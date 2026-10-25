/**
 * M5 engine fixes (issues/M5-death-shows-other-ending.md, issues/M5-grant-xp-stack-overflow.md):
 * the ending text follows how the run was lost (goal.deathText vs goal.lossText), and a huge xp
 * grant levels up iteratively and boundedly instead of recursing once per level.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGame, applyGmActions, step, endingText, DEATH_REASON_KEYS, END_REASON_KEYS } from '../../src/engine';
import { grantXp, xpToNext, MAX_LEVELS_PER_CHECK } from '../../src/engine/progression';
import type { GameState } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';
import { parseWorld, worldWarnings } from '../../src/schema/refs';
import { GmAction } from '../../src/schema/gm';
import { endView } from '../../src/client/view';
import { setLanguage } from '../../src/client/i18n';
import { WORLD_DIR, act, ctxFor, loadFixture, newGame, player, roomMap, testWorld } from './helpers';

setLanguage('en');

const read = (file: string) => JSON.parse(readFileSync(join(WORLD_DIR, `${file}.json`), 'utf8'));

function parse(w: unknown): WorldSpec {
  const r = parseWorld(w);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

const gmLines = (s: GameState) => s.log.filter((m) => m.kind === 'gm').map((m) => m.text);

describe('ending text by how the run was lost', () => {
  const losable = (deathText?: string) =>
    testWorld((w) => {
      w.goal.lose = { type: 'turn', cmp: 'gte', value: 3 };
      w.goal.lossText = 'Time ran out.';
      if (deathText) w.goal.deathText = deathText;
    });

  it('a death by HP in yams shows the defeat ending, not the timeout ending (pt-desktop-r2-yams3-end.png)', () => {
    const yams = loadFixture('cyberpunk-rooftop-yams.json');
    expect(yams.goal.lose).toBeDefined(); // turn >= 1400
    expect(yams.goal.deathText).toBeTruthy();
    let s = structuredClone(createGame(yams, { seed: 3, map: roomMap() }));
    const me = s.area.actors.find((a) => a.id === s.player.actorId)!;
    me.hp = 1;
    s = applyGmActions(s, [{ type: 'spawn', actor: 'repo-agent', count: 2, near: 'player' }] as never).state;
    for (let i = 0; i < 200 && s.status === 'playing'; i++) s = step(s, { type: 'wait' }).state;
    expect(s.status).toBe('lost');
    expect(s.turn).toBeLessThan(1400);
    const end = endView(yams, s);
    expect(end.text).toBe(yams.goal.deathText);
    expect(end.text).not.toBe(yams.goal.lossText);
    expect(gmLines(s)).toContain(yams.goal.deathText);
    expect(gmLines(s)).not.toContain(yams.goal.lossText);
  });

  it('the lose condition shows lossText', () => {
    const w = losable('You were defeated.');
    let s = newGame(w);
    for (let i = 0; i < 10 && s.status === 'playing'; i++) s = act(w, s, { type: 'wait' }).state;
    expect(s.status).toBe('lost');
    expect(s.endReasonKey).toBeUndefined();
    expect(endingText(w, s)).toBe('Time ran out.');
    expect(endView(w, s).text).toBe('Time ran out.');
    expect(gmLines(s)).toContain('Time ran out.');
  });

  it('defeat shows deathText when given, else falls back to lossText', () => {
    for (const [deathText, expected] of [['You were defeated.', 'You were defeated.'], [undefined, 'Time ran out.']] as const) {
      const w = losable(deathText);
      const s = structuredClone(newGame(w));
      player(s).hp = 0;
      const r = act(w, s, { type: 'wait' }).state;
      expect(r.status).toBe('lost');
      expect(DEATH_REASON_KEYS.has(r.endReasonKey!)).toBe(true);
      expect(endingText(w, r)).toBe(expected);
      expect(gmLines(r)).toContain(expected);
    }
  });

  it('a fatal resource running out is a condition loss (lossText), and a win shows winText', () => {
    const w = losable('You were defeated.');
    expect(endingText(w, { status: 'lost', endReasonKey: 'end.loss.resource' })).toBe('Time ran out.');
    expect(endingText(w, { status: 'won' })).toBe(w.goal.winText);
    // a save from before endReasonKey existed
    expect(endingText(w, { status: 'lost' })).toBe('Time ran out.');
  });

  it('DEATH_REASON_KEYS are every loss key except the resource one', () => {
    const loss = Object.keys(END_REASON_KEYS).filter((k) => k.startsWith('end.loss.') && k !== 'end.loss.resource');
    expect([...DEATH_REASON_KEYS].sort()).toEqual(loss.sort());
  });

  it('worldWarnings asks for deathText when the world can be lost another way', () => {
    expect(worldWarnings(losable())).toEqual([expect.stringMatching(/goal\.deathText/)]);
    expect(worldWarnings(losable('You were defeated.'))).toEqual([]);
    expect(worldWarnings(testWorld())).toEqual([]);
    const fatal = testWorld((w) => {
      w.resources = [{ id: 'air', name: 'Air', description: 'Breath left.', color: '#88ccff', max: 10, start: 10, perTurn: -1, emptyIsDeath: true }] as never;
    });
    expect(worldWarnings(fatal)).toEqual([expect.stringMatching(/fatal resource/)]);
  });

  it('every demo world that can be lost two ways has a deathText', () => {
    for (const f of readdirSync(WORLD_DIR).filter((x) => x.endsWith('.json'))) {
      const w = parse(read(f.replace(/\.json$/, '')));
      expect(worldWarnings(w), f).toEqual([]);
    }
  });
});

describe('huge xp grants', () => {
  /** fixture-western with a flat xp curve and every perk already taken */
  function flatWorld(): WorldSpec {
    const w = read('fixture-western');
    w.player.growth.curve = 1;
    w.player.growth.firstLevelXp = 5;
    return parse(w);
  }
  function allPerksTaken(world: WorldSpec): GameState {
    const s = structuredClone(createGame(world, { seed: 1 }));
    s.player.perks = world.player.growth.perks.map((p) => p.id);
    return s;
  }

  it('the schema bounds Effect grant_xp (and so the GM "effect" action) at 1000', () => {
    const w = read('fixture-western');
    w.rules[0].playerTriggers = [{ on: 'on_turn', chance: 1, action: { effects: [{ type: 'grant_xp', amount: 1e9 }] } }];
    expect(parseWorld(w).ok).toBe(false);
    w.rules[0].playerTriggers[0].action.effects[0].amount = 1000;
    expect(parseWorld(w).ok).toBe(true);
    expect(GmAction.safeParse({ type: 'effect', target: 'player', effects: [{ type: 'grant_xp', amount: 1_000_000_000 }] }).success).toBe(false);
  });

  it('a 1e9 grant in a flat-curve world does not overflow the stack and gains at most MAX_LEVELS_PER_CHECK levels', () => {
    const world = flatWorld();
    const s = allPerksTaken(world);
    const ctx = ctxFor(world, s);
    expect(() => grantXp(ctx, 1e9)).not.toThrow();
    expect(s.player.level).toBe(1 + MAX_LEVELS_PER_CHECK);
    expect(s.player.pendingPerkChoice).toBeNull();
    // the unspendable rest is dropped: the bar is just short of the next level
    expect(s.player.xp).toBeLessThan(xpToNext(ctx, s.player.level));
    expect(ctx.events.filter((e) => e.type === 'level_up')).toHaveLength(MAX_LEVELS_PER_CHECK);
  });

  it('an unvalidated world (imported / GM-built) with on_turn grant_xp 1e9 plays without throwing', () => {
    const w = read('fixture-western');
    w.player.growth.curve = 1;
    w.player.growth.firstLevelXp = 5;
    w.rules[0].playerTriggers = [{ on: 'on_turn', chance: 1, action: { effects: [{ type: 'grant_xp', amount: 1000 }] } }];
    const world = parse(w);
    // past the schema: what an unchecked world file or a hand-built GM rule could carry
    (world.rules[0].playerTriggers[0].action.effects[0] as { amount: number }).amount = 1e9;
    let s: GameState = createGame(world, { seed: 1 });
    expect(() => {
      for (let i = 0; i < 40 && s.status === 'playing'; i++) {
        const pc = s.player.pendingPerkChoice;
        s = (pc && pc.length ? step(s, { type: 'choose_perk', perkId: pc[0] }, { world }) : step(s, { type: 'wait' }, { world })).state;
      }
    }).not.toThrow();
    expect(Number.isFinite(s.player.level)).toBe(true);
    expect(Number.isFinite(s.player.xp)).toBe(true);
  });

  it('ordinary grants still level up several times in one go and stop at a pending perk choice', () => {
    const world = flatWorld();
    const s = allPerksTaken(world);
    const ctx = ctxFor(world, s);
    grantXp(ctx, 5 * 3 + 2);
    expect(s.player.level).toBe(4);
    expect(s.player.xp).toBe(2);

    const fresh = structuredClone(createGame(world, { seed: 1 }));
    const c2 = ctxFor(world, fresh);
    grantXp(c2, 5 * 3);
    expect(fresh.player.level).toBe(2); // a perk choice is pending: the rest waits for choosePerk
    expect(fresh.player.pendingPerkChoice?.length).toBeGreaterThan(0);
    expect(fresh.player.xp).toBe(10);
  });

  it('non-finite or non-positive amounts are ignored', () => {
    const world = flatWorld();
    const s = allPerksTaken(world);
    const ctx = ctxFor(world, s);
    for (const a of [Number.POSITIVE_INFINITY, Number.NaN, 0, -5]) grantXp(ctx, a);
    expect(s.player.xp).toBe(0);
    expect(s.player.level).toBe(1);
  });
});
