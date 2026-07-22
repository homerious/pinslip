# PinSlip

> 桌面钉住便签 + 本地知识管理 + AI 开放接入

PinSlip 是 Windows 桌面上的「钉住便签」工具：随手钉一张在屏幕上，写了就走。
所有便签都是纯 Markdown 文件，存在你自己选的目录里——**和 Obsidian 完全互通**，
你的笔记永远不被任何格式绑架。

当前版本：**v0.5.0**（[更新日志](docs/CHANGELOG.md)）

[![Release](https://github.com/homerious/pinslip/actions/workflows/release.yml/badge.svg)](https://github.com/homerious/pinslip/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/homerious/pinslip)](https://github.com/homerious/pinslip/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/homerious/pinslip/blob/main/LICENSE)

## 它能做什么

**便签，贴在桌面上**
无边框透明小卡片，可置顶、可折叠成标题条、六种颜色。写错了随手改，
不用了折叠起来，还嫌碍事就拖去贴屏幕边缘。

**编辑器不添乱**
Milkdown 所见即所得 Markdown：标题、列表、可点击的任务框、粘贴图片自动存附件。
没有需要学的语法，也没有藏起来的格式。

**便签会自己排队**
拖到屏幕边缘自动吸附对齐；两张置顶便签靠近会自动贴边；
重叠一半松手就**成组**——一叠便签左对齐摞起来，整组一起拖、
折叠一张下面的自动补位，还可以给组起名字。

**文件就是你的，随便翻**
便签就是 `标题-日期-id.md`，YAML frontmatter + Markdown 正文。
用 Obsidian、VS Code、记事本打开都一样；图片是相对路径，不裂图。
外部改了、删了，应用里实时同步。

**整理在需要时才出现**
标签、嵌套文件夹、全文搜索（中文 bigram + bm25 加权，命中词高亮）。
主界面三视图：列表 / 文件夹 / 标签。删了的东西进回收区，
保留几天你说了算，还能手动捞回来。

**一直在手边**
托盘常驻、全局快捷键速记、开机自启。关了重开，
每张便签的位置、尺寸、折叠状态、分组原样还原。

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
├── docs/                 # 文档（api.md 接口契约 / CHANGELOG / 设计留档）
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
- [AGENTS.md](AGENTS.md) — 项目接手指南（架构约定与领域坑）
- [便签组设计](docs/design-note-groups.md) / [标签与文件夹设计](docs/design-tags-folders.md) / [macOS 兼容性](docs/macos-compat.md)

## License

Apache-2.0
