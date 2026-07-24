package notes

import (
	"strings"
	"testing"
	"time"
)

func TestMakeExcerpt(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"空正文", "", ""},
		{"纯文本", "今天天气不错\n适合出门", "今天天气不错 适合出门"},
		{"标题与引用", "# 周报\n\n> 本周进度良好", "周报 本周进度良好"},
		{"列表与任务", "- 牛奶\n- [x] 鸡蛋\n1. 面包", "牛奶 鸡蛋 面包"},
		{"行内标记", "这**非常**重要，`code` 与 ~~作废~~ 文字", "这非常重要，code 与 作废 文字"},
		{"链接留文字", "详见 [设计文档](https://example.com) 与 [A](https://a.b)", "详见 设计文档 与 A"},
		{"图片留 alt", "界面长这样：![主界面截图](../attachments/a.png)\n结束", "界面长这样：主界面截图 结束"},
		{"无 alt 图片去掉", "前面 ![](../attachments/a.png) 后面", "前面 后面"},
		{"HTML 标签", "<p>剪藏 <b>正文</b></p>", "剪藏 正文"},
		{"冲突标记跳过", "正常行\n<<<<<<< HEAD\n本地内容\n=======\n远端内容\n>>>>>>> other", "正常行 本地内容 远端内容"},
		{"代码围栏跳过", "```go\nfmt.Println(1)\n```\n正文", "fmt.Println(1) 正文"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := MakeExcerpt(c.body); got != c.want {
				t.Fatalf("MakeExcerpt = %q, want %q", got, c.want)
			}
		})
	}
}

func TestMakeExcerptTruncation(t *testing.T) {
	body := strings.Repeat("字", 250)
	got := MakeExcerpt(body)
	runes := []rune(got)
	if len(runes) != ExcerptMaxRunes+1 || !strings.HasSuffix(got, "…") {
		t.Fatalf("截断形态不对（应 %d 字 + 省略号）: len=%d", ExcerptMaxRunes, len(runes))
	}
	// 不足 100 字不补省略号
	if got := MakeExcerpt("短内容"); strings.HasSuffix(got, "…") {
		t.Fatalf("短内容不应有省略号: %q", got)
	}
}

func TestInTimeRange(t *testing.T) {
	base := time.Date(2026, 7, 23, 12, 0, 0, 0, time.Local)
	m := Meta{CreatedAt: base, UpdatedAt: base.Add(2 * time.Hour)}

	day := time.Date(2026, 7, 23, 0, 0, 0, 0, time.Local)
	end := day.Add(24*time.Hour - time.Nanosecond)
	if !InTimeRange(m, TimeFieldUpdated, &day, &end) {
		t.Fatal("当天范围应命中（闭区间）")
	}
	next := day.Add(24 * time.Hour)
	if InTimeRange(m, TimeFieldUpdated, &next, nil) {
		t.Fatal("次日起始应排除")
	}
	// timeField=created：updated 超范围但 created 在内 → 命中
	until := base.Add(time.Hour)
	if !InTimeRange(m, TimeFieldCreated, nil, &until) {
		t.Fatal("created 在范围内应命中")
	}
	if InTimeRange(m, TimeFieldUpdated, nil, &until) {
		t.Fatal("updated 超范围应排除")
	}
	// 全开区间恒真
	if !InTimeRange(m, "bogus", nil, nil) {
		t.Fatal("无端点应恒真")
	}
}
