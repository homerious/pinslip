package notes

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pinslip/service/internal/index"
	"pinslip/service/internal/storage"
)

func newTestService(t *testing.T) (*Service, *storage.Engine) {
	t.Helper()
	root := t.TempDir()
	notesDir := filepath.Join(root, "notes")
	inboxDir := filepath.Join(root, "inbox")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(inboxDir, 0o755); err != nil {
		t.Fatal(err)
	}
	store := storage.NewEngine(notesDir, inboxDir, filepath.Join(root, "attachments"))
	db, err := index.Open(filepath.Join(root, "test.db"))
	if err != nil {
		t.Fatalf("index.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return NewService(store, db), store
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }

// 含冲突标记的便签：meta 与检索结果都带 conflicted=true，标题不被标记污染。
func TestConflictedNoteMetaAndSearch(t *testing.T) {
	svc, _ := newTestService(t)

	content := "<<<<<<< HEAD（本地）\n购物清单\n=======\n远端版本\n>>>>>>> origin/main（远端）\n牛奶\n鸡蛋\n"
	if _, err := svc.Save("conf01", SaveInput{Content: strPtr(content)}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	metas, err := svc.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(metas) != 1 {
		t.Fatalf("应有 1 条便签: %d", len(metas))
	}
	if !metas[0].Conflicted {
		t.Error("meta.Conflicted 应为 true")
	}
	if metas[0].Title != "购物清单" {
		t.Errorf("标题应跳过标记行取正文, got %q", metas[0].Title)
	}

	hits, err := svc.Search("牛奶", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || !hits[0].Conflicted {
		t.Errorf("检索结果应带 conflicted=true: %+v", hits)
	}

	// 解决冲突后标记消失
	resolved := "购物清单\n牛奶\n鸡蛋\n"
	if _, err := svc.Save("conf01", SaveInput{Content: strPtr(resolved)}); err != nil {
		t.Fatal(err)
	}
	metas, _ = svc.List()
	if metas[0].Conflicted {
		t.Error("解决冲突后 meta.Conflicted 应为 false")
	}
}

// 普通便签不带 conflicted。
func TestNormalNoteNotConflicted(t *testing.T) {
	svc, _ := newTestService(t)
	if _, err := svc.Save("norm01", SaveInput{Content: strPtr("普通便签\n<<<<<< 六个小于号不算\n")}); err != nil {
		t.Fatal(err)
	}
	metas, _ := svc.List()
	if len(metas) != 1 || metas[0].Conflicted {
		t.Errorf("普通便签不应标 conflicted: %+v", metas)
	}
}

// 新建：未显式给标题时从 Markdown 首行推导，source 默认 sticky，文件落盘。
func TestSaveCreatesNoteWithDerivedTitle(t *testing.T) {
	svc, store := newTestService(t)

	note, err := svc.Save("id0001", SaveInput{Content: strPtr("# 我的标题\n\n正文内容")})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if note.Title != "我的标题" {
		t.Fatalf("Title = %q, want 我的标题", note.Title)
	}
	if note.Source != "sticky" {
		t.Fatalf("Source = %q, want sticky", note.Source)
	}
	p, inbox, err := store.Locate("id0001")
	if err != nil || !strings.HasSuffix(p, ".md") {
		t.Fatalf("file not written: %v %q", err, p)
	}
	if inbox {
		t.Fatal("新便签不应落在 inbox")
	}
}

// 外部入口（浏览器插件剪藏）新建便签可直接落收集箱；已存在便签忽略 inbox 字段。
func TestSaveNewNoteToInbox(t *testing.T) {
	svc, store := newTestService(t)

	tru := true
	note, err := svc.Save("idinbox1", SaveInput{
		Content: strPtr("# 剪藏标题\n\n正文"),
		Title:   "剪藏标题",
		Source:  "web-clip",
		Inbox:   &tru,
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !note.Inbox {
		t.Fatal("新建指定 inbox=true 应落收集箱")
	}
	if _, inbox, err := store.Locate("idinbox1"); err != nil || !inbox {
		t.Fatalf("文件应在 inbox/: %v inbox=%v", err, inbox)
	}

	// 已存在便签再传 inbox=false 不挪位置（位置由界面操作决定）
	if _, err := svc.Save("idinbox1", SaveInput{Pin: boolPtr(true)}); err != nil {
		t.Fatalf("Save(update): %v", err)
	}
	if _, inbox, err := store.Locate("idinbox1"); err != nil || !inbox {
		t.Fatalf("已存在便签位置不应被 inbox 字段改动: %v inbox=%v", err, inbox)
	}
}

// 部分更新：只改 pin 不动正文（复现「取消固定不丢内容」的契约）。
func TestPartialUpdatePinKeepsContent(t *testing.T) {
	svc, _ := newTestService(t)
	if _, err := svc.Save("id0002", SaveInput{Content: strPtr("# 不变的正文\n\n第一行")}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	updated, err := svc.Save("id0002", SaveInput{Pin: boolPtr(true)})
	if err != nil {
		t.Fatalf("Save pin: %v", err)
	}
	if !updated.Pin {
		t.Fatal("Pin = false, want true")
	}
	got, err := svc.Get("id0002")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !strings.Contains(got.Content, "第一行") {
		t.Fatalf("content lost after pin-only update: %q", got.Content)
	}
	if got.Title != "不变的正文" {
		t.Fatalf("Title = %q, want 不变的正文", got.Title)
	}
}

// 折叠状态：部分更新往返持久化；不传时保留原值（与 pin 同语义）。
func TestCollapsedRoundTrip(t *testing.T) {
	svc, _ := newTestService(t)
	if _, err := svc.Save("id0008", SaveInput{Content: strPtr("正文")}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	updated, err := svc.Save("id0008", SaveInput{Collapsed: boolPtr(true)})
	if err != nil {
		t.Fatalf("Save collapsed: %v", err)
	}
	if !updated.Collapsed {
		t.Fatal("Collapsed = false, want true")
	}

	// 只更新内容：折叠状态保留
	if _, err := svc.Save("id0008", SaveInput{Content: strPtr("正文改写")}); err != nil {
		t.Fatalf("Save content: %v", err)
	}
	got, err := svc.Get("id0008")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !got.Collapsed {
		t.Fatal("内容更新后 Collapsed 丢失")
	}

	// 展开
	updated, err = svc.Save("id0008", SaveInput{Collapsed: boolPtr(false)})
	if err != nil {
		t.Fatalf("Save uncollapse: %v", err)
	}
	if updated.Collapsed {
		t.Fatal("Collapsed = true, want false")
	}
}

// 便签组：group 字段部分更新往返持久化；不传时保留原值（与 collapsed 同语义）。
func TestGroupRoundTrip(t *testing.T) {
	svc, _ := newTestService(t)
	if _, err := svc.Save("id0009", SaveInput{Content: strPtr("正文")}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	updated, err := svc.Save("id0009", SaveInput{Group: strPtr("g-0001")})
	if err != nil {
		t.Fatalf("Save group: %v", err)
	}
	if updated.Group != "g-0001" {
		t.Fatalf("Group = %q, want g-0001", updated.Group)
	}

	// 只更新内容：便签组保留
	if _, err := svc.Save("id0009", SaveInput{Content: strPtr("正文改写")}); err != nil {
		t.Fatalf("Save content: %v", err)
	}
	got, err := svc.Get("id0009")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Group != "g-0001" {
		t.Fatalf("内容更新后 Group = %q, want g-0001", got.Group)
	}

	// List 元数据也带 group
	metas, err := svc.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	found := false
	for _, m := range metas {
		if m.ID == "id0009" {
			found = true
			if m.Group != "g-0001" {
				t.Fatalf("Meta.Group = %q, want g-0001", m.Group)
			}
		}
	}
	if !found {
		t.Fatal("List 未包含 id0009")
	}

	// 移出组（显式传空字符串）
	updated, err = svc.Save("id0009", SaveInput{Group: strPtr("")})
	if err != nil {
		t.Fatalf("Save ungroup: %v", err)
	}
	if updated.Group != "" {
		t.Fatalf("Group = %q, want 空", updated.Group)
	}
}

// 组注册表：写入→读取一致、成员顺序保留；文件不存在时返回空注册表。
func TestGroupsRegistryRoundTrip(t *testing.T) {
	svc, _ := newTestService(t)

	// groups.json 尚不存在：空注册表而非错误
	if reg := svc.GetGroups(); len(reg.Groups) != 0 {
		t.Fatalf("空 vault Groups = %v, want 空注册表", reg.Groups)
	}

	in := &storage.GroupRegistry{Groups: []storage.Group{
		{ID: "g-0001", Members: []string{"n3", "n1", "n2"}, Name: "灵感"},
		{ID: "g-0002", Members: []string{"n9"}},
	}}
	if err := svc.SaveGroups(in); err != nil {
		t.Fatalf("SaveGroups: %v", err)
	}

	got := svc.GetGroups()
	if len(got.Groups) != 2 {
		t.Fatalf("Groups 数 = %d, want 2", len(got.Groups))
	}
	if got.Groups[0].ID != "g-0001" || got.Groups[1].ID != "g-0002" {
		t.Fatalf("组 id = %q/%q, want g-0001/g-0002", got.Groups[0].ID, got.Groups[1].ID)
	}
	// 组名透传：命名字段必须原样往返；未命名组保持空串（omitempty 不落盘）
	if got.Groups[0].Name != "灵感" || got.Groups[1].Name != "" {
		t.Fatalf("组名 = %q/%q, want 灵感/空串", got.Groups[0].Name, got.Groups[1].Name)
	}
	// 成员顺序即组内叠放顺序，必须原样保留
	if strings.Join(got.Groups[0].Members, ",") != "n3,n1,n2" {
		t.Fatalf("成员顺序 = %v, want [n3 n1 n2]", got.Groups[0].Members)
	}
	if strings.Join(got.Groups[1].Members, ",") != "n9" {
		t.Fatalf("成员 = %v, want [n9]", got.Groups[1].Members)
	}

	// 整体替换：后写覆盖先写
	if err := svc.SaveGroups(&storage.GroupRegistry{Groups: []storage.Group{
		{ID: "g-0003", Members: []string{"n7"}},
	}}); err != nil {
		t.Fatalf("SaveGroups 替换: %v", err)
	}
	got = svc.GetGroups()
	if len(got.Groups) != 1 || got.Groups[0].ID != "g-0003" {
		t.Fatalf("替换后 Groups = %v, want 仅 g-0003", got.Groups)
	}
}

// 部分更新：只传 content 时保留原有标签。
func TestPartialUpdateContentKeepsTags(t *testing.T) {
	svc, _ := newTestService(t)
	if _, err := svc.Save("id0003", SaveInput{Content: strPtr("正文"), Tags: []string{"工作"}}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if _, err := svc.Save("id0003", SaveInput{Content: strPtr("正文改写")}); err != nil {
		t.Fatalf("Save content: %v", err)
	}
	got, err := svc.Get("id0003")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(got.Tags) != 1 || got.Tags[0] != "工作" {
		t.Fatalf("Tags = %v, want [工作]", got.Tags)
	}
}

// 改标题触发文件重命名。
func TestRenameOnTitleChange(t *testing.T) {
	svc, store := newTestService(t)
	if _, err := svc.Save("id0004", SaveInput{Content: strPtr("正文"), Title: "旧标题"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := svc.Save("id0004", SaveInput{Title: "新标题"}); err != nil {
		t.Fatalf("Save rename: %v", err)
	}
	p, _, err := store.Locate("id0004")
	if err != nil {
		t.Fatalf("Locate: %v", err)
	}
	base := filepath.Base(p)
	if !strings.Contains(base, "新标题") {
		t.Fatalf("path = %q, want slug of 新标题", p)
	}
	if strings.Contains(base, "旧标题") {
		t.Fatalf("path still uses old title: %q", p)
	}
}

// 速记进入 inbox、source=quick，并且能被搜索到。
func TestQuickCaptureGoesToInbox(t *testing.T) {
	svc, _ := newTestService(t)
	note, err := svc.QuickCapture("今天给产品团队发了版本说明")
	if err != nil {
		t.Fatalf("QuickCapture: %v", err)
	}
	if !note.Inbox || note.Source != "quick" {
		t.Fatalf("Inbox=%v Source=%q, want true/quick", note.Inbox, note.Source)
	}

	hits, err := svc.Search("版本", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	found := false
	for _, h := range hits {
		if h.ID == note.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("quick note not searchable, hits=%v", hits)
	}
}

// 颜色：设置后随笔记持久化；只传 content 的部分更新保留原色。
func TestColorPartialUpdate(t *testing.T) {
	svc, _ := newTestService(t)
	if _, err := svc.Save("id0008", SaveInput{Content: strPtr("正文"), Color: "green"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := svc.Get("id0008")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Color != "green" {
		t.Fatalf("Color = %q, want green", got.Color)
	}

	if _, err := svc.Save("id0008", SaveInput{Content: strPtr("正文改写")}); err != nil {
		t.Fatalf("Save content: %v", err)
	}
	got, err = svc.Get("id0008")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Color != "green" {
		t.Fatalf("部分更新后 Color = %q, want green", got.Color)
	}

	// 换色
	if _, err := svc.Save("id0008", SaveInput{Color: "pink"}); err != nil {
		t.Fatalf("Save color: %v", err)
	}
	got, _ = svc.Get("id0008")
	if got.Color != "pink" {
		t.Fatalf("换色后 Color = %q, want pink", got.Color)
	}
}

// 删除后 Get 报 not found；文件未物理删除，而是进了回收区（统一删除入口行为）。
func TestDeleteThenGetFails(t *testing.T) {
	svc, store := newTestService(t)
	if _, err := svc.Save("id0006", SaveInput{Content: strPtr("正文")}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := svc.Delete("id0006"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := svc.Get("id0006"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("Get after delete err = %v, want ErrNotFound", err)
	}
	// 回收区应有 1 个顶层条目（这条便签）
	count, _, err := store.TrashStats()
	if err != nil {
		t.Fatalf("TrashStats: %v", err)
	}
	if count != 1 {
		t.Errorf("删除后回收区条目 = %d, want 1", count)
	}
}

// Reindex 能拾取绕过服务直接写盘的文件。
func TestReindexPicksUpExternalFile(t *testing.T) {
	svc, store := newTestService(t)
	fm := &storage.Frontmatter{
		ID:        "id0007",
		Title:     "外部写入",
		CreatedAt: "2026-07-17T10:00:00+08:00",
		UpdatedAt: "2026-07-17T10:00:00+08:00",
	}
	if err := store.Save(fm, "星球大战观影计划", false); err != nil {
		t.Fatalf("store.Save: %v", err)
	}

	// 重建前搜不到（索引里没有），重建后应能命中
	if err := svc.Reindex(); err != nil {
		t.Fatalf("Reindex: %v", err)
	}
	hits, err := svc.Search("观影", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) == 0 || hits[0].ID != "id0007" {
		t.Fatalf("reindex 后应能搜到外部文件, hits=%v", hits)
	}
}

// deriveTitle 的 markdown 结构标记剥离（与 renderer NoteView.deriveTitle 同算法）。
func TestDeriveTitle(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    string
	}{
		{"纯文本", "今天天气不错", "今天天气不错"},
		{"一级标题", "# 周报", "周报"},
		{"多级标题", "### 会议纪要", "会议纪要"},
		{"井号无空格是标签不是标题", "#tag", "#tag"},
		{"空标题行跳过", "##\n真正的标题", "真正的标题"},
		{"引用", "> 摘录的一句话", "摘录的一句话"},
		{"无序列表", "- 买牛奶", "买牛奶"},
		{"星号列表", "* 买面包", "买面包"},
		{"有序列表", "1. 第一步", "第一步"},
		{"任务列表", "- [ ] 待办事项", "待办事项"},
		{"已完成任务", "- [x] 已完成", "已完成"},
		{"叠加前缀", "> ## 引用里的标题", "引用里的标题"},
		{"整行粗体", "**重要提醒**", "重要提醒"},
		{"整行斜体", "*强调*", "强调"},
		{"整行删除线", "~~过期计划~~", "过期计划"},
		{"整行行内代码", "`main.go`", "main.go"},
		{"嵌套包装", "**~~加粗删除线~~**", "加粗删除线"},
		{"半包装保留原文", "**重要**：明天交", "**重要**：明天交"},
		{"整行链接", "[设计文档](https://example.com)", "设计文档"},
		{"整行图片取alt", "![架构图](../attachments/a.png)", "架构图"},
		{"图片无alt跳过", "![](../attachments/a.png)\n后续行", "后续行"},
		// git 冲突标记守卫：标记行不参与标题推导（设计稿「标题推导跳过标记行」）
		{"冲突标记跳过取正文", "<<<<<<< HEAD（本地）\n本地标题\n=======\n远端标题\n>>>>>>> origin/main（远端）", "本地标题"},
		{"冲突块后取后续正文", "<<<<<<< HEAD（本地）\n=======\n>>>>>>> origin/main（远端）\n真正标题", "真正标题"},
		{"仅分隔符行跳过", "=======\n正文", "正文"},
		{"全是标记行回退未命名", "<<<<<<< HEAD（本地）\n=======\n>>>>>>> origin/main（远端）", "未命名"},
		{"空内容", "", "未命名"},
		{"全空行", "\n\n  \n", "未命名"},
		{
			"超长截断30rune",
			"一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十",
			"一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十…",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := deriveTitle(c.content); got != c.want {
				t.Errorf("deriveTitle(%q) = %q, want %q", c.content, got, c.want)
			}
		})
	}
}

// Save 带 Folder：新建便签落子文件夹；已存在便签忽略 folder 参数。
func TestSaveWithFolder(t *testing.T) {
	svc, _ := newTestService(t)
	content := "子文件夹新建"
	folder := "工作/项目A"
	note, err := svc.Save("fld01", SaveInput{Content: &content, Folder: &folder})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if note.Folder != "工作/项目A" {
		t.Errorf("Folder = %q, want 工作/项目A", note.Folder)
	}
	// 已存在便签传 folder 不改变位置（移动只能走 Move）
	other := "别的目录"
	note2, err := svc.Save("fld01", SaveInput{Content: &content, Folder: &other})
	if err != nil {
		t.Fatalf("Save 2: %v", err)
	}
	if note2.Folder != "工作/项目A" {
		t.Errorf("已存在便签位置不应被 folder 参数改变: %q", note2.Folder)
	}
}

// trash 删除文件夹后，其中便签从索引清除（文件离开 notes/ 不再可检索）。
func TestDeleteFolderTrashClearsIndex(t *testing.T) {
	svc, _ := newTestService(t)
	content := "回收区关键词便签"
	folder := "废弃"
	if _, err := svc.Save("tr01", SaveInput{Content: &content, Folder: &folder}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := svc.DeleteFolder("废弃", "trash"); err != nil {
		t.Fatalf("DeleteFolder: %v", err)
	}
	hits, err := svc.Search("回收区关键词", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 0 {
		t.Errorf("trash 后应搜不到: %v", hits)
	}
}
