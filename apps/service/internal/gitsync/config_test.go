package gitsync

import "testing"

// 输入清洗：复制粘贴带来的空白与前导冒号必须被剥掉。
// 真实案例（2026-07-23 实测）：cnb 令牌按「user:token」格式展示，用户粘成
// ":1O1c..."，服务端对私有仓库的错误 token 返回 404「仓库不存在」而非 401，
// 排查链路极长——清洗逻辑就是在这里上的保险。
func TestNormalizeSanitizesInput(t *testing.T) {
	cfg := SyncConfig{
		URL:      "  https://cnb.cool/homerious/pinslip.git  ",
		Username: " cnb ",
		Token:    ":1O1c9b7bWBEkP5KLK4X824oAzUD\n",
		Enabled:  true,
	}
	if err := cfg.normalize(); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if cfg.URL != "https://cnb.cool/homerious/pinslip.git" {
		t.Fatalf("url 未去空白: %q", cfg.URL)
	}
	if cfg.Username != "cnb" {
		t.Fatalf("username 未去空白: %q", cfg.Username)
	}
	if cfg.Token != "1O1c9b7bWBEkP5KLK4X824oAzUD" {
		t.Fatalf("token 未去前导冒号/空白: %q", cfg.Token)
	}
	if cfg.Branch != "main" {
		t.Fatalf("branch 默认值: %q", cfg.Branch)
	}
}

// 清洗语义不破坏合法输入（token 内部的冒号保留——只剥前导一个）。
func TestNormalizeKeepsInnerColon(t *testing.T) {
	cfg := SyncConfig{URL: "https://example.com/r.git", Token: "ab:cd", Enabled: true}
	if err := cfg.normalize(); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if cfg.Token != "ab:cd" {
		t.Fatalf("token 内部冒号被误删: %q", cfg.Token)
	}
}
