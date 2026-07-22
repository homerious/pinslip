package storage

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ErrNotFound 表示指定 id 的笔记文件不存在。
var ErrNotFound = errors.New("note not found")

// Item 是一次文件遍历读到的笔记（含正文，用于索引重建）。
// Folder 是文件相对 notes/ 的子目录（"" 表示根目录或 inbox）。
type Item struct {
	FM     *Frontmatter
	Body   string
	Inbox  bool
	Folder string
}

// Engine 负责 notes/ 与 inbox/ 目录下笔记文件的读写，以及 attachments/ 附件的落盘。
// 本地文件是唯一事实来源，任何索引都可从它重建。
//
// 文件命名：<标题slug>-<id>.md（用户可直接浏览识别，id 保证唯一与可寻址）。
// 兼容旧命名 <id>.md：读取时自动定位，下次保存自动改名升级。
type Engine struct {
	notesDir  string
	inboxDir  string
	attachDir string
}

func NewEngine(notesDir, inboxDir, attachDir string) *Engine {
	return &Engine{notesDir: notesDir, inboxDir: inboxDir, attachDir: attachDir}
}

// FileNameFor 生成笔记文件名：<slug>-<创建日期yyyymmdd>-<id>.md
// 日期取创建时间（稳定不变），标题浏览友好 + 时间可辨 + id 唯一。
// createdAt 为 RFC3339；为空或解析失败时省略日期段。
func FileNameFor(id, title, createdAt string) string {
	slug := Slugify(title)
	if slug == "" {
		slug = "未命名"
	}
	date := ""
	if t, err := time.Parse(time.RFC3339, createdAt); err == nil {
		date = "-" + t.Format("20060102")
	}
	return slug + date + "-" + id + ".md"
}

// Slugify 把标题清理为安全的文件名片段：
// 去掉 Windows 非法字符 \/:*?"<>| 与控制字符，去首尾空格/点，截断 30 字符。
func Slugify(title string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(title) {
		if strings.ContainsRune(`\/:*?"<>|`, r) || r < 0x20 {
			continue
		}
		b.WriteRune(r)
	}
	s := strings.Trim(b.String(), " .")
	runes := []rune(s)
	if len(runes) > 30 {
		s = string(runes[:30])
	}
	return strings.TrimSpace(s)
}

// folderOf 计算文件相对 notes/ 的子目录（统一为正斜杠；根目录返回 ""）。
func (e *Engine) folderOf(filePath string) string {
	rel, err := filepath.Rel(e.notesDir, filepath.Dir(filePath))
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return ""
	}
	return filepath.ToSlash(rel)
}

// Locate 按 id 定位文件：notes/ 递归扫描 -<id>.md 后缀（兼容旧命名 <id>.md），
// inbox/ 保持扁平只扫顶层。
func (e *Engine) Locate(id string) (string, bool, error) {
	suffix := "-" + id + ".md"
	legacy := id + ".md"
	var match, legacyMatch string
	_ = filepath.Walk(e.notesDir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		name := info.Name()
		if strings.HasSuffix(name, suffix) {
			if match == "" {
				match = p
			}
		} else if name == legacy && legacyMatch == "" {
			legacyMatch = p
		}
		return nil
	})
	if match != "" {
		return match, false, nil
	}
	if legacyMatch != "" {
		return legacyMatch, false, nil
	}
	// inbox 扁平
	entries, err := os.ReadDir(e.inboxDir)
	if err == nil {
		for _, entry := range entries {
			if !entry.IsDir() && (strings.HasSuffix(entry.Name(), suffix) || entry.Name() == legacy) {
				return filepath.Join(e.inboxDir, entry.Name()), true, nil
			}
		}
	}
	return "", false, ErrNotFound
}

// Save 原子写入笔记文件（先写临时文件再改名）。
// 若旧文件存在且路径变化（标题改动/旧命名/跨目录移动），写入成功后删除旧文件。
// 目录决策：inbox=true → inboxDir；已存在于 notes/（含子文件夹）→ 留在原目录；
// 否则新建到 notes/ 根目录。
func (e *Engine) Save(fm *Frontmatter, body string, inbox bool) error {
	return e.save(fm, body, inbox, "")
}

// SaveToFolder 新建便签落盘到指定文件夹（目录不存在自动创建，路径走 ValidateFolder）。
// 仅新建生效：已存在的便签位置由 Locate 保留，folder 被忽略（移动请用 Move）。
func (e *Engine) SaveToFolder(fm *Frontmatter, body, folder string) error {
	if err := ValidateFolder(folder); err != nil {
		return err
	}
	return e.save(fm, body, false, folder)
}

func (e *Engine) save(fm *Frontmatter, body string, inbox bool, folder string) error {
	oldPath, oldInbox, locErr := e.Locate(fm.ID)

	var dir string
	switch {
	case inbox:
		dir = e.inboxDir
	case locErr == nil && !oldInbox:
		dir = filepath.Dir(oldPath) // 保留所在子文件夹
	case folder != "":
		dir = filepath.Join(e.notesDir, filepath.FromSlash(folder))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	default:
		dir = e.notesDir
	}
	data, err := MarshalNote(fm, body)
	if err != nil {
		return err
	}
	final := filepath.Join(dir, FileNameFor(fm.ID, fm.Title, fm.CreatedAt))
	// 临时文件名带纳秒时间戳：同一便签的并发保存（如编辑防抖与成组回写
	// 撞在一起）各用各的 tmp，不会互相改名抢走导致 "file not found"
	tmp := fmt.Sprintf("%s.%d.tmp", final, time.Now().UnixNano())
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	// Windows 上目标文件可能被外部程序（Obsidian/索引器/杀软）短暂占用，
	// rename 失败多为瞬时——小退避重试几次，通常能自愈；仍失败则清理 tmp
	var renErr error
	for attempt := 0; attempt < 4; attempt++ {
		if renErr = os.Rename(tmp, final); renErr == nil {
			break
		}
		time.Sleep(time.Duration(40*(attempt+1)) * time.Millisecond)
	}
	if renErr != nil {
		_ = os.Remove(tmp)
		return renErr
	}
	if locErr == nil && oldPath != final {
		_ = os.Remove(oldPath)
	}
	return nil
}

// Load 按 id 读取笔记，返回 frontmatter、正文、是否在 inbox、所在子文件夹（相对 notes/）。
func (e *Engine) Load(id string) (*Frontmatter, string, bool, string, error) {
	p, inbox, err := e.Locate(id)
	if err != nil {
		return nil, "", false, "", err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, "", false, "", err
	}
	fm, body, err := ParseNote(data)
	if err != nil {
		return nil, "", false, "", fmt.Errorf("解析 %s 失败: %w", p, err)
	}
	folder := ""
	if !inbox {
		folder = e.folderOf(p)
	}
	return fm, body, inbox, folder, nil
}

// Delete 按 id 删除笔记文件。
func (e *Engine) Delete(id string) error {
	p, _, err := e.Locate(id)
	if err != nil {
		return err
	}
	return os.Remove(p)
}

// 允许的附件扩展名（图片粘贴场景，MIME 不可信，只认扩展名白名单）
var attachExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
}

// SaveAttachment 把附件字节写入 attachments/ 目录，返回 vault 相对路径（attachments/<name>）。
// 文件名：att-<时间戳>-<随机4位hex><ext>，可读且防撞名。
func (e *Engine) SaveAttachment(ext string, data []byte) (string, error) {
	ext = strings.ToLower(ext)
	if !attachExts[ext] {
		return "", fmt.Errorf("不支持的附件类型 %q", ext)
	}
	rand4 := make([]byte, 2)
	if _, err := rand.Read(rand4); err != nil {
		return "", err
	}
	name := fmt.Sprintf("att-%s-%s%s", time.Now().Format("20060102-150405"), hex.EncodeToString(rand4), ext)
	if err := os.MkdirAll(e.attachDir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(e.attachDir, name), data, 0o644); err != nil {
		return "", err
	}
	return "attachments/" + name, nil
}

// List 遍历 notes/（递归子文件夹）与 inbox/（仅顶层），读取全部笔记（含正文）。
func (e *Engine) List() ([]Item, error) {
	var items []Item
	// notes/ 递归
	err := filepath.Walk(e.notesDir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // 单个路径失败不阻塞整体列表
		}
		if info.IsDir() || !strings.HasSuffix(info.Name(), ".md") {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		fm, body, err := ParseNote(data)
		if err != nil {
			return nil
		}
		items = append(items, Item{FM: fm, Body: body, Inbox: false, Folder: e.folderOf(p)})
		return nil
	})
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	// inbox/ 扁平
	entries, err := os.ReadDir(e.inboxDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(e.inboxDir, entry.Name()))
		if err != nil {
			continue
		}
		fm, body, err := ParseNote(data)
		if err != nil {
			continue
		}
		items = append(items, Item{FM: fm, Body: body, Inbox: true})
	}
	return items, nil
}

// ValidateFolder 校验文件夹相对路径（正斜杠分隔，"" 表示根目录）。
// 拒绝目录穿越（..）、空段、Windows 非法字符与结尾空格/点，保证路径安全。
func ValidateFolder(path string) error {
	if path == "" {
		return nil
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return fmt.Errorf("非法文件夹路径 %q", path)
		}
		if strings.ContainsAny(seg, `\:*?"<>|`) {
			return fmt.Errorf("文件夹名含非法字符 %q", seg)
		}
		if strings.HasSuffix(seg, " ") || strings.HasSuffix(seg, ".") {
			return fmt.Errorf("文件夹名不能以空格或点结尾 %q", seg)
		}
	}
	return nil
}

// CreateFolder 在 notes/ 下创建（嵌套）文件夹，已存在时为空操作。
func (e *Engine) CreateFolder(path string) error {
	if err := ValidateFolder(path); err != nil {
		return err
	}
	if path == "" {
		return nil
	}
	return os.MkdirAll(filepath.Join(e.notesDir, filepath.FromSlash(path)), 0o755)
}

// RenameFolder 重命名文件夹（同级改名，newName 为单段名称，不含层级）。
// 便签随目录走（文件夹即物理位置），id 不变、索引无需动；
// 目标名已存在或源不存在时报错。
func (e *Engine) RenameFolder(path, newName string) error {
	if err := ValidateFolder(path); err != nil {
		return err
	}
	if path == "" {
		return errors.New("不能重命名根目录")
	}
	if err := ValidateFolder(newName); err != nil {
		return err
	}
	if strings.Contains(newName, "/") {
		return fmt.Errorf("新名称不能含层级 %q", newName)
	}
	old := filepath.Join(e.notesDir, filepath.FromSlash(path))
	if info, err := os.Stat(old); err != nil || !info.IsDir() {
		return fmt.Errorf("文件夹不存在 %q", path)
	}
	newRel := newName
	if i := strings.LastIndex(path, "/"); i >= 0 {
		newRel = path[:i+1] + newName // 同级目录下改名
	}
	dst := filepath.Join(e.notesDir, filepath.FromSlash(newRel))
	if _, err := os.Stat(dst); err == nil {
		return fmt.Errorf("目标文件夹已存在 %q", newRel)
	}
	return os.Rename(old, dst)
}

// noteIDFromFileName 从笔记文件名解析 id：新命名 <slug>-<date>-<id>.md 取末段，
// 旧命名 <id>.md 整名即 id；非 .md 返回 false。
func noteIDFromFileName(name string) (string, bool) {
	if !strings.HasSuffix(name, ".md") {
		return "", false
	}
	stem := strings.TrimSuffix(name, ".md")
	if i := strings.LastIndex(stem, "-"); i >= 0 && i+1 < len(stem) {
		return stem[i+1:], true
	}
	return stem, true
}

// DeleteFolder 删除文件夹（仅 notes/ 内，path 非空）。两种模式：
//   - "move"（默认）：子树内便签全部移到根目录（复用 Move，含附件前缀重写），
//     随后删除空文件夹；含非笔记文件（非 .md）时拒绝执行，防止误删用户数据
//   - "trash"：整个文件夹移到 vault 的 .trash/<时间戳>-<名称>/（可手动找回的
//     后悔药，不经过 Windows 回收站），返回其中便签 id 列表供调用方清索引
//
// 返回 trash 模式移除的便签 id；move 模式恒为空（id 不变，索引无需动）。
func (e *Engine) DeleteFolder(path, mode string) ([]string, error) {
	if err := ValidateFolder(path); err != nil {
		return nil, err
	}
	if path == "" {
		return nil, errors.New("不能删除根目录")
	}
	dir := filepath.Join(e.notesDir, filepath.FromSlash(path))
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("文件夹不存在 %q", path)
	}

	// 收集子树内的便签 id（.md）与非笔记文件
	var ids []string
	var foreign []string
	if err := filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err != nil || fi.IsDir() {
			return nil
		}
		if id, ok := noteIDFromFileName(fi.Name()); ok {
			ids = append(ids, id)
		} else {
			foreign = append(foreign, p)
		}
		return nil
	}); err != nil {
		return nil, err
	}

	if mode == "trash" {
		trashDir := e.trashDir()
		if err := os.MkdirAll(trashDir, 0o755); err != nil {
			return nil, err
		}
		dst := filepath.Join(trashDir,
			time.Now().Format("20060102-150405")+"-"+filepath.Base(dir))
		if err := os.Rename(dir, dst); err != nil {
			return nil, err
		}
		return ids, nil
	}

	// move 模式：先拒非笔记文件，再便签上移根目录，最后删空目录
	if len(foreign) > 0 {
		return nil, fmt.Errorf("含 %d 个非笔记文件，拒绝删除（请先到文件管理器处理）", len(foreign))
	}
	for _, id := range ids {
		if err := e.Move(id, ""); err != nil {
			return nil, err
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		return nil, err
	}
	return nil, nil
}

// ListFolders 返回 notes/ 下全部子文件夹（相对路径，正斜杠分隔，字典序）。
func (e *Engine) ListFolders() ([]string, error) {
	folders := []string{}
	err := filepath.Walk(e.notesDir, func(p string, info os.FileInfo, err error) error {
		if err != nil || !info.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(e.notesDir, p)
		if relErr == nil && rel != "." && !strings.HasPrefix(rel, "..") {
			folders = append(folders, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	sort.Strings(folders)
	return folders, nil
}

// attachPrefixRe 匹配正文里附件引用的 ../ 前缀段（attachments/ 前的任意深度 ../）。
var attachPrefixRe = regexp.MustCompile(`(?:\.\./)+attachments/`)

// folderDepth 计算笔记相对路径前缀深度：根目录/inbox 为 1（attachments 在 vault 根，
// 与 notes、inbox 同级），子文件夹每深一层 +1。
func folderDepth(folder string) int {
	if folder == "" {
		return 1
	}
	return len(strings.Split(folder, "/")) + 1
}

// Move 把笔记移动到 notes/ 下的指定文件夹（"" 表示根目录），保持文件名不变。
// 目标文件夹不存在时自动创建；从 inbox 移出即脱离速记身份。
// 深度变化时同步重写正文里的附件相对路径前缀（../attachments/…），
// 保证 Obsidian 等外部查看器按新位置仍能解析图片。
func (e *Engine) Move(id, folder string) error {
	if err := ValidateFolder(folder); err != nil {
		return err
	}
	p, inbox, err := e.Locate(id)
	if err != nil {
		return err
	}
	dstDir := filepath.Join(e.notesDir, filepath.FromSlash(folder))
	if filepath.Dir(p) == dstDir {
		return nil
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return err
	}
	dst := filepath.Join(dstDir, filepath.Base(p))
	if err := os.Rename(p, dst); err != nil {
		return err
	}
	// 深度不变（平级移动/inbox 移出到根目录）无需重写
	oldDepth := 1
	if !inbox {
		oldDepth = folderDepth(e.folderOf(p))
	}
	if newDepth := folderDepth(folder); newDepth != oldDepth {
		data, err := os.ReadFile(dst)
		if err != nil {
			return err
		}
		prefix := []byte(strings.Repeat("../", newDepth) + "attachments/")
		if rewritten := attachPrefixRe.ReplaceAll(data, prefix); !bytes.Equal(rewritten, data) {
			if err := os.WriteFile(dst, rewritten, 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}
