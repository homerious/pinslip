// sync_test.go — hermetic 集成测试：t.TempDir + 本地裸仓库（file 传输）当 remote。
// 覆盖：首次接入 push、双 vault 互同步、干净合并、行冲突 markers、二进制双留、
// 引擎 auto-commit + SyncNow。
package gitsync

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"
	gitconfig "github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
)

// --- 测试辅助 ---

type tLogger struct{ t *testing.T }

func (l tLogger) Info(msg string, kv ...any)  { l.t.Log(append([]any{"[INFO]", msg}, kv...)...) }
func (l tLogger) Error(msg string, kv ...any) { l.t.Log(append([]any{"[ERROR]", msg}, kv...)...) }

// newBareRemote 建本地裸仓库当远端，返回其路径（go-git 原生 file 传输直接吃路径）。
func newBareRemote(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "remote.git")
	if _, err := git.PlainInit(dir, true); err != nil {
		t.Fatalf("建裸仓库失败: %v", err)
	}
	return dir
}

// newVault 建空 vault 目录结构。
func newVault(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, sub := range []string{"notes", "inbox", "attachments"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func writeVaultFile(t *testing.T, vault, rel string, content []byte) {
	t.Helper()
	abs := filepath.Join(vault, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, content, 0o644); err != nil {
		t.Fatal(err)
	}
}

func readVaultFile(t *testing.T, vault, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(vault, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("读取 %s 失败: %v", rel, err)
	}
	return string(data)
}

func testConfig(remote string) SyncConfig {
	return SyncConfig{URL: remote, Branch: "main", Enabled: true}
}

// connectVault 接入同步仓库（断言成功）。
func connectVault(t *testing.T, vault, remote string) *Repo {
	t.Helper()
	r, err := Connect(vault, testConfig(remote))
	if err != nil {
		t.Fatalf("Connect 失败: %v", err)
	}
	return r
}

// syncOnce 完整一轮：commit-all + pull + push。
func syncOnce(t *testing.T, r *Repo) {
	t.Helper()
	if _, _, err := r.CommitAll(); err != nil {
		t.Fatalf("CommitAll 失败: %v", err)
	}
	if _, err := r.Pull(); err != nil {
		t.Fatalf("Pull 失败: %v", err)
	}
	if err := r.Push(); err != nil {
		t.Fatalf("Push 失败: %v", err)
	}
}

// remoteFileContent 读取裸仓库 main 分支树中的文件内容。
func remoteFileContent(t *testing.T, remoteDir, rel string) (string, bool) {
	t.Helper()
	br, err := git.PlainOpen(remoteDir)
	if err != nil {
		t.Fatalf("打开裸仓库失败: %v", err)
	}
	ref, err := br.Reference(plumbing.NewBranchReferenceName("main"), true)
	if err != nil {
		return "", false
	}
	c, err := br.CommitObject(ref.Hash())
	if err != nil {
		t.Fatal(err)
	}
	content, ok, err := readFileAt(c, rel)
	if err != nil {
		t.Fatal(err)
	}
	return string(content), ok
}

// --- 用例 ---

// 首次接入：vault 有内容 + 远端空 → init + 全量提交 + push。
func TestConnectEmptyRemotePush(t *testing.T) {
	remote := newBareRemote(t)
	vault := newVault(t)
	writeVaultFile(t, vault, "notes/购物清单-abc123.md", []byte("---\nid: abc123\n---\n牛奶\n"))

	connectVault(t, vault, remote)

	// 标记与 .gitignore 落盘
	for _, f := range []string{markerFile, ".gitignore"} {
		if _, err := os.Stat(filepath.Join(vault, f)); err != nil {
			t.Errorf("%s 应写入 vault 根: %v", f, err)
		}
	}
	// 远端可见笔记与标记文件
	if content, ok := remoteFileContent(t, remote, "notes/购物清单-abc123.md"); !ok || !strings.Contains(content, "牛奶") {
		t.Errorf("远端应有笔记文件, ok=%v content=%q", ok, content)
	}
	if _, ok := remoteFileContent(t, remote, markerFile); !ok {
		t.Error("远端应有 .pinslip-repo 标记")
	}
	// .pinslip/ 配置区绝不进远端（token 安全）
	if _, ok := remoteFileContent(t, remote, ".pinslip/git-sync.json"); ok {
		t.Error(".pinslip/ 不应被同步")
	}
	// 已同步：ahead/behind 归零
	r := connectVault(t, vault, remote) // 重开路径也要能打开（已有 .git）
	ahead, behind, err := r.AheadBehind()
	if err != nil {
		t.Fatal(err)
	}
	if ahead != 0 || behind != 0 {
		t.Errorf("同步后 ahead=%d behind=%d, 应均为 0", ahead, behind)
	}
}

// 远端非空但非 pinslip 仓库 → 友好报错「请使用空仓库」。
func TestConnectForeignRemoteRejected(t *testing.T) {
	remote := newBareRemote(t)
	// 造一个普通提交推进远端（main 分支、无 pinslip 标记）
	seed := t.TempDir()
	gr, err := git.PlainInitWithOptions(seed, &git.PlainInitOptions{
		InitOptions: git.InitOptions{DefaultBranch: plumbing.NewBranchReferenceName("main")},
	})
	if err != nil {
		t.Fatal(err)
	}
	writeVaultFile(t, seed, "README.md", []byte("hello\n"))
	w, _ := gr.Worktree()
	if _, err := w.Add("README.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Commit("init", &git.CommitOptions{Author: commitAuthor}); err != nil {
		t.Fatal(err)
	}
	if _, err := gr.CreateRemote(&gitconfig.RemoteConfig{Name: "origin", URLs: []string{remote}}); err != nil {
		t.Fatal(err)
	}
	if err := gr.Push(&git.PushOptions{}); err != nil {
		t.Fatal(err)
	}

	vault := newVault(t)
	_, err = Connect(vault, testConfig(remote))
	if err == nil {
		t.Fatal("非 pinslip 远端应拒绝接入")
	}
	if !strings.Contains(err.Error(), "空仓库") {
		t.Errorf("错误应引导使用空仓库: %v", err)
	}
	if got := codeOf(err); got != CodeSyncRemoteNotPinslipRepo {
		t.Errorf("codeOf = %q, want %q", got, CodeSyncRemoteNotPinslipRepo)
	}
}

// 双 vault 互同步（模拟双设备）：A 改 B 见、B 改 A 见。
func TestTwoVaultsSync(t *testing.T) {
	remote := newBareRemote(t)
	vaultA := newVault(t)
	writeVaultFile(t, vaultA, "notes/a-aaa.md", []byte("A 的笔记\n"))
	repoA := connectVault(t, vaultA, remote) // 首次接入 → push

	// B：新设备接入（远端有标记 → adopt）
	vaultB := newVault(t)
	repoB := connectVault(t, vaultB, remote)
	if got := readVaultFile(t, vaultB, "notes/a-aaa.md"); got != "A 的笔记\n" {
		t.Errorf("B 应拉到 A 的笔记, got %q", got)
	}

	// B 写新笔记 → A 可见
	writeVaultFile(t, vaultB, "notes/b-bbb.md", []byte("B 的笔记\n"))
	syncOnce(t, repoB)
	if _, err := repoA.Pull(); err != nil {
		t.Fatalf("A Pull 失败: %v", err)
	}
	if got := readVaultFile(t, vaultA, "notes/b-bbb.md"); got != "B 的笔记\n" {
		t.Errorf("A 应拉到 B 的笔记, got %q", got)
	}

	// A 改同一笔记 → B 可见
	writeVaultFile(t, vaultA, "notes/a-aaa.md", []byte("A 的笔记 v2\n"))
	syncOnce(t, repoA)
	if _, err := repoB.Pull(); err != nil {
		t.Fatalf("B Pull 失败: %v", err)
	}
	if got := readVaultFile(t, vaultB, "notes/a-aaa.md"); got != "A 的笔记 v2\n" {
		t.Errorf("B 应拉到 A 的修改, got %q", got)
	}
}

// setupSyncedPair 造一对已同步 vault（含共同基础文件），返回两侧 Repo。
func setupSyncedPair(t *testing.T, baseRel string, baseContent []byte) (string, *Repo, string, *Repo) {
	t.Helper()
	remote := newBareRemote(t)
	vaultA := newVault(t)
	writeVaultFile(t, vaultA, baseRel, baseContent)
	repoA := connectVault(t, vaultA, remote)
	vaultB := newVault(t)
	repoB := connectVault(t, vaultB, remote)
	return vaultA, repoA, vaultB, repoB
}

// 同文件不同段落 → 自动合并无 markers。
func TestMergeCleanDifferentRegions(t *testing.T) {
	base := []byte("l1\nl2\nl3\nl4\nl5\n")
	vaultA, repoA, vaultB, repoB := setupSyncedPair(t, "notes/doc.md", base)

	// A 改开头并推送
	writeVaultFile(t, vaultA, "notes/doc.md", []byte("L1\nl2\nl3\nl4\nl5\n"))
	syncOnce(t, repoA)

	// B 改结尾（基于旧版本）→ pull 触发三方合并
	writeVaultFile(t, vaultB, "notes/doc.md", []byte("l1\nl2\nl3\nl4\nL5\n"))
	if _, _, err := repoB.CommitAll(); err != nil {
		t.Fatal(err)
	}
	outcome, err := repoB.Pull()
	if err != nil {
		t.Fatalf("B Pull 失败: %v", err)
	}
	if outcome.Kind != PullMerged {
		t.Errorf("应为三方合并, got %v", outcome.Kind)
	}
	if len(outcome.ConflictedFiles) != 0 {
		t.Errorf("不同段落不应冲突: %v", outcome.ConflictedFiles)
	}
	got := readVaultFile(t, vaultB, "notes/doc.md")
	if want := "L1\nl2\nl3\nl4\nL5\n"; got != want {
		t.Errorf("合并结果\ngot:  %q\nwant: %q", got, want)
	}
	if strings.Contains(got, "<<<<<<<") {
		t.Error("干净合并不应含 markers")
	}

	// B push → A pull → 内容一致
	if err := repoB.Push(); err != nil {
		t.Fatal(err)
	}
	if _, err := repoA.Pull(); err != nil {
		t.Fatal(err)
	}
	if got := readVaultFile(t, vaultA, "notes/doc.md"); got != "L1\nl2\nl3\nl4\nL5\n" {
		t.Errorf("A 侧应为合并结果, got %q", got)
	}
}

// 同一行冲突 → markers 文件落地且能 push，另一侧 pull 到 markers 文件。
func TestMergeConflictMarkersRoundTrip(t *testing.T) {
	base := []byte("x\ny\nz\n")
	vaultA, repoA, vaultB, repoB := setupSyncedPair(t, "notes/doc.md", base)

	writeVaultFile(t, vaultA, "notes/doc.md", []byte("x\ny-A\nz\n"))
	syncOnce(t, repoA)

	writeVaultFile(t, vaultB, "notes/doc.md", []byte("x\ny-B\nz\n"))
	if _, _, err := repoB.CommitAll(); err != nil {
		t.Fatal(err)
	}
	outcome, err := repoB.Pull()
	if err != nil {
		t.Fatalf("B Pull 失败: %v", err)
	}
	if outcome.Kind != PullMerged {
		t.Fatalf("应为三方合并, got %v", outcome.Kind)
	}
	if len(outcome.ConflictedFiles) != 1 || outcome.ConflictedFiles[0] != "notes/doc.md" {
		t.Errorf("ConflictedFiles 应为 notes/doc.md: %v", outcome.ConflictedFiles)
	}

	got := readVaultFile(t, vaultB, "notes/doc.md")
	for _, want := range []string{
		"<<<<<<< HEAD（本地）\n", "y-B\n", "=======\n", "y-A\n", ">>>>>>> origin/main（远端）\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("markers 文件缺少 %q:\n%q", want, got)
		}
	}
	// B 侧扫描可见冲突
	if files := scanConflictedFiles(vaultB); len(files) != 1 || files[0] != "notes/doc.md" {
		t.Errorf("scanConflictedFiles 应报 notes/doc.md: %v", files)
	}

	// 冲突文件照常提交并 push，不阻塞同步
	if _, _, err := repoB.CommitAll(); err != nil {
		t.Fatal(err)
	}
	if err := repoB.Push(); err != nil {
		t.Fatalf("含 markers 的合并应可推送: %v", err)
	}
	// A pull 到 markers 文件
	if _, err := repoA.Pull(); err != nil {
		t.Fatal(err)
	}
	gotA := readVaultFile(t, vaultA, "notes/doc.md")
	if !strings.Contains(gotA, "<<<<<<< HEAD（本地）") || !strings.Contains(gotA, "y-B") {
		t.Errorf("A 应拉到 markers 文件:\n%q", gotA)
	}
	if files := scanConflictedFiles(vaultA); len(files) != 1 {
		t.Errorf("A 侧扫描应见 1 个冲突文件: %v", files)
	}
}

// 二进制冲突 → 双方保留（远端原名 + 本地冲突副本）。
func TestMergeBinaryBothKept(t *testing.T) {
	vaultA, repoA, vaultB, repoB := setupSyncedPair(t, "attachments/pic.png", []byte("\x89PNG-base"))

	writeVaultFile(t, vaultA, "attachments/pic.png", []byte("\x89PNG-A-版本"))
	syncOnce(t, repoA)

	writeVaultFile(t, vaultB, "attachments/pic.png", []byte("\x89PNG-B-版本"))
	if _, _, err := repoB.CommitAll(); err != nil {
		t.Fatal(err)
	}
	outcome, err := repoB.Pull()
	if err != nil {
		t.Fatalf("B Pull 失败: %v", err)
	}
	if len(outcome.BinaryConflicts) != 1 {
		t.Fatalf("应有 1 个二进制冲突: %+v", outcome)
	}
	// 远端（A）版本保留原名
	if got := readVaultFile(t, vaultB, "attachments/pic.png"); got != "\x89PNG-A-版本" {
		t.Errorf("原名应保留远端内容, got %q", got)
	}
	// 本地（B）版本另存冲突副本
	dup := outcome.BinaryConflicts[0]
	if !strings.HasPrefix(dup, "attachments/pic-冲突-") || !strings.HasSuffix(dup, ".png") {
		t.Errorf("副本命名应为 pic-冲突-<时间>.png: %s", dup)
	}
	if got := readVaultFile(t, vaultB, dup); got != "\x89PNG-B-版本" {
		t.Errorf("副本应保留本地内容, got %q", got)
	}

	// push → 对端也能拿到两个文件
	if _, _, err := repoB.CommitAll(); err != nil {
		t.Fatal(err)
	}
	if err := repoB.Push(); err != nil {
		t.Fatal(err)
	}
	if _, err := repoA.Pull(); err != nil {
		t.Fatal(err)
	}
	if got := readVaultFile(t, vaultA, "attachments/pic.png"); got != "\x89PNG-A-版本" {
		t.Errorf("A 侧原名文件应保持远端内容, got %q", got)
	}
	if got := readVaultFile(t, vaultA, dup); got != "\x89PNG-B-版本" {
		t.Errorf("A 侧应拉到 B 的冲突副本, got %q", got)
	}
}

// 引擎冒烟：Reconfigure 接入 → watch 防抖 auto-commit → SyncNow 推送 → 远端可见。
func TestEngineAutoCommitAndSyncNow(t *testing.T) {
	remote := newBareRemote(t)
	vault := newVault(t)
	writeVaultFile(t, vault, "notes/first.md", []byte("第一条\n"))

	eng, err := NewEngine(vault, tLogger{t})
	if err != nil {
		t.Fatal(err)
	}
	eng.debounce = 50 * time.Millisecond      // 测试提速：防抖 50ms
	eng.pushInterval = time.Hour              // 关掉定时 push，只测手动路径
	defer eng.Stop()

	if err := eng.Reconfigure(testConfig(remote)); err != nil {
		t.Fatalf("Reconfigure 失败: %v", err)
	}
	// Reconfigure 的首轮同步（循环启动时）应已把 first.md 推上去
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, ok := remoteFileContent(t, remote, "notes/first.md"); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("首轮同步后远端应有 first.md")
		}
		time.Sleep(50 * time.Millisecond)
	}

	// 写入新文件 → 防抖 auto-commit（本地领先）
	writeVaultFile(t, vault, "notes/second.md", []byte("第二条\n"))
	deadline = time.Now().Add(5 * time.Second)
	for {
		st := eng.GetStatus()
		if st.Ahead > 0 && st.LastError == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("auto-commit 未生效: %+v", st)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// SyncNow → 推送，远端可见，ahead 归零
	if err := eng.SyncNow(); err != nil {
		t.Fatalf("SyncNow 失败: %v", err)
	}
	if content, ok := remoteFileContent(t, remote, "notes/second.md"); !ok || content != "第二条\n" {
		t.Errorf("远端应有 second.md, ok=%v content=%q", ok, content)
	}
	st := eng.GetStatus()
	if st.Ahead != 0 {
		t.Errorf("SyncNow 后 ahead 应归零: %+v", st)
	}
	if !st.Enabled || st.LastSyncAt.IsZero() {
		t.Errorf("状态应 enabled 且有同步时间: %+v", st)
	}

	// 另一设备接入可见两条笔记
	vaultB := newVault(t)
	connectVault(t, vaultB, remote)
	if got := readVaultFile(t, vaultB, "notes/second.md"); got != "第二条\n" {
		t.Errorf("对端应见 second.md, got %q", got)
	}
}

// token 保留语义：Reconfigure 传空 token = 不修改已存 token（渲染层表单不回显
// token，只改地址/分支时不能把凭证抹掉）；传新 token 则替换。
func TestReconfigureKeepsToken(t *testing.T) {
	vault := newVault(t)
	eng, err := NewEngine(vault, tLogger{t})
	if err != nil {
		t.Fatal(err)
	}

	// 首次配置：token 落盘（启用会因远端不可达而失败，这里只关心配置持久化）
	cfg := SyncConfig{URL: "https://example.com/a.git", Username: "u", Token: "secret-1", Branch: "main", Enabled: false}
	if err := eng.Reconfigure(cfg); err != nil {
		t.Fatal(err)
	}
	stored, err := loadSyncConfig(vault)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Token != "secret-1" {
		t.Fatalf("token 应已落盘: %q", stored.Token)
	}

	// 改地址（换仓库）+ 空 token → 保留原 token
	if err := eng.Reconfigure(SyncConfig{URL: "https://example.com/b.git", Username: "u", Branch: "main", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	stored, _ = loadSyncConfig(vault)
	if stored.Token != "secret-1" || stored.URL != "https://example.com/b.git" {
		t.Fatalf("空 token 应保留原值: %+v", stored)
	}

	// 显式传新 token → 替换
	if err := eng.Reconfigure(SyncConfig{URL: "https://example.com/b.git", Username: "u", Token: "secret-2", Branch: "main", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	stored, _ = loadSyncConfig(vault)
	if stored.Token != "secret-2" {
		t.Fatalf("新 token 应替换旧值: %q", stored.Token)
	}
}

// 断网恢复专项（设计稿验收清单）：指向不可达 remote 制造失败 → 本地编辑 →
// remote 恢复 → backoff 自动追上且远端可见。
func TestOfflineRecoveryCatchUp(t *testing.T) {
	// 「不可达」remote：一个不存在的路径（file 传输直接失败，等价断网）
	missing := filepath.Join(t.TempDir(), "not-exist", "remote.git")

	vault := newVault(t)
	writeVaultFile(t, vault, "notes/before.md", []byte("断网前的笔记\n"))

	eng, err := NewEngine(vault, tLogger{t})
	if err != nil {
		t.Fatal(err)
	}
	eng.debounce = 50 * time.Millisecond
	eng.pushInterval = 100 * time.Millisecond
	eng.backoff = []time.Duration{80 * time.Millisecond, 120 * time.Millisecond, 200 * time.Millisecond}
	defer eng.Stop()

	// 配置指向不可达远端：接入失败（配置已落盘）
	if err := eng.Reconfigure(testConfig(missing)); err == nil {
		t.Fatal("不可达远端应接入失败")
	}
	if st := eng.GetStatus(); st.LastError == "" {
		t.Fatal("lastError 应记录接入失败")
	} else if st.LastErrorCode != CodeSyncRemoteAccess {
		t.Fatalf("LastErrorCode = %q, want %q", st.LastErrorCode, CodeSyncRemoteAccess)
	}

	// 启动循环（等价服务重启捡起已存配置）：首轮失败进入 backoff
	eng.Start()

	// 断网期间本地编辑：写便签照常落盘，同步不阻塞使用
	writeVaultFile(t, vault, "notes/offline.md", []byte("断网期间写的\n"))

	// remote 恢复（同一路径现在可用了）
	if _, err := git.PlainInit(missing, true); err != nil {
		t.Fatalf("建裸仓库失败: %v", err)
	}

	// backoff 自动追上：远端最终可见断网前后的两份笔记
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, okBefore := remoteFileContent(t, missing, "notes/before.md")
		_, okOffline := remoteFileContent(t, missing, "notes/offline.md")
		if okBefore && okOffline {
			break
		}
		if time.Now().After(deadline) {
			st := eng.GetStatus()
			t.Fatalf("断网恢复后未自动追上: before=%v offline=%v lastError=%q",
				okBefore, okOffline, st.LastError)
		}
		time.Sleep(100 * time.Millisecond)
	}

	// 追上后状态收敛：错误清空、有同步时间、ahead 归零
	deadline = time.Now().Add(5 * time.Second)
	for {
		st := eng.GetStatus()
		if st.LastError == "" && !st.LastSyncAt.IsZero() && st.Ahead == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("追上后状态未收敛: %+v", st)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// 回归（严重 bug）：ff/adopt 检出绝不触碰树外文件。
// go-git 的整树 Reset(HardReset) 会把不在目标树里的工作区文件全部删除——
// 包括 .gitignore 排除的运行时文件（.pinslip/pinslip.db 打开中被删/锁冲突、
// .pinslip/git-sync.json 同步配置本身）。这里在 adopt 与 ff 两条路径上分别
// 预置运行时文件与未跟踪便签，断言它们原样存活；同时验证 ff 的新增/删除生效。
func TestPullKeepsIgnoredRuntimeFiles(t *testing.T) {
	remote := newBareRemote(t)
	vaultA := newVault(t)
	writeVaultFile(t, vaultA, "notes/base.md", []byte("base\n"))
	repoA := connectVault(t, vaultA, remote)

	// B：接入前预置运行时文件（模拟 pinslip.db 与同步配置）+ 未跟踪便签
	vaultB := newVault(t)
	runtimeFiles := map[string]string{
		".pinslip/pinslip.db":    "SQLITE-RUNTIME",
		".pinslip/git-sync.json": `{"url":"x"}`,
		"notes/local-only.md":    "本地未跟踪\n",
	}
	for rel, content := range runtimeFiles {
		writeVaultFile(t, vaultB, rel, []byte(content))
	}
	repoB := connectVault(t, vaultB, remote) // adopt 检出

	assertAlive := func(stage string) {
		t.Helper()
		for rel, want := range runtimeFiles {
			if got := readVaultFile(t, vaultB, rel); got != want {
				t.Errorf("%s 后 %s 应原样存活, got %q want %q", stage, rel, got, want)
			}
		}
	}
	assertAlive("adopt")

	// A：新增一条便签、删除 base，推送（制造 ff 差异：一增一删）
	writeVaultFile(t, vaultA, "notes/new.md", []byte("新便签\n"))
	if err := os.Remove(filepath.Join(vaultA, "notes/base.md")); err != nil {
		t.Fatal(err)
	}
	syncOnce(t, repoA)

	// B：ff pull——检出新增、应用删除，树外文件不动
	outcome, err := repoB.Pull()
	if err != nil {
		t.Fatalf("B Pull 失败: %v", err)
	}
	if outcome.Kind != PullFastForward {
		t.Errorf("应为 fast-forward, got %v", outcome.Kind)
	}
	if got := readVaultFile(t, vaultB, "notes/new.md"); got != "新便签\n" {
		t.Errorf("ff 应检出新便签, got %q", got)
	}
	if _, err := os.Stat(filepath.Join(vaultB, "notes/base.md")); !os.IsNotExist(err) {
		t.Error("ff 应删除 base.md")
	}
	assertAlive("ff pull")
}

// ff 覆盖保护：差异路径与本地未提交的脏文件相交时拒绝检出（等价 git 行为），
// 本地内容保留；gitignore 排除的文件不参与该判定（见上条测试）。
func TestPullFastForwardProtectsDirtyFile(t *testing.T) {
	vaultA, repoA, vaultB, repoB := setupSyncedPair(t, "notes/doc.md", []byte("v1\n"))

	writeVaultFile(t, vaultA, "notes/doc.md", []byte("v2\n"))
	syncOnce(t, repoA)

	// B 本地改同一文件但不提交
	writeVaultFile(t, vaultB, "notes/doc.md", []byte("本地未提交\n"))
	_, err := repoB.Pull()
	if err == nil {
		t.Fatal("脏文件与 ff 差异相交应拒绝检出")
	}
	if !strings.Contains(err.Error(), "notes/doc.md") {
		t.Errorf("错误应指明冲突文件: %v", err)
	}
	if got := readVaultFile(t, vaultB, "notes/doc.md"); got != "本地未提交\n" {
		t.Errorf("本地未提交内容应保留, got %q", got)
	}
}

// 回归（小 bug）：首次接入（PUT config）成功即落 lastSyncAt——
// Connect 内的首次提交+push 就是一轮完整同步，UI 不应显示「从未同步」。
func TestReconfigureSetsLastSyncAt(t *testing.T) {
	remote := newBareRemote(t)
	vault := newVault(t)
	writeVaultFile(t, vault, "notes/first.md", []byte("第一条\n"))

	eng, err := NewEngine(vault, tLogger{t})
	if err != nil {
		t.Fatal(err)
	}
	defer eng.Stop()

	before := time.Now()
	if err := eng.Reconfigure(testConfig(remote)); err != nil {
		t.Fatalf("Reconfigure 失败: %v", err)
	}
	st := eng.GetStatus()
	if st.LastSyncAt.IsZero() {
		t.Fatal("首次接入成功后 lastSyncAt 应立即有值")
	}
	if st.LastSyncAt.Before(before.Add(-time.Second)) {
		t.Errorf("lastSyncAt 应在接入时刻附近: %v", st.LastSyncAt)
	}
	if st.LastError != "" {
		t.Errorf("接入成功不应有 lastError: %q", st.LastError)
	}
}

// 自动推拉间隔配置：normalize 把缺省/越界值拉回默认 10，合法值（1~1440）保留；
// 引擎 currentPushInterval 跟随配置（测试覆盖优先），Status 透出当前生效值。
func TestPushIntervalMinConfig(t *testing.T) {
	// 缺省/非法 → 默认 10
	for _, in := range []int{0, -5, 1441, 100000} {
		c := SyncConfig{URL: "https://example.com/a.git", PushIntervalMin: in}
		if err := c.normalize(); err != nil {
			t.Fatal(err)
		}
		if c.PushIntervalMin != defaultPushIntervalMin {
			t.Errorf("PushIntervalMin=%d 应回退默认 %d, got %d", in, defaultPushIntervalMin, c.PushIntervalMin)
		}
	}
	// 边界与常规合法值 → 保留
	for _, in := range []int{1, 15, 1440} {
		c := SyncConfig{URL: "https://example.com/a.git", PushIntervalMin: in}
		if err := c.normalize(); err != nil {
			t.Fatal(err)
		}
		if c.PushIntervalMin != in {
			t.Errorf("合法值 %d 应保留, got %d", in, c.PushIntervalMin)
		}
	}

	// 引擎跟随配置：Reconfigure 后 currentPushInterval 即新值，Status 同步透出
	vault := newVault(t)
	eng, err := NewEngine(vault, tLogger{t})
	if err != nil {
		t.Fatal(err)
	}
	cfg := SyncConfig{URL: "https://example.com/a.git", Branch: "main", Enabled: false, PushIntervalMin: 15}
	if err := eng.Reconfigure(cfg); err != nil {
		t.Fatal(err)
	}
	if got := eng.currentPushInterval(); got != 15*time.Minute {
		t.Fatalf("currentPushInterval 应跟随配置 15m, got %v", got)
	}
	if st := eng.GetStatus(); st.PushIntervalMin != 15 {
		t.Fatalf("Status.PushIntervalMin 应为 15, got %d", st.PushIntervalMin)
	}
	// 落盘往返：重载后配置值仍在
	stored, err := loadSyncConfig(vault)
	if err != nil {
		t.Fatal(err)
	}
	if stored.PushIntervalMin != 15 {
		t.Fatalf("落盘重载后 PushIntervalMin 应为 15, got %d", stored.PushIntervalMin)
	}
	// 测试覆盖优先于配置（ms 级间隔只能靠覆盖）
	eng.pushInterval = time.Hour
	if got := eng.currentPushInterval(); got != time.Hour {
		t.Fatalf("测试覆盖应优先, got %v", got)
	}
}
