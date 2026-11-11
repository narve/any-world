import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PREVIEW_COLORS, previewColor, previewMap } from '../../src/client/place-preview';
import { cachePatch, cachedPatch, recentPlaces, rememberPlace } from '../../src/client/place-store';
import { AreaView, surfaceColor } from '../../src/client/render/tiles';
import type { AreaState } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';
import { makePlan } from '../mapgen/helpers';
import { fixturePatch } from './fixtures';

class MemoryStorage {
  private m = new Map<string, string>();
  quota = Infinity;
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (v.length > this.quota) throw new Error('QuotaExceededError');
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe('place store', () => {
  let store: MemoryStorage;
  beforeEach(() => {
    store = new MemoryStorage();
    (globalThis as { localStorage?: unknown }).localStorage = store;
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('remembers the latest places first, once each, at most six', () => {
    for (let i = 0; i < 8; i++) rememberPlace({ name: `P${i}`, displayName: `P${i}, Town`, lat: 58 + i * 0.01, lon: 8, type: 'square' });
    rememberPlace({ name: 'P3 again', displayName: 'x', lat: 58.03, lon: 8, type: '' });
    const names = recentPlaces().map((p) => p.name);
    expect(names).toHaveLength(6);
    expect(names[0]).toBe('P3 again');
    expect(names).not.toContain('P3');
  });

  it('keeps a patch for a week, per spot and extent', () => {
    const patch = fixturePatch('kuben');
    const t0 = 1_800_000_000_000;
    cachePatch(59.92734, 10.81631, 160, patch, t0);
    expect(cachedPatch(59.92733, 10.81632, 160, t0 + 1000)?.id).toBe('kuben');
    expect(cachedPatch(59.92734, 10.81631, 200, t0 + 1000)).toBeNull();
    expect(cachedPatch(59.93, 10.81631, 160, t0 + 1000)).toBeNull();
    expect(cachedPatch(59.92734, 10.81631, 160, t0 + 8 * 24 * 3600 * 1000)).toBeNull();
  });

  it('survives broken or full storage', () => {
    store.setItem('anyworld.place.recent.v1', '{not json');
    store.setItem('anyworld.place.cache.v1', '"nope"');
    expect(recentPlaces()).toEqual([]);
    expect(cachedPatch(1, 2, 160)).toBeNull();
    store.quota = 10;
    expect(() => cachePatch(1, 2, 160, fixturePatch('kuben'))).not.toThrow();
    expect(() => rememberPlace({ name: 'A', displayName: 'A', lat: 1, lon: 2, type: '' })).not.toThrow();
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(recentPlaces()).toEqual([]);
  });
});

describe('place preview', () => {
  it('lays the patch out as the game will and colours it by ground', () => {
    const map = previewMap(fixturePatch('domkirken'));
    expect([map.width, map.height]).toEqual([56, 40]);
    const used = new Set(map.tiles.map((_, i) => previewColor(map, i)));
    for (const c of ['road', 'grass', 'plaza', 'wall', 'indoor', 'door', 'water'] as const) expect(used, c).toContain(PREVIEW_COLORS[c]);
    // the start is outdoors
    expect(previewColor(map, map.start.y * map.width + map.start.x)).not.toBe(PREVIEW_COLORS.indoor);
  });
});

describe('place rendering', () => {
  it('draws trees as trees and gives every ground kind its own colour', () => {
    const patch = fixturePatch('domkirken');
    const map = previewMap(patch);
    const plan = { ...makePlan('place', 'large'), patch: patch.id, floor: { color: '#b02030', material: 'stone' as const, pattern: 'plain' as const } };
    const world = { terrains: [], palette: { accent: '#ffffff' } } as unknown as WorldSpec;
    const view = new AreaView(world, plan, { index: 0, map } as unknown as AreaState);
    const stats = view.stats();
    const trees = map.tiles.filter((t) => t.prop === 'tree').length;
    expect(trees).toBeGreaterThan(3);
    expect(stats.trees).toBe(trees);
    // a tree stands on ground, and is not also a wall block
    const walls = map.tiles.filter((t) => t.kind === 'wall' && t.prop !== 'tree').length;
    expect(stats.walls).toBeLessThanOrEqual(walls);
    expect(stats.floor).toBeGreaterThanOrEqual(map.tiles.filter((t) => ['floor', 'start', 'transition', 'door'].includes(t.kind)).length + trees);
    view.dispose();

    // on a strongly red floor, grass is still green and a road still grey
    const grass = surfaceColor('#b02030', 'grass');
    expect(grass.g).toBeGreaterThan(grass.r);
    const road = surfaceColor('#b02030', 'road');
    expect(Math.abs(road.r - road.b)).toBeLessThan(0.12);
    expect(surfaceColor('#b02030', 'plaza').getHSL({ h: 0, s: 0, l: 0 }).l).toBeGreaterThan(surfaceColor('#b02030', 'road').getHSL({ h: 0, s: 0, l: 0 }).l);
    expect(new THREE.Color('#b02030').g).toBeLessThan(0.05);
  });
});

describe('the bundled example places', () => {
  it('content/places.json names every file in content/places', () => {
    const index = JSON.parse(readFileSync('content/places.json', 'utf8')) as Record<string, string>;
    const files = readdirSync('content/places').filter((f) => f.endsWith('.json'));
    expect(Object.keys(index).sort()).toEqual(files.map((f) => f.replace(/\.json$/, '')).sort());
    for (const f of files) expect(index[f.replace(/\.json$/, '')]).toBe((JSON.parse(readFileSync(`content/places/${f}`, 'utf8')) as { name: string }).name);
  });
});
