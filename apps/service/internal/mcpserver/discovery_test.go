package mcpserver

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 启动写入：文件落在 <vault>/.pinslip/mcp.json，五字段齐全且格式可解析。
func TestWriteDiscovery(t *testing.T) {
	vault := t.TempDir()
	if err := WriteDiscovery(vault, 10796, "0.2.0"); err != nil {
		t.Fatalf("WriteDiscovery: %v", err)
	}
	data, err := os.ReadFile(DiscoveryPath(vault))
	if err != nil {
		t.Fatalf("发现文件未写入: %v", err)
	}
	var d Discovery
	if err := json.Unmarshal(data, &d); err != nil {
		t.Fatalf("发现文件不是合法 JSON: %v", err)
	}
	if d.Port != 10796 || d.PID != os.Getpid() || d.Version != "0.2.0" || d.MCPPath != MCPPath {
		t.Errorf("字段不符合预期: %+v", d)
	}
	if _, err := time.Parse(time.RFC3339, d.StartedAt); err != nil {
		t.Errorf("startedAt 应为 RFC3339: %q", d.StartedAt)
	}
	// 落盘目录必须正好是 .pinslip（与 git-sync.json/settings.json 同目录，agent 好找）
	if filepath.Dir(DiscoveryPath(vault)) != filepath.Join(vault, ".pinslip") {
		t.Errorf("发现文件目录不对: %s", DiscoveryPath(vault))
	}
}

// version 空串兜底 "dev"；退出删除且重复删除不报错。
func TestDiscoveryVersionFallbackAndRemove(t *testing.T) {
	vault := t.TempDir()
	if err := WriteDiscovery(vault, 1, ""); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(DiscoveryPath(vault))
	var d Discovery
	if err := json.Unmarshal(data, &d); err != nil {
		t.Fatal(err)
	}
	if d.Version != "dev" {
		t.Errorf("空 version 应回退 dev, got %q", d.Version)
	}

	if err := RemoveDiscovery(vault); err != nil {
		t.Fatalf("RemoveDiscovery: %v", err)
	}
	if _, err := os.Stat(DiscoveryPath(vault)); !os.IsNotExist(err) {
		t.Errorf("退出后文件应已删除: %v", err)
	}
	// 幂等：文件不存在再删不算错误（异常退出后启动清理场景）
	if err := RemoveDiscovery(vault); err != nil {
		t.Errorf("重复删除应无错误: %v", err)
	}
}
