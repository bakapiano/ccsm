# Changelog

## 0.22.22

### Features
- Add an explicit Settings choice between the global npm source and GitHub Release assets for update checks and installs, without automatic fallback.
- Attach the packed npm tarball and checksum to each GitHub Release and publish that same tarball to npm.

## 0.22.21

### Features
- Add a right-click context menu to session tabs with Close, Close Others, Close to the Right, and Close All actions.

## 0.22.20

### Fixes
- Check for ccsm updates through the user's global npm source instead of querying the public npm registry directly.

## 0.22.19

### Fixes
- Keep remote terminal protocol responses in separate PTY writes so focus, color, and device-attribute replies are not mistaken for user input when opening or launching a session.

## 0.22.18

### Features
- Add New folder creation inside the Working directory picker so existing-folder launches can create and select a directory without leaving the modal.

## 0.22.15

### Changed
- Allow multiple ccsm sessions to share the same work folder instead of reusing the first session with the same CLI and cwd.

### Fixes
- Keep Codex session-id binding stable when several Codex sessions run in the same cwd.
- Restore deleted sessions even when another active session uses the same CLI and cwd.

## 0.22.14

### Features
- Add a session action to open the current CLI's resume picker and bind the picked upstream session id back to the same ccsm session.

### Fixes
- Reattach the web terminal immediately when a running session is respawned under the same ccsm session id.

## 0.22.13

### Fixes
- Batch short bursts of terminal input over remote tunnel sessions, reducing per-keystroke WebSocket overhead on higher-latency links.
- Slow background data refreshes for remote tunnel sessions so API polling competes less with interactive terminal traffic.
- Avoid protected config/session loads while a remote device is still pending approval, preventing initial-load error toasts and 403 console noise before the host approves it.

## 0.22.12

### Features
- Add a hover quick-launch action on sidebar folders. The action starts a new session in that folder using the saved Launch-page CLI/workdir/repo configuration.

## 0.22.11

### Features
- Add a Deleted section to the sessions sidebar. Deleted sessions are soft-deleted for 30 days, hidden from the active session list, and can be restored back into their original folder when possible.

## 0.22.10

### Fixes
- Resume Claude, Codex, and Copilot sessions by the upstream CLI session id when ccsm can detect it, so forked or cleared conversations resume the exact active thread instead of the latest folder-level session.
- Persist discovered CLI session ids across reloads and rescan running sessions so `/clear`, `/new`, and resume-driven id rotations are tracked.
- Allow the hosted version router to complete Private Network Access loopback probes against the local backend in newer Chromium/Edge builds.

## 0.22.9

### Fixes
- Persist the open session tab strip and active session selection so switching away from Sessions or reloading the app no longer drops still-running session tabs.
- Clear persisted session tab state when a session is deleted, avoiding stale restored tabs.

## 0.22.8

### Changed
- Resume sessions by filesystem folder (`cwd`) instead of persisted upstream CLI session ids.
- Add latest/picker resume behavior for Claude, Codex, Copilot, and custom CLIs.
- Keep workspaces reserved by all persisted sessions until their session records are deleted.

### Removed
- Remove upstream session-id persistence, Codex seed-session startup, and import/adopt flows.

## 0.22.4

### Fixes
- Align the web terminal frontend lifecycle more closely with VS Code: resize debouncing now follows visibility and buffer-size heuristics, WebGL renderer changes request dimension refreshes, and terminal visibility changes flush pending layout before redraw.
- Refresh terminal rendering on session switches with the same visible-instance path, preventing stale canvas sizing after moving between terminals.
- Keep replay writes guarded until xterm finishes processing them, avoiding replay-triggered terminal responses leaking back into the PTY.

## 0.22.1

### Features
- Allow an existing session to switch to another configured CLI while preserving cwd-based resume behavior for the next launch.
- Add explicit Stop and Resume controls for the active session. Sessions stopped this way stay stopped until the user presses Resume.

### Fixes
- Keep sidebar clicks from auto-resuming sessions that were manually stopped.

## 0.9.0

The "web terminal becomes actually usable" release.

### Features
- **Theme accent picker** — pick a base color in Configure; the entire surface palette (page bg, sidebar tints, borders, OS title-bar theme-color) re-derives from it.
- **Resizable sidebar** — drag the right edge to set width 180–400 px, double-click to reset, persisted to localStorage.
- **Default terminal mode setting** — `defaultTerminalMode: 'wt' | 'web'` in Configure now governs every launch path (new / resume / continue / finder), not just the New Session form. The per-launch radio is gone.
- **Empty-repo launch** — Launch can spin up a workspace with no repos cloned; the Manage Repos editor is inlined right in the Launch card when none are configured.
- **OSC 52 clipboard support** — applications inside the web terminal (claude, tmux, vim) can write to the host clipboard via escape sequence.
- **WebGL renderer** — sharper glyphs and 10× lower paint cost during dense output (claude diff / syntax-highlighted code) versus the old DOM renderer.
- **`CCSM_PORT` env override** — run a dev server on a non-default port without editing config.

### Fixes
- **Paste in web terminal now matches wt** — multi-line / large pastes are correctly recognised as a single paste and rendered as a `[Pasted text +N lines]` chip. Root cause was node-pty using the older ConPTY API; we now opt into `useConptyDll: true` (same path VSCode uses) which keeps bracketed-paste regions intact across child-process reads.
- **Shift+Enter / Ctrl+Enter insert a newline** instead of submitting (xterm.js encodes them as `\r` by default; we now send `\n` for both).
- **Paste from right-click menu / when focus drifted** — document-level capture handler picks up paste events that xterm's textarea misses.
- **IME composition** no longer pushes the layout rightward; the textarea is re-anchored to the right edge during composition, and the canvas cursor is hidden so the user only sees the OS-native candidate popup.
- **App-mode (PWA / `--app=`) right-side controls don't collide** with the page meta cluster — reserved 150 px so status pill + Refresh button sit left of the floating OS controls.

### Other
- GitHub repo renamed to `bakapiano/ccsm` (was `bakapiano/cssm`); all URLs in the codebase, README, manifest, etc. updated to match.
- npm publish workflow with provenance attestations.

## 0.8.x

See git history.
