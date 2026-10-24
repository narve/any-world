/**
 * Render quality tiers (DESIGN §6b): 'high' for desktops / strong GPUs, 'low' for phones and slow
 * frames, 'auto' picks between them and adapts to the measured frame time.
 *
 * Everything here is pure (no DOM or WebGL access) so it can be unit tested; the Renderer applies
 * the resolved settings.
 */

export type QualitySetting = 'auto' | 'low' | 'high';
export type QualityTier = 'low' | 'high';

export interface QualityProfile {
  tier: QualityTier;
  /** cap on devicePixelRatio */
  maxPixelRatio: number;
  /** sun shadows on/off */
  shadows: boolean;
  /** shadow map resolution when shadows are on */
  shadowMapSize: number;
  /** how many lamp point lights may be live at once (≤ LAMP_LIGHTS) */
  lampLights: number;
  /** how many model point lights may be live at once (≤ MODEL_LIGHTS) */
  modelLights: number;
  /** noise octaves for the backdrop shader (detail of clouds / nebulae / aurora) */
  backdropOctaves: number;
  /** segments of the backdrop dome (width; height is half) */
  backdropSegments: number;
}

export const QUALITY_PROFILES: Readonly<Record<QualityTier, QualityProfile>> = {
  high: { tier: 'high', maxPixelRatio: 2, shadows: true, shadowMapSize: 2048, lampLights: 10, modelLights: 3, backdropOctaves: 5, backdropSegments: 48 },
  low: { tier: 'low', maxPixelRatio: 1.5, shadows: false, shadowMapSize: 1024, lampLights: 4, modelLights: 1, backdropOctaves: 3, backdropSegments: 24 },
};

export interface DeviceHints {
  /** navigator.maxTouchPoints */
  maxTouchPoints?: number;
  /** matchMedia('(pointer: coarse)').matches */
  coarsePointer?: boolean;
  /** navigator.userAgent */
  userAgent?: string;
  /** screen size in CSS px (shorter side decides "phone") */
  screenWidth?: number;
  screenHeight?: number;
}

/** True for phones and tablets: a coarse primary pointer, or a touch screen plus a mobile UA / small screen. */
export function isMobileDevice(h: DeviceHints): boolean {
  const ua = h.userAgent ?? '';
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i.test(ua);
  const touch = (h.maxTouchPoints ?? 0) > 0;
  const short = Math.min(h.screenWidth ?? Infinity, h.screenHeight ?? Infinity);
  if (h.coarsePointer && touch) return true;
  if (mobileUa && (touch || h.coarsePointer)) return true;
  // iPadOS reports a desktop UA but has touch points
  if (touch && /Macintosh/.test(ua)) return true;
  return touch && short <= 820;
}

/** Device hints of the current browser (empty outside one). */
export function browserDeviceHints(): DeviceHints {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  let coarse = false;
  try {
    coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    coarse = false;
  }
  const scr = typeof screen !== 'undefined' ? screen : undefined;
  return {
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    coarsePointer: coarse,
    userAgent: nav?.userAgent ?? '',
    screenWidth: scr?.width,
    screenHeight: scr?.height,
  };
}

/** Tier for a setting before any frame has been measured. */
export function initialTier(setting: QualitySetting, mobile: boolean): QualityTier {
  if (setting === 'auto') return mobile ? 'low' : 'high';
  return setting;
}

export interface AdaptiveOptions {
  /** frames slower than this (ms, smoothed) count as bad: 1000/40 */
  slowMs: number;
  /** frames at or faster than this count as good (a solid 60 Hz, allowing jitter) */
  fastMs: number;
  /** consecutive bad time (ms) before dropping to low */
  downAfterMs: number;
  /** consecutive good time (ms) before trying high again */
  upAfterMs: number;
  /** after this many drops the controller stays on low for the session */
  maxDowngrades: number;
  /** intervals longer than this are pauses (tab hidden, debugger, GC hitch), not frame times */
  gapMs: number;
  /** smoothing factor of the exponential moving average (0..1, weight of the new sample) */
  smoothing: number;
}

export const DEFAULT_ADAPTIVE: AdaptiveOptions = {
  slowMs: 25,
  fastMs: 18,
  downAfterMs: 2500,
  upAfterMs: 12000,
  maxDowngrades: 2,
  gapMs: 250,
  smoothing: 0.08,
};

/**
 * Picks the tier for the 'auto' setting from frame intervals, with hysteresis: it drops to low after
 * `downAfterMs` of smoothed frame times above `slowMs`, and only tries high again after `upAfterMs`
 * of solid frames (never on mobile, where low is the starting point and saves battery). After
 * `maxDowngrades` drops it stays on low, so a device on the edge does not flip back and forth.
 */
export class AdaptiveQuality {
  readonly opts: AdaptiveOptions;
  tier: QualityTier;
  /** smoothed frame interval (ms) */
  avgMs = 16.7;
  private bad = 0;
  private good = 0;
  private downgrades = 0;
  private samples = 0;
  private readonly allowUpgrade: boolean;

  constructor(start: QualityTier, opts: Partial<AdaptiveOptions> & { allowUpgrade?: boolean } = {}) {
    this.opts = { ...DEFAULT_ADAPTIVE, ...opts };
    this.tier = start;
    this.allowUpgrade = opts.allowUpgrade ?? start === 'high';
  }

  get locked(): boolean {
    return this.downgrades >= this.opts.maxDowngrades;
  }

  get fps(): number {
    return 1000 / Math.max(1, this.avgMs);
  }

  /**
   * Feed one frame interval in ms. Returns the new tier when it changed, otherwise null. The
   * smoothed average resets after a change, since the new tier runs at a different speed.
   */
  sample(ms: number): QualityTier | null {
    if (!(ms > 0) || ms > this.opts.gapMs) return null;
    this.samples++;
    const a = this.samples < 10 ? 0.3 : this.opts.smoothing;
    this.avgMs += (ms - this.avgMs) * a;
    // the first frames after start / a switch compile shaders and upload textures: ignore them
    if (this.samples < 20) return null;
    if (this.avgMs > this.opts.slowMs) {
      this.bad += ms;
      this.good = 0;
    } else if (this.avgMs <= this.opts.fastMs) {
      this.good += ms;
      this.bad = 0;
    } else {
      // in between: hold, slowly forget
      this.bad = Math.max(0, this.bad - ms);
      this.good = Math.max(0, this.good - ms);
    }
    if (this.tier === 'high' && this.bad >= this.opts.downAfterMs) {
      this.downgrades++;
      return this.switchTo('low');
    }
    if (this.tier === 'low' && this.allowUpgrade && !this.locked && this.good >= this.opts.upAfterMs) return this.switchTo('high');
    return null;
  }

  private switchTo(t: QualityTier): QualityTier {
    this.tier = t;
    this.bad = 0;
    this.good = 0;
    this.samples = 0;
    this.avgMs = 16.7;
    return t;
  }
}

/** Running frames-per-second meter (smoothed over about half a second). */
export class FpsMeter {
  fps = 0;
  private acc = 0;
  private frames = 0;

  sample(ms: number): void {
    if (!(ms > 0) || ms > 1000) return;
    this.acc += ms;
    this.frames++;
    if (this.acc >= 500) {
      const now = (this.frames * 1000) / this.acc;
      this.fps = this.fps === 0 ? now : this.fps * 0.5 + now * 0.5;
      this.acc = 0;
      this.frames = 0;
    }
  }
}
