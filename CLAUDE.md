# ccsm — Claude Code Session Manager

A small Node/Express + Preact web tool that runs every Claude/Codex/
Copilot CLI session inside a single web app. PTYs live in-process
(node-pty), sessions persist across restarts, and `--resume <uuid>`
reattaches to the exact upstream conversation.

## Why this exists

When you're running 8–10 concurrent `claude` sessions across ad-hoc
clones (`D:\proj`, `D:\proj2`, `…`, plus GUID worktree dirs), it's easy
to lose track of which terminal is which session. ccsm gives an
at-a-glance sidebar, organises sessions into folders, and `--resume`s
each one in the same xterm.js panel.

## Architecture: hosted frontend + local backend

The frontend is **not** bundled in the npm package — it's hosted on
GitHub Pages and matched to your installed backend version through a
version router.

```
┌── browser ────────────────────────────┐
│  https://bakapiano.github.io/ccsm/    ← version router (tiny)
│                       ↓
│  https://bakapiano.github.io/ccsm/X.Y.Z/  ← per-version frontend
└────────────┬──────────────────────────┘
             │  fetch /api/*   (CORS, allow-list)
             │  ws://localhost:7777/ws/*
             ▼
┌── local backend ──────────────────────┐
│  npm i -g @bakapiano/ccsm             │
│  ccsm                                  │
│   ├── /api/sessions  /api/sessions/new │
│   ├── /api/sessions/:id/resume         │
│   ├── /ws/terminal/:id (PTY)           │
│   ├── /api/version  /api/upgrade       │
│   ├── /api/heartbeat /api/health       │
│   └── /api/shutdown                    │
└───────────────────────────────────────┘
```

**Version routing.** GH Pages root (`/ccsm/`) hosts a tiny static
router (`pages-root/index.html`) that probes `localhost:7777/api/health`
and redirects to `./<backend.version>/`. Each release publishes a fresh
`/ccsm/<X.Y.Z>/` subdir; old ones stay forever via the workflow's
`keep_files: true`. Result: a 1:1 frontend↔backend version pin, no
semver-compat logic, and old backends keep working indefinitely.

Each per-version frontend has its version baked into a `<meta
name="ccsm-frontend-version">` at deploy time (injected by the GH Pages
workflow). On boot it re-fetches `/api/health` and bounces back through
the router via `location.replace('../')` if the backend has since been
upgraded.

When the backend is offline the router itself shows a "Start ccsm" UI
with a `ccsm://start` link (same protocol-handler trick we already
register at install time). No need to redirect to a stale version.

**Dev mode.** When running from a checkout (`__dirname` not under
`node_modules`), the backend ALSO serves `public/` so contributors can
iterate at `localhost:7777/` without pushing. In dev there's no
`<meta>` tag → the version guard no-ops.

## Run

```powershell
# install once
npm install -g @bakapiano/ccsm

# then anywhere
ccsm
```

`ccsm` opens the version router in a chromeless Edge `--app=` window.
Terminal returns immediately (the server is spawned detached). Close
the window → server saves a final snapshot of state and exits within
~12s.

If you don't want the auto-opened window (e.g. you live in the PWA),
just visit `https://bakapiano.github.io/ccsm/` — when backend is
down you see the inline OfflineBanner with a **Start ccsm** button.

Default port `7777`, default workDir `~/ccsm-workspaces`. Config +
state live at `~/.ccsm/` (override with `CCSM_HOME=<path>`). All
settings editable through the Configure page
(`~/.ccsm/config.json` on disk). Notable knobs:

- `port` (default `7777`) — preferred listen port. If taken, ccsm tries `+1..+9` then asks the OS for any free port.
- `resumeMode` (default `latest`) — `latest` uses each CLI's `resumeLatestArgs`; `picker` uses `resumePickerArgs`.
- `clis` — array of CLI definitions. Built-ins for `claude`, `codex`, `copilot`; users can add `other` CLIs with custom `command`, `args`, `resumeLatestArgs`, `resumePickerArgs`, `shell` (direct/pwsh/cmd).
- `defaultCliId` — which CLI the Launch page pre-selects.

## ccsm:// protocol · "wake on click"

The hosted frontend can't spawn processes (sandboxed). For "click to
wake backend" we register a per-user URL protocol handler on Windows:

```
HKCU\Software\Classes\ccsm\shell\open\command
  → wscript.exe "<LOCALAPPDATA>\ccsm\launcher.vbs" "%1"
```

`launcher.vbs` uses `Shell.Run(..., 0, False)` — windowstyle 0 means the
spawned `ccsm.cmd` runs **completely hidden**. No console flash. The
`.cmd` goes through `bin/ccsm.js`, which detects `ccsm://start` in argv,
spawns `server.js` detached with `CCSM_NO_BROWSER=1`, and exits.

The router's "Start ccsm" button (and OfflineBanner inside each
per-version frontend) is just `<a href="ccsm://start">`. First click
triggers a one-time Windows confirmation dialog ("Open ccsm.cmd?");
ticking "Always allow" makes it silent thereafter.

postinstall (`scripts/install.js`) registers the protocol
unconditionally on Windows — including npx-cache installs. The path
stored in the registry points at whatever `ccsm.cmd` location npm gave
us (`<prefix>/ccsm.cmd` from `npm config get prefix`).

## In-app upgrade

About page surfaces the installed version, polls
`registry.npmjs.org/@bakapiano%2Fccsm/latest` (cached 30 min) for the
latest published version, and offers an **Upgrade** button when newer.
`POST /api/upgrade` spawns `npm i -g @bakapiano/ccsm@latest` detached,
then on success spawns a fresh `ccsm` (also detached) and
gracefulShutdowns. The OfflineBanner appears briefly; the router then
picks up the new version on its next probe.

The `target` field is regex-validated (`/^[a-z0-9.+\-^~]+$/i`) before
the spawn — npm install doesn't shell out, but defends against argv
weirdness regardless. Concurrent calls return `409`.

## Lifecycle

Single `gracefulShutdown(reason)` function in `server.js` is the only
exit path. It kills any PTY children, then `process.exit(0)`. Every
trigger funnels here:

| trigger | path |
|---|---|
| auto-spawned browser window closes | `child.on('exit')` — see smart-kill below |
| `POST /api/shutdown` | from npm uninstall, from launcher's auto-upgrade |
| `POST /api/upgrade` after install completes | self-restart |
| SIGINT / SIGTERM | OS signals |
| heartbeat watchdog timeout | 90s with no heartbeat, only when launched via `bin/ccsm.js` |

**Smart browser-exit**: when the spawned browser child dies, we don't
kill immediately. Two filters:

1. **Fast-exit (<5s)** — Edge `--app=` often hands the URL off to an existing Edge profile process group and the spawned child dies milliseconds after creation. We ignore any exit inside the first 5s.
2. **Deferred multi-client check (12s)** — after a real close, wait 12s and check if any heartbeat arrived AFTER the close timestamp. If yes, a hosted-frontend tab (or another window) is keeping us busy, stay alive. If no, gracefulShutdown.

Frontend heartbeat cadence is 10s (in `main.js`), so one full cycle
fits inside the 12s decision window.

Environment overrides:
- `CCSM_KEEP_ALIVE=1` → disable both browser-exit hook and heartbeat watchdog. For automation hosts.
- `CCSM_LAUNCHER=1` → set by `bin/ccsm.js` when it spawns the server; enables the heartbeat watchdog.
- `CCSM_NO_BROWSER=1` → set by the launcher when handling a `ccsm://` click or by `/api/upgrade` self-respawn; suppresses the server's auto-open browser.
- `CCSM_NO_DEV=1` → suppress dev-mode features (static serving, hot-reload SSE) even when running from a checkout.

## Sessions: persisted and resumed

There's **one source of truth**: `~/.ccsm/sessions.json`, managed by
`lib/persistedSessions.js`. Every session ccsm starts goes in there
with `{ id, cliId, cwd, workspace, title, folderId, repos,
status, cliSessionId, … }`. The persisted `id` is ccsm-owned and
matches the PTY id; `cliSessionId` is the upstream CLI's own session id
when ccsm can discover it.

**Exact resume when available.** ccsm spawns a CLI but none of the
known CLIs put their upstream session id on the command line. The
binding scanner in `lib/sessionBinding.js` watches each CLI's runtime
traces and persists the discovered id on the session record. Resume
prefers `cli.resumeIdArgs` when `cliSessionId` is present, replacing
`<id>` with that upstream id. If no exact id is known, or the CLI has no
resume-by-id template, ccsm falls back to one of two folder-level
templates at the record's `cwd`:

- `resumeMode: 'latest'` -> `cli.resumeLatestArgs`
- `resumeMode: 'picker'` -> `cli.resumePickerArgs`

Built-ins default to:

- Claude: exact `--resume <id>`, latest `--continue`, picker `--resume`
- Codex: exact `resume <id>`, latest `resume --last`, picker `resume`
- Copilot: exact `--resume=<id>`, latest `--continue`, picker `--resume`

User-added `other` CLIs can leave those arrays empty if they do not
support resume, or set the templates explicitly.

**Shared work folders.** Records are not unique by cwd. Launching the
same CLI in the same folder creates another ccsm session record and a
separate PTY. Multiple sessions may share one work folder; delete is
still blocked for a workspace while any persisted session's `cwd` lives
inside it.

**Auto-resume.** SessionsPage doesn't show a "Resume" button. On
mount, if the active session's status isn't `running`, it calls
`resumeSession()`. `resumeSession()` in `api.js` keeps a per-id
in-flight Map so the same call from Sidebar.onClick and the
SessionsPage effect collapse into a single backend hit.

## Layout

```
ccsm/
├── server.js                     # Express + WebSocket; API-only in prod
├── bin/ccsm.js                   # launcher · detach, wake-on-protocol,
│                                 # auto-upgrade-restart, first-run hint
├── scripts/
│   ├── install.js                # postinstall · ccsm:// + launcher.vbs
│   └── uninstall.js              # preuninstall · cleanup + /api/shutdown
├── lib/
│   ├── persistedSessions.js      # ~/.ccsm/sessions.json — source of truth
│   ├── folders.js                # ~/.ccsm/folders.json — sidebar tree
│   ├── codexSeed.js              # Codex CODEX_HOME probe + bundled light theme install
│   ├── workspace.js              # ws-N allocation under workDir, repo clones
│   ├── webTerminal.js            # in-process PTY pool · node-pty + WebSocket
│   ├── jsonStore.js              # shared keyed-JSON store factory
│   └── config.js                 # loadConfig / saveConfig + DATA_DIR
├── pages-root/                   # pushed to GH Pages /
│   ├── index.html                # version router · probe localhost, redirect
│   ├── manifest.webmanifest      # PWA · stable id, start_url: ./
│   └── favicon.svg
└── public/                       # pushed to GH Pages /<version>/
    ├── index.html                # workflow injects <meta ccsm-frontend-version>
    ├── manifest.webmanifest      # per-version (links back to root scope)
    ├── favicon.svg
    ├── js/
    │   ├── backend.js            # httpBase() / wsBase() — same-origin local, cross-origin hosted
    │   ├── main.js               # boot · version guard · clock · heartbeat
    │   ├── state.js              # signals
    │   ├── api.js                # fetch wrapper + loaders + dedup-aware resumeSession
    │   ├── streaming.js          # NDJSON clone-progress stream
    │   ├── dialog.js · toast.js  # ccsmConfirm / ccsmPrompt / setToast
    │   ├── html.js · icons.js · util.js
    │   ├── components/
    │   │   ├── App.js · Sidebar.js · PageTitleBar.js
    │   │   ├── ServerStatus.js · Toast.js · OfflineBanner.js · DialogHost.js
    │   │   ├── Card.js · Modal.js · Popover.js · Picker.js · EntityFormModal.js
    │   │   ├── DirectoryPicker.js
    │   │   ├── ProgressList.js · TerminalView.js · useDragSort.js
    │   └── pages/
    │       ├── SessionsPage.js · LaunchPage.js
    │       ├── ConfigurePage.js · AboutPage.js
    └── css/                      # 12 focused stylesheets
        ├── tokens.css · base.css · layout.css
        ├── sidebar.css · cards.css · forms.css
        ├── widgets.css · feedback.css · modal.css
        ├── terminals.css · wco.css · responsive.css

~/.ccsm/                          # or $CCSM_HOME
├── config.json                   # source of truth
├── sessions.json                 # persisted sessions (ccsm id, cliId, cwd, …)
├── folders.json                  # folder tree
├── server.log                    # detached-server stdout/stderr
├── .first-run-shown              # marker so launcher only prints PWA hint once
└── browser-profile/              # Edge/Chrome --user-data-dir when browserMode=app

%LOCALAPPDATA%/ccsm/
└── launcher.vbs                  # silent ccsm:// dispatcher (written by postinstall)

HKCU\Software\Classes\ccsm        # URL protocol registration
```

On first run, if a legacy `<repo>/data/` directory exists and `~/.ccsm/`
is empty, `lib/config.js` copies the old data over (one-time,
idempotent).

## Locked-in design decisions

**Single in-app terminal, no `wt`.** PTYs run in-process via node-pty
and stream to xterm.js over `/ws/terminal/:id`. We dropped the
`wt`-per-session, focus-by-HWND, snapshot-of-live-claudes layer
entirely — too platform-specific and the web terminal handles
everything the old path did.

**Workspace = folder holding multiple repo clones.** Each `ws-N` under
`workDir` contains a subdirectory per cloned repo. CLIs launch at the
single selected repo's directory; with zero or multiple repos selected,
they launch at the workspace root so selected repos are sibling folders.

**Workspace naming.** Auto-allocated names are `ws-1`, `ws-2`, …
(lowest free integer). Hand-named folders under `workDir` are still
picked up. The Launch page's optional **Session name** field sends
`workspaceName`, which creates (or reuses) a folder with that exact name
under `workDir` instead of auto-allocating `ws-N` (sanitized to a single
safe directory segment; blank falls back to `ws-N`).

**Frontend trusts the backend's capability advertisement.**
`/api/capabilities` returns `{ webTerminal: true|false, ... }`. The
frontend uses ONLY features the backend says it has. Breaking changes
ship a new `/ccsm/<X.Y.Z>/` frontend; the router pins users to the
matching version.

**One source of truth for cross-origin.** `public/js/backend.js`
exports `httpBase()` and `wsBase()`. Localhost → same-origin (empty
base). Anything else → `http://localhost:7777`. CORS on the backend
allows `https://bakapiano.github.io` only — never `*`.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET / PUT | `/api/config` | read / replace config |
| GET | `/api/sessions` | list persisted sessions |
| PUT | `/api/sessions/:id` | rename / move to folder |
| DELETE | `/api/sessions/:id` | kill PTY + drop record |
| POST | `/api/sessions/:id/switch-cli` | change the persisted `cliId` for future resumes |
| POST | `/api/sessions/:id/stop` | kill the live PTY but keep the record; sets `manualStopped:true` so UI won't auto-resume |
| POST | `/api/sessions/new` | body `{cliId, cwd?, workspace?, workspaceName?, repos?, folderId?, title?}` — NDJSON stream (workspace · clone-progress · launched) |
| POST | `/api/sessions/:id/resume` | re-spawn at record `cwd` with the configured latest/picker resume args |
| GET | `/api/folders` · POST `/api/folders` · PUT/DELETE `/api/folders/:id` · POST `/api/folders/reorder` | folder CRUD |
| GET | `/api/workspaces` | workspaces under workDir with repo clone status + in-use flag |
| GET | `/api/browse` | directory browser for the Launch page workdir picker |
| GET | `/api/version` | `{ current, latest, updateAvailable, fetchedAt, cached, error? }` (npm registry cached 30 min, `?refresh=1` to bust) |
| POST | `/api/upgrade` | body `{target?}` — `npm i -g @bakapiano/ccsm@<target>` then self-restart |
| GET | `/api/capabilities` | `{ webTerminal: bool, ... }` for frontend feature gating |
| GET | `/api/health` | `{ ok, pid, version, name }` — used by router probe + heartbeat |
| POST | `/api/heartbeat` | called every 10s by the frontend; feeds lifecycle decisions |
| POST | `/api/spawn-browser` | open another browser window into the running server (used by `bin/ccsm.js` for auto-upgrade-restart) |
| POST | `/api/shutdown` | gracefulShutdown — used by uninstall + auto-upgrade |
| WS | `/ws/terminal/:id` | xterm.js bridge to a PTY in the webTerminal pool |
| GET (dev) | `/api/dev/ping` · `/api/dev/reload` | hot-reload SSE (only when running from a checkout) |

`/api/sessions/new` streams **NDJSON** (one JSON object per line). Event
types: `workspace`, `clone-start`, `clone-progress` (phase/percent/
current/total/detail), `clone-line` (raw git stderr line when not a
progress line), `clone-end`, `launched`, `done`. The frontend reads it
with `fetch().body.getReader()` + `TextDecoder` and updates per-repo
progress bars live.

**WebSocket Origin check**: same allow-list as CORS. The upgrade handler
rejects any Origin not in `ALLOWED_ORIGINS` (plus localhost/127.0.0.1).
Browsers always send Origin on WS upgrades.

## Non-obvious gotchas

**Resume is exact-first, cwd-fallback.** When `cliSessionId` is known,
ccsm resumes by upstream id. When it is unknown, ccsm falls back to the
CLI's latest/picker command in the record's `cwd`, so the upstream CLI's
folder-level resume semantics still matter.

**Workspace delete protection is record-scoped.** A workspace can host
multiple sessions, but it cannot be deleted while any persisted
session's `cwd` lives inside it. Auto-allocation still prefers an unused
workspace for new "auto" launches.

**Auto-resume dedup is module-level in api.js.** Sidebar.onClick and
SessionsPage's effect can both fire for the same exited session in the
same tick. `resumeSession()` keeps a per-id in-flight `Map` so the
second caller awaits the first one's promise instead of issuing a
second `/resume`.

**Heartbeat watchdog only when launched.** Set via `CCSM_LAUNCHER=1` by
`bin/ccsm.js`. If you start `server.js` directly (e.g. dev), the
90-second timeout doesn't apply — convenient when stepping through
code, but you have to ctrl-c yourself when done.

**ccsm:// silent dispatch.** Direct registration of `ccsm.cmd` as the
protocol handler causes a brief console window flash (cmd hosts the
.cmd file). The wscript.exe + .vbs wrapper avoids it entirely — wscript
is a Windows-subsystem host (no console) and `Shell.Run(..., 0, False)`
launches the target hidden. The `.vbs` is generated at install time
with the correct ccsm.cmd path baked in.

**Edge --app handoff race.** When the user has an existing Edge profile
process running, `--app=URL --user-data-dir=DIR` against the same DIR
may cause the new msedge.exe to immediately exit after handing the URL
off to the existing process. Our child handle dies milliseconds after
spawn. The lifecycle hook ignores any browser-child exit inside the
first 5s for exactly this reason.

## Frontend design language

The UI deliberately copies **claude.ai's** calm light aesthetic — warm
cream surfaces, generous spacing, soft borders, **no orange highlights**.
The brand orange `#b3614a` survives only in the brand mark / wordmark
dot. Every other "highlight" use (selection, focus rings, dirty
indicators, progress bars, page-actions banner) is ink/gray.

**Palette** (CSS vars in `public/css/tokens.css`):
- `--bg`            `#faf9f5`  warm cream page background
- `--bg-elev`       `#ffffff`  card surfaces
- `--sidebar-bg`    `#faf9f5`  (same as `--bg`, single continuous surface)
- `--border`        `#e8e3d5`
- `--ink`           `#1a1815`  body text (warm near-black, also used for terminal background)
- `--ink-mid` / `--ink-muted` / `--ink-faint`
- `--accent`        `#b3614a`  desaturated terracotta — brand only
- Status: green `#4a8a4a` idle · blue `#4a73a5` busy (pulsing) · red `#b73f3f` danger

**Type**:
- Body / headings: **Geist** (Google Fonts, 300–700).
- Mono: **JetBrains Mono** for paths, PIDs, sessionIds, branch tags.
- Always `font-variant-numeric: tabular-nums` on numeric cells.

**Buttons**:
- `.action` (default) — white bg, ink-mid border, ink text.
- `.action.primary` — black ink bg, white text. The "do this" CTA.
- `.action.subtle` — transparent bg, light border.
- `.action.danger` — filled red bg + white text.

**Layout**:
- Sidebar (collapsible, ~232px ↔ ~60px, state in `localStorage["ccsm.sidebar-collapsed"]`)
  - brand mark + `CCSM.` wordmark
  - tabs: Sessions / Launch / Configure / About
  - folder tree of persisted sessions (drag-sortable)
- Page-title bar: title on the left, server-status pill + Refresh button on the right
- Top-right control group uses fixed `min-height: 28px` and `border-radius: 999px` so server-status + Refresh align as a coherent control row

**No emoji in the UI** unless the user typed it. Use inline SVG icons
everywhere (line stroke, 1.5–2px) so they take `currentColor`.

**PWA + WCO**:
- `display_override: ["window-controls-overlay", "standalone"]` in the manifest. When installed and launched as PWA, the title bar's middle is reclaimed; only OS controls float top-right.
- `public/css/wco.css` provides drag regions (`-webkit-app-region: drag`) on `.sidebar-brand`, `.page-head`, etc., unconditional. Interactive elements opt out via the no-drag block.
- The root PWA manifest at `pages-root/manifest.webmanifest` has stable `id: /ccsm/` so installs survive across version-router redirects to new `/ccsm/<X.Y.Z>/` subdirs.

## Versioning

The hosted frontend lives at `https://bakapiano.github.io/ccsm/`. The
deploy workflow publishes two things to gh-pages on every push to main:

1. `pages-root/` → `/` (the router, plus root PWA manifest)
2. `public/` → `/<pkg.version>/` (the per-version frontend; workflow injects `<meta name="ccsm-frontend-version">` at build time)

Old version dirs stay forever (`keep_files: true`), so a user on an
older backend keeps loading the matching frontend until they upgrade.

`bin/ccsm.js` does auto-upgrade-restart: when the user runs `ccsm` and
the installed package version differs from a running backend, it POSTs
`/api/shutdown` to the old, waits for the port to free, then spawns a
fresh server. So `npm i -g @bakapiano/ccsm@latest && ccsm` is one
seamless step. From the frontend, the About page's Upgrade button
achieves the same thing without leaving the browser.

### Release process

**Do not release or push without explicit permission from the user.**
This means: don't run `git push`, don't run `npm version`, don't run
`gh release edit --draft=false`, don't commit + tag in one breath
because "the fix is ready". Wait for the user to say so. The instinct
to ship is wrong here — a half-baked release on the public npm registry
is much worse than a few minutes of waiting.

Three artifacts ship per release: a git tag, a GitHub Release, and an
npm publish. The whole thing is CI-driven — you never `npm publish`
locally — but it requires you to drive three steps in order:

1. **Commit + bump + push (local).** Stage everything, write a release
   commit, then bump + tag + push:

   ```powershell
   git add -A
   git commit -m "vX.Y.Z: <one-line summary>

   <body>

   Co-Authored-By: Claude ..."
   npm --prefix . version <patch|minor|major> -m "v%s"
   git push origin main
   git push origin vX.Y.Z
   ```

   `npm version` writes the new version into `package.json` +
   `package-lock.json`, creates its OWN commit, and tags it. The
   `--prefix .` is needed on Windows where bare `npm version` errors on
   the global `%APPDATA%\npm\package.json`. Push BOTH `main` and the
   tag — pushing only main skips the tag-triggered draft-release
   workflow.

2. **Push fires two workflows automatically; monitor both with `gh`:**
   - `Deploy frontend to GitHub Pages` → publishes `pages-root/` → `/`
     and `public/` → `/<X.Y.Z>/` on `gh-pages`. Old `/<X.Y.Z>/`
     subdirs stay forever (`keep_files: true`).
   - `Draft GitHub Release on tag push` → creates a **draft** release
     for `vX.Y.Z`.

   ```powershell
   gh run list --repo bakapiano/ccsm --limit 10
   gh run watch <deploy-pages-run-id> --exit-status
   gh run watch <release-draft-run-id> --exit-status
   ```

   The Pages deploy workflow can succeed while GitHub's built-in
   `pages-build-deployment` job fails or gets stuck, leaving
   `/<X.Y.Z>/` 404 even though `gh-pages` contains the files. Always
   watch that workflow too:

   ```powershell
   gh run list --repo bakapiano/ccsm --workflow pages-build-deployment --limit 5
   gh run watch <pages-build-deployment-run-id> --exit-status
   ```

   Then verify the public frontend URL from the local machine:

   ```powershell
   $v = "X.Y.Z"
   Invoke-WebRequest "https://bakapiano.github.io/ccsm/$v/" -Method Head
   Invoke-WebRequest "https://bakapiano.github.io/ccsm/$v/js/main.js" -Method Head
   ```

   Both must return HTTP 200 before considering the frontend deployed.
   If `pages-build-deployment` failed with only "Deployment failed, try
   again later" or the Pages API shows the latest build stuck in
   `building`, retry the legacy Pages build:

   ```powershell
   gh api -X POST repos/bakapiano/ccsm/pages/builds
   gh api repos/bakapiano/ccsm/pages/builds/latest
   ```

3. **Publish the draft (manual one-liner):**

   ```powershell
   gh release edit vX.Y.Z --draft=false
   ```

   This flips the draft to "published", which fires the third workflow
   — `Publish to npm` — using the `NPM_TOKEN` repo secret with
   provenance. The runner needs ~30s; verify with `gh` and npm:

   ```powershell
   gh run list --repo bakapiano/ccsm --workflow "Publish to npm" --limit 5
   gh run watch <publish-run-id> --exit-status
   npm view @bakapiano/ccsm version bin dist-tags
   ```

The reason for the draft step instead of auto-publishing on tag push:
gives you a chance to abort a half-baked tag (delete the draft +
`git push --delete origin vX.Y.Z`) before it lands on the public
registry.

### Why we don't publish from the local box

`npm publish` from a dev machine works in principle but skips
provenance attestation (the sigstore + GitHub OIDC binding that npm
displays as a "Provenance" badge on the package page). CI has the OIDC
token; you don't. Local publish also wouldn't have the consistent
runner state, so reproducible-build claims fall apart. The pipeline
exists; use it.

## Cross-platform

Today: Windows-first.

Cross-platform-clean already:
- Frontend (pure web)
- Router page (pure HTML/JS)
- `bin/ccsm.js` (pure node)
- `lib/webTerminal.js` (node-pty handles platform)
- `lib/persistedSessions.js`, `lib/folders.js`, `lib/config.js`, `lib/jsonStore.js`, `lib/workspace.js` (fs only)
- `server.js` Express + ws

Windows-specific (need ports for Mac/Linux):
- `scripts/install.js` — uses `reg.exe` and `wscript.exe`. Mac: write `Info.plist` with `CFBundleURLTypes`. Linux: write `~/.local/share/applications/ccsm.desktop` with `MimeType=x-scheme-handler/ccsm`.
- The `--app=` browser detection and PATH-merge in `server.js` are Windows-shaped (Edge first, registry HKCU\Environment for PATH).

Pattern for adding a platform: `switch (process.platform)` at each
entry point in those files. Each platform branch is roughly 50-100
lines.

## Extending

When adding features, the natural extension points:
- **New REST routes**: `server.js` (keep under `/api/*`, use the `asyncH` wrapper, decide if it needs CORS by being in the allow-list).
- **Frontend page**: `public/js/pages/<Name>Page.js`, route in `App.js`, sidebar nav item in `Sidebar.js`, heading in `state.js`'s `TAB_HEADINGS`.
- **Persistent user data**: drop a JSON file under `~/.ccsm/` and use `lib/jsonStore.js`'s factory.
- **Different CLIs**: add a built-in to `DEFAULT_CLIS` in `lib/config.js` with `resumeLatestArgs` / `resumePickerArgs`, and add an icon to `public/js/icons.js`.
- **A capability**: advertise via `/api/capabilities`. Frontend gates UI on `caps.<feature>`.
- **Bumping the frontend**: use the Release process above, then verify both the Pages workflow and `https://bakapiano.github.io/ccsm/<new-version>/` return 200.
