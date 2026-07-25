# PinSlip

[简体中文](README.md) | **English**

> **Capture now. Organize later.**

PinSlip is a tiny sticky note pinned to your desktop. Jot something down whenever
it crosses your mind, pin it to a screen edge, and it quietly keeps you company.
Every note is a plain Markdown file living in a folder you choose — **fully
interoperable with Obsidian**. Your words always belong to you.

Current version: **v1.0.1** ([Changelog](docs/CHANGELOG.md))

[![Release](https://github.com/homerious/pinslip/actions/workflows/release.yml/badge.svg)](https://github.com/homerious/pinslip/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/homerious/pinslip)](https://github.com/homerious/pinslip/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/homerious/pinslip/blob/main/LICENSE)

## Meet PinSlip

**An everyday sticky note for your desktop**
No heavy app to launch, no "where should I save this" to think about. Pin a note
on screen, write, and it saves itself. Six colors to pick from; when you're done,
fold it into a slim title bar and unfold it whenever you need it again.

**Want nicer formatting? Try Markdown**
Plain scribbles are perfectly fine. But when you feel like tidying up — a to-do
list, a few headed sections — type in Markdown and watch the layout come alive.
Task boxes tick with a click, and screenshots drop straight in with Ctrl+V;
you never have to think about where images are stored.

**Toss them anywhere, still tidy**
A crowd of notes never means a mess. Fold the ones you don't need for now;
pinned notes dock neatly against screen corners; nearby notes gently snap into
alignment like magnets; and they can form a little "squad" — move the whole
column together, resize it together, and when you fold one, the notes below
slide up to fill the gap.

**Your words belong to you**
All notes live in your own local folder — no cloud in the way. Even if you stop
using PinSlip one day, every note stays right where it is: an ordinary Markdown
file, readable by Obsidian, VS Code, or any Markdown-friendly editor, ready for
you to keep writing.

**Jotted in a flash, found in a flash**
Wrote something down days ago? Just search. Tags and folders help the organized
among you; full-text search has your back when you only remember the content.
Deleted something by accident? The recycle zone keeps it safe until you fish
it back out.

**More than one computer? Your notes can follow you**
Point PinSlip at your own git repository (GitHub, GitLab, or CNB) in settings,
and your notes sync there on a schedule. New machine? Pull and keep writing.
If both sides edited the same note, you can compare the two versions right
inside the sticky note and keep the one you like.

**Your AI assistant can take notes too**
PinSlip ships with a built-in MCP server, so your AI assistant can search, read,
and write notes for you. It listens on localhost only and is off by default —
whether to turn it on is entirely up to you.

**See something good on the web? Clip it in one click**
The Chrome and Firefox extensions are ready: selected text, images, or whole
articles (thanks to Readability) become sticky notes with a click, and region
screenshots work too. For now they are side-loaded from the source directory;
store listings are on the way.

## Download

Grab the right build from [Releases](https://github.com/homerious/pinslip/releases/latest):

| Platform | File |
|---|---|
| Windows | `PinSlip-Setup-x.x.x.exe` |
| macOS (Apple Silicon) | `PinSlip-x.x.x-arm64.dmg` |
| macOS (Intel) | `PinSlip-x.x.x.dmg` |
| Linux | `PinSlip-x.x.x.AppImage` / `pinslip_x.x.x_amd64.deb` |

Once installed, new versions are offered automatically through in-app updates.
macOS builds are not signed yet — if macOS says the app is "damaged", right-click
→ Open, or run `xattr -cr /Applications/PinSlip.app` after installing.

The interface speaks 简体中文 / English / 日本語 / 한국어 / Deutsch / Français /
Español — switch anytime in settings.

## Quick Start

Requirements:

- Node.js >= 18 (20+ recommended)
- pnpm >= 8 (or substitute `npx pnpm` for every `pnpm` command)
- Go >= 1.22 (on PATH, or point the `PINSLIP_GO` env var at the go binary)

```bash
# Install dependencies
pnpm install

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
- **Note data goes over HTTP**: renderers fetch the Go service directly
  (`127.0.0.1:<random port>`); the port is parsed from the service's stdout by
  the main process and handed down via the `runtime:info` IPC channel
- **Markdown files are the single source of truth**: SQLite FTS5 is only an
  index, rebuilt in full at startup with fsnotify watching as a safety net
- **Sync is an optional extra**: git sync (go-git + three-way merge) and the
  MCP server both live inside the Go service, off by default, enabled in settings
- The Go service binds to loopback only; data defaults to
  `%USERPROFILE%\Documents\PinSlip\` (override with `PINSLIP_DATA_DIR`)

## Docs

- [User Guide](docs/user-guide.md) — feature tour (first use → daily use →
  organizing → advanced)
- [CHANGELOG](docs/CHANGELOG.md) — release history
- [API Contract](docs/api.md) — local service HTTP endpoints

## License

MIT
