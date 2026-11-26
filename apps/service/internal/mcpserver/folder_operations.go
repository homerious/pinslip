package mcpserver

import (
	"context"
	"path"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
)

func (h *toolHandler) createFolder(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	folder, err := req.RequireString("path")
	if err != nil || strings.TrimSpace(folder) == "" {
		return mcp.NewToolResultError("path 必须是 notes/ 下的非空相对路径"), nil
	}
	if err := h.svc.CreateFolder(folder); err != nil {
		return serviceErr("创建文件夹", err)
	}
	return structured(map[string]string{"status": "ok", "path": folder})
}

func (h *toolHandler) renameFolder(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	folder, err := req.RequireString("path")
	if err != nil || strings.TrimSpace(folder) == "" {
		return mcp.NewToolResultError("path 必须是 notes/ 下的非空相对路径"), nil
	}
	name, err := req.RequireString("name")
	if err != nil || strings.TrimSpace(name) == "" {
		return mcp.NewToolResultError("name 必须是非空的同级目录名"), nil
	}
	if err := h.svc.RenameFolder(folder, name); err != nil {
		return serviceErr("重命名文件夹", err)
	}
	return structured(map[string]string{"status": "ok", "path": path.Join(path.Dir(folder), name)})
}

func (h *toolHandler) deleteFolder(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	folder, err := req.RequireString("path")
	if err != nil || strings.TrimSpace(folder) == "" {
		return mcp.NewToolResultError("path 必须是 notes/ 下的非空相对路径"), nil
	}
	mode, err := req.RequireString("mode")
	if err != nil || (mode != "move" && mode != "trash") {
		return mcp.NewToolResultError("mode 必须显式指定 move 或 trash"), nil
	}
	if err := h.svc.DeleteFolder(folder, mode); err != nil {
		return serviceErr("删除文件夹", err)
	}
	return structured(map[string]string{"status": "ok", "path": folder, "mode": mode})
}
