// Package config 负责加载配置与解析数据目录。
package config

import (
	"os"
	"path/filepath"
)

// Config 是服务运行所需的全部配置。
type Config struct {
	DataDir string // 数据根目录，包含 notes/ inbox/ attachments/ .pinslip/
	Port    int    // HTTP 监听端口，0 = 随机端口
}

// Load 加载配置。数据目录优先级：PINSLIP_DATA_DIR 环境变量 > ~/Documents/PinSlip。
func Load() (*Config, error) {
	dir := os.Getenv("PINSLIP_DATA_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		dir = filepath.Join(home, "Documents", "PinSlip")
	}
	cfg := &Config{DataDir: dir, Port: 0}
	return cfg, nil
}

func (c *Config) NotesDir() string  { return filepath.Join(c.DataDir, "notes") }
func (c *Config) InboxDir() string  { return filepath.Join(c.DataDir, "inbox") }
func (c *Config) AttachDir() string { return filepath.Join(c.DataDir, "attachments") }
func (c *Config) DBPath() string    { return filepath.Join(c.DataDir, ".pinslip", "pinslip.db") }

// EnsureDirs 创建数据目录结构。
func (c *Config) EnsureDirs() error {
	dirs := []string{c.NotesDir(), c.InboxDir(), c.AttachDir(), filepath.Dir(c.DBPath())}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}
