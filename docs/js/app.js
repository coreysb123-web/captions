// Captions: the screen, the settings, and everything that ties the parts together.

import {
  settings,
  saveSettings,
  hasKey,
  termList,
  addPerson,
  removePerson,
  makeSetupLink,
  applySetupCode,
  importPendingSetup,
} from './store.js';
import { TranscriptView, renderSaved } from './view.js';
import { Session } from './session.js';
import { MicSource, micSupported, listMicrophones } from './audio.js';
import { keepAwake } from './wake.js';
import {
  ElevenLabsEngine,
  SERVICE,
  KEY_PREFIX,
  testKey,
  looksLikeKey,
  usableTerms,
} from './engines/elevenlabs.js';
import { DemoEngine, DemoSource } from './engines/demo.js';
import * as history from './history.js';

const VERSION = '1.2';
const SIZES = [20, 24, 28, 32, 38, 44, 52, 60];
const RESUME_KEY = 'captions.resume';

const $ = (id) => document.getElementById(id);
const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const iOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let demo = false; // showing the made-up conversation
let conversation = null; // { id, startedAt } for the words on screen
let dirty = false; // words on screen that are not saved yet
let lastWordAt = 0;
let whoId = null; // speaker being named
let savedShown = null; // past conversation being read
let noteKind = '';

// ---- transcript and session -------------------------------------------------

const view = new TranscriptView({
  list: $('turns'),
  scroller: $('scroller'),
  onWho: openWho,
  onPinned: (pinned) => {
    $('latest').hidden = pinned;
  },
});

const session = new Session({
  view,
  makeEngine: (emit) =>
    demo
      ? new DemoEngine(emit)
      : new ElevenLabsEngine({ key: settings.engineKey, language: settings.language, terms: termList() }, emit),
  makeSource: (firstFrame) =>
    demo ? new DemoSource(firstFrame) : new MicSource({ tuning: settings.tuning, deviceId: settings.micId }),
  onState: showState,
  onLevel: showLevel,
  onWords: () => {
    lastWordAt = Date.now();
    dirty = true;
    $('empty').hidden = true;
    if (!settings.tipSeen && !demo && !noteKind) {
      showNote('Tip: tap a coloured name to say who that person is.', 'OK', dismissTip, 'tip');
    }
  },
  onFailure: showFailure,
});

const STATUS = {
  idle: 'Ready',
  starting: 'Starting…',
  listening: 'Listening',
  reconnecting: 'Reconnecting…',
  waiting: 'Mic paused',
  finishing: 'Finishing…',
};
const BUTTON = {
  idle: 'Start listening',
  starting: 'Pause',
  listening: 'Pause',
  reconnecting: 'Pause',
  waiting: 'Tap to continue',
  finishing: 'Finishing…',
};

function showState(state, detail) {
  $('app').dataset.state = state;
  const connecting = state === 'starting' || state === 'reconnecting';
  let label = STATUS[state];
  if (state === 'idle' && !view.isEmpty) label = 'Paused';
  if (state === 'listening' && demo) label = 'Demo';
  if (connecting && navigator.onLine === false) label = 'No internet';
  $('statusText').textContent = label;
  $('main').textContent = BUTTON[state];
  $('main').disabled = state === 'finishing';
  keepAwake(state !== 'idle');
  if (state === 'idle') showLevel(0);

  // Until the first words arrive, say in large print what is going on.
  if (view.isEmpty && state !== 'idle' && state !== 'finishing') {
    $('empty').hidden = false;
    $('empty').innerHTML =
      state === 'listening'
        ? '<h1>Listening…</h1><p>Words will appear here as people speak.</p>'
        : state === 'waiting'
          ? '<h1>Microphone paused</h1><p>Tap the green button below to carry on.</p>'
          : '<h1>Getting ready…</h1><p>This takes a few seconds.</p>';
  }

  // Several attempts in a row with nothing to show for them: offer a way out.
  const stuck = connecting && detail && detail.failures >= 4 && navigator.onLine !== false;
  if (stuck) showNote('Still trying to connect.', 'Restart', restartApp, 'stuck');
  else if (noteKind === 'stuck') hideNote();
}

function showLevel(rms) {
  const db = 20 * Math.log10(Math.max(rms, 0.00001));
  const level = Math.min(1, Math.max(0, (db + 60) / 46));
  $('meter').style.transform = 'scaleX(' + level.toFixed(3) + ')';
}

function start() {
  if (!demo && !hasKey()) {
    notice('Captions is not set up yet', ['Paste the setup link you were sent, or your ' + SERVICE.name + ' key.'], [
      { label: 'Paste link or key', primary: true, run: pasteSetup },
      { label: 'Open Setup', run: openSetup },
      { label: 'Not now' },
    ]);
    return;
  }
  if (!demo && !micSupported()) {
    showMicProblem({ code: 'mic-unsupported' });
    return;
  }
  if (!conversation) conversation = { id: Date.now(), startedAt: Date.now() };
  lastWordAt = Date.now();
  if (noteKind !== 'demo') hideNote();
  // Must run inside the tap, so the phone lets the microphone start.
  session.start().catch(showMicProblem);
}

async function pause() {
  await session.pause();
  saveConversation(true);
  if (demo) endDemo();
  else renderEmpty();
}

function showMicProblem(error) {
  renderEmpty();
  const code = (error && error.code) || 'mic-failed';
  if (code === 'mic-blocked') {
    notice('The microphone is switched off for Captions', [
      'If the phone asks whether Captions may use the microphone, tap Allow.',
      'If it does not ask: open the Settings app, find Safari (on newer iPhones it is inside Apps), tap Microphone and choose Allow. Then come back here and tap Start listening.',
    ]);
  } else if (code === 'mic-busy') {
    notice('The microphone is busy', [
      'Another app or a phone call is using it. Close that, then tap Start listening again.',
    ]);
  } else if (code === 'mic-missing') {
    notice('No microphone was found', ['If a headset is connected, disconnect it and try again.']);
  } else if (code === 'mic-unsupported') {
    notice('The microphone cannot be used here', [
      'Open Captions in Safari on the iPhone, using the address that starts with https.',
    ]);
  } else {
    notice('The microphone did not start', ['Please tap Start listening again.']);
  }
}

function showFailure(error) {
  saveConversation(true);
  renderEmpty();
  const said = error.message ? 'The speech service said: “' + error.message + '”' : '';
  const helper = 'Please tell the person who set up this phone.';
  if (error.code === 'auth') {
    notice('The service key was not accepted', [
      'Captions cannot run until the key in Setup is corrected. ' + helper,
      said,
    ], [{ label: 'Open Setup', primary: true, run: openSetup }, { label: 'Close' }]);
  } else if (error.code === 'quota') {
    notice('The speech service allowance has run out', [
      'The free allowance or the credit on the ' + SERVICE.name + ' account has been used up. ' + helper,
      said,
    ]);
  } else {
    notice('Captions could not start', ['The speech service refused the connection. ' + helper, said]);
  }
}

/** Last resort when connecting keeps failing: reload the app and put the words back. */
function restartApp() {
  saveConversation(true);
  try {
    if (conversation && !demo) sessionStorage.setItem(RESUME_KEY, String(conversation.id));
  } catch (e) {}
  location.reload();
}

// ---- saving -----------------------------------------------------------------

function saveConversation(force) {
  if (demo || !settings.keepHistory || !conversation || (!dirty && !force)) return;
  const turns = view.toJSON();
  if (!turns.length) return;
  dirty = false;
  history.saveConversation({
    id: conversation.id,
    startedAt: conversation.startedAt,
    endedAt: Date.now(),
    turns,
  });
}

async function newConversation() {
  if (session.active) await session.pause();
  saveConversation(true);
  if (demo) {
    endDemo();
    return;
  }
  view.clear();
  session.newConversation();
  conversation = null;
  dirty = false;
  hideNote();
  renderEmpty();
  showState('idle');
}

// ---- demonstration ----------------------------------------------------------

function startDemo() {
  if (session.active) return;
  closeAll();
  saveConversation(true);
  view.clear();
  session.newConversation();
  conversation = null;
  demo = true;
  $('empty').hidden = true;
  showNote('This is a demonstration with made-up voices.', 'End', pause, 'demo');
  session.start();
}

function endDemo() {
  demo = false;
  view.clear();
  session.newConversation();
  conversation = null;
  dirty = false;
  hideNote();
  renderEmpty();
  showState('idle');
}

// ---- the empty screen -------------------------------------------------------

function renderEmpty() {
  const el = $('empty');
  el.hidden = !view.isEmpty;
  if (!view.isEmpty) return;
  if (hasKey()) {
    el.innerHTML =
      '<h1>Ready when you are</h1>' +
      '<ol><li>Tap <b>Start listening</b>.</li>' +
      '<li>Put the phone on the table, close to the people talking.</li>' +
      '<li>Tap a coloured name to say who that person is.</li></ol>' +
      (iOS && !installed
        ? '<p class="hint">To open this like an app: tap the Share button in Safari, then “Add to Home Screen”.</p>'
        : '');
  } else {
    el.innerHTML =
      '<h1>Almost ready</h1>' +
      '<p>Captions needs setting up before it can caption real conversations. ' +
      'Paste the setup link you were sent, or your ' + SERVICE.name + ' key.</p>' +
      '<div class="stack">' +
      '<button class="btn primary" type="button" data-do="paste">Paste setup link or key</button>' +
      '<button class="btn" type="button" data-do="demo">See a demonstration</button>' +
      '<button class="btn" type="button" data-do="setup">Enter the settings by hand</button>' +
      '</div>';
  }
}

$('empty').addEventListener('click', (e) => {
  const button = e.target.closest('[data-do]');
  if (!button) return;
  if (button.dataset.do === 'paste') pasteSetup();
  else if (button.dataset.do === 'demo') startDemo();
  else openSetup();
});

// ---- notes (the strip at the top of the words) ------------------------------

function showNote(text, actionLabel, action, kind) {
  noteKind = kind || 'note';
  $('noteText').textContent = text;
  const button = $('noteAction');
  button.textContent = actionLabel || 'OK';
  button.onclick = action || hideNote;
  $('note').hidden = false;
  view.refit(); // the words area just changed height
}

function hideNote() {
  noteKind = '';
  $('note').hidden = true;
  view.refit();
}

function dismissTip() {
  settings.tipSeen = true;
  saveSettings();
  hideNote();
}

// ---- sheets -----------------------------------------------------------------

function openSheet(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}

function closeSheet(id) {
  const dialog = $(id);
  if (dialog.open) dialog.close();
}

function closeAll() {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}

document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) closer.closest('dialog').close();
  else if (e.target.tagName === 'DIALOG' && e.target.id !== 'notice') e.target.close(); // tapped outside
});

/** A message that needs an answer. lines: paragraphs; actions: [{ label, primary, run }]. */
function notice(title, lines, actions, extra) {
  $('noticeTitle').textContent = title;
  const body = $('noticeBody');
  body.textContent = '';
  for (const line of lines || []) {
    if (!line) continue;
    const p = document.createElement('p');
    p.textContent = line;
    body.appendChild(p);
  }
  if (extra) body.appendChild(extra);
  const box = $('noticeActions');
  box.textContent = '';
  for (const action of actions || [{ label: 'OK', primary: true }]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn' + (action.primary ? ' primary' : '') + (action.danger ? ' danger' : '');
    button.textContent = action.label;
    button.addEventListener('click', () => {
      closeSheet('notice');
      if (action.run) action.run();
    });
    box.appendChild(button);
  }
  openSheet('notice');
}

// ---- naming a speaker -------------------------------------------------------

function openWho(id) {
  const speaker = view.speakers.get(id);
  if (!speaker) return;
  whoId = id;
  const quote = view.recentWords(id);
  $('whoQuote').hidden = !quote;
  $('whoQuote').textContent = quote ? '“' + quote + '”' : '';
  $('whoQuote').className = 'quote c' + speaker.color;
  const box = $('whoNames');
  box.textContent = '';
  const names = ['Me'].concat(settings.people.filter((p) => p.toLowerCase() !== 'me'));
  for (const name of names) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = name;
    button.addEventListener('click', () => chooseWho(name));
    box.appendChild(button);
  }
  $('whoInput').value = '';
  $('whoClear').hidden = !view.isNamed(id);
  openSheet('who');
}

function chooseWho(name) {
  name = (name || '').trim();
  if (!name || !whoId) return;
  view.rename(whoId, name);
  if (name.toLowerCase() !== 'me') addPerson(name);
  dirty = true;
  if (!settings.tipSeen) {
    settings.tipSeen = true;
    saveSettings();
  }
  if (noteKind === 'tip') hideNote();
  closeSheet('who');
}

$('whoSave').addEventListener('click', () => chooseWho($('whoInput').value));
$('whoInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') chooseWho($('whoInput').value);
});
$('whoClear').addEventListener('click', () => {
  if (whoId) view.rename(whoId, '');
  dirty = true;
  closeSheet('who');
});

// ---- menu: text size and colours --------------------------------------------

function setSize(px) {
  settings.fontSize = px;
  saveSettings();
  document.documentElement.style.setProperty('--fs', px + 'px');
  view.refit();
}

function stepSize(direction) {
  let i = 0;
  for (let k = 0; k < SIZES.length; k++) {
    if (Math.abs(SIZES[k] - settings.fontSize) < Math.abs(SIZES[i] - settings.fontSize)) i = k;
  }
  i = Math.min(SIZES.length - 1, Math.max(0, i + direction));
  setSize(SIZES[i]);
}

function applyTheme() {
  let theme = settings.theme;
  if (theme === 'auto') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === settings.theme));
  }
}

for (const id of ['smaller', 'menuSmaller']) $(id).addEventListener('click', () => stepSize(-1));
for (const id of ['bigger', 'menuBigger']) $(id).addEventListener('click', () => stepSize(1));
$('themes').addEventListener('click', (e) => {
  const button = e.target.closest('[data-theme-choice]');
  if (!button) return;
  settings.theme = button.dataset.themeChoice;
  saveSettings();
  applyTheme();
});
try {
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
} catch (e) {}

$('openMenu').addEventListener('click', () => openSheet('menu'));
$('newConversation').addEventListener('click', () => {
  closeSheet('menu');
  if (view.isEmpty) return;
  notice('Start a new conversation?', ['The words on screen will be cleared.' + (settings.keepHistory ? ' They stay in Past conversations.' : '')], [
    { label: 'Start new', primary: true, run: newConversation },
    { label: 'Cancel' },
  ]);
});
$('openHistory').addEventListener('click', () => {
  closeSheet('menu');
  openHistory();
});
$('openPeople').addEventListener('click', () => {
  closeSheet('menu');
  renderPeople();
  openSheet('people');
});
$('openSetup').addEventListener('click', () => {
  closeSheet('menu');
  openSetup();
});

// ---- past conversations -----------------------------------------------------

async function openHistory() {
  saveConversation(true);
  const list = await history.listConversations();
  const box = $('historyList');
  box.textContent = '';
  $('historyEmpty').hidden = list.length > 0;
  for (const item of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'past';
    const title = document.createElement('b');
    const minutes = Math.max(1, Math.round((item.endedAt - item.startedAt) / 60000));
    title.textContent = history.whenLabel(item.startedAt) + ' · ' + minutes + ' min';
    const preview = document.createElement('small');
    preview.textContent = item.turns
      .slice(0, 3)
      .map((t) => t.who + ': ' + t.text.replace(/\n/g, ' '))
      .join('  ')
      .slice(0, 200);
    button.append(title, preview);
    button.addEventListener('click', () => {
      savedShown = item;
      $('savedTitle').textContent = history.whenLabel(item.startedAt);
      renderSaved($('savedBody'), item);
      openSheet('saved');
    });
    box.appendChild(button);
  }
  openSheet('history');
}

$('savedShare').addEventListener('click', async () => {
  if (!savedShown) return;
  const text = history.asText(savedShown);
  try {
    if (navigator.share) await navigator.share({ text });
    else {
      await navigator.clipboard.writeText(text);
      $('savedShare').textContent = 'Copied';
      setTimeout(() => ($('savedShare').textContent = 'Share'), 1500);
    }
  } catch (e) {}
});

$('savedDelete').addEventListener('click', () => {
  if (!savedShown) return;
  const doomed = savedShown;
  notice('Delete this conversation?', ['It will be removed from this phone for good.'], [
    {
      label: 'Delete',
      danger: true,
      run: async () => {
        await history.deleteConversation(doomed.id);
        closeSheet('saved');
        openHistory();
      },
    },
    { label: 'Keep it', primary: true },
  ]);
});

// ---- people -----------------------------------------------------------------

function renderPeople() {
  const list = $('peopleList');
  list.textContent = '';
  for (const name of settings.people) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn small danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      removePerson(name);
      renderPeople();
    });
    row.append(label, remove);
    list.appendChild(row);
  }
}

function addPersonFromInput() {
  addPerson($('personInput').value);
  $('personInput').value = '';
  renderPeople();
}
$('personAdd').addEventListener('click', addPersonFromInput);
$('personInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addPersonFromInput();
});

// ---- setup ------------------------------------------------------------------

function fillSetupTexts() {
  const price = '$' + SERVICE.pricePerHour.toFixed(2);
  $('setupIntro').textContent =
    'Captions come from the ' + SERVICE.name + ' speech service. It is paid for by the hour of listening (about ' +
    price + '), with no subscription, using the key below.';
  $('keyHint').textContent =
    'To get a key: sign in at ' + SERVICE.site + ', open Developers, then API Keys, and create one. Paste it here.';
  $('termsHint').textContent =
    'Family names, places, clubs. One per line, up to 50, each 20 letters or fewer. Using this box adds about $' +
    SERVICE.extraForTerms.toFixed(2) + ' an hour; leave it empty to keep the cost lowest.';
  const languages = $('langInput');
  for (const [code, name] of SERVICE.languages) languages.appendChild(new Option(name, code));
  $('version').textContent = 'Captions ' + VERSION;
}

async function fillMicrophones() {
  const select = $('micInput');
  const mics = await listMicrophones();
  select.textContent = '';
  select.appendChild(new Option('Automatic', ''));
  for (const mic of mics) select.appendChild(new Option(mic.label, mic.id));
  select.value = settings.micId;
  if (select.value !== settings.micId) select.value = '';
}

function openSetup() {
  $('keyInput').value = settings.engineKey;
  $('keyInput').type = 'password';
  $('keyShow').textContent = 'Show key';
  $('keyResult').textContent = '';
  $('termsInput').value = settings.terms;
  $('langInput').value = settings.language;
  $('tuningInput').value = settings.tuning;
  $('pauseInput').value = String(settings.autoPauseMin);
  $('historyInput').checked = settings.keepHistory;
  fillMicrophones();
  openSheet('setup');
}

function keepSetup() {
  const typed = $('keyInput').value.trim();
  if (/setup=/.test(typed) && applySetupCode(typed)) {
    // A whole setup link was pasted where the key goes: take everything it carries.
    $('keyInput').value = settings.engineKey;
    $('termsInput').value = settings.terms;
    $('langInput').value = settings.language;
    $('tuningInput').value = settings.tuning;
    $('keyResult').textContent = 'Setup link applied.';
  }
  settings.engineKey = $('keyInput').value.trim();
  settings.terms = $('termsInput').value;
  settings.language = $('langInput').value;
  settings.tuning = $('tuningInput').value;
  settings.micId = $('micInput').value;
  settings.autoPauseMin = Number($('pauseInput').value) || 0;
  settings.keepHistory = $('historyInput').checked;
  saveSettings();
  renderEmpty();
  const ignored = termList().length - usableTerms(termList()).length;
  if (ignored > 0) {
    $('termsHint').textContent =
      ignored + ' of these will not be used: only 50 are allowed, each 20 letters or fewer.';
  }
}

for (const id of ['keyInput', 'termsInput', 'langInput', 'tuningInput', 'micInput', 'pauseInput', 'historyInput']) {
  $(id).addEventListener('change', keepSetup);
}
$('setup').addEventListener('close', keepSetup);

$('keyShow').addEventListener('click', () => {
  const input = $('keyInput');
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  $('keyShow').textContent = hidden ? 'Hide key' : 'Show key';
});

$('keyTest').addEventListener('click', async () => {
  keepSetup();
  $('keyResult').textContent = 'Checking…';
  const result = await testKey(settings.engineKey);
  $('keyResult').textContent = result.message;
});

// ---- sending the settings to another phone ----------------------------------
//
// The link is always written out in the message itself. (Handing a share sheet the
// link as a separate "url" loses it in some mail apps, which then send only the words.)

function setupMessage(link) {
  return (
    'Open this link on the iPhone, in Safari, to set up Captions:\n\n' +
    link +
    '\n\nThen tap the Share button and choose "Add to Home Screen".'
  );
}

$('shareSetup').addEventListener('click', () => {
  keepSetup();
  if (!hasKey()) {
    $('keyResult').textContent = 'Enter the service key first.';
    $('keyInput').focus();
    return;
  }
  const link = makeSetupLink();
  const message = setupMessage(link);
  $('sendLink').value = link;
  $('sendEmail').href =
    'mailto:?subject=' + encodeURIComponent('Captions setup') + '&body=' + encodeURIComponent(message);
  $('sendText').href = 'sms:?&body=' + encodeURIComponent(message);
  $('sendText').hidden = !(iOS || /Android/i.test(navigator.userAgent));
  $('sendShare').hidden = !navigator.share;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  $('sendResult').textContent = local
    ? 'This link points at this computer, so it will not work on a phone. Open Captions at its real address and send the link from there.'
    : '';
  openSheet('send');
});

$('sendCopy').addEventListener('click', async () => {
  const box = $('sendLink');
  let copied = false;
  try {
    await navigator.clipboard.writeText(box.value);
    copied = true;
  } catch (e) {
    try {
      box.focus();
      box.select();
      copied = document.execCommand('copy');
    } catch (e2) {}
  }
  $('sendResult').textContent = copied
    ? 'Copied. Paste it into a message to the other phone.'
    : 'Could not copy by itself. Press and hold the link above and choose Copy.';
});

$('sendShare').addEventListener('click', async () => {
  try {
    await navigator.share({ title: 'Captions setup', text: setupMessage($('sendLink').value) });
  } catch (e) {}
});

$('sendLink').addEventListener('focus', () => $('sendLink').select());

// ---- taking in a setup link or a key ----------------------------------------

$('pasteSetup').addEventListener('click', pasteSetup);
$('showDemo').addEventListener('click', startDemo);

/**
 * Takes whatever was pasted: a setup link (or its code), or a bare service key.
 * Returns true if it was recognised (whether or not it turned out to be valid).
 */
async function usePasted(raw) {
  const text = (raw || '').trim();
  if (!text) return false;
  if (applySetupCode(text)) {
    afterSetup();
    return true;
  }
  const key = text.replace(/^["'‘’“”\s]+|["'‘’“”\s]+$/g, '');
  if (!looksLikeKey(key)) return false;

  // Not one of our setup links, but shaped like a service key: ask the service.
  notice('Checking the key…', ['One moment.'], []);
  const result = await testKey(key);
  closeSheet('notice');
  if (result.code === 'auth') {
    notice('That key was not accepted', [
      SERVICE.name + ' said: “' + result.said + '”',
      'Make sure the whole key was copied, with nothing added. It is one long word, usually starting with ' + KEY_PREFIX + '.',
    ]);
    return true;
  }
  settings.engineKey = key;
  saveSettings();
  if (result.ok) {
    afterSetup();
    return true;
  }
  closeAll();
  renderEmpty();
  if (result.code === 'quota') {
    notice('The key is right, but the account has run out', [
      SERVICE.name + ' said: “' + result.said + '”',
      'The key is saved. Captions will work once the ' + SERVICE.name + ' account has allowance or credit again.',
    ]);
  } else {
    notice('The key is saved, but could not be checked', [
      result.message,
      'Check the internet connection, then tap Start listening.',
    ]);
  }
  return true;
}

async function pasteSetup() {
  let text = '';
  try {
    text = (await navigator.clipboard.readText()).trim();
  } catch (e) {}
  // Only act on the clipboard by itself when it plainly holds one of ours or a service
  // key. Anything else could be private, and checking a key means sending it out.
  const ours = /setup=[\w-]{16,}/.test(text) || (text.startsWith(KEY_PREFIX) && looksLikeKey(text));
  if (ours && (await usePasted(text))) return;

  const box = document.createElement('textarea');
  box.placeholder = 'Press and hold here, then tap Paste';
  box.setAttribute('autocapitalize', 'off');
  box.setAttribute('autocomplete', 'off');
  box.spellcheck = false;
  notice(
    'Paste the setup link or key',
    ['Copy the setup link you were sent, or your ' + SERVICE.name + ' key, then paste it into this box.'],
    [
      {
        label: 'Use this',
        primary: true,
        run: async () => {
          if (await usePasted(box.value)) return;
          notice('That was not a setup link or a key', [
            'A setup link starts with https and contains #setup=. A key from ' + SERVICE.name +
              ' is one long word, usually starting with ' + KEY_PREFIX + '.',
            'Copy the whole thing and try again.',
          ]);
        },
      },
      { label: 'Cancel' },
    ],
    box
  );
}

function afterSetup() {
  closeAll();
  renderEmpty();
  if (iOS && !installed) {
    notice('Captions is set up', [
      'One more step: put Captions on the Home Screen.',
      'Tap the Share button in Safari (the square with an arrow), then “Add to Home Screen”. After that, open Captions from its icon.',
    ]);
  } else {
    notice('Captions is set up', ['Tap Start listening whenever you are ready.']);
  }
}

// ---- main controls ----------------------------------------------------------

$('main').addEventListener('click', () => {
  const state = session.state;
  if (state === 'idle') start();
  else if (state === 'waiting') session.resumeMicrophone();
  else if (state !== 'finishing') pause();
});

$('latest').addEventListener('click', () => view.jumpToLatest());
window.addEventListener('resize', () => view.refit());
window.addEventListener('online', () => showState(session.state, null));
window.addEventListener('offline', () => showState(session.state, null));

// Save little and often, and whenever the app is put away.
setInterval(() => saveConversation(false), 15000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveConversation(false);
});
window.addEventListener('pagehide', () => saveConversation(false));

// Stop by itself if it has been left running with nobody talking.
setInterval(() => {
  if (demo || session.state !== 'listening' || !settings.autoPauseMin) return;
  if (Date.now() - lastWordAt < settings.autoPauseMin * 60000) return;
  pause().then(() => showNote('Paused because nobody had spoken for a while.', 'OK', hideNote));
}, 20000);

// ---- starting up ------------------------------------------------------------

async function restoreAfterRestart() {
  let id = '';
  try {
    id = sessionStorage.getItem(RESUME_KEY) || '';
    sessionStorage.removeItem(RESUME_KEY);
  } catch (e) {}
  if (!id) return;
  const saved = (await history.listConversations()).find((c) => String(c.id) === id);
  if (!saved || !view.isEmpty) return;
  view.restore(saved.turns);
  conversation = { id: saved.id, startedAt: saved.startedAt };
  renderEmpty();
  showState('idle');
  showNote('Restarted. Tap Start listening to carry on.', 'OK', hideNote);
}

fillSetupTexts();
applyTheme();
const justSetUp = importPendingSetup(installed);
renderEmpty();
showState('idle');
if (justSetUp) afterSetup();
restoreAfterRestart();
history.pruneConversations();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// For testing from the browser console.
window.captions = {
  session,
  view,
  settings,
  startDemo,
  dropConnection: () => DemoEngine.current && DemoEngine.current.drop(),
};
