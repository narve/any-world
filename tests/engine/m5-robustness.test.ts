/**
 * M5 engine fixes (issues/M5-*.md):
 * - default-attack-verb: the built-in attack has no English verb in the log (own keys, catalog verb)
 * - proto-ids: ids named like Object.prototype members ("constructor") are rejected by the schema
 *   and, when they reach the engine anyway (saved/edited state, GM), behave like any other id
 * - extreme-modifiers: modifier amounts are bounded, so stats stay finite
 * (moved here from tests/review/m5/proto-ids.test.ts and extreme-modifiers.test.ts)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORLD_DIR, testWorld, newGame, ctxFor, player, addActor, ScriptedRng } from './helpers';
import { performAttack, attackOf, DEFAULT_ACTOR_ATTACK } from '../../src/engine/combat';
import { evalCondition } from '../../src/engine/conditions';
import { uniqueSpawnable } from '../../src/engine/actors';
import { statName } from '../../src/engine/ctx';
import { knowledgeOf } from '../../src/engine/knowledge';
import { own } from '../../src/engine/util';
import { renderLogKey } from '../../src/engine/log-keys';
import { parseWorld } from '../../src/schema/refs';
import { Id, RESERVED_IDS, WorldSpec } from '../../src/schema/world';
import { runGame } from '../../src/engine/sim/index';
import { createGame, step } from '../../src/engine/index';
import type { PlayerAction } from '../../src/engine/types';
import { setLanguage, tx } from '../../src/client/i18n/index';

afterEach(() => setLanguage('en', { persist: false }));

const readWorld = (file: string) => JSON.parse(readFileSync(join(WORLD_DIR, `${file}.json`), 'utf8'));

describe('default attack (no world-authored verb)', () => {
  it('logs with *_default keys and no verb param; the catalog supplies the verb', () => {
    const w = testWorld((wi) => {
      const rat = wi.actors!.find((a) => a.id === 'rat')!;
      delete (rat as { attack?: unknown }).attack;
    });
    const s = newGame(w, 1);
    const p = player(s);
    const rat = addActor(w, s, 'rat', { x: 2, y: 1 });
    const ctx = ctxFor(w, s, new ScriptedRng([20, 15, 1]));
    expect(attackOf(ctx, rat)!.attack).toBe(DEFAULT_ACTOR_ATTACK);
    performAttack(ctx, rat, p); // crit
    performAttack(ctx, rat, p); // miss (roll 1 later)
    const lines = s.log.filter((m) => m.key?.startsWith('log.attack.'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const m of lines) {
      expect(m.key).toMatch(/_default$/);
      expect(m.params).not.toHaveProperty('verb');
      expect(m.text).toBe(renderLogKey(m.key!, m.params));
    }
    setLanguage('nb', { persist: false });
    const nbText = tx(lines[0].key!, { ...lines[0].params, hp: 'Tålmodighet' }, lines[0].text);
    expect(nbText).not.toMatch(/strikes/);
    expect(nbText).toMatch(/fulltreffer/);
  });

  it('a world-authored attack still logs its own verb', () => {
    const w = testWorld();
    const s = newGame(w, 1);
    const rat = addActor(w, s, 'rat', { x: 2, y: 1 });
    performAttack(ctxFor(w, s, new ScriptedRng([15])), rat, player(s));
    const m = s.log.filter((x) => x.key?.startsWith('log.attack.')).pop()!;
    expect(m.key).not.toMatch(/_default$/);
    expect(m.params?.verb).toBe(attackOf(ctxFor(w, s), rat)!.attack.verb);
  });
});

describe('ids named like Object.prototype members', () => {
  it('the schema refuses reserved ids with repair feedback', () => {
    for (const id of RESERVED_IDS) expect(Id.safeParse(id).success, id).toBe(false);
    expect(Id.safeParse('constructos').success).toBe(true);
    const text = readFileSync(join(WORLD_DIR, 'viking-lawspeaker-althing.json'), 'utf8').replaceAll('"thirds-recited"', '"constructor"');
    const r = parseWorld(JSON.parse(text));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/reserved/);
  });

  it('own() reads own properties only', () => {
    const o: Record<string, number> = { a: 1 };
    expect(own(o, 'a')).toBe(1);
    expect(own(o, 'constructor')).toBeUndefined();
    expect(own(o, 'toString')).toBeUndefined();
    expect(own(o, '__proto__')).toBeUndefined();
  });

  it('counters, flags, defeats, knowledge and stat names keyed "constructor" start empty', () => {
    const w = testWorld();
    const s = newGame(w, 1);
    const ctx = ctxFor(w, s);
    expect(evalCondition(ctx, { type: 'counter', counter: 'constructor', cmp: 'eq', value: 0 })).toBe(true);
    expect(evalCondition(ctx, { type: 'flag', flag: 'constructor', value: false })).toBe(true);
    expect(evalCondition(ctx, { type: 'actor_defeated', actor: 'constructor', count: 1 })).toBe(false);
    expect(uniqueSpawnable(ctx, 'constructor')).toBe(true);
    expect(knowledgeOf(ctx, 'constructor')).toMatchObject({ level: 'clear', notes: [], timesUsed: 0 });
    expect(statName(ctx, 'constructor')).toBe('constructor');
  });

  /**
   * Renaming an id must not change any run. The schema refuses "constructor", so the world is parsed
   * with "constructos" (same length and sort position) and renamed afterwards, as a hand-edited or
   * older stored world would reach the engine.
   */
  function renamedAfterParse(file: string, from: string, to: string): WorldSpec {
    const r = parseWorld(JSON.parse(JSON.stringify(readWorld(file)).replaceAll(`"${from}"`, '"constructos"')));
    if (!r.ok) throw new Error(r.errors.join('\n'));
    return JSON.parse(JSON.stringify(r.world).replaceAll('"constructos"', `"${to}"`)) as WorldSpec;
  }
  /**
   * Plays the "constructos" world with a bot and replays the same actions on the "constructor" world:
   * the engine must give the same game (states equal after renaming back). Replaying isolates the
   * engine from the sim's bots, which keep their own id-keyed reads (src/engine/sim, other owner).
   */
  function replayDiff(file: string, from: string, bot: 'talker' | 'explorer', seeds: number[]): string[] {
    const ok = renamedAfterParse(file, from, 'constructos');
    const proto = renamedAfterParse(file, from, 'constructor');
    const diffs: string[] = [];
    const outcomes: string[] = [];
    for (const seed of seeds) {
      const actions: PlayerAction[] = [];
      const ref = runGame(ok, seed, bot, { maxTurns: 3000, onStep: (_s, action) => actions.push(action) });
      let a = createGame(ok, { seed });
      let b = createGame(proto, { seed });
      for (const [i, action] of actions.entries()) {
        a = step(a, action, { world: ok }).state;
        b = step(b, action, { world: proto }).state;
        if (i % 50 === 0 || i === actions.length - 1) {
          const sa = JSON.stringify(a);
          // worldId carries a content hash of the world, which the rename changes
          const sb = JSON.stringify({ ...b, worldId: a.worldId }).replaceAll('"constructor"', '"constructos"');
          if (sa !== sb) {
            diffs.push(`seed ${seed} step ${i} turn ${a.turn}`);
            break;
          }
        }
      }
      outcomes.push(`${seed}:${ref.result}:${a.status}:${b.status}`);
    }
    expect(outcomes.some((o) => o.includes(':won:')), outcomes.join(' ')).toBe(true);
    return diffs;
  }

  it('a counter called "constructor" (viking win condition: counter gte 3)', () => {
    expect(replayDiff('viking-lawspeaker-althing', 'thirds-recited', 'talker', [1, 2, 3, 4])).toEqual([]);
  }, 300_000);

  it('a boss actor called "constructor" (corporate-merger win condition: actor_defeated)', () => {
    expect(replayDiff('corporate-merger-kitchen', 'odile-greaves', 'explorer', [1, 2, 3, 4])).toEqual([]);
  }, 300_000);
});

describe('modifier amounts are bounded', () => {
  it('perk modifiers of 1e308 are refused by the schema', () => {
    const w = readWorld('fixture-teen');
    for (const p of w.player.growth.perks) p.modifiers = [{ stat: 'hp', amount: 1e308 }, { stat: 'mp', amount: 1e308 }];
    const r = parseWorld(w);
    expect(r.ok).toBe(false);
  });

  it('item, status and modify_stat amounts outside ±100 are refused; ±100 is accepted', () => {
    const w = readWorld('fixture-teen');
    const item = w.items.find((i: { modifiers?: unknown[] }) => i.modifiers && i.modifiers.length) ?? w.items[0];
    item.modifiers = [{ stat: 'str', amount: 101 }];
    expect(parseWorld(w).ok).toBe(false);
    item.modifiers = [{ stat: 'str', amount: -100 }];
    expect(parseWorld(w).ok).toBe(true);
    const w2 = readWorld('fixture-teen');
    w2.statuses[0].modifiers = [{ stat: 'ac', amount: -1e9 }];
    expect(parseWorld(w2).ok).toBe(false);
  });

  it('the largest allowed perk modifiers play without non-finite stats', () => {
    const w = readWorld('fixture-teen');
    for (const p of w.player.growth.perks) p.modifiers = [{ stat: 'hp', amount: 100 }, { stat: 'mp', amount: 100 }];
    const r = parseWorld(w);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const seed of [1, 2]) {
      const g = runGame(r.world, seed, 'explorer', { fast: true });
      expect(g.result, g.cause).not.toBe('crash');
    }
  }, 120_000);
});
