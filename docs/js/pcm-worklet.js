/* Runs on the audio thread.
 *
 * Takes microphone audio at whatever rate the phone provides (usually 48 kHz),
 * converts it to 16 kHz 16-bit mono, and posts it to the page in 100 ms frames
 * together with a loudness reading for the on-screen level meter.
 *
 * The rate conversion is a windowed-sinc low-pass filter. Speech engines are
 * sensitive to aliasing, so this is done properly rather than by dropping samples.
 */

const OUT_RATE = 16000;
const FRAME_SAMPLES = 1600; // 100 ms
const ZERO_CROSSINGS = 20;  // filter length each side; more = sharper
const TABLE_STEPS = 32;     // filter table resolution per input sample

class Resampler {
  constructor(inRate, outRate) {
    this.step = inRate / outRate; // input samples consumed per output sample
    // Cut off just below the lower of the two Nyquist limits.
    const cutoff = Math.min(1, outRate / inRate) * 0.92;
    this.half = ZERO_CROSSINGS / cutoff; // filter half-width, in input samples
    this.reach = Math.ceil(this.half);

    const size = Math.ceil(this.half * TABLE_STEPS) + 2;
    this.table = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const t = i / TABLE_STEPS;
      if (t >= this.half) break;
      const x = Math.PI * cutoff * t;
      const sinc = x === 0 ? 1 : Math.sin(x) / x;
      const w = t / this.half;
      const blackman = 0.42 + 0.5 * Math.cos(Math.PI * w) + 0.08 * Math.cos(2 * Math.PI * w);
      this.table[i] = cutoff * sinc * blackman;
    }

    // Make a steady input come out at exactly the same level.
    let sum = 0;
    for (let k = -this.reach; k <= this.reach; k++) sum += this.tap(Math.abs(k));
    this.gain = 1 / sum;

    this.buf = new Float32Array(this.reach * 2 + 8192);
    this.len = this.reach; // start with silence as history
    this.pos = this.reach; // fractional read position in buf
  }

  tap(distance) {
    const x = distance * TABLE_STEPS;
    const i = x | 0;
    if (i >= this.table.length - 1) return 0;
    return this.table[i] + (this.table[i + 1] - this.table[i]) * (x - i);
  }

  /** Feed input samples; `emit` is called once per output sample. */
  push(input, emit) {
    if (this.len + input.length > this.buf.length) {
      const bigger = new Float32Array((this.len + input.length) * 2);
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(input, this.len);
    this.len += input.length;

    const buf = this.buf;
    const table = this.table;
    const half = this.half;
    const last = this.len - 1;
    while (this.pos + this.reach < this.len) {
      const p = this.pos;
      let i = Math.ceil(p - half);
      if (i < 0) i = 0;
      let end = Math.floor(p + half);
      if (end > last) end = last;
      let acc = 0;
      for (; i <= end; i++) {
        const x = (i < p ? p - i : i - p) * TABLE_STEPS;
        const k = x | 0;
        acc += buf[i] * (table[k] + (table[k + 1] - table[k]) * (x - k));
      }
      emit(acc * this.gain);
      this.pos = p + this.step;
    }

    // Forget input we no longer need.
    const drop = Math.floor(this.pos - half) - 1;
    if (drop > 0) {
      buf.copyWithin(0, drop, this.len);
      this.len -= drop;
      this.pos -= drop;
    }
  }
}

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new Resampler(sampleRate, OUT_RATE);
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.fill = 0;
    this.sumSquares = 0;
    this.mix = null;

    this.emit = (v) => {
      this.sumSquares += v * v;
      let s = Math.round(v * 32767);
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      this.frame[this.fill++] = s;
      if (this.fill === FRAME_SAMPLES) {
        const rms = Math.sqrt(this.sumSquares / FRAME_SAMPLES);
        this.port.postMessage({ pcm: this.frame.buffer, rms }, [this.frame.buffer]);
        this.frame = new Int16Array(FRAME_SAMPLES);
        this.fill = 0;
        this.sumSquares = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0].length) return true;
    let samples = input[0];
    if (input.length > 1) {
      // Stereo microphone. Some iPhones deliver a "stereo" track with sound on one side
      // only, so use whichever side has signal, and average only when both do.
      const right = input[1];
      const n = samples.length;
      let leftOn = false;
      let rightOn = false;
      for (let i = 0; i < n && !(leftOn && rightOn); i++) {
        if (samples[i] !== 0) leftOn = true;
        if (right[i] !== 0) rightOn = true;
      }
      if (leftOn && rightOn) {
        if (!this.mix || this.mix.length !== n) this.mix = new Float32Array(n);
        for (let i = 0; i < n; i++) this.mix[i] = (samples[i] + right[i]) * 0.5;
        samples = this.mix;
      } else if (rightOn) {
        samples = right;
      }
    }
    this.resampler.push(samples, this.emit);
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
