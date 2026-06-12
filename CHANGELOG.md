# Changelog

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
