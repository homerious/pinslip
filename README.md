# PinSlip

[Website](https://pinslip.app/) · [简体中文](README_CN.md)

> **Capture now. Organize later.**

PinSlip is a tiny sticky note pinned to your desktop. Jot something down when
it crosses your mind, tuck it against a screen edge, and it quietly keeps you
company. Every note is an ordinary Markdown file in a folder you choose, ready
to open in Obsidian or VS Code. PinSlip runs on Windows, macOS, and Linux.

[![Release](https://github.com/homerious/pinslip/actions/workflows/release.yml/badge.svg)](https://github.com/homerious/pinslip/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/homerious/pinslip)](https://github.com/homerious/pinslip/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/homerious/pinslip/blob/main/LICENSE)

## Meet PinSlip

### An everyday sticky note for your desktop

Pin a note above your other windows, start writing, and it saves itself. Pick
from six colors so a to-do list, a temporary address, and the notes for your
current project are easy to tell apart. Fold a note down to a slim title bar
when you're done, then unfold it when you need it again.

### Toss them anywhere, still tidy

Drag a note to a screen edge and it snaps into place. Two pinned notes can snap
together like magnets. Stack related notes into a little group, then move the
whole stack or give them all the same width. Fold one and the notes below slide
up to fill the gap. Reopen PinSlip and your notes are where you left them, groups
and all.

### Want nicer formatting? Try Markdown

Jot down a few lines or give them headings, a table, or a to-do list you can tick
off as you go. Add or remove table rows and columns as you need them. Paste a
screenshot or drop an image in from your file manager. Paste a block of Markdown
and watch it take shape. Paste a standalone web address or Windows file path and
it keeps its original text.

### Give it a name, give the text a little room

Let PinSlip pick a title from what you write, or give a fresh note a name before
you type a word. Zoom in on a note's text without changing the size of the window.
If you write in Arabic or Hebrew, PinSlip can detect the writing direction, or you
can choose the direction for an individual note.

### Send someone that note

Copy the note as an image to share it in a chat, or save it as a PNG. When you want
the words, Copy All gives you a choice of Markdown or plain text. The copy button
on a table lets you paste the rows and columns straight into Excel.

### Your words belong to you

Your notes and image attachments live in a local folder you choose. Every note
is an ordinary Markdown file. Open the same folder in Obsidian or VS Code and
keep writing. When you want a backup, copy the whole folder.

### Jotted in a flash, found in a flash

Only remember one line from a few days ago? Search titles, tags, and note contents
in the manager, and PinSlip highlights the matching words. Expand a Markdown
preview to see tables and local images right in the manager. Already in a note and
looking for a particular line or fixing a name throughout? Use Find and Replace
inside the note.

### Ready to tidy up? Just drag it there

Nest folders, drag notes out of the inbox into the right one, and get suggestions
for tags you've used before as you type. Need to track down a file? Open Note
Info to see its folder, creation and save times, and note ID. If you delete
something by accident, you can fish it out of the recycle area.

### Catch a thought before it goes

Open Quick Capture with a global shortcut, type a few lines or paste a
screenshot, and send it to the inbox. Press `Ctrl+Enter` to save and keep the
window open for the next thought. Give each entry its own note or collect the
day's captures in one place. You can change the shortcut in settings.

### See something good on the web? Clip it in one click

Save a selection, a link, the text of an article, or a screenshot of the visible
page with the Chrome or Firefox extension. Clipped articles become Markdown
notes with a link back to the source. Just want to jot down a line? Open Quick
Capture from the extension icon.
Generate a pairing code in PinSlip's Browser Clipping settings and enter it once
in the extension. You can revoke access from those settings any time.

### More than one computer? Your notes can follow you

Connect your own Git repository and sync on a schedule or whenever notes change.
Pull them down on another computer and keep writing. Edits to different
paragraphs can merge automatically. If both copies changed the same passage,
compare the versions in the note window and choose or edit what to keep. The
note toolbar shows the sync status. If you restore from the remote repository,
PinSlip backs up your local notes and attachments first.

### Your AI assistant can take notes and tidy them up

Connect a local MCP client to find and read notes, write a new one, or add a few
lines to an old one. Ask it to rename or tag notes, move them, manage folders, or
drop a quick capture into your inbox. PinSlip checks the note's version before
renaming, tagging, or moving it. If you've edited it in the meantime, the client
has to read it again. MCP accepts local connections. You can copy the
connection settings from PinSlip or turn the service off there.
[MCP setup and tools](skills/pinslip/SKILL.md)

### Set up your desktop the way you like it

In Advanced Settings, put your favorite toolbar buttons first, switch the manager
to dark mode, or have it remember the size and position you gave it. PinSlip can
start with your computer and bring back your notes while leaving the manager
tucked away in the tray. You can also set a separate shortcut for a new note
and have it start with the text you just copied.

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
[<img src="https://github.com/ZeroFlagLabs.png?size=48" width="48" alt="ZeroFlagLabs">](https://github.com/ZeroFlagLabs)

## License

MIT
