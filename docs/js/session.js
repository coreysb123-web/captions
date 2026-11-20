// Runs one conversation: microphone -> speech engine -> transcript.
//
// It keeps going through pauses and dropped connections without losing or repeating
// words, and it keeps people's names attached to their voices when the engine has to
// be reconnected. Speech engines number the speakers afresh on every connection, so
// on each new connection we first replay a few seconds of every voice we already
// know ("the primer"), see which number the engine gives each one, and map those
// numbers back to the people already on screen.
//
// Time is measured on the conversation's own audio clock: frame N is the Nth 100 ms
// of audio captured since the conversation started (pauses do not count).
//
// Engine interface (see engines/):
//   caps       { burstMs, liveLabels }
//              burstMs:    how much stored audio may be handed over at once on connecting
//              liveLabels: speaker labels on unsettled words are stable enough to show
//   open()     start connecting; emits { type: 'open' } when audio may be sent
//   send(buf)  one 100 ms frame of 16 kHz 16-bit mono audio (ArrayBuffer)
//   endPrimer() everything sent so far on this connection was primer audio
//   finish()   no more audio; emits what is left, then { type: 'close', clean: true }
//   close()    stop immediately, no more events
// Events:
//   { type: 'result', final: [piece], interim: [piece] }
//       piece = { t: text, s: speaker label or null, a, b: ms since the connection's
//                 first frame (-1 if unknown), primer: true if it came from primer audio }
//   { type: 'primed' }            all primer audio has been labelled
//   { type: 'merge', from, to }   two speaker labels turned out to be one person
//   { type: 'close', clean, error: { code, message } }
//       codes: auth, quota, setup (stop and tell the user); network, server, busy (retry)

const FRAME_MS = 100;
const RING_FRAMES = 300; // keep the last 30 s of audio
const VOICE_FRAMES = 30; // remember about 3 s of each person's voice
const VOICE_MIN_FRAMES = 12; // less than this is not worth re-introducing
const MAX_VOICES = 8;
const GAP_FRAMES = 4; // silence between voices in the primer
const TAIL_BACK_MS = 500; // on reconnect, start a little before the last settled word
const MIN_VOTE_MS = 250;
const DRAFT_SIGHTINGS = 2; // a new voice must show up this many times running before it gets a chip
const RETRY_MS = [250, 1000, 2000, 4000, 6000];
const SILENCE = new Int16Array(1600);
const FATAL = { auth: 1, quota: 1, setup: 1 };

const noop = () => {};

export class Session {
  /**
   * view        TranscriptView
   * makeEngine  (emit) => engine
   * makeSource  (firstFrame) => microphone-like source
   * onState     (state, detail)      idle | starting | listening | reconnecting | waiting | finishing
   * onLevel     (loudness 0..1)
   * onWords     ()                   settled words were added
   * onFailure   ({ code, message })  stopped because of a problem the user must fix
   */
  constructor({ view, makeEngine, makeSource, onState, onLevel, onWords, onFailure }) {
    this.view = view;
    this.makeEngine = makeEngine;
    this.makeSource = makeSource;
    this.onState = onState || noop;
    this.onLevel = onLevel || noop;
    this.onWords = onWords || noop;
    this.onFailure = onFailure || noop;

    this.state = 'idle';
    this.want = false;
    this.conn = null;
    this.source = null;
    this.newConversation();

    setInterval(() => this._watch(), 1000);
    window.addEventListener('online', () => this._retryNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._wake();
    });
  }

  /** Forget the audio and voices of the previous conversation. Only when idle. */
  newConversation() {
    this.frames = 0; // frames captured so far: the conversation's audio clock
    this.ring = []; // recent audio: [{ i, pcm }]
    this.voices = new Map(); // speaker id -> { frames: [Int16Array], last, heard }
    this.watermark = -1; // audio time (ms) up to which settled words are on screen
    this.primerOff = false; // set if an engine objected to the primer
    this.failures = 0; // connection attempts in a row that never produced anything
  }

  get active() {
    return this.state !== 'idle';
  }

  /** Begin listening. Call straight from a tap. Rejects if the microphone cannot start. */
  start() {
    if (this.state !== 'idle') return Promise.resolve();
    this.want = true;
    this.micLive = false;
    this.muted = false;
    this.wasLive = false;
    this.wasListening = false;
    this.pendingConnect = false;
    this.retry = 0;
    this.failures = 0;
    this.lastError = null;
    this._set('starting');
    this._connect();
    return this._startSource().catch((err) => {
      this._shutdown();
      throw err;
    });
  }

  /** Stop listening, letting the engine finish the words it is still working on. */
  async pause() {
    if (!this.want) return;
    this.want = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this._set('finishing');
    const source = this.source;
    this.source = null;
    this.micLive = false;
    if (source) await source.stop().catch(noop);
    const conn = this.conn;
    if (conn && conn.open) {
      await new Promise((resolve) => {
        conn.whenClosed = resolve;
        conn.engine.finish();
        setTimeout(resolve, 2500);
      });
    }
    if (conn) conn.engine.close();
    this.conn = null;
    this.view.update([], []);
    this._set('idle');
  }

  /** The microphone was interrupted and could not restart by itself: try again from a tap. */
  resumeMicrophone() {
    if (!this.want) return Promise.resolve();
    return this._restartSource();
  }

  // ---- microphone -----------------------------------------------------------

  _startSource() {
    const source = this.makeSource(this.frames);
    this.source = source;
    source.onFrame = (buffer, rms) => {
      if (this.source === source) this._onFrame(buffer, rms);
    };
    source.onProblem = (what) => {
      if (this.source === source) this._onSourceProblem(what);
    };
    return source.start().then(() => {
      if (this.source !== source) {
        source.stop().catch(noop);
        return;
      }
      this.muted = false;
      this.lastFrameAt = performance.now();
      this._micIsLive();
    });
  }

  _restartSource() {
    const old = this.source;
    this.source = null;
    this.micLive = false;
    if (old) old.stop().catch(noop);
    this._refresh();
    return this._startSource().catch(() => {
      // Needs a tap from the user; the screen offers one while we are "waiting".
      this.micLive = false;
      this._refresh();
    });
  }

  _micIsLive() {
    this.micLive = true;
    this.wasLive = true;
    if (this.pendingConnect) {
      this.pendingConnect = false;
      this._connect();
    }
    this._refresh();
  }

  _onSourceProblem(what) {
    if (!this.want) return;
    if (what === 'suspended') {
      this.source.nudge();
    } else if (what === 'muted') {
      this.muted = true;
      this.micLive = false;
      this._refresh();
    } else if (what === 'unmuted') {
      this.muted = false;
      this.lastFrameAt = performance.now();
      this.source.nudge();
      this._micIsLive();
    } else if (what === 'ended') {
      this._restartSource();
    }
  }

  _onFrame(buffer, rms) {
    if (!this.want || this.muted) return;
    const pcm = new Int16Array(buffer);
    const i = this.frames++;
    this.ring.push({ i, pcm });
    if (this.ring.length > RING_FRAMES) this.ring.shift();
    const conn = this.conn;
    if (conn && conn.open) conn.engine.send(buffer);
    this.lastFrameAt = performance.now();
    this.onLevel(rms);
  }

  /** Once a second: notice a microphone that has silently stopped delivering audio. */
  _watch() {
    if (!this.want || !this.source || !this.micLive) return;
    const quiet = performance.now() - this.lastFrameAt;
    if (quiet > 6000) this._restartSource();
    else if (quiet > 2000) this.source.nudge();
  }

  /** The app came back to the front. */
  _wake() {
    if (!this.want) return;
    if (this.source) {
      if (this.source.ended) this._restartSource();
      else this.source.nudge();
    }
    this._retryNow();
  }

  // ---- engine connection ----------------------------------------------------

  _connect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.conn) this.conn.engine.close();
    const conn = {
      open: false,
      map: new Map(), // engine speaker label -> speaker id on screen
      votes: new Map(), // label -> Map(speaker id -> ms of primer audio)
      drafts: new Map(), // unmapped label -> results in a row in which it appeared
      settled: false,
      primer: [], // [{ from, to, id }] in this connection's own time
      primerMs: 0,
      base: 0, // conversation time of the first non-primer frame sent
      cut: this.watermark, // words before this are already on screen
      gotResult: false,
    };
    this.conn = conn;
    conn.engine = this.makeEngine((ev) => {
      if (this.conn === conn) this._onEngine(conn, ev);
    });
    conn.engine.open();
  }

  /** A retry is waiting on its timer: do it now (network came back, app came to the front). */
  _retryNow() {
    if (!this.want || !this.retryTimer) return;
    if (this.micLive) this._connect();
  }

  _onEngine(conn, ev) {
    if (ev.type === 'result') this._onResult(conn, ev);
    else if (ev.type === 'open') this._onOpen(conn);
    else if (ev.type === 'close') this._onClose(conn, ev);
    else if (ev.type === 'primed') this._settle(conn);
    else if (ev.type === 'merge') this._onMerge(conn, ev);
  }

  _onOpen(conn) {
    const engine = conn.engine;

    // Audio that still has to become text: from just before the last settled word.
    const wanted = Math.floor(Math.max(0, this.watermark - TAIL_BACK_MS) / FRAME_MS);
    let first = this.ring.length ? Math.max(this.ring[0].i, wanted) : this.frames;
    const allowance = engine.caps.burstMs / FRAME_MS; // how much we may hand over in one go
    if (this.frames - first > allowance) first = this.frames - Math.floor(allowance);
    let budget = this.primerOff ? 0 : allowance - (this.frames - first);

    // First, re-introduce the voices we already know, most recent last.
    let sent = 0;
    const known = [...this.voices]
      .filter(([, v]) => v.frames.length >= VOICE_MIN_FRAMES)
      .sort((x, y) => y[1].heard - x[1].heard)
      .slice(0, MAX_VOICES);
    const chosen = [];
    for (const entry of known) {
      const cost = entry[1].frames.length + GAP_FRAMES;
      if (cost > budget) break;
      budget -= cost;
      chosen.push(entry);
    }
    for (const [id, voice] of chosen.reverse()) {
      conn.primer.push({ from: sent * FRAME_MS, to: (sent + voice.frames.length) * FRAME_MS, id });
      for (const pcm of voice.frames) engine.send(pcm.buffer);
      sent += voice.frames.length;
      for (let i = 0; i < GAP_FRAMES; i++) engine.send(SILENCE.buffer);
      sent += GAP_FRAMES;
    }
    conn.primerMs = sent * FRAME_MS;
    if (sent) engine.endPrimer();
    else conn.settled = true; // nothing to match up

    // Then the outstanding audio; live frames follow from _onFrame.
    conn.base = first * FRAME_MS;
    for (const f of this.ring) if (f.i >= first) engine.send(f.pcm.buffer);
    conn.open = true;
    this._refresh();
  }

  _onResult(conn, ev) {
    if (!conn.gotResult) {
      conn.gotResult = true;
      this.retry = 0;
      this.failures = 0;
    }

    const finals = [];
    for (const p of ev.final) {
      if (p.primer) {
        this._vote(conn, p);
        continue;
      }
      const timed = p.b >= 0;
      const a = timed ? conn.base + p.a - conn.primerMs : this.frames * FRAME_MS;
      const b = timed ? conn.base + p.b - conn.primerMs : a;
      if (timed && (a + b) / 2 <= conn.cut) continue; // already on screen from before the reconnect
      const spk = this._speakerFor(conn, p.s);
      finals.push({ spk, text: p.t, a, b });
      if (timed) this._remember(spk, a, b);
      if (b > this.watermark) this.watermark = b;
    }

    // Count how long each not-yet-known voice has been showing up in unsettled words.
    const sighted = new Set();
    for (const p of ev.interim) if (p.s != null && !conn.map.has(p.s)) sighted.add(p.s);
    for (const label of [...conn.drafts.keys()]) if (!sighted.has(label)) conn.drafts.delete(label);
    for (const label of sighted) conn.drafts.set(label, (conn.drafts.get(label) || 0) + 1);

    const interim = [];
    for (const p of ev.interim) {
      if (p.primer) continue;
      const timed = p.b >= 0;
      const a = timed ? conn.base + p.a - conn.primerMs : 0;
      const b = timed ? conn.base + p.b - conn.primerMs : 0;
      if (timed && (a + b) / 2 <= conn.cut) continue;
      const spk = this._guessSpeaker(conn, p.s);
      if (spk && timed) {
        // Someone with no settled words yet: their unsettled words are the only sample of
        // their voice, and without one they could not be recognised after a reconnect.
        const voice = this.voices.get(spk);
        if (!voice || voice.frames.length < VOICE_MIN_FRAMES) this._remember(spk, a, b);
      }
      const last = interim[interim.length - 1];
      if (last && last.spk === spk) last.text += p.t;
      else interim.push({ spk, text: p.t });
    }

    this.view.update(finals, interim);
    if (finals.length) this.onWords();
  }

  _onClose(conn, ev) {
    const wasOpen = conn.open;
    conn.open = false;
    if (conn.whenClosed) conn.whenClosed();
    if (!this.want) return;
    const error = ev.error;
    if (error && FATAL[error.code]) {
      this._shutdown();
      this.onFailure(error);
      return;
    }
    // If the engine choked while being handed the primer, do without it from now on.
    if (error && error.code === 'busy' && conn.primerMs) this.primerOff = true;
    if (!conn.gotResult) this.failures++;
    this.view.update([], []); // words still settling will be heard again after reconnecting
    this.lastError = error || null;
    this._refresh();
    const wait = ev.clean && wasOpen ? 0 : RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];
    this.retry++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.want) return;
      // No point connecting while the phone has taken the microphone away.
      if (this.micLive || !this.wasLive) this._connect();
      else this.pendingConnect = true;
    }, wait);
  }

  // ---- who is speaking ------------------------------------------------------

  _vote(conn, piece) {
    if (piece.s == null || !(piece.b >= 0)) return;
    const mid = (piece.a + piece.b) / 2;
    for (const seg of conn.primer) {
      if (mid < seg.from || mid >= seg.to) continue;
      let tally = conn.votes.get(piece.s);
      if (!tally) conn.votes.set(piece.s, (tally = new Map()));
      tally.set(seg.id, (tally.get(seg.id) || 0) + Math.max(1, piece.b - piece.a));
      return;
    }
  }

  /** Decide which engine label is which known person, strongest evidence first. */
  _settle(conn) {
    if (conn.settled) return;
    conn.settled = true;
    const pairs = [];
    for (const [label, tally] of conn.votes) {
      for (const [id, weight] of tally) pairs.push({ label, id, weight });
    }
    pairs.sort((x, y) => y.weight - x.weight);
    const taken = new Set();
    for (const p of pairs) {
      if (p.weight < MIN_VOTE_MS || conn.map.has(p.label) || taken.has(p.id)) continue;
      if (!this.view.speakers.has(p.id)) continue;
      conn.map.set(p.label, p.id);
      taken.add(p.id);
    }
  }

  _speakerFor(conn, label) {
    this._settle(conn);
    if (label == null) {
      const last = this.view.lastSpeaker;
      if (last) return last;
      label = '?';
    }
    let id = conn.map.get(label);
    if (!id) {
      id = this.view.addSpeaker().id;
      conn.map.set(label, id);
    }
    return id;
  }

  /** For words still settling: who it probably is, or null to show a neutral chip. */
  _guessSpeaker(conn, label) {
    if (label == null) return null;
    const known = conn.map.get(label);
    if (known) return known;
    if (!conn.settled) {
      // Still matching voices: go by the evidence so far, without committing to it.
      const tally = conn.votes.get(label);
      if (!tally) return null;
      let best = null;
      let top = 0;
      for (const [id, weight] of tally) {
        if (weight > top) {
          top = weight;
          best = id;
        }
      }
      return top >= MIN_VOTE_MS ? best : null;
    }
    // A voice we have not met. Give it a chip once it has stuck around, so a label the
    // engine tries for one moment and then drops does not become a phantom person.
    if (conn.engine.caps.liveLabels && (conn.drafts.get(label) || 0) >= DRAFT_SIGHTINGS) {
      const id = this.view.addSpeaker().id;
      conn.map.set(label, id);
      conn.drafts.delete(label);
      return id;
    }
    return null;
  }

  /** The engine decided two of its labels are the same person. */
  _onMerge(conn, { from, to }) {
    const gone = conn.map.get(from);
    const kept = conn.map.get(to);
    if (gone && kept && gone !== kept) {
      this.view.mergeSpeakers(gone, kept);
      const voice = this.voices.get(gone);
      if (voice && !this.voices.has(kept)) this.voices.set(kept, voice);
      this.voices.delete(gone);
      for (const [label, id] of conn.map) if (id === gone) conn.map.set(label, kept);
    } else if (gone && !kept) {
      conn.map.set(to, gone);
    } else if (kept) {
      conn.map.set(from, kept);
    }
  }

  /** Keep the most recent few seconds of this person's voice for later re-introduction. */
  _remember(id, a, b) {
    if (!this.ring.length) return;
    let voice = this.voices.get(id);
    if (!voice) this.voices.set(id, (voice = { frames: [], last: -1, heard: 0 }));
    voice.heard = b;
    const oldest = this.ring[0].i;
    const from = Math.max(Math.floor(a / FRAME_MS), voice.last + 1, oldest);
    const to = Math.ceil(b / FRAME_MS) - 1;
    for (let i = from; i <= to; i++) {
      const f = this.ring[i - oldest];
      if (!f) break;
      voice.frames.push(f.pcm);
      voice.last = i;
    }
    if (voice.frames.length > VOICE_FRAMES) voice.frames.splice(0, voice.frames.length - VOICE_FRAMES);
  }

  // ---- state ----------------------------------------------------------------

  _refresh() {
    if (!this.want) return;
    let state;
    if (!this.micLive) state = this.wasLive ? 'waiting' : 'starting';
    else if (!this.conn || !this.conn.open) state = this.wasListening ? 'reconnecting' : 'starting';
    else {
      state = 'listening';
      this.wasListening = true;
    }
    this._set(state);
  }

  _set(state) {
    const detail =
      state === 'reconnecting' || state === 'starting'
        ? { error: this.lastError, failures: this.failures }
        : null;
    const key = detail ? `${state}:${detail.failures}:${detail.error ? detail.error.code : ''}` : state;
    if (key === this.stateKey) return;
    this.stateKey = key;
    this.state = state;
    this.onState(state, detail);
  }

  _shutdown() {
    this.want = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const source = this.source;
    this.source = null;
    this.micLive = false;
    if (source) source.stop().catch(noop);
    if (this.conn) this.conn.engine.close();
    this.conn = null;
    this.view.update([], []);
    this._set('idle');
  }
}
