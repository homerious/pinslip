// Package notes 是笔记领域包：业务逻辑与 HTTP 接口。
package notes

import "time"

// Note 是完整笔记（对应 docs/api.md 的 Note）。
type Note struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	Tags      []string  `json:"tags"`
	Source    string    `json:"source"`
	Pin       bool     `json:"pin"`
	Color     string   `json:"color"`
	Collapsed bool     `json:"collapsed"` // 折叠成标题条
	Group     string   `json:"group"`     // 所属便签组 id（"" = 不属于任何组）
	Inbox     bool     `json:"inbox"`
	Folder    string   `json:"folder"` // notes/ 下的相对子目录，"" 为根目录
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Meta 是列表项（不含正文）。
type Meta struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Tags       []string  `json:"tags"`
	Source     string    `json:"source"`
	Pin        bool      `json:"pin"`
	Color      string    `json:"color"`
	Collapsed  bool      `json:"collapsed"`
	Group      string    `json:"group"` // 所属便签组 id（"" = 不属于任何组）
	Inbox      bool      `json:"inbox"`
	Folder     string    `json:"folder"`
	WordCount  int       `json:"wordCount"`
	Conflicted bool      `json:"conflicted"` // 内容含 git 冲突标记行（^<<<<<<< ）
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// MoveInput 是 POST /api/notes/{id}/move 的请求体。
type MoveInput struct {
	Folder string `json:"folder"` // 目标文件夹（notes/ 相对路径，"" 为根目录）
}

// CreateFolderInput 是 POST /api/folders 的请求体。
type CreateFolderInput struct {
	Path string `json:"path"` // 新建文件夹（notes/ 相对路径，支持嵌套 a/b/c）
}

// SaveInput 是 PUT /api/notes/{id} 的请求体。
// 所有字段均可选：未提供的字段保留原值（部分更新）。
// content 为 nil 时保留原有正文（可用于单独更新 pin/tags 等元数据）。
type SaveInput struct {
	Content   *string  `json:"content,omitempty"`
	Title     string   `json:"title,omitempty"`
	Tags      []string `json:"tags,omitempty"`
	Pin       *bool    `json:"pin,omitempty"`
	Source    string   `json:"source,omitempty"`
	Color     string   `json:"color,omitempty"`     // 空字符串 = 保留原色
	Collapsed *bool    `json:"collapsed,omitempty"` // nil = 保留原折叠状态
	Group     *string  `json:"group,omitempty"`     // nil = 保留原便签组（"" = 移出组）
	Folder    *string  `json:"folder,omitempty"`    // 仅新建时生效：落盘目录；已存在便签忽略（移动走 move API）
}

// RenameFolderInput 是 POST /api/folders/rename 的请求体。
type RenameFolderInput struct {
	Path string `json:"path"` // 目标文件夹（notes/ 相对路径，非空）
	Name string `json:"name"` // 新名称（单段，不含层级）
}

// DeleteFolderInput 是 POST /api/folders/delete 的请求体。
type DeleteFolderInput struct {
	Path string `json:"path"` // 目标文件夹（notes/ 相对路径，非空）
	Mode string `json:"mode"` // "move"（默认，便签移到根目录）/ "trash"（连同便签移入 .trash）
}

// QuickInput 是 POST /api/notes/quick 的请求体。
type QuickInput struct {
	Content string `json:"content"`
}

// TrashStats 是 GET /api/trash/stats 的响应体。
type TrashStats struct {
	Count int   `json:"count"` // 顶层条目数（每条 = 一次删除的文件夹）
	Bytes int64 `json:"bytes"` // 全部文件大小合计
}
