package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// DefaultTrashRetentionDays 回收区自动清理的默认保留天数。
const DefaultTrashRetentionDays = 30

// 速记落点模式（quickCaptureMode 的合法取值）。
const (
	// QuickModeNote 逐条新建到收集箱（默认）
	QuickModeNote = "note"
	// QuickModeDaily 聚合到今日便签「速记 YYYY-MM-DD」
	QuickModeDaily = "daily"
)

// Settings 是 vault 级用户设置，持久化在 <vault>/.pinslip/settings.json
// （隐藏目录，与 pinslip.db 同级，不污染 notes/ 可见区域）。
type Settings struct {
	// TrashRetentionDays 回收区保留天数；<= 0 表示不自动清理
	TrashRetentionDays int `json:"trashRetentionDays"`
	// McpEnabled MCP 服务（/mcp 端点）开关；nil = 缺省开启
	// （指针是为了区分「未设置」与「显式关闭」——布尔零值无法表达三态）
	McpEnabled *bool `json:"mcpEnabled,omitempty"`
	// QuickCaptureMode 速记落点：note（默认）/ daily；空串 = 未设置（旧配置）
	QuickCaptureMode string `json:"quickCaptureMode,omitempty"`
	// QuickCaptureClipboard 速记窗打开时预填剪贴板文本；nil = 缺省开启
	QuickCaptureClipboard *bool `json:"quickCaptureClipboard,omitempty"`
}

// IsMcpEnabled MCP 服务是否开启：缺省 true，仅显式 false 才关闭。
func (s *Settings) IsMcpEnabled() bool {
	return s.McpEnabled == nil || *s.McpEnabled
}

// QuickMode 速记落点：仅精确 "daily" 走聚合，缺省/非法一律回退逐条模式。
func (s *Settings) QuickMode() string {
	if s.QuickCaptureMode == QuickModeDaily {
		return QuickModeDaily
	}
	return QuickModeNote
}

// IsQuickCaptureClipboard 剪贴板预填是否开启：缺省 true。
func (s *Settings) IsQuickCaptureClipboard() bool {
	return s.QuickCaptureClipboard == nil || *s.QuickCaptureClipboard
}

func defaultSettings() *Settings {
	return &Settings{TrashRetentionDays: DefaultTrashRetentionDays}
}

func (e *Engine) settingsPath() string {
	return filepath.Join(filepath.Dir(e.notesDir), ".pinslip", "settings.json")
}

// LoadSettings 读取 vault 设置；文件不存在或损坏时返回默认值（不报错）。
func (e *Engine) LoadSettings() *Settings {
	data, err := os.ReadFile(e.settingsPath())
	if err != nil {
		return defaultSettings()
	}
	s := defaultSettings()
	if err := json.Unmarshal(data, s); err != nil {
		return defaultSettings()
	}
	return s
}

// SaveSettings 写回 vault 设置（带缩进，用户可读/手改）。
func (e *Engine) SaveSettings(s *Settings) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(e.settingsPath()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(e.settingsPath(), data, 0o644)
}
