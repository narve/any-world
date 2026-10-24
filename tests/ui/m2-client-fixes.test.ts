/**
 * Regression tests (pure UI helpers) for:
 *  - issues/M2-dialogue-persuade-key.md — 'p' / 't' inside a conversation
 *  - issues/M2-exit-label-under-panels.md — the exit arrow and label keep clear of HUD panels
 */
import { describe, it, expect } from 'vitest';
import { resolveKey } from '../../src/client/ui/input';
import { EDGE, edgeArrow, labelBox, placeEdgeMarker, wrapLabel, type Rect } from '../../src/client/map-overlay';

const ALL = { talk: true, sneak: true, search: true, persuade: true };
const NO_PERSUADE = { ...ALL, persuade: false };
const k = (key: string, extra: Partial<{ shiftKey: boolean; ctrlKey: boolean }> = {}) => ({ key, ...extra });

describe('conversation keys', () => {
  it("'p' persuades from the dialogue panel when persuasion is on", () => {
    expect(resolveKey(k('p'), 'dialogue', ALL)).toEqual({ type: 'persuade' });
    expect(resolveKey(k('P', { shiftKey: true }), 'dialogue', ALL)).toBeNull();
    expect(resolveKey(k('p'), 'dialogue', NO_PERSUADE)).toBeNull();
  });

  it("'t' opens trade from the dialogue panel", () => {
    expect(resolveKey(k('t'), 'dialogue', ALL)).toEqual({ type: 'trade' });
  });

  it('other modal layers do not take p / t', () => {
    for (const layer of ['choice', 'levelup', 'trade'] as const) {
      expect(resolveKey(k('p'), layer, ALL)).toBeNull();
      expect(resolveKey(k('t'), layer, ALL)).toBeNull();
    }
    expect(resolveKey(k('p', { ctrlKey: true }), 'dialogue', ALL)).toBeNull();
  });
});

describe('exit label', () => {
  it('wraps a long label onto two lines and cuts with an ellipsis', () => {
    expect(wrapLabel('Exit')).toEqual(['Exit']);
    const lines = wrapLabel('Step into the point where everything folds back into the beginning');
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.length <= 24)).toBe(true);
    expect(lines[0]).toBe('Step into the point');
    expect(lines[1].endsWith('…')).toBe(true);
    expect(wrapLabel('Supercalifragilisticexpialidocious-door')[0].length).toBeLessThanOrEqual(24);
  });

  it('places the label on the inner side of the arrow', () => {
    const right = labelBox({ x: 1000, y: 300 }, 0, { w: 100, h: 20 });
    expect(right.anchor).toBe('end');
    expect(right.rect.x + right.rect.w).toBeLessThanOrEqual(1000);
    const up = labelBox({ x: 500, y: 96 }, -90, { w: 100, h: 20 });
    expect(up.rect.y).toBeGreaterThan(96);
  });

  it('slides away from a HUD panel it would cover, still pointing at the exit', () => {
    const box = { w: 1280, h: 720 };
    const from = { x: 640, y: 360 };
    const to = { x: 1500, y: -200 }; // off screen, up and right: the arrow lands at the top-right
    const arrow = edgeArrow(from, to, box)!;
    const rules: Rect = { x: 1000, y: 0, w: 280, h: 260 }; // the RULES panel in the top-right corner
    const size = { w: 150, h: 30 };
    const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    // the naive placement is under the panel (the bug)
    expect(hits(labelBox(arrow, arrow.angle, size).rect, rules) || hits({ x: arrow.x - 16, y: arrow.y - 16, w: 32, h: 32 }, rules)).toBe(true);
    const pl = placeEdgeMarker(arrow, to, size, [rules], box);
    expect(hits(pl.label.rect, rules)).toBe(false);
    expect(hits({ x: pl.x - 16, y: pl.y - 16, w: 32, h: 32 }, rules)).toBe(false);
    // it stays on the margin box and turns toward the exit
    const onEdge = Math.abs(pl.y - EDGE.top) < 1 || Math.abs(pl.x - (box.w - EDGE.right)) < 1;
    expect(onEdge).toBe(true);
    const expected = (Math.atan2(to.y - pl.y, to.x - pl.x) * 180) / Math.PI;
    expect(pl.angle).toBeCloseTo(expected, 5);
  });

  it('keeps the original spot when nothing is in the way', () => {
    const box = { w: 1280, h: 720 };
    const arrow = edgeArrow({ x: 640, y: 360 }, { x: 3000, y: 360 }, box)!;
    const pl = placeEdgeMarker(arrow, { x: 3000, y: 360 }, { w: 80, h: 16 }, [], box);
    expect(pl.x).toBe(arrow.x);
    expect(pl.y).toBe(arrow.y);
  });
});
