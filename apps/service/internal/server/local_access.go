package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
)

type localRoute uint8

const (
	desktopRoute localRoute = iota
	clipperRoute
	publicRoute
)

// 路径与方法同时进入权限判断，剪藏凭证无法调用同名的普通便签 API。
func localRouteFor(method, path string) localRoute {
	switch method + " " + path {
	case "GET /health", "GET /api/health", "POST /api/clipper/connect":
		return publicRoute
	case "GET /api/clipper/status", "POST /api/clipper/quick", "POST /api/clipper/notes", "POST /api/clipper/attachments":
		return clipperRoute
	default:
		return desktopRoute
	}
}

func loopbackHost(host string) bool {
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	switch strings.ToLower(host) {
	case "127.0.0.1", "localhost", "::1", "[::1]":
		return true
	}
	return false
}

func extensionOrigin(origin string) bool {
	u, err := url.Parse(origin)
	return err == nil && (u.Scheme == "chrome-extension" || u.Scheme == "moz-extension") &&
		u.Hostname() != "" && u.Host == u.Hostname() && u.User == nil &&
		u.Path == "" && u.RawQuery == "" && u.Fragment == ""
}

func (a *LocalAccess) wrap(next http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", next)
	mux.HandleFunc("POST /api/clipper/pairing", a.beginPairing)
	mux.HandleFunc("DELETE /api/clipper/pairing", a.revokeClippers)
	mux.HandleFunc("POST /api/clipper/connect", a.connectClipper)
	mux.HandleFunc("GET /api/clipper/status", func(w http.ResponseWriter, _ *http.Request) {
		writeLocalJSON(w, http.StatusOK, map[string]bool{"authorized": true})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host) || len(r.Header.Values("Origin")) > 1 {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		origin := r.Header.Get("Origin")
		if r.URL.Path == "/mcp" {
			// 保留本机 MCP 客户端，拒绝浏览器上下文和跨域预检。
			if (origin != "" && origin != "http://"+r.Host) ||
				r.Header.Get("Sec-Fetch-Site") != "" || r.Method == http.MethodOptions {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
			if r.Method == http.MethodPost {
				mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
				if err != nil || mediaType != "application/json" {
					http.Error(w, "MCP requires application/json", http.StatusUnsupportedMediaType)
					return
				}
			}
			next.ServeHTTP(w, r)
			return
		}

		method := r.Method
		if method == http.MethodOptions {
			method = r.Header.Get("Access-Control-Request-Method")
			if origin == "" || (method != http.MethodGet && method != http.MethodPost &&
				method != http.MethodPut && method != http.MethodDelete) {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
		}
		route := localRouteFor(method, r.URL.Path)
		// file:// 的 null 仅用于桌面传输兼容，业务路由依然校验令牌。
		desktopOrigin := origin == "null" || (origin != "" && origin == a.devOrigin)
		if origin != "" && !desktopOrigin && !(route != desktopRoute && extensionOrigin(origin)) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", method)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Add("Vary", "Access-Control-Request-Method")
			if desktopOrigin && route == desktopRoute && r.Header.Get("Access-Control-Request-Private-Network") == "true" {
				w.Header().Set("Access-Control-Allow-Private-Network", "true")
				w.Header().Add("Vary", "Access-Control-Request-Private-Network")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if route != publicRoute {
			token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			digest := sha256.Sum256([]byte(token))
			desktop := ok && a.desktopEnabled && subtle.ConstantTimeCompare(digest[:], a.desktopDigest[:]) == 1
			clipper := ok && route == clipperRoute && a.validClipper(digest)
			if !desktop && !clipper {
				w.Header().Set("WWW-Authenticate", "Bearer")
				w.Header().Set("Access-Control-Expose-Headers", "WWW-Authenticate")
				writeLocalJSON(w, http.StatusUnauthorized, map[string]string{
					"code": "LOCAL_API_UNAUTHORIZED", "error": "PinSlip credential required",
				})
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func writeLocalJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
