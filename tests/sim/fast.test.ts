/**
 * fastStep (in-place, used by the simulator) must behave exactly like the public step(): same
 * states, same events, same refusals, over long bot and random games on every world.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { WORLD_DIR, loadFixture } from '../engine/helpers';
import { createGame, step, stepTurn, legalActions, serialize, leadPlayer, readyPlayers } from '../../src/engine';
import { createRng } from '../../src/engine/rng';
import type { GameState, PlayerAction, TurnInput } from '../../src/engine/types';
import { fastStep, fastStepTurn } from '../../src/engine/sim/fast';
import { botByName, newMemory } from '../../src/engine/sim/bots';
import { gmActionsForArea } from '../../src/engine/sim/gm-script';
import { applyGmActions } from '../../src/engine';

const files = readdirSync(WORLD_DIR).filter((f) => f.endsWith('.json')).sort();

function copy(s: GameState): GameState {
  return structuredClone(s);
}

describe('fastStep matches step()', () => {
  for (const f of files) {
    it(`${f}: 400 explorer steps + 200 random/junk steps give identical states`, () => {
      const world = loadFixture(f);
      const env = { world };
      let a = createGame(world, { seed: 11 });
      let b = copy(a);
      const bot = botByName('explorer');
      const mem = newMemory(11);
      const rng = createRng(99);
      let gmArea = -1;
      for (let i = 0; i < 600 && a.status === 'playing'; i++) {
        // GM batches go through the public API on both copies
        if (a.area.index !== gmArea && !leadPlayer(a).pendingChoice && !leadPlayer(a).pendingPerkChoice) {
          gmArea = a.area.index;
          const acts = gmActionsForArea(world, a.area.index);
          a = applyGmActions(a, acts, env).state;
          b = applyGmActions(b, acts, env).state;
        }
        let action: PlayerAction;
        if (i < 400) action = bot.decide(a, world, mem);
        else if (rng.chance(0.15)) action = { type: rng.pick(['use', 'attack', 'interact', 'choose_option', 'transition'] as const), slot: rng.int(-1, 30), targetId: 'a9999', index: rng.int(-1, 4), pos: { x: rng.int(0, 60), y: rng.int(0, 60) } } as unknown as PlayerAction;
        else {
          const legal = legalActions(a, env);
          action = legal[rng.int(0, legal.length - 1)];
        }
        const ra = step(a, action, env);
        const rb = fastStep(b, action, world);
        expect(rb.tookTurn).toBe(ra.tookTurn);
        expect(rb.events).toEqual(ra.events);
        a = ra.state;
        b = rb.state;
        if (i % 20 === 0 || a.status !== 'playing') expect(serialize(b)).toBe(serialize(a));
      }
      expect(serialize(b)).toBe(serialize(a));
    });
  }
});

describe('fastStepTurn matches stepTurn() for a party of three', () => {
  for (const f of ['fixture-ship.json', 'fixture-western.json', 'detective-sugar-hotel.json']) {
    it(`${f}: 250 party turns of explorer/cautious/talker bots give identical states`, () => {
      const world = loadFixture(f);
      const env = { world };
      let a = createGame(world, { seed: 21, players: [{ name: 'Ann' }, { name: 'Bea' }, { name: 'Cid' }] });
      let b = copy(a);
      const bots = ['explorer', 'cautious', 'talker'].map((n) => botByName(n));
      const mems = bots.map((_, i) => newMemory(21 + i));
      for (let i = 0; i < 250 && a.status === 'playing'; i++) {
        const ready = new Set(readyPlayers(a, env));
        const inputs: TurnInput[] = [];
        a.party.forEach((pid, k) => {
          if (ready.has(pid)) inputs.push({ playerId: pid, actions: [bots[k].decide(a, world, mems[k], pid)] });
        });
        const ra = stepTurn(a, inputs, { ...env, advance: true });
        const rb = fastStepTurn(b, inputs, world, { advance: true });
        expect(rb.tookTurn).toBe(ra.tookTurn);
        expect(rb.outcomes).toEqual(ra.outcomes);
        expect(rb.waited).toEqual(ra.waited);
        expect(rb.events).toEqual(ra.events);
        a = ra.state;
        b = rb.state;
        if (i % 25 === 0 || a.status !== 'playing') expect(serialize(b)).toBe(serialize(a));
      }
      expect(serialize(b)).toBe(serialize(a));
    });
  }
});
