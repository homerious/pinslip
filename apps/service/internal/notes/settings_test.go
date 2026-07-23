package notes

import (
	"net/http/httptest"
	"strings"
	"testing"

	"pinslip/service/internal/storage"
)

// PUT /api/settings 未带 mcpEnabled 时保留磁盘现值（旧客户端只知 trashRetentionDays，
// 整体替换会把用户关掉的 MCP 开关抹回缺省开启）。
func TestSaveSettingsPreservesMcpEnabled(t *testing.T) {
	svc, _ := newTestService(t)
	h := NewHandler(svc)

	// 用户已显式关闭 MCP
	if err := svc.SaveSettings(&storage.Settings{TrashRetentionDays: 30, McpEnabled: boolPtr(false)}); err != nil {
		t.Fatal(err)
	}
	// 旧客户端 PUT 只带 trashRetentionDays
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(`{"trashRetentionDays":7}`))
	rec := httptest.NewRecorder()
	h.saveSettings(rec, req)
	if rec.Code != 200 {
		t.Fatalf("PUT 应成功: %d %s", rec.Code, rec.Body.String())
	}
	if svc.GetSettings().IsMcpEnabled() {
		t.Error("未带 mcpEnabled 的 PUT 不应把已关闭的开关抹回开启")
	}
	if svc.GetSettings().TrashRetentionDays != 7 {
		t.Errorf("trashRetentionDays 应已更新为 7, got %d", svc.GetSettings().TrashRetentionDays)
	}

	// 显式带 mcpEnabled=true 的 PUT 生效（开关可被重新打开）
	req = httptest.NewRequest("PUT", "/api/settings", strings.NewReader(`{"trashRetentionDays":7,"mcpEnabled":true}`))
	rec = httptest.NewRecorder()
	h.saveSettings(rec, req)
	if !svc.GetSettings().IsMcpEnabled() {
		t.Error("显式 mcpEnabled=true 应开启开关")
	}
}

// 缺省（无此键的旧配置文件）= 开启。
func TestMcpEnabledDefaultsTrue(t *testing.T) {
	svc, _ := newTestService(t)
	// 全新 vault：无 settings.json
	if !svc.GetSettings().IsMcpEnabled() {
		t.Error("无配置文件时 MCP 应缺省开启")
	}
	// 旧格式配置：只有 trashRetentionDays
	if err := svc.SaveSettings(&storage.Settings{TrashRetentionDays: 30}); err != nil {
		t.Fatal(err)
	}
	if !svc.GetSettings().IsMcpEnabled() {
		t.Error("旧格式配置（无 mcpEnabled 键）应缺省开启")
	}
}
