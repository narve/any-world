/**
 * Review M5 round 1: worlds kept in this browser (storage.ts saveGeneratedWorld). Keeping a new
 * generated or imported world evicts the oldest stored world, even when that is the world of the
 * autosaved run in progress: the run can no longer be continued (main.ts continueRun clears it
 * with "app.savedMissing").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadGeneratedWorlds, saveGeneratedWorld, saveRun, loadRun, MAX_GENERATED_WORLDS, type SavedRun } from '../../src/client/storage';

class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

describe('stored worlds vs. the autosaved run', () => {
  const g = globalThis as { localStorage?: unknown };
  let prev: unknown;
  beforeEach(() => {
    prev = g.localStorage;
    g.localStorage = new MemoryStorage();
  });
  afterEach(() => {
    g.localStorage = prev;
  });

  it('keeping more worlds never evicts the world the saved run is played in', () => {
    const world = { meta: { title: 'W' } };
    expect(saveGeneratedWorld('gen-playing-1', world, 1, { source: 'generated' })).toBe(true);
    const run: SavedRun = { v: 1, worldId: 'gen-playing-1', worldTitle: 'W', playerName: 'p', areaName: 'a', turn: 3, state: '{}', gmLog: [], savedAt: 2 };
    expect(saveRun(run)).toBe(true);
    // the player imports a handful of world files (or generates a few more)
    for (let i = 0; i < MAX_GENERATED_WORLDS; i++) saveGeneratedWorld(`gen-imported-${i}`, world, 10 + i, { source: 'imported' });
    expect(loadRun()?.worldId).toBe('gen-playing-1');
    expect(loadGeneratedWorlds().map((w) => w.id)).toContain('gen-playing-1');
  });
});
