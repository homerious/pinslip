package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Group 是一个便签组：几张便签竖向叠放为一组。
// ID 由调用方（Electron 端）生成，Go 侧只做存储透传，不校验格式；
// Members 是成员便签 id 列表，数组顺序即组内叠放顺序；
// Name 是用户自定义组名（可空，空时渲染层只显示手柄圆点）。
type Group struct {
	ID      string   `json:"id"`
	Members []string `json:"members"`
	Name    string   `json:"name,omitempty"`
}

// GroupRegistry 是 vault 级便签组注册表，持久化在 <vault>/.pinslip/groups.json
// （与 settings.json 同级，不污染 notes/ 可见区域）。
type GroupRegistry struct {
	Groups []Group `json:"groups"`
}

func emptyGroupRegistry() *GroupRegistry {
	return &GroupRegistry{Groups: []Group{}}
}

func (e *Engine) groupsPath() string {
	return filepath.Join(filepath.Dir(e.notesDir), ".pinslip", "groups.json")
}

// LoadGroups 读取便签组注册表；文件不存在或损坏时返回空注册表（不报错）。
func (e *Engine) LoadGroups() *GroupRegistry {
	data, err := os.ReadFile(e.groupsPath())
	if err != nil {
		return emptyGroupRegistry()
	}
	r := emptyGroupRegistry()
	if err := json.Unmarshal(data, r); err != nil {
		return emptyGroupRegistry()
	}
	return r
}

// SaveGroups 整体写回便签组注册表（带缩进，用户可读/手改）。
func (e *Engine) SaveGroups(r *GroupRegistry) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(e.groupsPath()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(e.groupsPath(), data, 0o644)
}
