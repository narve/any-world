import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/llm/mock';
import { loadRecordingsFromDir } from '../../src/llm/recordings-node';
import { existsSync, readFileSync } from 'node:fs';
import { GmResponse, DialogueResponse, GmAction } from '../../src/schema/gm';
import { parseWorld } from '../../src/schema/refs';
import { slugify, worldKeyOf, gmPurpose, dialoguePurpose, recordingFileName, safeKey } from '../../src/llm/recording-keys';

const req = (purpose: string) => ({ system: 's', messages: [{ role: 'user' as const, content: 'u' }], purpose });

describe('recording keys', () => {
  it('slugs are ASCII kebab-case, Norwegian letters folded', () => {
    expect(slugify('Lowmoor Goes Under')).toBe('lowmoor-goes-under');
    expect(slugify('Ærlige Øyne på Åsen')).toBe('aerlige-oyne-pa-asen');
    expect(slugify('Café   Noir!!')).toBe('cafe-noir');
    expect(slugify('x'.repeat(80)).length).toBe(40);
    expect(worldKeyOf({ meta: { title: '???' } } as never)).toBe('world');
    expect(safeKey('fixture-ship')).toBe('fixture-ship');
  });

  it('purposes and file names', () => {
    expect(gmPurpose('area_enter', 'Fixture Ship', 2)).toBe('gm:area_enter/fixture-ship/a2');
    expect(dialoguePurpose('fixture-teen', 'janitor')).toBe('dialogue/fixture-teen/janitor');
    expect(recordingFileName('gm:area_enter/fixture-ship/a2')).toBe('gm-area_enter-a2.json');
    expect(recordingFileName('dialogue/fixture-teen/janitor')).toBe('dialogue-janitor.json');
    expect(gmPurpose('milestone', 'k'.repeat(60), 3).length).toBeLessThanOrEqual(100);
  });
});

describe('MockProvider scoped lookup', () => {
  it('drops trailing segments, then the bare purpose and its prefix', () => {
    expect(MockProvider.lookupKeys('gm:idle/w/a1', 'H')).toEqual(['gm:idle/w/a1#H', 'gm:idle/w/a1', 'gm:idle/w', 'gm:idle', 'gm']);
    expect(MockProvider.lookupKeys('gm:idle', 'H')).toEqual(['gm:idle#H', 'gm:idle', 'gm']);
    expect(MockProvider.lookupKeys('world', 'H', false)).toEqual(['world#H', 'world']);
  });

  it('serves the most specific recording', async () => {
    const m = new MockProvider({
      recordings: [
        { purpose: 'gm:idle/w', text: 'world-wide' },
        { purpose: 'gm:idle/w/a1', text: 'area 1' },
      ],
    });
    expect((await m.complete(req('gm:idle/w/a1'))).text).toBe('area 1');
    expect((await m.complete(req('gm:idle/w/a2'))).text).toBe('world-wide');
    await expect(m.complete(req('gm:idle/other/a1'))).rejects.toThrow(/no recording/);
  });

  it('repeatLast:false lets an exhausted key fall through', async () => {
    const m = new MockProvider({ repeatLast: false, recordings: [{ purpose: 'gm:idle/w/a1', text: 'once' }, { purpose: 'gm:idle/w', text: 'general' }] });
    expect((await m.complete(req('gm:idle/w/a1'))).text).toBe('once');
    expect((await m.complete(req('gm:idle/w/a1'))).text).toBe('general');
    await expect(m.complete(req('gm:idle/w/a1'))).rejects.toThrow(/no recording/);
    // default: the last one repeats
    const r = new MockProvider({ recordings: [{ purpose: 'x', text: 'again' }] });
    expect((await r.complete(req('x'))).text).toBe('again');
    expect((await r.complete(req('x'))).text).toBe('again');
  });
});

describe('loadRecordingsFromDir', () => {
  it('reads per-world subdirectories (or one world only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-'));
    writeFileSync(join(dir, 'top.json'), JSON.stringify({ purpose: 'world', text: 't' }));
    mkdirSync(join(dir, 'world-a'));
    mkdirSync(join(dir, 'world-b'));
    writeFileSync(join(dir, 'world-a', 'gm-intro-a0.json'), JSON.stringify({ recordings: [{ purpose: 'gm:intro/world-a/a0', json: { actions: [] } }] }));
    writeFileSync(join(dir, 'world-b', 'dialogue-x.json'), JSON.stringify([{ purpose: 'dialogue/world-b/x', json: { reply: 'hi' } }]));
    const all = await loadRecordingsFromDir(dir);
    expect(all.map((r) => r.purpose)).toEqual(['world', 'gm:intro/world-a/a0', 'dialogue/world-b/x']);
    expect((await loadRecordingsFromDir(dir, { recursive: false })).map((r) => r.purpose)).toEqual(['world']);
    expect((await loadRecordingsFromDir(dir, { worldKey: 'world-b' })).map((r) => r.purpose)).toEqual(['world', 'dialogue/world-b/x']);
  });

  it('every bundled recording parses and is scoped to its directory', async () => {
    const recs = await loadRecordingsFromDir('content/recordings');
    for (const r of recs) expect(r.purpose === 'world' || /^(gm:[a-z_]+|dialogue)\/[a-z0-9-]+(\/|$)/.test(r.purpose), r.purpose).toBe(true);
  });

  it('bundled recordings: schema-valid, for an existing world, referencing only its ids', async () => {
    const recs = await loadRecordingsFromDir('content/recordings');
    expect(recs.length).toBeGreaterThanOrEqual(30);
    const keys = new Set<string>();
    for (const r of recs) {
      const key = r.purpose.split('/')[1]!;
      keys.add(key);
      const file = `content/worlds/${key}.json`;
      expect(existsSync(file), file).toBe(true);
      const w = parseWorld(JSON.parse(readFileSync(file, 'utf8')));
      if (!w.ok) throw new Error(file);
      const items = new Set(w.world.items.map((i) => i.id));
      const actors = new Set(w.world.actors.map((a) => a.id));
      const isGm = r.purpose.startsWith('gm:');
      const parsed = (isGm ? GmResponse : DialogueResponse).safeParse(r.json);
      expect(parsed.success, r.purpose).toBe(true);
      const acts: GmAction[] = parsed.success ? (parsed.data as { actions: GmAction[] }).actions : [];
      const flat = acts.flatMap((a) => (a.type === 'offer_choice' ? [a, ...a.options.flatMap((o) => o.actions)] : [a]));
      for (const a of flat) {
        if ('item' in a && typeof a.item === 'string') expect(items.has(a.item), `${r.purpose}: ${a.item}`).toBe(true);
        if (a.type === 'spawn') expect(actors.has(a.actor), `${r.purpose}: ${a.actor}`).toBe(true);
        if ((a.type === 'say' || a.type === 'trade') && !/^a\d+$/.test(a.actorId)) expect(actors.has(a.actorId), `${r.purpose}: ${a.actorId}`).toBe(true);
      }
    }
    for (const k of ['fixture-dream', 'fixture-ship', 'fixture-teen', 'fixture-western']) expect(keys.has(k), k).toBe(true);
  });
});
