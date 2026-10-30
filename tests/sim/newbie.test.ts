/**
 * The new-player bot (issues/M5-new-player-deaths.md): fights only what comes close, heals at 35%,
 * never uses an unknown item, walks straight at things. The new-player gate measures every demo
 * world with it, so its habits are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { loadFixture, testWorld, newGame, player, addActor, env } from '../engine/helpers';
import { step, leadPlayer } from '../../src/engine';
import type { GameState, PlayerAction } from '../../src/engine/types';
import { BOT_NAMES, DEFEND_RANGE, botByName, newMemory, type Bot } from '../../src/engine/sim/bots';
import { runGame } from '../../src/engine/sim/run';
import type { WorldSpec } from '../../src/schema';

function decide(name: string, world: WorldSpec, s: GameState): PlayerAction {
  return botByName(name).decide(s, world, newMemory(1));
}

/** a rat `dx` tiles east of the player, alerted and in view */
function ratAt(world: WorldSpec, dx: number): GameState {
  const s = newGame(world);
  const p = player(s);
  addActor(world, s, 'rat', { x: p.pos.x + dx, y: p.pos.y }, { ai: { alerted: true } });
  return step(s, { type: 'wait' }, env(world)).state; // refresh the field of view
}

describe('newbie bot', () => {
  it('is a named bot', () => {
    expect(BOT_NAMES).toContain('newbie');
    expect(botByName('newbie').name).toBe('newbie');
  });

  it('heals at 35% hp, not at the 50% the other bots top up at', () => {
    const world = testWorld();
    const s = newGame(world);
    player(s).hp = 13; // 43% of 30
    expect(decide('explorer', world, s).type).toBe('use');
    expect(decide('newbie', world, s).type).not.toBe('use');
    player(s).hp = 10; // 33%
    const a = decide('newbie', world, s);
    expect(a.type).toBe('use');
    expect(leadPlayer(s).slots[(a as { slot: number }).slot]!.defId).toBe('tonic');
  });

  it('never tries an unknown item, not even when calm or nearly dead', () => {
    const world = testWorld();
    const s = newGame(world);
    leadPlayer(s).slots = leadPlayer(s).slots.map((it) => (it && it.defId === 'tonic' ? null : it));
    leadPlayer(s).slots[6] = { id: 'i900', defId: 'murk', count: 1 };
    expect(leadPlayer(s).knowledge.murk.level).toBe('unknown');
    expect(decide('explorer', world, s)).toEqual({ type: 'use', slot: 6 });
    expect(decide('newbie', world, s)).not.toEqual({ type: 'use', slot: 6 });
    player(s).hp = 3;
    expect(decide('newbie', world, s)).not.toEqual({ type: 'use', slot: 6 });
  });

  it('leaves a hostile alone until it comes close, then fights it', () => {
    const world = testWorld();
    const DIRS: Record<string, [number, number]> = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };
    /** Chebyshev distance to the rat after action `a` (attacks count as closing in) */
    const after = (s: GameState, a: PlayerAction): number => {
      const p = player(s).pos;
      const rat = s.area.actors.find((x) => x.defId === 'rat')!.pos;
      if (a.type === 'attack') return 0;
      const [dx, dy] = a.type === 'move' ? DIRS[a.dir] : [0, 0];
      return Math.max(Math.abs(rat.x - p.x - dx), Math.abs(rat.y - p.y - dy));
    };
    const dist = (s: GameState) => after(s, { type: 'wait' });
    const far = ratAt(world, DEFEND_RANGE + 4);
    expect(dist(far)).toBeGreaterThan(DEFEND_RANGE);
    // the explorer goes after it; the newbie does not
    expect(after(far, decide('explorer', world, far))).toBeLessThan(dist(far));
    // it does what it would do with no rat there at all
    const alone = structuredClone(far);
    alone.area.actors = alone.area.actors.filter((x) => x.defId !== 'rat');
    expect(decide('newbie', world, far)).toEqual(decide('newbie', world, alone));
    const near = ratAt(world, 2);
    expect(dist(near)).toBeLessThanOrEqual(DEFEND_RANGE);
    expect(after(near, decide('newbie', world, near))).toBeLessThan(dist(near));
  });

  it('never uses an unknown item over whole games, and finishes them (no crash, no soft-lock)', () => {
    for (const file of ['fixture-ship.json', 'heist-silent-vault.json', 'fixture-teen.json']) {
      const world = loadFixture(file);
      const inner = botByName('newbie');
      const bad: string[] = [];
      const bot: Bot = {
        name: 'newbie',
        decide(s, w, m) {
          const a = inner.decide(s, w, m);
          if (a.type === 'use') {
            const it = leadPlayer(s).slots[a.slot];
            if (it && leadPlayer(s).knowledge[it.defId]?.level === 'unknown') bad.push(`${file} turn ${s.turn}: used unknown ${it.defId}`);
          }
          return a;
        },
      };
      for (const seed of [1, 2]) {
        const r = runGame(world, seed, bot, { fast: true });
        expect(['won', 'lost'], `${file} seed ${seed}: ${r.result} (${r.cause})`).toContain(r.result);
      }
      expect(bad).toEqual([]);
    }
  });

  it('is deterministic per seed', () => {
    const world = loadFixture('fixture-western.json');
    const a = runGame(world, 3, 'newbie', { fast: true });
    const b = runGame(world, 3, 'newbie', { fast: true });
    expect(b.result).toBe(a.result);
    expect(b.turns).toBe(a.turns);
    expect(b.cause).toBe(a.cause);
  });
});
