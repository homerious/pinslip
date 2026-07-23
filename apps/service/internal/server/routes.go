package server

import (
	"encoding/json"
	"net/http"

	"pinslip/service/internal/gitsync"
	"pinslip/service/internal/notes"
)

// NewRouter 装配全部路由。mcpHandler 挂 /mcp（开关中间件在其内部，
// 关闭时 404）；MCP 客户端会 POST/GET/DELETE 同一路径，不做方法限制。
func NewRouter(notesHandler *notes.Handler, syncHandler *gitsync.Handler, mcpHandler http.Handler, version string) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status":  "ok",
			"version": version,
		})
	})

	notesHandler.Register(mux)
	syncHandler.Register(mux)
	mux.Handle("/mcp", mcpHandler)
	return mux
}
