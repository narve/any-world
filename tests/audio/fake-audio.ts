/**
 * A fake WebAudio AudioContext for unit tests: records every node, connection, param automation
 * and source start/stop, with a manually advanced clock. Sources end (onended) when the clock
 * passes their stop time and `advance()` is called.
 */

export class FakeParam {
  value: number;
  events: { kind: string; value: number; time: number }[] = [];
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v: number, t: number) {
    this.events.push({ kind: 'set', value: v, time: t });
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push({ kind: 'linear', value: v, time: t });
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    if (!(v > 0)) throw new RangeError('exponential ramp to non-positive value');
    this.events.push({ kind: 'exp', value: v, time: t });
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number, t: number, tc: number) {
    if (!(tc > 0)) throw new RangeError('time constant must be positive');
    this.events.push({ kind: 'target', value: v, time: t });
    this.value = v;
    return this;
  }
  cancelScheduledValues(t: number) {
    this.events.push({ kind: 'cancel', value: this.value, time: t });
    return this;
  }
}

export class FakeNode {
  outputs: (FakeNode | FakeParam)[] = [];
  disconnected = false;
  constructor(
    public ctx: FakeAudioContext,
    public kind: string,
  ) {
    ctx.nodes.push(this);
  }
  connect(dest: FakeNode | FakeParam) {
    if (!dest) throw new TypeError('connect to nothing');
    this.outputs.push(dest);
    this.disconnected = false;
    return dest;
  }
  disconnect() {
    this.outputs = [];
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam(1);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'gain');
  }
}

export class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
  gain = new FakeParam(0);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'filter');
  }
}

export class FakeDelay extends FakeNode {
  delayTime = new FakeParam(0);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'delay');
  }
}

export class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24);
  knee = new FakeParam(30);
  ratio = new FakeParam(12);
  attack = new FakeParam(0.003);
  release = new FakeParam(0.25);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'compressor');
  }
}

export class FakeSource extends FakeNode {
  startTime: number | null = null;
  stopTime: number | null = null;
  ended = false;
  onended: (() => void) | null = null;
  start(t = 0) {
    if (this.startTime !== null) throw new Error('InvalidStateError: start called twice');
    this.startTime = t;
    this.ctx.started.push(this);
  }
  stop(t = 0) {
    if (this.startTime === null) throw new Error('InvalidStateError: stop before start');
    this.stopTime = this.stopTime === null ? t : Math.min(this.stopTime, t);
  }
}

export class FakeOscillator extends FakeSource {
  type = 'sine';
  frequency = new FakeParam(440);
  detune = new FakeParam(0);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'osc');
  }
}

export class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  playbackRate = new FakeParam(1);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'buffer');
  }
  override start(t = 0, offset = 0, duration?: number) {
    super.start(t);
    if (duration !== undefined) this.stopTime = t + duration;
    void offset;
  }
}

export class FakeBuffer {
  private data: Float32Array[];
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(i: number) {
    return this.data[i];
  }
}

export class FakeAudioContext {
  currentTime = 0;
  sampleRate = 8000;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  nodes: FakeNode[] = [];
  started: FakeSource[] = [];
  destination: FakeNode;
  resumeCalls = 0;
  suspendCalls = 0;
  /** make resume() fail (autoplay blocked) */
  blockResume = false;

  constructor() {
    this.destination = new FakeNode(this, 'destination');
  }
  createGain() {
    return new FakeGain(this);
  }
  createBiquadFilter() {
    return new FakeFilter(this);
  }
  createDelay() {
    return new FakeDelay(this);
  }
  createDynamicsCompressor() {
    return new FakeCompressor(this);
  }
  createOscillator() {
    return new FakeOscillator(this);
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  createBuffer(ch: number, len: number, rate: number) {
    return new FakeBuffer(ch, len, rate);
  }
  async resume() {
    this.resumeCalls++;
    if (this.state === 'closed') throw new Error('closed');
    if (this.blockResume) throw new Error('NotAllowedError');
    this.state = 'running';
  }
  async suspend() {
    this.suspendCalls++;
    if (this.state !== 'closed') this.state = 'suspended';
  }
  async close() {
    this.state = 'closed';
  }

  /** move the clock and fire onended for sources whose stop time passed */
  advance(seconds: number) {
    this.currentTime += seconds;
    for (const s of this.started) {
      if (!s.ended && s.stopTime !== null && s.stopTime <= this.currentTime) {
        s.ended = true;
        s.onended?.();
      }
    }
  }

  /** sources started at or after `from` (default: all), excluding continuous ones never stopped */
  notes(from = 0) {
    return this.started.filter((s) => (s.startTime ?? 0) >= from);
  }

  /** sources still sounding */
  live() {
    return this.started.filter((s) => !s.ended && (s.stopTime === null || s.stopTime > this.currentTime));
  }
}

/** a controllable interval timer */
export class FakeTimers {
  fns = new Map<number, () => void>();
  private id = 0;
  setInterval = (fn: () => void) => {
    this.id++;
    this.fns.set(this.id, fn);
    return this.id;
  };
  clearInterval = (h: unknown) => {
    this.fns.delete(h as number);
  };
  get active() {
    return this.fns.size;
  }
  fire() {
    for (const fn of [...this.fns.values()]) fn();
  }
}

/** a document stand-in with a settable `hidden` and visibilitychange listeners */
export class FakeVisibility {
  hidden = false;
  private ls = new Set<() => void>();
  addEventListener = (_t: string, fn: () => void) => {
    this.ls.add(fn);
  };
  removeEventListener = (_t: string, fn: () => void) => {
    this.ls.delete(fn);
  };
  get listeners() {
    return this.ls.size;
  }
  set(hidden: boolean) {
    this.hidden = hidden;
    for (const fn of [...this.ls]) fn();
  }
}

/** let pending promise callbacks run */
export async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
