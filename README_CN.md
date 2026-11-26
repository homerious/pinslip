# PinSlip

[官网](https://pinslip.app/) · [English](README.md)

> **Capture now. Organize later. 随手一记，自有归处。**

PinSlip 是一张钉在电脑桌面上的小便利贴。想到什么，随手记下来，贴在屏幕边上，
它就一直安安静静陪着你。每张便签都是一个普普通通的 Markdown 文件，
存在你自己选的文件夹里，打开 Obsidian 或 VS Code 也能接着写。
Windows、macOS 和 Linux 都能用。

[![Release](https://github.com/homerious/pinslip/actions/workflows/release.yml/badge.svg)](https://github.com/homerious/pinslip/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/homerious/pinslip)](https://github.com/homerious/pinslip/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/homerious/pinslip/blob/main/LICENSE)

## 认识一下 PinSlip

### 日常随手用的桌面小便签

想写什么，就钉一张在屏幕上，写着写着它就自己存好了。便签有六色可换，
待办、临时地址、手头资料各用一个颜色，一眼就能分清。不用的时候就折成一条小标题，
清清爽爽，要写要看再展开。

### 随手放，也能整整齐齐

便签拖到屏幕边上会自己贴好，钉住的几张靠近时，也会像磁铁一样轻轻吸在一起。
相关的便签还能组成一列「小分队」，整组一起拖、把宽度调齐。折叠一张，
下面的伙伴会自动补上来。下次打开 PinSlip，位置、大小和分组都还在。

### 想排版好看一点？试试 Markdown

平常随手记几行就够了。偶尔想写得整齐一点，可以加几个小标题、排一张表格，
或者列一份能直接打勾的待办。表格的行列可以随手增删。截图可以直接粘贴，
文件管理器里的图片也可以拖进来。手边有一段 Markdown 源码？贴进来就能看到排好的样子。
单独粘贴网址或 Windows 文件路径时，原来的地址也会保留下来。

### 先起个名字，字大一点也行

便签可以从正文自动取标题，也可以一打开就先起个名字。觉得字太小，
用工具栏把这张便签的标题和正文放大，窗口大小还是你原来摆好的样子。
写阿拉伯语、希伯来语时，可以让便签自动识别书写方向，也可以自己给某一张指定方向。

### 这一张，发给别人看看

想把列好的清单发到聊天里，可以直接「复制为图片」，也可以另存为 PNG。
要把文字带走，「复制全部」可以选 Markdown 或纯文本。整理了一张表？
点表格旁边的复制按钮，贴进 Excel 就会按原来的行列排好。

### 你写下的每个字，都在你手里

便签和图片附件都在本地你自己选的文件夹里。每张便签都是普通的 Markdown 文件，
同一个目录可以交给 Obsidian 或 VS Code 打开接着写。想备份时，把整个文件夹复制一份就行。

### 随手记的，也能随时找到

只记得几天前写过的一句话？用管理器搜一搜，标题、标签和正文都能找，命中的字会亮起来。
点开正文预览，表格和本地图片也能在管理器里看。已经打开了便签，想找某一句或把旧名字统一换掉？
用便签自己的查找和替换就行。

### 想整理了，拖一下就好

文件夹可以一层层建，收件箱里的速记也能直接拖进合适的目录。标签打到一半，
PinSlip 会帮你列出以前用过的，回车就能选中。找文件时，便签的「更多 → 便签信息」
能看到存放目录、创建和保存时间，还有便签 ID。手滑删了东西，回收区里还能捞回来。

### 念头来得快，速记也得跟得上

按一下全局快捷键，打几行字或贴张截图，就存进收件箱了。想一口气记好几条，
按 `Ctrl+Enter` 保存，窗口留着让你继续写。速记可以一条一张，也可以按时间顺序
汇到一张「速记 今日」。按键不顺手，在设置里换一个就好。

### 网页上看到好内容，一键收进来

Chrome 和 Firefox 扩展里可以收下选中的一段话、一个链接、文章正文，
或者当前网页画面的截图。保存正文时会提取文章内容、转成 Markdown，并带上出处，
以后想回去看原文也找得到。只想随手写一句？点扩展图标就能打开速记。
在桌面端的「浏览器剪藏」里生成配对码，到扩展里输一次就能用，也可以随时撤销授权。

### 多台电脑？便签可以跟着你走

在设置里连上自己的 Git 仓库，便签可以定时同步，也可以设置为有改动就同步。
换台电脑，拉下来接着写。两边改了不同的段落，能合并的会自动合并。
如果改到同一处，可以在便签里对比两份内容，挑一份或自己改好再保存。
同步得怎么样，便签工具栏上就能看。需要从远端恢复时，PinSlip 会先备份本地便签和附件。

### AI 助手也能帮你记，还能帮你收拾

在支持 MCP 的本机客户端连上 PinSlip，就能让 AI 找便签、读原文、写新便签，
或在一张旧便签后接着写。想让它帮你收拾，也可以交给它改标题、加减标签、移动便签，
或者新建、重命名和删除文件夹。临时想到的事可以直接扔进收件箱。改标题、标签或移动前，
PinSlip 会检查便签版本，刚被你改过的便签会请客户端先重新读取。MCP 只接受本机连接，
设置里可以复制接入配置或关闭服务。[MCP 接入与工具清单](skills/pinslip/SKILL.md)

### 桌面怎么摆，按你的习惯来

在高级设置里可以把常用按钮拖到前头，管理器能用深色主题，也可以记住你摆好的大小和位置。
想一开机就看到上次的便签，可以让 PinSlip 随系统启动，管理器先藏在托盘里。
也可以给「新建便签」单独设个快捷键，让它把刚复制的文字带进新便签。

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
