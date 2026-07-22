package storage

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestEngine(t *testing.T) *Engine {
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
	return NewEngine(notesDir, inboxDir, filepath.Join(root, "attachments"))
}

func testFM(id, title string) *Frontmatter {
	return &Frontmatter{
		ID:        id,
		Title:     title,
		CreatedAt: "2026-07-17T10:00:00+08:00",
		UpdatedAt: "2026-07-17T10:00:00+08:00",
	}
}

func TestFileNameFor(t *testing.T) {
	cases := []struct {
		name      string
		id        string
		title     string
		createdAt string
		want      string
	}{
		{"正常", "abc123", "周会纪要", "2026-07-17T10:00:00+08:00", "周会纪要-20260717-abc123.md"},
		{"空标题", "abc123", "", "2026-07-17T10:00:00+08:00", "未命名-20260717-abc123.md"},
		{"非法字符", "abc123", `a/b:c*d?"<>| x`, "2026-07-17T10:00:00+08:00", "abcd x-20260717-abc123.md"},
		{"无日期", "abc123", "周会纪要", "", "周会纪要-abc123.md"},
		{"日期解析失败", "abc123", "周会纪要", "not-a-date", "周会纪要-abc123.md"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := FileNameFor(c.id, c.title, c.createdAt); got != c.want {
				t.Errorf("FileNameFor = %q, want %q", got, c.want)
			}
		})
	}
}

func TestFileNameForLongTitle(t *testing.T) {
	long := strings.Repeat("很", 50)
	got := FileNameFor("abc123", long, "2026-07-17T10:00:00+08:00")
	// slug 截断 30 字 + "-20260717-abc123.md"
	if len([]rune(got)) != 30+len([]rune("-20260717-abc123.md")) {
		t.Errorf("长标题未按 30 字截断: %q", got)
	}
}

func TestSlugify(t *testing.T) {
	if got := Slugify(`  a/b:c*d?"<>| x  `); got != "abcd x" {
		t.Errorf("Slugify = %q", got)
	}
	if got := Slugify("标题。"); got != "标题。" {
		t.Errorf("中文句号应保留: %q", got)
	}
	if got := Slugify("trailing..."); got != "trailing" {
		t.Errorf("结尾点应去除: %q", got)
	}
}

func TestSaveLoadLocate(t *testing.T) {
	e := newTestEngine(t)
	fm := testFM("id0001", "测试笔记")
	if err := e.Save(fm, "正文内容", false); err != nil {
		t.Fatal(err)
	}
	p, inbox, err := e.Locate("id0001")
	if err != nil {
		t.Fatal(err)
	}
	if inbox {
		t.Error("不应在 inbox")
	}
	if want := "测试笔记-20260717-id0001.md"; filepath.Base(p) != want {
		t.Errorf("文件名 = %q, want %q", filepath.Base(p), want)
	}
	gotFM, body, _, _, err := e.Load("id0001")
	if err != nil {
		t.Fatal(err)
	}
	if gotFM.Title != "测试笔记" || strings.TrimSpace(body) != "正文内容" {
		t.Errorf("Load 内容不符: title=%q body=%q", gotFM.Title, body)
	}
}

func TestRenameOnTitleChange(t *testing.T) {
	e := newTestEngine(t)
	fm := testFM("id0002", "旧标题")
	if err := e.Save(fm, "正文", false); err != nil {
		t.Fatal(err)
	}
	fm.Title = "新标题"
	if err := e.Save(fm, "正文", false); err != nil {
		t.Fatal(err)
	}
	p, _, err := e.Locate("id0002")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(filepath.Base(p), "新标题") {
		t.Errorf("重命名后文件名应含新标题: %q", p)
	}
	entries, _ := os.ReadDir(filepath.Dir(p))
	if len(entries) != 1 {
		t.Errorf("改标题后应只有一个文件, got %d", len(entries))
	}
}

func TestLegacyNamingCompat(t *testing.T) {
	e := newTestEngine(t)
	// 手写一个旧命名 <id>.md 文件
	legacy := filepath.Join(e.notesDir, "id0003.md")
	content := "---\nid: id0003\ntitle: 旧格式\n---\n\n旧正文\n"
	if err := os.WriteFile(legacy, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, body, _, _, err := e.Load("id0003"); err != nil || strings.TrimSpace(body) != "旧正文" {
		t.Errorf("旧命名应可读: body=%q err=%v", body, err)
	}
	// 保存后自动升级为新命名
	if err := e.Save(testFM("id0003", "旧格式"), "旧正文改", false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacy); !errors.Is(err, os.ErrNotExist) {
		t.Error("保存后旧命名文件应被清理")
	}
	p, _, _ := e.Locate("id0003")
	if !strings.Contains(filepath.Base(p), "旧格式-20260717-id0003.md") {
		t.Errorf("应升级为新命名: %q", p)
	}
}

func TestMoveBetweenNotesAndInbox(t *testing.T) {
	e := newTestEngine(t)
	fm := testFM("id0004", "移动测试")
	if err := e.Save(fm, "正文", false); err != nil {
		t.Fatal(err)
	}
	if err := e.Save(fm, "正文", true); err != nil {
		t.Fatal(err)
	}
	_, inbox, err := e.Locate("id0004")
	if err != nil || !inbox {
		t.Errorf("应定位到 inbox: inbox=%v err=%v", inbox, err)
	}
	entries, _ := os.ReadDir(e.notesDir)
	if len(entries) != 0 {
		t.Errorf("notes 目录应已清空, got %d", len(entries))
	}
}

func TestListAndDelete(t *testing.T) {
	e := newTestEngine(t)
	_ = e.Save(testFM("ida", "甲"), "甲", false)
	_ = e.Save(testFM("idb", "乙"), "乙", false)
	_ = e.Save(testFM("idc", "丙"), "丙", true)

	items, err := e.List()
	if err != nil || len(items) != 3 {
		t.Fatalf("List 应返回 3 条: %d err=%v", len(items), err)
	}
	inboxCount := 0
	for _, it := range items {
		if it.Inbox {
			inboxCount++
		}
	}
	if inboxCount != 1 {
		t.Errorf("inbox 应有 1 条, got %d", inboxCount)
	}

	if err := e.Delete("ida"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.Locate("ida"); !errors.Is(err, ErrNotFound) {
		t.Errorf("删除后应 ErrNotFound, got %v", err)
	}
}

func TestSaveAttachment(t *testing.T) {
	e := newTestEngine(t)

	// 正常保存：返回相对路径，文件存在且内容一致
	rel, err := e.SaveAttachment(".PNG", []byte{0x89, 0x50, 0x4e, 0x47})
	if err != nil {
		t.Fatalf("SaveAttachment: %v", err)
	}
	if !strings.HasPrefix(rel, "attachments/att-") || !strings.HasSuffix(rel, ".png") {
		t.Fatalf("unexpected rel path: %s", rel)
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(filepath.Dir(rel)), rel))
	if err != nil {
		// rel 是 vault 相对路径，测试环境拼 attachDir
		data2, err2 := os.ReadFile(filepath.Join(e.attachDir, filepath.Base(rel)))
		if err2 != nil {
			t.Fatalf("read back: %v / %v", err, err2)
		}
		data = data2
	}
	if len(data) != 4 || data[0] != 0x89 {
		t.Fatalf("content mismatch: %v", data)
	}

	// 白名单外的扩展名拒绝
	if _, err := e.SaveAttachment(".exe", []byte{1}); err == nil {
		t.Fatal("expected error for .exe")
	}

	// 连续两次保存不重名
	a, _ := e.SaveAttachment(".png", []byte{1})
	b, _ := e.SaveAttachment(".png", []byte{2})
	if a == b {
		t.Fatal("names should differ")
	}
}

func TestValidateFolder(t *testing.T) {
	valid := []string{"", "工作", "工作/项目A", "a/b/c", "2026 计划"}
	for _, v := range valid {
		if err := ValidateFolder(v); err != nil {
			t.Errorf("ValidateFolder(%q) 应通过, got %v", v, err)
		}
	}
	invalid := []string{"..", "../etc", "a/../b", "a//b", "/abs", "a/", "a" + `\` + "b", `a:b`, "trailing.", "trailing ", "."}
	for _, v := range invalid {
		if err := ValidateFolder(v); err == nil {
			t.Errorf("ValidateFolder(%q) 应拒绝", v)
		}
	}
}

func TestCreateAndListFolders(t *testing.T) {
	e := newTestEngine(t)
	if err := e.CreateFolder("工作/项目A"); err != nil {
		t.Fatal(err)
	}
	if err := e.CreateFolder("生活"); err != nil {
		t.Fatal(err)
	}
	// 重复创建为空操作
	if err := e.CreateFolder("工作"); err != nil {
		t.Fatal(err)
	}
	folders, err := e.ListFolders()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"工作", "工作/项目A", "生活"}
	if len(folders) != len(want) {
		t.Fatalf("ListFolders = %v, want %v", folders, want)
	}
	for i := range want {
		if folders[i] != want[i] {
			t.Fatalf("ListFolders = %v, want %v", folders, want)
		}
	}
	if err := e.CreateFolder("../escape"); err == nil {
		t.Error("目录穿越应被拒绝")
	}
}

func TestRecursiveLocateAndList(t *testing.T) {
	e := newTestEngine(t)
	// 直接在子文件夹里放一个笔记文件
	sub := filepath.Join(e.notesDir, "工作", "项目A")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	content := "---\nid: iddeep\ntitle: 深层笔记\n---\n\n正文\n"
	if err := os.WriteFile(filepath.Join(sub, "深层笔记-20260717-iddeep.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	// Locate 应递归找到
	p, inbox, err := e.Locate("iddeep")
	if err != nil || inbox {
		t.Fatalf("递归 Locate 失败: p=%q inbox=%v err=%v", p, inbox, err)
	}
	// Load 应返回 folder
	_, _, _, folder, err := e.Load("iddeep")
	if err != nil || folder != "工作/项目A" {
		t.Errorf("folder = %q, want 工作/项目A (err=%v)", folder, err)
	}
	// List 应递归收集
	items, err := e.List()
	if err != nil || len(items) != 1 || items[0].Folder != "工作/项目A" {
		t.Errorf("List 递归不符: %+v err=%v", items, err)
	}
}

func TestMoveNote(t *testing.T) {
	e := newTestEngine(t)
	fm := testFM("idmv", "待移动")
	if err := e.Save(fm, "正文", false); err != nil {
		t.Fatal(err)
	}
	// 移到嵌套文件夹（自动创建）
	if err := e.Move("idmv", "工作/项目A"); err != nil {
		t.Fatal(err)
	}
	p, _, err := e.Locate("idmv")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(p) != filepath.Join(e.notesDir, "工作", "项目A") {
		t.Errorf("移动后位置不符: %q", p)
	}
	// 文件名保持不变
	if filepath.Base(p) != "待移动-20260717-idmv.md" {
		t.Errorf("移动后文件名应保持不变: %q", filepath.Base(p))
	}
	// 再保存应留在新文件夹（不漂移回根目录）
	fm.Title = "待移动改名"
	if err := e.Save(fm, "正文", false); err != nil {
		t.Fatal(err)
	}
	p2, _, _ := e.Locate("idmv")
	if filepath.Dir(p2) != filepath.Join(e.notesDir, "工作", "项目A") {
		t.Errorf("保存后应留在子文件夹: %q", p2)
	}
	// 移回根目录
	if err := e.Move("idmv", ""); err != nil {
		t.Fatal(err)
	}
	p3, _, _ := e.Locate("idmv")
	if filepath.Dir(p3) != e.notesDir {
		t.Errorf("移回根目录失败: %q", p3)
	}
	// 非法目标
	if err := e.Move("idmv", "../x"); err == nil {
		t.Error("非法目标应被拒绝")
	}
	// 不存在 id
	if err := e.Move("noid", "工作"); !errors.Is(err, ErrNotFound) {
		t.Errorf("不存在 id 应 ErrNotFound, got %v", err)
	}
}

func TestMoveFromInbox(t *testing.T) {
	e := newTestEngine(t)
	fm := testFM("idinbox", "速记")
	if err := e.Save(fm, "正文", true); err != nil {
		t.Fatal(err)
	}
	if err := e.Move("idinbox", "工作"); err != nil {
		t.Fatal(err)
	}
	_, inbox, err := e.Locate("idinbox")
	if err != nil || inbox {
		t.Errorf("移出 inbox 后应 inbox=false: inbox=%v err=%v", inbox, err)
	}
	entries, _ := os.ReadDir(e.inboxDir)
	if len(entries) != 0 {
		t.Errorf("inbox 应已清空, got %d", len(entries))
	}
}

func TestMoveRewritesAttachmentDepth(t *testing.T) {
	e := newTestEngine(t)
	fm := testFM("idimg", "带图笔记")
	body := "前文\n\n![](../attachments/att-1.png)\n\n中间\n\n![alt](../attachments/att-2.png)\n"
	if err := e.Save(fm, body, false); err != nil {
		t.Fatal(err)
	}
	// 根目录 → 两层子文件夹：../ 应变 ../../../
	if err := e.Move("idimg", "工作/项目A"); err != nil {
		t.Fatal(err)
	}
	_, got, _, _, err := e.Load("idimg")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "]((../") || !strings.Contains(got, "](../../../attachments/att-1.png)") {
		t.Errorf("移入二层文件夹后前缀应为 ../../../: %q", got)
	}
	if !strings.Contains(got, "](../../../attachments/att-2.png)") {
		t.Errorf("第二张图也应重写: %q", got)
	}
	// 二层 → 根目录：恢复 ../
	if err := e.Move("idimg", ""); err != nil {
		t.Fatal(err)
	}
	_, got2, _, _, _ := e.Load("idimg")
	if !strings.Contains(got2, "](../attachments/att-1.png)") || strings.Contains(got2, "../../../") {
		t.Errorf("移回根目录后前缀应恢复 ../: %q", got2)
	}
	// 平级移动（深度相同）不重写：根目录 ↔ inbox 均为 1
	if err := e.Save(fm, body, true); err != nil { // 挪到 inbox
		t.Fatal(err)
	}
	if err := e.Move("idimg", "生活"); err != nil { // inbox(深度1) → notes/生活(深度2)，应重写
		t.Fatal(err)
	}
	_, got3, _, _, _ := e.Load("idimg")
	if !strings.Contains(got3, "](../../attachments/att-1.png)") {
		t.Errorf("inbox 移入一层文件夹后前缀应为 ../../: %q", got3)
	}
}

// SaveToFolder：新建落子文件夹（目录自动创建）；已存在便签位置保留。
func TestSaveToFolder(t *testing.T) {
	e := newTestEngine(t)
	if err := e.SaveToFolder(testFM("sf01", "子文件夹便签"), "内容", "工作/项目A"); err != nil {
		t.Fatalf("SaveToFolder: %v", err)
	}
	p, inbox, err := e.Locate("sf01")
	if err != nil {
		t.Fatalf("Locate: %v", err)
	}
	if inbox {
		t.Error("不应落在 inbox")
	}
	if got := e.folderOf(p); got != "工作/项目A" {
		t.Errorf("folder = %q, want 工作/项目A", got)
	}
	// 已存在便签再调 SaveToFolder：folder 被忽略，位置保留
	if err := e.SaveToFolder(testFM("sf01", "子文件夹便签"), "内容2", "别的目录"); err != nil {
		t.Fatalf("SaveToFolder 2: %v", err)
	}
	p2, _, _ := e.Locate("sf01")
	if got := e.folderOf(p2); got != "工作/项目A" {
		t.Errorf("已存在便签位置应保留, folder = %q", got)
	}
	// 目录穿越拒绝
	if err := e.SaveToFolder(testFM("sf02", "x"), "y", "../逃逸"); err == nil {
		t.Error("目录穿越应被拒绝")
	}
}

// RenameFolder：同级改名（嵌套路径）、冲突/非法/根目录/不存在的拒绝。
func TestRenameFolder(t *testing.T) {
	e := newTestEngine(t)
	_ = e.SaveToFolder(testFM("rn01", "便签"), "内容", "工作/项目A")
	if err := e.RenameFolder("工作/项目A", "项目B"); err != nil {
		t.Fatalf("RenameFolder: %v", err)
	}
	p, _, err := e.Locate("rn01")
	if err != nil {
		t.Fatalf("Locate: %v", err)
	}
	if got := e.folderOf(p); got != "工作/项目B" {
		t.Errorf("rename 后 folder = %q, want 工作/项目B", got)
	}
	// 目标名同级已存在
	_ = e.CreateFolder("工作/素材")
	if err := e.RenameFolder("工作/项目B", "素材"); err == nil {
		t.Error("目标已存在应报错")
	}
	// 含层级拒绝
	if err := e.RenameFolder("工作", "a/b"); err == nil {
		t.Error("新名称含层级应拒绝")
	}
	// 根目录拒绝
	if err := e.RenameFolder("", "x"); err == nil {
		t.Error("根目录应拒绝")
	}
	// 源不存在
	if err := e.RenameFolder("不存在", "x"); err == nil {
		t.Error("源不存在应报错")
	}
}

// DeleteFolder move 模式：子树便签上移根目录（附件前缀重写），随后删空目录。
func TestDeleteFolderMove(t *testing.T) {
	e := newTestEngine(t)
	_ = e.SaveToFolder(testFM("dm01", "深层"), "图: ../../../attachments/a.png", "工作/项目A")
	_ = e.SaveToFolder(testFM("dm02", "浅层"), "内容", "工作")
	removed, err := e.DeleteFolder("工作", "move")
	if err != nil {
		t.Fatalf("DeleteFolder: %v", err)
	}
	if len(removed) != 0 {
		t.Errorf("move 模式不应返回移除 id: %v", removed)
	}
	if _, err := os.Stat(filepath.Join(e.notesDir, "工作")); !os.IsNotExist(err) {
		t.Error("文件夹应已删除")
	}
	for _, id := range []string{"dm01", "dm02"} {
		p, _, err := e.Locate(id)
		if err != nil || e.folderOf(p) != "" {
			t.Errorf("%s 应移到根目录: folder=%q err=%v", id, e.folderOf(p), err)
		}
	}
	// 附件前缀重写为深度 1
	_, body, _, _, _ := e.Load("dm01")
	if !strings.Contains(body, "../attachments/a.png") || strings.Contains(body, "../../") {
		t.Errorf("附件前缀应重写为单层 ../: %q", body)
	}
}

// DeleteFolder trash 模式：整个文件夹移入 vault .trash/，返回便签 id。
func TestDeleteFolderTrash(t *testing.T) {
	e := newTestEngine(t)
	_ = e.SaveToFolder(testFM("dt01", "便签"), "内容", "废弃")
	removed, err := e.DeleteFolder("废弃", "trash")
	if err != nil {
		t.Fatalf("DeleteFolder: %v", err)
	}
	if len(removed) != 1 || removed[0] != "dt01" {
		t.Errorf("trash 应返回便签 id: %v", removed)
	}
	if _, _, err := e.Locate("dt01"); !errors.Is(err, ErrNotFound) {
		t.Errorf("trash 后 Locate 应 ErrNotFound: %v", err)
	}
	trashDir := filepath.Join(filepath.Dir(e.notesDir), ".trash")
	entries, _ := os.ReadDir(trashDir)
	if len(entries) != 1 {
		t.Fatalf(".trash 应有 1 个条目: %v", entries)
	}
	sub, _ := os.ReadDir(filepath.Join(trashDir, entries[0].Name()))
	if len(sub) != 1 || !strings.HasSuffix(sub[0].Name(), "-dt01.md") {
		t.Errorf(".trash 内容不符: %v", sub)
	}
}

// DeleteFolder 边界：空文件夹直接删；含非笔记文件拒绝（且便签不动）；根目录拒绝。
func TestDeleteFolderEmptyAndForeign(t *testing.T) {
	e := newTestEngine(t)
	_ = e.CreateFolder("空目录/子层")
	if _, err := e.DeleteFolder("空目录", "move"); err != nil {
		t.Fatalf("空文件夹删除: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.notesDir, "空目录")); !os.IsNotExist(err) {
		t.Error("空文件夹应已删除")
	}
	// 含非笔记文件：move 模式拒绝，便签不动
	_ = e.SaveToFolder(testFM("df01", "便签"), "内容", "混合")
	if err := os.WriteFile(filepath.Join(e.notesDir, "混合", "随手记.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := e.DeleteFolder("混合", "move"); err == nil {
		t.Error("含非笔记文件应拒绝删除")
	}
	if _, _, err := e.Locate("df01"); err != nil {
		t.Error("拒绝删除时便签不应被动")
	}
	if _, err := e.DeleteFolder("", "move"); err == nil {
		t.Error("根目录应拒绝删除")
	}
}
