# PinSlip MCP Server + Skill 设计（2026-07-23 定稿）

> 目标：让 AI agent（Kimi Work / Claude Code 等 MCP 客户端）能触达笔记数据——
> 搜索、读取、新建、修改、追加、删除（进回收区），并能触发/查询 git 同步。

## 总体形态

```
AI agent ──MCP over Streamable HTTP（127.0.0.1）──▶ pinslipd /mcp 端点
                                                      │ 复用 internal/notes + internal/index 服务层
                                                      ▼
                                                   vault（md + .pinslip 索引）
```

- MCP 端点内嵌 pinslipd：与现有 HTTP API **同端口、同进程、同生命周期**（应用开着即可用）
- SDK：**mark3labs/mcp-go**（生态最成熟；MCP 层是薄壳，将来换官方 SDK 成本低）
- 传输：Streamable HTTP（MCP 现行标准），路由 `/mcp`
- **无 token 鉴权**（拍板：开放功能零配置；仅绑 127.0.0.1；设置里保留 MCP 总开关，默认开）
- 写入全走现有 notes service 层：文件名规范/frontmatter/索引重建/回收区行为与界面一致；
  开着的便签窗口被 AI 改内容 → 已有的外部变更感知自动处理

## 接入发现机制

pinslipd 启动时写 `<vault>/.pinslip/mcp.json`（关闭时删除或置 stale）：

```json
{ "port": 10796, "pid": 35668, "version": "x.y.z", "mcpPath": "/mcp", "startedAt": "..." }
```

- agent 读文件即知怎么连；文件不存在 / pid 已死 → skill 引导"请先启动 PinSlip"
- 设置界面「MCP 服务」小节：开关（默认开）+ 显示接入信息（地址、mcp.json 路径）+ 复制配置

## 工具清单（11 个，第一阶段全做）

数据面（9）：
search_notes（FTS5 片段，可按文件夹/标签过滤）、list_notes（过滤+排序+分页）、read_note、
create_note、update_note（全量替换）、append_note（追加，AI 速记高频）、
delete_note（**只进回收区**，不做物理删除）、list_tags、list_folders

同步面（2）：
sync_now（触发一轮 commit+pull+push，复用 /api/sync/now 语义）、
sync_status（上次同步时间、待推送数、待解冲突文件列表；冲突内容可再 read_note 查看）

不做：便签窗口 UI 状态（置顶/颜色/折叠/组）、同步配置（地址/令牌）、回收区清理。

## Skill（skills/pinslip/SKILL.md，公开文档）

1. 发现：读 mcp.json → port/path；异常分支（应用未启动/版本不符）
2. 配置示例：Claude Code `.mcp.json`、Kimi Work MCP 配置各一段可复制
3. 工作流：速记（append 到收集箱）、归档整理（search→read→移动/打标签）、引用写作
4. 规矩：删除必走回收区；大改前先 read；写入纯 Markdown

## 边界

- 应用没启动 = MCP 不可用（mcp.json 里 pid 可探测）；headless pinslipd 以后再说
- 实施三步：① mcp-go 接入 + 发现文件 + 只读三件套 ② 写入四件套 + git 同步两件套 ③ skill + 设置 UI
- 验收：真实 MCP 客户端挂上，完成「搜一条 → 追加一行 → 主界面看到变化」闭环
