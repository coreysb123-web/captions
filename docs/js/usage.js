// How much listening this phone has done, month by month.
//
// The speech service bills for the audio sent to it, silence included, so that is what
// is counted here: every bit of audio the app actually transmits. It is this phone's own
// tally, kept on the phone. The service's account keeps the real total across all phones.
// Months are calendar months in the phone's own time.

const KEY = 'captions.usage';
const KEEP_MONTHS = 13;
const SAVE_EVERY_MS = 10000; // of listening, between writes to storage

function monthKey(date) {
  const d = date || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function read() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (stored && stored.months && typeof stored.months === 'object') return stored;
  } catch (e) {}
  return { months: {} };
}

let data = read();
let unsaved = 0;

function thisMonth() {
  const key = monthKey();
  if (!data.months[key]) {
    data.months[key] = { ms: 0, termsMs: 0 };
    const keys = Object.keys(data.months).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_MONTHS))) delete data.months[old];
  }
  return data.months[key];
}

/** Record audio sent to the service. withTerms: the "unusual words" extra was in use. */
export function addListening(ms, withTerms) {
  const month = thisMonth();
  month.ms += ms;
  if (withTerms) month.termsMs += ms;
  unsaved += ms;
  if (unsaved >= SAVE_EVERY_MS) saveUsage();
}

export function saveUsage() {
  if (!unsaved) return;
  unsaved = 0;
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {}
}

/** { ms, termsMs } for this calendar month. */
export function usedThisMonth() {
  const m = thisMonth();
  return { ms: m.ms, termsMs: m.termsMs };
}

export function usedLastMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const m = data.months[monthKey(d)];
  return m ? { ms: m.ms, termsMs: m.termsMs } : { ms: 0, termsMs: 0 };
}

/** Rough cost in dollars of a month's listening at the service's hourly prices. */
export function costOf(used, pricePerHour, extraForTerms) {
  return (used.ms / 3600000) * pricePerHour + (used.termsMs / 3600000) * extraForTerms;
}

/** The first day of next month, when the tally starts again. */
export function nextReset() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

/** 200 minutes -> "3 h 20 min". */
export function asDuration(ms) {
  const minutes = Math.round(ms / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return m + ' min';
  return m ? h + ' h ' + m + ' min' : h + ' h';
}
