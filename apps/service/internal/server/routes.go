package server

import (
	"encoding/json"
	"net/http"

	"pinslip/service/internal/gitsync"
	"pinslip/service/internal/notes"
)

// NewRouter 装配全部路由。
func NewRouter(notesHandler *notes.Handler, syncHandler *gitsync.Handler, version string) http.Handler {
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
	return mux
}
