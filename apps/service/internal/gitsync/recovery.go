package gitsync

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/format/index"
	"github.com/go-git/go-git/v5/plumbing/object"
)

const recoveryMarker = "sync-recovery-required"

func (r *Repo) recoveryError() error {
	return withCode(CodeSyncRecoveryRequired, errors.New("历史仓库跟踪了本机运行时文件，且内容存在暂存删除；同步已暂停，请备份并从远端恢复"))
}

// 内置排除独立于 .gitignore：历史上已被跟踪的本机文件也不能被检出/删除。
func excludedSyncPath(p string) bool {
	return p == ".pinslip" || strings.HasPrefix(p, ".pinslip/") ||
		p == ".trash" || strings.HasPrefix(p, ".trash/") ||
		strings.HasPrefix(p, ".pinslip-index.db") ||
		path.Base(p) == ".DS_Store" || path.Base(p) == "Thumbs.db"
}

func contentSyncPath(p string) bool {
	for _, dir := range contentDirs {
		if strings.HasPrefix(p, dir+"/") {
			return true
		}
	}
	return false
}

// 必须先判断再清理索引，否则会丢失污染证据并提交用户未确认的内容删除。
func (r *Repo) checkRecoveryRequired() error {
	marker := filepath.Join(r.dir, ".pinslip", recoveryMarker)
	if _, err := os.Stat(marker); err == nil {
		return r.recoveryError()
	} else if !os.IsNotExist(err) {
		return err
	}
	head, err := r.r.Head()
	if errors.Is(err, plumbing.ErrReferenceNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	c, err := r.r.CommitObject(head.Hash())
	if err != nil {
		return err
	}
	files, err := treeFiles(c)
	if err != nil {
		return err
	}
	legacy := false
	for p := range files {
		if excludedSyncPath(p) {
			legacy = true
			break
		}
	}
	if !legacy {
		return nil
	}
	w, err := r.r.Worktree()
	if err != nil {
		return err
	}
	st, err := w.Status()
	if err != nil {
		return err
	}
	for p, s := range st {
		if contentSyncPath(p) && s.Staging == git.Deleted {
			// 失败的恢复可能已写入部分内容，必须跨重启保留暂停状态。
			if err := os.MkdirAll(filepath.Dir(marker), 0755); err != nil {
				return err
			}
			if err := os.WriteFile(marker, []byte("remote recovery required\n"), 0600); err != nil {
				return err
			}
			return r.recoveryError()
		}
	}
	return nil
}

// 只改索引；Worktree.Remove 会连本地数据库/配置一并删除，不能使用。
func (r *Repo) untrackRuntimeFiles() error {
	idx, err := r.r.Storer.Index()
	if err != nil {
		return err
	}
	kept := make([]*index.Entry, 0, len(idx.Entries))
	for _, e := range idx.Entries {
		if !excludedSyncPath(e.Name) {
			kept = append(kept, e)
		}
	}
	if len(kept) == len(idx.Entries) {
		return nil
	}
	idx.Entries = kept
	return r.r.Storer.SetIndex(idx)
}

// 远端恢复是显式替换：包括两棵树间没变、但本机已修改/暂存删除的文件。
// 新索引先在内存构建，文件全部写成功后提交；分支由调用方最后更新。
func (r *Repo) restoreRemoteTree(from, to *object.Commit) error {
	oldFiles := map[string]plumbing.Hash{}
	if from != nil {
		var err error
		oldFiles, err = treeFiles(from)
		if err != nil {
			return err
		}
	}
	oldIndex, err := r.r.Storer.Index()
	if err != nil {
		return err
	}
	for _, e := range oldIndex.Entries {
		oldFiles[e.Name] = e.Hash
	}
	target, err := treeFiles(to)
	if err != nil {
		return err
	}
	for _, p := range unionPaths(oldFiles) {
		if _, exists := target[p]; exists || excludedSyncPath(p) {
			continue
		}
		if err := os.Remove(r.absPath(p)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("删除 %s 失败: %w", p, err)
		}
	}
	tree, err := to.Tree()
	if err != nil {
		return err
	}
	idx := &index.Index{Version: 2}
	err = tree.Files().ForEach(func(f *object.File) error {
		if excludedSyncPath(f.Name) {
			return nil
		}
		content, ok, err := readFileAt(to, f.Name)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("目标树缺少文件 %s", f.Name)
		}
		if err := writeWorkFile(r.absPath(f.Name), content); err != nil {
			return fmt.Errorf("写入 %s 失败: %w", f.Name, err)
		}
		info, err := os.Stat(r.absPath(f.Name))
		if err != nil {
			return err
		}
		idx.Entries = append(idx.Entries, &index.Entry{Name: f.Name, Hash: f.Hash,
			Mode: f.Mode, Size: uint32(len(content)), ModifiedAt: info.ModTime(), CreatedAt: info.ModTime()})
		return nil
	})
	if err != nil {
		return err
	}
	return r.r.Storer.SetIndex(idx)
}
