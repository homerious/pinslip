# PinSlip 本地服务 API 契约

Go 服务（`pinslipd`）只绑定回环地址 `127.0.0.1`：**优先监听知名端口 17639**
（浏览器插件按固定地址探测），被占用时回退随机端口。
Electron 主进程拉起服务后从 stdout 解析 `PINSLIP_PORT=<port>`（该格式是对外约定），
渲染进程经 IPC 获取端口；端口同时写入临时文件作为备用发现途径。
所有请求/响应均为 JSON（附件上传的请求体除外）；错误统一为 `{ "error": "message" }`，
需要客户端映射文案的错误附稳定 `code` 字段（`message` 保留原文作兜底展示）。
HTTP 层允许任意来源跨域，并响应 Chrome 私有网络访问（PNA）预检——浏览器插件
正是经此从网页上下文直连本地服务。

## 数据模型

```jsonc
// Note（完整）
{
  "id": "9f2c1a4b7e3d4f01",
  "title": "会议记录",
  "titleManual": false,      // true = 用户手动重命名（frontmatter title_manual），正文保存不再自动推导标题
  "content": "# 会议记录\n\n正文 Markdown",
  "tags": ["work"],
  "source": "sticky",        // sticky / editor / quick / mcp / web-clip（自由字符串）
  "pin": false,
  "color": "yellow",         // yellow / pink / green / blue / purple / orange，缺省 yellow
  "collapsed": false,        // true = 折叠成标题条（窗口只显示标题栏，主进程按此恢复窗口高度）
  "zoom": 1.3,               // 内容缩放倍率（1.3 = 130%；缺省/omitted = 100%）
  "group": "g-a1b2",         // 所属便签组 id（"" = 不属于任何组；组定义见 .pinslip/groups.json）
  "inbox": false,            // true = 收件箱（速记产生），由文件位置推导
  "folder": "工作/项目A",     // notes/ 下的相对子目录（正斜杠分隔），"" 为根目录，由文件位置推导
  "createdAt": "2026-07-17T09:30:00+08:00",
  "updatedAt": "2026-07-17T10:22:00+08:00"
}

// NoteMeta（列表项，无 content，多 wordCount / excerpt / conflicted）
{ "id": "...", "title": "...", "tags": [], "source": "sticky",
  "pin": false, "color": "yellow", "collapsed": false, "group": "g-a1b2",
  "inbox": false, "folder": "工作/项目A",
  "wordCount": 128,          // 正文字符数
  "excerpt": "正文纯文本摘要…", // 列表预览用
  "conflicted": false,        // 正文含 git 冲突标记行（^<<<<<<<）
  "createdAt": "...", "updatedAt": "..." }

// GroupRegistry（便签组注册表，存 <vault>/.pinslip/groups.json；
// members 数组顺序即组内叠放顺序；name 可选）
{ "groups": [ { "id": "g-a1b2", "members": ["noteId1", "noteId2"], "name": "项目组" } ] }

// SearchHit（snippet 为纯文本摘要：命中锚定短窗口，首尾补 …；
// 高亮由前端按查询词自行标记，不在服务端做）
{ "id": "...", "title": "...", "snippet": "…命中关键词的上下文…", "conflicted": false }

// 错误（code 为稳定契约，客户端按 code 映射文案；无 code 时省略）
{ "error": "笔记不存在", "code": "NOTE_NOT_FOUND" }
```

## 接口

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| GET | `/health` | 健康检查 | — | `{ "status": "ok", "version": "1.0.1" }` |
| GET | `/api/health` | 身份握手（浏览器插件探测用） | — | `{ "app": "pinslip", "version": "1.0.1" }` |
| GET | `/api/notes` | 列出全部笔记元数据（含 inbox） | — | `NoteMeta[]` |
| GET | `/api/notes/{id}` | 读取单条笔记 | — | `Note`，404 + `NOTE_NOT_FOUND` = 不存在 |
| PUT | `/api/notes/{id}` | 创建或更新（upsert + 部分更新，id 由客户端生成） | `{ content?, title?, titleManual?, tags?, pin?, source?, color?, collapsed?, zoom?, group?, folder?, inbox? }` | `Note` |
| DELETE | `/api/notes/{id}` | 删除笔记：移入回收区（可找回）并清出索引 | — | `{ "status": "ok" }` |
| GET | `/api/notes/search?q=...&limit=N` | 全文搜索（FTS5，CJK bigram；bm25 列权重 标题10>标签5>正文1；limit <=0 或缺省 = 50） | — | `SearchHit[]` |
| POST | `/api/notes/quick` | 速记：写入 inbox（落点模式见「速记」节） | `{ "content": "..." }` | `Note` |
| POST | `/api/notes/{id}/move` | 移动笔记到文件夹（保持文件名，目标自动创建） | `{ "folder": "a/b" }`（"" = 根目录） | `{ "status": "ok" }` |
| GET | `/api/folders` | 列出 notes/ 下全部子文件夹（递归，字典序） | — | `{ "folders": ["工作", "工作/项目A"] }` |
| POST | `/api/folders` | 新建（嵌套）文件夹 | `{ "path": "工作/项目A" }` | `{ "status": "ok" }` |
| POST | `/api/folders/rename` | 重命名文件夹（同级改名，便签随目录走、索引不动） | `{ "path": "工作/项目A", "name": "项目B" }` | `{ "status": "ok" }` |
| POST | `/api/folders/delete` | 删除文件夹（两种模式，见下） | `{ "path": "工作", "mode": "move" }` | `{ "status": "ok" }` |
| GET | `/api/trash/stats` | 回收区占用统计 | — | `{ "count": 2, "bytes": 15360 }` |
| POST | `/api/trash/empty` | 清空回收区（物理删除 .trash，不进系统回收站） | — | `{ "status": "ok" }` |
| GET | `/api/settings` | 读取 vault 设置（缺失返回默认值） | — | `Settings`（见「vault 设置」节） |
| PUT | `/api/settings` | 写回 vault 设置（部分更新） | `{ "trashRetentionDays": 7 }` | `{ "status": "ok" }` |
| GET | `/api/groups` | 读取便签组注册表（文件缺失返回空表） | — | `GroupRegistry` |
| PUT | `/api/groups` | 整体替换便签组注册表 | `GroupRegistry` | `{ "status": "ok" }` |
| POST | `/api/attachments?ext=.png` | 上传图片到 vault `attachments/`（白名单 .png/.jpg/.jpeg/.gif/.webp） | raw 图片字节（非 JSON） | `{ "path": "attachments/att-..." }` |
| GET | `/api/sync/status` | git 同步状态（不含 token） | — | `SyncStatus`（见「git 同步」节） |
| PUT | `/api/sync/config` | 配置同步仓库/凭证/分支/开关，触发首次接入 | `SyncConfig` | `SyncStatus` |
| DELETE | `/api/sync/config` | 停用同步（保留 .git 与已存凭证） | — | `{ "status": "ok" }` |
| POST | `/api/sync/now` | 立即同步一轮（commit+pull+push） | — | `SyncStatus` |
| POST | `/api/sync/resolve` | 分叉人工接管（`{strategy:"local"\|"remote"}`，前置校验失败 400） | `{strategy}` | `SyncStatus` |
| * | `/mcp` | MCP 端点（Streamable HTTP，供 AI agent 接入；可用 `mcpEnabled` 关闭） | MCP 协议 | 见 `skills/pinslip/SKILL.md` |

### 文件夹约定

- 文件夹即物理目录：笔记的 folder 由文件位置推导，不进 frontmatter；移动笔记 = 移动文件。
- 路径校验：拒绝 `..`、`.`、空段、`\:*?"<>|` 非法字符与结尾空格/点（防目录穿越）。
- `inbox/` 保持扁平，不支持子文件夹；把速记移入文件夹即脱离 inbox 身份。
- 新建便签可带 `folder` / `inbox` 指定落盘位置（目录自动创建，同时给出时 `folder` 优先）；
  已存在便签传这两个字段会被忽略（保留原位置），换位置必须走 move。
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
- `count` 统计顶层条目数（文件夹/便签各算一条），`bytes` 为全部文件合计；
  回收区不存在时 stats 返回零值而非错误。

### vault 设置

- 存 `<vault>/.pinslip/settings.json`（与 pinslip.db 同目录，不污染 notes/），
  每个 vault 各自独立；文件缺失或损坏时读回默认值。
- 字段：

```jsonc
{
  "trashRetentionDays": 30,        // 回收区保留天数；<= 0 = 不自动清理
  "mcpEnabled": true,              // /mcp 端点开关；缺省（不写）= 开启，仅显式 false 关闭
  "quickCaptureMode": "note",      // 速记落点：note（默认）逐条 / daily 聚合，见「速记」节
  "quickCaptureClipboard": true    // 速记窗口唤起时预填剪贴板；缺省 = 开启
}
```

- `PUT /api/settings` 是**部分更新**：未提供的字段保留磁盘现值
  （可选字段以指针/空串区分「未设置」），不会把其他字段抹回缺省。

### 速记

- `POST /api/notes/quick` 落点由 `quickCaptureMode` 决定：
  - `note`（默认）：逐条新建 `source: "quick"` 的收件箱便签。
  - `daily`：聚合到标题为「速记 YYYY-MM-DD」的收件箱便签——不存在则新建，
    存在则按「`### HH:mm` 小标题 + 空行 + 内容」追加条目，条目间空行分隔。
- content 为空返回 400，不落盘任何文件。

### 便签组

- 几张便签组成一组竖向叠放。**成员关系记在便签 frontmatter**：`group: <groupId>`
  （空/缺省 = 不属于任何组），随便签文件走，部分更新语义与 `collapsed` 一致
  （PUT 不传 `group` 保留原值，传 `""` 移出组）。
- **组注册表**存 `<vault>/.pinslip/groups.json`（与 settings.json 同级）：
  `{ "groups": [{ "id": "g-a1b2", "members": ["noteId1", "noteId2"], "name": "可选名" }] }`，
  `members` 数组顺序即组内叠放顺序。文件缺失或损坏时读回空注册表。
- `PUT /api/groups` 是**整体替换**（body 即注册表 JSON），增删组、调序、
  拖拽换位都由调用方改完整个注册表后一次性写回。
- groupId 由调用方（Electron 端）生成，Go 侧只做存储透传，不校验格式。

### git 同步

vault 可配置为 git 同步仓库（go-git 实现，HTTPS + token 认证）。
同步配置（含 token）存 `<vault>/.pinslip/git-sync.json`（0600 权限），
token 不出现在任何接口响应与日志中。

```jsonc
// SyncConfig（PUT /api/sync/config 请求体）
{ "url": "https://github.com/me/vault.git", "username": "me",
  "token": "ghp_...",              // 空且 url 未变 = 沿用已存 token
  "branch": "main",                // 缺省 main
  "enabled": true,
  "pushIntervalMin": 10,           // 自动推拉间隔（分钟），越界回退默认 10
  "syncOnChange": false }          // true = 变更防抖后跑完整 commit+pull+push；缺省 false = 只 commit

// SyncStatus（GET /api/sync/status 响应）
{ "enabled": true, "configured": true, "url": "...", "username": "...",
  "branch": "main", "lastSyncAt": "...", "lastError": "", "lastErrorCode": "",
  "ahead": 0, "behind": 0, "conflictedFiles": [], "pushIntervalMin": 10,
  "syncOnChange": false,
  // 分叉参考信息：仅 lastErrorCode == "SYNC_UNRELATED_HISTORIES" 时出现，
  // 全部基于本地数据（worktree + 最近一次 fetch 的 origin 引用），无网络请求；
  // 非分叉状态缺省。本地无 origin 引用时远端三字段同样缺省（容错）
  "remoteIsPinslip": true,             // 远端 head 树是否含 .pinslip-repo 标记
  "remoteLastCommitAt": "...",         // 远端最后提交时间（RFC3339）
  "localNotes": 12, "remoteNotes": 8 } // 两边 notes/ 下 .md 数
```

`POST /api/sync/resolve`（分叉人工接管，body `{ "strategy": "local" | "remote" }`）：

- 前置校验失败返回 400 `{ "error": "..." }`：strategy 非法、当前不是分叉状态、
  或远端 head 无 `.pinslip-repo` 标记（来历不明的远端不给接管）。
- `local`：force-push 本地分支覆盖远端（远端分叉历史被丢弃）；
  `remote`：先把 `notes/` `inbox/` `attachments/` 复制到
  `<vault>/.pinslip/backups/divergence-<yyyymmdd-hhmmss>/`（目录不存在跳过，
  备份失败中止不检出），再 fetch + 本地分支重置到 `origin/<branch>` +
  按树差异检出（运行时文件不动）。
- 成功后自动跑一轮同步验证并返回最新 `SyncStatus`；执行失败不返回 5xx
  （同 `POST /api/sync/now`），错误体现在 `lastError` / `lastErrorCode`。

- 冲突采用三方合并（diff3）：文本冲突写 conflict markers 进文件（该笔记
  `conflicted` 置 true，主界面提示），二进制冲突双留；解决标记后自动继续同步。
- 同步错误带稳定 `code`（renderer 按 code 映射 i18n 文案）：
  `SYNC_URL_REQUIRED` / `SYNC_LOCAL_NOT_PINSLIP_REPO` / `SYNC_REMOTE_NOT_PINSLIP_REPO` /
  `SYNC_REMOTE_ACCESS` / `SYNC_BRANCH_NOT_FOUND` / `SYNC_UNRELATED_HISTORIES` /
  `SYNC_DIRTY_WORKTREE` / `SYNC_CONNECT_FAILED` / `SYNC_COMMIT_FAILED` / `SYNC_PULL_FAILED` 等。
- `POST /api/sync/now` 失败不返回 5xx（状态查询是常态路径），错误体现在
  `SyncStatus.lastError` / `lastErrorCode` 字段。

## 约定

- **id 由客户端生成**（Electron 主进程 `crypto.randomUUID()`），PUT 幂等 upsert，
  这样窗口创建时就能确定 id，无需等待服务端返回。
- **PUT 是部分更新**：所有字段均可选，未提供的字段保留原值。
  例如只传 `{ "pin": true }` 可单独切换置顶，正文和标题不受影响。
  `zoom` 语义：不传保留原值，传 1 或 <= 0 恢复默认并删除字段。
- 标题留空时服务端自动从内容推导：首个有效行剥离 markdown 结构标记
  （标题/引用/列表/任务框/整行行内包装/整行链接图片）后截断 30 字——
  与渲染端 `NoteView.deriveTitle` 同算法，**改动必须双端同步**（Go 侧有 `TestDeriveTitle`）。
- **手动标题**：frontmatter `title_manual: true`（omitempty）标记标题由用户重命名，
  此后正文保存不再自动推导。只有 PUT 显式传 `titleManual` 才触碰该标志——
  显式传 `title` 但不传 `titleManual`（MCP patch 回传标题/速记聚合/网页剪藏）
  不会置位；传 `titleManual: false` 立即按当前正文重推导标题并按新 slug 重命名文件。
- **文件命名**：`<标题slug>-<创建日期yyyymmdd>-<id>.md`——slug 为用户可读的标题
  （清理 `\/:*?"<>|` 等非法字符，截断 30 字符），日期取创建时间（稳定不变），
  id 保证唯一；标题变化时文件自动重命名。
  兼容旧命名 `<id>.md`：可读，保存后自动升级为新命名。
- 图片引用写**相对笔记文件**的路径：`../` × (folder 深度 + 1) + `attachments/xxx`，
  任何 markdown 查看器可解析；移动笔记时服务端按新深度重写前缀。
  附件文件命名 `att-<时间戳>-<随机4位hex><ext>`。
- 本地文件是唯一事实来源（`notes/` 与 `inbox/` 下），SQLite 只是索引；
  服务启动时全量重建索引。

## Electron 内部窗口初始化

- 应用高级设置 `copyAllFormat` 接受 `markdown`（默认）或 `plain`，控制主界面与便签的「复制全部」。
  缺失或非法磁盘值回退 Markdown，IPC 拒绝非法写入，磁盘写入失败保留旧值并回报错误；通过既有高级设置广播即时同步。
  右键/更多菜单临时选择不修改偏好，不影响 Ctrl+C，也不改笔记文件。

- 关闭保存握手：渲染层通过 `onNoteFlushRequested(save, resume)` 订阅后报告 `note:save-ready`；
  主进程发送带请求号的 `note:flush`，preload 等待 save 完成后回复 `note:flush-result`。
  主进程同时校验发送方窗口与当前请求号，8 秒未完成视为失败，保留窗口并通过
  `note:resume-editing` 恢复编辑。正文仍通过 HTTP 保存，不经此 IPC 传输。
  正常关窗、退出、切库和安装更新先等待保存；已成功删除后的 `closeNote(id, true)` 直接销毁窗口，跳过保存。

- `note:take-initial-content`（`window.api.takeInitialNoteContent()`）无参数，返回 `string | null`。
  仅新建便签快捷键可为新窗口提供剪贴板纯文本快照；主进程根据 IPC 发送方识别窗口，
  领取一次即清理，非对应窗口、已领取或没有初始内容时返回 `null`，关闭窗口也会清理。
  文本不放入路由 URL，不提供任意笔记 ID 查询。渲染层初始化后通过既有 `PUT /api/notes/{id}` 自动保存。
- 应用高级设置 `blankNoteClipboard` 是默认 `false` 的严格布尔值，仅 `blankNoteShortcut` 启用时
  可启用并生效。父快捷键关闭时保留子偏好；与服务端速记剪贴板设置互相独立。
