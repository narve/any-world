import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createGame } from '../../src/engine';
import { applyPlace } from '../../src/place/apply';
import { worldPlace } from '../../src/place/load';
import { parseWorld, validateWorldRefs } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import { fixturePatch, loadFixture } from './fixtures';

function world(id: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(fileURLToPath(new URL(`../../content/worlds/${id}.json`, import.meta.url)), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

const place = () => worldPlace(loadFixture('domkirken'), fixturePatch('domkirken'), '2026-11-10T12:00:00.000Z');

describe('a world on a real place', () => {
  it('applyPlace lays the opening area out on the place and stays a valid world', () => {
    const base = world('fixture-western');
    const placed = applyPlace(base, place());
    expect(placed.areas[0]).toMatchObject({ generator: 'place', patch: 'domkirken', size: 'large', name: base.areas[0]!.name });
    expect(placed.areas.slice(1).map((a) => a.generator)).toEqual(base.areas.slice(1).map((a) => a.generator));
    expect(base.areas[0]!.generator).not.toBe('place'); // the input is untouched
    // survives the world file round trip (export, rooms, storage)
    const again = parseWorld(JSON.parse(JSON.stringify(placed)));
    expect(again.ok, again.ok ? '' : again.errors.join('\n')).toBe(true);
    // applying another place replaces the first
    const other = worldPlace(loadFixture('tangen'), fixturePatch('tangen'), '2026-11-10T12:00:00.000Z');
    const moved = applyPlace(placed, other);
    expect(moved.areas[0]!.patch).toBe('tangen');
    expect(validateWorldRefs(moved)).toEqual([]);
  });

  it('a run starts on the real map', () => {
    const placed = applyPlace(world('fixture-western'), place());
    const state = createGame(placed, { seed: 11 });
    const map = state.area.map;
    expect([map.width, map.height]).toEqual([56, 40]);
    expect(map.regions.map((r) => r.name)).toEqual(expect.arrayContaining(['Kristiansand domkirke', 'Kirkegata']));
    expect(map.tiles.filter((t) => t.surface === 'road').length).toBeGreaterThan(60);
  });

  it('validation names a missing or misplaced patch', () => {
    const placed = applyPlace(world('fixture-western'), place());
    const wrong = { ...placed, areas: placed.areas.map((a, i) => (i === 0 ? { ...a, patch: 'nowhere' } : a)) };
    expect(validateWorldRefs(wrong).join('\n')).toMatch(/unknown place patch "nowhere" \(valid: domkirken\)/);
    const { patch: _p, ...bare } = placed.areas[0]!;
    expect(validateWorldRefs({ ...placed, areas: [bare as WorldSpec['areas'][number], ...placed.areas.slice(1)] }).join('\n')).toMatch(/generator "place" needs a patch/);
    const stray = { ...placed, areas: placed.areas.map((a, i) => (i === 1 ? { ...a, patch: 'domkirken' } : a)) };
    expect(validateWorldRefs(stray).join('\n')).toMatch(/only generator "place" takes a patch/);
    const noPlace = { ...placed, place: undefined };
    expect(validateWorldRefs(noPlace).join('\n')).toMatch(/the world has no place/);
    const twice = { ...placed, place: { ...placed.place!, patches: [placed.place!.patches[0]!, placed.place!.patches[0]!] } };
    expect(validateWorldRefs(twice).join('\n')).toMatch(/duplicate id "domkirken"/);
  });
});
