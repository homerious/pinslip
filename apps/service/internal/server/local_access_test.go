package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testDesktopToken = "test desktop credential"
const testExtensionOrigin = "moz-extension://c64aae7e-2d43-4fe4-aae3-700595d82071"

func accessRequest(h http.Handler, method, path, origin, token, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:17639"+path, strings.NewReader(body))
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestLocalAccessBoundaries(t *testing.T) {
	access, err := NewLocalAccess(testDesktopToken, "http://localhost:5173", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := access.wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	for _, tc := range []struct {
		name, path, origin, token string
		want                      int
	}{
		{"普通网站读", "/api/notes", "https://example.test", "", 403},
		{"桌面来源无凭证", "/api/notes", "null", "", 401},
		{"打包桌面", "/api/notes", "null", testDesktopToken, 200},
		{"开发桌面", "/api/notes", "http://localhost:5173", testDesktopToken, 200},
		{"本机主进程", "/api/notes", "", testDesktopToken, 200},
		{"剪藏不能借桌面凭证跨域", "/api/notes", testExtensionOrigin, testDesktopToken, 403},
		{"扩展识别服务", "/api/health", testExtensionOrigin, "", 200},
		{"本机 MCP", "/mcp", "", "", 200},
		{"网页 MCP", "/mcp", "https://example.test", "", 403},
		{"不透明来源 MCP", "/mcp", "null", "", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := accessRequest(handler, http.MethodGet, tc.path, tc.origin, tc.token, "")
			if got.Code != tc.want || got.Header().Get("Access-Control-Allow-Origin") == "*" {
				t.Fatalf("status=%d headers=%v", got.Code, got.Header())
			}
		})
	}
	for _, tc := range []struct {
		host, path, origin, fetchSite, preflight string
		want                                     int
	}{
		{"not-loopback.test", "/api/notes", "", "", "", 403},
		{"127.0.0.1:17639", "/mcp", "", "cross-site", "", 403},
		{"127.0.0.1:17639", "/api/notes", "https://example.test", "", "PUT", 403},
		{"127.0.0.1:17639", "/api/notes", "null", "", "PUT", 204},
		{"127.0.0.1:17639", "/api/clipper/notes", testExtensionOrigin, "", "POST", 204},
	} {
		req := httptest.NewRequest(http.MethodGet, "http://"+tc.host+tc.path, nil)
		req.Header.Set("Origin", tc.origin)
		req.Header.Set("Sec-Fetch-Site", tc.fetchSite)
		if tc.preflight != "" {
			req.Method = http.MethodOptions
			req.Header.Set("Access-Control-Request-Method", tc.preflight)
			req.Header.Set("Access-Control-Request-Private-Network", "true")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != tc.want {
			t.Fatalf("%+v: got %d", tc, w.Code)
		}
		allowPNA := w.Header().Get("Access-Control-Allow-Private-Network") == "true"
		if allowPNA != (tc.origin == "null" && tc.want == 204) {
			t.Fatalf("%+v: unexpected PNA response %v", tc, w.Header())
		}
	}
}

func TestClipperPairingAndScopes(t *testing.T) {
	store := filepath.Join(t.TempDir(), "clipper.json")
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	load := func() *LocalAccess {
		t.Helper()
		access, err := NewLocalAccess(testDesktopToken, "", store)
		if err != nil {
			t.Fatal(err)
		}
		return access
	}
	access := load()
	handler := access.wrap(next)
	start := func() string {
		t.Helper()
		w := accessRequest(handler, http.MethodPost, "/api/clipper/pairing", "null", testDesktopToken, "")
		var result struct{ Code string }
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Code == "" {
			t.Fatalf("start pairing: status=%d", w.Code)
		}
		return result.Code
	}
	connect := func(code string) *httptest.ResponseRecorder {
		return accessRequest(handler, http.MethodPost, "/api/clipper/connect", testExtensionOrigin, "", `{"code":"`+code+`"}`)
	}
	expired := start()
	access.pairingUntil = time.Now().Add(-time.Second)
	if w := connect(expired); w.Code != 401 {
		t.Fatalf("expired code: %d", w.Code)
	}
	code := start()
	w := connect(code)
	var result struct{ Token string }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Token == "" {
		t.Fatalf("redeem pairing code: status=%d", w.Code)
	}
	if w = connect(code); w.Code != 401 {
		t.Fatalf("reused code: status=%d", w.Code)
	}
	data, err := os.ReadFile(store)
	if err != nil || strings.Contains(string(data), result.Token) {
		t.Fatal("credential store must contain only token digests")
	}
	handler = load().wrap(next)
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{"GET", "/api/clipper/status", 200},
		{"POST", "/api/clipper/notes", 204},
		{"POST", "/api/clipper/quick", 204},
		{"POST", "/api/clipper/attachments", 204},
		{"GET", "/api/notes", 401},
		{"PUT", "/api/notes/existing", 401},
		{"POST", "/api/clipper/pairing", 401},
	} {
		w := accessRequest(handler, tc.method, tc.path, "", result.Token, "")
		if w.Code != tc.want {
			t.Fatalf("%s %s: got %d, want %d", tc.method, tc.path, w.Code, tc.want)
		}
	}
	if w := accessRequest(handler, http.MethodDelete, "/api/clipper/pairing", "null", testDesktopToken, ""); w.Code != 200 {
		t.Fatalf("revoke status=%d", w.Code)
	}
	if w := accessRequest(load().wrap(next), http.MethodGet, "/api/clipper/status", testExtensionOrigin, result.Token, ""); w.Code != 401 {
		t.Fatalf("revoked token after restart: %d", w.Code)
	}
}
