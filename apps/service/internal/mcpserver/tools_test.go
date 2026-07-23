package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/mcp"

	"pinslip/service/internal/gitsync"
	"pinslip/service/internal/index"
	"pinslip/service/internal/notes"
	"pinslip/service/internal/storage"
)

// ---- 测试基建（与 notes/service_test.go 同模式：真文件引擎 + 真 SQLite 索引） ----

type tLogger struct{ t *testing.T }

func (l tLogger) Info(msg string, kv ...any)  { l.t.Log(msg, kv) }
func (l tLogger) Error(msg string, kv ...any) { l.t.Log(msg, kv) }

func newTestHandler(t *testing.T) (*toolHandler, *notes.Service) {
	t.Helper()
	root := t.TempDir()
	for _, sub := range []string{"notes", "inbox"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	store := storage.NewEngine(
		filepath.Join(root, "notes"),
		filepath.Join(root, "inbox"),
		filepath.Join(root, "attachments"),
	)
	db, err := index.Open(filepath.Join(root, "test.db"))
	if err != nil {
		t.Fatalf("index.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	svc := notes.NewService(store, db)
	syncEng, err := gitsync.NewEngine(root, tLogger{t})
	if err != nil {
		t.Fatalf("gitsync.NewEngine: %v", err)
	}
	return &toolHandler{svc: svc, sync: syncEng}, svc
}

// call 直接调用工具处理函数（跳过 JSON-RPC 层，聚焦业务语义）。
func call(t *testing.T, fn func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error), args map[string]any) *mcp.CallToolResult {
	t.Helper()
	res, err := fn(context.Background(), mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: args},
	})
	if err != nil {
		t.Fatalf("工具调用返回协议级错误: %v", err)
	}
	return res
}

// structuredMap 把结构化结果转成 map 便于断言。
func structuredMap(t *testing.T, res *mcp.CallToolResult) map[string]any {
	t.Helper()
	if res.IsError {
		t.Fatalf("预期成功，得到错误结果: %v", res.Content)
	}
	data, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatalf("StructuredContent 不可序列化: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("StructuredContent 不是 JSON 对象: %v", err)
	}
	return m
}

// errText 取错误结果的文本（中文可读性断言用）。
func errText(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	if !res.IsError {
		t.Fatal("预期错误结果，实际成功")
	}
	if len(res.Content) == 0 {
		t.Fatal("错误结果无内容")
	}
	tc, ok := res.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("错误结果不是文本: %T", res.Content[0])
	}
	return tc.Text
}

// ---- 数据面工具 ----

// 核心闭环：建 → 读 → 追加 → 全量替换 → 删除（进回收区）。
func TestNoteLifecycleTools(t *testing.T) {
	h, svc := newTestHandler(t)

	// create：标题从正文推导，source 标记 mcp
	res := call(t, h.createNote, map[string]any{"content": "# 购物清单\n牛奶\n"})
	created := structuredMap(t, res)
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatal("create_note 应返回 id")
	}
	if created["title"] != "购物清单" {
		t.Errorf("标题应从首行推导, got %v", created["title"])
	}
	if created["source"] != "mcp" {
		t.Errorf("source 应为 mcp, got %v", created["source"])
	}

	// read
	note := structuredMap(t, call(t, h.readNote, map[string]any{"id": id}))
	if note["content"] != "# 购物清单\n牛奶\n" {
		t.Errorf("read 内容不符: %q", note["content"])
	}

	// append：原文末尾无换行时补换行另起一行
	note = structuredMap(t, call(t, h.appendNote, map[string]any{"id": id, "content": "鸡蛋"}))
	if note["content"] != "# 购物清单\n牛奶\n鸡蛋" {
		t.Errorf("append 拼接不符: %q", note["content"])
	}

	// update：全量替换 + 改标签
	note = structuredMap(t, call(t, h.updateNote, map[string]any{
		"id": id, "content": "全新正文", "tags": []string{"生活"},
	}))
	if note["content"] != "全新正文" {
		t.Errorf("update 应全量替换, got %q", note["content"])
	}
	if tags, _ := note["tags"].([]any); len(tags) != 1 || tags[0] != "生活" {
		t.Errorf("标签应整体替换, got %v", note["tags"])
	}

	// update 不存在的 id：报错且不悄悄新建
	res = call(t, h.updateNote, map[string]any{"id": "no-such", "content": "x"})
	if !strings.Contains(errText(t, res), "便签不存在") {
		t.Errorf("不存在的 id 应报中文错误, got %v", res.Content)
	}
	if _, err := svc.Get("no-such"); err == nil {
		t.Error("update 不应把不存在的 id upsert 成新便签")
	}

	// delete：进回收区，再读报错
	res = call(t, h.deleteNote, map[string]any{"id": id})
	if m := structuredMap(t, res); m["status"] != "ok" {
		t.Errorf("delete 应成功: %v", m)
	}
	res = call(t, h.readNote, map[string]any{"id": id})
	if !strings.Contains(errText(t, res), "便签不存在") {
		t.Errorf("删除后 read 应报错, got %v", res.Content)
	}
}

// 搜索：FTS 命中 + 文件夹/标签过滤。
func TestSearchNotesWithFilters(t *testing.T) {
	h, svc := newTestHandler(t)
	put := func(id, content, folder string, tags []string) {
		in := notes.SaveInput{Content: &content, Tags: tags}
		if folder != "" {
			in.Folder = &folder
		}
		if _, err := svc.Save(id, in); err != nil {
			t.Fatal(err)
		}
	}
	put("n1", "周报：项目进度良好", "", nil)
	put("n2", "周报：项目风险汇总", "工作", []string{"周报"})
	put("n3", "会议纪要", "工作", nil)

	// 无过滤：两条「项目」都命中
	m := structuredMap(t, call(t, h.searchNotes, map[string]any{"query": "项目"}))
	if m["total"].(float64) != 2 {
		t.Fatalf("应命中 2 条: %v", m)
	}
	// folder 过滤：只剩工作文件夹那条
	m = structuredMap(t, call(t, h.searchNotes, map[string]any{"query": "项目", "folder": "工作"}))
	items := m["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["id"] != "n2" {
		t.Errorf("folder 过滤应只剩 n2: %v", items)
	}
	// tag 过滤：只剩带「周报」标签的
	m = structuredMap(t, call(t, h.searchNotes, map[string]any{"query": "项目", "tag": "周报"}))
	items = m["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["id"] != "n2" {
		t.Errorf("tag 过滤应只剩 n2: %v", items)
	}
	// 命中条目带片段与文件夹信息
	if items[0].(map[string]any)["snippet"] == "" || items[0].(map[string]any)["folder"] != "工作" {
		t.Errorf("条目应带 snippet 与 folder: %v", items[0])
	}
	// 缺 query：中文错误
	res := call(t, h.searchNotes, map[string]any{})
	if !strings.Contains(errText(t, res), "query") {
		t.Errorf("缺 query 应报错: %v", res.Content)
	}
}

// 列表：分页 + 排序 + 总数。
func TestListNotesPagination(t *testing.T) {
	h, svc := newTestHandler(t)
	for _, id := range []string{"a1", "a2", "a3"} {
		content := "便签 " + id
		if _, err := svc.Save(id, notes.SaveInput{Content: &content}); err != nil {
			t.Fatal(err)
		}
		// updatedAt 是秒级精度（RFC3339）：拉开间距才能让排序断言有意义
		time.Sleep(1100 * time.Millisecond)
	}

	m := structuredMap(t, call(t, h.listNotes, map[string]any{"limit": 2}))
	if m["total"].(float64) != 3 || len(m["items"].([]any)) != 2 {
		t.Fatalf("第一页应 2 条共 3 条: %v", m)
	}
	m = structuredMap(t, call(t, h.listNotes, map[string]any{"limit": 2, "offset": 2}))
	if len(m["items"].([]any)) != 1 {
		t.Fatalf("第二页应 1 条: %v", m)
	}
	// 排序：默认 updated desc 首条是最新的 a3；asc 首条是最早的 a1
	desc := structuredMap(t, call(t, h.listNotes, map[string]any{}))
	if first := desc["items"].([]any)[0].(map[string]any)["id"]; first != "a3" {
		t.Errorf("默认 updated desc 首条应为 a3: %v", first)
	}
	asc := structuredMap(t, call(t, h.listNotes, map[string]any{"sort": "updated", "order": "asc"}))
	if first := asc["items"].([]any)[0].(map[string]any)["id"]; first != "a1" {
		t.Errorf("asc 首条应为 a1: %v", first)
	}
}

// 标签聚合：计数降序。
func TestListTags(t *testing.T) {
	h, svc := newTestHandler(t)
	put := func(id string, tags []string) {
		content := id
		if _, err := svc.Save(id, notes.SaveInput{Content: &content, Tags: tags}); err != nil {
			t.Fatal(err)
		}
	}
	put("t1", []string{"工作"})
	put("t2", []string{"工作", "生活"})
	put("t3", nil)

	m := structuredMap(t, call(t, h.listTags, nil))
	items := m["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("应 2 个标签: %v", items)
	}
	first := items[0].(map[string]any)
	if first["tag"] != "工作" || first["count"].(float64) != 2 {
		t.Errorf("「工作」应 2 次居首: %v", first)
	}
}

// ---- 同步面工具 ----

// 未配置时：configured=false + 中文引导；sync_now 不报错（与 HTTP 层语义一致）。
func TestSyncStatusUnconfigured(t *testing.T) {
	h, _ := newTestHandler(t)

	m := structuredMap(t, call(t, h.syncStatus, nil))
	if m["configured"] != false || m["enabled"] != false {
		t.Errorf("未配置状态不符: %v", m)
	}
	if msg, _ := m["message"].(string); !strings.Contains(msg, "尚未配置") {
		t.Errorf("应有中文引导: %v", m)
	}

	m = structuredMap(t, call(t, h.syncNow, nil))
	if ok, _ := m["success"].(bool); !ok {
		t.Errorf("未配置时 sync_now 应为 no-op 成功: %v", m)
	}
}

// ---- 总开关中间件 ----

func TestWithEnabledGate(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	// 关闭：404 + 中文错误体
	h := withEnabled(next, func() bool { return false })
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("关闭时应 404, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "MCP 服务未开启") {
		t.Errorf("404 应带中文说明: %s", rec.Body.String())
	}

	// 开启：透传
	h = withEnabled(next, func() bool { return true })
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if rec.Code != http.StatusNoContent {
		t.Errorf("开启时应透传, got %d", rec.Code)
	}
}
