package gitsync

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"
)

// 模拟旧版/外部操作已强制跟踪运行时文件的远端，不经过新版清理。
func commitLegacyFiles(t *testing.T, r *Repo, files map[string]string) {
	t.Helper()
	w, _ := r.r.Worktree()
	for p, data := range files {
		writeVaultFile(t, r.dir, p, []byte(data))
		if _, err := w.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := w.Commit("legacy files", &git.CommitOptions{Author: commitAuthor}); err != nil {
		t.Fatal(err)
	}
	if err := r.Push(); err != nil {
		t.Fatal(err)
	}
}

func TestCommitAllDeletionStates(t *testing.T) {
	for _, mode := range []string{"unstaged", "staged", "staged-modification", "staged-trash-deletion"} {
		t.Run(mode, func(t *testing.T) {
			remote := newBareRemote(t)
			vault := newVault(t)
			p := "notes/TODO.md"
			writeVaultFile(t, vault, p, []byte("TODO\n"))
			r := connectVault(t, vault, remote)
			w, _ := r.r.Worktree()
			if mode == "staged-trash-deletion" {
				p = ".trash/未命名.md"
				commitLegacyFiles(t, r, map[string]string{p: "old trash"})
			}
			if mode == "staged-modification" {
				writeVaultFile(t, vault, p, []byte("changed\n"))
				if _, err := w.Add(p); err != nil {
					t.Fatal(err)
				}
			} else if mode == "unstaged" {
				if err := os.Remove(r.absPath(p)); err != nil {
					t.Fatal(err)
				}
			} else if _, err := w.Remove(p); err != nil {
				t.Fatal(err)
			}
			if _, _, err := r.CommitAll(); err != nil {
				t.Fatal(err)
			}
			c, _ := r.r.CommitObject(r.HeadHash())
			data, exists, err := readFileAt(c, p)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "staged-modification" {
				if !exists || string(data) != "changed\n" {
					t.Fatalf("staged modification lost: %q", data)
				}
			} else if exists {
				t.Fatal("deletion not committed")
			}
			if _, _, err := r.CommitAll(); err != nil {
				t.Fatalf("repeat: %v", err)
			}
		})
	}
}

func TestLegacyRuntimePathsNeverCheckoutOrMerge(t *testing.T) {
	remote := newBareRemote(t)
	a := newVault(t)
	writeVaultFile(t, a, "notes/TODO.md", []byte("TODO\n"))
	ra := connectVault(t, a, remote)
	legacy := map[string]string{".pinslip/pinslip.db": "remote DB", ".pinslip/git-sync.json": "remote config", ".trash/old.md": "remote trash"}
	commitLegacyFiles(t, ra, legacy)
	b := newVault(t)
	for p := range legacy {
		writeVaultFile(t, b, p, []byte("LOCAL"))
	}
	rb := connectVault(t, b, remote)
	for p := range legacy {
		if got := readVaultFile(t, b, p); got != "LOCAL" {
			t.Fatalf("checkout changed %s: %q", p, got)
		}
	}
	if _, _, err := rb.CommitAll(); err != nil {
		t.Fatal(err)
	}
	c, _ := rb.r.CommitObject(rb.HeadHash())
	files, _ := treeFiles(c)
	for p := range files {
		if excludedSyncPath(p) {
			t.Fatalf("runtime still committed: %s", p)
		}
	}
	// 与旧设备分叉：远端修改数据库且新增笔记，本地清理不能与其产生运行时冲突。
	commitLegacyFiles(t, ra, map[string]string{".pinslip/pinslip.db": "REMOTE UPDATED", "notes/remote.md": "new remote note"})
	if _, err := rb.Pull(); err != nil {
		t.Fatal(err)
	}
	if err := rb.Push(); err != nil {
		t.Fatal(err)
	}
	if got := readVaultFile(t, b, "notes/remote.md"); got != "new remote note" {
		t.Fatal(got)
	}
	for p := range legacy {
		if got := readVaultFile(t, b, p); got != "LOCAL" {
			t.Fatalf("merge changed %s: %q", p, got)
		}
	}
	// 另一新设备直接快进到旧提交，也不能碰本机运行时文件。
	if err := rb.fastForward(ra.HeadHash()); err != nil {
		t.Fatal(err)
	}
	for p := range legacy {
		if got := readVaultFile(t, b, p); got != "LOCAL" {
			t.Fatalf("ff changed %s: %q", p, got)
		}
	}
}

func TestCommitAllUntracksLegacyRuntimeWithoutChangingFiles(t *testing.T) {
	remote := newBareRemote(t)
	vault := newVault(t)
	r := connectVault(t, vault, remote)
	legacy := map[string]string{".pinslip/pinslip.db": "LOCAL DB", ".pinslip/settings.json": "LOCAL SETTINGS", ".trash/old.md": "LOCAL TRASH"}
	commitLegacyFiles(t, r, legacy)
	writeVaultFile(t, vault, ".gitignore", []byte("custom-user-pattern\n"))
	if _, _, err := r.CommitAll(); err != nil {
		t.Fatal(err)
	}
	c, _ := r.r.CommitObject(r.HeadHash())
	files, err := treeFiles(c)
	if err != nil {
		t.Fatal(err)
	}
	for p, want := range legacy {
		if _, ok := files[p]; ok {
			t.Fatalf("still tracked: %s", p)
		}
		if got := readVaultFile(t, vault, p); got != want {
			t.Fatalf("changed local %s: %q", p, got)
		}
	}
	ignore := readVaultFile(t, vault, ".gitignore")
	if !strings.Contains(ignore, "custom-user-pattern\n") || !strings.Contains(ignore, ".pinslip/\n") {
		t.Fatal("gitignore not merged")
	}
}

func TestRecoveryProtectsTODOAndRestoresRemote(t *testing.T) {
	remote := newBareRemote(t)
	a := newVault(t)
	writeVaultFile(t, a, "notes/TODO.md", []byte("keep TODO\n"))
	ra := connectVault(t, a, remote)
	commitLegacyFiles(t, ra, map[string]string{".trash/old.md": "old", ".pinslip/pinslip.db": "remote DB"})
	remoteHead := ra.HeadHash()
	b := newVault(t)
	writeVaultFile(t, b, ".pinslip/pinslip.db", []byte("LOCAL DB"))
	rb := connectVault(t, b, remote)
	w, _ := rb.r.Worktree()
	if _, err := w.Remove("notes/TODO.md"); err != nil {
		t.Fatal(err)
	}
	writeVaultFile(t, b, "notes/local.md", []byte("back me up"))
	writeVaultFile(t, b, "unrelated.txt", []byte("keep outside tree"))
	eng, err := NewEngine(b, tLogger{t})
	if err != nil {
		t.Fatal(err)
	}
	eng.pushInterval = time.Hour
	if err := eng.Reconfigure(testConfig(remote)); err != nil {
		t.Fatal(err)
	}
	defer eng.Stop()
	st := waitForStatusCode(t, eng, CodeSyncRecoveryRequired)
	if st.RemoteIsPinslip == nil || !*st.RemoteIsPinslip {
		t.Fatalf("missing recovery info: %+v", st)
	}
	if err := eng.SyncNow(); codeOf(err) != CodeSyncRecoveryRequired {
		t.Fatalf("sync should pause: %v", err)
	}
	if eng.repo.HeadHash() != remoteHead {
		t.Fatal("recovery protection changed HEAD")
	}
	if data, ok := remoteFileContent(t, remote, "notes/TODO.md"); !ok || data != "keep TODO\n" {
		t.Fatal("remote TODO lost")
	}
	if err := eng.ResolveDivergence("local"); !errors.Is(err, errResolvePrecondition) {
		t.Fatalf("unsafe local strategy allowed: %v", err)
	}
	if err := eng.ResolveDivergence("remote"); err != nil {
		t.Fatal(err)
	}
	if got := readVaultFile(t, b, "notes/TODO.md"); got != "keep TODO\n" {
		t.Fatal(got)
	}
	if got := readVaultFile(t, b, ".pinslip/pinslip.db"); got != "LOCAL DB" {
		t.Fatal("local DB overwritten")
	}
	if got := readVaultFile(t, b, "unrelated.txt"); got != "keep outside tree" {
		t.Fatal(got)
	}
	backups, _ := filepath.Glob(filepath.Join(b, ".pinslip", "backups", "divergence-*"))
	if len(backups) != 1 || readVaultFile(t, backups[0], "notes/local.md") != "back me up" {
		t.Fatal("missing backup")
	}
	if st := eng.GetStatus(); st.LastErrorCode != "" {
		t.Fatalf("recovery did not complete: %+v", st)
	}
	if data, ok := remoteFileContent(t, remote, "notes/TODO.md"); !ok || data != "keep TODO\n" {
		t.Fatal("remote TODO lost after recovery")
	}
}

func TestResetToRemoteSameTreeAndFailedCheckout(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "same-tree", true: "write-failure"}[fail], func(t *testing.T) {
			remote := newBareRemote(t)
			a := newVault(t)
			writeVaultFile(t, a, "notes/TODO.md", []byte("keep TODO"))
			ra := connectVault(t, a, remote)
			if fail {
				commitLegacyFiles(t, ra, map[string]string{".trash/old.md": "old trash"})
			}
			b := newVault(t)
			rb := connectVault(t, b, remote)
			oldHead := rb.HeadHash()
			w, _ := rb.r.Worktree()
			if _, err := w.Remove("notes/TODO.md"); err != nil {
				t.Fatal(err)
			}
			if fail {
				if err := rb.checkRecoveryRequired(); codeOf(err) != CodeSyncRecoveryRequired {
					t.Fatalf("guard: %v", err)
				}
				commitLegacyFiles(t, ra, map[string]string{"notes/zz-block.md": "cannot write"})
				if err := os.MkdirAll(rb.absPath("notes/zz-block.md"), 0755); err != nil {
					t.Fatal(err)
				}
			}
			err := rb.ResetToRemote()
			if fail {
				if err == nil || rb.HeadHash() != oldHead {
					t.Fatalf("failed reset changed branch: %v", err)
				}
				// TODO 已写回，暂存状态可能改变；重新打开仍必须保持恢复保护。
				reopened := connectVault(t, b, remote)
				if _, _, err := reopened.CommitAll(); codeOf(err) != CodeSyncRecoveryRequired {
					t.Fatalf("failed recovery bypassed after reopen: %v", err)
				}
				if err := os.Remove(rb.absPath("notes/zz-block.md")); err != nil {
					t.Fatal(err)
				}
				if err := reopened.ResetToRemote(); err != nil {
					t.Fatal(err)
				}
				if _, _, err := reopened.CommitAll(); err != nil {
					t.Fatalf("retry failed: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := readVaultFile(t, b, "notes/TODO.md"); got != "keep TODO" {
				t.Fatal(got)
			}
			if _, _, err := rb.CommitAll(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
