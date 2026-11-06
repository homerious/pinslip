package notes

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

const PreviewBatchLimit = 8

type Preview struct {
	ID        string `json:"id"`
	Markdown  string `json:"markdown"`
	Revision  string `json:"revision"`
	Direction string `json:"direction,omitempty"`
	Truncated bool   `json:"truncated"`
	Error     string `json:"error,omitempty"`
}

func previewText(body string, limit int) (string, bool) {
	if len(body) <= limit {
		return body, false
	}
	for limit > 0 && !utf8.RuneStart(body[limit]) {
		limit--
	}
	return strings.Clone(body[:limit]), true
}

func (h *Handler) previews(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs      []string `json:"ids"`
		Expanded bool     `json:"expanded"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	if err := dec.Decode(&in); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid preview request"})
		return
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		writeJSON(w, 400, map[string]string{"error": "invalid preview request"})
		return
	}
	seen := map[string]bool{}
	if len(in.IDs) == 0 || len(in.IDs) > PreviewBatchLimit {
		writeJSON(w, 400, map[string]string{"error": "preview batch must contain 1 to 8 ids"})
		return
	}
	for _, id := range in.IDs {
		if id == "" || len(id) > 128 || id == "." || id == ".." || strings.ContainsAny(id, "/\\\x00") || seen[id] {
			writeJSON(w, 400, map[string]string{"error": "invalid or duplicate preview id"})
			return
		}
		seen[id] = true
	}
	limit := 8192
	if in.Expanded {
		limit = 32768
	}
	items := make([]Preview, 0, len(in.IDs))
	for _, id := range in.IDs {
		item := Preview{ID: id}
		note, err := h.svc.Get(id)
		if err != nil {
			item.Error = "preview unavailable"
			items = append(items, item)
			continue
		}
		item.Markdown, item.Truncated = previewText(note.Content, limit)
		sum := sha256.Sum256([]byte(note.Content + "\x00" + note.Folder + "\x00" + note.Direction))
		item.Revision = hex.EncodeToString(sum[:])
		item.Direction = note.Direction
		items = append(items, item)
	}
	writeJSON(w, 200, items)
}
