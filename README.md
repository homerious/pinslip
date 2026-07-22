# PinSlip

**简体中文** | [English](README_EN.md)

> 想成为你日常好用、爱用的记录小工具。

PinSlip 是一张钉在电脑桌面上的小便利贴。想到什么，随手记下来，贴在屏幕边上，
它就一直安安静静陪着你。所有笔记都是普普通通的 Markdown 文件，
存在你自己选的文件夹里——**和 Obsidian 完全互通**，你的文字永远是你的。

当前版本：**v0.5.1**（[更新日志](docs/CHANGELOG.md)）

[![Release](https://github.com/homerious/pinslip/actions/workflows/release.yml/badge.svg)](https://github.com/homerious/pinslip/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/homerious/pinslip)](https://github.com/homerious/pinslip/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/homerious/pinslip/blob/main/LICENSE)

## 认识一下 PinSlip

**日常随手用的桌面小便签**
不用打开笨重的大软件，也不用想「该存到哪里」。想到什么，钉一张在屏幕上，
写完它就在那里。有六种暖暖的颜色可以换，不用的时候折成一条小标题，
清清爽爽，要用再展开。

**想排版好看一点？试试 Markdown**
平常随手记记文字就很好。偶尔想写得整齐一点——一份待办清单、几段带小标题的笔记——
试试按 Markdown 语法输入，马上就能看到不一样的排版效果。任务框可以直接打勾，
截图按 Ctrl+V 就贴进来了，一点都不用操心图片存哪。

**随手放，也能整整齐齐**
便签多了也不用你动手收拾。想暂存一下，就折叠收起来；置顶的便签可以整齐地
贴在屏幕角落；几张便签靠近时，会轻轻吸在一起对齐；还能组成一列「小分队」——
整个队伍一起移动、一起改宽度，折叠一张，下面的伙伴会自动补上来。

**你的文字，所有权都在你**
所有笔记都存放在本地你自己的文件夹里，不经过任何云端。就算哪天不用 PinSlip 了，
每一张便签也都还在——它就是一个普通的 Markdown 文件，兼容 Obsidian，
也可以用 VS Code 等任何支持 Markdown 的软件打开，接着写。

**随手记的，也能随时找到**
当时随手一记的东西，过后想找？直接搜就好。标签和文件夹帮你归好类，
全文搜索连中文也搜得准，找到的词会亮给你看。就算手滑删掉了，
回收区里还给你留着，随时可以捞回来。

**还有一点小心思**
它会一直待在托盘里陪你；按 `Ctrl+Shift+N`，任何时候都能速记一条；
开机自动启动，关了重开，每张便签还在原来的位置等你。

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
