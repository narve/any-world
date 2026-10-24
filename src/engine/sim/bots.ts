/**
 * Simulation bots: deterministic functions that pick a PlayerAction for a GameState. They only
 * pick actions from legalActions, and only use what the player could know (remembered map, item
 * knowledge levels); unknown items are tried when it is safe.
 *
 *   explorer — explores every region, fights what blocks it, loots, heals, equips upgrades,
 *              pursues the goal / transition requirements and moves on when the area is done
 *   cautious — avoids fights it doesn't need, sneaks, heals early, kites with ranged attacks
 *   talker   — talks to and persuades everyone it can (non-violent worlds); fights as a last resort
 *   random   — random legal actions (fuzzing), with a mild bias toward the way onward
 *
 * A bot keeps a small BotMemory (its own seeded RNG, targets it gave up on, stuck counters). The
 * runner reports whether the previous action was refused through `memory.lastInvalid`.
 */
import type { WorldSpec, ItemDef } from '../../schema/world';
import type { GmAction } from '../../schema/gm';
import type { Dir, GameState, PlayerAction, Pos } from '../types';
import type { Ctx } from '../ctx';
import { SeededRng, createRng } from '../rng';
import { equipSlotOf } from '../inventory';
import { getStat, maxHp, side } from '../stats';
import { TALK_RANGE } from '../npc';
import {
  type Objective,
  type PathField,
  armourScore,
  avgAmount,
  botCtx,
  cheb,
  currentObjectives,
  evalConditionSafe,
  fastLegal,
  firstStep,
  frontierTiles,
  hpFrac,
  idxToPos,
  isNpc,
  itemProfile,
  known,
  knownHostiles,
  loseCounters,
  modValue,
  pathField,
  player,
  seenCount,
  trinketScore,
  visibleHostiles,
  vitalResources,
  wantedDefeats,
  wantedItems,
  weaponScore,
} from './view';

export const BOT_NAMES = ['explorer', 'cautious', 'talker', 'random'] as const;
export type BotName = (typeof BOT_NAMES)[number];

export interface BotMemory {
  rng: SeededRng;
  decisions: number;
  areaIndex: number;
  /** decisions spent in the current area */
  areaDecisions: number;
  /** tile indices (this area) the bot stopped trying to reach */
  blacklist: Set<number>;
  /** unknown item kinds already tried */
  tried: Set<string>;
  /** actor instance id → talk / persuade attempts */
  talks: Map<string, number>;
  persuades: Map<string, number>;
  /** one-off uses this area ("reveal", "buff:<actorId>") */
  onceThisArea: Set<string>;
  target: { idx: number; best: number; since: number } | null;
  lastAction: PlayerAction | null;
  /** set by the runner: refusal reason of the last action (null = accepted) */
  lastInvalid: string | null;
  /** progress tracking for stuck detection */
  lastSeenCount: number;
  lastProgressAt: number;
  wanderUntil: number;
  restStreak: number;
  lastSearchAt: number;
  /** key → decision number of the last time (rate limits) */
  cooldowns: Map<string, number>;
  /** recent player tile indices (oscillation detection) */
  trail: number[];
}

export function newMemory(seed: number): BotMemory {
  return {
    rng: createRng((seed * 2654435761) >>> 0 || 1),
    decisions: 0,
    areaIndex: -1,
    areaDecisions: 0,
    blacklist: new Set(),
    tried: new Set(),
    talks: new Map(),
    persuades: new Map(),
    onceThisArea: new Set(),
    target: null,
    lastAction: null,
    lastInvalid: null,
    lastSeenCount: 0,
    lastProgressAt: 0,
    wanderUntil: 0,
    restStreak: 0,
    lastSearchAt: -999,
    cooldowns: new Map(),
    trail: [],
  };
}

interface Persona {
  name: BotName;
  /** eager: hunts visible hostiles; avoid: only fights what blocks it or is required; talk: persuades first */
  fight: 'eager' | 'avoid' | 'talk';
  /** heal below this hp fraction */
  healAt: number;
  sneak: boolean;
  kite: boolean;
  /** explore the whole area before moving on (else leave once the way is open and a bit explored) */
  exploreFully: boolean;
  talkAll: boolean;
}

const PERSONAS: Record<Exclude<BotName, 'random'>, Persona> = {
  explorer: { name: 'explorer', fight: 'eager', healAt: 0.4, sneak: false, kite: false, exploreFully: true, talkAll: false },
  cautious: { name: 'cautious', fight: 'avoid', healAt: 0.55, sneak: true, kite: true, exploreFully: false, talkAll: false },
  talker: { name: 'talker', fight: 'talk', healAt: 0.5, sneak: false, kite: false, exploreFully: true, talkAll: true },
};

/** decisions per area before a bot stops exploring and heads for the way onward */
const AREA_DECISION_CAP = 700;
/** decisions without new information before the bot starts wandering */
const STALL_LIMIT = 60;

export interface Bot {
  name: BotName;
  decide(state: GameState, world: WorldSpec, memory: BotMemory): PlayerAction;
}

export function botByName(name: string): Bot {
  if (name === 'random') return { name: 'random', decide: randomDecide };
  const persona = PERSONAS[name as Exclude<BotName, 'random'>];
  if (!persona) throw new Error(`unknown bot "${name}" (known: ${BOT_NAMES.join(', ')})`);
  return { name: persona.name, decide: (s, w, m) => personaDecide(persona, s, w, m) };
}

// ---------------------------------------------------------------------------
// Random bot
// ---------------------------------------------------------------------------

function randomDecide(state: GameState, world: WorldSpec, mem: BotMemory): PlayerAction {
  const ctx = botCtx(world, state);
  const legal = fastLegal(ctx);
  mem.decisions++;
  if (!legal.length) return { type: 'wait' };
  const tr = legal.find((a) => a.type === 'transition');
  if (tr && mem.rng.chance(0.5)) return tr;
  if (state.pendingChoice || state.player.pendingPerkChoice) return mem.rng.pick(legal);
  // moves dominate the list; weight other verbs up a bit so items/talk/interact get exercised
  const moves = legal.filter((a) => a.type === 'move');
  const other = legal.filter((a) => a.type !== 'move');
  if (moves.length && mem.rng.chance(0.6)) return mem.rng.pick(moves);
  return mem.rng.pick(other.length ? other : legal);
}

// ---------------------------------------------------------------------------
// Persona bots
// ---------------------------------------------------------------------------

interface Turn {
  ctx: Ctx;
  legal: PlayerAction[];
  persona: Persona;
  mem: BotMemory;
  world: WorldSpec;
  objectives: { goal: Objective[]; lock: Objective[]; finalArea: boolean };
  wantItems: Set<string>;
  wantDefeat: Set<string>;
}

function personaDecide(persona: Persona, state: GameState, world: WorldSpec, mem: BotMemory): PlayerAction {
  const ctx = botCtx(world, state);
  const legal = fastLegal(ctx);
  mem.decisions++;
  if (!legal.length) return { type: 'wait' };
  if (state.player.pendingPerkChoice) return pickPerk(ctx, legal);
  if (state.pendingChoice) return pickOption(ctx, legal, persona);

  if (state.area.index !== mem.areaIndex) {
    mem.areaIndex = state.area.index;
    mem.areaDecisions = 0;
    mem.blacklist.clear();
    mem.onceThisArea.clear();
    mem.target = null;
    mem.lastProgressAt = mem.decisions;
    mem.wanderUntil = 0;
  }
  mem.areaDecisions++;
  const seenNow = seenCount(state);
  if (seenNow !== mem.lastSeenCount) {
    mem.lastSeenCount = seenNow;
    mem.lastProgressAt = mem.decisions;
  }
  // a refused move: give up on the current target
  if (mem.lastInvalid && mem.lastAction?.type === 'move' && mem.target) {
    mem.blacklist.add(mem.target.idx);
    mem.target = null;
  }
  // pacing between two or three tiles without seeing anything new: drop the target, wander a bit
  const here = player(ctx).pos;
  mem.trail.push(here.y * state.area.map.width + here.x);
  if (mem.trail.length > 16) mem.trail.shift();
  if (mem.trail.length === 16 && new Set(mem.trail).size <= 3 && mem.decisions - mem.lastProgressAt > 16 && mem.decisions >= mem.wanderUntil) {
    if (mem.target) mem.blacklist.add(mem.target.idx);
    mem.target = null;
    mem.trail = [];
    mem.wanderUntil = mem.decisions + 6;
  }

  const objectives = currentObjectives(ctx);
  const all = [...objectives.goal, ...objectives.lock];
  const t: Turn = { ctx, legal, persona: restrained(ctx, persona), mem, world, objectives, wantItems: wantedItems(all), wantDefeat: wantedDefeats(all) };

  const act =
    survive(t) ??
    goalUse(t) ??
    fight(t) ??
    equipUpgrade(t) ??
    pickup(t) ??
    sneak(t) ??
    tryUnknown(t) ??
    utility(t) ??
    rest(t) ??
    leave(t) ??
    navigate(t) ??
    wander(t);
  return act;
}

/**
 * When kills feed a lose condition (a violence counter that ends the run at N), a sensible player
 * stops picking fights as the counter nears N: only required or blocking fights, no full sweeps.
 */
function restrained(ctx: Ctx, persona: Persona): Persona {
  const vc = ctx.ix.switches.violenceCounter;
  if (!vc) return persona;
  const limit = loseCounters(ctx.world).get(vc);
  if (limit === undefined) return persona;
  const used = ctx.s.counters[vc] ?? 0;
  if (used < limit * 0.5) return persona;
  return { ...persona, fight: persona.fight === 'eager' ? 'avoid' : persona.fight, exploreFully: false };
}

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

function pickPerk(ctx: Ctx, legal: PlayerAction[]): PlayerAction {
  let best = legal[0];
  let bestScore = -Infinity;
  for (const a of legal) {
    if (a.type !== 'choose_perk') continue;
    const perk = ctx.ix.perks.get(a.perkId);
    if (!perk) continue;
    let s = 0;
    for (const m of perk.modifiers) s += modValue(m.stat, m.amount) * 2;
    s += perk.grantItems.length * 2 + perk.triggers.length;
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return best;
}

function gmActionValue(ctx: Ctx, a: GmAction, want: Set<string>): number {
  switch (a.type) {
    case 'give_item': {
      const def = ctx.ix.items.get(a.item);
      if (!def) return 0;
      return 3 + (want.has(a.item) ? 30 : 0) + Math.min(4, itemProfile(ctx.world, def).heal / 4);
    }
    case 'effect': {
      let v = 0;
      for (const e of a.effects) {
        if (e.type === 'heal') v += a.target === 'player' ? 2 + avgAmount(e.amount) / 4 : 0;
        else if (e.type === 'damage') v += a.target === 'player' ? -4 : 2;
        else if (e.type === 'remove_status') v += a.target === 'player' ? 1 : 0;
        else if (e.type === 'apply_status') v += a.target === 'player' ? (ctx.ix.statuses.get(e.status)?.harmful ? -3 : 1) : 1;
      }
      return v;
    }
    case 'currency':
      return a.amount > 0 ? 1 + a.amount / 50 : 0; // price handled separately
    case 'grant_xp':
      return 2 + a.amount / 20;
    case 'spawn': {
      const def = ctx.ix.actors.get(a.actor);
      return def && def.faction === 'hostile' ? -3 : 1;
    }
    case 'set_flag':
      return 1;
    case 'start_quest':
      return 2;
    case 'add_rule':
      return -1;
    case 'remove_rule':
      return 0.5;
    case 'change_faction':
      return a.faction === 'hostile' ? -2 : 1;
    case 'reveal_item':
      return 1;
    case 'place_item':
      return 1;
    default:
      return 0;
  }
}

function heldHeals(ctx: Ctx): number {
  let n = 0;
  for (const it of ctx.s.player.slots) {
    if (!it) continue;
    const def = ctx.ix.items.get(it.defId);
    if (def && known(ctx, def.id) !== 'unknown' && itemProfile(ctx.world, def).heal > 0) n += it.count;
  }
  return n;
}

function equippedDef(ctx: Ctx, kind: 'weapon' | 'armour' | 'trinket'): ItemDef | null {
  const slot = ctx.s.player.equipped[kind];
  const it = slot !== null ? ctx.s.player.slots[slot] : null;
  return it ? (ctx.ix.items.get(it.defId) ?? null) : null;
}

function upgradeValue(ctx: Ctx, def: ItemDef): number {
  const kind = equipSlotOf(def);
  if (kind === 'weapon') return weaponScore(ctx, def) - weaponScore(ctx, equippedDef(ctx, 'weapon'));
  if (kind === 'armour') return armourScore(def) - armourScore(equippedDef(ctx, 'armour'));
  if (kind === 'trinket') return trinketScore(def) - trinketScore(equippedDef(ctx, 'trinket'));
  return 0;
}

function pickOption(ctx: Ctx, legal: PlayerAction[], persona: Persona): PlayerAction {
  const pc = ctx.s.pendingChoice!;
  const objs = currentObjectives(ctx);
  const want = wantedItems([...objs.goal, ...objs.lock]);
  const hurt = hpFrac(ctx) < 0.8;
  let best = legal[legal.length - 1];
  let bestScore = -Infinity;
  for (const a of legal) {
    if (a.type !== 'choose_option') continue;
    const opt = pc.options[a.index];
    if (!opt) continue;
    let s = 0;
    const price = opt.actions.reduce((n, x) => n + (x.type === 'currency' && x.amount < 0 ? -x.amount : 0), 0);
    if (opt.tag === 'service:heal') s = hurt ? 12 : -1;
    else if (opt.tag === 'service:gift') s = 8;
    else if (opt.tag === 'service:recruit') s = 6;
    else if (opt.tag === 'buy') {
      const give = opt.actions.find((x) => x.type === 'give_item');
      const def = give && give.type === 'give_item' ? ctx.ix.items.get(give.item) : undefined;
      if (def) {
        if (want.has(def.id)) s = 30;
        else if (equipSlotOf(def) && upgradeValue(ctx, def) > 0.3) s = 6;
        else if (itemProfile(ctx.world, def).heal > 0 && heldHeals(ctx) < 3) s = 4;
        else s = -1;
      }
    } else {
      for (const x of opt.actions) s += gmActionValue(ctx, x, want);
      if (/^(goodbye|decline)$/i.test(opt.label.trim())) s = Math.max(s, 0);
      else if (!opt.actions.length) s = 0;
      if (persona.talkAll && opt.actions.some((x) => x.type === 'say')) s += 1;
    }
    s -= price / 100;
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

type UseAction = Extract<PlayerAction, { type: 'use' }>;

function useActions(t: Turn): UseAction[] {
  return t.legal.filter((a): a is UseAction => a.type === 'use');
}

function defAt(t: Turn, slot: number): ItemDef | undefined {
  const it = t.ctx.s.player.slots[slot];
  return it ? t.ctx.ix.items.get(it.defId) : undefined;
}

/** use actions of items whose effect the player knows (clear or vague) */
function knownUses(t: Turn): { a: UseAction; def: ItemDef }[] {
  const out: { a: UseAction; def: ItemDef }[] = [];
  for (const a of useActions(t)) {
    const def = defAt(t, a.slot);
    if (!def || def.useMode === 'passive' || !def.onUse) continue;
    if (known(t.ctx, def.id) === 'unknown') continue;
    out.push({ a, def });
  }
  return out;
}

function survive(t: Turn): PlayerAction | null {
  const { ctx } = t;
  const p = player(ctx);
  const frac = hpFrac(ctx);
  const hostiles = visibleHostiles(ctx);
  const healAt = hostiles.length ? t.persona.healAt : Math.max(t.persona.healAt, 0.5);
  if (frac < healAt) {
    const missing = maxHp(ctx, p) - p.hp;
    const heals = knownUses(t)
      .map((u) => ({ ...u, pr: itemProfile(t.world, u.def) }))
      .filter((u) => u.pr.heal > 0 && !u.pr.offensive);
    if (heals.length) {
      // the smallest heal that covers most of the gap, else the biggest
      heals.sort((a, b) => a.pr.heal - b.pr.heal);
      const fit = heals.find((h) => h.pr.heal >= missing * 0.6) ?? heals[heals.length - 1];
      return fit.a;
    }
    // desperate: try an unknown item
    if (frac < 0.25) {
      const unk = useActions(t).find((a) => {
        const def = defAt(t, a.slot);
        return def && known(ctx, def.id) === 'unknown' && def.category === 'consumable';
      });
      if (unk) return unk;
    }
  }
  // harmful statuses with a cure at hand
  const harmful = p.statuses.filter((s) => ctx.ix.statuses.get(s.id)?.harmful);
  if (harmful.length && (frac < 0.7 || harmful.some((s) => ctx.ix.statuses.get(s.id)?.flags.some((f) => ['stunned', 'rooted', 'afraid', 'blinded', 'confused'].includes(f))))) {
    const cure = knownUses(t).find((u) => {
      const pr = itemProfile(t.world, u.def);
      if (!pr.cures || pr.offensive) return false;
      return u.def.onUse!.effects.some((e) => e.type === 'remove_status' && (e.status === 'all_harmful' || harmful.some((h) => h.id === e.status)));
    });
    if (cure) return cure.a;
  }
  // vital resources (oxygen, light…) running low: an item, else terrain that refills it
  for (const res of vitalResources(t.world)) {
    const r = ctx.ix.resources.get(res)!;
    const v = ctx.s.player.resources[res] ?? 0;
    const onRefill = refillTiles(ctx, res).has(p.pos.y * ctx.s.area.map.width + p.pos.x);
    // topping up on a refill tile: stay until nearly full
    if (onRefill && v < r.max * 0.8 && !hostiles.some((h) => cheb(h.pos, p.pos) <= 2)) {
      t.mem.lastProgressAt = t.mem.decisions;
      const wait = t.legal.find((a) => a.type === 'wait');
      if (wait) return wait;
    }
    if (v > r.max * 0.25) continue;
    const refill = knownUses(t).find((u) => (itemProfile(t.world, u.def).resources[res] ?? 0) > 0);
    if (refill) return refill.a;
    const go = walkToRefill(t, res);
    if (go) return go;
  }
  // a lose counter is close: use anything that lowers it
  for (const [counter, limit] of loseCounters(t.world)) {
    const v = ctx.s.counters[counter] ?? 0;
    if (v < limit - 1 || v <= 0) continue;
    const fix = knownUses(t).find((u) => (itemProfile(t.world, u.def).counters[counter] ?? 0) < 0);
    if (fix) return fix.a;
  }
  // a cautious bot steps away from melee when hurt (if a safe tile exists)
  if (t.persona.kite && hostiles.some((h) => cheb(h.pos, p.pos) === 1) && frac < 0.5) {
    const away = stepAway(t, hostiles.map((h) => h.pos));
    if (away) return away;
  }
  return null;
}

/** use a known item that sets a wanted flag / raises a wanted counter */
function goalUse(t: Turn): PlayerAction | null {
  const objs = [...t.objectives.goal, ...t.objectives.lock];
  const flags = new Set(objs.filter((o) => o.kind === 'flag').map((o) => (o as { flag: string }).flag));
  const counters = new Set(objs.filter((o) => o.kind === 'counter').map((o) => (o as { counter: string }).counter));
  if (!flags.size && !counters.size) {
    if (objs.some((o) => o.kind === 'wait') && !visibleHostiles(t.ctx).length) return t.legal.find((a) => a.type === 'wait') ?? null;
    return null;
  }
  const p = player(t.ctx);
  for (const u of knownUses(t)) {
    const pr = itemProfile(t.world, u.def);
    const useful = pr.setsFlags.some((f) => flags.has(f)) || Object.entries(pr.counters).some(([c, v]) => counters.has(c) && v > 0);
    if (!useful) continue;
    // the item's own condition (e.g. "only on the stage, once the rival is beaten") must hold now
    const cond = u.def.onUse!.condition;
    if (cond && cond.type !== 'chance' && !evalConditionSafe(t.ctx, cond, p)) continue;
    // never spam the same goal item: once per 10 decisions
    const key = `goal:${u.def.id}`;
    const last = t.mem.cooldowns.get(key) ?? -999;
    if (t.mem.decisions - last < 10) continue;
    t.mem.cooldowns.set(key, t.mem.decisions);
    return u.a;
  }
  return null;
}

function equipUpgrade(t: Turn): PlayerAction | null {
  const { ctx } = t;
  const p = player(ctx);
  if (visibleHostiles(ctx).some((h) => cheb(h.pos, p.pos) <= 1)) return null;
  let best: PlayerAction | null = null;
  let bestGain = 0.3;
  for (const a of t.legal) {
    if (a.type !== 'equip') continue;
    const def = defAt(t, a.slot);
    if (!def) continue;
    const gain = upgradeValue(ctx, def);
    if (gain > bestGain) {
      bestGain = gain;
      best = a;
    }
  }
  return best;
}

function pickup(t: Turn): PlayerAction | null {
  const p = player(t.ctx);
  if (visibleHostiles(t.ctx).some((h) => cheb(h.pos, p.pos) <= 1) && t.persona.fight !== 'avoid') return null;
  return t.legal.find((a) => a.type === 'pickup') ?? null;
}

function sneak(t: Turn): PlayerAction | null {
  // sneaking makes every step slower: not worth it while a vital resource drains each turn
  const draining = vitalResources(t.world).some((r) => (t.ctx.ix.resources.get(r)?.perTurn ?? 0) < 0);
  const want = t.persona.sneak && !draining;
  if (want === t.ctx.s.player.sneaking) return null;
  if (!want && !t.ctx.s.player.sneaking) return null;
  return t.legal.find((a) => a.type === 'toggle_sneak') ?? null;
}

function tryUnknown(t: Turn): PlayerAction | null {
  const { ctx } = t;
  if (visibleHostiles(ctx).length || hpFrac(ctx) < 0.7) return null;
  for (const a of useActions(t)) {
    const def = defAt(t, a.slot);
    if (!def || t.mem.tried.has(def.id)) continue;
    if (known(ctx, def.id) !== 'unknown') continue;
    // a positional item with an automatic target would be thrown at someone: skip those when calm
    if (a.target) continue;
    t.mem.tried.add(def.id);
    return a;
  }
  return null;
}

/** map reveals once per area; buffs before a unique */
function utility(t: Turn): PlayerAction | null {
  const { ctx } = t;
  if (!t.mem.onceThisArea.has('reveal') && !visibleHostiles(ctx).length) {
    const rev = knownUses(t).find((u) => itemProfile(t.world, u.def).revealMap && !itemProfile(t.world, u.def).selfHarm);
    if (rev) {
      t.mem.onceThisArea.add('reveal');
      return rev.a;
    }
  }
  return null;
}

/** tile indices whose terrain refills resource `res` for whoever stands there */
function refillTiles(ctx: Ctx, res: string): Set<number> {
  const out = new Set<number>();
  const good = new Set(
    [...ctx.ix.terrains.values()]
      .filter((td) => td.walkable !== false && td.onStand.some((e) => e.type === 'resource' && e.resource === res && avgAmount(e.amount) > 0))
      .map((td) => td.id),
  );
  if (!good.size) return out;
  const tiles = ctx.s.area.map.tiles;
  for (let i = 0; i < tiles.length; i++) if (tiles[i].terrain && good.has(tiles[i].terrain!) && ctx.s.area.seen[i]) out.add(i);
  return out;
}

function walkToRefill(t: Turn, res: string): PlayerAction | null {
  const tiles = refillTiles(t.ctx, res);
  if (!tiles.size) return null;
  const p = player(t.ctx);
  const W = t.ctx.s.area.map.width;
  const field = pathField(t.ctx);
  let goal = -1;
  let best = Infinity;
  for (const i of tiles) {
    if (field.dist[i] < best && !t.ctx.s.area.actors.some((a) => a.hp > 0 && a.pos.y * W + a.pos.x === i && a.id !== p.id)) {
      best = field.dist[i];
      goal = i;
    }
  }
  if (goal < 0) return null;
  return stepTowards(t, field, goal, p.pos.y * W + p.pos.x);
}

/** a draining vital resource is low and nothing at hand refills it: time to move on */
function hurry(t: Turn): boolean {
  const { ctx } = t;
  for (const res of vitalResources(t.world)) {
    const r = ctx.ix.resources.get(res)!;
    if (r.perTurn >= 0) continue;
    const v = ctx.s.player.resources[res] ?? 0;
    if (v > r.max * 0.4) continue;
    const refill = knownUses(t).some((u) => (itemProfile(t.world, u.def).resources[res] ?? 0) > 0);
    if (!refill && !refillTiles(ctx, res).size) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fighting
// ---------------------------------------------------------------------------

function dirTo(from: Pos, to: Pos): Dir | null {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  const map: Record<string, Dir> = { '0,-1': 'n', '1,-1': 'ne', '1,0': 'e', '1,1': 'se', '0,1': 's', '-1,1': 'sw', '-1,0': 'w', '-1,-1': 'nw' };
  return map[`${dx},${dy}`] ?? null;
}

function moveAction(t: Turn, dir: Dir | null): PlayerAction | null {
  if (!dir) return null;
  return t.legal.find((a) => a.type === 'move' && a.dir === dir) ?? null;
}

function stepAway(t: Turn, threats: Pos[]): PlayerAction | null {
  const p = player(t.ctx);
  let best: PlayerAction | null = null;
  let bestScore = threats.reduce((m, q) => Math.min(m, cheb(q, p.pos)), Infinity);
  for (const a of t.legal) {
    if (a.type !== 'move') continue;
    const d = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] }[a.dir];
    const to = { x: p.pos.x + d[0], y: p.pos.y + d[1] };
    if (t.ctx.s.area.actors.some((x) => x.hp > 0 && x.pos.x === to.x && x.pos.y === to.y)) continue;
    const score = threats.reduce((m, q) => Math.min(m, cheb(q, to)), Infinity);
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

function offensiveUse(t: Turn, hostiles: ReturnType<typeof visibleHostiles>): PlayerAction | null {
  const { ctx } = t;
  const p = player(ctx);
  const frac = hpFrac(ctx);
  const myHit = weaponScore(ctx, equippedDef(ctx, 'weapon'));
  for (const u of knownUses(t)) {
    const pr = itemProfile(t.world, u.def);
    if (!pr.offensive || (pr.damage <= 0 && !pr.debuff)) continue;
    const tg = u.def.onUse!.targeting;
    let target = u.a.target ? hostiles.find((h) => h.pos.x === u.a.target!.x && h.pos.y === u.a.target!.y) : undefined;
    if (!u.a.target) {
      if (tg.shape === 'adjacent') target = hostiles.find((h) => cheb(h.pos, p.pos) === 1);
      else if (tg.shape === 'all_visible') target = hostiles[0];
      else continue;
    }
    if (!target) continue;
    // area effects that would catch the user
    if ((tg.shape === 'area' || tg.shape === 'cone') && tg.affects === 'all' && cheb(target.pos, p.pos) <= tg.radius) continue;
    const def = ctx.ix.actors.get(target.defId);
    const tough = target.hp > myHit * 2.5 || !!def?.unique;
    const free = u.def.useMode === 'reusable' || u.def.useMode === 'charges';
    if (free ? tough || frac < 0.6 || t.wantDefeat.has(target.defId) : (tough && def?.unique) || frac < 0.35) return u.a;
  }
  return null;
}

function buffBeforeBoss(t: Turn, hostiles: ReturnType<typeof visibleHostiles>): PlayerAction | null {
  const p = player(t.ctx);
  const boss = hostiles.find((h) => t.ctx.ix.actors.get(h.defId)?.unique && cheb(h.pos, p.pos) <= 4);
  if (!boss) return null;
  const key = `buff:${boss.id}`;
  if (t.mem.onceThisArea.has(key)) return null;
  const buff = knownUses(t).find((u) => {
    const pr = itemProfile(t.world, u.def);
    return pr.buff && !pr.selfHarm && !pr.offensive && u.def.useMode !== 'passive';
  });
  if (!buff) return null;
  t.mem.onceThisArea.add(key);
  return buff.a;
}

function fight(t: Turn): PlayerAction | null {
  const { ctx, persona } = t;
  const p = player(ctx);
  const hostiles = visibleHostiles(ctx);
  if (!hostiles.length) return null;
  hostiles.sort((a, b) => cheb(a.pos, p.pos) - cheb(b.pos, p.pos) || a.hp - b.hp);
  const adjacent = hostiles.filter((h) => cheb(h.pos, p.pos) === 1);

  // talkers persuade first (anyone in reach they haven't failed twice on)
  if (persona.fight === 'talk') {
    for (const a of t.legal) {
      if (a.type !== 'persuade') continue;
      const target = hostiles.find((h) => h.id === a.targetId);
      if (!target || t.wantDefeat.has(target.defId)) continue;
      const n = t.mem.persuades.get(target.id) ?? 0;
      if (n >= 2) continue;
      t.mem.persuades.set(target.id, n + 1);
      return a;
    }
  }

  // cautious: back off from melee when there's a ranged option or the fight isn't needed
  if (persona.kite && adjacent.length && !adjacent.some((h) => t.wantDefeat.has(h.defId))) {
    const ranged = (equippedDef(ctx, 'weapon')?.weapon?.range ?? ctx.world.player.unarmed.range) > 1;
    if (ranged || hpFrac(ctx) < 0.7) {
      const away = stepAway(t, hostiles.map((h) => h.pos));
      if (away && t.mem.rng.chance(0.75)) return away;
    }
  }

  const buff = buffBeforeBoss(t, hostiles);
  if (buff) return buff;
  const item = offensiveUse(t, hostiles);
  if (item) return item;

  if (adjacent.length) {
    const target = [...adjacent].sort((a, b) => a.hp - b.hp)[0];
    const atk = t.legal.find((a) => a.type === 'attack' && a.targetId === target.id);
    if (atk) return atk;
    const bump = moveAction(t, dirTo(p.pos, target.pos));
    if (bump) return bump;
  }
  // ranged attack on the nearest visible hostile
  for (const h of hostiles) {
    if (persona.fight === 'avoid' && !t.wantDefeat.has(h.defId) && cheb(h.pos, p.pos) > 3) continue;
    const atk = t.legal.find((a) => a.type === 'attack' && a.targetId === h.id);
    if (atk) return atk;
  }
  // close in: eager bots chase what they see; the others only what they must defeat
  const chase = hostiles.find((h) => {
    if (t.wantDefeat.has(h.defId)) return hpFrac(ctx) > 0.35 || heldHeals(ctx) === 0;
    if (persona.fight !== 'eager') return false;
    const def = ctx.ix.actors.get(h.defId);
    if (def?.unique && hpFrac(ctx) < 0.6 && !t.wantDefeat.has(h.defId)) return false;
    return cheb(h.pos, p.pos) <= 8 && hpFrac(ctx) > 0.3;
  });
  if (chase) {
    const field = pathField(ctx);
    const W = ctx.s.area.map.width;
    const step = firstStep(field, chase.pos.y * W + chase.pos.x, p.pos.y * W + p.pos.x);
    if (step >= 0) {
      const mv = moveAction(t, dirTo(p.pos, idxToPos(step, W)));
      if (mv) return mv;
    }
  }
  // cautious bots slip away from approaching hostiles
  if (persona.fight !== 'eager' && hostiles.some((h) => cheb(h.pos, p.pos) <= 3) && hpFrac(ctx) < 0.6) {
    const away = stepAway(t, hostiles.map((h) => h.pos));
    if (away) return away;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resting, leaving and moving around
// ---------------------------------------------------------------------------

function rest(t: Turn): PlayerAction | null {
  const { ctx } = t;
  const ps = t.world.player;
  if (ps.hpRegenEvery <= 0 || ctx.ix.switches.noNaturalHpRegen) return null;
  if (hpFrac(ctx) >= 0.6 || visibleHostiles(ctx).length) {
    t.mem.restStreak = 0;
    return null;
  }
  // draining resources make resting expensive
  for (const res of vitalResources(t.world)) {
    const r = ctx.ix.resources.get(res)!;
    if (r.perTurn < 0 && (ctx.s.player.resources[res] ?? 0) < r.max * 0.5) return null;
  }
  if (t.mem.restStreak >= 30 * ps.hpRegenEvery) return null;
  t.mem.restStreak++;
  t.mem.lastProgressAt = t.mem.decisions; // resting is progress
  return t.legal.find((a) => a.type === 'wait') ?? null;
}

function lockMet(t: Turn): boolean {
  return !t.objectives.finalArea && t.objectives.lock.length === 0;
}

/** take the way onward when standing on it and the area is done (or the goal lies further on) */
function leave(t: Turn): PlayerAction | null {
  const tr = t.legal.find((a) => a.type === 'transition');
  if (!tr) return null;
  if (readyToLeave(t)) return tr;
  return null;
}

function readyToLeave(t: Turn): boolean {
  if (!lockMet(t)) return false;
  // goal items/actors of this area still visible and reachable? stay (they may be needed later too)
  const { ctx } = t;
  if (t.mem.areaDecisions > AREA_DECISION_CAP || hurry(t)) return true;
  if (t.wantItems.size && ctx.s.area.items.some((fi) => t.wantItems.has(fi.item.defId) && ctx.s.area.seen[fi.pos.y * ctx.s.area.map.width + fi.pos.x])) return false;
  if (!t.persona.exploreFully) return t.mem.areaDecisions > 80 || frontierTiles(ctx).length === 0;
  return false; // explorers leave when navigate() finds nothing left to do
}

interface Candidate {
  /** tile to walk to (or stand next to, for `adjacentOk`) */
  idx: number;
  bonus: number;
  /** act when adjacent (talk, interact) instead of stepping onto it */
  onArrive?: PlayerAction;
}

function navigate(t: Turn): PlayerAction | null {
  const { ctx, mem } = t;
  if (mem.decisions < mem.wanderUntil) return null;
  const p = player(ctx);
  const map = ctx.s.area.map;
  const W = map.width;
  const here = p.pos.y * W + p.pos.x;
  const hostiles = knownHostiles(ctx);
  const avoid = t.persona.fight !== 'eager';
  const field = pathField(ctx, avoid && hostiles.length ? { extraCost: (i) => nearHostileCost(i, W, hostiles) } : {});
  const cands: Candidate[] = [];
  const seen = ctx.s.area.seen;
  const invSpace = ctx.s.player.slots.some((s) => s === null);

  // floor items (wanted ones first)
  for (const fi of ctx.s.area.items) {
    const i = fi.pos.y * W + fi.pos.x;
    if (!seen[i] || mem.blacklist.has(i)) continue;
    const wanted = t.wantItems.has(fi.item.defId);
    if (!invSpace && !wanted) continue;
    cands.push({ idx: i, bonus: wanted ? 60 : 10 });
  }
  // actors to defeat
  for (const a of hostiles) {
    const i = a.pos.y * W + a.pos.x;
    if (mem.blacklist.has(i)) continue;
    if (t.wantDefeat.has(a.defId) && (hpFrac(ctx) > 0.45 || heldHeals(ctx) === 0)) cands.push({ idx: i, bonus: 45 });
  }
  // npcs to talk to
  if (ctx.world.verbs.talk) {
    for (const a of ctx.s.area.actors) {
      if (a.hp <= 0 || a.id === ctx.s.player.actorId || !isNpc(ctx, a) || side(ctx, a) === 'H') continue;
      const i = a.pos.y * W + a.pos.x;
      if (seen[i] !== 2 || mem.blacklist.has(i)) continue;
      const talks = mem.talks.get(a.id) ?? 0;
      const def = ctx.ix.actors.get(a.defId)!;
      const used = new Set(a.npcUsed ?? []);
      const healer = def.npc!.role === 'healer' && !used.has('heal') && hpFrac(ctx) < 0.6;
      const first = !a.talkedTo && talks === 0;
      const again = t.persona.talkAll && talks < 3;
      if (!(healer || first || again)) continue;
      const talk = t.legal.find((x) => x.type === 'talk' && x.targetId === a.id);
      cands.push({ idx: i, bonus: healer ? 25 : first ? 8 : 3, onArrive: talk ?? { type: 'talk', targetId: a.id } });
    }
  }
  // interactable terrain (each tile works once)
  for (let i = 0; i < map.tiles.length; i++) {
    const tile = map.tiles[i];
    if (!tile.terrain || tile.interacted || !seen[i] || mem.blacklist.has(i)) continue;
    const td = ctx.ix.terrains.get(tile.terrain);
    if (!td?.interact) continue;
    if (hpFrac(ctx) < 0.5) continue;
    const pos = idxToPos(i, W);
    cands.push({ idx: i, bonus: 5, onArrive: { type: 'interact', pos } });
  }
  // frontier
  const frontier = frontierTiles(ctx);
  const exitKnown = Number.isFinite(field.dist[map.exit.y * W + map.exit.x]);
  const exploring = t.persona.exploreFully || !lockMet(t) || !exitKnown || t.mem.areaDecisions < 80;
  if (exploring) for (const i of frontier) if (!mem.blacklist.has(i)) cands.push({ idx: i, bonus: 0 });
  // the way onward: when the area is done (or the per-area budget is spent)
  const exitIdx = map.exit.y * W + map.exit.x;
  const canLeave = lockMet(t) && !t.objectives.finalArea;
  if (canLeave && (mem.areaDecisions > AREA_DECISION_CAP || readyToLeave(t))) cands.push({ idx: exitIdx, bonus: 100 });

  // pick the best reachable candidate (adjacency targets: closest neighbour)
  let best: { c: Candidate; cost: number; goal: number; score: number } | null = null;
  for (const c of cands) {
    let goal = c.idx;
    let cost = field.dist[c.idx];
    if (c.onArrive) {
      const pos = idxToPos(c.idx, W);
      const range = c.onArrive.type === 'talk' ? TALK_RANGE : 1;
      if (cheb(pos, p.pos) <= range) {
        const ready = t.legal.find((x) => JSON.stringify(x) === JSON.stringify(c.onArrive));
        if (ready) {
          if (c.onArrive.type === 'talk') mem.talks.set(c.onArrive.targetId, (mem.talks.get(c.onArrive.targetId) ?? 0) + 1);
          if (c.onArrive.type === 'interact') mem.blacklist.add(c.idx);
          mem.target = null;
          return ready;
        }
        if (c.onArrive.type === 'interact' && cheb(pos, p.pos) <= 1) {
          mem.blacklist.add(c.idx);
          continue;
        }
      }
      // walk to the cheapest neighbour
      cost = Infinity;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = pos.x + dx;
          const ny = pos.y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= map.height) continue;
          const j = ny * W + nx;
          if (field.dist[j] < cost) {
            cost = field.dist[j];
            goal = j;
          }
        }
    }
    if (!Number.isFinite(cost)) continue;
    // hysteresis: the current target keeps a small edge so two targets can't flip-flop
    const score = cost - c.bonus - (mem.target?.idx === c.idx ? 3 : 0);
    if (!best || score < best.score) best = { c, cost, goal, score };
  }
  if (!best && canLeave && Number.isFinite(field.dist[exitIdx])) best = { c: { idx: exitIdx, bonus: 0 }, cost: field.dist[exitIdx], goal: exitIdx, score: 0 };
  if (!best && canLeave && exitIdx === here) best = { c: { idx: exitIdx, bonus: 0 }, cost: 0, goal: exitIdx, score: 0 };
  if (!best) return null;
  if (best.goal === here) {
    if (best.c.idx === exitIdx) return t.legal.find((a) => a.type === 'transition') ?? null;
    // standing on the goal tile: nothing more to do there
    mem.blacklist.add(best.c.idx);
    return null;
  }
  // progress check on the current target
  if (!mem.target || mem.target.idx !== best.c.idx) mem.target = { idx: best.c.idx, best: best.cost, since: mem.decisions };
  else if (best.cost < mem.target.best) {
    mem.target.best = best.cost;
    mem.target.since = mem.decisions;
  } else if (mem.decisions - mem.target.since > 25) {
    mem.blacklist.add(best.c.idx);
    mem.target = null;
    return null;
  }
  return stepTowards(t, field, best.goal, here);
}

function nearHostileCost(i: number, W: number, hostiles: { pos: Pos }[]): number {
  const x = i % W;
  const y = (i - x) / W;
  let c = 0;
  for (const h of hostiles) {
    const d = Math.max(Math.abs(h.pos.x - x), Math.abs(h.pos.y - y));
    if (d <= 2) c += 4 - d;
  }
  return c;
}

function stepTowards(t: Turn, field: PathField, goal: number, here: number): PlayerAction | null {
  const W = field.width;
  const step = firstStep(field, goal, here);
  if (step < 0) return null;
  const p = player(t.ctx);
  const mv = moveAction(t, dirTo(p.pos, idxToPos(step, W)));
  if (mv) return mv;
  // a closed door next to us or an actor in the way that isn't bumpable: try the door / any move
  const doorAt = idxToPos(step, W);
  const door = t.legal.find((a) => a.type === 'interact' && a.pos.x === doorAt.x && a.pos.y === doorAt.y);
  return door ?? null;
}

/** nothing to do, or stuck: search now and then, walk somewhere random, or wait */
function wander(t: Turn): PlayerAction {
  const { ctx, mem } = t;
  if (mem.decisions - mem.lastProgressAt > STALL_LIMIT && mem.wanderUntil <= mem.decisions) {
    mem.wanderUntil = mem.decisions + 12;
    mem.lastProgressAt = mem.decisions;
    mem.blacklist.clear();
  }
  // locked in: search for hidden things, then try walking through unexplored space
  if (!lockMet(t) || t.objectives.finalArea) {
    if (ctx.world.verbs.search && mem.decisions - mem.lastSearchAt > 15) {
      mem.lastSearchAt = mem.decisions;
      const s = t.legal.find((a) => a.type === 'search');
      if (s) return s;
    }
    if (mem.decisions >= mem.wanderUntil) {
      const p = player(ctx);
      const W = ctx.s.area.map.width;
      const field = pathField(ctx, { throughUnseen: true });
      let goal = -1;
      let bestD = Infinity;
      for (let i = 0; i < field.dist.length; i++) {
        if (ctx.s.area.seen[i] !== 0 || !Number.isFinite(field.dist[i]) || mem.blacklist.has(i)) continue;
        if (field.dist[i] < bestD) {
          bestD = field.dist[i];
          goal = i;
        }
      }
      if (goal >= 0) {
        const act = stepTowards(t, field, goal, p.pos.y * W + p.pos.x);
        if (act) return act;
        mem.blacklist.add(goal);
      }
      // hunt any hostile remembered on the map (keys are often carried or guarded)
      const prey = knownHostiles(ctx)[0] ?? ctx.s.area.actors.find((a) => a.hp > 0 && side(ctx, a) === 'H');
      if (prey) {
        const f2 = pathField(ctx, { throughUnseen: true });
        const act = stepTowards(t, f2, prey.pos.y * W + prey.pos.x, p.pos.y * W + p.pos.x);
        if (act) return act;
      }
    }
  }
  const moves = t.legal.filter((a) => a.type === 'move');
  if (moves.length && mem.rng.chance(0.8)) return mem.rng.pick(moves);
  return t.legal.find((a) => a.type === 'wait') ?? t.legal[0];
}

/** the strength stat the bot cares about (for tests / reports) */
export function botPower(state: GameState, world: WorldSpec): { hp: number; attack: number; ac: number } {
  const ctx = botCtx(world, state);
  const p = player(ctx);
  return { hp: maxHp(ctx, p), attack: weaponScore(ctx, equippedDef(ctx, 'weapon')), ac: getStat(ctx, p, 'ac') };
}
