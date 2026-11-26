---
name: pinslip
description: 接入 PinSlip 桌面便签的本地 MCP 服务——搜索、读取、新建、修改、追加、删除（进回收区）便签，并触发/查询 git 同步。当用户提到便签、速记、笔记归档、把内容记到 PinSlip，或需要读写 PinSlip vault 时使用。
---

# PinSlip MCP 接入指南

PinSlip 是本机桌面便签应用。其本地服务（pinslipd）内置 MCP server，
AI agent 可通过 Streamable HTTP 读写便签并触发 git 同步。

- 通过 MCP Streamable HTTP 访问 `/mcp`。服务仅监听 `127.0.0.1`，POST 请求使用 `application/json`。
- 本机原生 MCP 客户端无需 token。服务校验回环主机和请求来源，拒绝浏览器请求和跨域预检。
- 生命周期：与应用同进退——应用没启动，MCP 就不可用
- 总开关：应用「设置 → MCP 服务」可整体关闭（关闭时端点 404）

## 1. 发现：怎么找到服务

读发现文件 `<vault>/.pinslip/mcp.json`：

```json
{
  "port": 10796,
  "pid": 35668,
  "version": "0.1.0",
  "mcpPath": "/mcp",
  "startedAt": "2026-07-24T09:30:00+08:00"
}
```

| 字段 | 含义 |
| --- | --- |
| `port` | HTTP 端口（优先知名端口 17639，被占用回退随机，以本文件为准） |
| `pid` | 服务进程号（可探测存活） |
| `version` | pinslipd 版本 |
| `mcpPath` | MCP 端点路径（固定 `/mcp`） |
| `startedAt` | 本次启动时间（RFC3339） |

vault 位置：默认 `~/Documents/PinSlip`（Windows：`C:\Users\<你>\Documents\PinSlip`）；
若用户改过存储位置，以应用「设置 → 数据与存储 → 存储位置」为准。

**接入地址 = `http://127.0.0.1:<port>/mcp`。**

异常分支：

- 文件不存在 → 应用未启动（或从未启动过）。提示用户先启动 PinSlip，不要自己猜测端口。
- 文件存在但 `pid` 进程已死 / 连接被拒绝 → 文件是残留。同样提示用户启动应用。
- 请求 `/mcp` 返回 404 → 用户在设置里关闭了 MCP 服务。提示用户在
  「设置 → MCP 服务 → AI 接入」打开开关。
- 请求 `/mcp` 返回 403 → 确认使用的是本机原生 MCP 客户端，并核对发现文件中的接入地址。

## 2. 客户端配置

### Claude Code（`.mcp.json`）

```json
{
  "mcpServers": {
    "pinslip": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/mcp"
    }
  }
}
```

### 通用 MCP 客户端

在本机支持 Streamable HTTP 的 MCP 客户端中，server 类型选 `http` / `streamable-http`，
URL 填 `http://127.0.0.1:<port>/mcp`，无需鉴权头。

> 端口优先绑 17639、被占用才回退随机，务必先从 mcp.json 读取实际值，不要写死。
> 应用设置里「复制接入信息」按钮可直接复制上面这段配置。

## 3. 工具一览（18 个）

数据面（16）：

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `search_notes` | 全文搜索（FTS5，中文子串匹配），返回命中片段 | `query`（必填）、`folder`、`tag`、`inbox`、`since`/`until`/`timeField`、`limit`（默认 20） |
| `list_notes` | 列出便签元数据（含 excerpt 摘要，不含正文），过滤+排序+分页 | `folder`、`tag`、`inbox`、`since`/`until`/`timeField`、`sort`（updated/created）、`order`、`limit`（默认 50）、`offset` |
| `read_note` | 读取单条便签完整内容与 `revision` | `id`（必填） |
| `create_note` | 在普通便签目录新建，默认落在根目录 | `content`（必填）、`title`（缺省自动推导）、`tags`、`folder` |
| `update_note` | **全量替换**正文，可顺带改标题/标签/移动文件夹 | `id`、`content`（均必填）、`title`、`tags`、`folder`、`expectedRevision` |
| `patch_note` | 把正文中唯一出现的 `oldString` 换成 `newString` | `id`、`oldString`、`newString`（均必填）、`expectedRevision` |
| `append_note` | 把内容追加到便签末尾，保留已有标题 | `id`、`content`（均必填）、`expectedRevision` |
| `delete_note` | 删除便签并移入回收区 | `id`（必填）、`expectedRevision` |
| `update_note_metadata` | 保留正文，增删标签、设置手动标题或恢复自动标题 | `id`、`expectedRevision`（均必填）、`title` 或 `resetTitle: true`、`addTags`、`removeTags` |
| `move_note` | 独立移动便签，并调整附件相对路径 | `id`、`expectedRevision`、`folder`（均必填，空字符串表示普通便签根目录） |
| `quick_capture` | 速记进收件箱，按 vault 设置逐条新建或按日聚合 | `content`（必填） |
| `list_tags` | 全部标签及使用次数 | 无 |
| `list_folders` | notes/ 下全部子文件夹 | 无 |
| `create_folder` | 创建空文件夹及其上级目录，已存在视为成功 | `path`（必填，notes/ 下的相对路径） |
| `rename_folder` | 同级重命名文件夹，返回新路径，子目录和便签保留 | `path`、`name`（均必填，`name` 是单段目录名） |
| `delete_folder` | 保留便签并移到普通便签根目录，或整棵目录移入 PinSlip 回收区 | `path`、`mode`（均必填，`move` 或 `trash`） |

时间过滤参数（`search_notes` / `list_notes` 通用）：
`since` / `until` 接受日期（`2026-07-23`，本地时区）或 RFC3339 时间戳，**闭区间**
（只给日期时 until 按当天结束计）；`timeField` 选 `updated`（默认）或 `created`。

`search_notes` 在应用 `limit` 前先筛选，再按关键词相关度返回匹配结果。两个查询工具的 `folder: ""` 都只匹配普通便签根目录。只查收件箱时传 `inbox: true` 并省略 `folder`。

同步面（2）：

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `sync_now` | 立即执行一轮 git 同步（commit + pull + push） | 无 |
| `sync_status` | 上次同步时间、待推送数、待解冲突文件列表 | 无 |

## 4. 典型工作流

**速记**

1. 用户要速记到收件箱时用 `quick_capture`。保存结果会带上便签 ID，可再读取。
2. 用户指定一张既有便签时，用 `list_notes` 定位并用 `read_note` 确认对象，再用 `append_note` 追加。

**归档整理**

1. `search_notes` 按关键词找候选，再用 `read_note` 读正文和当前版本。
2. 改标题或标签用 `update_note_metadata`，移动用 `move_note`。用 `list_folders` 查看目标目录。
3. 修改后重新 `read_note` 获取最新版本再执行下一步。旧的合并调用 `update_note` 返回 `NOTE_PARTIAL_WRITE` 时，先检查实际正文和位置再重试。

**管理文件夹**

用 `create_folder` 创建空目录，用 `rename_folder` 同级改名。删除前核对 `list_folders` 返回的路径，并明确用户要保留便签还是把整个目录回收。

- `mode: "move"` 将子树内的便签移到普通便签根目录，再删除空目录。目录含非便签文件时会拒绝操作。
- `mode: "trash"` 将整棵目录连同其中的文件移进 PinSlip 回收区。

若 `move` 报错，用 `list_folders` 和 `list_notes` 检查原目录与根目录，再决定是否重试。

**按时间查找**：「上周记的/最近改过的」这类需求用时间参数，不要全量拉列表自己算：

1. `list_notes`（`since: "2026-07-20"`, `until: "2026-07-26"`）按更新时间圈范围；
   找「哪天记的」用 `timeField: "created"`
2. 每条结果带 `excerpt` 摘要，先扫摘要定位，命中再 `read_note` 取全文

**小改动**：改一两句话、修错别字、更新某个字段值，用 `patch_note`
（`oldString` 必须唯一匹配，找不到/多处匹配会报错，此时 `read_note` 拿到原文再试）；
整篇重写才用 `update_note`。

**引用写作**：用户要写东西时，先 `search_notes` 找相关便签素材，
`read_note` 取出原文片段引用，写完的长文可 `create_note` 存回 PinSlip。

**同步**

用 `sync_status` 查看配置状态、`ahead`（待推送数）和 `conflictedFiles`（待解冲突文件）。用 `read_note` 查看冲突便签正文中的 Git 冲突标记。用户要求立即同步时才调用 `sync_now`，它会执行提交、拉取和推送。未配置或已停用时可能返回 `success: true`，应结合 `configured`、`enabled` 和 `message` 判断是否实际同步。

## 5. 规矩（重要）

- **版本校验**。把 `read_note` 返回的 `revision` 原样作为 `expectedRevision` 提交。收到 `NOTE_REVISION_CONFLICT` 时重新读取并核对改动，再决定是否重试。
- **删除只进回收区**：`delete_note` 不做物理删除，用户可在应用内找回。
  不要尝试任何绕过回收区的删除方式。
- **大改前先 `read_note`**：`update_note` 是**全量替换**不是局部修改，
  不先读出原文拼接会把用户内容冲掉。小改动优先 `patch_note`（唯一匹配才执行，
  标题不会被重新推导），小补充优先用 `append_note`。
- **写入纯 Markdown**：便签正文就是 `.md` 文件原文，标题/列表/任务框/图片
  都是标准 Markdown；不要写入 HTML 或私有语法。
- **便签窗口实时联动**。已打开的便签正文被 AI 改动后，窗口自动载入并提示。有未保存的编辑时，窗口提示用户选择载入最新内容或保留本地编辑。
- **窗口 UI 状态不可控**：置顶/颜色/折叠/便签组属于窗口行为，
  MCP 不提供接口；同步配置（仓库地址/令牌）也只能在应用设置里改。
