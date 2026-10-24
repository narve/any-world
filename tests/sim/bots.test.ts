/** Bot behaviour on hand-built situations, plus the runner's outcome classification. */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { WORLD_DIR, loadFixture, testWorld, newGame, player, addActor, env, roomMap, simpleGenerator } from '../engine/helpers';
import { createGame, step, legalActions, serialize } from '../../src/engine';
import type { GameState, PlayerAction, MapGenerator } from '../../src/engine/types';
import { BOT_NAMES, botByName, newMemory, type Bot } from '../../src/engine/sim/bots';
import { botCtx, fastLegal, itemProfile } from '../../src/engine/sim/view';
import { runGame } from '../../src/engine/sim/run';
import type { WorldSpec } from '../../src/schema';

const same = (a: PlayerAction, b: PlayerAction) => JSON.stringify(a) === JSON.stringify(b);
const isLegal = (s: GameState, world: WorldSpec, a: PlayerAction) =>
  a.type === 'wait' || legalActions(s, { world, mapGenerator: simpleGenerator }).some((x) => same(x, a));

function decide(name: string, world: WorldSpec, s: GameState, seed = 1): PlayerAction {
  return botByName(name).decide(s, world, newMemory(seed));
}

describe('bot helpers', () => {
  it('fastLegal equals legalActions and decide() never mutates the state, along real games', () => {
    const files = readdirSync(WORLD_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, 3)) {
      const world = loadFixture(f);
      let s = createGame(world, { seed: 5 });
      const mem = newMemory(5);
      const bot = botByName('explorer');
      for (let i = 0; i < 150 && s.status === 'playing'; i++) {
        const before = serialize(s);
        expect(fastLegal(botCtx(world, s))).toEqual(legalActions(s, { world }));
        const a = bot.decide(s, world, mem);
        expect(serialize(s), 'decide() mutated the state').toBe(before);
        s = step(s, a, { world }).state;
      }
    }
  });

  it('item profiles read heals, damage, flags and resources', () => {
    const world = testWorld();
    const p = (id: string) => itemProfile(world, world.items.find((i) => i.id === id)!);
    expect(p('tonic').heal).toBe(6);
    expect(p('spark').damage).toBe(3);
    expect(p('spark').offensive).toBe(true);
    expect(p('fog').selfHarm).toBe(true);
    expect(p('wand').offensive).toBe(true);
  });
});

describe('bot decisions', () => {
  it('every bot resolves a pending perk choice (and the persona bots pick the strongest perk)', () => {
    const world = testWorld();
    const s = newGame(world);
    s.player.pendingPerkChoice = ['quick', 'tough'];
    for (const name of BOT_NAMES) {
      const a = decide(name, world, s);
      expect(a.type).toBe('choose_perk');
    }
    expect(decide('explorer', world, s)).toEqual({ type: 'choose_perk', perkId: 'tough' });
  });

  it('answers a healer dialogue by asking for help when hurt', () => {
    const world = testWorld();
    let s = newGame(world);
    const p = player(s);
    addActor(world, s, 'sage', { x: p.pos.x + 1, y: p.pos.y });
    s = step(s, { type: 'talk', targetId: s.area.actors[s.area.actors.length - 1].id }, env(world)).state;
    expect(s.pendingChoice).not.toBeNull();
    player(s).hp = 10;
    const a = decide('explorer', world, s);
    expect(a.type).toBe('choose_option');
    const opt = s.pendingChoice!.options[(a as { index: number }).index];
    expect(opt.tag).toBe('service:heal');
  });

  it('picks the cheapest way out of a GM offer it cannot afford', () => {
    const world = testWorld();
    let s = newGame(world);
    s.pendingChoice = {
      kind: 'gm_offer',
      prompt: 'buy?',
      options: [
        { label: 'Buy', actions: [{ type: 'currency', amount: -50 }, { type: 'give_item', item: 'tonic', count: 1 }] },
        { label: 'Decline', actions: [] },
      ],
    };
    const a = decide('cautious', world, s);
    expect(a).toEqual({ type: 'choose_option', index: 1 });
    s = step(s, a, env(world)).state;
    expect(s.pendingChoice).toBeNull();
  });

  it('heals with a known item when hurt and calm', () => {
    const world = testWorld();
    const s = newGame(world);
    player(s).hp = 6;
    const a = decide('explorer', world, s);
    expect(a.type).toBe('use');
    expect(s.player.slots[(a as { slot: number }).slot]!.defId).toBe('tonic');
  });

  it('tries an unknown item when it is safe, but not with a hostile in view', () => {
    const world = testWorld();
    const s = newGame(world);
    s.player.slots[6] = { id: 'i900', defId: 'murk', count: 1 };
    expect(s.knowledge.murk.level).toBe('unknown');
    const a = decide('explorer', world, s);
    expect(a).toEqual({ type: 'use', slot: 6 });
    const p = player(s);
    addActor(world, s, 'rat', { x: p.pos.x + 2, y: p.pos.y + 2 }, { ai: { alerted: true } });
    const b = decide('explorer', world, s);
    expect(b).not.toEqual({ type: 'use', slot: 6 });
  });

  it('fights an adjacent hostile (explorer) and persuades it first (talker)', () => {
    const world = testWorld();
    const s = newGame(world);
    const p = player(s);
    const rat = addActor(world, s, 'rat', { x: p.pos.x + 1, y: p.pos.y + 1 }, { ai: { alerted: true } });
    const s2 = step(s, { type: 'wait' }, env(world)).state; // refresh FOV
    const r2 = s2.area.actors.find((a) => a.id === rat.id)!;
    const a = decide('explorer', world, s2);
    expect(a.type === 'attack' ? a.targetId === r2.id : a.type === 'move').toBe(true);
    expect(isLegal(s2, world, a)).toBe(true);
    expect(decide('talker', world, s2)).toEqual({ type: 'persuade', targetId: r2.id });
  });

  it('cautious bot sneaks when the world allows it', () => {
    const world = testWorld();
    const s = newGame(world);
    expect(decide('cautious', world, s)).toEqual({ type: 'toggle_sneak' });
  });

  it('walks to an item the transition lock needs, then leaves once it holds it', () => {
    const world = testWorld();
    const s = newGame(world);
    const mem = newMemory(1);
    const bot = botByName('explorer');
    // the key is on the floor across the (fully visible) room
    s.area.items.push({ item: { id: 'i901', defId: 'key', count: 1 }, pos: { x: 6, y: 5 } });
    let cur = s;
    for (let i = 0; i < 60 && cur.area.index === 0; i++) {
      const a = bot.decide(cur, world, mem);
      expect(isLegal(cur, world, a), JSON.stringify(a)).toBe(true);
      const r = step(cur, a, env(world));
      expect(r.events.find((e) => e.type === 'invalid')).toBeUndefined();
      cur = r.state;
    }
    expect(cur.player.slots.some((it) => it?.defId === 'key')).toBe(true);
    expect(cur.area.index).toBe(1);
  });
});

describe('runGame', () => {
  it('reports a walled-off exit as stuck (not an endless loop)', () => {
    const world = testWorld((w) => {
      delete (w.areas[0] as { transitionRequires?: unknown }).transitionRequires;
    });
    const walls: { x: number; y: number }[] = [];
    for (let x = 8; x <= 10; x++) walls.push({ x, y: 6 });
    walls.push({ x: 8, y: 7 }, { x: 8, y: 8 });
    const sealed: MapGenerator = () => roomMap(12, 10, { walls });
    const r = runGame(world, 3, 'explorer', { mapGenerator: sealed, maxTurns: 5000, stallSteps: 150 });
    expect(r.result).toBe('stuck');
    expect(r.cause).toMatch(/no progress/);
    expect(r.steps).toBeLessThan(2000);
  });

  it('classifies a throwing bot as a crash with its cause', () => {
    const world = testWorld();
    const bad: Bot = {
      name: 'explorer',
      decide: () => {
        throw new Error('boom');
      },
    };
    const r = runGame(world, 1, bad, { mapGenerator: simpleGenerator });
    expect(r.result).toBe('crash');
    expect(r.cause).toMatch(/^bot: .*boom/);
  });

  it('runs the scripted GM (spawn, offer_choice, add_rule/remove_rule) without crashing', () => {
    const world = loadFixture('fixture-western.json');
    const r = runGame(world, 2, 'explorer', { gm: true, fast: true });
    expect(r.result).not.toBe('crash');
    expect(r.stats.gmBatches).toBeGreaterThan(0);
    expect(r.stats.invalidLegal).toBe(0);
  });

  it('is deterministic per seed and bot', () => {
    const world = loadFixture('fixture-teen.json');
    const a = runGame(world, 4, 'cautious', { fast: true, maxTurns: 400 });
    const b = runGame(world, 4, 'cautious', { fast: true, maxTurns: 400 });
    expect(b).toEqual(a);
  });
});
