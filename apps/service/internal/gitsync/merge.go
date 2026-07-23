// Package gitsync 提供 PinSlip git 同步所需的三方文本合并能力。
//
// MergeText 实现行级 diff3 三方合并，语义对齐 GNU diff3 / git merge-file。
// 算法思路（LCS → 对齐 → 分块 → 按侧取舍）：
//
//  1. 切行：把 base / ours / theirs 按行切分，每行保留其原始换行符
//     （最后一行可能没有 '\n'）。这样比较与输出都基于原始字节内容，
//     无尾换行的文件合并后不会凭空添加或丢失换行。
//  2. 匹配：分别求 base↔ours、base↔theirs 的最长公共子序列（LCS），
//     得到两组对齐关系 m1 / m2（base 行号 → 对侧行号，-1 表示该行被改/删）。
//     LCS 采用 Hirschberg 线性空间算法：时间 O(n·m)，空间 O(m)，
//     避免 10000×10000 的完整 DP 表（约 400MB）。便签文件都很小，
//     该实现完全够用。注意：LCS 与 GNU diff 同属最小编辑距离对齐，
//     但在多个等长最优解之间的选择可能与 GNU diff3 略有差异，
//     只影响变更块的切分位置，不影响合并正确性。
//  3. 分块：沿 base 顺序扫描。当 base[i] 同时与 ours[j]、theirs[k] 对齐时，
//     该行为"稳定区"（三方一致，原样输出）；否则进入"变更块"——向后找下一个
//     两侧都有匹配的 base 行，块内 base/ours/theirs 各占一段（可为空）。
//  4. 取舍：对每个变更块比较三段内容——
//     ours == theirs → 两侧修改一致，取一份，不冲突；
//     ours == base   → 仅 theirs 修改，取 theirs；
//     theirs == base → 仅 ours 修改，取 ours；
//     三者互不相同   → 输出冲突块（见下方标记常量）。
//
// 冲突块标记格式（含中文标注）为产品要求，不可更改：
//
//	<<<<<<< HEAD（本地）
//	ours 的行
//	=======
//	theirs 的行
//	>>>>>>> origin/main（远端）
package gitsync

import (
	"bytes"
	"fmt"
	"strings"
)

// maxLines 为单侧输入的行数上限。超过后返回错误，由调用方降级处理。
const maxLines = 10000

// 冲突块标记，严格遵循产品要求格式。
const (
	conflictMarkerOurs   = "<<<<<<< HEAD（本地）\n"
	conflictMarkerSep    = "=======\n"
	conflictMarkerTheirs = ">>>>>>> origin/main（远端）\n"
)

// MergeText 对行文本做三方合并（base 为共同祖先，ours/theirs 为两侧修改）。
// 返回合并后的内容与是否产生了冲突标记。
// 任一侧超过 10000 行时返回错误（调用方应降级为整文件冲突，本包不负责降级）。
func MergeText(base, ours, theirs []byte) (merged []byte, conflicts bool, err error) {
	baseLines := splitLines(base)
	oursLines := splitLines(ours)
	theirsLines := splitLines(theirs)

	for _, side := range []struct {
		name  string
		lines []string
	}{
		{"base", baseLines},
		{"ours", oursLines},
		{"theirs", theirsLines},
	} {
		if len(side.lines) > maxLines {
			return nil, false, fmt.Errorf("gitsync: %s input has %d lines, exceeds the %d-line limit",
				side.name, len(side.lines), maxLines)
		}
	}

	// m1[i] = ours 中与 base[i] 匹配的行号，-1 表示无匹配；m2 同理对应 theirs。
	m1 := matchIndex(baseLines, oursLines)
	m2 := matchIndex(baseLines, theirsLines)

	var buf bytes.Buffer
	buf.Grow(len(base) + len(ours) + len(theirs))

	i, j, k := 0, 0, 0 // 分别指向 base / ours / theirs 的当前行
	for i < len(baseLines) || j < len(oursLines) || k < len(theirsLines) {
		if i < len(baseLines) && m1[i] == j && m2[i] == k {
			// 稳定区：三方一致，原样输出。
			buf.WriteString(baseLines[i])
			i++
			j++
			k++
			continue
		}

		// 变更块：向后找下一个两侧都存在匹配的 base 行作为块终点。
		// 由于 LCS 匹配是单调不交叉的，m1[i'] >= j、m2[i'] >= k 恒成立。
		i0, j0, k0 := i, j, k
		for i < len(baseLines) && (m1[i] < 0 || m2[i] < 0) {
			i++
		}
		if i < len(baseLines) {
			j, k = m1[i], m2[i]
		} else {
			j, k = len(oursLines), len(theirsLines)
		}

		b := baseLines[i0:i]
		o := oursLines[j0:j]
		t := theirsLines[k0:k]
		switch {
		case equalLines(o, t):
			// 两侧修改一致（含同时删除），取一份。
			writeRaw(&buf, o)
		case equalLines(o, b):
			// 仅 theirs 修改。
			writeRaw(&buf, t)
		case equalLines(t, b):
			// 仅 ours 修改。
			writeRaw(&buf, o)
		default:
			conflicts = true
			buf.WriteString(conflictMarkerOurs)
			writeSection(&buf, o)
			buf.WriteString(conflictMarkerSep)
			writeSection(&buf, t)
			buf.WriteString(conflictMarkerTheirs)
		}
	}
	return buf.Bytes(), conflicts, nil
}

// splitLines 按行切分，每行保留其换行符；最后一行可能不带 '\n'。
// 空输入返回 nil。
func splitLines(b []byte) []string {
	if len(b) == 0 {
		return nil
	}
	s := string(b)
	var lines []string
	for len(s) > 0 {
		idx := strings.IndexByte(s, '\n')
		if idx < 0 {
			lines = append(lines, s)
			break
		}
		lines = append(lines, s[:idx+1])
		s = s[idx+1:]
	}
	return lines
}

// matchIndex 求 base 与 other 的 LCS 对齐：返回切片 m，
// m[p] = q 表示 base[p] 与 other[q] 匹配，-1 表示 base[p] 无匹配。
func matchIndex(base, other []string) []int {
	m := make([]int, len(base))
	for i := range m {
		m[i] = -1
	}
	lcsMatches(base, other, 0, 0, m)
	return m
}

// lcsMatches 用 Hirschberg 线性空间算法求 a 与 b 的 LCS，并把匹配关系写入 m：
// 若 a[p] 与 b[q] 匹配，则 m[aOff+p] = bOff+q。时间 O(len(a)·len(b))，空间 O(len(b))。
func lcsMatches(a, b []string, aOff, bOff int, m []int) {
	if len(a) == 0 || len(b) == 0 {
		return
	}
	if len(a) == 1 {
		for q := range b {
			if b[q] == a[0] {
				m[aOff] = bOff + q
				return
			}
		}
		return
	}

	mid := len(a) / 2
	left := lcsRow(a[:mid], b)
	// right[t] = a[mid:] 的长 t 后缀 与 b 的长 t 后缀 的 LCS 长度。
	right := lcsRow(reversed(a[mid:]), reversed(b))

	// 选切点 cut 使 左半 LCS + 右半 LCS 最大（取第一个最大值，保证确定性）。
	best, cut := -1, 0
	for q := 0; q <= len(b); q++ {
		if v := left[q] + right[len(b)-q]; v > best {
			best, cut = v, q
		}
	}
	lcsMatches(a[:mid], b[:cut], aOff, bOff, m)
	lcsMatches(a[mid:], b[cut:], aOff+mid, bOff+cut, m)
}

// lcsRow 返回 LCS DP 表的最后一行：row[q] = LCS(a, b[:q]) 的长度。
// 只保留两行滚动，空间 O(len(b))。
func lcsRow(a, b []string) []int {
	prev := make([]int, len(b)+1)
	curr := make([]int, len(b)+1)
	for p := range a {
		for q := range b {
			switch {
			case a[p] == b[q]:
				curr[q+1] = prev[q] + 1
			case prev[q+1] >= curr[q]:
				curr[q+1] = prev[q+1]
			default:
				curr[q+1] = curr[q]
			}
		}
		prev, curr = curr, prev // curr[0] 恒为 0，交换后无需清零
	}
	return prev
}

func reversed(s []string) []string {
	r := make([]string, len(s))
	for i, v := range s {
		r[len(s)-1-i] = v
	}
	return r
}

func equalLines(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// writeRaw 原样写出行内容（不增删任何换行）。
func writeRaw(buf *bytes.Buffer, lines []string) {
	for _, l := range lines {
		buf.WriteString(l)
	}
}

// writeSection 在冲突块内写出一侧的内容。若最后一行无换行符则补一个，
// 保证后续冲突标记独占一行（与 git merge-file 行为一致）。
func writeSection(buf *bytes.Buffer, lines []string) {
	writeRaw(buf, lines)
	if n := len(lines); n > 0 && !strings.HasSuffix(lines[n-1], "\n") {
		buf.WriteByte('\n')
	}
}
