# PinSlip

[官网](https://pinslip.app/) · [English](README.md)

PinSlip 是一款支持 Windows、macOS 和 Linux 的桌面便签应用。把正在用的便签钉在屏幕上，用快捷键随手记录，之后按关键词、文件夹或标签找回来。每张便签都是存放在你所选本地目录中的 Markdown 文件，可以直接用 Obsidian 或 VS Code 打开和编辑。

[![Release](https://github.com/homerious/pinslip/actions/workflows/release.yml/badge.svg)](https://github.com/homerious/pinslip/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/homerious/pinslip)](https://github.com/homerious/pinslip/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/homerious/pinslip/blob/main/LICENSE)

## 功能介绍

### 桌面便签

选一种颜色，把手头的待办或资料钉在其他窗口上方。编辑会自动保存，暂时用不到时可以折叠成标题栏。便签会吸附到屏幕边缘，两张置顶便签靠近时也会自动对齐。相关便签可以组成一列，整组一起移动，折叠其中一张时下方会自动补位。应用重开后会恢复便签布局和分组。

### Markdown 编辑与本地存储

可以写标题、插入表格、勾选任务，也可以把截图直接粘贴进便签。每张便签都是一个 Markdown 文件，和图片附件一起保存在你选的本地目录里。用 Obsidian 或 VS Code 就能打开和继续编辑，复制整个目录即可备份。

### 搜索与整理

在管理器里按文件夹或标签浏览，也可以直接搜索标题、标签和正文。列表支持 Markdown 正文预览，搜索时会高亮命中的文字。误删的便签可以从回收区找回。

### 全局速记与浏览器剪藏

用全局快捷键打开速记，把一段文字或一张截图直接存进收件箱。速记可以逐条新建，也可以按日汇总。在 PinSlip 设置中配对 Chrome 或 Firefox 扩展后，可以把选中文字、链接、网页正文或区域截图存成便签。

### 本机 AI 与 MCP

连接支持 MCP 的本机客户端后，可以让它搜索、读取、创建和编辑便签，追加正文、修改标题和标签、移动便签、管理文件夹，或把速记写入收件箱。内置服务只接受本机连接，可在 PinSlip 设置中关闭 MCP 接入。[MCP 接入与工具清单](skills/pinslip/SKILL.md)

### 可选 Git 同步

把 PinSlip 接到自己的 Git 仓库，就能在多台电脑间同步便签。可合并的编辑会自动合并，遇到冲突时可以在便签窗口比较两个版本并处理。

## 下载

去 [Releases](https://github.com/homerious/pinslip/releases/latest) 挑一个适合你系统的：

| 系统 | 文件 |
|---|---|
| Windows | `PinSlip-Setup-x.x.x.exe` |
| macOS（Apple 芯片） | `PinSlip-x.x.x-arm64.dmg` |
| macOS（Intel） | `PinSlip-x.x.x.dmg` |
| Linux | `PinSlip-x.x.x.AppImage` / `pinslip_x.x.x_amd64.deb` |

装好之后有新版本会自动提示更新；连不上 GitHub 也不用担心，更新会走国内镜像。
基于 Electron 45 的 macOS 安装包需要 macOS 13 Ventura 或更新版本。
macOS 安装包暂未签名，首次打开如遇「已损坏」提示，右键 → 打开即可。

界面已支持 简体中文 / English / 日本語 / 한국어 / Deutsch / Français / Español，
在设置里随时切换。

## 快速开始

环境要求：

- Node.js >= 22.12
- pnpm >= 8（没装的话所有 `pnpm` 命令可用 `npx pnpm` 代替）
- Go >= 1.22（需在 PATH 中，或设置环境变量 `PINSLIP_GO` 指向 go 可执行文件）
- 当前源码构建的 macOS 版本需要 macOS 13 Ventura 或更高版本

```bash
# 安装依赖
pnpm install
pnpm --filter @pinslip/desktop exec install-electron

# 开发模式：启动 Electron（主进程自动拉起 Go 服务）
pnpm dev

# 单独编译 Go 服务（同时拷贝二进制到 apps/desktop/resources/service/）
pnpm build:service

# 构建桌面端产物
pnpm build

# 打出安装包（先 build:service；--win / --mac / --linux）
pnpm dist

# 类型检查
pnpm typecheck
```

## 目录结构

```
pinslip/
├── apps/
│   ├── desktop/          # Electron + React 桌面端（pnpm workspace 成员）
│   ├── service/          # Go 本地服务（go.mod 独立，内置 MCP server）
│   └── extension/        # 浏览器插件（Chrome / Firefox）
├── docs/                 # 文档（用户手册 / CHANGELOG / API 契约）
├── skills/               # 给 AI agent 的 pinslip skill（教它调用 MCP）
├── scripts/              # 编排脚本（dev / build-service）
└── Makefile              # 跨语言编排入口
```

## 架构要点

- **窗口的事走 IPC**：渲染进程通过 `window.api.*`（preload 白名单）调用窗口管理
- **便签数据走本地 HTTP。** Go 服务优先绑定 `127.0.0.1:17639`，端口被占用时改用可用端口。主进程通过 `runtime:info` 把实际端口和桌面会话凭证交给渲染进程。
- **md 文件是唯一事实来源**：SQLite FTS5 只是索引，启动全量重建 + fsnotify 双保险
- **Git 同步和 MCP 都运行在本地 Go 服务中。** Git 同步由用户配置。本机 MCP 接入默认开启，可以在 vault 设置中关闭。
- Go 服务只绑定回环地址，数据默认存 `%USERPROFILE%\Documents\PinSlip\`
  （可用 `PINSLIP_DATA_DIR` 覆盖）

## 文档

- [用户手册](docs/user-guide.md) — 功能说明（第一次用 → 日常用 → 整理 → 进阶）
- [CHANGELOG](docs/CHANGELOG.md) — 版本变更记录
- [API 契约](docs/api.md) — 本地服务 HTTP 接口

## 贡献者

由 [@homerious](https://github.com/homerious) 打造，感谢社区每一位朋友 💛

[<img src="https://github.com/Gaald.png?size=48" width="48" alt="Gaald">](https://github.com/Gaald)
[<img src="https://github.com/Keyhabit.png?size=48" width="48" alt="Keyhabit">](https://github.com/Keyhabit)
[<img src="https://github.com/onemast.png?size=48" width="48" alt="onemast">](https://github.com/onemast)
[<img src="https://github.com/BigHairyWookie.png?size=48" width="48" alt="BigHairyWookie">](https://github.com/BigHairyWookie)

## License

MIT
