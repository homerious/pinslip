package mcpserver

import (
	"encoding/json"
	"net/http"

	"github.com/mark3labs/mcp-go/server"

	"pinslip/service/internal/gitsync"
	"pinslip/service/internal/notes"
)

// NewHandler 构建 /mcp 端点 handler：MCP server（Streamable HTTP）+ 总开关中间件。
// 开关状态每次请求现读 vault 设置（.pinslip/settings.json 的 mcpEnabled），
// 关闭时整个端点 404——工具列表与调用一并不可用。
func NewHandler(svc *notes.Service, syncEngine *gitsync.Engine, version string) http.Handler {
	mcpSrv := server.NewMCPServer("pinslip", version)
	h := &toolHandler{svc: svc, sync: syncEngine}
	h.registerTools(mcpSrv)

	httpSrv := server.NewStreamableHTTPServer(mcpSrv)
	return withEnabled(httpSrv, func() bool { return svc.GetSettings().IsMcpEnabled() })
}

// withEnabled 总开关中间件：关闭时返回 404（对外表现为端点不存在，不暴露开关细节）。
func withEnabled(next http.Handler, enabled func() bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !enabled() {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"error": "MCP 服务未开启（可在设置的 MCP 小节打开）",
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}
