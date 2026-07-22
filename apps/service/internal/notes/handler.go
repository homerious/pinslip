package notes

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"

	"pinslip/service/internal/storage"
)

// Handler 是笔记 API 的 HTTP 层：只负责参数解析与 JSON 编解码。
type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// Register 把笔记路由注册到 mux。
// Go 1.22+ ServeMux 中字面量段（search/quick）优先于通配段（{id}）。
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/notes", h.list)
	mux.HandleFunc("GET /api/notes/search", h.search)
	mux.HandleFunc("POST /api/notes/quick", h.quick)
	mux.HandleFunc("GET /api/notes/{id}", h.get)
	mux.HandleFunc("PUT /api/notes/{id}", h.save)
	mux.HandleFunc("DELETE /api/notes/{id}", h.remove)
	mux.HandleFunc("POST /api/notes/{id}/move", h.move)
	mux.HandleFunc("GET /api/folders", h.listFolders)
	mux.HandleFunc("POST /api/folders", h.createFolder)
	mux.HandleFunc("POST /api/folders/rename", h.renameFolder)
	mux.HandleFunc("POST /api/folders/delete", h.deleteFolder)
	mux.HandleFunc("POST /api/attachments", h.uploadAttachment)
	mux.HandleFunc("GET /api/trash/stats", h.trashStats)
	mux.HandleFunc("POST /api/trash/empty", h.emptyTrash)
	mux.HandleFunc("GET /api/settings", h.getSettings)
	mux.HandleFunc("PUT /api/settings", h.saveSettings)
	mux.HandleFunc("GET /api/groups", h.getGroups)
	mux.HandleFunc("PUT /api/groups", h.saveGroups)
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	metas, err := h.svc.List()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, metas)
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	note, err := h.svc.Get(r.PathValue("id"))
	if errors.Is(err, storage.ErrNotFound) {
		writeError(w, http.StatusNotFound, err)
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, note)
}

func (h *Handler) save(w http.ResponseWriter, r *http.Request) {
	var in SaveInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	note, err := h.svc.Save(r.PathValue("id"), in)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, note)
}

func (h *Handler) remove(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.PathValue("id")); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// move 把笔记移动到 notes/ 下的指定文件夹：POST /api/notes/{id}/move {folder}。
func (h *Handler) move(w http.ResponseWriter, r *http.Request) {
	var in MoveInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := h.svc.Move(r.PathValue("id"), in.Folder); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, err)
			return
		}
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// listFolders 返回 notes/ 下全部子文件夹（相对路径列表）。
func (h *Handler) listFolders(w http.ResponseWriter, r *http.Request) {
	folders, err := h.svc.ListFolders()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"folders": folders})
}

// createFolder 新建（嵌套）文件夹：POST /api/folders {path}。
func (h *Handler) createFolder(w http.ResponseWriter, r *http.Request) {
	var in CreateFolderInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if in.Path == "" {
		writeError(w, http.StatusBadRequest, errors.New("path 不能为空"))
		return
	}
	if err := h.svc.CreateFolder(in.Path); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// renameFolder 重命名文件夹（同级改名）：POST /api/folders/rename {path, name}。
func (h *Handler) renameFolder(w http.ResponseWriter, r *http.Request) {
	var in RenameFolderInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if in.Path == "" || in.Name == "" {
		writeError(w, http.StatusBadRequest, errors.New("path 与 name 不能为空"))
		return
	}
	if err := h.svc.RenameFolder(in.Path, in.Name); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// deleteFolder 删除文件夹：POST /api/folders/delete {path, mode}。
// mode = "move"（默认，便签移到根目录后删空文件夹）/ "trash"（连同便签移入 .trash）。
func (h *Handler) deleteFolder(w http.ResponseWriter, r *http.Request) {
	var in DeleteFolderInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if in.Path == "" {
		writeError(w, http.StatusBadRequest, errors.New("path 不能为空"))
		return
	}
	if in.Mode == "" {
		in.Mode = "move"
	}
	if err := h.svc.DeleteFolder(in.Path, in.Mode); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	hits, err := h.svc.Search(q, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, hits)
}

func (h *Handler) quick(w http.ResponseWriter, r *http.Request) {
	var in QuickInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if in.Content == "" {
		writeError(w, http.StatusBadRequest, errors.New("content 不能为空"))
		return
	}
	note, err := h.svc.QuickCapture(in.Content)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, note)
}

// uploadAttachment 接收粘贴的图片（raw body），?ext=.png 指定扩展名（白名单校验）。
// 返回 { path: "attachments/<name>" }——相对路径写入 markdown，Obsidian 可读。
func (h *Handler) uploadAttachment(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 20<<20)) // 20MB 上限
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	rel, err := h.svc.SaveAttachment(r.URL.Query().Get("ext"), data)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": rel})
}

// trashStats 返回回收区占用：GET /api/trash/stats → {count, bytes}。
func (h *Handler) trashStats(w http.ResponseWriter, _ *http.Request) {
	count, bytes, err := h.svc.TrashStats()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, TrashStats{Count: count, Bytes: bytes})
}

// emptyTrash 清空回收区：POST /api/trash/empty。
func (h *Handler) emptyTrash(w http.ResponseWriter, _ *http.Request) {
	if err := h.svc.EmptyTrash(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// getSettings 读取 vault 设置：GET /api/settings。
func (h *Handler) getSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, h.svc.GetSettings())
}

// saveSettings 写回 vault 设置：PUT /api/settings {trashRetentionDays}。
func (h *Handler) saveSettings(w http.ResponseWriter, r *http.Request) {
	var in storage.Settings
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := h.svc.SaveSettings(&in); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// getGroups 读取便签组注册表：GET /api/groups（文件缺失返回空表）。
func (h *Handler) getGroups(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, h.svc.GetGroups())
}

// saveGroups 整体替换便签组注册表：PUT /api/groups {groups: [{id, members}]}。
// members 数组顺序即组内叠放顺序；groupId 由调用方生成，服务端不校验格式。
func (h *Handler) saveGroups(w http.ResponseWriter, r *http.Request) {
	var in storage.GroupRegistry
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := h.svc.SaveGroups(&in); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	// 5xx 服务端留痕：客户端日志往往只有状态码（成组回写 500 排查过一次），
	// 真因必须能在服务日志里查到
	if status >= 500 {
		log.Printf("[ERROR] %v", err)
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
