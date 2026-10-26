/** GM context summary (engine/gm-context.ts): content, knowledge, budget, purity. */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { WORLD_DIR, loadFixture, testWorld, newGame, addActor, player, act } from './helpers';
import { createGame, step, serialize, applyGmActions, leadPlayer } from '../../src/engine';
import { buildGmContext, estimateTokens, GM_CONTEXT_MAX_TOKENS } from '../../src/engine/gm-context';
import { botByName, newMemory } from '../../src/engine/sim/bots';
import type { GameState } from '../../src/engine/types';

const files = readdirSync(WORLD_DIR).filter((f) => f.startsWith('fixture-') && f.endsWith('.json')).sort();

describe('buildGmContext', () => {
  it('summarises the player, area, rules, difficulty and language of a new run', () => {
    const w = testWorld();
    const s = newGame(w);
    const c = buildGmContext(s, w, 'intro');
    expect(c.v).toBe(1);
    expect(c.hook).toBe('intro');
    expect(c.language).toBe('en');
    expect(c.difficulty).toBe('normal');
    expect(c.world).toEqual({ title: 'Test World', genre: 'test', tone: 'dry', goal: 'Defeat the boss' });
    expect(c.player).toMatchObject({ name: 'Tess', level: 1, hp: 30, maxHp: 30, currency: 0, stats: { str: 12, dex: 12, int: 12, ac: 10 } });
    expect(c.player.resources).toEqual(['Oil 10/20']);
    expect(c.player.inventory).toEqual([
      { id: 'stick', name: 'Stick', eq: 'weapon' },
      { id: 'tonic', name: 'Tonic', n: 2 },
    ]);
    expect(c.area).toMatchObject({ index: 0, count: 2, name: 'First', exitLocked: true });
    expect(c.gm).toMatchObject({ budget: 10, canAddRule: true, rulesActive: 0, rulesMax: 5, ruleHarmLeft: 10 });
    // the goal names the boss and a flag: progress shows where they stand; the lock names the key
    expect(c.progress.flags).toEqual({ 'boss-down': false });
    expect(c.progress.items).toEqual({ key: false });
    expect(estimateTokens(c)).toBeLessThan(GM_CONTEXT_MAX_TOKENS);
  });

  it('respects item knowledge: unknown items appear under their appearance, never their name', () => {
    const w = testWorld((x) => {
      x.player.startingItems.push({ item: 'murk', count: 1 });
    });
    const s = newGame(w);
    const c = buildGmContext(s, w);
    const murk = c.player.inventory.find((i) => i.id === 'murk')!;
    expect(murk.known).toBe('unknown');
    expect(murk.name).toBe(leadPlayer(s).knowledge.murk.appearance!.label);
    expect(JSON.stringify(c)).not.toContain('Murky Draught');
  });

  it('lists only actors the player can see, nearest first, with handles and threat', () => {
    const w = testWorld();
    const s = newGame(w);
    addActor(w, s, 'rat', { x: 3, y: 1 });
    addActor(w, s, 'sage', { x: 2, y: 2 });
    // a refreshed view (FOV) after the surgery
    const s2 = act(w, s, { type: 'wait' }).state;
    const c = buildGmContext(s2, w, { hook: 'boss_seen', detail: { actorId: 'a2', note: 'x'.repeat(200), bad: { nested: true } } });
    expect(c.visible.map((a) => a.def)).toEqual(expect.arrayContaining(['rat', 'sage']));
    const sage = c.visible.find((a) => a.def === 'sage')!;
    expect(sage).toMatchObject({ name: 'Sage', faction: 'friendly', npc: 'healer', hp: 100 });
    expect(c.visible[0].dist).toBeLessThanOrEqual(c.visible[c.visible.length - 1].dist);
    expect(c.detail!.actorId).toBe('a2');
    expect(String(c.detail!.note).length).toBeLessThanOrEqual(80);
    expect('bad' in c.detail!).toBe(false);
    // an actor behind a wall is not listed
    const hidden = newGame(w, 1);
    for (let y = 0; y < hidden.area.map.height; y++) hidden.area.map.tiles[y * hidden.area.map.width + 5] = { kind: 'wall' };
    addActor(w, hidden, 'rat', { x: 8, y: 5 });
    const h2 = act(w, hidden, { type: 'wait' }).state;
    expect(buildGmContext(h2, w).visible.some((a) => a.def === 'rat')).toBe(false);
  });

  it('reports the log tail, rules, quests, budget spent and an open choice', () => {
    const w = testWorld();
    let s = newGame(w);
    s = applyGmActions(s, [
      { type: 'narrate', text: 'The lights flicker.' },
      { type: 'start_quest', id: 'q1', title: 'Find the key', description: 'd', complete: { type: 'has_item', who: 'player', item: 'key' }, reward: [] },
      { type: 'offer_choice', prompt: 'A deal?', options: [{ label: 'Yes', actions: [{ type: 'grant_xp', amount: 5 }] }] },
    ], { world: w }).state;
    const c = buildGmContext(s, w, 'idle');
    expect(c.log).toContain('The lights flicker.');
    expect(c.quests).toEqual([{ id: 'q1', title: 'Find the key', status: 'active' }]);
    expect(c.gm.budget).toBeLessThan(10);
    expect(c.gm.choiceOpen).toBe(true);
    expect(c.log.length).toBeLessThanOrEqual(8);
  });

  it('never changes its input', () => {
    const w = testWorld();
    const s = newGame(w);
    addActor(w, s, 'rat', { x: 3, y: 1 });
    const before = serialize(s);
    const snap = structuredClone(s);
    buildGmContext(s, w, 'low_hp');
    expect(serialize(s)).toBe(before);
    expect(s).toEqual(snap);
  });

  it('stays within ~1.5k tokens on long fixture runs, and a tighter budget trims the least important parts', () => {
    let maxTokens = 0;
    for (const f of files) {
      const world = loadFixture(f);
      for (const seed of [1, 2]) {
        let s: GameState = createGame(world, { seed });
        const bot = botByName('explorer');
        const mem = newMemory(seed);
        for (let i = 0; i < 500 && s.status === 'playing'; i++) {
          s = step(s, bot.decide(s, world, mem), { world }).state;
          if (i % 25 === 0) {
            const c = buildGmContext(s, world, 'idle');
            const t = estimateTokens(c);
            maxTokens = Math.max(maxTokens, t);
            expect(t).toBeLessThanOrEqual(GM_CONTEXT_MAX_TOKENS);
            expect(c.language).toBe(world.meta.language);
            expect(c.area.index).toBe(s.area.index);
            const small = buildGmContext(s, world, 'idle', { maxTokens: 400 });
            expect(estimateTokens(small)).toBeLessThanOrEqual(400);
            expect(small.player.name).toBe(world.player.name);
          }
        }
      }
    }
    expect(maxTokens).toBeGreaterThan(150);
  }, 60_000);

  it('knows a language other than English and a harder difficulty', () => {
    const w = testWorld((x) => {
      (x.meta as { language?: string }).language = 'nb';
    });
    const s = createGame(w, { seed: 2, difficulty: 'brutal', map: newGame(w).area.map });
    const c = buildGmContext(s, w);
    expect(c.language).toBe('nb');
    expect(c.difficulty).toBe('brutal');
    expect(c.gm.ruleHarmLeft).toBe(35);
    expect(player(s).hp).toBe(c.player.hp);
  });
});
