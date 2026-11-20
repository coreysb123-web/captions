// Microphone capture: getUserMedia -> AudioWorklet -> 16 kHz PCM frames.

const WORKLET_URL = new URL('./pcm-worklet.js', import.meta.url).href;

export function micSupported() {
  return !!(
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia &&
    (window.AudioContext || window.webkitAudioContext) &&
    window.AudioWorkletNode
  );
}

function constraints(tuning, deviceId) {
  const room = tuning !== 'close';
  const audio = {
    channelCount: { ideal: 1 },
    // "Room" switches off the phone's call-style voice processing. That processing is
    // tuned for a mouth a few centimetres away and treats voices across a table as
    // background noise to remove, which is the opposite of what we want here.
    echoCancellation: !room,
    noiseSuppression: !room,
    autoGainControl: !room,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

function problem(error) {
  const name = (error && error.name) || '';
  let code = 'mic-failed';
  if (name === 'NotAllowedError' || name === 'SecurityError') code = 'mic-blocked';
  else if (name === 'NotFoundError' || name === 'OverconstrainedError') code = 'mic-missing';
  else if (name === 'NotReadableError' || name === 'AbortError') code = 'mic-busy';
  const out = new Error(code);
  out.code = code;
  out.cause = error;
  return out;
}

export class MicSource {
  constructor({ tuning = 'room', deviceId = '' } = {}) {
    this.tuning = tuning;
    this.deviceId = deviceId;
    this.onFrame = null; // (ArrayBuffer of 1600 Int16 samples, loudness 0..1)
    this.onProblem = null; // ('ended' | 'suspended' | 'muted' | 'unmuted')
    this.stopped = false;
  }

  /** Must be called straight from a tap, so the phone allows audio to start. */
  async start() {
    if (!micSupported()) {
      const e = new Error('mic-unsupported');
      e.code = 'mic-unsupported';
      throw e;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AudioCtx({ latencyHint: 'interactive' }));
    // Ask to run while we are still inside the tap; the result is checked again below.
    const kick = ctx.resume();
    if (kick && kick.catch) kick.catch(() => {});

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(this.tuning, this.deviceId));
    } catch (first) {
      if (!this.deviceId || (first.name !== 'OverconstrainedError' && first.name !== 'NotFoundError')) {
        this._cleanup();
        throw problem(first);
      }
      // The chosen microphone is gone (e.g. headset disconnected): use the default one.
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints(this.tuning, ''));
      } catch (second) {
        this._cleanup();
        throw problem(second);
      }
    }
    this.stream = stream;
    if (this.stopped) {
      this._cleanup();
      return;
    }

    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const source = (this.sourceNode = ctx.createMediaStreamSource(stream));
      const capture = (this.capture = new AudioWorkletNode(ctx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      }));
      capture.port.onmessage = (e) => {
        if (!this.stopped && this.onFrame) this.onFrame(e.data.pcm, e.data.rms);
      };
      // The graph only runs if it ends at the speakers, so finish with a silent output.
      const silent = (this.silent = ctx.createGain());
      silent.gain.value = 0;
      source.connect(capture);
      capture.connect(silent);
      silent.connect(ctx.destination);
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    } catch (e) {
      this._cleanup();
      throw problem(e);
    }
    if (this.stopped) {
      this._cleanup();
      return;
    }

    const track = (this.track = stream.getAudioTracks()[0]);
    const tell = (what) => {
      if (!this.stopped && this.onProblem) this.onProblem(what);
    };
    if (track) {
      track.addEventListener('ended', () => tell('ended'));
      track.addEventListener('mute', () => tell('muted'));
      track.addEventListener('unmute', () => tell('unmuted'));
    }
    ctx.addEventListener('statechange', () => {
      if (ctx.state !== 'running' && ctx.state !== 'closed') tell('suspended');
    });
  }

  /** Try to get audio flowing again after the phone interrupted it. */
  nudge() {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
  }

  get ended() {
    return !this.track || this.track.readyState === 'ended';
  }

  async stop() {
    this.stopped = true;
    this._cleanup();
  }

  _cleanup() {
    try {
      if (this.capture) {
        this.capture.port.onmessage = null;
        this.capture.disconnect();
      }
      if (this.sourceNode) this.sourceNode.disconnect();
      if (this.silent) this.silent.disconnect();
    } catch (e) {}
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.capture = this.sourceNode = this.silent = this.stream = null;
  }
}

/** Microphones the phone offers. Names are only available once access has been allowed. */
export async function listMicrophones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')
      .map((d, i) => ({ id: d.deviceId, label: d.label || 'Microphone ' + (i + 1) }));
  } catch (e) {
    return [];
  }
}
