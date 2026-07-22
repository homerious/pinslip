# PinSlip

[简体中文](README.md) | **English**

> A little note-taking companion we hope you'll reach for every day.

PinSlip is a small sticky note that lives on your desktop. Whenever something
crosses your mind, jot it down and pin it to the edge of your screen — it will
quietly keep you company. Every note is an ordinary Markdown file in a folder
you choose — **fully interoperable with Obsidian**. Your words stay yours.

Current version: **v0.5.0** ([Changelog](docs/CHANGELOG.md))

[![Release](https://github.com/homerious/pinslip/actions/workflows/release.yml/badge.svg)](https://github.com/homerious/pinslip/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/homerious/pinslip)](https://github.com/homerious/pinslip/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/homerious/pinslip/blob/main/LICENSE)

## Say hi to PinSlip

**An everyday note, right on your desktop**
No heavy app to launch, no "where should I save this?" moment. Pin a note to
your screen and it's simply there when you need it. Six warm colors to pick
from; fold it into a slim title bar when you're done, unfold it when you're back.

**Want it a little prettier? Try Markdown**
Plain scribbles are perfectly fine. But when you feel like tidying up — a to-do
list, a few sections with little headings — type in Markdown and watch the
formatting come alive. Task boxes are click-to-check, and screenshots paste in
with Ctrl+V. You'll never wonder where the image files went.

**Toss them around — they still line up**
No need to tidy up by hand. Fold a note away for later; pinned notes sit neatly
in any screen corner; notes gently snap to each other when they get close; and
they can form a little "squad" — the whole squad moves and resizes together,
and when one note folds, the ones below shuffle up to fill in.

**Your words belong to you**
Everything is stored locally, in your own folder — no cloud in the middle.
Even if you stop using PinSlip one day, every note is still right there:
just a plain Markdown file, ready to open in Obsidian, VS Code, or any
Markdown-friendly editor, and pick up where you left off.

**Jotted in a hurry, found in a second**
Wrote something down quickly and need it later? Just search. Tags and folders
keep things grouped, full-text search works great with Chinese too, and matched
words light up for you. Deleted something by accident? It's waiting in the
recycle area — bring it back anytime.

**A few more small thoughts**
It keeps you company in the system tray; `Ctrl+Shift+N` captures a thought from
anywhere; it starts with your computer, and every note reopens exactly where
you left it.

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
