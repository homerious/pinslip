// Package index 维护 SQLite FTS5 全文索引。索引只是加速器，可从文件引擎全量重建。
//
// 中文搜索方案：FTS5 默认的 unicode61 分词器不会切分 CJK，
// 这里在写入和查询两侧都把 CJK 连续段拆成重叠二元组（bigram），
// 拉丁文本保持整词。原文另存于 UNINDEXED 列，用于生成可读摘要。
package index

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"unicode"

	_ "modernc.org/sqlite" // 纯 Go SQLite 驱动（免 CGO），内置 FTS5
)

// DB 封装索引数据库。
type DB struct {
	db *sql.DB
}

// Record 是一条待索引的笔记内容（均为原文）。
type Record struct {
	ID      string
	Title   string
	Content string
	Tags    string
}

// Hit 是一条搜索结果。
type Hit struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Snippet    string `json:"snippet"`
	Conflicted bool   `json:"conflicted"` // 内容含 git 冲突标记行（^<<<<<<< ）
}

// Open 打开（必要时创建）索引数据库并建表。
func Open(path string) (*DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)",
		filepath.ToSlash(path))
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// 单连接串行化：本地单用户服务没有并发吞吐需求；多连接并发写事务
	// 在 WAL 下仍可能偶发 database is locked（快照冲突），限 1 从根上消除
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		return nil, err
	}
	// *_tok 列存分词后的文本（可搜索），raw_* 列存原文（仅用于展示）
	_, err = db.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
		id UNINDEXED,
		title_tok,
		content_tok,
		tags_tok,
		raw_title UNINDEXED,
		raw_content UNINDEXED
	)`)
	if err != nil {
		return nil, fmt.Errorf("创建 FTS 表失败: %w", err)
	}
	return &DB{db: db}, nil
}

// Upsert 重建单条笔记的索引行（先删后插，保持简单可靠）。
func (d *DB) Upsert(r Record) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM notes_fts WHERE id = ?`, r.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO notes_fts
		(id, title_tok, content_tok, tags_tok, raw_title, raw_content)
		VALUES (?, ?, ?, ?, ?, ?)`,
		r.ID, tokenize(r.Title), tokenize(r.Content), tokenize(r.Tags),
		r.Title, r.Content); err != nil {
		return err
	}
	return tx.Commit()
}

// Delete 移除索引。
func (d *DB) Delete(id string) error {
	_, err := d.db.Exec(`DELETE FROM notes_fts WHERE id = ?`, id)
	return err
}

// Search 全文搜索（CJK 子串匹配）。FTS 查询为空或出错时退化为 LIKE。
func (d *DB) Search(query string, limit int) ([]Hit, error) {
	if limit <= 0 {
		limit = 50
	}
	terms := strings.Fields(query)
	if match := buildMatchQuery(query); match != "" {
		// 列权重（按建表列序 id,title_tok,content_tok,tags_tok,raw_*）：
		// 标题 10 > 标签 5 > 正文 1；UNINDEXED 列权重占位即可
		rows, err := d.db.Query(
			`SELECT id, raw_title, raw_content FROM notes_fts
			 WHERE notes_fts MATCH ?
			 ORDER BY bm25(notes_fts, 0, 10.0, 1.0, 5.0, 0, 0) LIMIT ?`, match, limit)
		if err == nil {
			hits, err := scanRaw(rows, terms)
			if err == nil {
				return hits, nil
			}
		}
	}
	// 退化：LIKE 模糊匹配（标题命中排前）
	like := "%" + strings.ReplaceAll(query, "%", "") + "%"
	rows, err := d.db.Query(
		`SELECT id, raw_title, raw_content FROM notes_fts
		 WHERE raw_title LIKE ? OR raw_content LIKE ?
		 ORDER BY (raw_title LIKE ?) DESC LIMIT ?`, like, like, like, limit)
	if err != nil {
		return nil, err
	}
	return scanRaw(rows, terms)
}

// buildMatchQuery 把用户输入分词后转义为安全的 FTS5 MATCH 表达式（空格即 AND）。
func buildMatchQuery(query string) string {
	words := strings.Fields(tokenize(query))
	if len(words) == 0 {
		return ""
	}
	for i, w := range words {
		w = strings.ReplaceAll(w, `"`, `""`)
		words[i] = `"` + w + `"`
	}
	return strings.Join(words, " ")
}

// tokenize 把文本转为可索引的词序列：
// 拉丁字母/数字保留整词（小写化），CJK 连续段拆成重叠二元组。
// 写入与查询使用同一函数，保证匹配一致。
func tokenize(text string) string {
	var tokens []string
	var latin []rune
	var cjk []rune

	flushLatin := func() {
		if len(latin) > 0 {
			tokens = append(tokens, strings.ToLower(string(latin)))
			latin = latin[:0]
		}
	}
	flushCJK := func() {
		if len(cjk) == 1 {
			tokens = append(tokens, string(cjk))
		}
		for i := 0; i+1 < len(cjk); i++ {
			tokens = append(tokens, string(cjk[i:i+2]))
		}
		cjk = cjk[:0]
	}

	for _, r := range text {
		switch {
		case isCJK(r):
			flushLatin()
			cjk = append(cjk, r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			flushCJK()
			latin = append(latin, r)
		default:
			flushLatin()
			flushCJK()
		}
	}
	flushLatin()
	flushCJK()
	return strings.Join(tokens, " ")
}

func isCJK(r rune) bool {
	return unicode.Is(unicode.Han, r) ||
		unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) ||
		unicode.Is(unicode.Hangul, r)
}

// scanRaw 读取查询结果并用原文生成摘要。
func scanRaw(rows *sql.Rows, terms []string) ([]Hit, error) {
	defer rows.Close()
	hits := []Hit{}
	for rows.Next() {
		var h Hit
		var raw string
		if err := rows.Scan(&h.ID, &h.Title, &raw); err != nil {
			return nil, err
		}
		h.Snippet = makeSnippet(raw, terms)
		h.Conflicted = hasConflictMarkers(raw)
		hits = append(hits, h)
	}
	return hits, rows.Err()
}

// hasConflictMarkers 报告内容是否含 git 冲突标记行（^<<<<<<< ）。
// 与 gitsync.HasConflictMarkers 同款逻辑（复刻以保持包间解耦）。
func hasConflictMarkers(content string) bool {
	return strings.HasPrefix(content, "<<<<<<< ") || strings.Contains(content, "\n<<<<<<< ")
}

// makeSnippet 从原文中提取命中片段：以首个命中词为锚点取短窗口（命中词放
// 窗口约 1/4 处）。窗口必须短——主界面摘要只有一行，窗口过长时命中词会
// 被 CSS 省略号截掉（曾出现命中词整词不可见的问题）。
func makeSnippet(raw string, terms []string) string {
	runes := []rune(raw)
	// rune 级对齐做大小写不敏感匹配：Go 的 ToLower 是 rune 1:1 映射，
	// lowerRunes 与 runes 等长，下标直接对齐（不会有 JS toLowerCase 的变长问题）
	lowerRunes := []rune(strings.ToLower(raw))
	pos, hitLen := -1, 0
	for _, t := range terms {
		tr := []rune(strings.ToLower(t))
		if i := runesIndex(lowerRunes, tr); i >= 0 && (pos < 0 || i < pos) {
			pos, hitLen = i, len(tr)
		}
	}
	const window = 22 // 窗口宽 ≈ 窄面板一行可视容量（12px 字号约 18-20 汉字）
	if pos < 0 {
		if len(runes) > window {
			return string(runes[:window]) + "…"
		}
		return raw
	}
	start := pos - window/4
	if start < 0 {
		start = 0
	}
	if pos+hitLen > start+window {
		start = pos // 命中词比窗口还长（超长拉丁词）：直接对齐其开头
	}
	end := start + window
	if end > len(runes) {
		end = len(runes)
		if start = end - window; start < 0 {
			start = 0
		}
	}
	snip := string(runes[start:end])
	if start > 0 {
		snip = "…" + snip
	}
	if end < len(runes) {
		snip += "…"
	}
	return snip
}

// runesIndex 返回 sub 在 s 中的首个 rune 下标（无则 -1）。
func runesIndex(s, sub []rune) int {
	if len(sub) == 0 || len(s) < len(sub) {
		return -1
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		match := true
		for j := range sub {
			if s[i+j] != sub[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

// Rebuild 清空并全量重建索引。
func (d *DB) Rebuild(records []Record) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM notes_fts`); err != nil {
		return err
	}
	for _, r := range records {
		if _, err := tx.Exec(`INSERT INTO notes_fts
			(id, title_tok, content_tok, tags_tok, raw_title, raw_content)
			VALUES (?, ?, ?, ?, ?, ?)`,
			r.ID, tokenize(r.Title), tokenize(r.Content), tokenize(r.Tags),
			r.Title, r.Content); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (d *DB) Close() error {
	return d.db.Close()
}
