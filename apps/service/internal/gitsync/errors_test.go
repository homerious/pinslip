package gitsync

import (
	"errors"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestWithCodeRoundTrip(t *testing.T) {
	base := errors.New("boom")
	err := withCode(CodeSyncPushFailed, base)
	if got := codeOf(err); got != CodeSyncPushFailed {
		t.Fatalf("codeOf = %q, want %q", got, CodeSyncPushFailed)
	}
	if !errors.Is(err, base) {
		t.Fatal("errors.Is should unwrap to the base error")
	}
	if err.Error() != "boom" {
		t.Fatalf("Error() = %q, want original message", err.Error())
	}
	if codeOf(base) != "" {
		t.Fatal("plain error should have no code")
	}
}

func TestWithCodeKeepsInnerCode(t *testing.T) {
	inner := withCode(CodeSyncRemoteAccess, errors.New("denied"))
	err := withCode(CodeSyncPullFailed, inner)
	if got := codeOf(err); got != CodeSyncRemoteAccess {
		t.Fatalf("codeOf = %q, want inner %q", got, CodeSyncRemoteAccess)
	}
	if got := codeOr(err, CodeSyncPullFailed); got != CodeSyncRemoteAccess {
		t.Fatalf("codeOr = %q, want inner %q", got, CodeSyncRemoteAccess)
	}
	if got := codeOr(fmt.Errorf("wrap: %w", errors.New("x")), CodeSyncPullFailed); got != CodeSyncPullFailed {
		t.Fatalf("codeOr = %q, want fallback %q", got, CodeSyncPullFailed)
	}
}

func TestSyncWriteErrorIncludesCode(t *testing.T) {
	rec := httptest.NewRecorder()
	syncWriteError(rec, 400, withCode(CodeSyncURLRequired, errors.New("启用同步必须提供仓库地址 url")))
	body := rec.Body.String()
	if !strings.Contains(body, `"code":"`+CodeSyncURLRequired+`"`) {
		t.Fatalf("body missing code: %s", body)
	}
	if !strings.Contains(body, "启用同步必须提供仓库地址 url") {
		t.Fatalf("body missing message: %s", body)
	}

	rec2 := httptest.NewRecorder()
	syncWriteError(rec2, 500, errors.New("plain"))
	if strings.Contains(rec2.Body.String(), `"code"`) {
		t.Fatalf("plain error should not carry code: %s", rec2.Body.String())
	}
}

func TestConnectEmptyURLCode(t *testing.T) {
	_, err := Connect(newVault(t), SyncConfig{Enabled: true, URL: ""})
	if err == nil {
		t.Fatal("Connect with empty URL should fail")
	}
	if got := codeOf(err); got != CodeSyncURLRequired {
		t.Fatalf("codeOf = %q, want %q", got, CodeSyncURLRequired)
	}
}

func TestConnectUnreachableRemoteCode(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "not-exist", "remote.git")
	_, err := Connect(newVault(t), testConfig(missing))
	if err == nil {
		t.Fatal("Connect should fail for unreachable remote")
	}
	if got := codeOf(err); got != CodeSyncRemoteAccess {
		t.Fatalf("codeOf = %q, want %q", got, CodeSyncRemoteAccess)
	}
}
