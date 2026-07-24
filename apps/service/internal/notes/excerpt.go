// excerpt.go — 列表摘要生成：从 Markdown 正文提取纯文本片段，
// 供 MCP list_notes 与列表 API 做预览（不拉全文就能判断便签内容）。
package notes

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// ExcerptMaxRunes 是摘要的最大字符数（超出截断并补省略号）。
const ExcerptMaxRunes = 100

var (
	// 行首块级标记：标题 #、引用 >、无序/有序/任务列表、代码块围栏
	excerptBlockPrefix = regexp.MustCompile(`^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|` + "`" + `{3}.*$)`)
	// 图片：整体去掉但保留 alt（alt 是内容描述，丢了反而误导「这里没东西」）
	excerptImage = regexp.MustCompile(`!\[([^\]]*)\]\([^)]*\)`)
	// 链接保留文字
	excerptLink = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	// 行内标记：加粗/斜体/删除线/行内代码
	excerptEmph = regexp.MustCompile(`(\*\*|__|\*|_|~~|` + "`" + `)`)
	// HTML 标签（剪藏内容可能带）
	excerptHTML = regexp.MustCompile(`</?[a-zA-Z][^>]*>`)
	// 空白压缩（含换行）
	excerptSpace = regexp.MustCompile(`\s+`)
)

// MakeExcerpt 生成正文摘要：去 markdown 标记、图片仅留 alt、压缩空白，
// 截断到 ExcerptMaxRunes（rune 安全）。正文为空返回 ""。
func MakeExcerpt(body string) string {
	var b strings.Builder
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		// git 冲突标记行不进摘要（与标题推导同规则）
		if strings.HasPrefix(line, "<<<<<<<") || strings.HasPrefix(line, "=======") ||
			strings.HasPrefix(line, ">>>>>>>") {
			continue
		}
		for excerptBlockPrefix.MatchString(line) {
			next := strings.TrimSpace(excerptBlockPrefix.ReplaceAllString(line, ""))
			if next == line {
				break
			}
			line = next
		}
		if line == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(line)
		// 已超截断长度就不必再扫后面的行
		if b.Len() > ExcerptMaxRunes*4 {
			break
		}
	}
	s := excerptImage.ReplaceAllString(b.String(), "$1")
	s = excerptLink.ReplaceAllString(s, "$1")
	s = excerptEmph.ReplaceAllString(s, "")
	s = excerptHTML.ReplaceAllString(s, "")
	s = excerptSpace.ReplaceAllString(strings.TrimSpace(s), " ")
	if utf8.RuneCountInString(s) > ExcerptMaxRunes {
		r := []rune(s)
		s = string(r[:ExcerptMaxRunes]) + "…"
	}
	return s
}
