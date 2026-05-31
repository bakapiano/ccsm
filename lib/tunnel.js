'use strict';

// Tunnel manager · spawns and supervises a cloudflared or devtunnel
// child to expose the local ccsm backend over a public URL. Captures
// the URL from stdout, exposes state to the API, and tears down the
// child on stop / server shutdown.
//
// Two providers, each with their own CLI quirk:
//   cloudflared · `cloudflared tunnel --url http://localhost:<port>`
//                 Prints `https://*.trycloudflare.com` somewhere in
//                 the boot banner. No login required for quick tunnels.
//   devtunnel   · `devtunnel host -p <port> --allow-anonymous`
//                 Prints `Connect via browser: https://*.devtunnels.ms`.
//                 Host must be logged in (`devtunnel user login`).
//
// Discovery: scan PATH first via `where.exe`, then known winget install
// dirs. Returns the absolute path so we can spawn the child regardless
// of whether the post-install PATH refresh has reached this Node process.

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { promisify } = require('node:util');
const { loadConfig, saveConfig } = require('./config');
const execFileP = promisify(execFile);

const PROVIDERS = {
  cloudflared: {
    id: 'cloudflared',
    label: 'Cloudflare Tunnel',
    wingetId: 'Cloudflare.cloudflared',
    binary: 'cloudflared.exe',
    knownPaths: [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
    ],
    args: (port) => ['tunnel', '--url', `http://localhost:${port}`],
    urlRegex: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  },
  devtunnel: {
    id: 'devtunnel',
    label: 'Microsoft Dev Tunnel',
    wingetId: 'Microsoft.devtunnel',
    binary: 'devtunnel.exe',
    knownPaths: [
      path.join(process.env['LOCALAPPDATA'] || '', 'Microsoft', 'WinGet', 'Packages',
        'Microsoft.devtunnel_Microsoft.Winget.Source_8wekyb3d8bbwe', 'devtunnel.exe'),
    ],
    args: (port, opts = {}) => {
      // With a persistent (named) tunnel, ports + anonymous access are
      // configured ahead of time via `devtunnel port create` and
      // `devtunnel access create` (see ensureDevtunnelTunnelId +
      // configureDevtunnelTunnel). The host call then takes ONLY the
      // tunnel id — passing -p or --allow-anonymous here makes the CLI
      // try to batch-update the existing tunnel and the service rejects
      // it ("Batch update of ports is not supported"). Anonymous +
      // ephemeral mode keeps the legacy flags as a fallback when no
      // tunnel id has been minted.
      if (opts.tunnelId) {
        return ['host', opts.tunnelId];
      }
      return ['host', '-p', String(port), '--allow-anonymous'];
    },
    // devtunnel sometimes prints two URL forms for the same tunnel:
    //   https://<id>.<region>.devtunnels.ms:<port>     ← port as suffix
    //   https://<id>-<port>.<region>.devtunnels.ms     ← port baked into
    //                                                    the subdomain
    // The plain `<id>.<region>` form (without a `:<port>` suffix) is
    // unreachable — browsers default to 443 and the tunnel serves
    // nothing there, so we get a 404. We always want the subdomain-
    // port form. Force the regex to require `-<digits>` in the
    // subdomain so the bare form (which our old greedy match would
    // capture first) gets skipped.
    urlRegex: /https:\/\/[a-z0-9]+-\d+\.[a-z0-9-]+\.devtunnels\.ms/i,
    needsLogin: true,
  },
};

// In-memory state. Single tunnel at a time — switching providers tears
// down the old one first.
let current = null;   // { provider, child, url, startedAt, log: string[] }
let token = null;     // Remote-access bearer token. Null = no remote
                      // access enforced. Set via setToken() or by the
                      // start() call. Server.js middleware reads via
                      // getToken().
let login = null;     // Pending interactive `devtunnel user login -d`
                      // flow · { child, mode, lines, url, code, status,
                      // startedAt, finishedAt, error, user }. Single
                      // flow at a time. See startDevtunnelLogin().

function getToken() { return token; }
function setToken(t) { token = t ? String(t) : null; return token; }

async function findBinary(provider) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  // PATH lookup via where.exe — works regardless of how the CLI got
  // installed (winget, choco, manual, in-tree). windowsHide stops the
  // conhost window from flashing.
  try {
    const { stdout } = await execFileP('where.exe', [p.binary], { windowsHide: true });
    const out = String(stdout).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch { /* not on PATH */ }
  // Fall back to known install locations (winget's PATH update doesn't
  // reach the already-running Node process).
  for (const candidate of p.knownPaths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  // For devtunnel: winget's package dir has a version suffix that
  // changes between releases. Glob it.
  if (provider === 'devtunnel') {
    const base = path.join(process.env['LOCALAPPDATA'] || '', 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const entry of fs.readdirSync(base)) {
        if (entry.startsWith('Microsoft.devtunnel_')) {
          const candidate = path.join(base, entry, 'devtunnel.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {}
  }
  return null;
}

async function getVersion(provider, exe) {
  try {
    const { stdout } = await execFileP(exe, ['--version'], { windowsHide: true });
    return String(stdout).trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

async function checkDevtunnelLogin(exe) {
  try {
    const { stdout } = await execFileP(exe, ['user', 'show'], { windowsHide: true, timeout: 5000 });
    // "Logged in as <email> using <provider>." vs "Not logged in"
    const m = String(stdout).trim().match(/Logged in as (\S+)/);
    if (m) return { loggedIn: true, user: m[1] };
    return { loggedIn: false, user: null };
  } catch {
    return { loggedIn: false, user: null };
  }
}

// Mint (or read back) a persistent devtunnel id and stash it in
// config.devtunnel.tunnelId so subsequent `devtunnel host` invocations
// reuse the same public URL.
//
// Why: every `devtunnel host` without a tunnel id allocates a fresh
// random id, which means a fresh subdomain and therefore a fresh
// browser origin on the remote side. localStorage is per-origin, so
// approved device ids get orphaned and the remote user has to re-
// register from scratch on every tunnel restart.
//
// Behaviour:
//   - If config already has a tunnelId, return it verbatim. We do NOT
//     validate it against `devtunnel list` here — the host child will
//     fail loudly if the id was deleted from another machine, and
//     callers can drop it and retry by deleting config.devtunnel.
//   - Otherwise call `devtunnel create --json`, capture the .tunnelId
//     from the response, persist it, return it.
//   - If the create call fails for any reason, return null and let
//     start() fall back to a temporary tunnel — degraded but working.
async function ensureDevtunnelTunnelId(exe) {
  try {
    const cfg = await loadConfig();
    if (cfg?.devtunnel?.tunnelId) return cfg.devtunnel.tunnelId;
    const { stdout } = await execFileP(exe, ['create', '--json'], {
      windowsHide: true,
      timeout: 20_000,
    });
    let id = null;
    try {
      const j = JSON.parse(String(stdout));
      // The CLI's JSON shape varies a bit by version; the canonical
      // field is `tunnelId` but older builds nest it under `tunnel`.
      id = j.tunnelId || j.tunnel?.tunnelId || j.id || null;
    } catch {
      // Fall back to scraping the plain-text output for `Tunnel ID: foo`
      const m = String(stdout).match(/Tunnel ID:\s*(\S+)/i);
      if (m) id = m[1];
    }
    if (!id) return null;
    // Persist for next time. Swallow save errors — worst case the next
    // start re-allocates one.
    try { await saveConfig({ devtunnel: { tunnelId: id } }); }
    catch (e) { console.warn('[tunnel] persist devtunnel id failed:', e.message); }
    return id;
  } catch (e) {
    console.warn('[tunnel] ensureDevtunnelTunnelId failed:', e.message);
    return null;
  }
}

// Bring a named tunnel into shape for hosting: make sure the port is
// in its port list and anonymous access is allowed. Idempotent — the
// "already exists" errors from `port create` / `access create` are
// silently absorbed. Required because `devtunnel host <id>` (which
// we use for persistent tunnels) doesn't accept -p / --allow-anonymous
// flags after the tunnel exists — passing them triggers the service
// to reject the call with "Batch update of ports is not supported".
async function configureDevtunnelTunnel(exe, tunnelId, port) {
  if (!tunnelId) return;
  // Add port. If it already exists the CLI prints an error; swallow it.
  try {
    await execFileP(exe, ['port', 'create', tunnelId, '-p', String(port)], {
      windowsHide: true,
      timeout: 10_000,
    });
  } catch (e) {
    // Only surface failures that aren't "already exists" — those mean
    // something is genuinely broken (auth lost, wrong tunnel id, etc.).
    const msg = String(e.stderr || e.stdout || e.message || '');
    if (!/already/i.test(msg)) {
      console.warn('[tunnel] devtunnel port create failed:', msg.slice(0, 200));
    }
  }
  // Add anonymous access. Same idempotency story.
  try {
    await execFileP(exe, ['access', 'create', tunnelId, '-a'], {
      windowsHide: true,
      timeout: 10_000,
    });
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message || '');
    if (!/already/i.test(msg)) {
      console.warn('[tunnel] devtunnel access create failed:', msg.slice(0, 200));
    }
  }
}

// Delete the persisted devtunnel id (and the remote tunnel resource
// itself, best-effort). Used by the Reset affordance in the Remote
// page when the user wants to rotate the public URL.
async function resetDevtunnelTunnelId() {
  let prevId = null;
  try {
    const cfg = await loadConfig();
    prevId = cfg?.devtunnel?.tunnelId || null;
  } catch {}
  try { await saveConfig({ devtunnel: { tunnelId: null } }); } catch {}
  if (prevId) {
    const exe = await findBinary('devtunnel');
    if (exe) {
      // Detach from the tunnel resource on the Azure side too; failure
      // is fine (resource may already be gone). 5s cap.
      try { await execFileP(exe, ['delete', prevId, '-f'], { windowsHide: true, timeout: 5_000 }); }
      catch { /* ignore */ }
    }
  }
  return { previousTunnelId: prevId };
}

// Probe is cached. Each cold call shells out 4-6 sync execs (where.exe,
// --version per provider, `devtunnel user show`) — cumulatively ~1s of
// blocked event loop on Windows. The Remote page polls /api/tunnel/status
// every 2.5s, and tunnel.start() returns a fresh status() — without this
// cache, the loop is frozen ~40% of the time during normal operation,
// and /api/health probes from other clients time out.
const PROBE_TTL_MS = 30_000;
let probeCache = null;
let probeCacheAt = 0;

async function probe(force = false) {
  if (!force && probeCache && Date.now() - probeCacheAt < PROBE_TTL_MS) {
    return probeCache;
  }
  // All providers in parallel; within each, --version and the
  // devtunnel `user show` check run together too. Cold probe drops
  // from ~1.5s serial to ~700ms (capped by the slowest exec —
  // typically `devtunnel user show`).
  const ids = Object.keys(PROVIDERS);
  const results = await Promise.all(ids.map(async (id) => {
    const exe = await findBinary(id);
    const p = { installed: !!exe, exe, version: null };
    if (exe) {
      const tasks = [getVersion(id, exe)];
      if (id === 'devtunnel') tasks.push(checkDevtunnelLogin(exe));
      const [version, devUser] = await Promise.all(tasks);
      p.version = version;
      if (devUser) Object.assign(p, devUser);
    }
    return [id, p];
  }));
  probeCache = Object.fromEntries(results);
  probeCacheAt = Date.now();
  return probeCache;
}

// Invalidate the cache when callers know the on-disk state likely changed
// (post-install, post-login, etc.). Next probe() re-shells.
function invalidateProbe() { probeCache = null; probeCacheAt = 0; }

async function status() {
  return {
    providers: await probe(),
    running: !!current,
    provider: current?.provider || null,
    url: current?.url || null,
    startedAt: current?.startedAt || null,
    pid: current?.child?.pid || null,
    log: current?.log?.slice(-50) || [],
    token,
    tunnelId: current?.tunnelId || (await (async () => {
      try { return (await loadConfig())?.devtunnel?.tunnelId || null; }
      catch { return null; }
    })()),
    // Token is echoed back so the Remote page can render the
    // pre-built share URL. The route itself is token-protected
    // (the middleware blocks non-loopback callers without it), so
    // anyone reaching this endpoint already knows the token.
    login: loginSnapshot(),
  };
}

// ---- devtunnel interactive login (device-code flow) ----
//
// `devtunnel user login -d` prints a Microsoft device-code line then
// polls Azure until the user authenticates in a browser (or until it
// times out). We spawn it as a child, parse the URL + code out of the
// first informational lines, and expose progress via /api/tunnel/status
// so the Remote page can render a one-click sign-in panel instead of
// asking the user to paste a command into a terminal.
//
// Two modes: 'microsoft' (default, -d) and 'github' (-g -d). GitHub is
// only worth offering if the user explicitly picks it — Microsoft
// device code works for Entra ID / personal MS accounts and is what
// most people land on.
//
// State machine:
//   running  → child alive, waiting for user
//   done     → child exited 0; probe cache is invalidated so the next
//              providers map shows `loggedIn: true`
//   error    → child exited non-zero or crashed
//   canceled → cancelDevtunnelLogin() killed the child
function loginSnapshot() {
  if (!login) return null;
  return {
    mode: login.mode,
    status: login.status,
    url: login.url,
    code: login.code,
    error: login.error || null,
    user: login.user || null,
    startedAt: login.startedAt,
    finishedAt: login.finishedAt || null,
    lines: login.lines.slice(-40),
  };
}

async function startDevtunnelLogin({ mode = 'microsoft' } = {}) {
  if (login && login.status === 'running') {
    // Already in flight · return the snapshot rather than throwing so
    // a double-click on Sign in doesn't error out.
    return loginSnapshot();
  }
  const exe = await findBinary('devtunnel');
  if (!exe) throw new Error('Microsoft Dev Tunnel is not installed');
  // Starting a fresh login drops any existing credentials from disk
  // before the new flow finishes — so the cached probe ("signed in as
  // old-user") is now lying. Invalidate so the next /status round-
  // trip re-shells `devtunnel user show` and the provider line flips
  // to "not signed in" while the device-code panel is up.
  invalidateProbe();

  // -d picks the Microsoft device-code flow; -g switches it to GitHub.
  // We deliberately stay on device code (no `--use-browser`) — the user
  // may be driving the Remote page from a phone where opening a local
  // browser on the host machine doesn't help.
  const args = mode === 'github' ? ['user', 'login', '-g', '-d'] : ['user', 'login', '-d'];
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const entry = {
    child,
    mode,
    lines: [],
    url: null,
    code: null,
    status: 'running',
    error: null,
    user: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  login = entry;

  const URL_RE  = /https?:\/\/\S+/i;
  // Microsoft device-code prompt examples (have varied over CLI
  // versions): "...enter the code ABCD-1234 to authenticate"
  //            "...code XXXXXXXXX..."
  // GitHub device flow uses 8 chars with a dash, e.g. `XXXX-XXXX`.
  const CODE_RE = /\b([A-Z0-9]{4,}-?[A-Z0-9]{3,})\b/;
  const LOGGED  = /Logged in as (\S+)/i;

  const ingest = (line) => {
    if (!line) return;
    entry.lines.push(line);
    if (entry.lines.length > 100) entry.lines.shift();
    if (!entry.url) {
      const m = line.match(URL_RE);
      if (m) entry.url = m[0].replace(/[.,)]+$/, '');
    }
    if (!entry.code && /code/i.test(line)) {
      // Skip URL-bearing fragments before extracting the code so we
      // don't grab a uuid-ish segment out of the device login URL.
      const sans = line.replace(URL_RE, '');
      const m = sans.match(CODE_RE);
      if (m) entry.code = m[1];
    }
    const u = line.match(LOGGED);
    if (u) entry.user = u[1];
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => c.split(/\r?\n/).forEach(ingest));
  child.stderr.on('data', (c) => c.split(/\r?\n/).forEach(ingest));

  child.on('exit', (code, signal) => {
    entry.finishedAt = Date.now();
    if (entry.status === 'canceled') {
      // already terminal; leave as-is
    } else if (code === 0) {
      entry.status = 'done';
      // The just-completed login means the probe cache is now lying
      // about `loggedIn: false`. Drop it so the next status() call
      // re-shells `devtunnel user show` and the UI flips to signed-in.
      invalidateProbe();
    } else {
      entry.status = 'error';
      entry.error = `devtunnel exited code=${code}${signal ? ` signal=${signal}` : ''}`;
    }
  });
  child.on('error', (err) => {
    entry.status = 'error';
    entry.error = String(err && err.message || err);
    entry.finishedAt = Date.now();
  });

  return loginSnapshot();
}

function cancelDevtunnelLogin() {
  if (!login || login.status !== 'running') return loginSnapshot();
  login.status = 'canceled';
  login.finishedAt = Date.now();
  try { login.child.kill(); } catch {}
  return loginSnapshot();
}

function clearDevtunnelLogin() {
  if (login && login.status === 'running') {
    try { login.child.kill(); } catch {}
  }
  login = null;
  return null;
}

// Spawn the tunnel CLI. Resolves once we've parsed the public URL out
// of stdout (with a timeout safety net). Throws if the CLI isn't
// installed, the provider is unknown, or another tunnel is running.
async function start({ provider, port }) {
  if (current) throw new Error('tunnel already running');
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  const exe = await findBinary(provider);
  if (!exe) throw new Error(`${p.label} is not installed`);
  if (provider === 'devtunnel') {
    const { loggedIn } = await checkDevtunnelLogin(exe);
    if (!loggedIn) throw new Error('devtunnel requires login — run `devtunnel user login` first');
  }

  // Resolve devtunnel's persistent id BEFORE building args so the
  // CLI is invoked with `host <id>` and the public URL stays stable
  // across restarts. Cloudflared has no equivalent here — quick
  // tunnels always rotate URLs and named tunnels require a CF
  // account + DNS setup that's outside ccsm's scope.
  let tunnelId = null;
  if (provider === 'devtunnel') {
    tunnelId = await ensureDevtunnelTunnelId(exe);
    if (tunnelId) {
      // Make sure the port is in the tunnel's port list and anonymous
      // access is enabled. `devtunnel host <id>` doesn't accept port /
      // access flags after the tunnel exists, so this has to be done
      // out of band before host.
      await configureDevtunnelTunnel(exe, tunnelId, port);
    }
  }

  const args = p.args(port, { tunnelId });
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const entry = { provider, child, url: null, startedAt: Date.now(), log: [], tunnelId };
  current = entry;

  const pushLog = (line) => {
    entry.log.push(line);
    if (entry.log.length > 200) entry.log.shift();
    if (!entry.url) {
      const m = line.match(p.urlRegex);
      if (m) entry.url = m[0];
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => chunk.split(/\r?\n/).forEach((l) => l && pushLog(l)));
  child.stderr.on('data', (chunk) => chunk.split(/\r?\n/).forEach((l) => l && pushLog(l)));

  child.on('exit', (code, signal) => {
    if (current === entry) current = null;
    console.log(`[tunnel] ${provider} exited · code=${code} signal=${signal || ''}`);
  });
  child.on('error', (err) => {
    if (current === entry) current = null;
    console.error(`[tunnel] ${provider} spawn error`, err);
  });

  // Wait up to 25s for the URL to show up in stdout.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (entry.url) return await status();
    if (!current || current !== entry) {
      throw new Error('tunnel exited before reporting a URL · ' + entry.log.slice(-3).join(' / '));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Timed out — keep the child alive (the URL might appear later) but
  // tell the caller we don't have one yet.
  return await status();
}

function stop() {
  if (!current) return false;
  try { current.child.kill(); } catch {}
  current = null;
  return true;
}

// Background install via winget. Returns immediately with the spawned
// pid; the actual install completes asynchronously. Caller polls
// probe() to learn when the binary appears on disk.
function installViaWinget(provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  if (process.platform !== 'win32') throw new Error('winget install only supported on Windows');
  const child = spawn('winget', [
    'install', p.wingetId,
    '--accept-source-agreements',
    '--accept-package-agreements',
    '--silent',
  ], { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  return { provider, pid: child.pid };
}

module.exports = {
  PROVIDERS,
  probe,
  status,
  start,
  stop,
  installViaWinget,
  getToken,
  setToken,
  startDevtunnelLogin,
  cancelDevtunnelLogin,
  clearDevtunnelLogin,
  invalidateProbe,
  resetDevtunnelTunnelId,
};
