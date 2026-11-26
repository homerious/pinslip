# PinSlip

[Website](https://pinslip.app/) · [简体中文](README_CN.md)

PinSlip is a desktop sticky-note app for Windows, macOS, and Linux. Pin a note
where you need it, capture a thought with a keyboard shortcut, and find it later
by keyword, folder, or tag. Every note is a Markdown file in a local folder you
choose. Open the same files in Obsidian or VS Code.

[![Release](https://github.com/homerious/pinslip/actions/workflows/release.yml/badge.svg)](https://github.com/homerious/pinslip/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/homerious/pinslip)](https://github.com/homerious/pinslip/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/homerious/pinslip/blob/main/LICENSE)

## Features

### Desktop sticky notes

Pick one of six colors, pin notes above other windows, and fold them down to a
title bar when you need more space. Edits save automatically. Notes snap to
screen edges, and nearby pinned notes snap into alignment. Group related notes
to move them as a stack. When you fold one, the notes below move up to fill the
gap. PinSlip restores your layout and groups when you reopen it.

### Markdown editing and local files

Write headings, tables, and checkable task lists, or paste a screenshot straight
into a note. PinSlip saves each note as a Markdown file in a folder you choose
and stores images alongside your notes in that folder. Open and edit the same
files in Obsidian or VS Code, or back them up by copying the folder.

### Search and organize

Browse notes by folder or tag, or search titles, tags, and note contents.
The manager can show formatted Markdown previews, and search results highlight
the matching text. You can recover accidentally deleted notes from the recycle
area.

### Quick Capture and web clipping

Open Quick Capture with a global shortcut to send a thought or screenshot
straight to the inbox. Save each entry as its own note or collect entries in
a daily note. Pair the Chrome or Firefox extension in PinSlip settings to
save selected text, links, article contents, or a screenshot of a selected area.

### Local AI via MCP

Connect a local MCP client to search, read, create, or edit notes, append text,
update titles and tags, move notes, manage folders, and send quick captures to
the inbox. The built-in service accepts local connections, and you can turn off
MCP access in PinSlip settings. [MCP setup and tools](skills/pinslip/SKILL.md)

### Optional Git sync

Connect your own Git repository to sync notes across computers. PinSlip merges
compatible edits automatically. When changes conflict, compare the versions and
resolve them in the note window.

## Download

Grab the right build from [Releases](https://github.com/homerious/pinslip/releases/latest):

| Platform | File |
|---|---|
| Windows | `PinSlip-Setup-x.x.x.exe` |
| macOS (Apple Silicon) | `PinSlip-x.x.x-arm64.dmg` |
| macOS (Intel) | `PinSlip-x.x.x.dmg` |
| Linux | `PinSlip-x.x.x.AppImage` / `pinslip_x.x.x_amd64.deb` |

Once installed, new versions are offered automatically through in-app updates.
Builds based on Electron 45 require macOS 13 Ventura or later.
macOS builds are not signed yet — if macOS says the app is "damaged", right-click
→ Open, or run `xattr -cr /Applications/PinSlip.app` after installing.

The interface speaks 简体中文 / English / 日本語 / 한국어 / Deutsch / Français /
Español — switch anytime in settings.

## Quick Start

Requirements:

- Node.js >= 22.12
- pnpm >= 8 (or substitute `npx pnpm` for every `pnpm` command)
- Go >= 1.22 (on PATH, or point the `PINSLIP_GO` env var at the go binary)
- macOS 13 Ventura or later when running the macOS build from this source

```bash
# Install dependencies
pnpm install
pnpm --filter @pinslip/desktop exec install-electron

# Dev mode: launch Electron (the main process spawns the Go service)
pnpm dev

# Build the Go service (also copies the binary to apps/desktop/resources/service/)
pnpm build:service

# Build the desktop bundles
pnpm build

# Package installers (run build:service first; --win / --mac / --linux)
pnpm dist

# Type check
pnpm typecheck
```

## Project Layout

```
pinslip/
├── apps/
│   ├── desktop/          # Electron + React desktop app (pnpm workspace member)
│   ├── service/          # Go local service (standalone go.mod, MCP server built in)
│   └── extension/        # Browser extension (Chrome / Firefox)
├── docs/                 # Docs (user guide / CHANGELOG / API contract)
├── skills/               # The pinslip skill that teaches AI agents to use MCP
├── scripts/              # Orchestration scripts (dev / build-service)
└── Makefile              # Cross-language orchestration entry
```

## Architecture Notes

- **Windowing goes through IPC**: renderers call window management via
  `window.api.*` (a preload whitelist)
- **Notes use local HTTP.** The Go service prefers `127.0.0.1:17639` and falls back
  to an available port. The main process passes the port and desktop session credential to renderers through `runtime:info`.
- **Markdown files are the single source of truth**: SQLite FTS5 is only an
  index, rebuilt in full at startup with fsnotify watching as a safety net
- **Git sync and MCP run in the local Go service.** Git sync is optional. Local
  MCP access is enabled by default and can be turned off in the vault’s settings.
- The Go service binds to loopback only; data defaults to
  `%USERPROFILE%\Documents\PinSlip\` (override with `PINSLIP_DATA_DIR`)

## Docs

- [User Guide](docs/user-guide.md) — feature tour (first use → daily use →
  organizing → advanced)
- [CHANGELOG](docs/CHANGELOG.md) — release history
- [API Contract](docs/api.md) — local service HTTP endpoints

## Contributors

Built by [@homerious](https://github.com/homerious), with love from the community 💛

[<img src="https://github.com/Gaald.png?size=48" width="48" alt="Gaald">](https://github.com/Gaald)
[<img src="https://github.com/Keyhabit.png?size=48" width="48" alt="Keyhabit">](https://github.com/Keyhabit)
[<img src="https://github.com/onemast.png?size=48" width="48" alt="onemast">](https://github.com/onemast)
[<img src="https://github.com/BigHairyWookie.png?size=48" width="48" alt="BigHairyWookie">](https://github.com/BigHairyWookie)

## License

MIT
