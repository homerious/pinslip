package index

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestTokenizeCJKBigrams(t *testing.T) {
	got := tokenize("中文标题")
	for _, want := range []string{"中文", "文标", "标题"} {
		if !strings.Contains(got, want) {
			t.Errorf("tokenize(中文标题) = %q, 应含 bigram %q", got, want)
		}
	}
}

func TestTokenizeLatinLowercased(t *testing.T) {
	got := tokenize("PinSlip")
	if !strings.Contains(got, "pinslip") {
		t.Errorf("tokenize(PinSlip) = %q, 应小写化为 pinslip", got)
	}
}

func TestTokenizeMixed(t *testing.T) {
	got := tokenize("使用Go语言")
	// 拉丁整词 + CJK bigram 都在
	if !strings.Contains(got, "go") {
		t.Errorf("应含拉丁词 go: %q", got)
	}
	if !strings.Contains(got, "语言") {
		t.Errorf("应含 bigram 语言: %q", got)
	}
}

func newTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestUpsertSearchDelete(t *testing.T) {
	db := newTestDB(t)
	if err := db.Upsert(Record{ID: "a1", Title: "周会纪要", Content: "讨论了 pinslip 发布计划", Tags: "工作"}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	// 中文子串命中
	hits, err := db.Search("纪要", 10)
	if err != nil || len(hits) == 0 {
		t.Fatalf("Search(纪要) 应命中: hits=%v err=%v", hits, err)
	}
	if hits[0].ID != "a1" || hits[0].Title != "周会纪要" {
		t.Errorf("hit 内容不符: %+v", hits[0])
	}

	// 拉丁词不区分大小写
	hits, err = db.Search("PINSLIP", 10)
	if err != nil || len(hits) == 0 {
		t.Fatalf("Search(PINSLIP) 应命中: hits=%v err=%v", hits, err)
	}

	// 删除后不命中
	if err := db.Delete("a1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	hits, err = db.Search("纪要", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 0 {
		t.Errorf("删除后不应命中: %v", hits)
	}
}

// 特殊字符查询不应报错（buildMatchQuery 逐词加引号 + LIKE 兜底）。
func TestSearchSpecialChars(t *testing.T) {
	db := newTestDB(t)
	_ = db.Upsert(Record{ID: "b1", Title: "普通笔记", Content: "内容"})
	for _, q := range []string{`"引号"`, `a AND b`, `x OR y`, `*`, `(括号)`, `'`} {
		if _, err := db.Search(q, 10); err != nil {
			t.Errorf("Search(%q) 不应报错: %v", q, err)
		}
	}
}

func TestMakeSnippet(t *testing.T) {
	raw := strings.Repeat("前面的铺垫文字", 10) + "关键词" + strings.Repeat("后面的补充文字", 10)
	snip := makeSnippet(raw, []string{"关键词"})
	if !strings.Contains(snip, "关键词") {
		t.Errorf("摘要应含命中词: %q", snip)
	}
	if !strings.Contains(snip, "…") {
		t.Errorf("截断摘要应含省略号: %q", snip)
	}
}

// Rebuild 全量替换索引。
func TestRebuild(t *testing.T) {
	db := newTestDB(t)
	_ = db.Upsert(Record{ID: "old", Title: "旧笔记", Content: "旧内容"})
	if err := db.Rebuild([]Record{{ID: "new", Title: "新笔记", Content: "新内容"}}); err != nil {
		t.Fatalf("Rebuild: %v", err)
	}
	hits, _ := db.Search("旧内容", 10)
	if len(hits) != 0 {
		t.Errorf("Rebuild 后旧记录应被清空: %v", hits)
	}
	hits, _ = db.Search("新内容", 10)
	if len(hits) != 1 || hits[0].ID != "new" {
		t.Errorf("Rebuild 后应能搜到新记录: %v", hits)
	}
}

// 列权重排序：标题命中 > 标签命中 > 正文命中（bm25 列权重 10/5/1）。
func TestSearchRankingWeights(t *testing.T) {
	db := newTestDB(t)
	// 同一个词分别出现在 正文/标签/标题，内容长度接近，避免 bm25 长度因子干扰
	_ = db.Upsert(Record{ID: "in-content", Title: "普通标题甲", Content: "今天讨论发布checklist的细节", Tags: "杂项"})
	_ = db.Upsert(Record{ID: "in-tags", Title: "普通标题乙", Content: "随便写点什么凑数的内容", Tags: "发布checklist"})
	_ = db.Upsert(Record{ID: "in-title", Title: "发布checklist", Content: "另外一些不相关的正文", Tags: "杂项"})

	hits, err := db.Search("发布checklist", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 3 {
		t.Fatalf("应命中 3 条: %v", hits)
	}
	wantOrder := []string{"in-title", "in-tags", "in-content"}
	for i, want := range wantOrder {
		if hits[i].ID != want {
			t.Errorf("第 %d 名 = %q, want %q（实际顺序 %v）", i+1, hits[i].ID, want, hits)
		}
	}
}
