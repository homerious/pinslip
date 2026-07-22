package storage

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// mkTrashEntry 在回收区造一个带文件的顶层条目，返回条目路径。
func mkTrashEntry(t *testing.T, e *Engine, name string, fileBytes int) string {
	t.Helper()
	dir := filepath.Join(e.trashDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if fileBytes > 0 {
		if err := os.WriteFile(filepath.Join(dir, "a.md"), make([]byte, fileBytes), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestTrashStats(t *testing.T) {
	e := newTestEngine(t)

	// 回收区不存在：零值而非错误
	count, bytes, err := e.TrashStats()
	if err != nil || count != 0 || bytes != 0 {
		t.Fatalf("空回收区: count=%d bytes=%d err=%v", count, bytes, err)
	}

	mkTrashEntry(t, e, "20260701-120000-旧文件夹", 100)
	mkTrashEntry(t, e, "20260710-120000-另一个", 50)

	count, bytes, err = e.TrashStats()
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Errorf("count = %d, want 2", count)
	}
	if bytes != 150 {
		t.Errorf("bytes = %d, want 150", bytes)
	}
}

func TestEmptyTrash(t *testing.T) {
	e := newTestEngine(t)
	mkTrashEntry(t, e, "20260701-120000-旧文件夹", 10)

	if err := e.EmptyTrash(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(e.trashDir()); !os.IsNotExist(err) {
		t.Errorf("清空后回收区应不存在, stat err = %v", err)
	}
	// 再次清空（目录不存在）不应报错
	if err := e.EmptyTrash(); err != nil {
		t.Errorf("重复清空: %v", err)
	}
}

func TestCleanTrash(t *testing.T) {
	e := newTestEngine(t)

	old := time.Now().AddDate(0, 0, -40).Format(trashNameLayout)
	fresh := time.Now().AddDate(0, 0, -5).Format(trashNameLayout)
	oldDir := mkTrashEntry(t, e, old+"-过期文件夹", 10)
	freshDir := mkTrashEntry(t, e, fresh+"-新文件夹", 10)
	// 无时间戳前缀的手动条目：Chtimes 改为 40 天前，应被按 ModTime 清掉
	manualDir := mkTrashEntry(t, e, "手动丢入的", 10)
	oldTime := time.Now().AddDate(0, 0, -40)
	if err := os.Chtimes(manualDir, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	removed, err := e.CleanTrash(30)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 {
		t.Errorf("removed = %d, want 2（过期前缀 + 过期 ModTime 手动条目）", removed)
	}
	if _, err := os.Stat(oldDir); !os.IsNotExist(err) {
		t.Error("过期条目应被清理")
	}
	if _, err := os.Stat(freshDir); err != nil {
		t.Error("新条目应保留")
	}

	// retentionDays <= 0：不清理
	if err := e.EmptyTrash(); err != nil {
		t.Fatal(err)
	}
	mkTrashEntry(t, e, old+"-过期文件夹", 10)
	removed, err = e.CleanTrash(0)
	if err != nil || removed != 0 {
		t.Errorf("retention=0: removed=%d err=%v, want 0,nil", removed, err)
	}
}

func TestTrashNote(t *testing.T) {
	e := newTestEngine(t)
	_ = e.Save(testFM("idt1", "笔记"), "正文", false)
	_ = e.Save(testFM("idt2", "速记"), "速记", true) // inbox

	// notes/ 下的便签
	if err := e.TrashNote("idt1"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.Locate("idt1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("trash 后 Locate 应 ErrNotFound, got %v", err)
	}
	// inbox/ 下的速记同样进回收区
	if err := e.TrashNote("idt2"); err != nil {
		t.Fatal(err)
	}

	entries, err := os.ReadDir(e.trashDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("回收区应有 2 个条目, got %d", len(entries))
	}
	for _, entry := range entries {
		name := entry.Name()
		// 命名：<时间戳>-<原文件名>，原文件名含 id
		if len(name) <= len(trashNameLayout) || name[len(trashNameLayout)] != '-' {
			t.Errorf("条目 %q 缺时间戳前缀", name)
		}
		if !strings.Contains(name, "idt") || !strings.HasSuffix(name, ".md") {
			t.Errorf("条目 %q 应含原文件名（带 id）", name)
		}
	}

	// 不存在的 id
	if err := e.TrashNote("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("TrashNote 不存在 id err = %v, want ErrNotFound", err)
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	e := newTestEngine(t)

	// 文件不存在：默认 30 天
	if s := e.LoadSettings(); s.TrashRetentionDays != DefaultTrashRetentionDays {
		t.Errorf("默认 TrashRetentionDays = %d, want %d",
			s.TrashRetentionDays, DefaultTrashRetentionDays)
	}

	if err := e.SaveSettings(&Settings{TrashRetentionDays: 7}); err != nil {
		t.Fatal(err)
	}
	if s := e.LoadSettings(); s.TrashRetentionDays != 7 {
		t.Errorf("写后读 = %d, want 7", s.TrashRetentionDays)
	}

	// 损坏的 JSON：回退默认值
	if err := os.WriteFile(e.settingsPath(), []byte("{oops"), 0o644); err != nil {
		t.Fatal(err)
	}
	if s := e.LoadSettings(); s.TrashRetentionDays != DefaultTrashRetentionDays {
		t.Errorf("损坏文件应回退默认 %d, got %d", DefaultTrashRetentionDays, s.TrashRetentionDays)
	}
}
