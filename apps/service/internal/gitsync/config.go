// sync 配置持久化：存 Go 服务自己的配置区 <vault>/.pinslip/git-sync.json，
// 而非设计稿写的 Electron settings.json——服务拥有配置更内聚（服务才是真正的
// 同步执行者，Electron 只是渲染层），且 .pinslip/ 已被 .gitignore 排除，
// token 不会随同步泄露。
package gitsync

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// 自动推拉间隔（分钟）的合法范围与默认值：normalize 把缺省/越界值拉回默认。
const (
	defaultPushIntervalMin = 10
	minPushIntervalMin     = 1
	maxPushIntervalMin     = 1440 // 一天
)

// SyncConfig 是 git 同步配置。token 只落盘到 .pinslip/git-sync.json，
// 绝不进日志、不进 git 跟踪、不出现在 status 响应里。
type SyncConfig struct {
	URL      string `json:"url"`
	Username string `json:"username"`
	Token    string `json:"token"`
	Branch   string `json:"branch"` // 默认 main
	Enabled  bool   `json:"enabled"`
	// PushIntervalMin 自动推拉间隔（分钟）；0/越界在 normalize 回退默认 10
	PushIntervalMin int `json:"pushIntervalMin,omitempty"`
}

// normalize 清洗输入、补默认值并做最小校验。
func (c *SyncConfig) normalize() error {
	// 输入清洗：复制粘贴常带首尾空白；token 尤其要防 cnb 等平台的
	// 「user:token」复制格式——用户常把 :token 整段粘进来，
	// 多出的前导冒号会让服务端把私有仓库误判成不存在（404 而非 401，极难排查）
	c.URL = strings.TrimSpace(c.URL)
	c.Username = strings.TrimSpace(c.Username)
	c.Token = strings.TrimSpace(c.Token)
	c.Token = strings.TrimPrefix(c.Token, ":")
	if c.Branch == "" {
		c.Branch = "main"
	}
	if c.PushIntervalMin < minPushIntervalMin || c.PushIntervalMin > maxPushIntervalMin {
		c.PushIntervalMin = defaultPushIntervalMin
	}
	if c.Enabled && c.URL == "" {
		return withCode(CodeSyncURLRequired, errors.New("启用同步必须提供仓库地址 url"))
	}
	return nil
}

func configPath(vaultDir string) string {
	return filepath.Join(vaultDir, ".pinslip", "git-sync.json")
}

// loadSyncConfig 读取同步配置；文件不存在返回 nil（未配置），损坏返回错误。
func loadSyncConfig(vaultDir string) (*SyncConfig, error) {
	data, err := os.ReadFile(configPath(vaultDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg SyncConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, cfg.normalize()
}

// saveSyncConfig 写回同步配置（0600：含 token，仅本用户可读）。
func saveSyncConfig(vaultDir string, cfg *SyncConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	p := configPath(vaultDir)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o600)
}
