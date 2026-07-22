# PinSlip 本地服务 API 契约

Go 服务（`pinslipd`）监听 `127.0.0.1:<随机端口>`，只绑定回环地址。
Electron 主进程拉起服务后从 stdout 解析 `PINSLIP_PORT=<port>`，渲染进程经 IPC 获取端口。
所有请求/响应均为 JSON；错误统一为 `{ "error": "message" }`。

## 数据模型

```jsonc
// Note（完整）
{
  "id": "9f2c1a4b7e3d4f01",
  "title": "会议记录",
  "content": "# 会议记录\n\n正文 Markdown",
  "tags": ["work"],
  "source": "sticky",        // sticky / editor / quick / mcp
  "pin": false,
  "color": "yellow",         // yellow / pink / green / blue / purple / orange，缺省 yellow
  "collapsed": false,        // true = 折叠成标题条（窗口只显示标题栏，主进程按此恢复窗口高度）
  "group": "g-a1b2",         // 所属便签组 id（"" = 不属于任何组；组定义见 .pinslip/groups.json）
  "inbox": false,            // true = 收件箱（速记产生）
  "folder": "工作/项目A",     // notes/ 下的相对子目录（正斜杠分隔），"" 为根目录
  "createdAt": "2026-07-17T09:30:00+08:00",
  "updatedAt": "2026-07-17T10:22:00+08:00"
}

// NoteMeta（列表项，无 content，多 wordCount）
{ "id": "...", "title": "...", "tags": [], "source": "sticky",
  "pin": false, "color": "yellow", "collapsed": false, "group": "g-a1b2",
  "inbox": false, "folder": "工作/项目A",
  "wordCount": 128, "createdAt": "...", "updatedAt": "..." }

// GroupRegistry（便签组注册表，存 <vault>/.pinslip/groups.json；
// members 数组顺序即组内叠放顺序）
{ "groups": [ { "id": "g-a1b2", "members": ["noteId1", "noteId2"] } ] }

// SearchHit（snippet 为纯文本摘要：命中锚定短窗口，首尾补 …；
// 高亮由前端按查询词自行标记，不在服务端做）
{ "id": "...", "title": "...", "snippet": "…命中关键词的上下文…" }
```

## 接口

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| GET | `/health` | 健康检查 | — | `{ "status": "ok", "version": "0.1.0" }` |
| GET | `/api/notes` | 列出全部笔记元数据（含 inbox） | — | `NoteMeta[]` |
| GET | `/api/notes/{id}` | 读取单条笔记 | — | `Note`，404 = 不存在 |
| PUT | `/api/notes/{id}` | 创建或更新（upsert + 部分更新，id 由客户端生成） | `{ content?, title?, tags?, pin?, source?, color?, collapsed?, group?, folder? }` | `Note` |
| DELETE | `/api/notes/{id}` | 删除笔记：移入回收区（可找回）并清出索引 | — | `{ "status": "ok" }` |
| GET | `/api/notes/search?q=...` | 全文搜索（FTS5，CJK bigram；bm25 列权重 标题10>标签5>正文1） | — | `SearchHit[]` |
| POST | `/api/notes/quick` | 速记：写入 inbox | `{ "content": "..." }` | `Note` |
| POST | `/api/notes/{id}/move` | 移动笔记到文件夹（保持文件名，目标自动创建） | `{ "folder": "a/b" }`（"" = 根目录） | `{ "status": "ok" }` |
| GET | `/api/folders` | 列出 notes/ 下全部子文件夹（递归，字典序） | — | `{ "folders": ["工作", "工作/项目A"] }` |
| POST | `/api/folders` | 新建（嵌套）文件夹 | `{ "path": "工作/项目A" }` | `{ "status": "ok" }` |
| POST | `/api/folders/rename` | 重命名文件夹（同级改名，便签随目录走、索引不动） | `{ "path": "工作/项目A", "name": "项目B" }` | `{ "status": "ok" }` |
| POST | `/api/folders/delete` | 删除文件夹（两种模式，见下） | `{ "path": "工作", "mode": "move" }` | `{ "status": "ok" }` |
| GET | `/api/trash/stats` | 回收区占用统计 | — | `{ "count": 2, "bytes": 15360 }` |
| POST | `/api/trash/empty` | 清空回收区（物理删除 .trash，不进系统回收站） | — | `{ "status": "ok" }` |
| GET | `/api/settings` | 读取 vault 设置（缺失返回默认值） | — | `{ "trashRetentionDays": 30 }` |
| PUT | `/api/settings` | 写回 vault 设置 | `{ "trashRetentionDays": 7 }` | `{ "status": "ok" }` |
| GET | `/api/groups` | 读取便签组注册表（文件缺失返回空表） | — | `GroupRegistry` |
| PUT | `/api/groups` | 整体替换便签组注册表 | `GroupRegistry` | `{ "status": "ok" }` |
| POST | `/api/attachments?ext=.png` | 上传图片到 vault `attachments/`（白名单 png/jpg/gif/webp） | raw 图片字节（非 JSON） | `{ "path": "attachments/att-..." }` |

### 文件夹约定

- 文件夹即物理目录：笔记的 folder 由文件位置推导，不进 frontmatter；移动笔记 = 移动文件。
- 路径校验：拒绝 `..`、空段、`\:*?"<>|` 非法字符与结尾空格/点（防目录穿越）。
- `inbox/` 保持扁平，不支持子文件夹；把速记移入文件夹即脱离 inbox 身份。
- 新建便签可带 `folder` 指定落盘目录（目录自动创建）；已存在便签传 `folder`
  会被忽略（保留原位置），换位置必须走 move。
- 重命名 = 同级目录改名（`os.Rename`）：便签随目录走，id 不变、索引无需动；
  拒绝根目录/含层级名/目标已存在。
- 删除文件夹两种模式：`move`（默认）子树内便签全部移到根目录（复用 move，
  含附件前缀重写），随后删空目录——**含非 .md 文件时拒绝执行**（防误删用户数据）；
  `trash` 整树移入回收区，其中便签从索引移除。

### 回收区约定

- 回收区 = `<vault>/.trash/`（与 notes/ 同级）。**所有用户删除入口统一经过回收区**：
  单条便签删除（主界面列表/便签窗口）与文件夹 trash 删除都移到这里，
  物理删除只发生在 清空回收区/自动清理 时。
- trash 条目命名为 `<删除时刻yyyymmdd-HHMMSS>-<原名>`：文件夹是目录条目，
  单条便签是 `.md` 文件条目（文件名内含 id，天然防撞名）；时间戳前缀是
  自动清理判龄的依据。便签附件留在共享 `attachments/` 不动。
- 找回：把条目从 `.trash/` 拖回 `notes/` 即可，watcher 全量扫描会自动重建索引。
- 自动清理：服务启动时执行一次，删除超过 `trashRetentionDays` 天的条目；
  无前缀条目（用户手动丢入）回退按修改时间判龄；`<= 0` = 不清理。
- 清空回收区是物理删除（`os.RemoveAll`），不经过系统回收站，UI 需二次确认。
- `count` 统计顶层条目数（文件夹/便签各算一条），`bytes` 为全部文件合计。

### vault 设置

- 存 `<vault>/.pinslip/settings.json`（与 pinslip.db 同目录，不污染 notes/）：
  `{ "trashRetentionDays": 30 }`。文件缺失或损坏时读回默认值；每个 vault 各自独立。

### 便签组

- 几张便签组成一组竖向叠放。**成员关系记在便签 frontmatter**：`group: <groupId>`
  （空/缺省 = 不属于任何组），随便签文件走，部分更新语义与 `collapsed` 一致
  （PUT 不传 `group` 保留原值，传 `""` 移出组）。
- **组注册表**存 `<vault>/.pinslip/groups.json`（与 settings.json 同级）：
  `{ "groups": [{ "id": "g-a1b2", "members": ["noteId1", "noteId2"] }] }`，
  `members` 数组顺序即组内叠放顺序。文件缺失或损坏时读回空注册表。
- `PUT /api/groups` 是**整体替换**（body 即注册表 JSON），增删组、调序、
  拖拽换位都由调用方改完整个注册表后一次性写回。
- groupId 由调用方（Electron 端）生成，Go 侧只做存储透传，不校验格式。

## 约定

- **id 由客户端生成**（Electron 主进程 `crypto.randomUUID()`），PUT 幂等 upsert，
  这样窗口创建时就能确定 id，无需等待服务端返回。
- **PUT 是部分更新**：所有字段均可选，未提供的字段保留原值。
  例如只传 `{ "pin": true }` 可单独切换置顶，正文和标题不受影响。
- 标题留空时服务端自动从内容推导：首个有效行剥离 markdown 结构标记
  （标题/引用/列表/任务框/整行行内包装/整行链接图片）后截断 30 字——
  与渲染端 `NoteView.deriveTitle` 同算法，**改动必须双端同步**（Go 侧有 `TestDeriveTitle`）。
- **文件命名**：`<标题slug>-<创建日期yyyymmdd>-<id>.md`——slug 为用户可读的标题
  （清理 `\/:*?"<>|` 等非法字符，截断 30 字符），日期取创建时间（稳定不变），
  id 保证唯一；标题变化时文件自动重命名。
  兼容旧命名 `<id>.md`：可读，保存后自动升级为新命名。
- 图片引用写**相对笔记文件**的路径：`../` × (folder 深度 + 1) + `attachments/xxx`，
  任何 markdown 查看器可解析；移动笔记时服务端按新深度重写前缀。
- 本地文件是唯一事实来源（`notes/` 与 `inbox/` 下），SQLite 只是索引；
  服务启动时全量重建索引。
