/** Test helpers: a small parsed world, hand-built maps and a simple deterministic map generator. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorldSpec, parseWorld, type WorldSpecInput } from '../../src/schema';
import type { AreaMap, MapGenerator, Pos, Tile, GameState, ActorInstance, PlayerState } from '../../src/engine/types';
import { createGame, leadPlayer, step, type EngineEnv } from '../../src/engine';

export const WORLD_DIR = join(__dirname, '..', '..', 'content', 'worlds');

export function loadFixture(file: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(join(WORLD_DIR, file), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

/** open room w×h with a wall border; start at (1,1), exit at (w-2,h-2) */
export function roomMap(w = 12, h = 10, opts: { start?: Pos; exit?: Pos; walls?: Pos[] } = {}): AreaMap {
  const tiles: Tile[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) tiles.push({ kind: x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 'wall' : 'floor', region: 0 });
  for (const p of opts.walls ?? []) tiles[p.y * w + p.x] = { kind: 'wall' };
  const start = opts.start ?? { x: 1, y: 1 };
  const exit = opts.exit ?? { x: w - 2, y: h - 2 };
  tiles[start.y * w + start.x] = { kind: 'start', region: 0 };
  tiles[exit.y * w + exit.x] = { kind: 'transition', region: 0 };
  return { width: w, height: h, tiles, start, exit, regions: [{ id: 0, name: 'Room', centre: { x: w >> 1, y: h >> 1 }, size: (w - 2) * (h - 2) }] };
}

/** deterministic generator: a few rooms joined by corridors (used when mapgen is unavailable) */
export const simpleGenerator: MapGenerator = (plan, _world, rng) => {
  const w = plan.size === 'small' ? 30 : plan.size === 'large' ? 50 : 40;
  const h = plan.size === 'small' ? 22 : plan.size === 'large' ? 36 : 28;
  const tiles: Tile[] = Array.from({ length: w * h }, () => ({ kind: 'wall' as const }));
  const rooms: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < 40 && rooms.length < 7; i++) {
    const rw = rng.int(4, 9);
    const rh = rng.int(4, 7);
    const rx = rng.int(1, w - rw - 2);
    const ry = rng.int(1, h - rh - 2);
    if (rooms.some((r) => rx < r.x + r.w + 1 && rx + rw + 1 > r.x && ry < r.y + r.h + 1 && ry + rh + 1 > r.y)) continue;
    rooms.push({ x: rx, y: ry, w: rw, h: rh });
  }
  rooms.forEach((r, id) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) tiles[y * w + x] = { kind: 'floor', region: id };
  });
  const centre = (r: (typeof rooms)[number]) => ({ x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) });
  for (let i = 1; i < rooms.length; i++) {
    const a = centre(rooms[i - 1]);
    const b = centre(rooms[i]);
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) if (tiles[a.y * w + x].kind === 'wall') tiles[a.y * w + x] = { kind: 'floor' };
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) if (tiles[y * w + b.x].kind === 'wall') tiles[y * w + b.x] = { kind: 'floor' };
  }
  const start = centre(rooms[0]);
  const exit = centre(rooms[rooms.length - 1]);
  tiles[start.y * w + start.x] = { kind: 'start', region: 0 };
  tiles[exit.y * w + exit.x] = { kind: 'transition', region: rooms.length - 1 };
  return {
    width: w,
    height: h,
    tiles,
    start,
    exit,
    regions: rooms.map((r, id) => ({ id, centre: centre(r), size: r.w * r.h })),
  };
};

const model = { archetype: 'blob', colors: { primary: '#888888' } } as const;
const self = { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false } as const;

/** a compact valid world for unit tests; `patch` mutates the input before parsing */
export function testWorldInput(): WorldSpecInput {
  const statName = (n: string) => ({ name: n, abbr: n.slice(0, 3).toUpperCase(), description: n });
  return {
    specVersion: 1,
    meta: { title: 'Test World', tagline: 't', genre: 'test', tags: [], tone: 'dry', premise: 'p' },
    vocabulary: {
      stats: { str: statName('Might'), dex: statName('Grace'), int: statName('Wit'), hp: statName('Health'), mp: statName('Focus'), ac: statName('Guard') },
      defeated: 'bested',
      xp: 'Insight',
    },
    palette: { primary: '#111111', secondary: '#222222', accent: '#333333', danger: '#ff0000', ui: '#444444', text: '#ffffff' },
    damageTypes: [
      { id: 'physical', name: 'blunt', color: '#aaaaaa' },
      { id: 'fire', name: 'fire', color: '#ff6600' },
    ],
    statuses: [
      { id: 'burning', name: 'Burning', description: 'd', harmful: true, color: '#ff6600', perTurn: [{ type: 'damage', amount: { base: 1 }, damageType: 'fire' }] },
      { id: 'stun', name: 'Stunned', description: 'd', harmful: true, color: '#ffff00', flags: ['stunned'] },
      { id: 'root', name: 'Rooted', description: 'd', harmful: true, color: '#00ff00', flags: ['rooted'] },
      { id: 'haste', name: 'Hasted', description: 'd', harmful: false, color: '#00ffff', flags: ['hasted'] },
      { id: 'slow', name: 'Slowed', description: 'd', harmful: true, color: '#0000ff', flags: ['slowed'] },
      { id: 'mute', name: 'Silenced', description: 'd', harmful: true, color: '#999999', flags: ['silenced'] },
      { id: 'blind', name: 'Blinded', description: 'd', harmful: true, color: '#000000', flags: ['blinded'] },
      { id: 'fear', name: 'Afraid', description: 'd', harmful: true, color: '#550055', flags: ['afraid'] },
      { id: 'confuse', name: 'Confused', description: 'd', harmful: true, color: '#ff00ff', flags: ['confused'] },
      { id: 'charm', name: 'Charmed', description: 'd', harmful: true, color: '#ff88ff', flags: ['charmed'] },
      { id: 'hide', name: 'Hidden', description: 'd', harmful: false, color: '#777777', flags: ['invisible'] },
      { id: 'regen', name: 'Mending', description: 'd', harmful: false, color: '#55ff55', flags: ['regenerating'], modifiers: [{ stat: 'str', amount: 2 }] },
    ],
    resources: [{ id: 'oil', name: 'Oil', description: 'lamp oil', color: '#ffaa00', max: 20, start: 10, perTurn: 0, onEmpty: [{ type: 'apply_status', status: 'blind', duration: 3 }] }],
    verbs: { talk: true, sneak: true, search: true, persuade: true },
    player: {
      name: 'Tess',
      title: 'Tester',
      description: 'A tester.',
      stats: { str: 12, dex: 12, int: 12, hp: 30, mp: 10, ac: 10 },
      unarmed: { name: 'Fists', verb: 'punches', damage: { base: 1, dice: '1d2' }, range: 1, accuracyStat: 'str' },
      startingItems: [
        { item: 'stick', equipped: true },
        { item: 'tonic', count: 2 },
      ],
      growth: {
        firstLevelXp: 10,
        perks: [
          { id: 'tough', name: 'Tough', description: '+5 hp', modifiers: [{ stat: 'hp', amount: 5 }] },
          { id: 'quick', name: 'Quick', description: '+1 dex', modifiers: [{ stat: 'dex', amount: 1 }] },
          { id: 'clever', name: 'Clever', description: '+1 int', modifiers: [{ stat: 'int', amount: 1 }], grantItems: ['spark'] },
          { id: 'strong', name: 'Strong', description: '+1 str', modifiers: [{ stat: 'str', amount: 1 }] },
        ],
      },
      model,
    },
    actors: [
      {
        id: 'rat',
        name: 'Rat',
        description: 'small',
        stats: { hp: 5, ac: 8, str: 6, dex: 10 },
        attack: { name: 'Bite', verb: 'bites', damage: { base: 1 }, range: 1 },
        behaviour: { type: 'chaser' },
        xp: 4,
        model,
      },
      {
        id: 'golem',
        name: 'Golem',
        description: 'big',
        stats: { hp: 40, ac: 14, str: 16 },
        attack: { name: 'Slam', verb: 'slams', damage: { base: 3, dice: '1d6' }, range: 1, accuracyStat: 'str' },
        resistances: [{ damageType: 'fire', multiplier: 0 }, { damageType: 'physical', multiplier: 0.5 }],
        behaviour: { type: 'stationary' },
        xp: 30,
        model,
      },
      {
        id: 'archer',
        name: 'Archer',
        description: 'shoots',
        stats: { hp: 8, ac: 10, mp: 10 },
        attack: { name: 'Arrow', verb: 'shoots', damage: { base: 1, dice: '1d4' }, range: 5 },
        abilities: [
          {
            id: 'firebolt',
            name: 'Fire Bolt',
            description: 'fire',
            action: { targeting: { shape: 'single', range: 5, affects: 'enemies' }, effects: [{ type: 'damage', amount: { base: 2 }, damageType: 'fire' }] },
            cost: { resource: 'mp', amount: 3 },
            cooldown: 3,
          },
        ],
        behaviour: { type: 'kiter', param: 3 },
        xp: 6,
        loot: [{ item: 'tonic', chance: 1 }],
        model,
      },
      {
        id: 'sage',
        name: 'Sage',
        description: 'wise',
        faction: 'friendly',
        stats: { hp: 10 },
        behaviour: { type: 'idle' },
        xp: 0,
        npc: { role: 'healer', personality: 'calm', greeting: 'Hello, traveller.', lines: ['The wind is cold.'] },
        model,
      },
      {
        id: 'boss',
        name: 'Boss',
        description: 'the boss',
        unique: true,
        stats: { hp: 20, ac: 10 },
        attack: { name: 'Hit', verb: 'hits', damage: { base: 2 }, range: 1 },
        behaviour: { type: 'chaser' },
        triggers: [{ on: 'on_death', action: { targeting: self, effects: [{ type: 'set_flag', flag: 'boss-down' }] } }],
        xp: 20,
        model,
      },
    ],
    items: [
      {
        id: 'stick',
        name: 'Stick',
        kind: 'Club',
        description: 'a stick',
        category: 'weapon',
        equipSlot: 'weapon',
        useMode: 'passive',
        weapon: { name: 'Stick', verb: 'whacks', damage: { base: 2, dice: '1d4' }, range: 1, accuracyStat: 'str' },
        model,
      },
      {
        id: 'bow',
        name: 'Bow',
        kind: 'Bow',
        description: 'a bow',
        category: 'weapon',
        equipSlot: 'weapon',
        useMode: 'passive',
        weapon: { name: 'Bow', verb: 'shoots', damage: { base: 1, dice: '1d6' }, range: 6 },
        requires: [{ stat: 'dex', min: 14 }],
        model,
      },
      { id: 'coat', name: 'Coat', kind: 'Coat', description: 'warm', category: 'armour', equipSlot: 'armour', useMode: 'passive', armour: 2, model },
      {
        id: 'ring',
        name: 'Ring',
        kind: 'Ring',
        description: 'shiny',
        category: 'trinket',
        equipSlot: 'trinket',
        useMode: 'passive',
        modifiers: [{ stat: 'dex', amount: 2 }],
        triggers: [{ on: 'on_equip', action: { targeting: self, effects: [{ type: 'set_flag', flag: 'ring-on' }] } }],
        model,
      },
      {
        id: 'tonic',
        name: 'Tonic',
        kind: 'Flask',
        description: 'heals',
        category: 'consumable',
        useMode: 'consumed',
        stackable: true,
        onUse: { targeting: self, effects: [{ type: 'heal', amount: { base: 6 } }] },
        model,
      },
      {
        id: 'murk',
        name: 'Murky Draught',
        kind: 'Flask',
        description: 'secretly heals',
        category: 'consumable',
        useMode: 'consumed',
        stackable: true,
        knowledge: 'unknown',
        appearanceGroup: 'flask',
        onUse: { targeting: self, effects: [{ type: 'heal', amount: { base: 6 } }] },
        model,
      },
      {
        id: 'fog',
        name: 'Fog Draught',
        kind: 'Flask',
        description: 'secretly burns',
        category: 'consumable',
        useMode: 'consumed',
        stackable: true,
        knowledge: 'unknown',
        appearanceGroup: 'flask',
        revealOnUse: 'vague',
        vagueText: 'Warm going down.',
        onUse: { targeting: self, effects: [{ type: 'apply_status', status: 'burning', duration: 2 }] },
        model,
      },
      {
        id: 'spark',
        name: 'Spark',
        kind: 'Spell',
        description: 'zap',
        category: 'spell',
        useMode: 'reusable',
        cost: { resource: 'mp', amount: 3 },
        cooldown: 2,
        onUse: { targeting: { shape: 'ray', range: 5, affects: 'enemies' }, effects: [{ type: 'damage', amount: { base: 3 }, damageType: 'fire' }] },
        model,
      },
      {
        id: 'wand',
        name: 'Wand',
        kind: 'Wand',
        description: 'boom',
        category: 'tool',
        useMode: 'charges',
        charges: 2,
        onUse: { targeting: { shape: 'area', range: 6, radius: 1, affects: 'enemies' }, effects: [{ type: 'damage', amount: { base: 4 }, damageType: 'fire' }] },
        model,
      },
      { id: 'key', name: 'Key', kind: 'Key', description: 'opens', category: 'key', useMode: 'passive', model },
    ],
    terrains: [
      { id: 'spikes', name: 'Spikes', description: 'ouch', onStand: [{ type: 'damage', amount: { base: 1 } }], color: '#999999' },
      { id: 'glue', name: 'Glue', description: 'sticky', onStand: [{ type: 'apply_status', status: 'root', duration: 1 }], color: '#cccc00' },
      { id: 'pillar', name: 'Pillar', description: 'solid', walkable: false, blocksSight: true, color: '#555555' },
      {
        id: 'chest',
        name: 'Chest',
        description: 'holds things',
        walkable: false,
        color: '#aa7700',
        interact: { targeting: self, effects: [{ type: 'spawn_item', item: 'tonic' }] },
      },
    ],
    unknownAppearances: { flask: [{ label: 'green flask', color: '#00ff00' }, { label: 'red flask', color: '#ff0000' }] },
    areas: [
      {
        name: 'First',
        description: 'd',
        generator: 'rooms',
        size: 'small',
        floor: { color: '#333333' },
        wall: { color: '#666666' },
        lighting: { ambient: '#222222' },
        actors: [{ actor: 'rat', min: 0, max: 0 }],
        items: [],
        itemCount: 0,
        transitionName: 'Stairs',
        transitionRequires: { type: 'has_item', who: 'player', item: 'key' },
      },
      {
        name: 'Second',
        description: 'd',
        generator: 'rooms',
        size: 'small',
        floor: { color: '#333333' },
        wall: { color: '#666666' },
        lighting: { ambient: '#222222' },
        actors: [{ actor: 'rat', weight: 10, min: 1, max: 2 }],
        placed: [{ actor: 'boss', where: 'far' }],
        items: [{ item: 'tonic', weight: 10 }],
        itemCount: 2,
        placedItems: [{ item: 'key', where: 'near_start' }],
        transitionName: 'Exit',
      },
    ],
    goal: { summary: 'Defeat the boss', win: { type: 'flag', flag: 'boss-down' }, winText: 'You won.', lossText: 'You lost.' },
    gm: { persona: 'p', voice: 'v', fallback: { intro: 'Hi.', areaEnter: ['Here we are.'], lowHp: ['Careful.'] } },
    audio: { mood: 'm', synth: {} },
  } as WorldSpecInput;
}

export function testWorld(patch?: (w: WorldSpecInput) => void): WorldSpec {
  const input = testWorldInput();
  patch?.(input);
  const r = parseWorld(input);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

export const env = (world: WorldSpec): EngineEnv => ({ world, mapGenerator: simpleGenerator });

/** new game on a hand-built room (no random spawns in area 0 of the test world) */
export function newGame(world: WorldSpec, seed = 1, map: AreaMap = roomMap()): GameState {
  return createGame(world, { seed, map, mapGenerator: simpleGenerator });
}

export function player(s: GameState): ActorInstance {
  return s.area.actors.find((a) => a.id === leadPlayer(s).actorId)!;
}

/** places a fresh actor of `defId` at pos by direct state surgery (test setup only) */
export function addActor(world: WorldSpec, s: GameState, defId: string, pos: Pos, over: Partial<ActorInstance> = {}): ActorInstance {
  const def = world.actors.find((a) => a.id === defId)!;
  const a: ActorInstance = {
    id: `a${s.nextId++}`,
    defId,
    pos: { ...pos },
    hp: def.stats.hp,
    maxHp: def.stats.hp,
    mp: def.stats.mp,
    maxMp: def.stats.mp,
    base: { str: def.stats.str, dex: def.stats.dex, int: def.stats.int, ac: def.stats.ac, speed: def.speed, sight: def.sight },
    faction: def.faction,
    statuses: [],
    energy: 0,
    cooldowns: {},
    ai: { alerted: false, home: { ...pos } },
    tempMods: [],
    ...over,
  };
  s.area.actors.push(a);
  return a;
}

/**
 * Adds a second (third…) player by direct state surgery: a copy of the lead's actor at `pos` and a
 * fresh PlayerState with a copy of the lead's knowledge (appearances are shared). Test setup only,
 * for the data model (save, clone, hash); the engine's own addPlayer comes with the party rules.
 */
export function handBuiltPlayer(s: GameState, pos: Pos, name: string): PlayerState {
  const lead = leadPlayer(s);
  const la = s.area.actors.find((a) => a.id === lead.actorId)!;
  const id = `p${s.party.length + 1}`;
  const a: ActorInstance = structuredClone(la);
  a.id = `a${s.nextId++}`;
  a.pos = { ...pos };
  s.area.actors.push(a);
  const ps: PlayerState = {
    id,
    name,
    actorId: a.id,
    slots: lead.slots.map(() => null),
    equipped: { weapon: null, armour: null, trinket: null },
    level: 1,
    xp: 0,
    perks: [],
    pendingPerkChoice: null,
    resources: { ...lead.resources },
    sneaking: false,
    knowledge: structuredClone(lead.knowledge),
    pendingChoice: null,
    seen: new Uint8Array(s.area.map.width * s.area.map.height),
  };
  s.players[id] = ps;
  s.party.push(id);
  return ps;
}

export function act(world: WorldSpec, s: GameState, action: Parameters<typeof step>[1]) {
  return step(s, action, env(world));
}

// ---------------------------------------------------------------------------
// Direct access to engine internals for unit tests
// ---------------------------------------------------------------------------
import { indexWorld, type Ctx } from '../../src/engine/ctx';
import { SeededRng, rngFromState } from '../../src/engine/rng';

export function ctxFor(world: WorldSpec, s: GameState, rng?: SeededRng): Ctx {
  return { world, ix: indexWorld(world), s, pid: s.party[0], rng: rng ?? rngFromState(s.rng), events: [], mapGen: simpleGenerator, depth: 0 };
}

/** an rng whose int() calls return queued values first (then falls back to the seeded stream) */
export class ScriptedRng extends SeededRng {
  queue: number[];
  constructor(values: number[], seed = 1) {
    super(SeededRng.fromSeed(seed).state());
    this.queue = [...values];
  }
  override int(min: number, max: number): number {
    if (this.queue.length) return Math.min(max, Math.max(min, this.queue.shift()!));
    return super.int(min, max);
  }
}
