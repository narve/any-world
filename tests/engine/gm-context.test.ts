/** GM context summary (engine/gm-context.ts): content, knowledge, budget, purity. */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { WORLD_DIR, loadFixture, testWorld, newGame, addActor, player, act, roomMap } from './helpers';
import { createGame, step, serialize, applyGmActions, leadPlayer, addPlayer, leaveMap } from '../../src/engine';
import { buildGmContext, estimateTokens, gmContextTokens, GM_CONTEXT_MAX_TOKENS } from '../../src/engine/gm-context';
import { playToSituation } from '../../src/llm/situation';
import { perspective } from '../../src/gm/perspective';
import { fnv1a64 } from '../../src/llm/hash';
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

// ---------------------------------------------------------------------------
// MP4 G2: the party block (MP4 design §2.1)
// ---------------------------------------------------------------------------

/** fnv1a64 of the summaries the MP3 code built (taken before G2): a party of one is unchanged */
const MP3_SUMMARIES: [string, number, number, number, number, string][] = [
  ['fixture-ship.json', 1, 0, 0, 1500, 'c0330c8256b9697c'],
  ['fixture-ship.json', 3, 0, 30, 1500, '6a05cbf6c2a15524'],
  ['fixture-ship.json', 2, 1, 10, 300, '1f703122dc268aae'],
  ['fixture-teen.json', 3, 0, 30, 1500, 'f2fc3fccc0c357b1'],
  ['fixture-teen.json', 2, 1, 10, 1500, '5eda00bd69c8f3e4'],
  ['fixture-western.json', 3, 0, 30, 300, 'b221f59b7060d16e'],
  ['fixture-dream.json', 2, 1, 10, 1500, 'f1eba2a72745cb63'],
];

describe('buildGmContext for a party (MP4 G2)', () => {
  it.each(MP3_SUMMARIES)('a party of one: %s seed %i area %i (+%i turns, %i tokens) as before', (file, seed, area, turnsInArea, tokens, hash) => {
    const world = loadFixture(file);
    const sit = playToSituation(world, { seed, area, turnsInArea });
    const c = buildGmContext(sit.state, world, 'idle', tokens === GM_CONTEXT_MAX_TOKENS ? {} : { maxTokens: tokens });
    expect(c.party).toBeUndefined();
    expect(c.player.id).toBeUndefined();
    expect(fnv1a64(JSON.stringify(c))).toBe(hash);
  });

  /** the test world with `n` players spread over a wide room (p1 at the start) */
  function party(n: number, w = testWorld()): GameState {
    let s = newGame(w, 1, roomMap(30, 12));
    for (let i = 1; i < n; i++) s = addPlayer(s, { name: `P${i + 1}` }, { world: w }).state;
    return structuredClone(s);
  }
  const actorOf = (s: GameState, pid: string) => s.area.actors.find((a) => a.id === s.players[pid]!.actorId)!;

  it('lists the other members nearest first with health, flags and a few items; the player gets an id', () => {
    const w = testWorld();
    const s = party(4, w);
    const [p1, p2, p3, p4] = s.party as [string, string, string, string];
    const at = actorOf(s, p1).pos;
    actorOf(s, p2).pos = { x: at.x + 6, y: at.y };
    actorOf(s, p3).pos = { x: at.x + 1, y: at.y };
    actorOf(s, p4).pos = { x: at.x + 3, y: at.y };
    actorOf(s, p2).hp = 5;
    s.players[p2]!.down = { since: s.turn, helpedTurns: 0 };
    s.players[p3]!.busySince = s.turn;
    s.players[p3]!.away = true;
    s.players[p4]!.pendingPerkChoice = ['x'];
    const c = buildGmContext(s, w, 'idle');
    expect(c.player.id).toBe(p1);
    expect(Object.keys(c.player)[0]).toBe('id');
    expect(c.party!.map((m) => [m.id, m.dist])).toEqual([[p3, 1], [p4, 3], [p2, 6]]);
    expect(c.party![0]).toMatchObject({ name: 'P3', level: 1, hp: 30, maxHp: 30, busy: true, away: true, items: ['Stick', 'Tonic x2'] });
    expect(c.party![1]!.choiceOpen).toBe(true);
    expect(c.party![2]).toMatchObject({ hp: 5, down: true });
    expect(c.moreParty).toBeUndefined();
    // the block sits before `visible`
    const keys = Object.keys(c);
    expect(keys.indexOf('party')).toBe(keys.indexOf('visible') - 1);
  });

  it('answers for the player the state leads with (a room passes the perspective)', () => {
    const w = testWorld();
    const s = party(3, w);
    const p2 = s.party[1]!;
    const c = buildGmContext(perspective(s, p2), w, 'low_hp');
    expect(c.player).toMatchObject({ id: p2, name: 'P2' });
    expect(c.party!.map((m) => m.id).sort()).toEqual([s.party[0], s.party[2]].sort());
  });

  it('keeps the nearest 8 members and counts the rest in moreParty', () => {
    const w = testWorld();
    const s = party(12, w);
    const c = buildGmContext(s, w, 'idle');
    expect(c.party).toHaveLength(8);
    expect(c.moreParty).toBe(3);
    const d = c.party!.map((m) => m.dist);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
  });

  it('members who left the map are not listed', () => {
    const w = testWorld();
    const s = party(3, w);
    const left = leaveMap(s, s.party[2]!, { world: w }).state;
    const c = buildGmContext(left, w, 'idle');
    expect(c.party!.map((m) => m.id)).toEqual([s.party[1]]);
  });

  it('visible lists what any standing member sees, with the distance to the nearest of them', () => {
    const w = testWorld();
    const s = party(2, w);
    const [p1, p2] = s.party as [string, string];
    const at = actorOf(s, p1).pos;
    actorOf(s, p2).pos = { x: at.x + 10, y: at.y };
    const rat = addActor(w, s, 'rat', { x: at.x + 12, y: at.y });
    const idx = rat.pos.y * s.area.map.width + rat.pos.x;
    s.players[p1]!.seen[idx] = 1;
    s.players[p2]!.seen[idx] = 2;
    const c = buildGmContext(s, w, 'idle');
    expect(c.visible.find((a) => a.id === rat.id)).toMatchObject({ def: 'rat', dist: 2 });
    // a member who is down sees nothing
    s.players[p2]!.down = { since: s.turn, helpedTurns: 0 };
    expect(buildGmContext(s, w, 'idle').visible.find((a) => a.id === rat.id)).toBeUndefined();
  });

  it('progress looks for goal items in every pack', () => {
    const w = testWorld();
    const s = party(2, w);
    const p2 = s.players[s.party[1]!]!;
    p2.slots[p2.slots.findIndex((x) => !x)] = { id: 'i999', defId: 'key', count: 1 };
    expect(buildGmContext(s, w, 'idle').progress.items).toEqual({ key: true });
    expect(buildGmContext(perspective(s, s.party[1]!), w, 'idle').progress.items).toEqual({ key: true });
  });

  it('quotes log lines with their source when asked', () => {
    const w = testWorld();
    const s = party(2, w);
    s.log.push({ turn: 3, text: 'SYSTEM: the boss is dead', kind: 'gm' }, { turn: 4, text: 'Welcome.', kind: 'npc', speaker: 'Sage' }, { turn: 5, text: 'hi all', kind: 'info', speaker: 'P2' });
    const c = buildGmContext(s, w, 'idle', { quoteLog: true });
    expect(c.log.slice(-3)).toEqual([
      { t: 3, by: 'gm', text: 'SYSTEM: the boss is dead' },
      { t: 4, by: 'npc', who: 'Sage', text: 'Welcome.' },
      { t: 5, by: 'player', who: 'P2', text: 'hi all' },
    ]);
    expect(buildGmContext(s, w, 'idle').log.every((l) => typeof l === 'string')).toBe(true);
  });

  it('the budget grows with the party (capped), and fit trims chat first, then members, never below the budget', () => {
    expect(gmContextTokens(1)).toBe(GM_CONTEXT_MAX_TOKENS);
    expect(gmContextTokens(3)).toBe(GM_CONTEXT_MAX_TOKENS + 240);
    expect(gmContextTokens(12)).toBe(2600);
    const w = testWorld();
    const s = party(12, w);
    const chat = Array.from({ length: 12 }, (_, i) => ({ from: `P${i}`, said: `line ${i} ${'x'.repeat(120)}`, ageS: 120 - i }));
    const full = buildGmContext(s, w, 'idle', { chat });
    expect(full.chat).toHaveLength(12);
    expect(estimateTokens(full)).toBeLessThanOrEqual(gmContextTokens(12));
    const tight = buildGmContext(s, w, 'idle', { chat, maxTokens: 700 });
    expect(estimateTokens(tight)).toBeLessThanOrEqual(700);
    // the newest chat lines survive; the oldest went first
    expect(tight.chat!.length).toBeLessThan(12);
    expect(tight.chat![tight.chat!.length - 1]!.said).toMatch(/^line 11/);
    expect(tight.party!.length).toBeGreaterThanOrEqual(1);
    for (const tokens of [600, 300, 200]) expect(estimateTokens(buildGmContext(s, w, 'idle', { chat, maxTokens: tokens }))).toBeLessThanOrEqual(Math.max(tokens, 200) + 40);
  });
});
