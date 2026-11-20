// Speech engine: ElevenLabs "Scribe v3 Live" (real-time transcription with live speaker labels).
//
// How a connection works (from the ElevenLabs realtime speech-to-text documentation):
//   1. The service key is exchanged for a single-use token (a plain HTTPS request, allowed
//      from a web page). The key itself never goes into the WebSocket address.
//   2. A WebSocket is opened with that token. Audio goes up as JSON messages holding
//      base64 16 kHz PCM; results come back as JSON events:
//        partial_transcript    words so far in the segment in progress, with draft speakers
//        committed_transcript  the segment's text is final (speakers follow separately)
//        diarized_transcript   the segment's words with their final speakers and timings
//        speakers_merged       two speaker ids turned out to be the same person
//   3. The service ends a segment by itself when it hears a pause.
//
// NOT YET VERIFIED AGAINST THE LIVE SERVICE (needs a real key to check):
//   - that word timings count from the start of the connection (the code detects and
//     copes with timings that restart on each segment, at the cost of voice matching);
//   - how fast stored audio may be sent when catching up (SPEED below; the service's own
//     examples send at 2.5x to 5x real time);
//   - the maximum length of one connection (the code reconnects when told the limit is hit).

const TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe';
const SOCKET_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const MODEL = 'scribe_v3_live';
const RATE = 16000;
const FRAME_MS = 100;
const SPEED = 5; // when catching up, send stored audio at most this many times real time
const BUCKET_FRAMES = 10; // ...after up to one second sent straight away
const FRAMES_PER_MESSAGE = 5;
const CONNECT_TIMEOUT_MS = 10000;
const PAUSE_SECS = 0.6; // silence that ends a segment (speaker labels are settled per segment)
const MAX_TERMS = 50;
const MAX_TERM_CHARS = 20;
const STALL_BYTES = 400000; // unsent data that means the network has stopped moving
const STALL_MS = 8000;

export const SERVICE = {
  name: 'ElevenLabs',
  site: 'elevenlabs.io',
  pricePerHour: 0.22,
  extraForTerms: 0.08,
  languages: [
    ['en', 'English'],
    ['', 'Detect automatically'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['de', 'German'],
    ['it', 'Italian'],
    ['pt', 'Portuguese'],
    ['nl', 'Dutch'],
    ['pl', 'Polish'],
    ['sv', 'Swedish'],
    ['el', 'Greek'],
    ['hi', 'Hindi'],
    ['zh', 'Chinese'],
    ['ja', 'Japanese'],
    ['ar', 'Arabic'],
  ],
};

// Error events the service can send before closing, and what we do about each.
const ERRORS = {
  auth_error: 'auth',
  quota_exceeded: 'quota',
  unaccepted_terms: 'setup',
  invalid_request: 'setup',
  session_time_limit_exceeded: 'limit',
  rate_limited: 'busy',
  queue_overflow: 'busy',
  resource_exhausted: 'busy',
  transcriber_error: 'server',
  input_error: 'server',
  chunk_size_exceeded: 'server',
  commit_throttled: 'server',
  insufficient_audio_activity: 'server',
  error: 'server',
};

function problem(code, message) {
  return { code, message: message || '' };
}

async function describe(response) {
  try {
    const body = await response.json();
    const d = body && body.detail;
    if (typeof d === 'string') return d;
    if (d && typeof d.message === 'string') return d.message;
  } catch (e) {}
  return 'The service answered with error ' + response.status + '.';
}

async function mintToken(key, signal) {
  let response;
  try {
    response = await fetch(TOKEN_URL, { method: 'POST', headers: { 'xi-api-key': key }, signal });
  } catch (e) {
    throw problem('network', 'Could not reach the speech service.');
  }
  if (response.status === 401 || response.status === 403) throw problem('auth', await describe(response));
  if (response.status === 429) throw problem('busy', await describe(response));
  if (!response.ok) throw problem('server', await describe(response));
  let data = null;
  try {
    data = await response.json();
  } catch (e) {}
  if (!data || !data.token) throw problem('server', 'The service did not return a token.');
  return data.token;
}

/** Checks that a key is accepted, without opening an audio connection (so no usage is billed). */
export async function testKey(key) {
  if (!key) return { ok: false, message: 'No key entered.' };
  try {
    await mintToken(key);
    return { ok: true, message: 'The key works.' };
  } catch (e) {
    if (e.code === 'auth') {
      return { ok: false, message: 'The key was not accepted. ' + e.message };
    }
    return { ok: false, message: e.message || 'Could not check the key.' };
  }
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x6000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x6000));
  }
  return btoa(binary);
}

/** Up to 50 terms of up to 20 characters each: the service's limits for live transcription. */
export function usableTerms(terms) {
  return terms.filter((t) => t.length <= MAX_TERM_CHARS).slice(0, MAX_TERMS);
}

export class ElevenLabsEngine {
  constructor({ key, language, terms }, emit) {
    this.key = key;
    this.language = language || '';
    this.terms = usableTerms(terms || []);
    this.emit = emit;
    this.caps = { burstMs: 24000, liveLabels: true };

    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.finishing = false;
    this.pendingError = null;

    this.queue = []; // [{ buf, commit }] waiting to be sent
    this.queued = 0; // frames ever queued
    this.sent = 0; // frames actually sent
    this.tokens = BUCKET_FRAMES;
    this.lastFill = 0;

    this.primerMs = 0;
    this.phase = 'live'; // 'primer' while results still belong to primer audio
    this.primedSent = true;

    this.aliases = new Map(); // merged speaker id -> the id it became
    this.partial = []; // pieces of the segment in progress
    this.held = []; // committed segments waiting for their final speakers
    this.timed = []; // recent word timings from committed_transcript_with_timestamps
    this.timesOk = true;
    this.lastEnd = 0;
    this.segments = 0;
  }

  // ---- interface ------------------------------------------------------------

  open() {
    this._connect().catch((error) => this._abort(error && error.code ? error : problem('network', String(error))));
  }

  send(buffer) {
    if (this.closed || this.finishing) return;
    this.queue.push({ buf: buffer, commit: false });
    this.queued++;
    this._pump();
  }

  /** Everything queued so far is primer audio: close that segment off, then expect live audio. */
  endPrimer() {
    if (!this.queued) return;
    this.primerMs = this.queued * FRAME_MS;
    this.phase = 'primer';
    this.primedSent = false;
    if (this.queue.length) this.queue[this.queue.length - 1].commit = true;
    else this._transmit([], true); // all of it has already gone: send the segment break on its own
  }

  finish() {
    if (this.closed || this.finishing) return;
    this.finishing = true;
    this.queue.length = 0; // anything not yet sent stays in the session's buffer for next time
    clearTimeout(this.pumpTimer);
    if (!this.ready) {
      this._done();
      return;
    }
    // Close off the segment in progress so its last words come back settled.
    try {
      this.ws.send(
        JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: RATE })
      );
    } catch (e) {
      this._done();
      return;
    }
    // If nothing was being said, there is nothing to wait for.
    this.finishTimer = setTimeout(() => {
      if (!this.partial.length && !this.held.length) this._done();
    }, 900);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    clearTimeout(this.pumpTimer);
    clearTimeout(this.finishTimer);
    if (this.aborter) this.aborter.abort();
    const ws = this.ws;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch (e) {}
    }
  }

  // ---- connecting -----------------------------------------------------------

  async _connect() {
    // iPhones sometimes leave a new connection hanging after the app has been in the
    // background, so every attempt is on a timer.
    this.connectTimer = setTimeout(
      () => this._abort(problem('network', 'Connecting took too long.')),
      CONNECT_TIMEOUT_MS
    );
    this.aborter = typeof AbortController === 'function' ? new AbortController() : null;
    const token = await mintToken(this.key, this.aborter ? this.aborter.signal : undefined);
    if (this.closed) return;

    const query = new URLSearchParams({
      model_id: MODEL,
      token,
      audio_format: 'pcm_16000',
      diarize: 'true',
      commit_strategy: 'vad',
      vad_silence_threshold_secs: String(PAUSE_SECS),
      include_timestamps: 'true',
    });
    if (this.language) query.set('language_code', this.language);
    for (const term of this.terms) query.append('keyterms', term);

    const ws = (this.ws = new WebSocket(SOCKET_URL + '?' + query.toString()));
    ws.onmessage = (e) => this._onMessage(e);
    ws.onclose = () => this._onSocketClose();
    ws.onerror = () => {};
  }

  _abort(error) {
    if (this.closed) return;
    this.close();
    this.emit({ type: 'close', clean: false, error });
  }

  _done() {
    if (this.closed) return;
    this.close();
    this.emit({ type: 'close', clean: true });
  }

  _onSocketClose() {
    if (this.closed) return;
    const error = this.pendingError;
    const clean = this.finishing || (error && error.code === 'limit');
    this.close();
    this.emit({
      type: 'close',
      clean: !!clean,
      error: clean ? null : error || problem('network', 'The connection was lost.'),
    });
  }

  // ---- sending audio --------------------------------------------------------

  _pump() {
    if (!this.ready || this.closed) return;
    const ws = this.ws;
    const now = performance.now();
    this.tokens = Math.min(BUCKET_FRAMES, this.tokens + ((now - this.lastFill) * SPEED) / FRAME_MS);
    this.lastFill = now;

    // If data is piling up unsent, the network has stopped; do not add to the pile.
    if (ws.bufferedAmount > STALL_BYTES) {
      if (!this.stalledAt) this.stalledAt = now;
      else if (now - this.stalledAt > STALL_MS) {
        this._abort(problem('network', 'The connection stopped moving.'));
        return;
      }
    } else {
      this.stalledAt = 0;
      while (this.queue.length && this.tokens >= 1) {
        const limit = Math.min(FRAMES_PER_MESSAGE, Math.floor(this.tokens));
        const parts = [];
        let commit = false;
        while (parts.length < limit && this.queue.length) {
          const item = this.queue.shift();
          parts.push(item.buf);
          if (item.commit) {
            commit = true;
            break;
          }
        }
        this.tokens -= parts.length;
        this._transmit(parts, commit);
      }
    }

    // After a while with no sign that the primer has been dealt with, stop waiting for it.
    if (this.phase === 'primer' && this.sent * FRAME_MS - this.primerMs > 12000) {
      this.phase = 'live';
      this._maybePrimed();
    }

    clearTimeout(this.pumpTimer);
    if (this.queue.length) this.pumpTimer = setTimeout(() => this._pump(), 50);
  }

  _transmit(parts, commit) {
    let bytes;
    if (parts.length === 1) {
      bytes = new Uint8Array(parts[0]);
    } else {
      let total = 0;
      for (const p of parts) total += p.byteLength;
      bytes = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        bytes.set(new Uint8Array(p), at);
        at += p.byteLength;
      }
    }
    this.sent += parts.length;
    try {
      this.ws.send(
        JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: toBase64(bytes),
          commit,
          sample_rate: RATE,
        })
      );
    } catch (e) {
      // The close handler reports the failure.
    }
  }

  // ---- receiving results ----------------------------------------------------

  _onMessage(e) {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch (err) {
      return;
    }
    switch (m.message_type) {
      case 'session_started':
        clearTimeout(this.connectTimer);
        this.ready = true;
        this.lastFill = performance.now();
        this.emit({ type: 'open' });
        this._pump();
        break;
      case 'partial_transcript':
        this._onPartial(m);
        break;
      case 'committed_transcript':
        this._onCommitted(m);
        break;
      case 'committed_transcript_with_timestamps':
        if (Array.isArray(m.words)) {
          this.timed.push({ text: m.text, words: m.words });
          if (this.timed.length > 6) this.timed.shift();
        }
        break;
      case 'diarized_transcript':
        this._onDiarized(m);
        break;
      case 'speakers_merged':
        this._onMerged(m);
        break;
      case 'warning':
        console.warn('[captions] speech service warning:', m.warning);
        break;
      default:
        if (ERRORS[m.message_type]) {
          this.pendingError = problem(ERRORS[m.message_type], m.error || m.message_type);
          // The service closes the connection itself after an error; make sure of it.
          setTimeout(() => {
            if (!this.closed) this._onSocketClose();
          }, 1500);
        }
    }
  }

  _alias(id) {
    let hops = 0;
    while (this.aliases.has(id) && hops++ < 50) id = this.aliases.get(id);
    return id;
  }

  /**
   * Turn the service's word list into pieces of text with a speaker and timing each.
   * Spaces and words the service has not attributed yet take the speaker of the word
   * beside them, so a sentence is not chopped up by unlabelled gaps.
   */
  _pieces(words, fallbackText) {
    const out = [];
    if (Array.isArray(words)) {
      for (const w of words) {
        if (!w || typeof w.text !== 'string' || !w.text) continue;
        const timed = typeof w.start === 'number' && typeof w.end === 'number';
        out.push({
          t: w.text,
          s: w.speaker_id != null && w.type !== 'spacing' ? this._alias(String(w.speaker_id)) : null,
          a: timed ? w.start * 1000 : -1,
          b: timed ? w.end * 1000 : -1,
          space: w.type === 'spacing',
        });
      }
    }
    if (!out.length && fallbackText) out.push({ t: fallbackText, s: null, a: -1, b: -1, space: false });
    // A space belongs with the word after it; anything else unlabelled, with the word before.
    for (let i = out.length - 2; i >= 0; i--) if (out[i].space) out[i].s = out[i + 1].s;
    for (let i = 1; i < out.length; i++) if (out[i].s == null) out[i].s = out[i - 1].s;
    for (let i = out.length - 2; i >= 0; i--) if (out[i].s == null) out[i].s = out[i + 1].s;
    if (out.length && !/^\s/.test(out[0].t)) out[0].t = ' ' + out[0].t;
    return out;
  }

  _onPartial(m) {
    let pieces = this._pieces(m.words, m.text);
    if (this.phase === 'primer') {
      // Words here are primer audio being replayed, unless their timing says otherwise.
      const live = pieces.findIndex((p) => p.a >= this.primerMs);
      if (live < 0) pieces = [];
      else {
        pieces = pieces.slice(live);
        this.phase = 'live';
      }
    }
    this.partial = pieces;
    this._report([]);
    this._maybePrimed();
  }

  _onCommitted(m) {
    const pieces = this.partial.length ? this.partial : this._pieces(null, m.text);
    this.held.push({
      index: typeof m.segment_index === 'number' ? m.segment_index : null,
      pieces: this.phase === 'primer' ? [] : pieces,
      primer: this.phase === 'primer',
    });
    this.partial = [];
    if (this.held.length > 8) this.held.shift(); // speakers never arrived for a very old segment
    this._report([]);
  }

  _onDiarized(m) {
    let at = this.held.findIndex((h) => h.index === m.segment_index);
    if (at < 0 && this.held.length) at = 0;
    // A segment counts as primer audio if it was closed off, or arrives, during the primer.
    const segPrimer = this.phase === 'primer' || (at >= 0 && this.held[at].primer);
    if (at >= 0) this.held.splice(0, at + 1);

    let words = m.words;
    const untimed = !Array.isArray(words) || !words.some((w) => w && typeof w.start === 'number');
    if (untimed && Array.isArray(words)) {
      // No timings on the speaker-labelled words: borrow them from the timed copy of the segment.
      const twin = this.timed.find((t) => t.text === m.text && t.words.length === words.length);
      if (twin) words = words.map((w, i) => Object.assign({}, w, { start: twin.words[i].start, end: twin.words[i].end }));
    }
    const pieces = this._pieces(words, m.text);
    this.segments++;

    // Timings should run on from the previous segment and never be ahead of the audio sent.
    let first = -1;
    let last = -1;
    for (const p of pieces) {
      if (p.b < 0) continue;
      if (first < 0) first = p.a;
      last = p.b;
    }
    if (this.timesOk && last >= 0) {
      const sentMs = this.sent * FRAME_MS;
      if (first < this.lastEnd - 600 || last > sentMs + 2000) {
        this.timesOk = false;
        console.warn('[captions] word timings are not continuous; voice matching is switched off.');
        this.phase = 'live'; // without timings there is no telling primer from live: stop hiding words
      }
    }
    if (last >= 0) this.lastEnd = last;

    let carried = -1;
    for (const p of pieces) {
      if (!this.timesOk) {
        p.a = p.b = -1;
      } else if (p.b < 0 && carried >= 0) {
        p.a = p.b = carried;
      } else if (p.b >= 0) {
        carried = p.b;
      }
      if (segPrimer && (p.b < 0 || (p.a + p.b) / 2 < this.primerMs)) p.primer = true;
      else this.phase = 'live'; // a word from after the primer
      delete p.space;
    }
    if (this.timesOk && last >= this.primerMs - 1500) this.phase = 'live';

    this._report(pieces);
    this._maybePrimed();
    if (this.finishing && !this.held.length) this._done();
  }

  _onMerged(m) {
    const from = String(m.from_speaker_id);
    const to = this._alias(String(m.to_speaker_id));
    if (from === to) return;
    this.aliases.set(from, to);
    for (const p of this.partial) if (p.s === from) p.s = to;
    for (const h of this.held) for (const p of h.pieces) if (p.s === from) p.s = to;
    this.emit({ type: 'merge', from, to });
    this._report([]);
  }

  /** Tell the session once that every primer segment has come back with its speakers. */
  _maybePrimed() {
    if (this.primedSent || this.phase !== 'live' || this.held.some((h) => h.primer)) return;
    this.primedSent = true;
    this.emit({ type: 'primed' });
  }

  _report(final) {
    if (this.closed) return;
    let interim = [];
    for (const h of this.held) if (!h.primer) interim = interim.concat(h.pieces);
    interim = interim.concat(this.partial);
    this.emit({ type: 'result', final, interim });
  }
}
