import { describe, it, expect } from 'vitest';
import { cutawayTiles } from './cutaway';
import { towardCamera, yawForStep, worldToTile, facingAngle, normStep } from './coords';
import { Animator, ease } from './tween';
import { HpBar } from './actors';
import type * as THREE from 'three';

describe('coords', () => {
  it('towardCamera agrees with yawForStep', () => {
    for (let s = -4; s <= 8; s++) {
      const { dx, dy } = towardCamera(s);
      const yaw = yawForStep(s);
      expect(Math.sin(yaw)).toBeCloseTo(dx);
      expect(Math.cos(yaw)).toBeCloseTo(dy);
      expect(normStep(s)).toBeGreaterThanOrEqual(0);
    }
  });
  it('maps world to tiles and facing', () => {
    expect(worldToTile(2.4, 6.6)).toEqual({ x: 2, y: 7 });
    expect(facingAngle({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(0);
    expect(facingAngle({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(Math.PI / 2);
    expect(facingAngle({ x: 1, y: 1 }, { x: 1, y: 1 })).toBeNull();
  });
});

describe('cutawayTiles', () => {
  const W = 20;
  const H = 20;
  const allTall = { width: W, height: H, isTall: () => true };
  const xy = (i: number) => ({ x: i % W, y: Math.floor(i / W) });

  it('camera in the south lowers tiles south of the player only', () => {
    const set = cutawayTiles(allTall, { x: 10, y: 10 }, 0, { around: false });
    expect(set.size).toBeGreaterThan(0);
    // the player's own tile (a door frame / exit model / tall walkable terrain) plus tiles south
    for (const i of set) expect(xy(i).y > 10 || i === 10 * W + 10).toBe(true);
    expect(set.has(11 * W + 10)).toBe(true); // directly south
    expect(set.has(9 * W + 10)).toBe(false); // north stays
  });

  it('rotating the camera rotates the wedge', () => {
    const p = { x: 10, y: 10 };
    for (let step = 0; step < 4; step++) {
      const { dx, dy } = towardCamera(step);
      const set = cutawayTiles(allTall, p, step);
      expect(set.has((p.y + dy) * W + (p.x + dx))).toBe(true);
      expect(set.has((p.y - dy) * W + (p.x - dx))).toBe(false);
      for (const i of set) {
        const t = xy(i);
        // never anything behind the player's row (the neighbour wedges reach the row beside the player)
        expect((t.x - p.x) * dx + (t.y - p.y) * dy).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('respects isTall and map bounds', () => {
    const none = cutawayTiles({ width: W, height: H, isTall: () => false }, { x: 10, y: 10 }, 0);
    expect(none.size).toBe(0);
    // at the south edge nothing lies towards the camera: only the player's row can be touched
    const edge = cutawayTiles(allTall, { x: 0, y: 19 }, 0);
    for (const i of edge) expect(i >= 0 && i < W * H && xy(i).y === 19 && xy(i).x <= 1).toBe(true);
    expect(cutawayTiles(allTall, { x: 0, y: 19 }, 0, { around: false }).size).toBe(1);
  });

  // M1 issue: cut-away did not clear what blocks the player in doorways or adjacent enemies
  it('clears walls between the camera and the 8 neighbours, not just the player', () => {
    const p = { x: 10, y: 10 };
    const set = cutawayTiles(allTall, p, 0, { depth: 2, halfWidth: 0.5, spread: 0 });
    // an enemy west of the player: the wall south of it (camera south) must be lowered
    expect(set.has(11 * W + 9)).toBe(true);
    // an enemy north-west (behind) of the player: the wall between it and the camera, beside the player
    expect(set.has(10 * W + 9)).toBe(true);
    // walls the player leans against from behind stay up
    expect(set.has(9 * W + 10)).toBe(false);
    expect(set.has(9 * W + 9)).toBe(false);
    const old = cutawayTiles(allTall, p, 0, { depth: 2, halfWidth: 0.5, spread: 0, around: false });
    expect(old.has(11 * W + 9)).toBe(false);
  });

  it('lowers the player tile and extra focus tiles when they are tall (door frames, exit models)', () => {
    const tallAt = (tiles: number[]) => ({ width: W, height: H, isTall: (i: number) => tiles.includes(i) });
    const door = 10 * W + 10;
    expect(cutawayTiles(tallAt([door]), { x: 10, y: 10 }, 0).has(door)).toBe(true);
    // an adjacent enemy standing in a doorway beside the player
    const side = 10 * W + 11;
    expect(cutawayTiles(tallAt([side]), { x: 10, y: 10 }, 0, { around: false }).has(side)).toBe(false);
    expect(cutawayTiles(tallAt([side]), { x: 10, y: 10 }, 0, { around: false, focus: [{ x: 11, y: 10 }] }).has(side)).toBe(true);
    // the camera rotated east: the tile east of the player is in front, west is behind
    const west = 10 * W + 9;
    expect(cutawayTiles(tallAt([west]), { x: 10, y: 10 }, 3).has(west)).toBe(false);
  });

  it('widens with depth', () => {
    const set = cutawayTiles(allTall, { x: 10, y: 10 }, 0, { depth: 4, halfWidth: 1, spread: 1 });
    const width = (row: number) => [...set].filter((i) => xy(i).y === row).length;
    expect(width(14)).toBeGreaterThan(width(11));
  });
});

describe('Animator', () => {
  it('runs tweens over time with delays and resolves when blocking ones finish', async () => {
    const a = new Animator();
    const seen: number[] = [];
    let cosmetic = 0;
    a.add({ duration: 100, update: (k) => seen.push(k) });
    a.add({ delay: 50, duration: 100, update: () => {}, blocking: true });
    a.add({ duration: 1000, update: (k) => (cosmetic = k), blocking: false });
    let resolved = false;
    a.whenIdle().then(() => (resolved = true));
    a.tick(50);
    expect(seen.at(-1)).toBeCloseTo(0.5);
    a.tick(120);
    expect(a.busy).toBe(true);
    a.tick(160);
    await Promise.resolve();
    expect(resolved).toBe(true);
    expect(a.busy).toBe(false);
    expect(cosmetic).toBeLessThan(1);
    expect(a.size).toBe(1);
  });

  it('finishAll jumps everything to the end and calls done/start once', () => {
    const a = new Animator();
    let started = 0;
    let done = 0;
    let last = -1;
    a.add({ delay: 500, duration: 100, start: () => started++, update: (k) => (last = k), done: () => done++, ease: ease.outCubic });
    a.finishAll();
    expect([started, done, last]).toEqual([1, 1, 1]);
    expect(a.size).toBe(0);
  });

  it('finishBlocking leaves cosmetic tweens running', () => {
    const a = new Animator();
    let c = 0;
    a.add({ duration: 100, update: () => {} });
    a.add({ duration: 100, update: (k) => (c = k), blocking: false });
    a.finishBlocking();
    expect(a.busy).toBe(false);
    expect(a.size).toBe(1);
    a.tick(100);
    expect(c).toBe(1);
  });
});

// M1 issue: overhead hp bars were unreadable (fill drawn under the translucent background)
describe('HpBar', () => {
  it('puts background and fill in the same render list so renderOrder draws the fill on top', () => {
    const bar = new HpBar();
    const bg = bar.bg.material as THREE.MeshBasicMaterial;
    const fg = bar.fg.material as THREE.MeshBasicMaterial;
    // three.js renders all opaque objects before transparent ones: both must be transparent
    expect(bg.transparent).toBe(true);
    expect(fg.transparent).toBe(true);
    expect(fg.opacity).toBe(1);
    expect(bar.fg.renderOrder).toBeGreaterThan(bar.bg.renderOrder);
    for (const m of [bg, fg]) {
      expect(m.fog).toBe(false);
      expect(m.toneMapped).toBe(false);
      expect(m.depthTest).toBe(false);
      expect(m.depthWrite).toBe(false);
    }
    bar.set(20 / 32);
    expect('#' + fg.color.getHexString()).toBe('#5fe08a');
    bar.set(0.2);
    expect('#' + fg.color.getHexString()).toBe('#ff5a4a');
    expect(bar.fg.scale.x).toBeCloseTo(0.58 * 0.2);
    bar.dispose();
  });
});
