---
name: pinslip
description: 接入 PinSlip 桌面便签的本地 MCP 服务——搜索、读取、新建、修改、追加、删除（进回收区）便签，并触发/查询 git 同步。当用户提到便签、速记、笔记归档、把内容记到 PinSlip，或需要读写 PinSlip vault 时使用。
---

# PinSlip MCP 接入指南

PinSlip 是本机桌面便签应用。其本地服务（pinslipd）内置 MCP server，
AI agent 可通过 Streamable HTTP 读写便签并触发 git 同步。

- 传输：MCP Streamable HTTP，端点 `/mcp`
- 网络：仅监听 `127.0.0.1`，无鉴权（本机开放功能）
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
| `port` | HTTP 端口（每次启动随机） |
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

任何支持 Streamable HTTP 的客户端：server 类型选 `http` / `streamable-http`，
URL 填 `http://127.0.0.1:<port>/mcp`，无需鉴权头。

> 端口每次启动随机，务必先从 mcp.json 读取，不要写死。
> 应用设置里「复制接入信息」按钮可直接复制上面这段配置。

## 3. 工具一览（11 个）

数据面（9）：

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `search_notes` | 全文搜索（FTS5，中文子串匹配），返回命中片段 | `query`（必填）、`folder`、`tag`、`limit`（默认 20） |
| `list_notes` | 列出便签元数据（不含正文），过滤+排序+分页 | `folder`、`tag`、`inbox`、`sort`（updated/created）、`order`、`limit`（默认 50）、`offset` |
| `read_note` | 读取单条便签完整内容 | `id`（必填） |
| `create_note` | 新建便签 | `content`（必填）、`title`（缺省自动推导）、`tags`、`folder` |
| `update_note` | **全量替换**正文，可顺带改标题/标签 | `id`、`content`（均必填）、`title`、`tags` |
| `append_note` | 把内容追加到便签末尾 | `id`、`content`（均必填） |
| `delete_note` | 删除便签——**只进回收区**，可找回 | `id`（必填） |
| `list_tags` | 全部标签及使用次数 | 无 |
| `list_folders` | notes/ 下全部子文件夹 | 无 |

同步面（2）：

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `sync_now` | 立即执行一轮 git 同步（commit + pull + push） | 无 |
| `sync_status` | 上次同步时间、待推送数、待解冲突文件列表 | 无 |

## 4. 典型工作流

**速记（最高频）**：先把内容记进收集箱，别打断用户当前思路。

1. `list_notes`（`inbox: true`）找用户的收集便签；没有就 `create_note` 建一条（如标题「收集箱」）
2. `append_note` 把新内容追加到末尾（一条一行，带时间戳更佳）

**归档整理**：

1. `search_notes` 按关键词找候选 → `read_note` 看全文
2. 用 `update_note` 补标签（tags 整体替换，先读出现有标签再增删）
3. 新建便签时直接指定 `folder` 归位；`list_folders` 看现有目录结构

**引用写作**：用户要写东西时，先 `search_notes` 找相关便签素材，
`read_note` 取出原文片段引用，写完的长文可 `create_note` 存回 PinSlip。

**同步**：批量写入完成后 `sync_now` 推一轮；
`sync_status` 看 `ahead`（待推送数）与 `conflictedFiles`（待解冲突，
冲突内容可 `read_note` 查看标准 git markers）。

## 5. 规矩（重要）

- **删除只进回收区**：`delete_note` 不做物理删除，用户可在应用内找回。
  不要尝试任何绕过回收区的删除方式。
- **大改前先 `read_note`**：`update_note` 是**全量替换**不是局部修改，
  不先读出原文拼接会把用户内容冲掉。小补充优先用 `append_note`。
- **写入纯 Markdown**：便签正文就是 `.md` 文件原文，标题/列表/任务框/图片
  都是标准 Markdown；不要写入 HTML 或私有语法。
- **便签窗口实时联动**：开着的便签被 AI 改动后，应用的外部变更感知会
  自动提示用户，不需要（也无法）通过 MCP 通知窗口。
- **窗口 UI 状态不可控**：置顶/颜色/折叠/便签组属于窗口行为，
  MCP 不提供接口；同步配置（仓库地址/令牌）也只能在应用设置里改。
