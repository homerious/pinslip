// merge3.go — 非 fast-forward 三方合并（go-git 只支持 ff，这里自实现）。
//
// 流程：MergeBase 找共同祖先 → 收集 base/ours/theirs 三棵树的全部文件路径 →
// 逐路径按 diff3 语义取舍：
//   - 一侧未变（与 base 一致）→ 取另一侧（含删除）；
//   - 两侧改得一样 → 取一份；
//   - 文本（.md）两侧都改 → merge.go 的 MergeText，冲突则写入标准 markers；
//   - 二进制两侧都改 → 双方保留：远端保留原名，本地另存
//     name-冲突-YYYYMMDD-HHmmss.ext（图片没有「打开解冲突」的场景）。
//
// 全部路径处理完创建双亲合并提交（ours 在前，theirs 在后）。
package gitsync

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// mergeTheirs 把远端提交 remote 三方合并进当前 HEAD（local），
// 工作区必须干净（调用方保证）。
func (r *Repo) mergeTheirs(local, remote *object.Commit) (*PullOutcome, error) {
	bases, err := local.MergeBase(remote)
	if err != nil {
		return nil, fmt.Errorf("查找共同祖先失败: %w", err)
	}
	if len(bases) == 0 {
		return nil, withCode(CodeSyncUnrelatedHistories, fmt.Errorf("本地与远端没有共同祖先（unrelated histories），v1 不支持合并，请改用空仓库"))
	}
	base := bases[0]

	baseFiles, err := treeFiles(base)
	if err != nil {
		return nil, err
	}
	oursFiles, err := treeFiles(local)
	if err != nil {
		return nil, err
	}
	theirsFiles, err := treeFiles(remote)
	if err != nil {
		return nil, err
	}

	paths := unionPaths(baseFiles, oursFiles, theirsFiles)
	out := &PullOutcome{Kind: PullMerged}
	staged := map[string]bool{} // 避免二进制冲突新增路径重复暂存

	for _, p := range paths {
		bHash, bOK := baseFiles[p]
		oHash, oOK := oursFiles[p]
		tHash, tOK := theirsFiles[p]

		switch {
		case oOK == tOK && (!oOK || oHash == tHash):
			// 两侧一致（含同时删除、同时改成相同内容）：保持 ours，无需动作
		case bOK == oOK && (!bOK || bHash == oHash):
			// 仅远端改：取 theirs（含删除）
			if err := r.takeTheirs(p, remote, tOK, staged); err != nil {
				return nil, err
			}
		case bOK == tOK && (!bOK || bHash == tHash):
			// 仅本地改：保持 ours，无需动作
		default:
			// 两侧都改了且不一样
			if err := r.resolveConflict(p, base, local, remote, oOK, tOK, out, staged); err != nil {
				return nil, err
			}
		}
	}

	w, err := r.r.Worktree()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	sig := *commitAuthor
	sig.When = now
	hash, err := w.Commit(
		fmt.Sprintf("merge %s (sync %s)", r.cfg.Branch, now.Format("2006-01-02 15:04")),
		&git.CommitOptions{Author: &sig, Parents: []plumbing.Hash{local.Hash, remote.Hash}, AllowEmptyCommits: true},
	)
	if err != nil {
		return nil, fmt.Errorf("创建合并提交失败: %w", err)
	}
	out.MergeCommit = hash
	return out, nil
}

// takeTheirs 把路径 p 检出为 theirs 侧内容；tOK=false 表示删除。
func (r *Repo) takeTheirs(p string, remote *object.Commit, tOK bool, staged map[string]bool) error {
	w, err := r.r.Worktree()
	if err != nil {
		return err
	}
	if !tOK {
		if err := os.Remove(r.absPath(p)); err != nil && !os.IsNotExist(err) {
			return err
		}
		_, err := w.Remove(p)
		return err
	}
	content, _, err := readFileAt(remote, p)
	if err != nil {
		return err
	}
	if err := writeWorkFile(r.absPath(p), content); err != nil {
		return err
	}
	_, err = w.Add(p)
	return err
}

// resolveConflict 处理两侧都改了且不一致的路径。
func (r *Repo) resolveConflict(p string, base, local, remote *object.Commit,
	oOK, tOK bool, out *PullOutcome, staged map[string]bool) error {

	baseContent, _, err := readFileAt(base, p)
	if err != nil {
		return err
	}
	var ours, theirs []byte
	if oOK {
		if ours, _, err = readFileAt(local, p); err != nil {
			return err
		}
	}
	if tOK {
		if theirs, _, err = readFileAt(remote, p); err != nil {
			return err
		}
	}

	w, err := r.r.Worktree()
	if err != nil {
		return err
	}

	if IsTextPath(p) {
		// 文本：diff3 三方合并；一侧删除时该侧按空内容参与，
		// 结果必含冲突 markers——把删除决策显式暴露给用户
		merged, conflicts, err := MergeText(baseContent, ours, theirs)
		if err != nil {
			return fmt.Errorf("三方合并 %s 失败: %w", p, err)
		}
		if err := writeWorkFile(r.absPath(p), merged); err != nil {
			return err
		}
		if _, err := w.Add(p); err != nil {
			return err
		}
		if conflicts {
			out.ConflictedFiles = append(out.ConflictedFiles, p)
		}
		return nil
	}

	// 二进制：双方保留——远端保留原名，本地另存冲突副本
	if tOK {
		if err := writeWorkFile(r.absPath(p), theirs); err != nil {
			return err
		}
		if _, err := w.Add(p); err != nil {
			return err
		}
	} else {
		// 远端删除、本地修改：原名位置删除（索引按删除处理）
		if err := os.Remove(r.absPath(p)); err != nil && !os.IsNotExist(err) {
			return err
		}
		if _, err := w.Remove(p); err != nil {
			return err
		}
	}
	if oOK {
		dup := conflictCopyPath(r.absPath(p), time.Now())
		if err := writeWorkFile(dup, ours); err != nil {
			return err
		}
		rel := filepath.ToSlash(mustRel(r.dir, dup))
		if !staged[rel] {
			if _, err := w.Add(rel); err != nil {
				return err
			}
			staged[rel] = true
		}
		out.BinaryConflicts = append(out.BinaryConflicts, rel)
	}
	return nil
}

// conflictCopyPath 生成二进制冲突副本路径：name-冲突-YYYYMMDD-HHmmss.ext；
// 同秒重名时追加 -2、-3…。
func conflictCopyPath(abs string, now time.Time) string {
	ext := filepath.Ext(abs)
	stem := abs[:len(abs)-len(ext)]
	cand := fmt.Sprintf("%s-冲突-%s%s", stem, now.Format("20060102-150405"), ext)
	for i := 2; ; i++ {
		if _, err := os.Stat(cand); os.IsNotExist(err) {
			return cand
		}
		cand = fmt.Sprintf("%s-冲突-%s-%d%s", stem, now.Format("20060102-150405"), i, ext)
	}
}

// writeWorkFile 写工作区文件（自动建父目录）。
func writeWorkFile(abs string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	return os.WriteFile(abs, content, 0o644)
}

// unionPaths 三份路径表的并集（排序，保证合并确定性）。
func unionPaths(maps ...map[string]plumbing.Hash) []string {
	set := map[string]struct{}{}
	for _, m := range maps {
		for p := range m {
			set[p] = struct{}{}
		}
	}
	paths := make([]string, 0, len(set))
	for p := range set {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths
}

func mustRel(base, target string) string {
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return target
	}
	return rel
}
