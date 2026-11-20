// A pretend microphone and speech engine, so the app can be tried (and tested)
// with no service key and no real audio. It "hears" a scripted family lunch.
//
// The pretend microphone stamps each 100 ms frame with its position in the script.
// The pretend engine reads those stamps and produces the matching words, numbering
// the speakers in the order it first hears them on each connection, exactly as a
// real engine does. That lets the reconnect and voice-matching logic be exercised
// for real: replayed audio produces the same words with different speaker numbers.

const FRAME = 1600;
const FRAME_MS = 100;
const MAGIC_A = 0x5a5a;
const MAGIC_B = 0x2b2b;

const LINES = [
  ['A', 'Did you manage to get the tomatoes in before the frost?'],
  ['B', 'Just about. I lost two plants, but the rest are ripening on the windowsill.'],
  ['C', 'Dad, tell them what the doctor said about your knee.'],
  ['B', 'Oh, he was happy enough. Six more weeks of the exercises, and then I can go back to bowling.'],
  ['D', "That's great news, Grandpa. Are you still coming to the game on Saturday?"],
  ['B', "I wouldn't miss it. It starts at three, doesn't it?"],
  ['D', "Three o'clock. I'll pick you up at half past two."],
  ['A', 'Take a coat this time. You were frozen last year.'],
  ['C', 'Mum, could you pass the gravy, please?'],
  ['A', 'Here you are. Careful, the jug is hot.'],
  ['C', 'Thank you. This roast is lovely, by the way.'],
  ['D', 'Are there any more potatoes?'],
  ['A', "Plenty. Help yourself, they're in the dish by the oven."],
  ['B', "Susan, how's the new job going?"],
  ['C', 'Really well, thanks. The journey is a bit long, but the people are friendly.'],
  ['D', 'Did you hear back about the apartment?'],
  ['C', "Not yet. They said they'd call on Monday."],
  ['A', 'Well, fingers crossed. Now, who would like some apple pie?'],
];

function buildScript() {
  const words = [];
  let t = 700;
  for (const [who, line] of LINES) {
    for (const w of line.split(' ')) {
      const dur = 120 + w.replace(/[^a-z]/gi, '').length * 55;
      words.push({ who, text: ' ' + w, a: t, b: t + dur });
      t += dur + 45;
    }
    t += 500 + (line.length % 5) * 130;
  }
  // A long enough gap before the script repeats that the repeat starts a fresh block.
  const period = Math.ceil((t + 8000) / FRAME_MS) * FRAME_MS;
  const endsIn = new Map(); // frame number within the script -> words that end in it
  const spoken = new Set(); // frames that contain speech
  for (const w of words) {
    const f = Math.floor((w.b - 1) / FRAME_MS);
    if (!endsIn.has(f)) endsIn.set(f, []);
    endsIn.get(f).push(w);
    for (let i = Math.floor(w.a / FRAME_MS); i <= f; i++) spoken.add(i);
  }
  return { period, endsIn, spoken };
}

const SCRIPT = buildScript();
const FRAMES_PER_LOOP = SCRIPT.period / FRAME_MS;

/** Stands in for the microphone. `firstFrame` continues the conversation's audio clock. */
export class DemoSource {
  constructor(firstFrame = 0) {
    this.next = firstFrame;
    this.onFrame = null;
    this.onProblem = null;
  }

  async start() {
    const t0 = performance.now();
    let made = 0;
    this.timer = setInterval(() => {
      const due = Math.floor((performance.now() - t0) / FRAME_MS);
      // If the page was asleep, do not flood: skip ahead like a real microphone would.
      if (due - made > 20) made = due - 1;
      while (made < due) {
        made++;
        const i = this.next++;
        const pcm = new Int16Array(FRAME);
        pcm[0] = MAGIC_A;
        pcm[1] = i & 0x7fff;
        pcm[2] = (i >> 15) & 0x7fff;
        pcm[3] = MAGIC_B;
        const talking = SCRIPT.spoken.has(i % FRAMES_PER_LOOP);
        const rms = talking ? 0.05 + Math.random() * 0.09 : 0.002 + Math.random() * 0.002;
        if (this.onFrame) this.onFrame(pcm.buffer, rms);
      }
    }, 40);
  }

  async stop() {
    clearInterval(this.timer);
  }

  nudge() {}
}

/** Stands in for the speech service. Same interface as the real engines. */
export class DemoEngine {
  constructor(emit) {
    this.emit = emit;
    this.caps = { burstMs: Infinity, liveLabels: true };
    this.primerMs = 0;
    this.primedSent = true;
    this.pos = 0; // frames received on this connection
    this.prevStamp = -2;
    this.runStart = 0; // script time where the current unbroken stretch of audio began
    this.pending = []; // heard but not yet settled
    this.labels = new Map();
    this.closed = false;
    this.done = false;
    DemoEngine.current = this;
  }

  open() {
    this.openTimer = setTimeout(() => {
      if (!this.closed) this.emit({ type: 'open' });
    }, 300);
  }

  send(buffer) {
    if (this.closed || this.done) return;
    const head = new Int16Array(buffer, 0, 4);
    const pos = this.pos++;
    if (head[0] === MAGIC_A && head[3] === MAGIC_B) {
      const idx = (head[1] & 0x7fff) | ((head[2] & 0x7fff) << 15);
      if (idx !== this.prevStamp + 1) this.runStart = idx * FRAME_MS; // the audio jumped
      this.prevStamp = idx;
      const loop = Math.floor(idx / FRAMES_PER_LOOP);
      const words = SCRIPT.endsIn.get(idx - loop * FRAMES_PER_LOOP);
      if (words) {
        const shift = loop * SCRIPT.period;
        for (const w of words) {
          const wa = w.a + shift;
          const wb = w.b + shift;
          // A word mostly cut off by a jump in the audio is not recognised.
          if (wa < this.runStart - 0.4 * (wb - wa)) continue;
          const b = pos * FRAME_MS + (wb - idx * FRAME_MS);
          const a = Math.max(0, b - (wb - wa));
          this.pending.push({ t: w.text, s: this._label(w.who), a, b });
        }
      }
    } else {
      this.prevStamp = -2; // silence between stretches of audio
    }
    this._schedule();
  }

  endPrimer() {
    this.primerMs = this.pos * FRAME_MS;
    this.primedSent = false;
  }

  finish() {
    if (this.closed || this.done) return;
    this.done = true;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this._flush();
      if (!this.closed) {
        this.closed = true;
        this.emit({ type: 'close', clean: true });
      }
    }, 150);
  }

  close() {
    this.closed = true;
    clearTimeout(this.openTimer);
    clearTimeout(this.flushTimer);
  }

  /** Test hook: behave as if the network connection was lost. */
  drop() {
    if (this.closed) return;
    this.close();
    this.emit({ type: 'close', clean: false, error: { code: 'network', message: 'Simulated drop' } });
  }

  _label(who) {
    if (!this.labels.has(who)) this.labels.set(who, String(this.labels.size + 1));
    return this.labels.get(who);
  }

  _schedule() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._flush();
    }, 70);
  }

  _flush() {
    if (this.closed) return;
    const now = this.pos * FRAME_MS;
    const final = [];
    while (this.pending.length && (this.done || now - this.pending[0].b >= 800)) {
      final.push(this.pending.shift());
    }
    const inPrimer = (p) => (p.a + p.b) / 2 < this.primerMs;
    for (const p of final) if (inPrimer(p)) p.primer = true;
    const interim = this.pending.filter((p) => !inPrimer(p));
    if (final.length || interim.length || this.hadInterim) {
      this.hadInterim = interim.length > 0;
      this.emit({ type: 'result', final, interim });
    }
    if (!this.primedSent && now >= this.primerMs + 800 && !this.pending.some(inPrimer)) {
      this.primedSent = true;
      this.emit({ type: 'primed' });
    }
  }
}

DemoEngine.current = null;
