// One source of truth for "where is the ccsm backend reachable"
// and "what auth token (if any) do we attach to every request".
//
//   localhost / 127.0.0.1            same-origin (page IS the backend)
//   bakapiano.github.io              http://localhost:7777 (the hosted
//                                      frontend talks to the user's local
//                                      backend via CORS)
//   anything else (tunnel domain)    same-origin (the local backend is
//                                      serving this frontend over the
//                                      tunnel; API calls go to the same
//                                      tunnel URL automatically)
//
// httpBase is used by fetch(); wsBase is used by WebSocket constructions.
// Keep both as functions rather than constants so the values reflect
// `location.*` at call time (matters for tests / route changes).

const HOSTED_HOST = 'bakapiano.github.io';

function isLocal() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}
function isHosted() {
  return location.hostname === HOSTED_HOST;
}

export function httpBase() {
  if (isHosted()) return 'http://localhost:7777';
  // Local OR tunnel-served — both same-origin.
  return '';
}

export function wsBase() {
  if (isHosted()) return 'ws://localhost:7777';
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
}

export function isHostedFrontend() {
  return isHosted();
}
// True when the page is being served via a remote tunnel — neither the
// host machine itself (localhost) nor the GH-Pages router. Used to gate
// off "wake backend" affordances that only work locally.
export function isRemoteAccess() {
  return !isLocal() && !isHosted();
}

// ── Remote-access bearer token ────────────────────────────────────
// Persisted in localStorage so it survives reloads on whatever device
// loaded the share URL. main.js captures a fresh token from `?token=`
// on first arrival and stashes it via setToken(), then strips the
// query string from the URL so the secret doesn't sit in the address
// bar / browser history.
const LS_KEY = 'ccsm.token';

export function getToken() {
  try { return localStorage.getItem(LS_KEY) || null; } catch { return null; }
}
export function setToken(t) {
  try {
    if (t) localStorage.setItem(LS_KEY, t);
    else localStorage.removeItem(LS_KEY);
  } catch {}
}

// ── Device id ─────────────────────────────────────────────────────
// Per-browser-profile UUID that identifies this device to the host
// machine for the approval flow. Generated once, persisted in
// localStorage, sent on every API call as X-Device-Id. The host pairs
// the id with the User-Agent the server records on first sight, so
// the approval UI can show "iPhone · Safari" instead of a raw uuid.
const LS_DEVICE = 'ccsm.deviceId';

export function getDeviceId() {
  try {
    let id = localStorage.getItem(LS_DEVICE);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || (Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem(LS_DEVICE, id);
    }
    return id;
  } catch {
    return null;
  }
}

// Per-device 4-digit human-verification code. Sent alongside the
// device id so the operator approving on the host can match what
// they see in the Remote page against what the requesting user
// reads off their own screen — guards against approving the wrong
// pending request when two devices arrive in quick succession.
// Purely identification, NOT a credential — no secrecy assumed.
const LS_DEVICE_CODE = 'ccsm.deviceCode';

export function getDeviceCode() {
  try {
    let c = localStorage.getItem(LS_DEVICE_CODE);
    if (!c || !/^\d{4}$/.test(c)) {
      // 1000..9999 inclusive so the leading digit is never 0 — keeps
      // the code visually consistent at 4 characters wherever it
      // shows up. Random.value covers 9000 possibilities, plenty for
      // a "which of these is yours" disambiguator.
      const n = 1000 + Math.floor(Math.random() * 9000);
      c = String(n);
      localStorage.setItem(LS_DEVICE_CODE, c);
    }
    return c;
  } catch {
    return null;
  }
}
