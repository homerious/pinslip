// tools.go — 12 个 MCP 工具：数据面 10（搜索/列表/读/建/改/局部替换/追加/删/标签/文件夹）
// + 同步面 2（立即同步/同步状态）。全部是薄壳：读写走 notes.Service 与
// gitsync.Engine 的现有服务层函数，不直接碰文件与 SQLite——文件名规范、
// frontmatter、索引重建、回收区行为与界面入口完全一致。
package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	mcpsdk "github.com/mark3labs/mcp-go/server"

	"pinslip/service/internal/gitsync"
	"pinslip/service/internal/notes"
	"pinslip/service/internal/storage"
)

// toolHandler 持有工具实现依赖的两个服务层入口。
type toolHandler struct {
	svc  *notes.Service
	sync *gitsync.Engine
}

// registerTools 把 12 个工具注册到 MCP server。
func (h *toolHandler) registerTools(s *mcpsdk.MCPServer) {
	// ---- 数据面 ----

	s.AddTool(mcp.NewTool("search_notes",
		mcp.WithDescription("全文搜索便签（FTS5，中文子串匹配），返回命中片段；可按文件夹/标签/时间范围过滤"),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("query", mcp.Required(), mcp.Description("搜索词，空格分隔多个词（AND）")),
		mcp.WithString("folder", mcp.Description("只搜该文件夹（notes/ 相对路径，\"\" = 根目录）；不传 = 不过滤")),
		mcp.WithString("tag", mcp.Description("只搜含此标签的便签")),
		mcp.WithString("since", mcp.Description("起始时间（闭区间）：日期 2026-07-23 或 RFC3339 时间戳；按 timeField 指定的时间字段过滤")),
		mcp.WithString("until", mcp.Description("截止时间（闭区间）：只给日期时按当天结束计")),
		mcp.WithString("timeField", mcp.Description("since/until 作用的时间字段"), mcp.Enum("updated", "created"), mcp.DefaultString("updated")),
		mcp.WithNumber("limit", mcp.Description("最多返回条数"), mcp.DefaultNumber(20)),
	), h.searchNotes)

	s.AddTool(mcp.NewTool("list_notes",
		mcp.WithDescription("列出便签元数据（不含正文，每条带 excerpt 摘要预览），支持文件夹/标签/收集箱/时间范围过滤、排序与分页"),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("folder", mcp.Description("只看该文件夹（notes/ 相对路径，\"\" = 根目录）；不传 = 不过滤")),
		mcp.WithString("tag", mcp.Description("只看含此标签的便签")),
		mcp.WithBoolean("inbox", mcp.Description("true = 只看收集箱；false = 排除收集箱；不传 = 全部")),
		mcp.WithString("since", mcp.Description("起始时间（闭区间）：日期 2026-07-23 或 RFC3339 时间戳；按 timeField 指定的时间字段过滤")),
		mcp.WithString("until", mcp.Description("截止时间（闭区间）：只给日期时按当天结束计")),
		mcp.WithString("timeField", mcp.Description("since/until 作用的时间字段"), mcp.Enum("updated", "created"), mcp.DefaultString("updated")),
		mcp.WithString("sort", mcp.Description("排序字段"), mcp.Enum("updated", "created"), mcp.DefaultString("updated")),
		mcp.WithString("order", mcp.Description("排序方向"), mcp.Enum("desc", "asc"), mcp.DefaultString("desc")),
		mcp.WithNumber("limit", mcp.Description("每页条数"), mcp.DefaultNumber(50)),
		mcp.WithNumber("offset", mcp.Description("跳过条数（分页）"), mcp.DefaultNumber(0)),
	), h.listNotes)

	s.AddTool(mcp.NewTool("read_note",
		mcp.WithDescription("读取单条便签完整内容（Markdown 正文 + 元数据）；update_note / patch_note 修改前建议先读"),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("id", mcp.Required(), mcp.Description("便签 id（search_notes / list_notes 返回的 id）")),
	), h.readNote)

	s.AddTool(mcp.NewTool("create_note",
		mcp.WithDescription("新建便签（Markdown 正文）；可指定标题/标签/落盘文件夹"),
		mcp.WithString("content", mcp.Required(), mcp.Description("Markdown 正文")),
		mcp.WithString("title", mcp.Description("标题；不传则从正文首行自动推导")),
		mcp.WithArray("tags", mcp.Description("标签列表"), mcp.WithStringItems()),
		mcp.WithString("folder", mcp.Description("落盘文件夹（notes/ 相对路径，不存在自动创建）；不传 = 根目录")),
	), h.createNote)

	s.AddTool(mcp.NewTool("update_note",
		mcp.WithDescription("全量替换便签正文（小改动优先用 patch_note 局部替换，整篇重写才用它；大改前请先 read_note 确认现内容）；可顺带改标题/标签/移动文件夹"),
		mcp.WithString("id", mcp.Required(), mcp.Description("便签 id")),
		mcp.WithString("content", mcp.Required(), mcp.Description("新的 Markdown 正文（全量替换，不是局部修改）")),
		mcp.WithString("title", mcp.Description("新标题；不传则按新正文重新推导")),
		mcp.WithArray("tags", mcp.Description("新标签列表（整体替换）；不传 = 保留原标签"), mcp.WithStringItems()),
		mcp.WithString("folder", mcp.Description("移动到该文件夹（notes/ 相对路径，\"\" = 根目录，不存在自动创建）；正文里的附件相对路径会按新深度自动重写；不传 = 位置不变")),
	), h.updateNote)

	s.AddTool(mcp.NewTool("patch_note",
		mcp.WithDescription("局部替换便签内容：把 oldString 替换成 newString，其余内容不动（标题保留）。oldString 必须在正文中唯一出现；找不到或有多处都会报错，此时先 read_note 拿到当前正文再调整"),
		mcp.WithString("id", mcp.Required(), mcp.Description("便签 id")),
		mcp.WithString("oldString", mcp.Required(), mcp.Description("要被替换的原文片段（须与正文完全一致，含空白换行；唯一匹配才执行）")),
		mcp.WithString("newString", mcp.Required(), mcp.Description("替换后的新内容（传空字符串 = 删除该片段）")),
	), h.patchNote)

	s.AddTool(mcp.NewTool("append_note",
		mcp.WithDescription("把内容追加到便签末尾（速记/收集箱高频操作）；正文其余部分不动"),
		mcp.WithString("id", mcp.Required(), mcp.Description("便签 id")),
		mcp.WithString("content", mcp.Required(), mcp.Description("要追加的 Markdown 内容")),
	), h.appendNote)

	s.AddTool(mcp.NewTool("delete_note",
		mcp.WithDescription("删除便签——只进回收区（可在应用内找回），不做物理删除"),
		mcp.WithDestructiveHintAnnotation(true),
		mcp.WithString("id", mcp.Required(), mcp.Description("便签 id")),
	), h.deleteNote)

	s.AddTool(mcp.NewTool("list_tags",
		mcp.WithDescription("列出全部标签及使用次数（按次数降序）"),
		mcp.WithReadOnlyHintAnnotation(true),
	), h.listTags)

	s.AddTool(mcp.NewTool("list_folders",
		mcp.WithDescription("列出 notes/ 下全部子文件夹（相对路径）"),
		mcp.WithReadOnlyHintAnnotation(true),
	), h.listFolders)

	// ---- 同步面 ----

	s.AddTool(mcp.NewTool("sync_now",
		mcp.WithDescription("立即执行一轮 git 同步（commit + pull + push），返回最新同步状态"),
		mcp.WithIdempotentHintAnnotation(true),
	), h.syncNow)

	s.AddTool(mcp.NewTool("sync_status",
		mcp.WithDescription("查询 git 同步状态：上次同步时间、待推送数、待解冲突文件列表"),
		mcp.WithReadOnlyHintAnnotation(true),
	), h.syncStatus)
}

// ---- 结果构造辅助 ----

// structured 返回结构化 JSON 结果（附带文本形态兼容只读 text 的客户端）。
func structured(v any) (*mcp.CallToolResult, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultStructured(v, string(data)), nil
}

// hasArg 判断入参是否显式提供（区分「没传 = 不过滤」与「"" = 根目录」）。
func hasArg(req mcp.CallToolRequest, key string) (string, bool) {
	v, ok := req.GetArguments()[key]
	if !ok {
		return "", false
	}
	s, _ := v.(string)
	return s, true
}

// notFoundErr 统一「笔记不存在」的中文错误。
func notFoundErr(id string) *mcp.CallToolResult {
	return mcp.NewToolResultErrorf("便签不存在（id: %s），可能已被删除；可用 list_notes 查看最新列表", id)
}

// serviceErr 把服务层错误包成可读中文工具错误。
func serviceErr(op string, err error) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultErrorf("%s失败：%v", op, err), nil
}

// ---- 数据面工具 ----

// noteBrief 是搜索/列表条目的输出形态（Meta 的子集 + 命中片段）。
type noteBrief struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Snippet    string   `json:"snippet,omitempty"`
	Excerpt    string   `json:"excerpt,omitempty"`
	Folder     string   `json:"folder"`
	Tags       []string `json:"tags"`
	Inbox      bool     `json:"inbox"`
	Conflicted bool     `json:"conflicted"`
	CreatedAt  string   `json:"createdAt"`
	UpdatedAt  string   `json:"updatedAt"`
}

func metaToBrief(m notes.Meta) noteBrief {
	return noteBrief{
		ID:         m.ID,
		Title:      m.Title,
		Excerpt:    m.Excerpt,
		Folder:     m.Folder,
		Tags:       m.Tags,
		Inbox:      m.Inbox,
		Conflicted: m.Conflicted,
		CreatedAt:  m.CreatedAt.Format(time.RFC3339),
		UpdatedAt:  m.UpdatedAt.Format(time.RFC3339),
	}
}

// metaByID 拉一次列表建 id → Meta 索引（搜索过滤/补充字段共用）。
func (h *toolHandler) metaByID() (map[string]notes.Meta, error) {
	metas, err := h.svc.List()
	if err != nil {
		return nil, err
	}
	m := make(map[string]notes.Meta, len(metas))
	for _, meta := range metas {
		m[meta.ID] = meta
	}
	return m, nil
}

// timeBound 是 since/until/timeField 参数解析后的时间过滤条件。
type timeBound struct {
	field string
	since *time.Time
	until *time.Time
}

func (tf *timeBound) match(m notes.Meta) bool {
	return notes.InTimeRange(m, tf.field, tf.since, tf.until)
}

// parseTimeArg 解析单个时间参数：接受 YYYY-MM-DD（本地时区；endOfDay=true 时取当天
// 最后一刻，保证闭区间含整天）或 RFC3339 时间戳；非法值给中文错误。
func parseTimeArg(name, v string, endOfDay bool) (*time.Time, *mcp.CallToolResult) {
	if t, err := time.ParseInLocation("2006-01-02", v, time.Local); err == nil {
		if endOfDay {
			t = t.Add(24*time.Hour - time.Nanosecond)
		}
		return &t, nil
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return &t, nil
	}
	return nil, mcp.NewToolResultErrorf(
		"时间参数 %s 无法识别：%q；支持日期（如 2026-07-23）或 RFC3339 时间戳（如 2026-07-23T10:00:00+08:00）",
		name, v)
}

// getTimeBound 从入参提取时间过滤条件（since/until 不传 = 对应端不限）。
func getTimeBound(req mcp.CallToolRequest) (*timeBound, *mcp.CallToolResult) {
	tf := &timeBound{field: notes.TimeFieldUpdated}
	if f := req.GetString("timeField", ""); f != "" {
		if f != notes.TimeFieldUpdated && f != notes.TimeFieldCreated {
			return nil, mcp.NewToolResultErrorf(
				"timeField 只支持 %q（默认）或 %q，收到 %q",
				notes.TimeFieldUpdated, notes.TimeFieldCreated, f)
		}
		tf.field = f
	}
	if v, ok := hasArg(req, "since"); ok && v != "" {
		t, errRes := parseTimeArg("since", v, false)
		if errRes != nil {
			return nil, errRes
		}
		tf.since = t
	}
	if v, ok := hasArg(req, "until"); ok && v != "" {
		t, errRes := parseTimeArg("until", v, true)
		if errRes != nil {
			return nil, errRes
		}
		tf.until = t
	}
	return tf, nil
}

// matchFilters 应用 folder/tag/inbox/时间范围过滤（都没传 = 全部通过）。
func matchFilters(m notes.Meta, folder string, hasFolder bool, tag string, inbox *bool, tf *timeBound) bool {
	if hasFolder && m.Folder != folder {
		return false
	}
	if tag != "" {
		found := false
		for _, t := range m.Tags {
			if t == tag {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if inbox != nil && m.Inbox != *inbox {
		return false
	}
	if tf != nil && !tf.match(m) {
		return false
	}
	return true
}

func (h *toolHandler) searchNotes(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	query, err := req.RequireString("query")
	if err != nil || strings.TrimSpace(query) == "" {
		return mcp.NewToolResultError("缺少必填参数 query（搜索词不能为空）"), nil
	}
	folder, hasFolder := hasArg(req, "folder")
	tag := req.GetString("tag", "")
	limit := req.GetInt("limit", 20)
	if limit <= 0 {
		limit = 20
	}
	tf, errRes := getTimeBound(req)
	if errRes != nil {
		return errRes, nil
	}

	// 有过滤条件时多取一些再筛，保证最终条数尽量达到 limit
	searchLimit := limit
	if hasFolder || tag != "" || tf.since != nil || tf.until != nil {
		searchLimit = 200
	}
	hits, err := h.svc.Search(query, searchLimit)
	if err != nil {
		return serviceErr("搜索", err)
	}

	var metas map[string]notes.Meta
	items := make([]noteBrief, 0, limit)
	for _, hit := range hits {
		if len(items) >= limit {
			break
		}
		if metas == nil {
			if metas, err = h.metaByID(); err != nil {
				return serviceErr("读取便签列表", err)
			}
		}
		meta, ok := metas[hit.ID]
		if !ok { // 索引滞后于文件（刚删除），跳过
			continue
		}
		if !matchFilters(meta, folder, hasFolder, tag, nil, tf) {
			continue
		}
		b := metaToBrief(meta)
		b.Snippet = hit.Snippet
		items = append(items, b)
	}
	return structured(map[string]any{"total": len(items), "items": items})
}

func (h *toolHandler) listNotes(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	folder, hasFolder := hasArg(req, "folder")
	tag := req.GetString("tag", "")
	var inbox *bool
	if v, ok := req.GetArguments()["inbox"]; ok {
		if b, ok := v.(bool); ok {
			inbox = &b
		}
	}
	sortKey := req.GetString("sort", "updated")
	order := req.GetString("order", "desc")
	limit := req.GetInt("limit", 50)
	offset := req.GetInt("offset", 0)
	if limit <= 0 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	tf, errRes := getTimeBound(req)
	if errRes != nil {
		return errRes, nil
	}

	metas, err := h.svc.List()
	if err != nil {
		return serviceErr("列出便签", err)
	}
	filtered := make([]notes.Meta, 0, len(metas))
	for _, m := range metas {
		if matchFilters(m, folder, hasFolder, tag, inbox, tf) {
			filtered = append(filtered, m)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		ti, tj := filtered[i].UpdatedAt, filtered[j].UpdatedAt
		if sortKey == "created" {
			ti, tj = filtered[i].CreatedAt, filtered[j].CreatedAt
		}
		if order == "asc" {
			return ti.Before(tj)
		}
		return ti.After(tj)
	})

	total := len(filtered)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	items := make([]noteBrief, 0, end-offset)
	for _, m := range filtered[offset:end] {
		items = append(items, metaToBrief(m))
	}
	return structured(map[string]any{
		"total": total, "offset": offset, "limit": limit, "items": items,
	})
}

func (h *toolHandler) readNote(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("id")
	if err != nil {
		return mcp.NewToolResultError("缺少必填参数 id"), nil
	}
	note, err := h.svc.Get(id)
	if errors.Is(err, storage.ErrNotFound) {
		return notFoundErr(id), nil
	}
	if err != nil {
		return serviceErr("读取便签", err)
	}
	return structured(note)
}

func (h *toolHandler) createNote(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	content, err := req.RequireString("content")
	if err != nil || strings.TrimSpace(content) == "" {
		return mcp.NewToolResultError("缺少必填参数 content（正文不能为空）"), nil
	}
	in := notes.SaveInput{
		Content: &content,
		Title:   req.GetString("title", ""),
		Source:  "mcp",
	}
	if tags, err := req.RequireStringSlice("tags"); err == nil {
		in.Tags = tags
	}
	if folder, ok := hasArg(req, "folder"); ok {
		in.Folder = &folder
	}
	note, err := h.svc.Save(notes.NewID(), in)
	if err != nil {
		return serviceErr("新建便签", err)
	}
	return structured(note)
}

func (h *toolHandler) updateNote(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("id")
	if err != nil {
		return mcp.NewToolResultError("缺少必填参数 id"), nil
	}
	content, err := req.RequireString("content")
	if err != nil {
		return mcp.NewToolResultError("缺少必填参数 content（update_note 是全量替换，必须给出完整新正文）"), nil
	}
	// 先读后写：不存在的 id 不应被 upsert 悄悄新建（与 delete 语义对齐）
	if _, err := h.svc.Get(id); errors.Is(err, storage.ErrNotFound) {
		return notFoundErr(id), nil
	} else if err != nil {
		return serviceErr("读取便签", err)
	}
	in := notes.SaveInput{Content: &content, Title: req.GetString("title", "")}
	if tags, err := req.RequireStringSlice("tags"); err == nil {
		in.Tags = tags
	}
	note, err := h.svc.Save(id, in)
	if err != nil {
		return serviceErr("更新便签", err)
	}
	// 传入 folder 即移动归属：走 store.Move（深度变化时自动重写正文里的
	// 附件 ../ 前缀，与便签编辑器移动文件夹的行为一致）
	if folder, ok := hasArg(req, "folder"); ok {
		if err := h.svc.Move(id, folder); err != nil {
			return serviceErr("移动便签", err)
		}
		if note, err = h.svc.Get(id); err != nil {
			return serviceErr("读取移动后的便签", err)
		}
	}
	return structured(note)
}

func (h *toolHandler) patchNote(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("id")
	if err != nil {
		return mcp.NewToolResultError("缺少必填参数 id"), nil
	}
	oldString, err := req.RequireString("oldString")
	if err != nil || oldString == "" {
		return mcp.NewToolResultError("缺少必填参数 oldString（要被替换的原文片段不能为空）"), nil
	}
	newString, err := req.RequireString("newString")
	if err != nil {
		return mcp.NewToolResultError("缺少必填参数 newString（传空字符串表示删除该片段）"), nil
	}
	note, err := h.svc.Get(id)
	if errors.Is(err, storage.ErrNotFound) {
		return notFoundErr(id), nil
	}
	if err != nil {
		return serviceErr("读取便签", err)
	}
	switch n := strings.Count(note.Content, oldString); {
	case n == 0:
		return mcp.NewToolResultError(
			"未找到要替换的文本：正文里没有与 oldString 完全一致的内容（注意空白与换行也要一致）；请先 read_note 查看当前正文再调整"), nil
	case n > 1:
		return mcp.NewToolResultErrorf(
			"oldString 在正文中出现 %d 次，无法确定唯一替换位置；请把 oldString 加长到包含更多上下文使其唯一（可先 read_note 查看）", n), nil
	}
	merged := strings.Replace(note.Content, oldString, newString, 1)
	// 标题显式回写：patch 是局部修改，不应触发标题按正文重新推导
	updated, err := h.svc.Save(id, notes.SaveInput{Content: &merged, Title: note.Title})
	if err != nil {
		return serviceErr("更新便签", err)
	}
	return structured(updated)
}

func (h *toolHandler) appendNote(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("id")
	if err != nil {
		return mcp.NewToolResultError("缺少必填参数 id"), nil
	}
	content, err := req.RequireString("content")
	if err != nil || content == "" {
		return mcp.NewToolResultError("缺少必填参数 content（追加内容不能为空）"), nil
	}
	note, err := h.svc.Get(id)
	if errors.Is(err, storage.ErrNotFound) {
		return notFoundErr(id), nil
	}
	if err != nil {
		return serviceErr("读取便签", err)
	}
	// 拼接：原文末尾没有换行时补一个，追加内容另起一行
	merged := note.Content
	if merged != "" && !strings.HasSuffix(merged, "\n") {
		merged += "\n"
	}
	merged += content
	updated, err := h.svc.Save(id, notes.SaveInput{Content: &merged})
	if err != nil {
		return serviceErr("追加便签", err)
	}
	return structured(updated)
}

func (h *toolHandler) deleteNote(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("id")
	if err != nil {
		return mcp.NewToolResultError("缺少必填参数 id"), nil
	}
	if err := h.svc.Delete(id); errors.Is(err, storage.ErrNotFound) {
		return notFoundErr(id), nil
	} else if err != nil {
		return serviceErr("删除便签", err)
	}
	return structured(map[string]string{
		"status":  "ok",
		"message": "已移入回收区（应用内可找回，不会物理删除）",
	})
}

func (h *toolHandler) listTags(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	metas, err := h.svc.List()
	if err != nil {
		return serviceErr("读取便签列表", err)
	}
	counts := map[string]int{}
	for _, m := range metas {
		for _, t := range m.Tags {
			counts[t]++
		}
	}
	type tagCount struct {
		Tag   string `json:"tag"`
		Count int    `json:"count"`
	}
	items := make([]tagCount, 0, len(counts))
	for t, c := range counts {
		items = append(items, tagCount{Tag: t, Count: c})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		return items[i].Tag < items[j].Tag
	})
	return structured(map[string]any{"total": len(items), "items": items})
}

func (h *toolHandler) listFolders(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	folders, err := h.svc.ListFolders()
	if err != nil {
		return serviceErr("列出文件夹", err)
	}
	if folders == nil {
		folders = []string{}
	}
	return structured(map[string]any{"folders": folders})
}

// ---- 同步面工具 ----

// syncStatusView 是同步面两个工具共用的输出形态。
type syncStatusView struct {
	Success         *bool    `json:"success,omitempty"` // 仅 sync_now 输出本轮成败
	Configured      bool     `json:"configured"`
	Enabled         bool     `json:"enabled"`
	LastSyncAt      string   `json:"lastSyncAt,omitempty"` // RFC3339；从未同步则省略
	LastError       string   `json:"lastError,omitempty"`
	Ahead           int      `json:"ahead"`           // 待推送提交数
	Behind          int      `json:"behind"`          // 待拉取提交数
	ConflictedFiles []string `json:"conflictedFiles"` // 待解冲突文件（read_note 可查内容）
	Message         string   `json:"message,omitempty"`
}

func statusToView(st gitsync.Status) syncStatusView {
	v := syncStatusView{
		Configured:      st.Configured,
		Enabled:         st.Enabled,
		LastError:       st.LastError,
		Ahead:           st.Ahead,
		Behind:          st.Behind,
		ConflictedFiles: st.ConflictedFiles,
	}
	if !st.LastSyncAt.IsZero() && st.LastSyncAt.Year() > 1 {
		v.LastSyncAt = st.LastSyncAt.Format(time.RFC3339)
	}
	if !st.Configured {
		v.Message = "尚未配置 git 同步（请在应用设置里配置仓库）"
	} else if !st.Enabled {
		v.Message = "git 同步已停用"
	}
	return v
}

func (h *toolHandler) syncNow(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	err := h.sync.SyncNow()
	v := statusToView(h.sync.GetStatus())
	ok := err == nil
	v.Success = &ok
	if err != nil {
		v.Message = "本轮同步失败：" + err.Error()
	}
	return structured(v)
}

func (h *toolHandler) syncStatus(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return structured(statusToView(h.sync.GetStatus()))
}
