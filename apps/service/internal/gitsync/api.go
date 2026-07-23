// api.go — git 同步 REST API，照 notes.Handler 模式接进 internal/server。
//
//	GET    /api/sync/status  → Status（不含 token）
//	PUT    /api/sync/config  → 配置仓库/凭证/分支/开关，触发首次接入
//	DELETE /api/sync/config  → 停用（保留 .git 与已存凭证）
//	POST   /api/sync/now     → 立即 commit+pull+push
package gitsync

import (
	"encoding/json"
	"log"
	"net/http"
)

// Handler 是 git 同步 API 的 HTTP 层。
type Handler struct {
	eng *Engine
}

func NewHandler(eng *Engine) *Handler {
	return &Handler{eng: eng}
}

// Register 把同步路由注册到 mux。
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/sync/status", h.status)
	mux.HandleFunc("PUT /api/sync/config", h.putConfig)
	mux.HandleFunc("DELETE /api/sync/config", h.deleteConfig)
	mux.HandleFunc("POST /api/sync/now", h.syncNow)
}

func (h *Handler) status(w http.ResponseWriter, _ *http.Request) {
	syncWriteJSON(w, http.StatusOK, h.eng.GetStatus())
}

// putConfig 配置仓库/凭证/分支/开关：{url, username, token, branch, enabled}。
// token 为空且 url 未变时沿用已存 token。接入失败返回 400 与原因。
func (h *Handler) putConfig(w http.ResponseWriter, r *http.Request) {
	var in SyncConfig
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		syncWriteError(w, http.StatusBadRequest, err)
		return
	}
	if err := h.eng.Reconfigure(in); err != nil {
		syncWriteError(w, http.StatusBadRequest, err)
		return
	}
	syncWriteJSON(w, http.StatusOK, h.eng.GetStatus())
}

// deleteConfig 停用同步：保留 .git 与已存配置（仅置 enabled=false）。
func (h *Handler) deleteConfig(w http.ResponseWriter, _ *http.Request) {
	if err := h.eng.Disable(); err != nil {
		syncWriteError(w, http.StatusInternalServerError, err)
		return
	}
	syncWriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// syncNow 立即同步一轮（commit+pull+push），完成后返回最新状态。
func (h *Handler) syncNow(w http.ResponseWriter, _ *http.Request) {
	if err := h.eng.SyncNow(); err != nil {
		// 同步失败不丟 5xx：状态查询是常态路径，错误体现在 lastError 字段
		log.Printf("[ERROR] git 手动同步失败: %v", err)
	}
	syncWriteJSON(w, http.StatusOK, h.eng.GetStatus())
}

func syncWriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func syncWriteError(w http.ResponseWriter, status int, err error) {
	if status >= 500 {
		log.Printf("[ERROR] %v", err)
	}
	syncWriteJSON(w, status, map[string]string{"error": err.Error()})
}
