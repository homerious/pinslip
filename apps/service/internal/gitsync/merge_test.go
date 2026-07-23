package gitsync

import (
	"fmt"
	"strings"
	"testing"
)

func TestMergeText(t *testing.T) {
	tests := []struct {
		name          string
		base          string
		ours          string
		theirs        string
		want          string
		wantConflicts bool
	}{
		{
			name:   "干净合并：两侧修改不同区域（开头 vs 结尾）",
			base:   "alpha\nbeta\ngamma\ndelta\n",
			ours:   "ALPHA\nbeta\ngamma\ndelta\n",
			theirs: "alpha\nbeta\ngamma\nDELTA\n",
			want:   "ALPHA\nbeta\ngamma\nDELTA\n",
		},
		{
			name:   "同一行两侧改成不同内容：产生冲突块",
			base:   "a\nb\nc\n",
			ours:   "a\nours-b\nc\n",
			theirs: "a\ntheirs-b\nc\n",
			want: "a\n" +
				"<<<<<<< HEAD（本地）\n" +
				"ours-b\n" +
				"=======\n" +
				"theirs-b\n" +
				">>>>>>> origin/main（远端）\n" +
				"c\n",
			wantConflicts: true,
		},
		{
			name:   "两侧做了相同修改：只出现一次，无冲突",
			base:   "x\ny\nz\n",
			ours:   "x\nY\nz\n",
			theirs: "x\nY\nz\n",
			want:   "x\nY\nz\n",
		},
		{
			name:   "仅 ours 修改：直通",
			base:   "1\n2\n3\n",
			ours:   "1\n2-ours\n3\n",
			theirs: "1\n2\n3\n",
			want:   "1\n2-ours\n3\n",
		},
		{
			name:   "仅 theirs 修改：直通",
			base:   "1\n2\n3\n",
			ours:   "1\n2\n3\n",
			theirs: "1\n2-theirs\n3\n",
			want:   "1\n2-theirs\n3\n",
		},
		{
			name:   "两侧在文件末尾追加不同内容：冲突块",
			base:   "a\n",
			ours:   "a\nours-tail\n",
			theirs: "a\ntheirs-tail\n",
			want: "a\n" +
				"<<<<<<< HEAD（本地）\n" +
				"ours-tail\n" +
				"=======\n" +
				"theirs-tail\n" +
				">>>>>>> origin/main（远端）\n",
			wantConflicts: true,
		},
		{
			name:   "base 为空、两侧各加不同内容：冲突块",
			base:   "",
			ours:   "ours-only\n",
			theirs: "theirs-only\n",
			want: "<<<<<<< HEAD（本地）\n" +
				"ours-only\n" +
				"=======\n" +
				"theirs-only\n" +
				">>>>>>> origin/main（远端）\n",
			wantConflicts: true,
		},
		{
			name:   "无尾换行：一侧改最后一行，另一侧不动，保持无尾换行且不冲突",
			base:   "a\nb\nc",
			ours:   "a\nb\nc2",
			theirs: "a\nb\nc",
			want:   "a\nb\nc2",
		},
		{
			name:   "完全无变化：三方一致，原样输出",
			base:   "same\ncontent\nhere\n",
			ours:   "same\ncontent\nhere\n",
			theirs: "same\ncontent\nhere\n",
			want:   "same\ncontent\nhere\n",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			merged, conflicts, err := MergeText([]byte(tc.base), []byte(tc.ours), []byte(tc.theirs))
			if err != nil {
				t.Fatalf("MergeText 返回错误: %v", err)
			}
			if got := string(merged); got != tc.want {
				t.Errorf("合并结果不匹配\ngot:\n%q\nwant:\n%q", got, tc.want)
			}
			if conflicts != tc.wantConflicts {
				t.Errorf("conflicts = %v, want %v", conflicts, tc.wantConflicts)
			}
		})
	}
}

// TestMergeTextConflictMarkers 显式校验冲突块包含两侧内容与三种标记行。
func TestMergeTextConflictMarkers(t *testing.T) {
	merged, conflicts, err := MergeText([]byte("v\n"), []byte("ours-v\n"), []byte("theirs-v\n"))
	if err != nil {
		t.Fatalf("MergeText 返回错误: %v", err)
	}
	if !conflicts {
		t.Fatal("应报告冲突")
	}
	for _, want := range []string{
		"<<<<<<< HEAD（本地）\n",
		"=======\n",
		">>>>>>> origin/main（远端）\n",
		"ours-v\n",
		"theirs-v\n",
	} {
		if !strings.Contains(string(merged), want) {
			t.Errorf("冲突输出缺少 %q，实际:\n%q", want, string(merged))
		}
	}
}

// TestMergeTextNoTrailingNewlineConflict 无尾换行的内容进入冲突块时，
// 标记行仍须独占一行（与 git merge-file 一致，允许为标记完整性补换行）。
func TestMergeTextNoTrailingNewlineConflict(t *testing.T) {
	merged, conflicts, err := MergeText([]byte("x"), []byte("ours-x"), []byte("theirs-x"))
	if err != nil {
		t.Fatalf("MergeText 返回错误: %v", err)
	}
	want := "<<<<<<< HEAD（本地）\n" +
		"ours-x\n" +
		"=======\n" +
		"theirs-x\n" +
		">>>>>>> origin/main（远端）\n"
	if !conflicts {
		t.Fatal("应报告冲突")
	}
	if got := string(merged); got != want {
		t.Errorf("got:\n%q\nwant:\n%q", got, want)
	}
}

func TestMergeTextLineLimit(t *testing.T) {
	mk := func(n int) []byte {
		var sb strings.Builder
		for i := 0; i < n; i++ {
			fmt.Fprintf(&sb, "line %d\n", i)
		}
		return []byte(sb.String())
	}

	small := mk(3)
	big := mk(maxLines + 1) // 10001 行

	cases := []struct {
		name               string
		base, ours, theirs []byte
	}{
		{"base 超限", big, small, small},
		{"ours 超限", small, big, small},
		{"theirs 超限", small, small, big},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := MergeText(tc.base, tc.ours, tc.theirs); err == nil {
				t.Fatal("超过 10000 行应返回错误")
			}
		})
	}

	// 边界：恰好 10000 行应正常合并。
	merged, conflicts, err := MergeText(mk(maxLines), mk(maxLines), mk(maxLines))
	if err != nil {
		t.Fatalf("恰好 %d 行不应报错: %v", maxLines, err)
	}
	if conflicts {
		t.Fatal("三方一致不应冲突")
	}
	if string(merged) != string(mk(maxLines)) {
		t.Fatal("三方一致时应原样输出")
	}
}
