// Package storage 是文件引擎：Markdown 文件读写、frontmatter 解析、目录维护。
package storage

import (
	"bytes"
	"strings"

	"gopkg.in/yaml.v3"
)

// Frontmatter 是 Markdown 文件头部的 YAML 元数据。
type Frontmatter struct {
	ID        string   `yaml:"id"`
	Title     string   `yaml:"title,omitempty"`
	Tags      []string `yaml:"tags,omitempty"`
	Source    string   `yaml:"source,omitempty"`
	Pin       bool     `yaml:"pin,omitempty"`
	Color     string   `yaml:"color,omitempty"`     // 便签颜色：yellow/pink/green/blue/purple/orange，空为默认黄
	Collapsed bool     `yaml:"collapsed,omitempty"` // 折叠成标题条（只显示标题栏）
	Group     string   `yaml:"group,omitempty"`     // 所属便签组 id（空 = 不属于任何组）
	CreatedAt string   `yaml:"created_at"`
	UpdatedAt string   `yaml:"updated_at"`
}

// MarshalNote 把 frontmatter + 正文序列化为完整的 Markdown 文件内容。
func MarshalNote(fm *Frontmatter, body string) ([]byte, error) {
	y, err := yaml.Marshal(fm)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	buf.WriteString("---\n")
	buf.Write(y)
	buf.WriteString("---\n\n")
	buf.WriteString(body)
	if !strings.HasSuffix(body, "\n") {
		buf.WriteString("\n")
	}
	return buf.Bytes(), nil
}

// ParseNote 解析 Markdown 文件，返回 frontmatter 与正文。
// 没有 frontmatter 的文件返回空 Frontmatter 和全文。
func ParseNote(data []byte) (*Frontmatter, string, error) {
	s := string(data)
	if !strings.HasPrefix(s, "---") {
		return &Frontmatter{}, s, nil
	}
	rest := s[3:]
	idx := strings.Index(rest, "\n---")
	if idx < 0 {
		return &Frontmatter{}, s, nil
	}
	head := rest[:idx]
	body := strings.TrimLeft(rest[idx+4:], "\r\n")

	var fm Frontmatter
	if err := yaml.Unmarshal([]byte(head), &fm); err != nil {
		return nil, "", err
	}
	return &fm, body, nil
}
