/** World files (DESIGN §12): export → import round trips; imports are untrusted and re-validated. */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import { exportWorldFile, MAX_WORLD_FILE_BYTES, parseWorldFile, WORLD_FILE_FORMAT } from '../../src/client/world-file';

const dir = join(__dirname, '..', '..', 'content', 'worlds');
const worlds: [string, WorldSpec][] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    const r = parseWorld(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (!r.ok) throw new Error(`${f} invalid`);
    return [f, r.world];
  });
const teen = worlds.find(([f]) => f === 'fixture-teen.json')![1];
const nb = worlds.find(([, w]) => w.meta.language === 'nb')![1];

describe('exportWorldFile', () => {
  it('wraps the spec with a format header and a file name from the title', () => {
    const f = exportWorldFile(teen, new Date('2026-10-24T12:00:00Z'));
    expect(f.filename).toMatch(/^[a-z0-9-]+\.anyworld\.json$/);
    const json = JSON.parse(f.text);
    expect(json).toMatchObject({ format: WORLD_FILE_FORMAT, version: 1, exportedAt: '2026-10-24T12:00:00.000Z' });
    expect(json.world.meta.title).toBe(teen.meta.title);
  });

  it('slugs non-ASCII titles (Norwegian) into a safe file name', () => {
    expect(exportWorldFile(nb).filename).toMatch(/^[a-z0-9-]+\.anyworld\.json$/);
  });

  it('every recorded world survives export → import unchanged, language included', () => {
    for (const [name, w] of worlds) {
      const r = parseWorldFile(exportWorldFile(w).text);
      expect(r.ok, name).toBe(true);
      if (r.ok) {
        expect(r.world).toEqual(w);
        expect(r.world.meta.language).toBe(w.meta.language);
      }
    }
  });
});

describe('parseWorldFile', () => {
  it('accepts a bare World Spec (content/worlds/*.json) and a UTF-8 BOM', () => {
    expect(parseWorldFile(JSON.stringify(teen)).ok).toBe(true);
    expect(parseWorldFile(`﻿${JSON.stringify(teen)}`).ok).toBe(true);
  });

  it('rejects text that is not JSON', () => {
    const r = parseWorldFile('{"format": "anyworld-world", ');
    expect(r).toMatchObject({ ok: false, kind: 'not_json', key: 'world.import.error.notJson' });
  });

  it('rejects JSON that is not a world', () => {
    for (const text of ['[]', '42', 'null', '{"hello": 1}', '{"format": "something-else", "world": {}}', '{"format": "anyworld-world", "version": 1}']) {
      expect(parseWorldFile(text), text).toMatchObject({ ok: false, kind: 'not_world' });
    }
  });

  it('rejects files from a newer format or spec version', () => {
    expect(parseWorldFile(JSON.stringify({ format: WORLD_FILE_FORMAT, version: 2, world: teen }))).toMatchObject({ ok: false, kind: 'newer_version' });
    expect(parseWorldFile(JSON.stringify({ ...teen, specVersion: 2 }))).toMatchObject({ ok: false, kind: 'newer_version' });
  });

  it('rejects oversized files before parsing them', () => {
    const big = `{"x":"${'a'.repeat(MAX_WORLD_FILE_BYTES)}"}`;
    expect(parseWorldFile(big)).toMatchObject({ ok: false, kind: 'too_large' });
    // multi-byte characters count as UTF-8 bytes
    const wide = `{"x":"${'å'.repeat(Math.ceil(MAX_WORLD_FILE_BYTES / 2) + 10)}"}`;
    expect(parseWorldFile(wide)).toMatchObject({ ok: false, kind: 'too_large' });
  });

  it('re-validates the spec: schema errors and broken references are refused with details', () => {
    const noTitle = structuredClone(teen) as unknown as { meta: { title?: string } };
    delete noTitle.meta.title;
    const a = parseWorldFile(JSON.stringify(noTitle));
    expect(a).toMatchObject({ ok: false, kind: 'invalid', key: 'world.import.error.invalid' });
    if (!a.ok) expect(a.details.join(' ')).toMatch(/title/);

    const badRef = structuredClone(teen);
    badRef.player.startingItems = [{ item: 'no-such-item-anywhere', count: 1, equipped: false, quick: true }];
    const b = parseWorldFile(JSON.stringify({ format: WORLD_FILE_FORMAT, version: 1, world: badRef }));
    expect(b).toMatchObject({ ok: false, kind: 'invalid' });
    if (!b.ok) expect(b.details.join(' ')).toMatch(/no-such-item-anywhere/);
  });

  it('drops unknown keys (untrusted input never adds fields the game does not know)', () => {
    const extra = { ...structuredClone(teen), evil: '<script>alert(1)</script>', meta: { ...teen.meta, onclick: 'x' } };
    const r = parseWorldFile(JSON.stringify(extra));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('evil' in r.world).toBe(false);
      expect('onclick' in r.world.meta).toBe(false);
    }
  });
});
