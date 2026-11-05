// divergence.go — 分叉（unrelated histories）的人工接管。
//
// 背景：本地 .git 撕裂重建/换机未克隆直接 init 后，本地历史与远端旧快照无共同
// 祖先，三方合并报 SYNC_UNRELATED_HISTORIES 卡死。机器无法判断该听哪边
// （远端可能是该覆盖的旧快照，也可能是别台设备的独有内容），所以选择永远
// 留给人——本文件提供判断所需的参考信息（status 分叉字段）与两个接管动作：
//
//   - local（以本地为准）：force-push 覆盖远端，远端分叉历史被丢弃；
//   - remote（以远端为准）：先把 notes//inbox//attachments/ 备份到
//     .pinslip/backups/divergence-<时间戳>/（回收区有自动清理，备份不容许被清，
//     故不落 .trash/；.pinslip/ 在 gitignore 内不污染同步内容），再重置本地
//     分支到远端 head 并按树差异检出。
//
// 纪律（changes/add-sync-divergence-resolve/design.md）：
//   - 参考信息全部基于本地数据（worktree + 最近一次 fetch 的 origin 引用），
//     MUST NOT 为此发起网络请求；只在分叉状态计算，正常同步路径零开销；
//   - 来历不明的远端（无 .pinslip-repo 标记）MUST NOT 给接管入口；
//   - 两个动作都不自成状态机：opMu 临界区内完成后跑一轮 syncCycle 验证，
//     失败按既有 codeOr 兜底码路径进 lastError/lastErrorCode。
package gitsync

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// errResolvePrecondition 分叉接管前置校验失败（非分叉状态/远端无标记/策略非法），
// HTTP 层据此返回 400；执行失败不走它（记 lastError 后返回最新状态，同 syncNow 语义）。
var errResolvePrecondition = errors.New("分叉接管前置校验失败")

// contentDirs 是同步内容目录（备份与检出都以它们为范围）。
var contentDirs = []string{"notes", "inbox", "attachments"}

// countWorktreeNotes 数 worktree notes/ 下的 .md 文件数（目录不存在返回 0）。
func countWorktreeNotes(vaultDir string) int {
	n := 0
	_ = filepath.WalkDir(filepath.Join(vaultDir, "notes"), func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(d.Name(), ".md") {
			n++
		}
		return nil
	})
	return n
}

// countTreeNotes 数提交树 notes/ 下的 .md 文件数。
func countTreeNotes(c *object.Commit) int {
	t, err := c.Tree()
	if err != nil {
		return 0
	}
	n := 0
	_ = t.Files().ForEach(func(f *object.File) error {
		if strings.HasPrefix(f.Name, "notes/") && strings.HasSuffix(f.Name, ".md") {
			n++
		}
		return nil
	})
	return n
}

// fillRemoteDivergenceInfo 填远端侧分叉参考字段（RemoteIsPinslip /
// RemoteLastCommitAt / RemoteNotes），全部基于最近一次 fetch 的 origin 引用。
// 容错：本地无 origin 引用或提交读不出来时字段留缺省，不阻断 status。
func fillRemoteDivergenceInfo(repo *Repo, st *Status) {
	ref, err := repo.r.Reference(plumbing.NewRemoteReferenceName("origin", repo.cfg.Branch), true)
	if err != nil {
		return
	}
	c, err := repo.r.CommitObject(ref.Hash())
	if err != nil {
		return
	}
	at := c.Committer.When
	st.RemoteLastCommitAt = &at
	_, ferr := c.File(markerFile)
	isPinslip := ferr == nil
	st.RemoteIsPinslip = &isPinslip
	st.RemoteNotes = countTreeNotes(c)
}

// ResolveDivergence 分叉人工接管入口：strategy 为 "local" 或 "remote"。
// 前置校验失败（策略非法/非分叉状态/远端无标记）返回 errResolvePrecondition
// 包装错误（HTTP 400）；执行失败记 lastError/lastErrorCode 后原样返回
// （HTTP 层按 syncNow 语义返回最新状态）。成功后跑一轮 syncCycle 验证。
func (e *Engine) ResolveDivergence(strategy string) error {
	if strategy != "local" && strategy != "remote" {
		return fmt.Errorf("%w: strategy 必须是 local 或 remote, got %q", errResolvePrecondition, strategy)
	}
	if err := e.resolveDivergence(strategy); err != nil {
		return err
	}
	// 接回正常循环验证（决策 5：不自成状态机；未启用时 SyncNow 为 no-op）
	return e.SyncNow()
}

// resolveDivergence 在 opMu 临界区内执行接管动作（与同步循环天然串行）。
func (e *Engine) resolveDivergence(strategy string) error {
	e.opMu.Lock()
	defer e.opMu.Unlock()

	e.mu.RLock()
	repo, cfg, code := e.repo, e.cfg, e.lastErrorCode
	e.mu.RUnlock()
	if cfg == nil || !cfg.Enabled || repo == nil || (code != CodeSyncUnrelatedHistories && code != CodeSyncRecoveryRequired) {
		return fmt.Errorf("%w: 当前不是分叉状态，无需接管", errResolvePrecondition)
	}
	if code == CodeSyncRecoveryRequired && strategy != "remote" {
		return fmt.Errorf("%w: 恢复保护仅允许备份后从远端恢复", errResolvePrecondition)
	}
	// 来历不明的远端（连标记都没有）不给接管：这种仓库更可能是地址填错了，
	// 给入口等于帮用户把数据推进火坑（决策 1）
	pinslip, err := repo.remoteHasMarker()
	if err != nil {
		return fmt.Errorf("%w: 读取远端引用失败: %v", errResolvePrecondition, err)
	}
	if !pinslip {
		return fmt.Errorf("%w: 远端缺少 %s 标记（来历不明），不提供接管", errResolvePrecondition, markerFile)
	}

	switch strategy {
	case "local":
		if err := repo.ForcePush(); err != nil {
			return e.failCycle(CodeSyncPushFailed, "以本地为准覆盖远端失败", err)
		}
		e.logger.Info("分叉接管完成：已以本地为准覆盖远端", "url", cfg.URL, "branch", cfg.Branch)
		return nil
	default: // remote
		// 先备份再检出：备份失败必须中止，不检出（决策 3）
		backupDir, err := backupContentDirs(e.vaultDir)
		if err != nil {
			return e.failCycle(CodeSyncPullFailed, "分叉接管备份失败（未检出）", err)
		}
		if err := repo.ResetToRemote(); err != nil {
			return e.failCycle(CodeSyncPullFailed, "以远端为准重建本地失败", err)
		}
		e.logger.Info("分叉接管完成：已备份并检出远端版本",
			"url", cfg.URL, "branch", cfg.Branch, "backup", backupDir)
		return nil
	}
}

// backupContentDirs 把 notes//inbox//attachments/ 复制到
// .pinslip/backups/divergence-<yyyymmdd-hhmmss>-<随机后缀>/（目录不存在跳过；
// 三个都不存在时不建空备份目录）。返回备份目录路径。
func backupContentDirs(vaultDir string) (string, error) {
	var dst string
	for _, sub := range contentDirs {
		src := filepath.Join(vaultDir, sub)
		if _, err := os.Stat(src); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return "", localIOErr("检查待备份目录失败", err)
		}
		if dst == "" {
			parent := filepath.Join(vaultDir, ".pinslip", "backups")
			if err := os.MkdirAll(parent, 0755); err != nil {
				return "", err
			}
			var err error
			dst, err = os.MkdirTemp(parent, "divergence-"+time.Now().Format("20060102-150405")+"-")
			if err != nil {
				return "", err
			}
		}
		if err := copyDir(src, filepath.Join(dst, sub)); err != nil {
			return "", fmt.Errorf("备份 %s 失败: %w", sub, err)
		}
	}
	return dst, nil
}

// copyDir 递归复制目录（保留相对结构；文件权限统一 0644/0755，
// 备份只要求内容可读，不追求元数据保真）。
func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(p, target)
	})
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
