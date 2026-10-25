/** storage.ts (M4): settings normalisation, worlds kept in this browser (sources, origin, forget). */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSettings, forgetGeneratedWorld, loadGeneratedWorlds, loadSettings, MAX_GENERATED_WORLDS, normalizeSettings, saveGeneratedWorld, saveSettings } from '../../src/client/storage';
import { findStoredWorld, forgetWorld, generatedWorlds, GENERATED_PREFIX, hasWorld, loadWorld, recordingsKey, rememberWorld, worldIndex, worldTitle } from '../../src/client/worlds';
import { parseWorld } from '../../src/schema/refs';

class MemoryStorage {
  data = new Map<string, string>();
  quota = Infinity;
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (v.length > this.quota) throw new Error('QuotaExceededError');
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
}

const mem = new MemoryStorage();
const g = globalThis as { localStorage?: unknown };
const had = 'localStorage' in g;
const prev = g.localStorage;
g.localStorage = mem;
afterAll(() => {
  if (had) g.localStorage = prev;
  else delete g.localStorage;
});
beforeEach(() => {
  mem.clear();
  mem.quota = Infinity;
});

const teenRaw = JSON.parse(readFileSync(join(__dirname, '..', '..', 'content', 'worlds', 'fixture-teen.json'), 'utf8'));
const teen = (() => {
  const r = parseWorld(teenRaw);
  if (!r.ok) throw new Error('fixture invalid');
  return r.world;
})();

describe('settings', () => {
  it('defaults: auto quality, GM on, SoundCloud off', () => {
    const d = defaultSettings('backend');
    expect(d).toMatchObject({ quality: 'auto', gm: true, audio: { soundcloud: false }, provider: { transport: 'backend' } });
  });

  it('round-trips through localStorage', () => {
    const s = { ...defaultSettings('direct'), quality: 'low' as const, gm: false, audio: { volume: 0.2, muted: true, soundcloud: true } };
    s.provider = { preset: 'openai', transport: 'direct', apiKey: 'sk-1', model: 'gpt-5' };
    saveSettings(s);
    expect(loadSettings('direct')).toEqual({ ...s, apiKeys: { openai: 'sk-1' } }); // the key is also kept per preset (M5-api-key-leaks-across-presets)
  });

  it('repairs bad or hostile values field by field', () => {
    const s = normalizeSettings(
      { provider: { preset: 42, transport: 'carrier-pigeon', apiKey: '' }, audio: { volume: 7, muted: 'yes' }, animationSpeed: 'fast', quality: 'ultra', gm: 'no' },
      'backend',
    );
    expect(s.provider).toEqual({ preset: 'anthropic', transport: 'backend' });
    expect(s.audio).toEqual({ volume: 1, muted: true, soundcloud: false });
    expect(s.animationSpeed).toBe(1);
    expect(s.quality).toBe('auto');
    expect(s.gm).toBe(true);
    expect(normalizeSettings(null, 'direct')).toEqual(defaultSettings('direct'));
  });

  it('a static build (direct only) never loads a stored backend transport', () => {
    expect(normalizeSettings({ provider: { preset: 'anthropic', transport: 'backend' } }, 'direct', ['direct']).provider.transport).toBe('direct');
    expect(normalizeSettings({ provider: { preset: 'anthropic', transport: 'backend' } }, 'backend').provider.transport).toBe('backend');
  });

  it('corrupt JSON falls back to defaults', () => {
    mem.setItem('anyworld.settings.v1', '{nope');
    expect(loadSettings('direct')).toEqual(defaultSettings('direct'));
  });
});

describe('worlds kept in this browser', () => {
  it('remembers source and origin; generatedWorlds re-validates them', () => {
    const a = rememberWorld(teen, 1, { source: 'imported' });
    const b = rememberWorld(teen, 2, { source: 'generated', origin: 'fixture-teen' });
    expect(a.id.startsWith(GENERATED_PREFIX)).toBe(true);
    const list = generatedWorlds();
    expect(list.map((w) => [w.id, w.source, w.origin])).toEqual([
      [a.id, 'imported', undefined],
      [b.id, 'generated', 'fixture-teen'],
    ]);
    expect(recordingsKey(findStoredWorld(b.id)!)).toBe('fixture-teen');
    expect(recordingsKey(findStoredWorld(a.id)!)).toBe(a.id);
  });

  it('entries from before M4 (no source) count as AI-made', () => {
    mem.setItem('anyworld.worlds.v1', JSON.stringify([{ id: 'gen-old-1', world: teenRaw, savedAt: 5 }]));
    expect(generatedWorlds()[0]).toMatchObject({ id: 'gen-old-1', source: 'generated', savedAt: 5 });
  });

  it('an invalid stored world is skipped, not fatal', () => {
    mem.setItem('anyworld.worlds.v1', JSON.stringify([{ id: 'gen-bad-1', world: { nope: 1 }, savedAt: 1 }, { id: 'gen-ok-1', world: teenRaw, savedAt: 2 }]));
    expect(generatedWorlds().map((w) => w.id)).toEqual(['gen-ok-1']);
  });

  it('forget drops one world; bundled ids cannot be forgotten', () => {
    const a = rememberWorld(teen, 11);
    const b = rememberWorld(teen, 12);
    expect(forgetWorld(a.id)).toBe(true);
    expect(forgetWorld(a.id)).toBe(false);
    expect(forgetWorld('fixture-teen')).toBe(false);
    expect(loadGeneratedWorlds().map((w) => w.id)).toEqual([b.id]);
    expect(forgetGeneratedWorld('gen-missing')).toBe(false);
  });

  it('keeps at most MAX_GENERATED_WORLDS and drops the oldest when storage is full', () => {
    for (let i = 0; i < MAX_GENERATED_WORLDS + 2; i++) saveGeneratedWorld(`gen-w-${i}`, { n: i }, i);
    const ids = loadGeneratedWorlds().map((w) => w.id);
    expect(ids).toHaveLength(MAX_GENERATED_WORLDS);
    expect(ids[ids.length - 1]).toBe(`gen-w-${MAX_GENERATED_WORLDS + 1}`);
    mem.quota = JSON.stringify([{ id: 'gen-x', world: { n: 1 }, savedAt: 1, source: 'imported' }]).length * 2.5;
    expect(saveGeneratedWorld('gen-x', { n: 1 }, 1, { source: 'imported' })).toBe(true);
    expect(loadGeneratedWorlds().length).toBeLessThan(MAX_GENERATED_WORLDS);
    expect(loadGeneratedWorlds().at(-1)).toMatchObject({ id: 'gen-x', source: 'imported' });
  });
});

describe('bundled world index (light, synchronous) and lazy specs', () => {
  it('lists every bundled world with meta and colour, without loading specs', () => {
    const idx = worldIndex();
    expect(idx.length).toBeGreaterThanOrEqual(10);
    const teenIdx = idx.find((w) => w.id === 'fixture-teen')!;
    expect(teenIdx.meta.title).toBe(teen.meta.title);
    expect(teenIdx.color).toBe(teen.palette.primary);
    expect(idx.map((w) => w.id)).toEqual([...idx.map((w) => w.id)].sort());
    expect(worldTitle('fixture-teen')).toBe(teen.meta.title);
    expect(worldTitle('nope')).toBeUndefined();
    expect(hasWorld('fixture-teen')).toBe(true);
    expect(hasWorld('gen-nope-1')).toBe(false);
  });

  it('loadWorld validates bundled specs on demand and finds stored ones', async () => {
    const b = await loadWorld('fixture-teen');
    expect(b?.world).toEqual(teen);
    expect(await loadWorld('nope')).toBeUndefined();
    const g = rememberWorld(teen, 99, { source: 'imported' });
    expect((await loadWorld(g.id))?.source).toBe('imported');
    expect(hasWorld(g.id)).toBe(true);
    expect(worldTitle(g.id)).toBe(teen.meta.title);
  });
});
