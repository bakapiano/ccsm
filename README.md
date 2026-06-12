# ccsm — Claude Code Session Manager

A single pane over every Claude / Codex / Copilot CLI session on your
machine. Each session runs inside the page (xterm.js + a PTY pool in
the local backend), gets recorded by filesystem folder, and resumes in
that folder when you click it again.

[![open](https://img.shields.io/badge/open-bakapiano.github.io%2Fccsm-1a1815?style=flat-square)](https://bakapiano.github.io/ccsm/)

```
┌── browser ─────────────────────────┐
│  https://bakapiano.github.io/ccsm/  ← version router
│                  ↓
│  /ccsm/X.Y.Z/   ← per-version frontend (pinned to your backend)
└────────────┬───────────────────────┘
             │  fetch /api/*   (CORS)
             │  ws://localhost:7777/ws/*
             ▼
┌── local backend ───────────────────┐
│  ccsm (npm bin)                    │
│   ├── /api/sessions  /api/sessions/new   │
│   ├── /api/sessions/:id/resume     │
│   ├── /api/version  /api/upgrade   │
│   ├── /ws/terminal/:id (PTY)       │
│   └── /api/health  /api/heartbeat  │
└────────────────────────────────────┘
```

## What it does

- **Runs every CLI session in the page.** `claude`, `codex`, `copilot`
  or any custom command, in an xterm.js panel. Switch sessions in the
  sidebar; the PTY keeps running in the backend.
- **Folder-level resume.** ccsm stores the CLI and `cwd` for each
  session. Click a stopped session later and ccsm launches the CLI in
  that folder using either the configured "resume latest" command or
  the CLI's resume picker.
- **Workspaces + clones.** "New session" picks an unused workspace
  under your work-dir, clones selected repos with live `git clone
  --progress` streamed to per-repo progress bars, and opens a fresh CLI
  in the single selected repo or at the workspace root for zero/multiple
  repos. Or pick any existing folder via the file browser.
- **Folders.** Drag sessions into named folders for organisation.
- **In-app upgrade.** About page checks npm for newer versions of
  ccsm and offers a one-click upgrade button. Backend self-restarts.

## Install

```bash
npm i -g @bakapiano/ccsm
```

This:
- puts `ccsm` on your PATH
- registers a `ccsm://` URL protocol so the hosted frontend can wake
  the backend with one click

`npx @bakapiano/ccsm` works too for a one-shot trial — the protocol
still gets registered.

## Use

```bash
ccsm                       # starts the backend, opens the frontend
```

Or just visit **https://bakapiano.github.io/ccsm/** in any browser.
If the backend isn't running, the router shows a "Backend not running"
banner with a **Start ccsm** button — click it, Windows asks once
whether to open the `ccsm://` handler (check "Always allow"), and the
backend spawns silently behind the page. The router auto-reconnects in
1-2s and redirects to the frontend matching your installed backend
version.

### Install as PWA

In Chrome / Edge, click the install icon in the address bar (or use the
"Install ccsm" button on the **About** tab inside the app). The PWA gets
its own window, its own icon, and Window Controls Overlay so the title
bar blends into the page.

After installing, clicking the PWA icon is the new entry point — no
terminal needed.

## Defaults

| | |
|---|---|
| Port | `7777` (auto-bumps if taken) |
| Work dir | `~/ccsm-workspaces` (each subdirectory holds one or more repo clones) |
| Built-in CLIs | `claude`, `codex`, `copilot` — add your own via the **Configure** tab |
| Resume behavior | `latest` by default; switch to `picker` in **Configure** |
| Data dir | `~/.ccsm/` (override with `CCSM_HOME=<path>`) — survives upgrades and npx cache wipes |

All of the above are editable through the **Configure** tab.

## Layout

```
ccsm/
├── server.js                 # Express + WebSocket; API only in prod
├── bin/ccsm.js               # launcher · detaches server, opens browser
├── scripts/
│   ├── install.js            # postinstall · registers ccsm:// (Windows)
│   └── uninstall.js          # preuninstall · cleanup
├── lib/
│   ├── persistedSessions.js  # ~/.ccsm/sessions.json — the source of truth
│   ├── folders.js            # sidebar tree
│   ├── workspace.js          # ws-N allocation + repo clones
│   ├── webTerminal.js        # node-pty pool · WebSocket bridge
│   ├── jsonStore.js · config.js
├── pages-root/               # → GH Pages /  (version router)
└── public/                   # → GH Pages /<pkg.version>/  (per-version frontend)

~/.ccsm/                       # or $CCSM_HOME
├── config.json
├── sessions.json              # persisted sessions
├── folders.json
├── server.log
└── browser-profile/           # Edge/Chrome --user-data-dir
```

## How "wake on click" works

The hosted frontend lives entirely in the browser sandbox — it cannot
spawn processes. So when the backend is down, the OfflineBanner's
**Start ccsm** is a plain `<a href="ccsm://start">`. The OS hands that
off to a per-user URL protocol handler registered at install time:

```
HKCU\Software\Classes\ccsm\shell\open\command
  → wscript.exe "<LOCALAPPDATA>\ccsm\launcher.vbs" "%1"
```

The `.vbs` calls `ccsm.cmd "ccsm://start"` with `WindowStyle = 0`. That
gets to `bin/ccsm.js`, which parses the protocol URL, spawns
`server.js` detached, and exits. Zero windows ever flash.

First click triggers a one-time Windows dialog ("Open ccsm.cmd?"). Tick
**Always allow** and future clicks are silent.

## Lifecycle (when does the backend die)

| trigger | reaction |
|---|---|
| The auto-opened browser window closes | wait 12s · if any other client heartbeats during that window, stay alive; otherwise gracefulShutdown |
| No heartbeat for 90s | gracefulShutdown |
| `POST /api/shutdown` | gracefulShutdown |
| `POST /api/upgrade` after install | self-respawn + gracefulShutdown |
| SIGINT / SIGTERM | gracefulShutdown |

## Dev

```bash
git clone https://github.com/bakapiano/ccsm
cd ccsm
npm install
CCSM_NO_BROWSER=1 CCSM_KEEP_ALIVE=1 node server.js
# opens http://localhost:7777 with hot-reload (public/ is served locally
# and SSE pushes a reload event on every file save)
```

Dev mode is detected via `__dirname.includes('node_modules')` — when
running from a checkout, the backend also serves `public/`. In an
npm-installed copy it's API-only, and you use the hosted frontend.

## Versioning (frontend ↔ backend)

The hosted root (`/ccsm/`) is a tiny static **version router**: it
probes `localhost:7777/api/health`, then redirects you to
`/ccsm/<backend.version>/`. Each release publishes a fresh
per-version subdir; old ones stay forever. No semver-compat logic — a
frontend is always 1:1 with the backend it was built against.

If your backend gets upgraded under a still-loaded page, the
per-version frontend detects the mismatch on its next probe and
bounces you back through the router automatically.

## Status

- Backend: Windows-first. macOS / Linux backend ports planned (URL
  protocol registration is the only platform-specific install piece).
- Frontend: cross-platform (pure web).

See [CLAUDE.md](CLAUDE.md) for design decisions and the non-obvious
gotchas baked into the launcher, session lifecycle, and workspace code.
