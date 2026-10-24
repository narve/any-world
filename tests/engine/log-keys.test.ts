/**
 * i18n of the engine log (DESIGN §7b): every engine-generated line carries a catalog key from
 * LOG_KEYS plus params, and its English `text` is exactly the key's template rendered with those
 * params. Lines without a key must be world/GM/NPC-authored text (already in the world's language).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORLD_DIR, loadFixture, testWorld, newGame, act, player } from './helpers';
import { createGame, step, legalActions, applyGmActions } from '../../src/engine';
import { LOG_KEYS, END_REASON_KEYS, FACTION_KEYS, renderLogKey, renderTemplate, templateParams } from '../../src/engine/log-keys';
import { createRng } from '../../src/engine/rng';
import { botByName, newMemory } from '../../src/engine/sim/bots';
import { gmActionsForArea, gmIdleActions } from '../../src/engine/sim/gm-script';
import type { GameEvent, GameState, LogMessage, PlayerAction } from '../../src/engine/types';
import type { GmAction } from '../../src/schema/gm';
import type { WorldSpec } from '../../src/schema';

const files = readdirSync(WORLD_DIR).filter((f) => f.startsWith('fixture-') && f.endsWith('.json')).sort();

/** every string anywhere in a value */
function strings(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

interface Seen {
  keyed: Map<string, number>;
  keyless: { text: string; kind: string }[];
  problems: string[];
}

function check(m: LogMessage | Extract<GameEvent, { type: 'message' }>, seen: Seen): void {
  if (m.key) {
    seen.keyed.set(m.key, (seen.keyed.get(m.key) ?? 0) + 1);
    if (!(m.key in LOG_KEYS)) seen.problems.push(`unknown key ${m.key}`);
    const rendered = renderLogKey(m.key, m.params);
    if (rendered !== m.text) seen.problems.push(`${m.key}: "${rendered}" !== "${m.text}"`);
    for (const v of Object.values(m.params ?? {})) {
      if (typeof v !== 'string' && typeof v !== 'number') seen.problems.push(`${m.key}: param of type ${typeof v}`);
      if (typeof v === 'number' && !Number.isFinite(v)) seen.problems.push(`${m.key}: non-finite param`);
    }
    for (const p of templateParams(LOG_KEYS[m.key as keyof typeof LOG_KEYS] ?? '')) {
      if (!(p in (m.params ?? {}))) seen.problems.push(`${m.key}: missing param ${p}`);
    }
  } else {
    seen.keyless.push({ text: m.text, kind: m.kind });
  }
}

function play(world: WorldSpec, seed: number, steps: number, seen: Seen, gmStrings: Set<string>): GameState {
  const env = { world };
  let s = createGame(world, { seed });
  for (const m of s.log) check(m, seen);
  const bot = botByName(seed % 2 ? 'explorer' : 'talker');
  const mem = newMemory(seed);
  const rng = createRng(seed * 31 + 7);
  let gmArea = -1;
  let nextIdle = 60;
  for (let i = 0; i < steps && s.status === 'playing'; i++) {
    if (s.area.index !== gmArea && !s.pendingChoice && !s.player.pendingPerkChoice) {
      gmArea = s.area.index;
      const acts: GmAction[] = gmActionsForArea(world, s.area.index);
      strings(acts, gmStrings);
      const r = applyGmActions(s, acts, env);
      for (const e of r.events) if (e.type === 'message') check(e, seen);
      s = r.state;
    } else if (s.turn >= nextIdle && !s.pendingChoice) {
      nextIdle = s.turn + 80;
      const acts = gmIdleActions(s);
      strings(acts, gmStrings);
      s = applyGmActions(s, acts, env).state;
    }
    let action: PlayerAction;
    const roll = rng.next();
    if (roll < 0.6) action = bot.decide(s, world, mem);
    else {
      const legal = legalActions(s, env);
      action = legal[rng.int(0, legal.length - 1)];
    }
    const before = s.log.length;
    const r = step(s, action, env);
    const msgs = r.events.filter((e): e is Extract<GameEvent, { type: 'message' }> => e.type === 'message');
    for (const e of msgs) check(e, seen);
    // the log gained the same lines as the message events (key + params included)
    const tail = r.state.log.slice(-msgs.length);
    if (msgs.length && r.state.log.length >= before) {
      tail.forEach((m, k) => {
        if (m.text !== msgs[k].text || m.key !== msgs[k].key) seen.problems.push(`log/event mismatch: ${m.text} vs ${msgs[k].text}`);
        if (m.key) expect(m.params).toEqual(msgs[k].params);
      });
    }
    s = r.state;
  }
  return s;
}

describe('engine log lines carry catalog keys', () => {
  it('LOG_KEYS templates are well-formed and every key is emitted somewhere in the engine source', () => {
    const src = join(__dirname, '..', '..', 'src', 'engine');
    const code = readdirSync(src)
      .filter((f) => f.endsWith('.ts') && f !== 'log-keys.ts')
      .map((f) => readFileSync(join(src, f), 'utf8'))
      .join('\n');
    for (const [key, tpl] of Object.entries(LOG_KEYS)) {
      expect(key).toMatch(/^log\.[a-z_]+(\.[a-z_]+)*$/);
      expect(tpl.length).toBeGreaterThan(0);
      // balanced braces: every { opens a {param} or {param|cap}
      expect(tpl.replace(/\{[A-Za-z0-9_]+(\|cap)?\}/g, '')).not.toMatch(/[{}]/);
      const viaMap = (Object.values(FACTION_KEYS) as string[]).includes(key);
      expect(code.includes(`'${key}'`) || viaMap, `${key} is never emitted`).toBe(true);
    }
    for (const key of Object.keys(END_REASON_KEYS)) expect(code.includes(`'${key}'`), `${key} is never used`).toBe(true);
  });

  it('renderTemplate: params, |cap, numbers and missing params', () => {
    expect(renderTemplate('{a|cap} hits {b} for {n}.', { a: 'the rat', b: 'Tess', n: 3 })).toBe('The rat hits Tess for 3.');
    expect(renderTemplate('{a} and {missing}!', { a: 'x' })).toBe('x and !');
    expect(renderTemplate('{a|cap}', { a: '' })).toBe('');
    expect(renderLogKey('log.attack.hit', { attacker: 'rat', verb: 'bites', target: 'Tess', amount: 2 })).toBe('Rat bites Tess for 2.');
    expect(renderLogKey('no.such.key')).toBe('no.such.key');
    expect(templateParams(LOG_KEYS['log.attack.crit_typed'])).toEqual(['attacker', 'verb', 'target', 'amount', 'damageType']);
  });

  it('a long fuzz run on every fixture: every keyed line is a known key whose template renders to its text; keyless lines are authored text', () => {
    const seen: Seen = { keyed: new Map(), keyless: [], problems: [] };
    let lines = 0;
    for (const f of files) {
      const world = loadFixture(f);
      const gmStrings = new Set<string>();
      const authored = strings(world);
      for (const seed of [1, 2, 3, 4]) {
        const before = seen.keyless.length;
        const s = play(world, seed, 700, seen, gmStrings);
        lines += s.log.length;
        for (const k of seen.keyless.slice(before)) {
          const ok = authored.has(k.text) || gmStrings.has(k.text);
          if (!ok) seen.problems.push(`${f}: keyless engine line "${k.text}" (${k.kind})`);
        }
        if (s.status === 'lost' && s.endReasonKey) expect(renderLogKey(s.endReasonKey, s.endReasonParams)).toBe(s.endReason);
      }
    }
    expect(seen.problems.slice(0, 10)).toEqual([]);
    expect(lines).toBeGreaterThan(500);
    // the run exercised a broad set of keys
    expect(seen.keyed.size).toBeGreaterThanOrEqual(30);
  }, 120_000);

  it('the test world: every key the scripted scenarios produce renders back to its text', () => {
    const w = testWorld();
    let s = newGame(w);
    const out: LogMessage[] = [];
    const run = (a: PlayerAction) => {
      const r = act(w, s, a);
      s = r.state;
    };
    run({ type: 'toggle_sneak' });
    run({ type: 'toggle_sneak' });
    run({ type: 'search' });
    run({ type: 'use', slot: 1 });
    run({ type: 'drop', slot: 1 });
    run({ type: 'pickup' });
    player(s).pos = { ...s.area.map.exit };
    const locked = act(w, s, { type: 'transition' });
    // a refused action leaves the state as it was; the reason is the event's
    expect(locked.state).toBe(s);
    expect(locked.events).toEqual([{ type: 'invalid', reason: 'Stairs: locked' }]);
    player(s).hp = 3;
    s = applyGmActions(s, [{ type: 'currency', amount: -3 }, { type: 'currency', amount: 7 }, { type: 'spawn', actor: 'rat', count: 2, near: 'player' }], { world: w }).state;
    out.push(...s.log);
    for (const m of out) {
      if (!m.key) continue;
      expect(m.key in LOG_KEYS).toBe(true);
      expect(renderLogKey(m.key, m.params)).toBe(m.text);
    }
    const keys = new Set(out.map((m) => m.key));
    for (const k of ['log.sneak.on', 'log.sneak.off', 'log.search.nothing', 'log.item.use', 'log.item.drop', 'log.item.pickup', 'log.currency.gain', 'log.currency.spend', 'log.appears_many']) {
      expect(keys.has(k), k).toBe(true);
    }
    const spend = out.find((m) => m.key === 'log.currency.spend')!;
    expect(spend.text).toBe('-3 coins');
    expect(spend.params).toEqual({ amount: 3, currency: 'coins' });
  });
});
