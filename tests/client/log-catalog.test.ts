/**
 * Engine log lines through the client catalog (M3 integration): real runs on every fixture, every
 * keyed line rendered by the UI's ICU formatter (src/client/i18n) must read exactly like the engine's
 * own English text (after the world's health word is added, as the log panel does). Catches a catalog
 * template that drifts from LOG_KEYS or a param the client formatter treats differently.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { WORLD_DIR, loadFixture } from '../engine/helpers';
import { createGame, step, legalActions } from '../../src/engine';
import { createRng } from '../../src/engine/rng';
import { botByName, newMemory } from '../../src/engine/sim/bots';
import type { LogMessage } from '../../src/engine/types';
import { logLineText } from '../../src/client/ui/components/log';
import { displayLogText } from '../../src/client/ui/format';
import { hasKey, tx } from '../../src/client/i18n/index';

const files = readdirSync(WORLD_DIR).filter((f) => f.startsWith('fixture-') && f.endsWith('.json')).sort();

describe('engine log keys rendered by the client catalog', () => {
  it('every keyed line of real runs renders to the engine text, and loss reasons too', () => {
    const problems: string[] = [];
    const keys = new Set<string>();
    let keyed = 0;
    for (const f of files) {
      const world = loadFixture(f);
      const vocab = world.vocabulary;
      for (const seed of [1, 2, 3]) {
        let s = createGame(world, { seed });
        const bot = botByName(seed % 2 ? 'explorer' : 'talker');
        const mem = newMemory(seed);
        const rng = createRng(seed * 17 + 3);
        const seen: LogMessage[] = [...s.log];
        for (let i = 0; i < 600 && s.status === 'playing'; i++) {
          const legal = legalActions(s, { world });
          const action = rng.next() < 0.7 ? bot.decide(s, world, mem) : legal[rng.int(0, legal.length - 1)];
          const before = s.log;
          s = step(s, action, { world }).state;
          // log entries are shared copy-on-write: new ones are those not in the previous log
          const old = new Set(before);
          for (const m of s.log) if (!old.has(m)) seen.push(m);
        }
        for (const m of seen) {
          if (!m.key || m.kind === 'gm' || m.kind === 'npc') continue;
          keyed++;
          keys.add(m.key);
          if (!hasKey(m.key)) problems.push(`${f}: key ${m.key} missing from the catalog`);
          const got = logLineText(m, vocab);
          const want = displayLogText(m.text, vocab);
          if (got !== want) problems.push(`${f}: ${m.key}: "${got}" ≠ "${want}"`);
          if (/[{}]/.test(got) && !/[{}]/.test(m.text)) problems.push(`${f}: ${m.key}: placeholder left in "${got}"`);
        }
        if (s.status === 'lost' && s.endReasonKey && s.endReason !== undefined) {
          const r = tx(s.endReasonKey, s.endReasonParams, s.endReason);
          if (r !== s.endReason) problems.push(`${f}: end reason ${s.endReasonKey}: "${r}" ≠ "${s.endReason}"`);
        }
      }
    }
    expect([...new Set(problems)].slice(0, 10)).toEqual([]);
    expect(keyed).toBeGreaterThan(300);
    expect(keys.size).toBeGreaterThanOrEqual(20);
  }, 120_000);
});
