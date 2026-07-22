package storage

import (
	"os"
	"path/filepath"
	"time"
)

// trashNameLayout 是回收区条目名的时间戳前缀格式（见 DeleteFolder trash 模式）。
const trashNameLayout = "20060102-150405"

// trashDir 返回回收区目录：<vault>/.trash（与 notes/ 同级）。
func (e *Engine) trashDir() string {
	return filepath.Join(filepath.Dir(e.notesDir), ".trash")
}

// TrashStats 统计回收区：count 为顶层条目数（每个条目 = 一次删除的文件夹），
// bytes 为全部文件大小合计。回收区不存在时返回零值而非错误。
func (e *Engine) TrashStats() (count int, bytes int64, err error) {
	entries, err := os.ReadDir(e.trashDir())
	if os.IsNotExist(err) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	count = len(entries)
	for _, entry := range entries {
		info, statErr := entry.Info()
		if statErr != nil {
			continue
		}
		if !info.IsDir() {
			bytes += info.Size()
			continue
		}
		_ = filepath.Walk(filepath.Join(e.trashDir(), entry.Name()),
			func(_ string, fi os.FileInfo, walkErr error) error {
				if walkErr == nil && !fi.IsDir() {
					bytes += fi.Size()
				}
				return nil
			})
	}
	return count, bytes, nil
}

// EmptyTrash 清空回收区（整个目录移除；下次 trash 删除时 DeleteFolder 会重建）。
func (e *Engine) EmptyTrash() error {
	if err := os.RemoveAll(e.trashDir()); err != nil {
		return err
	}
	return nil
}

// TrashNote 把单条笔记移入回收区：<时间戳>-<原文件名>（与文件夹 trash 条目同层）。
// notes/ 与 inbox/ 下的笔记都适用；文件名内含 id，天然防撞名。
// 附件留在共享的 attachments/ 不动（与文件夹 trash 一致）。
func (e *Engine) TrashNote(id string) error {
	p, _, err := e.Locate(id)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(e.trashDir(), 0o755); err != nil {
		return err
	}
	dst := filepath.Join(e.trashDir(),
		time.Now().Format(trashNameLayout)+"-"+filepath.Base(p))
	return os.Rename(p, dst)
}

// CleanTrash 清理回收区中超过 retentionDays 天的顶层条目，返回清理数。
// 条目年龄优先按名称时间戳前缀（删除时刻）判断；用户手动丢进去的无前缀
// 条目回退按修改时间判断。retentionDays <= 0 表示不清理。
func (e *Engine) CleanTrash(retentionDays int) (int, error) {
	if retentionDays <= 0 {
		return 0, nil
	}
	entries, err := os.ReadDir(e.trashDir())
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	cutoff := time.Now().AddDate(0, 0, -retentionDays)
	removed := 0
	for _, entry := range entries {
		at, ok := trashEntryTime(entry)
		if !ok {
			continue
		}
		if at.Before(cutoff) {
			if err := os.RemoveAll(filepath.Join(e.trashDir(), entry.Name())); err != nil {
				return removed, err
			}
			removed++
		}
	}
	return removed, nil
}

// trashEntryTime 判断回收区条目的"删除时刻"：名前缀时间戳优先，回退修改时间。
func trashEntryTime(entry os.DirEntry) (time.Time, bool) {
	name := entry.Name()
	if len(name) > len(trashNameLayout) && name[len(trashNameLayout)] == '-' {
		if t, err := time.ParseInLocation(trashNameLayout,
			name[:len(trashNameLayout)], time.Local); err == nil {
			return t, true
		}
	}
	// 手动丢入的条目（无前缀）：按修改时间，且忽略路径里带 - 但前缀非法的情况
	if info, err := entry.Info(); err == nil {
		return info.ModTime(), true
	}
	return time.Time{}, false
}
