import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachMapInput, LONG_PRESS_MS, PressTracker, tapDecision, TAP_SLOP, type MapInputHandlers } from '../../src/client/ui/touch-input';
import { coverInsets, inViewport, isCompact, layoutFor, overlaps, sameInsets } from '../../src/client/ui/layout';
import { findUnlock, installAudioUnlock } from '../../src/client/ui/audio-unlock';

describe('PressTracker (tap / long press / drag)', () => {
  it('a short still press is a tap', () => {
    const p = new PressTracker();
    p.down(1, 100, 100, 0);
    p.move(1, 104, 103);
    expect(p.up(1, 120)).toBe('tap');
  });

  it('moving beyond the slop is a drag, not a tap', () => {
    const p = new PressTracker();
    p.down(1, 100, 100, 0);
    p.move(1, 100 + TAP_SLOP + 2, 100);
    expect(p.due(LONG_PRESS_MS + 10)).toBe(false);
    expect(p.up(1, 80)).toBeNull();
  });

  it('a held press becomes due once and eats its release', () => {
    const p = new PressTracker();
    p.down(1, 10, 10, 1000);
    expect(p.due(1000 + LONG_PRESS_MS - 1)).toBe(false);
    expect(p.due(1000 + LONG_PRESS_MS)).toBe(true);
    p.fireLong();
    expect(p.due(1000 + LONG_PRESS_MS + 50)).toBe(false);
    expect(p.up(1, 1000 + LONG_PRESS_MS + 80)).toBeNull();
  });

  it('a long press whose timer never ran is reported on release', () => {
    const p = new PressTracker();
    p.down(1, 10, 10, 0);
    expect(p.up(1, LONG_PRESS_MS + 5)).toBe('long');
  });

  it('a second finger cancels the press (it is a pinch / twist)', () => {
    const p = new PressTracker();
    p.down(1, 10, 10, 0);
    p.down(2, 60, 10, 10);
    expect(p.up(2, 40)).toBeNull();
    expect(p.up(1, 50)).toBeNull();
    // all fingers lifted: the next press works again
    p.down(3, 10, 10, 100);
    expect(p.up(3, 150)).toBe('tap');
  });

  it('pointercancel forgets the finger', () => {
    const p = new PressTracker();
    p.down(1, 10, 10, 0);
    p.release(1);
    expect(p.pressing).toBe(false);
    p.down(2, 10, 10, 10);
    expect(p.up(2, 30)).toBe('tap');
  });
});

describe('tapDecision', () => {
  const me = { x: 5, y: 5 };
  it('an adjacent friendly NPC is talked to', () => {
    expect(tapDecision({ x: 6, y: 5 }, { player: me, actor: { id: 'n', hostile: false, canTalk: true, canAttack: true } })).toEqual({ kind: 'talk', targetId: 'n' });
  });
  it('an adjacent hostile is attacked, also diagonally', () => {
    expect(tapDecision({ x: 6, y: 6 }, { player: me, actor: { id: 'h', hostile: true, canTalk: false, canAttack: true } })).toEqual({ kind: 'attack', targetId: 'h' });
  });
  it('a hostile that can talk (persuadable) is still attacked on tap', () => {
    expect(tapDecision({ x: 4, y: 5 }, { player: me, actor: { id: 'h', hostile: true, canTalk: true, canAttack: true } })).toEqual({ kind: 'attack', targetId: 'h' });
  });
  it('a far actor, an empty tile, or an actor that allows nothing: walk there', () => {
    expect(tapDecision({ x: 9, y: 5 }, { player: me, actor: { id: 'h', hostile: true, canTalk: false, canAttack: true } })).toEqual({ kind: 'travel' });
    expect(tapDecision({ x: 6, y: 5 }, { player: me, actor: null })).toEqual({ kind: 'travel' });
    expect(tapDecision({ x: 6, y: 5 }, { player: me, actor: { id: 'x', hostile: false, canTalk: false, canAttack: false } })).toEqual({ kind: 'travel' });
  });
});

describe('layoutFor', () => {
  it('names phone portrait / landscape, tablet and desktop', () => {
    expect(layoutFor(390, 664)).toBe('phone-portrait');
    expect(layoutFor(412, 839)).toBe('phone-portrait');
    expect(layoutFor(750, 342)).toBe('phone-landscape');
    expect(layoutFor(863, 360)).toBe('phone-landscape');
    expect(layoutFor(768, 1024)).toBe('tablet');
    expect(layoutFor(1024, 768)).toBe('tablet');
    expect(layoutFor(1280, 800)).toBe('desktop');
    expect(layoutFor(1600, 450)).toBe('phone-landscape');
    expect(isCompact('phone-landscape')).toBe(true);
    expect(isCompact('tablet')).toBe(false);
  });
});

describe('coverInsets', () => {
  const r = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

  it('phone portrait: the HUD rows and the thumb rows become top / bottom insets', () => {
    const ins = coverInsets([r(6, 6, 250, 80), r(320, 6, 384, 50), r(100, 84, 290, 104), r(6, 108, 384, 152), r(6, 500, 250, 544), r(254, 500, 384, 544), r(6, 550, 384, 594), r(6, 600, 384, 658)], 390, 664);
    expect(ins).toEqual({ top: 152, bottom: 164, left: 0, right: 0 });
  });

  it('phone landscape: side columns become left / right insets', () => {
    const ins = coverInsets([r(6, 6, 210, 80), r(6, 84, 210, 128), r(6, 230, 210, 336), r(240, 6, 500, 30), r(690, 6, 744, 50), r(553, 56, 744, 200), r(553, 206, 744, 250), r(553, 256, 744, 336)], 750, 342, { bandShare: 0.4 });
    expect(ins.left).toBe(210);
    expect(ins.right).toBe(197);
    // the status strip spans most of the map column between them
    expect(ins.top).toBe(30);
    expect(ins.bottom).toBe(0);
  });

  it('a lone corner panel is not a band', () => {
    const ins = coverInsets([r(12, 12, 310, 300), r(12, 640, 310, 788)], 1280, 800);
    expect(ins).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it('adds safe-area insets and always leaves part of the map free', () => {
    expect(coverInsets([], 390, 844, { safe: { top: 47, bottom: 34 } })).toEqual({ top: 47, bottom: 34, left: 0, right: 0 });
    const ins = coverInsets([r(0, 0, 400, 380), r(0, 420, 400, 800)], 400, 800, { minFree: 0.3 });
    expect(800 - ins.top - ins.bottom).toBeGreaterThanOrEqual(239);
  });

  it('ignores empty and off-screen rectangles', () => {
    expect(coverInsets([r(0, 0, 0, 0), r(-500, -500, -10, -10), r(10, 900, 380, 950)], 390, 664)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it('sameInsets / overlaps / inViewport', () => {
    expect(sameInsets({ top: 10, bottom: 10, left: 0, right: 0 }, { top: 11, bottom: 9, left: 0, right: 0 })).toBe(true);
    expect(sameInsets(null, { top: 0, bottom: 0, left: 0, right: 0 })).toBe(false);
    expect(sameInsets({ top: 10, bottom: 10, left: 0, right: 0 }, { top: 20, bottom: 10, left: 0, right: 0 })).toBe(false);
    expect(overlaps(r(0, 0, 50, 50), r(49, 0, 100, 50))).toBe(false);
    expect(overlaps(r(0, 0, 50, 50), r(40, 40, 100, 100))).toBe(true);
    expect(inViewport(r(0, 0, 390, 664), 390, 664)).toBe(true);
    expect(inViewport(r(0, 600, 390, 700), 390, 664)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the DOM binding, with a plain EventTarget standing in for the map element
// ---------------------------------------------------------------------------

function ptr(type: string, init: { pointerType?: string; pointerId?: number; x?: number; y?: number; button?: number }): Event {
  const e = new Event(type, { cancelable: true });
  return Object.assign(e, { pointerType: init.pointerType ?? 'touch', pointerId: init.pointerId ?? 1, clientX: init.x ?? 0, clientY: init.y ?? 0, button: init.button ?? 0 });
}

describe('attachMapInput', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (extra: Partial<MapInputHandlers> = {}) => {
    const el = new EventTarget() as unknown as HTMLElement;
    const calls: string[] = [];
    const h: MapInputHandlers = {
      pick: (x, y) => ({ x: Math.floor(x / 10), y: Math.floor(y / 10) }),
      hover: (p) => calls.push(`hover ${p ? `${p.x},${p.y}` : 'null'}`),
      click: (p, b) => calls.push(`click ${p.x},${p.y} ${b}`),
      tap: (p) => calls.push(`tap ${p.x},${p.y}`),
      longPress: (p) => calls.push(`long ${p.x},${p.y}`),
      touchStart: () => calls.push('touchstart'),
      camera: { zoomBy: (f) => calls.push(`zoom ${f > 1 ? 'in' : 'out'}`), rotateStep: (d) => calls.push(`rotate ${d}`) },
      gesture: (on) => calls.push(`gesture ${on}`),
      ...extra,
    };
    const binding = attachMapInput(el, h);
    const fire = (e: Event) => {
      el.dispatchEvent(e);
      return e;
    };
    return { el, calls, binding, fire };
  };

  it('a touch tap taps the tile and cancels the emulated mouse events', () => {
    const { calls, fire } = setup();
    const down = fire(ptr('pointerdown', { x: 55, y: 23 }));
    expect(down.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(100);
    fire(ptr('pointerup', { x: 56, y: 24 }));
    expect(calls).toEqual(['touchstart', 'tap 5,2']);
  });

  it('a held touch is a long press (inspect), and the release does not tap', () => {
    const { calls, fire } = setup();
    fire(ptr('pointerdown', { x: 31, y: 41 }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 20);
    expect(calls).toContain('long 3,4');
    fire(ptr('pointerup', { x: 31, y: 41 }));
    expect(calls.filter((c) => c.startsWith('tap'))).toEqual([]);
  });

  it('a drag is neither a tap nor a long press', () => {
    const { calls, fire } = setup();
    fire(ptr('pointerdown', { x: 10, y: 10 }));
    fire(ptr('pointermove', { x: 60, y: 10 }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 20);
    fire(ptr('pointerup', { x: 60, y: 10 }));
    expect(calls).toEqual(['touchstart']);
  });

  it('two fingers pinch-zoom and twist-rotate, without tapping', () => {
    const { calls, fire } = setup();
    fire(ptr('pointerdown', { pointerId: 1, x: 100, y: 100 }));
    fire(ptr('pointerdown', { pointerId: 2, x: 200, y: 100 }));
    expect(calls).toContain('gesture true');
    fire(ptr('pointermove', { pointerId: 2, x: 300, y: 100 }));
    expect(calls).toContain('zoom in');
    // twist the second finger a quarter turn around the first
    fire(ptr('pointermove', { pointerId: 2, x: 100, y: 300 }));
    expect(calls.some((c) => c.startsWith('rotate'))).toBe(true);
    fire(ptr('pointerup', { pointerId: 2, x: 100, y: 300 }));
    fire(ptr('pointerup', { pointerId: 1, x: 100, y: 100 }));
    expect(calls).toContain('gesture false');
    expect(calls.filter((c) => c.startsWith('tap') || c.startsWith('long'))).toEqual([]);
  });

  it('mouse: hover only on tile change, click when the mouse did not drag, right click = secondary', () => {
    const { calls, fire } = setup();
    fire(ptr('pointermove', { pointerType: 'mouse', x: 11, y: 11 }));
    fire(ptr('pointermove', { pointerType: 'mouse', x: 12, y: 12 }));
    fire(ptr('pointermove', { pointerType: 'mouse', x: 25, y: 12 }));
    fire(ptr('pointerdown', { pointerType: 'mouse', x: 25, y: 12 }));
    fire(ptr('pointerup', { pointerType: 'mouse', x: 26, y: 12 }));
    fire(ptr('pointerdown', { pointerType: 'mouse', x: 25, y: 12, button: 2 }));
    fire(ptr('pointerup', { pointerType: 'mouse', x: 25, y: 12, button: 2 }));
    fire(ptr('pointerdown', { pointerType: 'mouse', x: 25, y: 12 }));
    fire(ptr('pointerup', { pointerType: 'mouse', x: 95, y: 12 }));
    fire(ptr('pointerleave', { pointerType: 'mouse' }));
    expect(calls).toEqual(['hover 1,1', 'hover 2,1', 'click 2,1 primary', 'click 2,1 secondary', 'hover null']);
  });

  it('nothing is emitted while a panel blocks the map; detach removes the listeners', () => {
    let blocked = true;
    const { calls, fire, binding } = setup({ blocked: () => blocked });
    fire(ptr('pointerdown', { x: 10, y: 10 }));
    fire(ptr('pointerup', { x: 10, y: 10 }));
    expect(calls).toEqual(['touchstart']);
    blocked = false;
    binding.detach();
    fire(ptr('pointerdown', { x: 10, y: 10 }));
    fire(ptr('pointerup', { x: 10, y: 10 }));
    expect(calls).toEqual(['touchstart']);
  });
});

describe('audio unlock on the first gesture', () => {
  it('finds unlock in the supported module shapes', () => {
    const f = () => 1;
    expect(findUnlock({ unlock: f })).toBeTypeOf('function');
    expect(findUnlock({ audio: { unlock: f } })).toBeTypeOf('function');
    expect(findUnlock({ default: { unlock: f } })).toBeTypeOf('function');
    expect(findUnlock({ unlockAudio: f })).toBeTypeOf('function');
    expect(findUnlock({ play: f })).toBeNull();
    expect(findUnlock(null)).toBeNull();
  });

  it('keeps `this` for object methods', () => {
    const audio = {
      ctx: 'ok',
      unlock(this: { ctx: string }) {
        return this.ctx;
      },
    };
    expect(findUnlock({ audio })!()).toBe('ok');
  });

  it('calls unlock synchronously inside the first gesture after the module loaded, once', async () => {
    const target = new EventTarget() as unknown as Window;
    let n = 0;
    const h = installAudioUnlock({ load: () => Promise.resolve({ unlock: () => void n++ }), target });
    await Promise.resolve();
    await Promise.resolve();
    expect(n).toBe(0);
    target.dispatchEvent(new Event('pointerdown'));
    expect(n).toBe(1);
    expect(h.unlocked).toBe(true);
    target.dispatchEvent(new Event('keydown'));
    target.dispatchEvent(new Event('touchend'));
    expect(n).toBe(1);
  });

  it('a gesture before the module loaded is followed by unlock on the next gesture', async () => {
    const target = new EventTarget() as unknown as Window;
    let n = 0;
    let resolve!: (m: unknown) => void;
    installAudioUnlock({ load: () => new Promise((r) => (resolve = r)), target });
    target.dispatchEvent(new Event('pointerdown'));
    expect(n).toBe(0);
    resolve({ audio: { unlock: () => void n++ } });
    await Promise.resolve();
    await Promise.resolve();
    target.dispatchEvent(new Event('click'));
    expect(n).toBe(1);
  });

  it('no audio module, or one without unlock: listeners go away quietly', async () => {
    const target = new EventTarget() as unknown as Window;
    const h = installAudioUnlock({ load: () => null, target });
    target.dispatchEvent(new Event('pointerdown'));
    expect(h.unlocked).toBe(false);
    const h2 = installAudioUnlock({ load: () => Promise.resolve({}), target });
    await Promise.resolve();
    await Promise.resolve();
    target.dispatchEvent(new Event('pointerdown'));
    expect(h2.unlocked).toBe(false);
  });

  it('a failing unlock is reported, not thrown', async () => {
    const target = new EventTarget() as unknown as Window;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installAudioUnlock({
      load: () =>
        Promise.resolve({
          unlock: () => {
            throw new Error('no context');
          },
        }),
      target,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(() => target.dispatchEvent(new Event('pointerdown'))).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
