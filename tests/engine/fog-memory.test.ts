/**
 * Fog as memory, not blindness (docs/playtest/FABLE-GAMEPLAY-REVIEW.md §4): the player sees at
 * least 10 tiles, remembers the layout of the room they step into without seeing who is in it,
 * and GM spawns appear where the player can see them.
 */
import { describe, it, expect } from 'vitest';
import { testWorld, newGame, player, addActor, ctxFor, act, roomMap } from './helpers';
import { applyGmActions, leadPlayer } from '../../src/engine';
import { playerBaseSight, sightRadius } from '../../src/engine/stats';
import { ROOM_MEMORY_MAX_TILES, playerSeesTile, updateFov } from '../../src/engine/vision';
import type { AreaMap, Tile } from '../../src/engine/types';

/**
 * 24×12: room 0 (x 1–11) with a wall stub at x 6 (y 1–8) hiding its north-east part from the
 * start, a wall at x 12 with a door at y 10, room 1 (x 13–22).
 */
function twoRooms(): AreaMap {
  const w = 24;
  const h = 12;
  const tiles: Tile[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (border || x === 12 || (x === 6 && y <= 8)) tiles.push({ kind: 'wall' });
      else tiles.push({ kind: 'floor', region: x < 12 ? 0 : 1 });
    }
  tiles[10 * w + 12] = { kind: 'door' };
  const start = { x: 2, y: 2 };
  const exit = { x: 21, y: 9 };
  tiles[start.y * w + start.x] = { kind: 'start', region: 0 };
  tiles[exit.y * w + exit.x] = { kind: 'transition', region: 1 };
  return {
    width: w,
    height: h,
    tiles,
    start,
    exit,
    regions: [
      { id: 0, name: 'West room', centre: { x: 6, y: 5 }, size: 90 },
      { id: 1, name: 'East room', centre: { x: 17, y: 5 }, size: 100 },
    ],
  };
}

describe('fog as memory', () => {
  it('the player sees at least 10 tiles (world sight + 3, at most 15); hostiles keep theirs', () => {
    expect(playerBaseSight(7)).toBe(10);
    expect(playerBaseSight(9)).toBe(12);
    expect(playerBaseSight(2)).toBe(10);
    expect(playerBaseSight(14)).toBe(15);
    const w = testWorld();
    const s = newGame(w, 1, twoRooms());
    player(s).base.sight = 8;
    const ctx = ctxFor(w, s);
    expect(sightRadius(ctx, player(s))).toBe(11);
    const rat = addActor(w, s, 'rat', { x: 3, y: 9 }, { base: { str: 6, dex: 10, int: 10, ac: 8, speed: 100, sight: 5 } });
    expect(sightRadius(ctx, rat)).toBe(5);
  });

  it('stepping into a room remembers its layout (walls included) but shows nobody in it', () => {
    const w = testWorld();
    const s = newGame(w, 1, twoRooms());
    const map = s.area.map;
    const hidden = { x: 9, y: 2 };
    const rat = addActor(w, s, 'rat', hidden, {});
    const ctx = ctxFor(w, s);
    updateFov(ctx);
    const at = (x: number, y: number) => leadPlayer(s).seen[y * map.width + x];
    // behind the wall stub: not in view, but remembered as part of the room
    expect(playerSeesTile(ctx, hidden)).toBe(false);
    expect(at(hidden.x, hidden.y)).toBe(1);
    expect(at(11, 1)).toBe(1);
    expect(at(12, 3)).toBe(1); // the room's east wall
    expect(at(rat.pos.x, rat.pos.y)).not.toBe(2);
    // the next room stays unknown until the player stands in it
    expect(at(20, 2)).toBe(0);
  });

  it('open ground (a region bigger than a room) is not handed over on entry', () => {
    const w = testWorld();
    // 40×20, one region of 38×18 tiles; a wall at x 20 hides the east half from the start
    const walls = Array.from({ length: 17 }, (_, i) => ({ x: 20, y: i + 1 }));
    const s = newGame(w, 1, roomMap(40, 20, { start: { x: 2, y: 2 }, exit: { x: 37, y: 17 }, walls }));
    expect(38 * 18).toBeGreaterThan(ROOM_MEMORY_MAX_TILES);
    updateFov(ctxFor(w, s));
    expect(leadPlayer(s).seen[2 * 40 + 30]).toBe(0);
  });

  it('a GM spawn "random" lands where the player can see it', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const w = testWorld();
      let s = newGame(w, seed, twoRooms());
      s = applyGmActions(s, [{ type: 'spawn', actor: 'rat', count: 2, near: 'random' }], { world: w }).state;
      const ctx = ctxFor(w, s);
      const rats = s.area.actors.filter((a) => a.defId === 'rat');
      expect(rats.length).toBe(2);
      for (const r of rats) expect(playerSeesTile(ctx, r.pos)).toBe(true);
    }
  });

  it('walking through the door into the next room remembers that room', () => {
    const w = testWorld();
    let s = newGame(w, 1, twoRooms());
    player(s).pos = { x: 11, y: 10 };
    s = act(w, s, { type: 'move', dir: 'e' }).state; // opens the door
    s = act(w, s, { type: 'move', dir: 'e' }).state;
    s = act(w, s, { type: 'move', dir: 'e' }).state;
    expect(player(s).pos.x).toBeGreaterThanOrEqual(13);
    expect(leadPlayer(s).seen[1 * s.area.map.width + 22]).toBeGreaterThan(0);
  });
});
