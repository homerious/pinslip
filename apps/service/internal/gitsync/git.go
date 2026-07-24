// git.go — go-git 薄封装。vault 根即仓库根；只同步工作区内容文件，
// .gitignore 排除运行时文件（.trash/、索引库、.pinslip/ 配置区等）。
//
// go-git v5 的 Pull/Merge 只支持 fast-forward，非 ff 三方合并在 merge3.go
// 自实现（MergeBase + merge.go 的 diff3 MergeText）。
package gitsync

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/transport"
	githttp "github.com/go-git/go-git/v5/plumbing/transport/http"
	"github.com/go-git/go-git/v5/storage/memory"
)

// markerFile 是「本 vault 的同步仓库」识别标记，随仓库提交分发。
// 远端非空时有它才允许接入，否则报错引导用户使用空仓库。
const markerFile = ".pinslip-repo"

// markerContent 标记文件内容：版本号留作未来兼容升级的钩子。
const markerContent = "pinslip sync repository v1\n"

// gitignoreContent 首次 init 自动写入。设计稿条目全保留；
// 额外加 .pinslip/——索引库实际位于 .pinslip/pinslip.db，同步配置（含 token）
// 也在 .pinslip/ 下，必须排除在 git 跟踪之外（设计稿的 .pinslip-index.db*
// 是旧路径名，保留以防万一）。
const gitignoreContent = `.trash/
.pinslip/
.pinslip-index.db*
.DS_Store
Thumbs.db
`

// commitAuthor 是全部自动提交使用的签名（本机服务提交，不冒充用户身份）。
var commitAuthor = &object.Signature{Name: "PinSlip", Email: "pinslip@localhost"}

// Repo 封装 vault 根上的 git 仓库操作。
type Repo struct {
	r   *git.Repository
	dir string // vault 根（工作区）
	cfg SyncConfig
}

// auth HTTPS BasicAuth：username + token（token 作 password）。
// 本地 file:// 远端（测试）无需凭证，返回 nil。
func (r *Repo) auth() transport.AuthMethod {
	if r.cfg.Username == "" && r.cfg.Token == "" {
		return nil
	}
	return &githttp.BasicAuth{Username: r.cfg.Username, Password: r.cfg.Token}
}

// Connect 打开或首次接入同步仓库：
//   - vault 已是 pinslip 同步仓库（.git + 标记文件）→ 打开并校正 origin；
//   - vault 已是其他 git 仓库（无标记）→ 报错，不接管用户自己的仓库；
//   - 远端空 → init + 全量首次提交 + push；
//   - 远端非空 → 校验标记文件：是 pinslip 仓库则接入（fetch + reset），
//     否则返回「请使用空仓库」的友好错误。
func Connect(dir string, cfg SyncConfig) (*Repo, error) {
	if err := cfg.normalize(); err != nil {
		return nil, err
	}
	repo := &Repo{dir: dir, cfg: cfg}

	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return repo.openExisting()
	}
	return repo.firstConnect()
}

// openExisting 打开已有 .git 的 vault：必须是 pinslip 同步仓库（有标记）。
func (r *Repo) openExisting() (*Repo, error) {
	gr, err := git.PlainOpen(r.dir)
	if err != nil {
		return nil, fmt.Errorf("打开 vault 仓库失败: %w", err)
	}
	// 标记文件在工作区或任一提交里存在即可认定是 pinslip 仓库
	if _, err := os.Stat(filepath.Join(r.dir, markerFile)); err != nil {
		if !r.markerInHistory(gr) {
			return nil, withCode(CodeSyncLocalNotPinslipRepo, errors.New("vault 已是一个 git 仓库但不是 PinSlip 同步仓库（缺少 .pinslip-repo 标记），请手动处理 .git 后再配置同步"))
		}
	}
	r.r = gr
	if err := r.ensureRemote(); err != nil {
		return nil, err
	}
	// .gitignore / 标记文件补齐（老仓库可能缺）：写入后由后续 commit-all 提交
	_ = os.WriteFile(filepath.Join(r.dir, ".gitignore"), []byte(gitignoreContent), 0o644)
	_ = os.WriteFile(filepath.Join(r.dir, markerFile), []byte(markerContent), 0o644)
	return r, nil
}

// markerInHistory 检查 HEAD 提交树里是否有标记文件。
func (r *Repo) markerInHistory(gr *git.Repository) bool {
	head, err := gr.Head()
	if err != nil {
		return false
	}
	c, err := gr.CommitObject(head.Hash())
	if err != nil {
		return false
	}
	if _, err := c.File(markerFile); err == nil {
		return true
	}
	return false
}

// ensureRemote 保证 origin 指向配置的 URL（不存在则建，不同则改）。
func (r *Repo) ensureRemote() error {
	rem, err := r.r.Remote("origin")
	switch {
	case errors.Is(err, git.ErrRemoteNotFound):
		_, err = r.r.CreateRemote(&config.RemoteConfig{Name: "origin", URLs: []string{r.cfg.URL}})
		return err
	case err != nil:
		return err
	}
	if urls := rem.Config().URLs; len(urls) != 1 || urls[0] != r.cfg.URL {
		cfg, err := r.r.Config()
		if err != nil {
			return err
		}
		rc := cfg.Remotes["origin"]
		rc.URLs = []string{r.cfg.URL}
		return r.r.Storer.SetConfig(cfg)
	}
	return nil
}

// firstConnect 无 .git 的首次接入。
func (r *Repo) firstConnect() (*Repo, error) {
	refs, err := listRemoteRefs(r.cfg.URL, r.auth())
	if err != nil {
		return nil, withCode(CodeSyncRemoteAccess, fmt.Errorf("无法访问远端仓库（检查地址/用户名/token）: %w", err))
	}

	gr, err := git.PlainInitWithOptions(r.dir, &git.PlainInitOptions{
		InitOptions: git.InitOptions{DefaultBranch: plumbing.NewBranchReferenceName(r.cfg.Branch)},
	})
	if err != nil {
		return nil, fmt.Errorf("初始化仓库失败: %w", err)
	}
	r.r = gr
	if err := r.ensureRemote(); err != nil {
		return nil, err
	}

	if len(refs) == 0 {
		// 远端空：全量首次提交 + push
		if err := r.writeMetaFiles(); err != nil {
			return nil, err
		}
		if _, _, err := r.CommitAll(); err != nil {
			return nil, fmt.Errorf("首次提交失败: %w", err)
		}
		if err := r.Push(); err != nil {
			return nil, fmt.Errorf("首次推送失败: %w", err)
		}
		return r, nil
	}

	// 远端非空：fetch 后校验标记
	if err := r.Fetch(); err != nil {
		return nil, fmt.Errorf("拉取远端失败: %w", err)
	}
	remoteRef, err := r.r.Reference(plumbing.NewRemoteReferenceName("origin", r.cfg.Branch), true)
	if err != nil {
		return nil, withCode(CodeSyncBranchNotFound, fmt.Errorf("远端没有分支 %q，请确认分支名或改用空仓库", r.cfg.Branch))
	}
	rc, err := r.r.CommitObject(remoteRef.Hash())
	if err != nil {
		return nil, err
	}
	if _, err := rc.File(markerFile); err != nil {
		return nil, withCode(CodeSyncRemoteNotPinslipRepo, errors.New("远端仓库不是 PinSlip 的同步仓库（缺少 .pinslip-repo 标记），为避免历史纠缠请使用空仓库"))
	}
	// 接入：本地分支指向远端并检出。
	// 注意（v1 简化）：本地同名路径文件会被远端版本覆盖（checkDirty=false 不拦截），
	// 该路径设计用于新设备接入（vault 为空）；非空 vault 接入异机仓库前先自行备份。
	// 差异之外的文件（.pinslip/ 运行时文件、无关本地文件）一律不动。
	if err := r.applyTreeDiff(nil, rc, false); err != nil {
		return nil, fmt.Errorf("检出远端内容失败: %w", err)
	}
	if err := r.r.Storer.SetReference(plumbing.NewHashReference(
		plumbing.NewBranchReferenceName(r.cfg.Branch), remoteRef.Hash())); err != nil {
		return nil, err
	}
	return r, nil
}

// applyTreeDiff 把工作区与索引从 from 提交更新到 to 提交（from=nil 表示空树），
// 只检出/删除两棵树的差异路径，差异之外的文件一律不碰。
//
// 为什么不用 go-git 的 Reset(HardReset)：其实现链 ResetSparsely → resetWorktree →
// diffStagingWithWorktree → checkoutChange → rmFileAndDirsIfEmpty 会把
// 「不在目标树里的工作区文件」全部当作删除候选——包括未跟踪与被 .gitignore
// 排除的运行时文件（.pinslip/pinslip.db 正被服务以 SQLite 打开、
// .pinslip/git-sync.json 是同步配置本身，删了同步即自毁），删完还会递归
// 清理空目录。Windows 上文件锁让它显式报错，Linux 上打开中的文件被静默
// unlink——同样有害但更隐蔽。故所有检出必须按树差异逐路径进行。
//
// checkDirty=true 时（正常 ff），差异路径与本地未提交/未跟踪文件相交则拒绝
// （等价 git 的覆盖保护）；gitignore 排除的文件本就不在 status 内，天然豁免。
func (r *Repo) applyTreeDiff(from, to *object.Commit, checkDirty bool) error {
	var fromTree *object.Tree
	if from != nil {
		t, err := from.Tree()
		if err != nil {
			return err
		}
		fromTree = t
	}
	toTree, err := to.Tree()
	if err != nil {
		return err
	}
	changes, err := object.DiffTree(fromTree, toTree) // fromTree=nil 按空树处理
	if err != nil {
		return err
	}
	if checkDirty {
		if err := r.ensureNoDirtyOverlap(changes); err != nil {
			return err
		}
	}

	w, err := r.r.Worktree()
	if err != nil {
		return err
	}
	for _, ch := range changes {
		if ch.To.Name == "" {
			// 删除（DiffTree 不做 rename 检测：删除即 To 为空）
			if err := os.Remove(r.absPath(ch.From.Name)); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("删除 %s 失败: %w", ch.From.Name, err)
			}
			if _, err := w.Remove(ch.From.Name); err != nil {
				return fmt.Errorf("从索引移除 %s 失败: %w", ch.From.Name, err)
			}
			continue
		}
		content, ok, err := readFileAt(to, ch.To.Name)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("目标树缺少文件 %s", ch.To.Name)
		}
		if err := writeWorkFile(r.absPath(ch.To.Name), content); err != nil {
			return fmt.Errorf("写入 %s 失败: %w", ch.To.Name, err)
		}
		if _, err := w.Add(ch.To.Name); err != nil {
			return fmt.Errorf("暂存 %s 失败: %w", ch.To.Name, err)
		}
	}
	return nil
}

// ensureNoDirtyOverlap 差异路径若与本地未提交/未跟踪文件相交则报错
// （gitignore 排除的文件不在 status 内，不会误拦）。
func (r *Repo) ensureNoDirtyOverlap(changes object.Changes) error {
	if len(changes) == 0 {
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
	for _, ch := range changes {
		path := ch.To.Name
		if path == "" {
			path = ch.From.Name
		}
		if fs, ok := st[path]; ok && (fs.Staging != git.Unmodified || fs.Worktree != git.Unmodified) {
			return withCode(CodeSyncDirtyWorktree, fmt.Errorf("本地有未提交/未跟踪的变更会被远端覆盖: %s（请先提交或移开该文件）", path))
		}
	}
	return nil
}

// writeMetaFiles 写入 .gitignore 与标记文件（幂等）。
func (r *Repo) writeMetaFiles() error {
	if err := os.WriteFile(filepath.Join(r.dir, ".gitignore"), []byte(gitignoreContent), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(r.dir, markerFile), []byte(markerContent), 0o644)
}

// listRemoteRefs ls-remote：列出远端全部引用（用于判断远端是否为空）。
// 空仓库返回 (nil, nil)——go-git 以 ErrEmptyRemoteRepository 表示该信号。
func listRemoteRefs(url string, auth transport.AuthMethod) ([]*plumbing.Reference, error) {
	rem := git.NewRemote(memory.NewStorage(), &config.RemoteConfig{Name: "origin", URLs: []string{url}})
	refs, err := rem.List(&git.ListOptions{Auth: auth})
	if errors.Is(err, transport.ErrEmptyRemoteRepository) {
		return nil, nil
	}
	return refs, err
}

// Fetch 拉取远端引用（origin/*）。已是最新不算错误。
func (r *Repo) Fetch() error {
	err := r.r.Fetch(&git.FetchOptions{RemoteName: "origin", Auth: r.auth()})
	if errors.Is(err, git.NoErrAlreadyUpToDate) {
		return nil
	}
	return err
}

// CommitAll 提交工作区全部变更（add -A 语义），返回提交哈希与文件数；
// 无变更时返回零值。提交消息：sync YYYY-MM-DD HH:mm (n files)。
func (r *Repo) CommitAll() (plumbing.Hash, int, error) {
	w, err := r.r.Worktree()
	if err != nil {
		return plumbing.ZeroHash, 0, err
	}
	st, err := w.Status()
	if err != nil {
		return plumbing.ZeroHash, 0, err
	}
	if st.IsClean() {
		return plumbing.ZeroHash, 0, nil
	}
	paths := make([]string, 0, len(st))
	for p := range st {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		if st[p].Worktree == git.Deleted {
			// w.Remove 容忍工作区文件已不存在（deleteFromFilesystem 忽略 IsNotExist）
			if _, err := w.Remove(p); err != nil {
				return plumbing.ZeroHash, 0, fmt.Errorf("暂存删除 %s 失败: %w", p, err)
			}
		} else {
			if _, err := w.Add(p); err != nil {
				return plumbing.ZeroHash, 0, fmt.Errorf("暂存 %s 失败: %w", p, err)
			}
		}
	}
	now := time.Now()
	msg := fmt.Sprintf("sync %s (%d files)", now.Format("2006-01-02 15:04"), len(paths))
	sig := *commitAuthor
	sig.When = now
	hash, err := w.Commit(msg, &git.CommitOptions{Author: &sig})
	if err != nil {
		return plumbing.ZeroHash, 0, err
	}
	return hash, len(paths), nil
}

// PullKind 描述一次 pull 的结果。
type PullKind int

const (
	PullUpToDate   PullKind = iota // 本地与远端一致
	PullLocalAhead                 // 本地领先，无需合并
	PullFastForward                // 快进到远端
	PullMerged                     // 非 ff 三方合并（可能有冲突 markers）
)

// PullOutcome 是一次 pull 的结果详情。
type PullOutcome struct {
	Kind            PullKind
	MergeCommit     plumbing.Hash // Kind == PullMerged 时的合并提交
	ConflictedFiles []string      // 写入冲突 markers 的文本文件（vault 相对路径）
	BinaryConflicts []string      // 二进制冲突双留时本地副本的新路径
}

// Pull 拉取并合并远端变更：fetch 后按分叉情况快进或走 merge3.go 的三方合并。
func (r *Repo) Pull() (*PullOutcome, error) {
	if err := r.Fetch(); err != nil {
		return nil, fmt.Errorf("fetch 失败: %w", err)
	}
	remoteRef, err := r.r.Reference(plumbing.NewRemoteReferenceName("origin", r.cfg.Branch), true)
	if errors.Is(err, plumbing.ErrReferenceNotFound) {
		// 远端分支尚未建立（如对端还一次都没推）：视为已最新
		return &PullOutcome{Kind: PullUpToDate}, nil
	}
	if err != nil {
		return nil, err
	}

	head, err := r.r.Head()
	if errors.Is(err, plumbing.ErrReferenceNotFound) {
		// 本地尚无提交：直接对齐远端
		if err := r.fastForward(remoteRef.Hash()); err != nil {
			return nil, err
		}
		return &PullOutcome{Kind: PullFastForward}, nil
	}
	if err != nil {
		return nil, err
	}

	if head.Hash() == remoteRef.Hash() {
		return &PullOutcome{Kind: PullUpToDate}, nil
	}

	local, err := r.r.CommitObject(head.Hash())
	if err != nil {
		return nil, err
	}
	remote, err := r.r.CommitObject(remoteRef.Hash())
	if err != nil {
		return nil, err
	}

	localAhead, err := isAncestor(remote, local)
	if err != nil {
		return nil, err
	}
	if localAhead {
		return &PullOutcome{Kind: PullLocalAhead}, nil
	}
	remoteAhead, err := isAncestor(local, remote)
	if err != nil {
		return nil, err
	}
	if remoteAhead {
		if err := r.fastForward(remoteRef.Hash()); err != nil {
			return nil, err
		}
		return &PullOutcome{Kind: PullFastForward}, nil
	}

	// 分叉：三方合并。工作区必须干净（引擎在 pull 前先 commit-all）。
	w, err := r.r.Worktree()
	if err != nil {
		return nil, err
	}
	st, err := w.Status()
	if err != nil {
		return nil, err
	}
	if !st.IsClean() {
		return nil, withCode(CodeSyncDirtyWorktree, errors.New("工作区有未提交变更，无法合并（请先提交）"))
	}
	return r.mergeTheirs(local, remote)
}

// fastForward 把本地分支快进到 remoteHash（调用方保证祖先关系）。
// 检出走 applyTreeDiff（只动两树差异路径，不碰 .pinslip/ 等树外文件，
// 详见该函数注释）；本地无提交时按空树全量检出。
func (r *Repo) fastForward(remoteHash plumbing.Hash) error {
	remote, err := r.r.CommitObject(remoteHash)
	if err != nil {
		return err
	}
	var from *object.Commit
	head, err := r.r.Head()
	switch {
	case err == nil:
		if from, err = r.r.CommitObject(head.Hash()); err != nil {
			return err
		}
	case errors.Is(err, plumbing.ErrReferenceNotFound):
		from = nil
	default:
		return err
	}
	if err := r.applyTreeDiff(from, remote, true); err != nil {
		return err
	}
	return r.r.Storer.SetReference(plumbing.NewHashReference(
		plumbing.NewBranchReferenceName(r.cfg.Branch), remoteHash))
}

// Push 推送本地分支到 origin。已是最新不算错误。
func (r *Repo) Push() error {
	err := r.r.Push(&git.PushOptions{RemoteName: "origin", Auth: r.auth()})
	if errors.Is(err, git.NoErrAlreadyUpToDate) {
		return nil
	}
	return err
}

// PushContext 带超时的推送（退出时尽力 push 用）。
func (r *Repo) PushContext(ctx context.Context) error {
	err := r.r.PushContext(ctx, &git.PushOptions{RemoteName: "origin", Auth: r.auth()})
	if errors.Is(err, git.NoErrAlreadyUpToDate) {
		return nil
	}
	return err
}

// AheadBehind 统计本地相对 origin/<branch> 的领先/落后提交数
// （只读本地引用，不做网络请求；远端位置取决于最近一次 fetch）。
// 个人 vault 历史短，两次全量可达性遍历的开销可忽略。
func (r *Repo) AheadBehind() (ahead, behind int, err error) {
	head, err := r.r.Head()
	if errors.Is(err, plumbing.ErrReferenceNotFound) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	localSet, err := reachableSet(r.r, head.Hash())
	if err != nil {
		return 0, 0, err
	}
	remoteRef, err := r.r.Reference(plumbing.NewRemoteReferenceName("origin", r.cfg.Branch), true)
	if errors.Is(err, plumbing.ErrReferenceNotFound) {
		return len(localSet), 0, nil // 远端还没有此分支：全部领先
	}
	if err != nil {
		return 0, 0, err
	}
	remoteSet, err := reachableSet(r.r, remoteRef.Hash())
	if err != nil {
		return 0, 0, err
	}
	for h := range localSet {
		if _, ok := remoteSet[h]; !ok {
			ahead++
		}
	}
	for h := range remoteSet {
		if _, ok := localSet[h]; !ok {
			behind++
		}
	}
	return ahead, behind, nil
}

// Dirty 报告工作区是否有未提交变更。
func (r *Repo) Dirty() (bool, error) {
	w, err := r.r.Worktree()
	if err != nil {
		return false, err
	}
	st, err := w.Status()
	if err != nil {
		return false, err
	}
	return !st.IsClean(), nil
}

// HeadHash 返回当前 HEAD 哈希（零值表示无提交）。
func (r *Repo) HeadHash() plumbing.Hash {
	head, err := r.r.Head()
	if err != nil {
		return plumbing.ZeroHash
	}
	return head.Hash()
}

// isAncestor 报告 anc 是否为 desc 的祖先（含相等）。
func isAncestor(anc, desc *object.Commit) (bool, error) {
	if anc.Hash == desc.Hash {
		return true, nil
	}
	// 沿 desc 的父链 BFS；用 anc 的提交时间剪枝（更老的提交不可能是它）
	set, err := reachableSetSince(desc, anc.Committer.When)
	if err != nil {
		return false, err
	}
	_, ok := set[anc.Hash]
	return ok, nil
}

// reachableSet 从 start 出发的全部可达提交哈希。
func reachableSet(r *git.Repository, start plumbing.Hash) (map[plumbing.Hash]struct{}, error) {
	c, err := r.CommitObject(start)
	if err != nil {
		return nil, err
	}
	return reachableSetSince(c, time.Time{})
}

// reachableSetSince BFS 收集可达提交；遇到提交时间早于 since 的节点即停止展开
// （父提交不会比子提交更晚——允许同秒，故用 strictly before 判断）。
func reachableSetSince(start *object.Commit, since time.Time) (map[plumbing.Hash]struct{}, error) {
	set := map[plumbing.Hash]struct{}{}
	queue := []*object.Commit{start}
	for len(queue) > 0 {
		c := queue[0]
		queue = queue[1:]
		if _, ok := set[c.Hash]; ok {
			continue
		}
		set[c.Hash] = struct{}{}
		if !since.IsZero() && c.Committer.When.Before(since) {
			continue
		}
		err := c.Parents().ForEach(func(p *object.Commit) error {
			if _, ok := set[p.Hash]; !ok {
				queue = append(queue, p)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return set, nil
}

// readFileAt 读取提交中的文件内容；不存在返回 (nil, false, nil)。
func readFileAt(c *object.Commit, path string) ([]byte, bool, error) {
	f, err := c.File(path)
	if err != nil {
		return nil, false, nil // object.ErrFileNotFound 及其包装都按不存在处理
	}
	rd, err := f.Reader()
	if err != nil {
		return nil, false, err
	}
	defer rd.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(rd); err != nil {
		return nil, false, err
	}
	return buf.Bytes(), true, nil
}

// treeFiles 收集提交树中全部文件路径 → blob 哈希。
func treeFiles(c *object.Commit) (map[string]plumbing.Hash, error) {
	t, err := c.Tree()
	if err != nil {
		return nil, err
	}
	files := map[string]plumbing.Hash{}
	err = t.Files().ForEach(func(f *object.File) error {
		files[f.Name] = f.Hash
		return nil
	})
	return files, err
}

// IsTextPath 报告路径是否按文本处理（设计稿：只有 .md 走 diff3/markers）。
func IsTextPath(path string) bool {
	return strings.HasSuffix(strings.ToLower(path), ".md")
}

// absPath vault 相对（git 风格正斜杠）→ 本地绝对路径。
func (r *Repo) absPath(rel string) string {
	return filepath.Join(r.dir, filepath.FromSlash(rel))
}
