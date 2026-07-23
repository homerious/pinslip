// Package mcpserver 提供 PinSlip 的 MCP server（设计稿 docs/design-mcp.md）：
// 与现有 HTTP API 同端口同进程，Streamable HTTP 传输挂在 /mcp 路由；
// 工具层是薄壳，全部读写走 internal/notes、internal/gitsync 的现有服务层。
//
// 接入发现：服务启动时写 <vault>/.pinslip/mcp.json（agent 读文件即知怎么连），
// 优雅退出时删除；文件不存在 / pid 已死 = 应用未启动，由 skill 引导用户先开应用。
package mcpserver

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// MCPPath 是 MCP 端点的固定路由（discovery 文件与路由注册共用同一锚点）。
const MCPPath = "/mcp"

// Discovery 是写给 agent 的接入信息（<vault>/.pinslip/mcp.json）。
type Discovery struct {
	Port      int    `json:"port"`
	PID       int    `json:"pid"`
	Version   string `json:"version"`
	MCPPath   string `json:"mcpPath"`
	StartedAt string `json:"startedAt"` // RFC3339
}

// DiscoveryPath 返回 discovery 文件位置（与 git-sync.json/settings.json 同目录）。
func DiscoveryPath(vaultDir string) string {
	return filepath.Join(vaultDir, ".pinslip", "mcp.json")
}

// WriteDiscovery 启动时写入接入信息。version 为空用 "dev"。
func WriteDiscovery(vaultDir string, port int, version string) error {
	if version == "" {
		version = "dev"
	}
	d := Discovery{
		Port:      port,
		PID:       os.Getpid(),
		Version:   version,
		MCPPath:   MCPPath,
		StartedAt: time.Now().Format(time.RFC3339),
	}
	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	p := DiscoveryPath(vaultDir)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}

// RemoveDiscovery 优雅退出时删除接入信息（残留文件会让 agent 误判服务在线）。
// 文件不存在不算错误。
func RemoveDiscovery(vaultDir string) error {
	if err := os.Remove(DiscoveryPath(vaultDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
