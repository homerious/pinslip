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

	// 身份握手：浏览器插件按固定端口探测后先调它确认对面是 PinSlip
	// （该端口可能被别的软件占用），并取版本号展示。
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"app":     "pinslip",
			"version": version,
		})
	})

	notesHandler.Register(mux)
	syncHandler.Register(mux)
	mux.Handle("/mcp", mcpHandler)
	return mux
}
