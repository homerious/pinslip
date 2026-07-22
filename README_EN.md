# PinSlip

[简体中文](README.md) | **English**

> Pinned desktop sticky notes + local knowledge management + open AI access

PinSlip is a "pin it on your screen" sticky notes app for Windows: jot something down,
pin it, and walk away. Every note is a plain Markdown file stored in a folder you
choose — **fully interoperable with Obsidian**. Your notes are never locked into
any format.

Current version: **v0.5.0** ([Changelog](docs/CHANGELOG.md))

[![Release](https://github.com/homerious/pinslip/actions/workflows/release.yml/badge.svg)](https://github.com/homerious/pinslip/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/homerious/pinslip)](https://github.com/homerious/pinslip/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/homerious/pinslip/blob/main/LICENSE)

## How you'll use it

**Write it, pin it, walk away**
Notes are frameless cards pinned to your screen: always-on-top, six colors,
and they fold into a slim title bar when you're done. Close the app, reopen it —
everything is right where you left it.

**Markdown without the syntax lessons**
Headings, lists, and clickable task checkboxes are all WYSIWYG. Paste a
screenshot with Ctrl+V — images are saved to an attachments folder next to
your notes automatically.

**Never messy, never lost**
Notes snap neatly to each other when they get close; drag one toward the screen
edge and it's pulled back into the safe area — a note can never slide off-screen
and disappear. Overlap two pinned notes halfway, let go, and they **group**:
a tidy left-aligned stack that drags as one, reflows when one note is folded,
and can be given a name.

**Your notes open in anything**
Each note is a `title-date-id.md` file: YAML frontmatter + Markdown body.
Keep writing in Obsidian, edit in VS Code — PinSlip follows external changes
in real time. Images use relative paths, so moving folders won't break them.

**Find things without remembering**
Tags, nested folders, and full-text search (Chinese bigram + BM25 weighting,
with match highlighting). Three views in the main window: list / folders / tags.
Deleted notes go to a recycle area — you decide how long they're kept, and you
can fish anything back.

**Always within reach**
Lives in the system tray, `Ctrl+Shift+N` quick capture from anywhere,
launch at login.

## Getting started

Requirements:

- Node.js >= 18 (20+ recommended)
- pnpm >= 8 (or replace every `pnpm` command with `npx pnpm`)
- Go >= 1.22 (on PATH, or set `PINSLIP_GO` to the go binary)

```bash
# Install dependencies
pnpm install

# Dev mode: launches Electron (the main process spawns the Go service)
pnpm dev

# Build the Go service (also copies the binary into apps/desktop/resources/service/)
pnpm build:service

# Build the desktop app
pnpm build

# Produce the Windows installer (runs build:service first)
pnpm dist

# Type check
pnpm typecheck
```

## Project layout

```
pinslip/
├── apps/
│   ├── desktop/          # Electron + React desktop app (pnpm workspace member)
│   └── service/          # Go local service (standalone go.mod)
├── docs/                 # Docs (user guide / CHANGELOG / API contract)
├── scripts/              # Orchestration scripts (dev / build-service)
└── Makefile              # Cross-language entry point
```

## Architecture notes

- **Windowing goes through IPC**: the renderer calls window management via
  `window.api.*` (a preload allowlist)
- **Note data goes over HTTP**: the renderer fetches the Go service directly
  (`127.0.0.1:<random port>`); the port is parsed from the service's stdout by
  the main process and handed to renderers via IPC `runtime:info`
- **Markdown files are the single source of truth**: the SQLite FTS5 index is
  disposable — full rebuild on startup plus fsnotify watching
- The Go service binds to loopback only; data defaults to
  `%USERPROFILE%\Documents\PinSlip\` (override with `PINSLIP_DATA_DIR`)

## Docs

- [User guide](docs/user-guide.md) — feature walkthrough (first run → daily use → organizing → advanced)
- [CHANGELOG](docs/CHANGELOG.md) — version history
- [API contract](docs/api.md) — local service HTTP API

## License

MIT
