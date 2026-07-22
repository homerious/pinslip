# PinSlip

**简体中文** | [English](README_EN.md)

> 桌面钉住便签 + 本地知识管理 + AI 开放接入

PinSlip 是 Windows 桌面上的「钉住便签」工具：随手钉一张在屏幕上，写了就走。
所有便签都是纯 Markdown 文件，存在你自己选的目录里——**和 Obsidian 完全互通**，
你的笔记永远不被任何格式绑架。

当前版本：**v0.5.0**（[更新日志](docs/CHANGELOG.md)）

[![Release](https://github.com/homerious/pinslip/actions/workflows/release.yml/badge.svg)](https://github.com/homerious/pinslip/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/homerious/pinslip)](https://github.com/homerious/pinslip/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/homerious/pinslip/blob/main/LICENSE)

## 你会怎么用它

**想到就写，写完就走**
便签是钉在屏幕上的无边框小卡片：可置顶、六种颜色、不用时折叠成一条标题栏。
写错随手改，关掉重开还在原地。

**不用学语法的 Markdown**
标题、列表、可打勾的任务框都是所见即所得；截图 Ctrl+V 直接贴进来，
图片自动存到便签旁的附件目录。

**多了也不乱**
便签靠近时会自动对齐；拖向屏幕边缘会吸附回安全位置，便签永远不会「丢」出屏幕。
两张置顶便签重叠一半松手就成组——一叠便签左对齐摞好，整组一起拖，
折叠一张，下面的自动补位，还可以给组起名字。

**你的笔记，什么编辑器都能打开**
每张便签就是 `标题-日期-id.md`：YAML frontmatter + Markdown 正文。
在 Obsidian 里接着写、在 VS Code 里改，PinSlip 实时跟上；
图片用相对路径，挪动文件夹也不裂图。

**找东西不靠记忆**
标签、嵌套文件夹、全文搜索（中文分词 + 权重排序，命中词高亮）。
主界面三种看法：列表 / 文件夹 / 标签。删掉的进回收区，
保留几天你定，随时捞回来。

**一直在手边**
托盘常驻、`Ctrl+Shift+N` 全局速记、开机自启。

## 快速开始

环境要求：

- Node.js >= 18（推荐 20+）
- pnpm >= 8（没装的话所有 `pnpm` 命令可用 `npx pnpm` 代替）
- Go >= 1.22（需在 PATH 中，或设置环境变量 `PINSLIP_GO` 指向 go 可执行文件）

```bash
# 安装依赖
pnpm install

# 开发模式：启动 Electron（主进程自动拉起 Go 服务）
pnpm dev

# 单独编译 Go 服务（同时拷贝二进制到 apps/desktop/resources/service/）
pnpm build:service

# 构建桌面端产物
pnpm build

# 打出 Windows 安装包（先 build:service）
pnpm dist

# 类型检查
pnpm typecheck
```

## 目录结构

```
pinslip/
├── apps/
│   ├── desktop/          # Electron + React 桌面端（pnpm workspace 成员）
│   └── service/          # Go 本地服务（go.mod 独立）
├── docs/                 # 文档（用户手册 / CHANGELOG / API 契约）
├── scripts/              # 编排脚本（dev / build-service）
└── Makefile              # 跨语言编排入口
```

## 架构要点

- **窗口的事走 IPC**：渲染进程通过 `window.api.*`（preload 白名单）调用窗口管理
- **笔记数据走 HTTP**：渲染进程直接 fetch Go 服务（`127.0.0.1:随机端口`），
  端口由主进程拉起 Go 时解析 stdout 获得，经 IPC `runtime:info` 下发
- **md 文件是唯一事实来源**：SQLite FTS5 只是索引，启动全量重建 + fsnotify 双保险
- Go 服务只绑定回环地址，数据默认存 `%USERPROFILE%\Documents\PinSlip\`
  （可用 `PINSLIP_DATA_DIR` 覆盖）

## 文档

- [用户手册](docs/user-guide.md) — 功能说明（第一次用 → 日常用 → 整理 → 进阶）
- [CHANGELOG](docs/CHANGELOG.md) — 版本变更记录
- [API 契约](docs/api.md) — 本地服务 HTTP 接口

## License

MIT
