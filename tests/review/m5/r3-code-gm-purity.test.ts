/**
 * Review M5 round 3 (code): engine purity of applyGmActions for the GM action types the round-1
 * fuzz did not cover. gm-checks dry-runs every model action through applyGmActions on the LIVE
 * snapshot (GmContext.state is the session's state object), so any mutation of the input state
 * would leak a refused or capped action into the real game.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parseWorld } from '../../../src/schema/refs';
import { applyGmActions, createGame, legalActions, serialize, step, leadPlayer } from '../../../src/engine';
import type { GameState } from '../../../src/engine/types';
import { GmAction } from '../../../src/schema/gm';
import { createRng } from '../../../src/engine/rng';

const files = readdirSync('content/worlds').filter((f) => f.endsWith('.json'));

describe('applyGmActions never mutates its input (all action types)', () => {
  for (const f of files) {
    it(`${f}`, () => {
      const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${f}`, 'utf8')));
      if (!r.ok) throw new Error(r.errors.join('\n'));
      const world = r.world;
      const rng = createRng(f.length * 17 + 3);
      const items = world.items.map((i) => i.id);
      const actors = world.actors.map((a) => a.id);
      const statuses = world.statuses.map((x) => x.id);
      const pick = <T,>(xs: T[]): T => xs[rng.int(0, xs.length - 1)]!;
      let s: GameState = createGame(world, { seed: 5 });
      for (let i = 0; i < 200 && s.status === 'playing'; i++) {
        if (i % 5 === 2) {
          const other = s.area.actors.find((a) => a.id !== leadPlayer(s).actorId && a.hp > 0);
          const raw: unknown[] = [
            { type: 'effect', target: 'all_visible_enemies', effects: [{ type: 'damage', amount: { base: 3 } }, ...(statuses.length ? [{ type: 'apply_status', status: pick(statuses) }] : [])] },
            { type: 'effect', target: 'nearest_enemy', effects: [{ type: 'push', distance: 2 }, { type: 'transform', into: pick(actors) }] },
            { type: 'effect', target: 'player', effects: [{ type: 'teleport', mode: 'random' }, { type: 'modify_stat', stat: 'hp', amount: 2 }, { type: 'heal', amount: { base: 2 } }] },
            { type: 'give_item', item: pick(items) },
            { type: 'currency', amount: 7 },
            { type: 'grant_xp', amount: 30 },
            { type: 'set_flag', flag: 'review-flag' },
            ...(other ? [{ type: 'change_faction', actorId: other.id, faction: 'friendly' }, { type: 'say', actorId: other.id, text: 'Hi' }] : []),
            { type: 'start_quest', id: 'rq', title: 'Q', description: 'D', complete: { type: 'turn', cmp: 'gte', value: s.turn + 2 }, reward: [{ type: 'grant_xp', amount: 10 }] },
            { type: 'add_rule', reason: 'r', rule: { id: `gm-r${i}`, name: 'R', description: 'd', playerTriggers: [{ on: 'on_turn', every: 3, action: { effects: [{ type: 'heal', amount: { base: 1 } }] } }] } },
            { type: 'reveal_item', item: pick(items), level: 'clear' },
            { type: 'mood', music: 'tense' },
          ];
          const gm = raw.map((a) => GmAction.parse(a));
          const sub = gm.filter(() => rng.chance(0.5));
          const before = serialize(s);
          const res = applyGmActions(s, sub, { world });
          expect(serialize(s)).toBe(before);
          s = res.state;
          if (i % 10 === 2 && !leadPlayer(s).pendingChoice) {
            const offer = GmAction.parse({ type: 'offer_choice', prompt: 'p', options: [{ label: 'a', actions: [{ type: 'grant_xp', amount: 5 }] }, { label: 'b', actions: [{ type: 'currency', amount: 3 }] }] });
            const b2 = serialize(s);
            const r2 = applyGmActions(s, [offer], { world });
            expect(serialize(s)).toBe(b2);
            s = r2.state;
          }
        } else {
          const legal = legalActions(s, { world });
          const a = legal[rng.int(0, legal.length - 1)]!;
          const before = serialize(s);
          const next = step(s, a, { world }).state;
          expect(serialize(s)).toBe(before);
          s = next;
        }
      }
    }, 60_000);
  }
});
