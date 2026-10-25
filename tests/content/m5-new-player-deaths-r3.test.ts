/**
 * M5 round-3 retune for new players on Gentle (issues/M5-new-player-gentle-deaths.md).
 *
 * The win rates are checked with
 *   npm run sim -- --gate --seeds 200 --seed-start 9001 --world <file>
 *   npm run sim -- --analyse --difficulty normal --bots explorer,cautious,talker --seeds 100 --world <file>
 * (too slow for vitest). These tests pin the deterministic properties the retune relies on, plus
 * the Hush death spiral, which is played through the engine.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { createGame } from '../../src/engine';
import { dealDamage } from '../../src/engine/combat';
import { enterArea } from '../../src/engine/area';
import type { GameState } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';
import { addActor, ctxFor, loadFixture, player, roomMap, WORLD_DIR } from '../engine/helpers';

function actor(w: WorldSpec, id: string) {
  const a = w.actors.find((x) => x.id === id);
  if (!a) throw new Error(`no actor ${id}`);
  return a;
}

function spawn(w: WorldSpec, area: number, id: string) {
  return w.areas[area]!.actors.find((x) => x.actor === id);
}

/** items the goal or an area transition needs, and items that set a flag the goal reads */
function keyItems(w: WorldSpec): Set<string> {
  const ids = new Set<string>();
  const walk = (c: unknown): void => {
    if (!c || typeof c !== 'object') return;
    const o = c as Record<string, unknown>;
    if (o.type === 'has_item' && typeof o.item === 'string') ids.add(o.item);
    if (o.type === 'flag' && typeof o.flag === 'string') {
      for (const it of w.items) if (it.onUse?.effects.some((e) => e.type === 'set_flag' && e.flag === o.flag)) ids.add(it.id);
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(w.goal.win);
  for (const a of w.areas) walk(a.transitionRequires);
  return ids;
}

const worldFiles = readdirSync(WORLD_DIR).filter((f) => f.endsWith('.json'));

describe('no area puts a far hostile in the same far corner as a key item', () => {
  // 'far' picks from the 10% of tiles farthest from the start, so both land side by side
  for (const file of worldFiles) {
    it(file, () => {
      const w = loadFixture(file);
      const keys = keyItems(w);
      w.areas.forEach((area, i) => {
        const farHostiles = area.placed.filter((p) => p.where === 'far' && actor(w, p.actor).faction === 'hostile');
        const farKeys = area.placedItems.filter((p) => p.where === 'far' && keys.has(p.item));
        expect({ area: i, both: farHostiles.length > 0 && farKeys.length > 0 }).toEqual({ area: i, both: false });
      });
    });
  }
});

describe('heist-silent-vault: an empty Hush rouses the watch at most once per area', () => {
  const w = loadFixture('heist-silent-vault.json');

  function watchmen(s: GameState): number {
    return s.area.actors.filter((a) => a.defId === 'night-watchman' && a.hp > 0).length;
  }

  /** hurts the player `n` times by 1 from a hostile, keeping them alive */
  function hurt(s: GameState, n: number, from: string): void {
    const ctx = ctxFor(w, s);
    for (let i = 0; i < n; i++) {
      player(s).hp = player(s).maxHp;
      dealDamage(ctx, player(s), 1, 'feedback', from);
    }
    s.rng = ctx.rng.state();
  }

  it('the rule, the meter and its reset are wired as the retune expects', () => {
    const rule = w.rules.find((r) => r.id === 'whisper-floors')!;
    const drain = rule.playerTriggers.find((t) => t.on === 'on_hurt')!;
    expect(drain.action.condition).toEqual({ type: 'flag', flag: 'watch-roused', value: false });
    const reset = rule.playerTriggers.find((t) => t.on === 'on_area_enter')!;
    expect(reset.action.effects).toEqual([{ type: 'set_flag', flag: 'watch-roused', value: false }]);
    const hush = w.resources.find((r) => r.id === 'hush')!;
    expect(hush.onEmpty.filter((e) => e.type === 'summon')).toHaveLength(1);
    expect(hush.onEmpty).toContainEqual({ type: 'set_flag', flag: 'watch-roused', value: true });
    // refills the meter completely (was +5, which emptied again five hits later)
    expect(hush.onEmpty).toContainEqual({ type: 'resource', resource: 'hush', amount: { base: hush.max } });
  });

  for (const difficulty of ['gentle', 'normal'] as const) {
    it(`${difficulty}: thirty hits in one area summon one Night Watchman; the next area can summon one more`, () => {
      const s = createGame(w, { seed: 11, map: roomMap(16, 12), difficulty });
      s.area.actors = s.area.actors.filter((a) => a.id === s.player.actorId);
      const docent = addActor(w, s, 'night-docent', { x: 10, y: 8 });
      expect(s.player.resources.hush).toBe(10);
      hurt(s, 30, docent.id);
      expect(watchmen(s)).toBe(1);
      expect(s.flags['watch-roused']).toBe(true);
      // the meter is not drained while the watch is out
      expect(s.player.resources.hush).toBe(10);

      const ctx = ctxFor(w, s);
      enterArea(ctx, 1, roomMap(16, 12));
      s.rng = ctx.rng.state();
      expect(s.flags['watch-roused']).toBe(false);
      s.area.actors = s.area.actors.filter((a) => a.id === s.player.actorId);
      const moth = addActor(w, s, 'echo-moth', { x: 10, y: 8 });
      hurt(s, 30, moth.id);
      expect(watchmen(s)).toBe(1);
    });
  }

  it('one Wolf Tone, and the encore cue is not in its corner', () => {
    expect(spawn(w, 2, 'wolf-tone')).toBeUndefined();
    expect(w.areas[2]!.placed.filter((p) => p.actor === 'wolf-tone')).toEqual([{ actor: 'wolf-tone', where: 'far' }]);
    expect(w.areas[2]!.placedItems.find((p) => p.item === 'prompters-last-cue')!.where).toBe('centre');
  });

  it('the Night Watchman is easier to hit, the vault has one rank-and-file watchman and a cake by the door', () => {
    expect(actor(w, 'night-watchman').stats.ac).toBeLessThanOrEqual(11);
    expect(spawn(w, 3, 'night-watchman')!.max).toBe(1);
    expect(w.areas[3]!.placedItems).toContainEqual({ item: 'sacher-slice', where: 'near_start' });
  });
});

describe('fixture-western: Drought (no regeneration) leaves a way to recover', () => {
  const w = loadFixture('fixture-western.json');

  it('arrival Parched is short', () => {
    const drought = w.rules.find((r) => r.id === 'drought')!;
    expect(drought.switches.noNaturalHpRegen).toBe(true);
    const parched = drought.playerTriggers[0]!.action.effects.find((e) => e.type === 'apply_status');
    expect(parched).toMatchObject({ status: 'parched', duration: 2 });
  });

  it('the flats and the galleries have a heal waiting by the start', () => {
    // not the cistern: a guaranteed heal there drops the static boss risk below the
    // fixtures-m2 guard and Vane stops being a real fight for the explorer
    const heals = new Set(w.items.filter((i) => i.onUse?.effects.some((e) => e.type === 'heal')).map((i) => i.id));
    for (const i of [1, 2]) {
      const placed = w.areas[i]!.placedItems.filter((p) => p.where === 'near_start' && heals.has(p.item));
      expect(placed.length, `area ${i}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('claim jumpers no longer outrange the Peacemaker, and the flats and galleries are thinner', () => {
    const gun = w.items.find((i) => i.id === 'peacemaker')!.weapon!;
    expect(actor(w, 'claim-jumper').attack!.range).toBeLessThanOrEqual(gun.range);
    expect(spawn(w, 1, 'claim-jumper')).toMatchObject({ min: 1, max: 3 });
    expect(spawn(w, 1, 'dust-coyote')!.max).toBeLessThanOrEqual(5);
    expect(spawn(w, 2, 'tinplate-prospector')).toMatchObject({ min: 1, max: 3 });
  });
});

describe('fixture-teen: no pack of Senior Pranksters, a softer final assembly', () => {
  const w = loadFixture('fixture-teen.json');

  it('the empty house has at most two pranksters, who hit softer', () => {
    expect(spawn(w, 1, 'senior-prankster')).toMatchObject({ min: 1, max: 2 });
    expect(spawn(w, 1, 'group-chat-lurker')!.max).toBeLessThanOrEqual(3);
    const p = actor(w, 'senior-prankster');
    expect(p.stats.hp).toBeLessThanOrEqual(14);
    expect(p.attack!.damage.base).toBe(1);
  });

  it('Mags rallies one lurker, not two; a polaroid waits by the assembly door', () => {
    const rally = actor(w, 'mags-calloway').abilities.find((a) => a.id === 'rally-the-squad')!;
    expect(rally.action.effects).toContainEqual(expect.objectContaining({ type: 'summon', actor: 'group-chat-lurker', count: 1 }));
    expect(spawn(w, 2, 'group-chat-lurker')!.max).toBeLessThanOrEqual(2);
    expect(w.areas[2]!.placedItems).toContainEqual({ item: 'polaroid', where: 'near_start' });
  });

  it('fewer random pickups (they mostly fed the explorer, who was above the normal band)', () => {
    expect(w.areas.map((a) => a.itemCount)).toEqual([5, 6, 3]);
  });
});

describe('corporate-merger-kitchen (en and nb): the Grapevine is not a crowd', () => {
  for (const file of ['corporate-merger-kitchen.json', 'corporate-merger-kitchen-nb.json']) {
    it(file, () => {
      const w = loadFixture(file);
      expect(spawn(w, 2, 'rumour-mill')).toMatchObject({ min: 1, max: 3 });
      expect(spawn(w, 2, 'watercooler-whisper')).toMatchObject({ min: 1, max: 3 });
      expect(spawn(w, 2, 'reply-all-chain')!.max).toBeLessThanOrEqual(2);
      expect(spawn(w, 2, 'greyline-consultant')!.max).toBeLessThanOrEqual(2);
    });
  }
});

describe('folk-horror-scarecrow-wedding: the tower and the nave are thinner', () => {
  const w = loadFixture('folk-horror-scarecrow-wedding.json');
  it('at most two clapperlings and two rope-ringers; two bridesmaids with the Gaffer', () => {
    expect(spawn(w, 2, 'clapperling')!.max).toBeLessThanOrEqual(2);
    expect(spawn(w, 2, 'rope-ringer')!.max).toBeLessThanOrEqual(2);
    expect(spawn(w, 3, 'barley-bridesmaid')).toMatchObject({ min: 2, max: 2 });
  });
});
