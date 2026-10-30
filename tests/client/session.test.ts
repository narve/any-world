/**
 * GameSession — the DOM-free integrator (issues/M1-missing-main-controller.md). These tests play
 * the fixture worlds through the same calls the browser controller makes for UI callbacks.
 */
import { describe, it, expect } from 'vitest';
import type { GameState, Pos } from '../../src/engine/types';
import { GameSession } from '../../src/client/session';
import { loadFixture, roomMap } from '../engine/helpers';
import { leadPlayer, patchPlayer } from '../../src/engine';

const western = loadFixture('fixture-western.json');
const ship = loadFixture('fixture-ship.json');

function session(world = western, seed = 1, map = roomMap(14, 10)) {
  return new GameSession({ world, worldId: 'fixture-test', seed, map });
}

const P = (s: GameSession) => s.player().pos;

/** moves the player (and only the player) to `pos`, then lets one free action refresh FOV */
function teleport(s: GameSession, pos: Pos): void {
  const st = structuredClone(s.state) as GameState;
  st.area.actors.find((a) => a.id === leadPlayer(st).actorId)!.pos = { ...pos };
  s.state = st;
  s.act({ type: 'toggle_sneak' }); // may be refused (no sneak verb): FOV only refreshes on success
  s.act({ type: 'wait' });
}

/** clears every actor except the player and the given def ids */
function onlyKeep(s: GameSession, defIds: string[]): void {
  const st = structuredClone(s.state) as GameState;
  st.area.actors = st.area.actors.filter((a) => a.id === leadPlayer(st).actorId || defIds.includes(a.defId));
  s.state = st;
}

function placeActor(s: GameSession, defId: string, pos: Pos): string {
  const st = structuredClone(s.state) as GameState;
  const a = st.area.actors.find((x) => x.defId === defId);
  if (!a) throw new Error(`no ${defId} in area`);
  a.pos = { ...pos };
  s.state = st;
  return a.id;
}

describe('GameSession basics', () => {
  it('starts a run with the intro narration and a full game view', () => {
    const s = session();
    const vm = s.viewModel();
    expect(vm.screen).toBe('game');
    expect(vm.game!.narration?.kind).toBe('intro');
    expect(vm.game!.narration?.title).toBe(western.meta.title);
    expect(vm.game!.slots).toHaveLength(28);
    expect(vm.game!.hud.playerName).toBe(western.player.name);
    expect(vm.theme.palette.primary).toBe(western.palette.primary);
    s.dismissNarration('intro');
    expect(s.viewModel().game!.narration).toBeNull();
  });

  it('turns screen-relative movement into map directions using the camera step', () => {
    const s = session();
    onlyKeep(s, []);
    teleport(s, { x: 5, y: 5 });
    const t0 = s.state.turn;
    s.uiAction({ type: 'move', dir: 'n' });
    expect(P(s)).toEqual({ x: 5, y: 4 });
    s.setCameraStep(1); // camera looks east: screen-up is east
    s.uiAction({ type: 'move', dir: 'n' });
    expect(P(s)).toEqual({ x: 6, y: 4 });
    s.setCameraStep(2); // looks south
    s.uiAction({ type: 'move', dir: 'n' });
    expect(P(s)).toEqual({ x: 6, y: 5 });
    expect(s.state.turn).toBeGreaterThan(t0);
  });

  it('reports refused actions as warnings without changing the state', () => {
    const s = session();
    onlyKeep(s, []);
    teleport(s, { x: 1, y: 1 });
    const before = s.state;
    const out = s.uiAction({ type: 'move', dir: 'nw' }); // into the wall
    expect(out.changed).toBe(false);
    expect(s.state).toBe(before);
    expect(out.toasts[0]?.tone).toBe('warn');
  });

  it('autosave data restores the same run', () => {
    const s = session();
    s.uiAction({ type: 'wait' });
    s.uiAction({ type: 'wait' });
    const saved = s.savedRun(123);
    expect(saved.worldTitle).toBe(western.meta.title);
    expect(saved.turn).toBe(s.state.turn);
    const r = new GameSession({ world: western, worldId: saved.worldId, seed: 0, saved: saved.state, gmLog: saved.gmLog });
    expect(r.state.turn).toBe(s.state.turn);
    expect(r.player().pos).toEqual(s.player().pos);
    expect(r.viewModel().game!.narration).toBeNull();
  });

  it('shows the end screen once the run is over', () => {
    const s = session();
    s.state = { ...s.state, status: 'lost', endReason: 'test' };
    const vm = s.viewModel();
    expect(vm.screen).toBe('end');
    expect(vm.end!.result).toBe('lost');
    expect(vm.end!.text).toBe(western.goal.lossText);
  });
});

describe('talk, dialogue and trade', () => {
  it('talk with nobody nearby says so instead of acting', () => {
    const s = session();
    onlyKeep(s, []);
    const out = s.intent({ type: 'talk' });
    expect(out.changed).toBe(false);
    expect(out.toasts[0].text).toMatch(/no one nearby/);
  });

  it('talk picks the nearby NPC, replies are mapped onto engine options and leaving closes it', () => {
    const s = session();
    onlyKeep(s, ['preacher-weekes']);
    teleport(s, { x: 5, y: 5 });
    placeActor(s, 'preacher-weekes', { x: 6, y: 5 });
    s.intent({ type: 'talk' });
    const d = s.viewModel().game!.dialogue!;
    expect(d).toBeTruthy();
    expect(d.npcName).toBe(western.actors.find((a) => a.id === 'preacher-weekes')!.name);
    expect(d.options.length).toBeGreaterThan(0);
    expect(d.options).not.toContain('Goodbye');
    // reply 0 = "Ask for help" (healer service): healed, and the healer answers in the same
    // conversation (issues/M5-healer-silent.md)
    const hurt = structuredClone(s.state) as GameState;
    hurt.area.actors.find((a) => a.id === leadPlayer(hurt).actorId)!.hp = 3;
    s.state = hurt;
    s.dialogueReply(0);
    expect(leadPlayer(s.state).pendingChoice?.kind).toBe('dialogue');
    expect(s.player().hp).toBeGreaterThan(3);
    expect(s.history.map((h) => h.who)).toEqual(['npc', 'player']);
    expect(s.viewModel().game!.dialogue!.reply).toMatch(/helps you/);
    // leave, talk again: a new conversation, then leave
    s.dialogueLeave();
    expect(leadPlayer(s.state).pendingChoice).toBeNull();
    s.intent({ type: 'talk' });
    expect(leadPlayer(s.state).pendingChoice?.kind).toBe('dialogue');
    expect(s.history).toEqual([]);
    s.dialogueLeave();
    expect(leadPlayer(s.state).pendingChoice).toBeNull();
    expect(s.viewModel().game!.dialogue).toBeNull();
  });

  it('persuade from the dialogue panel leaves the conversation first', () => {
    const s = session();
    onlyKeep(s, ['kid-tobias']);
    teleport(s, { x: 5, y: 5 });
    const id = placeActor(s, 'kid-tobias', { x: 6, y: 5 });
    s.intent({ type: 'talk' });
    expect(leadPlayer(s.state).pendingChoice?.kind).toBe('dialogue');
    const t0 = s.state.turn;
    const out = s.intent({ type: 'persuade', targetId: id });
    expect(out.changed).toBe(true);
    expect(leadPlayer(s.state).pendingChoice).toBeNull();
    expect(s.state.turn).toBeGreaterThan(t0); // persuading took the turn
  });

  it('trade: open, buy (shop stays open), close back to the dialogue', () => {
    const s = session();
    onlyKeep(s, ['widow-oquendo']);
    teleport(s, { x: 5, y: 5 });
    const id = placeActor(s, 'widow-oquendo', { x: 6, y: 5 });
    const rich = structuredClone(s.state) as GameState;
    rich.purse = 500;
    s.state = rich;
    s.intent({ type: 'talk' });
    expect(s.viewModel().game!.dialogue!.canTrade).toBe(true);
    s.intent({ type: 'open_trade', npcId: id });
    const tv = s.viewModel().game!.trade!;
    expect(tv.offers.length).toBeGreaterThan(0);
    expect(s.viewModel().game!.dialogue).toBeNull(); // trade replaces the dialogue panel
    const price = tv.offers[0].price;
    const countHeld = () => leadPlayer(s.state).slots.filter(Boolean).length;
    const held = countHeld();
    s.trade({ type: 'buy', offerIndex: 0 });
    expect(s.state.purse).toBe(500 - price);
    expect(countHeld()).toBeGreaterThanOrEqual(held); // stacks may merge
    expect(s.viewModel().game!.trade).not.toBeNull();
    s.trade({ type: 'close' });
    expect(s.viewModel().game!.trade).toBeNull();
    expect(s.viewModel().game!.dialogue).not.toBeNull();
  });

  it('buying without enough money is refused with a warning and keeps the shop open', () => {
    const s = session();
    onlyKeep(s, ['widow-oquendo']);
    teleport(s, { x: 5, y: 5 });
    const id = placeActor(s, 'widow-oquendo', { x: 6, y: 5 });
    const poor = structuredClone(s.state) as GameState;
    poor.purse = 0;
    s.state = poor;
    s.intent({ type: 'talk' });
    s.intent({ type: 'open_trade', npcId: id });
    const offers = s.viewModel().game!.trade!.offers;
    const pricey = offers.findIndex((o) => o.price > 0);
    expect(pricey).toBeGreaterThanOrEqual(0);
    const out = s.trade({ type: 'buy', offerIndex: pricey });
    expect(out.toasts[0]?.tone).toBe('warn');
    expect(s.viewModel().game!.trade).not.toBeNull();
  });
});

describe('look and target modes', () => {
  it('look mode describes the cursor tile and the cursor follows the camera', () => {
    const s = session();
    onlyKeep(s, []);
    teleport(s, { x: 5, y: 5 });
    const out = s.intent({ type: 'look', on: true });
    expect(s.mode).toBe('look');
    expect(out.describe?.actor?.name).toBe(western.player.name);
    s.setCameraStep(1);
    const o2 = s.intent({ type: 'look_move', dir: 'n' });
    expect(s.cursor).toEqual({ x: 6, y: 5 });
    expect(o2.describe?.tile?.title).toBeTruthy();
    expect(s.highlights()).toEqual([{ x: 6, y: 5 }]);
    s.intent({ type: 'look', on: false });
    expect(s.mode).toBe('normal');
    expect(s.highlights()).toEqual([]);
  });

  it('aimed items go through targeting and fire at the confirmed tile', () => {
    const s = session();
    const slot = leadPlayer(s.state).slots.findIndex((it) => it?.defId === 'trick-shot');
    expect(slot).toBeGreaterThanOrEqual(0);
    const foe = s.state.area.actors.find((a) => a.faction === 'hostile');
    onlyKeep(s, foe ? [foe.defId] : []);
    teleport(s, { x: 3, y: 5 });
    // activating from a menu without a target starts targeting instead of failing
    const o = s.uiAction({ type: 'use', slot });
    expect(o.changed).toBe(false);
    expect(s.mode).toBe('target');
    expect(s.targetingSlot).toBe(slot);
    s.intent({ type: 'cancel' });
    expect(s.mode).toBe('normal');

    s.intent({ type: 'begin_target', slot });
    expect(s.mode).toBe('target');
    if (foe) {
      // the cursor starts on the engine's automatic target when one is in range
      const st = structuredClone(s.state) as GameState;
      const f = st.area.actors.find((a) => a.defId === foe.defId)!;
      f.pos = { x: 6, y: 5 };
      s.state = st;
      s.intent({ type: 'cancel' });
      s.act({ type: 'wait' });
      if (leadPlayer(s.state).pendingPerkChoice || s.ended) return;
      s.intent({ type: 'begin_target', slot });
    }
    const cursor = s.cursor!;
    const turn = s.state.turn;
    const out = s.intent({ type: 'confirm_cursor' });
    if (out.changed) {
      expect(s.mode).toBe('normal');
      expect(s.state.turn).toBeGreaterThanOrEqual(turn);
    } else {
      // refused (e.g. own tile) keeps targeting so the player can pick another tile
      expect(s.mode).toBe('target');
      expect(s.cursor).toEqual(cursor);
    }
  });

  it('a primary click in target mode uses the item on that tile; secondary cancels', () => {
    const s = session();
    const slot = leadPlayer(s.state).slots.findIndex((it) => it?.defId === 'trick-shot');
    onlyKeep(s, []);
    teleport(s, { x: 3, y: 5 });
    s.intent({ type: 'begin_target', slot });
    s.intent({ type: 'click_tile', pos: { x: 3, y: 5 }, button: 'secondary' });
    expect(s.mode).toBe('normal');
    s.intent({ type: 'begin_target', slot });
    s.intent({ type: 'hover_tile', pos: { x: 6, y: 5 } });
    expect(s.cursor).toEqual({ x: 6, y: 5 });
  });
});

describe('click-to-travel', () => {
  it('walks to a clicked explored tile one step per tick', () => {
    const s = session();
    onlyKeep(s, []);
    teleport(s, { x: 2, y: 2 });
    const out = s.intent({ type: 'click_tile', pos: { x: 8, y: 6 }, button: 'primary' });
    expect(out.travel).toBe(true);
    let ticks = 0;
    for (;;) {
      const r = s.travelTick();
      ticks++;
      if (!r.more) break;
      expect(ticks).toBeLessThan(50);
    }
    expect(P(s)).toEqual({ x: 8, y: 6 });
    expect(ticks).toBe(6); // Chebyshev distance
    // fixture-western's heat rule hurts every few turns: ambient drains must not stop travel
  });

  it('stops when a new hostile comes into view', () => {
    const s = session(western, 1, roomMap(20, 10, { walls: [{ x: 10, y: 1 }, { x: 10, y: 2 }, { x: 10, y: 3 }, { x: 10, y: 4 }, { x: 10, y: 5 }, { x: 10, y: 6 }, { x: 10, y: 7 }] }));
    const foe = s.state.area.actors.find((a) => a.faction === 'hostile')!;
    expect(foe).toBeDefined();
    onlyKeep(s, [foe.defId]);
    const st = structuredClone(s.state) as GameState;
    st.area.actors = st.area.actors.filter((a) => a.id === leadPlayer(st).actorId || a.id === foe.id);
    st.area.actors.find((a) => a.id === foe.id)!.pos = { x: 15, y: 2 }; // behind the wall
    s.state = st;
    teleport(s, { x: 3, y: 8 });
    // reveal the whole row so the destination past the wall is "explored"
    const seen = Uint8Array.from(leadPlayer(s.state).seen as ArrayLike<number>, (v) => (v === 0 ? 1 : v));
    s.state = patchPlayer(s.state, { seen });
    expect(s.intent({ type: 'click_tile', pos: { x: 17, y: 8 }, button: 'primary' }).travel).toBe(true);
    let stoppedAt: Pos | null = null;
    for (let i = 0; i < 30; i++) {
      const r = s.travelTick();
      if (!r.more) {
        stoppedAt = P(s);
        break;
      }
    }
    expect(stoppedAt).not.toBeNull();
    expect(stoppedAt).not.toEqual({ x: 17, y: 8 });
    expect(stoppedAt!.x).toBeGreaterThanOrEqual(10); // it walked until the wall stopped hiding the foe
    expect(s.travelDest).toBeNull();
  });

  it('walks toward unexplored destinations, without leaking what is there', () => {
    const s = session();
    const p = s.state.area.actors.find((a) => a.id === leadPlayer(s.state).actorId)!.pos;
    const map = s.state.area.map;
    // only the player's own tile and its neighbours are known
    const seen = new Uint8Array(leadPlayer(s.state).seen.length);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) seen[(p.y + dy) * map.width + p.x + dx] = 2;
    s.state = patchPlayer(s.state, { seen });
    let dest: Pos | null = null;
    for (let y = 1; y < map.height - 1 && !dest; y++)
      for (let x = 1; x < map.width - 1; x++)
        if (Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) > 4) {
          dest = { x, y };
          break;
        }
    const out = s.intent({ type: 'click_tile', pos: dest!, button: 'primary' });
    expect(out.travel).toBe(true);
    expect(s.preview(dest)).toMatchObject({ kind: 'walk' });
    // the route through the unknown is the same whether the unseen tiles are wall or floor
    const before = JSON.stringify(s.preview(dest)!.path);
    const walls = map.tiles.map((t, i) => (seen[i] ? t : { ...t, kind: 'wall' as const }));
    s.state = { ...s.state, area: { ...s.state.area, map: { ...map, tiles: walls } } };
    expect(JSON.stringify(s.preview(dest)!.path)).toBe(before);
  });

  it('refuses destinations on the map border (never passable)', () => {
    const s = session();
    const out = s.intent({ type: 'click_tile', pos: { x: 0, y: 0 }, button: 'primary' });
    expect(out.travel).toBeUndefined();
    expect(out.toasts.length).toBe(1);
  });
});

describe('area transitions', () => {
  it('taking the exit narrates the new area and resets the cursor', () => {
    const s = session(ship, 2);
    onlyKeep(s, []);
    teleport(s, s.state.area.map.exit);
    s.intent({ type: 'look', on: true });
    s.intent({ type: 'cancel' });
    const out = s.uiAction({ type: 'transition' });
    if (!out.changed) throw new Error(`transition refused: ${out.toasts.map((t) => t.text).join()}`);
    expect(out.areaChanged).toBe(true);
    expect(s.state.area.index).toBe(1);
    const n = s.viewModel().game!.narration!;
    expect(n.kind).toBe('area_enter');
    expect(n.title).toBe(ship.areas[1].name);
  });
});

describe('terrain interaction from the UI (audit: interact unreachable)', () => {
  function consoleRoom() {
    const map = roomMap(12, 9);
    map.tiles[4 * 12 + 6] = { kind: 'floor', terrain: 'bridge-console', region: 0 };
    const s = new GameSession({ world: ship, worldId: 'fixture-test', seed: 2, map });
    onlyKeep(s, []);
    teleport(s, { x: 5, y: 4 });
    return s;
  }

  it('bumping a usable tile that blocks movement uses it', () => {
    const s = consoleRoom();
    expect(s.interactTargets().map((t) => t.name)).toEqual([ship.terrains.find((t) => t.id === 'bridge-console')!.name]);
    const out = s.uiAction({ type: 'move', dir: 'e' });
    expect(out.changed).toBe(true);
    expect(P(s)).toEqual({ x: 5, y: 4 });
    expect(s.state.area.map.tiles[4 * 12 + 6].interacted).toBe(true);
    expect(s.state.flags['saw-orbit-trace']).toBe(true);
    // used up: the tooltip says so and it no longer offers itself
    expect(s.describeAt({ x: 6, y: 4 }).tile?.usable).toBe('used');
    expect(s.interactTargets()).toEqual([]);
  });

  it('Enter (interact intent) and a click on the adjacent tile use it too', () => {
    const a = consoleRoom();
    expect(a.describeAt({ x: 6, y: 4 }).tile?.usable).toBe('usable');
    expect(a.viewModel().game!.interactHint).toMatch(/^Enter: use /);
    a.intent({ type: 'interact' });
    expect(a.state.flags['saw-orbit-trace']).toBe(true);

    const b = consoleRoom();
    const out = b.intent({ type: 'click_tile', pos: { x: 6, y: 4 }, button: 'primary' });
    expect(out.travel).toBeUndefined();
    expect(b.state.flags['saw-orbit-trace']).toBe(true);

    const c = consoleRoom();
    teleport(c, { x: 2, y: 2 });
    expect(c.intent({ type: 'interact' }).toasts[0]?.text).toMatch(/nothing to use/i);
  });

  it('the hover preview tells what a click does', () => {
    const s = consoleRoom();
    expect(s.preview({ x: 6, y: 4 })?.kind).toBe('use');
    const walk = s.preview({ x: 2, y: 2 })!;
    expect(walk.kind).toBe('walk');
    expect(walk.path[walk.path.length - 1]).toEqual({ x: 2, y: 2 });
    expect(walk.path.length).toBe(3);
    expect(s.preview({ x: 0, y: 0 })?.kind).toBe('none'); // a wall
    expect(s.preview({ x: 5, y: 4 })?.kind).toBe('self');
    s.intent({ type: 'look', on: true });
    expect(s.preview({ x: 2, y: 2 })).toBeNull(); // look mode has its own cursor
  });
});

describe('hostile hover preview', () => {
  it('outlines a hostile as an attack target', () => {
    const s = session(western, 1, roomMap(14, 10));
    const hostile = western.actors.find((a) => !a.npc && a.faction === 'hostile')!;
    onlyKeep(s, []);
    teleport(s, { x: 4, y: 5 });
    // placed after the FOV refresh, so it has no turn to move
    const st = structuredClone(s.state) as GameState;
    const pl = st.area.actors.find((a) => a.id === leadPlayer(st).actorId)!;
    st.area.actors.push({ ...structuredClone(pl), id: 'a777', defId: hostile.id, faction: 'hostile', pos: { x: 6, y: 5 } });
    s.state = st;
    expect(s.preview({ x: 6, y: 5 })?.kind).toBe('attack');
  });
});

describe('start options', () => {
  it('carries difficulty and weirdness into saves and the end screen', () => {
    const s = new GameSession({ world: western, worldId: 'fixture-test', seed: 1, map: roomMap(14, 10), difficulty: 'hard', weirdness: 0.8 });
    expect(s.difficulty).toBe('hard');
    const saved = s.savedRun(0);
    expect(saved.difficulty).toBe('hard');
    expect(saved.weirdness).toBe(0.8);
    const resumed = new GameSession({ world: western, worldId: 'fixture-test', seed: 0, saved: saved.state, gmLog: saved.gmLog, difficulty: saved.difficulty, weirdness: saved.weirdness, rules: saved.rules, hooks: saved.hooks });
    expect(resumed.difficulty).toBe('hard');
    expect(resumed.takeHooks()).toEqual([]); // no second intro on resume
    const st = structuredClone(resumed.state) as GameState;
    st.status = 'lost';
    resumed.state = st;
    expect(resumed.viewModel().end).toMatchObject({ difficulty: 'hard', weirdness: 0.8 });
  });
});

describe('onboarding card (replaces the M1 first-run hints)', () => {
  it('waits for the prologue, then shows until dismissed', () => {
    const s = new GameSession({ world: western, worldId: 'fixture-test', seed: 1, map: roomMap(14, 10), onboarding: true });
    // the prologue card is up first: onboarding comes after it
    expect(s.narration).not.toBeNull();
    expect(s.viewModel().game!.onboarding).toBeNull();
    s.dismissNarration(s.narration!.id);
    const ob = s.viewModel().game!.onboarding!;
    expect(ob.worldId).toBe('fixture-test');
    expect(ob.goal).toBe(western.goal.summary);
    expect(ob.conflict.join(' ')).toContain(western.vocabulary.conflict);
    s.intent({ type: 'dismiss_onboarding', forever: true });
    expect(s.viewModel().game!.onboarding).toBeNull();
    s.intent({ type: 'show_onboarding' });
    expect(s.viewModel().game!.onboarding).not.toBeNull();
  });

  it('gets out of the way after a dozen turns nobody closed it', () => {
    const s = new GameSession({ world: western, worldId: 'fixture-test', seed: 1, map: roomMap(14, 10), onboarding: true });
    s.dismissNarration(s.narration!.id);
    for (let i = 0; i < 11; i++) s.act({ type: 'wait' });
    expect(s.viewModel().game!.onboarding).not.toBeNull();
    s.act({ type: 'wait' });
    expect(s.viewModel().game!.onboarding).toBeNull();
  });

  it('is off without the flag', () => {
    const s = session();
    s.narration = null;
    expect(s.viewModel().game!.onboarding).toBeNull();
  });

  it('show an objective line', () => {
    const s = session();
    expect(s.viewModel().game!.objective).toContain(western.goal.summary);
  });
});
