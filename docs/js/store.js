// Settings kept on this phone, and the "setup code" used to copy them to another phone.
//
// A setup code is the settings packed into one line of text. It can arrive three ways:
//   1. in the address, as  https://.../#setup=CODE  (a link sent by text message);
//   2. in a short-lived cookie: on iPhone, "Add to Home Screen" gives the installed app
//      its own empty storage but does copy cookies across, so a phone that opened the
//      link in Safari is already set up when the Home Screen icon is first tapped;
//   3. pasted in by hand.
// The code contains the service key, so treat a setup link like a password.

const KEY = 'captions.settings';
const COOKIE = 'captions_setup';

const DEFAULTS = {
  engineKey: '', // secret key for the speech service
  language: 'en',
  terms: '', // names and unusual words, one per line
  people: [], // names offered when labelling a speaker
  fontSize: 28,
  theme: 'auto', // auto | light | dark
  tuning: 'room', // room | close
  micId: '',
  autoPauseMin: 20, // 0 = never
  keepHistory: true,
  tipSeen: false,
  appliedCode: '', // the last setup code taken in, so the same link is not re-applied
};

function read() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

export const settings = read();

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch (e) {}
}

export function hasKey() {
  return !!settings.engineKey;
}

/** The "names and unusual words" box as a clean list. */
export function termList() {
  const seen = new Set();
  const out = [];
  for (const raw of settings.terms.split(/[\n,;]+/)) {
    const term = raw.trim();
    if (term && !seen.has(term.toLowerCase())) {
      seen.add(term.toLowerCase());
      out.push(term);
    }
  }
  return out;
}

// ---- people -----------------------------------------------------------------

export function addPerson(name) {
  name = (name || '').trim();
  if (!name) return;
  const key = name.toLowerCase();
  if (!settings.people.some((p) => p.toLowerCase() === key)) {
    settings.people.push(name);
    saveSettings();
  }
}

export function removePerson(name) {
  const key = name.toLowerCase();
  settings.people = settings.people.filter((p) => p.toLowerCase() !== key);
  saveSettings();
}

// ---- setup codes ------------------------------------------------------------

function encode(object) {
  const bytes = new TextEncoder().encode(JSON.stringify(object));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(code) {
  let s = code.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function makeSetupCode() {
  return encode({
    v: 1,
    k: settings.engineKey,
    l: settings.language,
    t: settings.terms,
    p: settings.people,
    m: settings.tuning,
  });
}

export function makeSetupLink() {
  return location.origin + location.pathname + '#setup=' + makeSetupCode();
}

/** Accepts a bare code or a whole setup link. Returns true if it was valid and applied. */
export function applySetupCode(text) {
  const match = /setup=([\w-]+)/.exec(text || '');
  const code = match ? match[1] : (text || '').trim();
  if (!/^[\w-]{16,}$/.test(code)) return false;
  let data;
  try {
    data = decode(code);
  } catch (e) {
    return false;
  }
  if (!data || typeof data.k !== 'string' || !data.k) return false;
  settings.engineKey = data.k;
  if (typeof data.l === 'string') settings.language = data.l;
  if (typeof data.t === 'string') settings.terms = data.t;
  if (data.m === 'room' || data.m === 'close') settings.tuning = data.m;
  if (Array.isArray(data.p)) for (const name of data.p) if (typeof name === 'string') addPerson(name);
  settings.appliedCode = code;
  saveSettings();
  return true;
}

function cookiePath() {
  return location.pathname.replace(/[^/]*$/, '');
}

function setCookie(value, seconds) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${value}; max-age=${seconds}; path=${cookiePath()}; SameSite=Strict${secure}`;
}

function getCookie() {
  const match = new RegExp('(?:^|; )' + COOKIE + '=([^;]*)').exec(document.cookie);
  return match ? match[1] : '';
}

/**
 * Run once at startup. Takes in a setup code from the address or the carried-over
 * cookie. Returns true if this phone has just been set up by it.
 */
export function importPendingSetup(isInstalledApp) {
  let applied = false;
  const inAddress = /[#&]setup=([\w-]+)/.exec(location.hash);
  if (inAddress && inAddress[1] !== settings.appliedCode) {
    applied = applySetupCode(inAddress[1]);
  }
  if (!applied && !hasKey()) {
    const carried = getCookie();
    if (carried) applied = applySetupCode(carried);
  }
  if (isInstalledApp) {
    if (getCookie()) setCookie('', 0); // delivered; no reason to keep it
  } else if (inAddress && hasKey()) {
    setCookie(inAddress[1], 24 * 3600); // so "Add to Home Screen" carries it across
  }
  return applied;
}
