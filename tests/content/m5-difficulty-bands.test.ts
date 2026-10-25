/**
 * M5 difficulty-band retune of three bundled M3 worlds (issues/M5-difficulty-bands-m3-worlds.md).
 *
 * The win rates themselves are checked with
 *   npm run sim -- --world <file> --seeds 100 --bots explorer,cautious,talker --analyse --difficulty <d>
 * (too slow for vitest). These tests pin the cheap, deterministic properties the retune relies on,
 * so a later edit that undoes one of them shows up here first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';

const dir = join(__dirname, '..', '..', 'content', 'worlds');

function load(id: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')));
  if (!r.ok) throw new Error(`${id}: ${r.errors.join('\n')}`);
  return r.world;
}

function actor(w: WorldSpec, id: string) {
  const a = w.actors.find((x) => x.id === id);
  if (!a) throw new Error(`no actor ${id}`);
  return a;
}

function spawn(w: WorldSpec, area: number, id: string) {
  const s = w.areas[area]!.actors.find((x) => x.actor === id);
  if (!s) throw new Error(`no spawn ${id} in area ${area}`);
  return s;
}

describe('heist-silent-vault: the rank-and-file guard is a real threat (gentle was 93%)', () => {
  const w = load('heist-silent-vault');
  it('Night Watchman is still a real threat (13 hp, 3+1d2 since the new-player gate; was 15 hp, 3+1d4)', () => {
    // issues/M5-new-player-deaths.md: the watchman killed most new players, so the gate retune
    // took ×0.85 off him; he still hits harder than the player's 1d3 cough
    const a = actor(w, 'night-watchman');
    expect(a.stats.hp).toBeGreaterThanOrEqual(13);
    expect(a.attack!.damage).toMatchObject({ base: 3, dice: '1d2' });
  });
});

describe('folk-horror-scarecrow-wedding: brutal no longer ends in area 1 (brutal was 1%)', () => {
  const w = load('folk-horror-scarecrow-wedding');
  it('the opening swarm is smaller and the small hitters have no flat bonus', () => {
    const aunt = spawn(w, 0, 'well-wishing-aunt');
    expect(aunt.min ?? 0).toBeLessThanOrEqual(1);
    expect(aunt.max ?? 99).toBeLessThanOrEqual(3);
    // a flat +1 on a d3 is rounded up by the brutal ×1.3 damage multiplier on every hit
    expect(actor(w, 'banns-crow').attack!.damage.base ?? 0).toBe(0);
    expect(actor(w, 'clapperling').attack!.damage.base ?? 0).toBe(0);
    expect(actor(w, 'banns-crow').stats.hp).toBeLessThanOrEqual(5);
  });
  it('more player hp; Gaffer Hob is the boss a new player can beat (45 hp since the new-player gate; was 74)', () => {
    expect(w.player.stats.hp).toBe(32);
    // issues/M5-new-player-deaths.md: Hob killed most newbie runs (gentle 38%, normal 8%)
    const hob = actor(w, 'gaffer-hob');
    expect(hob.stats.hp).toBeGreaterThanOrEqual(45);
    expect(hob.stats.hp).toBeGreaterThan(w.player.stats.hp);
  });
});

describe('deep-sea-whale-fall: brutal survives the descent (brutal was 1%), gentle stays near band', () => {
  const w = load('deep-sea-whale-fall');
  it('the pre-boss swarm is thinner and the fast Ghost Chimaera hits softer', () => {
    expect(actor(w, 'ghost-chimaera').attack!.damage.base ?? 0).toBe(0);
    expect(actor(w, 'osteo-crab').attack!.damage.base ?? 0).toBeLessThanOrEqual(1);
    expect(spawn(w, 1, 'ghost-chimaera').min ?? 0).toBeLessThanOrEqual(1);
    expect(spawn(w, 1, 'hagfish-knot').min ?? 0).toBeLessThanOrEqual(1);
    expect(spawn(w, 2, 'osteo-crab').max ?? 99).toBeLessThanOrEqual(3);
    expect(spawn(w, 2, 'ghost-chimaera').min ?? 0).toBeLessThanOrEqual(1);
  });
  it('two galley broths wait at the start of the last area, and HARROW-4 is tougher to compensate', () => {
    const broths = w.areas[3]!.placedItems.filter((p) => p.item === 'galley-broth' && p.where === 'near_start');
    expect(broths).toHaveLength(2);
    expect(w.items.find((i) => i.id === 'galley-broth')!.onUse?.effects.some((e) => e.type === 'heal')).toBe(true);
    expect(w.player.stats.hp).toBe(32);
    // 98 hp / 4+1d8 before the new-player gate took ×0.85 off it (issues/M5-new-player-deaths.md)
    const rig = actor(w, 'harrow-rig');
    expect(rig.stats.hp).toBeGreaterThanOrEqual(83);
    expect(rig.attack!.damage.base).toBe(3);
  });
});
