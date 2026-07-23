package notes

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"pinslip/service/internal/index"
	"pinslip/service/internal/storage"
)

// Service 协调文件引擎与索引引擎。handler 与未来的 MCP 层都只依赖它。
type Service struct {
	store *storage.Engine
	idx   *index.DB
}

func NewService(store *storage.Engine, idx *index.DB) *Service {
	return &Service{store: store, idx: idx}
}

// List 返回全部笔记元数据。
func (s *Service) List() ([]Meta, error) {
	items, err := s.store.List()
	if err != nil {
		return nil, err
	}
	metas := make([]Meta, 0, len(items))
	for _, it := range items {
		metas = append(metas, toMeta(it.FM, it.Body, it.Inbox, it.Folder))
	}
	return metas, nil
}

// Get 读取单条笔记。
func (s *Service) Get(id string) (*Note, error) {
	fm, body, inbox, folder, err := s.store.Load(id)
	if err != nil {
		return nil, err
	}
	return toNote(fm, body, inbox, folder), nil
}

// Save 创建或更新笔记（upsert，id 由客户端生成）。
// 支持部分更新：Content 为 nil 保留原文，Tags 为 nil 保留原标签。
// Folder 仅新建时生效（决定落盘目录）；已存在便签忽略——移动走 Move。
func (s *Service) Save(id string, in SaveInput) (*Note, error) {
	now := time.Now()

	// 已存在则保留创建时间、正文与位置（notes/inbox），不存在则新建到 notes/
	fm, oldBody, inbox, folder, err := s.store.Load(id)
	isNew := errors.Is(err, storage.ErrNotFound)
	if isNew {
		fm = &storage.Frontmatter{ID: id, CreatedAt: now.Format(time.RFC3339)}
		inbox = false
		oldBody = ""
	} else if err != nil {
		return nil, err
	}

	content := oldBody
	if in.Content != nil {
		content = *in.Content
	}

	if in.Title != "" {
		fm.Title = in.Title
	} else if in.Content != nil {
		// 内容变化时重新推导标题：客户端不传 title 即「自动标题」，
		// 主界面列表才能和便签窗口的实时标题保持一致
		fm.Title = deriveTitle(content)
	}
	if fm.Title == "" {
		fm.Title = deriveTitle(content)
	}
	if in.Tags != nil {
		fm.Tags = in.Tags
	}
	if in.Pin != nil {
		fm.Pin = *in.Pin
	}
	if in.Collapsed != nil {
		fm.Collapsed = *in.Collapsed
	}
	if in.Group != nil {
		fm.Group = *in.Group
	}
	if in.Source != "" {
		fm.Source = in.Source
	}
	if in.Color != "" {
		fm.Color = in.Color
	}
	if fm.Source == "" {
		fm.Source = "sticky"
	}
	fm.UpdatedAt = now.Format(time.RFC3339)

	// 新建且指定了落盘文件夹：SaveToFolder（目录自动创建）；
	// 已存在便签即使传了 folder 也由 store 保留原位置
	if isNew && in.Folder != nil && *in.Folder != "" {
		if err := s.store.SaveToFolder(fm, content, *in.Folder); err != nil {
			return nil, err
		}
		folder = *in.Folder
	} else if err := s.store.Save(fm, content, inbox); err != nil {
		return nil, err
	}
	if err := s.idx.Upsert(index.Record{
		ID:      fm.ID,
		Title:   fm.Title,
		Content: content,
		Tags:    strings.Join(fm.Tags, " "),
	}); err != nil {
		return nil, err
	}
	return toNote(fm, content, inbox, folder), nil
}

// QuickCapture 速记：按 vault 设置的落点模式写入收集箱——
// 'note'（默认）逐条新建；'daily' 聚合到今日便签（见 quickCaptureDaily）。
func (s *Service) QuickCapture(content string) (*Note, error) {
	if s.GetSettings().QuickMode() == storage.QuickModeDaily {
		return s.quickCaptureDaily(content)
	}
	return s.saveQuickToInbox(SaveInput{Content: &content, Source: "quick"})
}

// saveQuickToInbox 新建速记到 inbox：Save 默认落 notes/，随后挪到 inbox/
// （engine.Save 会自动清理旧路径）。
func (s *Service) saveQuickToInbox(in SaveInput) (*Note, error) {
	id := NewID()
	note, err := s.Save(id, in)
	if err != nil {
		return nil, err
	}
	fm, body, _, _, err := s.store.Load(id)
	if err != nil {
		return nil, err
	}
	if err := s.store.Save(fm, body, true); err != nil {
		return nil, err
	}
	note.Inbox = true
	return note, nil
}

// quickCaptureDaily 聚合模式：把内容追加到标题「速记 YYYY-MM-DD」的 inbox 便签
// （不存在则新建，落点与逐条模式一致），条目格式「### HH:mm」小标题 + 空行 + 内容，
// 条目间空行分隔。复用同一 upsert 服务层，索引/frontmatter 行为与界面入口一致。
func (s *Service) quickCaptureDaily(content string) (*Note, error) {
	now := time.Now()
	title := "速记 " + now.Format("2006-01-02")
	entry := "### " + now.Format("15:04") + "\n\n" + content

	// 找今日便签：inbox 内标题精确匹配（用户改标题/挪出收集箱则视为没有，另起新签）
	id := ""
	metas, err := s.List()
	if err != nil {
		return nil, err
	}
	for _, m := range metas {
		if m.Inbox && m.Title == title {
			id = m.ID
			break
		}
	}
	if id == "" {
		// 标题显式给定：否则首行是「### HH:mm」，deriveTitle 会把便签命名成时间
		return s.saveQuickToInbox(SaveInput{Content: &entry, Title: title, Source: "quick"})
	}

	// 追加：读出 → 拼接 → 同一 upsert（标题显式回写，防被重新推导）
	note, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	merged := entry
	if strings.TrimRight(note.Content, "\n") != "" {
		merged = strings.TrimRight(note.Content, "\n") + "\n\n" + entry
	}
	return s.Save(id, SaveInput{Content: &merged, Title: title})
}

// Delete 删除笔记：移入回收区（可找回）并清出索引。
// 与文件夹 trash 删除统一——所有用户删除入口都经过回收区；
// 物理删除只发生在 清空回收区/自动清理 时。
func (s *Service) Delete(id string) error {
	if err := s.store.TrashNote(id); err != nil {
		return err
	}
	return s.idx.Delete(id)
}

// Move 把笔记移动到 notes/ 下的指定文件夹（"" 为根目录），索引无需变更（id 不变）。
func (s *Service) Move(id, folder string) error {
	return s.store.Move(id, folder)
}

// CreateFolder 创建（嵌套）文件夹。
func (s *Service) CreateFolder(path string) error {
	return s.store.CreateFolder(path)
}

// RenameFolder 重命名文件夹（同级改名）。便签随目录走，id 不变、索引无需动。
func (s *Service) RenameFolder(path, newName string) error {
	return s.store.RenameFolder(path, newName)
}

// DeleteFolder 删除文件夹：move 模式便签移到根目录（索引不变）；
// trash 模式整个移入 .trash，其中便签从索引移除（文件离开 notes/ 不再可检索）。
func (s *Service) DeleteFolder(path, mode string) error {
	removed, err := s.store.DeleteFolder(path, mode)
	if err != nil {
		return err
	}
	for _, id := range removed {
		if err := s.idx.Delete(id); err != nil {
			return err
		}
	}
	return nil
}

// ListFolders 列出 notes/ 下全部子文件夹。
func (s *Service) ListFolders() ([]string, error) {
	return s.store.ListFolders()
}

// TrashStats 统计回收区占用（顶层条目数 + 总字节数）。
func (s *Service) TrashStats() (int, int64, error) {
	return s.store.TrashStats()
}

// EmptyTrash 清空回收区。其中便签在 DeleteFolder trash 模式时已清出索引，无需再动。
func (s *Service) EmptyTrash() error {
	return s.store.EmptyTrash()
}

// AutoCleanTrash 按 vault 设置清理回收区超期条目（服务启动时调用），返回清理数。
func (s *Service) AutoCleanTrash() (int, error) {
	return s.store.CleanTrash(s.store.LoadSettings().TrashRetentionDays)
}

// GetSettings 读取 vault 设置（缺失返回默认值）。
func (s *Service) GetSettings() *storage.Settings {
	return s.store.LoadSettings()
}

// SaveSettings 写回 vault 设置。
func (s *Service) SaveSettings(settings *storage.Settings) error {
	return s.store.SaveSettings(settings)
}

// GetGroups 读取便签组注册表（文件缺失返回空表）。
func (s *Service) GetGroups() *storage.GroupRegistry {
	return s.store.LoadGroups()
}

// SaveGroups 整体写回便签组注册表（members 数组顺序即组内叠放顺序）。
func (s *Service) SaveGroups(reg *storage.GroupRegistry) error {
	return s.store.SaveGroups(reg)
}

// SaveAttachment 保存粘贴的图片等附件，返回 vault 相对路径（attachments/<name>）。
func (s *Service) SaveAttachment(ext string, data []byte) (string, error) {
	return s.store.SaveAttachment(ext, data)
}

// Search 全文搜索。
func (s *Service) Search(query string, limit int) ([]index.Hit, error) {
	return s.idx.Search(query, limit)
}

// Reindex 从文件引擎全量重建索引（服务启动时调用）。
func (s *Service) Reindex() error {
	items, err := s.store.List()
	if err != nil {
		return err
	}
	records := make([]index.Record, 0, len(items))
	for _, it := range items {
		title := it.FM.Title
		if title == "" {
			title = deriveTitle(it.Body)
		}
		records = append(records, index.Record{
			ID:      it.FM.ID,
			Title:   title,
			Content: it.Body,
			Tags:    strings.Join(it.FM.Tags, " "),
		})
	}
	return s.idx.Rebuild(records)
}

// NewID 生成 16 位十六进制随机 id。
func NewID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// deriveTitle 从内容推导标题：首个一级标题 > 首个非空行（截断 30 字符）> "未命名"。
// 标题推导的行首结构标记（与 renderer NoteView.deriveTitle 完全一致）：
// #{1,6} 标题、> 引用、-/*/+ 无序列表、1. 有序列表、[ ]/[x] 任务框；
// 可叠加（如 "> - [ ] x"），循环剥到干净；"#tag" 这类无空格形式不算标记
var titleBlockPrefix = regexp.MustCompile(
	`^(?:#{1,6}(?:\s+|$)|>(?:\s?|$)|[-*+](?:\s+|$)|\d{1,9}[.)](?:\s+|$)|\[[ xX]\](?:\s+|$))`)

// 整行链接/图片：[t](url) / ![alt](src) → 取 t / alt
var titleLinkOnly = regexp.MustCompile(`^!?\[([^\]]*)\]\([^)]*\)$`)

// 整行行内包装可剥的最外层标记：两字符在前，保证 ** 优先于 * 匹配
// （顺序与 renderer INLINE_WRAPS 一致）
var titleInlineWraps = []string{"**", "__", "~~", "*", "_", "`"}

// deriveTitle 取首个有效行，剥掉 markdown 结构标记后截断 30 rune；
// 剥完为空的纯格式行（如 "##"）继续看下一行；全空返回 "未命名"
func deriveTitle(content string) string {
	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		// git 冲突标记行不参与标题推导：否则冲突文件会被重命名成
		// "<<<<<<< HEAD（本地）" 这类魔幻标记符（格式锚点见 gitsync 包）
		if strings.HasPrefix(line, "<<<<<<<") || strings.HasPrefix(line, "=======") ||
			strings.HasPrefix(line, ">>>>>>>") {
			continue
		}
		// 块级前缀：循环剥（叠加前缀如 "> ## "）
		for titleBlockPrefix.MatchString(line) {
			next := strings.TrimSpace(titleBlockPrefix.ReplaceAllString(line, ""))
			if next == line {
				break
			}
			line = next
		}
		if m := titleLinkOnly.FindStringSubmatch(line); m != nil {
			line = strings.TrimSpace(m[1])
		}
		// 行内包装：整行被同一标记完整包裹才剥最外层（**重要**：xxx 这类半包装保留原文）
		for {
			stripped := false
			for _, w := range titleInlineWraps {
				if len(line) > len(w)*2 && strings.HasPrefix(line, w) && strings.HasSuffix(line, w) {
					line = strings.TrimSpace(line[len(w) : len(line)-len(w)])
					stripped = true
					break
				}
			}
			if !stripped {
				break
			}
		}
		if line == "" {
			continue
		}
		if utf8.RuneCountInString(line) > 30 {
			r := []rune(line)
			line = string(r[:30]) + "…"
		}
		return line
	}
	return "未命名"
}

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

func toNote(fm *storage.Frontmatter, body string, inbox bool, folder string) *Note {
	tags := fm.Tags
	if tags == nil {
		tags = []string{}
	}
	return &Note{
		ID:        fm.ID,
		Title:     fm.Title,
		Content:   body,
		Tags:      tags,
		Source:    fm.Source,
		Pin:       fm.Pin,
		Color:     fm.Color,
		Collapsed: fm.Collapsed,
		Group:     fm.Group,
		Inbox:     inbox,
		Folder:    folder,
		CreatedAt: parseTime(fm.CreatedAt),
		UpdatedAt: parseTime(fm.UpdatedAt),
	}
}

func toMeta(fm *storage.Frontmatter, body string, inbox bool, folder string) Meta {
	note := toNote(fm, body, inbox, folder)
	title := note.Title
	if title == "" {
		title = deriveTitle(body)
	}
	return Meta{
		ID:         note.ID,
		Title:      title,
		Tags:       note.Tags,
		Source:     note.Source,
		Pin:        note.Pin,
		Color:      note.Color,
		Collapsed:  note.Collapsed,
		Group:      note.Group,
		Inbox:      note.Inbox,
		Folder:     note.Folder,
		WordCount:  utf8.RuneCountInString(body),
		Conflicted: hasConflictMarkers(body),
		CreatedAt:  note.CreatedAt,
		UpdatedAt:  note.UpdatedAt,
	}
}

// hasConflictMarkers 报告内容是否含 git 冲突标记行（^<<<<<<< ）。
// 与 gitsync.HasConflictMarkers 同款逻辑（此处复刻以保持包间解耦，
// 格式锚点是 gitsync 的 conflictMarkerOurs）。
func hasConflictMarkers(content string) bool {
	return strings.HasPrefix(content, "<<<<<<< ") || strings.Contains(content, "\n<<<<<<< ")
}
