/**
 * Pure UI helpers added in M2: log folding (audit "merge repeated log lines"), untyped-harm naming,
 * tooltip placement away from the player, the exit compass arrow, Enter = use, difficulty labels.
 */
import { describe, it, expect } from 'vitest';
import type { LogMessage } from '../../src/engine/types';
import { displayLogText, groupLog, DEFAULT_VOCABULARY } from '../../src/client/ui/format';
import { placeTooltip } from '../../src/client/ui/components/common';
import { edgeArrow } from '../../src/client/map-overlay';
import { resolveKey, keyHelp } from '../../src/client/ui/input';

const VERBS = { talk: true, sneak: false, search: true, persuade: false };
const m = (turn: number, text: string, kind: LogMessage['kind'] = 'bad'): LogMessage => ({ turn, text, kind });

describe('groupLog', () => {
  it('folds identical consecutive lines into one row with a counter', () => {
    const g = groupLog([m(1, 'Dolores takes 1 Heat.'), m(2, 'Dolores takes 1 Heat.'), m(3, 'Dolores takes 1 Heat.')]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ count: 3, firstTurn: 1, lastTurn: 3 });
  });

  it('ten turns of an interleaved damage-over-time status give at most two rows', () => {
    const log: LogMessage[] = [];
    for (let t = 1; t <= 10; t++) log.push(m(t, 'Dolores takes 1 Heat.'), m(t, 'Dolores takes 2 Venom.'));
    const g = groupLog(log);
    expect(g.length).toBeLessThanOrEqual(2);
    expect(g.reduce((n, x) => n + x.count, 0)).toBe(20);
  });

  it('keeps distinct lines, story lines and old repeats apart', () => {
    const g = groupLog([m(1, 'A'), m(1, 'B', 'info'), m(1, 'Hello', 'gm'), m(1, 'Hello', 'gm'), m(20, 'A')]);
    expect(g.map((x) => x.msg.text)).toEqual(['A', 'B', 'Hello', 'Hello', 'A']);
  });

  it('moves a folded row to the bottom (it is the latest news)', () => {
    const g = groupLog([m(1, 'tick'), m(1, 'You hit it.', 'combat'), m(2, 'tick')]);
    expect(g.map((x) => [x.msg.text, x.count])).toEqual([
      ['You hit it.', 1],
      ['tick', 2],
    ]);
  });
});

describe('displayLogText', () => {
  it('names untyped harm with the world word for health', () => {
    const v = { stats: { ...DEFAULT_VOCABULARY.stats, hp: { name: 'Integrity', abbr: 'INT', description: '' } } };
    expect(displayLogText('The drone snips at Ines for 5.', v)).toBe('The drone snips at Ines for 5 Integrity.');
    expect(displayLogText('Ines takes 1.', v)).toBe('Ines takes 1 Integrity.');
    expect(displayLogText('Ines takes 1 Vacuum.', v)).toBe('Ines takes 1 Vacuum.');
  });
});

describe('placeTooltip', () => {
  const box = { w: 1280, h: 800 };
  const size = { w: 200, h: 100 };
  it('defaults to below-right of the point', () => {
    expect(placeTooltip({ x: 400, y: 300 }, size, box, null)).toEqual({ px: 418, py: 318 });
  });
  it('goes to the far side of the target from the player', () => {
    // player is below-right of the target: the card goes above-left
    const p = placeTooltip({ x: 600, y: 360 }, size, box, { x: 640, y: 400 });
    expect(p.px + size.w).toBeLessThanOrEqual(600);
    expect(p.py + size.h).toBeLessThanOrEqual(360);
    // player above-left: below-right
    const q = placeTooltip({ x: 680, y: 440 }, size, box, { x: 640, y: 400 });
    expect(q.px).toBeGreaterThan(680);
    expect(q.py).toBeGreaterThan(440);
  });
  it('flips and clamps at the edges', () => {
    const p = placeTooltip({ x: 1270, y: 790 }, size, box, null);
    expect(p.px + size.w).toBeLessThanOrEqual(box.w - 8);
    expect(p.py + size.h).toBeLessThanOrEqual(box.h - 8);
  });
});

describe('edgeArrow', () => {
  const box = { w: 1000, h: 600 };
  it('is null for an on-screen exit', () => {
    expect(edgeArrow({ x: 500, y: 300 }, { x: 700, y: 400 }, box, 46)).toBeNull();
  });
  it('points along the screen edge toward an off-screen exit', () => {
    const a = edgeArrow({ x: 500, y: 300 }, { x: 2500, y: 300 }, box, 46)!;
    expect(a.x).toBeCloseTo(1000 - 46);
    expect(a.y).toBeCloseTo(300);
    expect(a.angle).toBeCloseTo(0);
    const b = edgeArrow({ x: 500, y: 300 }, { x: 500, y: -900 }, box, 46)!;
    expect(b.y).toBeCloseTo(46);
    expect(b.angle).toBeCloseTo(-90);
  });
  it('keeps clear of the HUD with the default per-side margins', () => {
    const c = edgeArrow({ x: 500, y: 300 }, { x: 500, y: 2000 }, box)!;
    expect(c.y).toBeCloseTo(600 - 120);
  });
});

describe('Enter uses things next to you', () => {
  it('maps Enter to interact in play and keeps it for skipping narration', () => {
    expect(resolveKey({ key: 'Enter' }, 'game', VERBS)).toEqual({ type: 'interact' });
    expect(resolveKey({ key: 'Enter' }, 'narration', VERBS)).toEqual({ type: 'skip' });
    expect(resolveKey({ key: 'Enter' }, 'look', VERBS)).toEqual({ type: 'confirm' });
    const rows = keyHelp(VERBS, { conflict: 'Attack' }).flatMap((s) => s.rows);
    expect(rows.some((r) => r.keys.includes('Enter') && /use/i.test(r.what))).toBe(true);
  });
});
