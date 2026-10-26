/**
 * "Clearer controls & goals" (PLAN backlog, user playtest of Lowmoor): pure builders for the goal
 * tracker, the context action bar, locked-exit explanations and the onboarding card. Everything is
 * derived from the world spec + game state and rendered in plain words through the UI catalog, with
 * genre words from the world's vocabulary and names from its content. DOM-free and unit-tested
 * (tests/client/guide.test.ts).
 */
import type { Condition, Effect, WorldSpec } from '../schema/world';
import type { GameState, PlayerAction } from '../engine/types';
import { QUICK_SLOTS } from '../engine/types';
import { describeItemDef, persuadeOdds, playerSheet, type PlayerSheet } from '../engine/index';
import { catalog, formatMessage, getLanguage, listJoin, normalizeLanguage, t as tUi, type MessageKey, type MessageParams } from './i18n/index';
import type { ContextActionView, ConditionLineView, GoalStepView, GoalView, OnboardingView } from './ui/viewmodel';

// ---------------------------------------------------------------------------
// language: the goal and onboarding lines read in the WORLD's language when it differs from the UI
// language (an English world in a Norwegian UI must not read "… er put in the dirt"); the UI chrome
// around them stays in the UI language (issues/M5-mixed-language-world-ui.md)
// ---------------------------------------------------------------------------

let textLang: string | null = null;

/** the catalog language of `world` when it differs from the UI language and has a catalog, else null */
export function worldTextLanguage(world: Pick<WorldSpec, 'meta'>): string | null {
  const lang = normalizeLanguage(world.meta.language || 'en');
  return lang !== getLanguage() && catalog(lang) ? lang : null;
}

/** run `fn` with this module's plain-word lines in the world's language (see worldTextLanguage) */
export function inWorldLanguage<T>(world: Pick<WorldSpec, 'meta'>, fn: () => T): T {
  const lang = worldTextLanguage(world);
  if (!lang) return fn();
  const prev = textLang;
  textLang = lang;
  try {
    return fn();
  } finally {
    textLang = prev;
  }
}

function t(key: MessageKey, params?: MessageParams): string {
  if (!textLang) return tUi(key, params);
  const tpl = catalog(textLang)?.[key] ?? catalog('en')?.[key];
  return tpl === undefined ? key : formatMessage(tpl, params, textLang);
}

/** true / false, or null when it can't be known from here (chance, someone else's stats) */
export type Truth = boolean | null;

type Cmp = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';

function compare(a: number, cmp: Cmp, b: number): boolean {
  switch (cmp) {
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
    case 'eq':
      return a === b;
    case 'gte':
      return a >= b;
    case 'gt':
      return a > b;
  }
  return false;
}

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

/** "colours-spilled" → "colours spilled" (counters and flags only have ids) */
export function humanizeId(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** a flag's or counter's player-facing name: the world's goal label, else the humanised id */
export function stateLabel(world: WorldSpec, id: string): string {
  return ownLabel(world, id) ?? humanizeId(id);
}

/**
 * The world's own goal label for a flag/counter id, if it has one. Own keys only: ids come from
 * untrusted world files, and "constructor" is a valid id (issues/M5-goal-label-prototype-key.md).
 */
export function ownLabel(world: WorldSpec, id: string): string | undefined {
  const labels = world.goal.labels as Record<string, unknown> | undefined;
  if (!labels || typeof labels !== 'object' || !Object.prototype.hasOwnProperty.call(labels, id)) return undefined;
  const l = labels[id];
  return typeof l === 'string' && l.trim() ? l.trim() : undefined;
}

const itemNameCache = new WeakMap<GameState, Map<string, string>>();
const sheetCache = new WeakMap<GameState, PlayerSheet>();

function sheetOf(state: GameState): PlayerSheet | null {
  let s = sheetCache.get(state);
  if (!s) {
    try {
      s = playerSheet(state);
    } catch {
      return null;
    }
    sheetCache.set(state, s);
  }
  return s;
}

/** an item's name as the player knows it (an unknown potion keeps its appearance) */
export function itemName(world: WorldSpec, state: GameState | undefined, id: string): string {
  if (state) {
    let m = itemNameCache.get(state);
    if (!m) itemNameCache.set(state, (m = new Map()));
    const hit = m.get(id);
    if (hit) return hit;
    try {
      const name = describeItemDef(state, id).name;
      m.set(id, name);
      return name;
    } catch {
      /* world not registered (tests without a game): fall through */
    }
  }
  const def = world.items.find((i) => i.id === id);
  if (!def) return humanizeId(id);
  return def.knowledge === 'unknown' ? t('cond.unknownItem') : def.name;
}

function actorName(world: WorldSpec, id: string): string {
  return world.actors.find((a) => a.id === id)?.name ?? humanizeId(id);
}

function statusName(world: WorldSpec, id: string): string {
  return world.statuses.find((s) => s.id === id)?.name ?? humanizeId(id);
}

function terrainName(world: WorldSpec, id: string): string {
  return world.terrains.find((x) => x.id === id)?.name ?? humanizeId(id);
}

function statName(world: WorldSpec, stat: string): string {
  const v = world.vocabulary.stats as Record<string, { name: string } | undefined>;
  if (v[stat]) return v[stat]!.name;
  const r = world.resources.find((x) => x.id === stat);
  if (r) return r.name;
  if (stat === 'speed') return t('stat.speed');
  if (stat === 'sight') return t('stat.sight');
  return humanizeId(stat);
}

function areaTitle(world: WorldSpec, area: number): string {
  const plan = world.areas[area];
  return t('cond.areaName', { area: world.vocabulary.area, n: area + 1, name: plan?.name ?? '' });
}

// ---------------------------------------------------------------------------
// evaluation (client-side, read-only; mirrors engine/conditions.ts for what the player can know)
// ---------------------------------------------------------------------------

/** an own-key read of an id-keyed record (ids are untrusted: "constructor" is a valid id) */
function own<T>(rec: Record<string, T> | undefined, id: string, fallback: T): T {
  return rec && Object.prototype.hasOwnProperty.call(rec, id) ? rec[id] : fallback;
}

function counterOf(state: GameState, id: string): number {
  const v = own<unknown>(state.counters, id, 0);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function defeatedOf(state: GameState, id: string): number {
  const v = own<unknown>(state.defeated, id, 0);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function player(state: GameState) {
  return state.area.actors.find((a) => a.id === state.player.actorId);
}

function itemCount(state: GameState, defId: string): number {
  let n = 0;
  for (const it of state.player.slots) if (it && it.defId === defId) n += it.count ?? 1;
  return n;
}

function aboutPlayer(who: string): boolean {
  return who === 'player' || who === 'self';
}

function statValue(state: GameState, stat: string, asPct: boolean): number | null {
  const s = sheetOf(state);
  if (!s) return null;
  let v: number | undefined;
  let max: number | undefined;
  switch (stat) {
    case 'str':
    case 'dex':
    case 'int':
    case 'ac':
    case 'speed':
    case 'sight':
      v = s[stat];
      break;
    case 'hp':
      v = s.hp;
      max = s.maxHp;
      break;
    case 'mp':
      v = s.mp;
      max = s.maxMp;
      break;
    default: {
      const r = s.resources.find((x) => x.id === stat);
      if (!r) return null;
      v = r.value;
      max = r.max;
    }
  }
  if (v === undefined) return null;
  if (!asPct) return v;
  return max && max > 0 ? (v / max) * 100 : 0;
}

/** evaluate a condition for the player, as far as the client can tell */
export function evalCondition(state: GameState, c: Condition, depth = 0): Truth {
  if (depth > 32) return null;
  switch (c.type) {
    case 'all': {
      let unknown = false;
      for (const x of c.of) {
        const v = evalCondition(state, x, depth + 1);
        if (v === false) return false;
        if (v === null) unknown = true;
      }
      return unknown ? null : true;
    }
    case 'any': {
      let unknown = false;
      for (const x of c.of) {
        const v = evalCondition(state, x, depth + 1);
        if (v === true) return true;
        if (v === null) unknown = true;
      }
      return unknown ? null : false;
    }
    case 'not': {
      const v = evalCondition(state, c.cond, depth + 1);
      return v === null ? null : !v;
    }
    case 'has_item':
      return aboutPlayer(c.who) ? itemCount(state, c.item) >= (c.count ?? 1) : null;
    case 'has_status': {
      if (!aboutPlayer(c.who)) return null;
      return !!player(state)?.statuses.some((s) => s.id === c.status);
    }
    case 'flag':
      return own(state.flags, c.flag, false) === (c.value ?? true);
    case 'counter':
      return compare(counterOf(state, c.counter), c.cmp, c.value);
    case 'actor_defeated':
      return defeatedOf(state, c.actor) >= (c.count ?? 1);
    case 'in_area':
      return state.area.index === c.area;
    case 'turn':
      return compare(state.turn, c.cmp, c.value);
    case 'stat': {
      if (!aboutPlayer(c.who)) return null;
      const v = statValue(state, c.stat, !!c.asPercentOfMax);
      if (v === null) return null;
      const target = c.asPercentOfMax && Math.abs(c.value) <= 1 ? c.value * 100 : c.value;
      return compare(v, c.cmp, target);
    }
    case 'on_terrain': {
      if (!aboutPlayer(c.who)) return null;
      const p = player(state);
      if (!p) return null;
      const m = state.area.map;
      return m.tiles[p.pos.y * m.width + p.pos.x]?.terrain === c.terrain;
    }
    case 'chance':
      return null;
    case 'always':
      return true;
  }
  return null;
}

// ---------------------------------------------------------------------------
// plain words
// ---------------------------------------------------------------------------

function cmpWords(cmp: Cmp, value: number | string): string {
  return t(`cond.cmp.${cmp}` as const, { value });
}

/** a stat condition's target: "30%" for asPercentOfMax (0.3 and 30 both mean 30 %), else the number */
function statTarget(c: { asPercentOfMax?: boolean; value: number }): number | string {
  if (!c.asPercentOfMax) return c.value;
  return `${Math.round(Math.abs(c.value) <= 1 ? c.value * 100 : c.value)}%`;
}

/** a single condition as a statement ("You carry the Speech Notebook") */
export function leafText(world: WorldSpec, state: GameState | undefined, c: Condition): string {
  switch (c.type) {
    case 'has_item': {
      const item = itemName(world, state, c.item);
      if (!aboutPlayer(c.who)) return t('cond.hasItemOther', { item });
      return (c.count ?? 1) > 1 ? t('cond.hasItemCount', { item, count: c.count ?? 1 }) : t('cond.hasItem', { item });
    }
    case 'has_status':
      return aboutPlayer(c.who) ? t('cond.hasStatus', { status: statusName(world, c.status) }) : t('cond.hasStatusOther', { status: statusName(world, c.status) });
    case 'flag': {
      // a world label is already a statement ("The farewell speech is given"): shown as is, not
      // wrapped in “…” has happened (issues/M5-goal-flag-label-double-wrapped.md)
      const label = ownLabel(world, c.flag);
      if (label) return c.value === false ? t('cond.flagNotLabeled', { label }) : label;
      return c.value === false ? t('cond.flagNot', { flag: humanizeId(c.flag) }) : t('cond.flag', { flag: humanizeId(c.flag) });
    }
    case 'counter':
      return t('cond.counter', { counter: stateLabel(world, c.counter), cmp: cmpWords(c.cmp, c.value) });
    case 'actor_defeated': {
      const actor = actorName(world, c.actor);
      const defeated = world.vocabulary.defeated;
      return (c.count ?? 1) > 1 ? t('cond.defeatedCount', { actor, defeated, count: c.count ?? 1 }) : t('cond.defeated', { actor, defeated });
    }
    case 'in_area':
      return t('cond.inArea', { where: areaTitle(world, c.area) });
    case 'turn':
      return c.cmp === 'lt' || c.cmp === 'lte' ? t('cond.turnBefore', { n: c.cmp === 'lte' ? c.value + 1 : c.value }) : t('cond.turnReach', { n: c.cmp === 'gt' ? c.value + 1 : c.value });
    case 'stat': {
      const stat = statName(world, c.stat);
      const cmp = cmpWords(c.cmp, statTarget(c));
      return aboutPlayer(c.who) ? t('cond.stat', { stat, cmp }) : t('cond.statOther', { stat, cmp });
    }
    case 'on_terrain':
      return t('cond.onTerrain', { terrain: terrainName(world, c.terrain) });
    case 'chance':
      return t('cond.chance', { pct: Math.round(c.p * 100) });
    case 'always':
      return t('cond.always');
    default:
      return '';
  }
}

/** a single condition as something to do next ("Get the Speech Notebook") */
export function stepText(world: WorldSpec, state: GameState | undefined, c: Condition): string {
  switch (c.type) {
    case 'has_item': {
      const item = itemName(world, state, c.item);
      const count = c.count ?? 1;
      if (count <= 1) return t('step.getItem', { item });
      return t('step.getItemCount', { item, count, have: state ? itemCount(state, c.item) : 0 });
    }
    case 'actor_defeated':
      return t('step.defeat', { actor: actorName(world, c.actor), defeated: world.vocabulary.defeated });
    case 'in_area':
      return t('step.reach', { where: world.areas[c.area]?.name ?? areaTitle(world, c.area) });
    case 'flag': {
      const label = ownLabel(world, c.flag);
      if (label) return c.value === false ? t('step.avoidFlagLabeled', { label }) : t('step.flagLabeled', { label });
      return c.value === false ? t('step.avoidFlag', { flag: humanizeId(c.flag) }) : t('step.flag', { flag: humanizeId(c.flag) });
    }
    case 'counter':
      return t('step.counter', { counter: stateLabel(world, c.counter), cmp: cmpWords(c.cmp, c.value), now: state ? counterOf(state, c.counter) : 0 });
    case 'has_status':
      return t('step.status', { status: statusName(world, c.status) });
    case 'stat':
      return t('step.stat', { stat: statName(world, c.stat), cmp: cmpWords(c.cmp, statTarget(c)) });
    case 'on_terrain':
      return t('step.terrain', { terrain: terrainName(world, c.terrain) });
    case 'turn':
      return t('step.turn', { n: c.cmp === 'gt' ? c.value + 1 : c.value });
    default:
      return leafText(world, state, c);
  }
}

/** progress in plain words for counters and multi-item conditions ("now 1") */
function nowText(world: WorldSpec, state: GameState | undefined, c: Condition): string | undefined {
  if (!state) return undefined;
  if (c.type === 'counter') return t('cond.now', { value: counterOf(state, c.counter) });
  if (c.type === 'has_item' && (c.count ?? 1) > 1 && aboutPlayer(c.who)) return t('cond.now', { value: itemCount(state, c.item) });
  if (c.type === 'actor_defeated' && (c.count ?? 1) > 1) return t('cond.now', { value: defeatedOf(state, c.actor) });
  if (c.type === 'turn') return t('cond.nowTurn', { value: state.turn });
  void world;
  return undefined;
}

/**
 * A condition as plain-word lines: a top-level "all" lists its parts; "any" gets a "One of these:"
 * heading, "not" an "Avoid:" heading (or one "Never: …" line for a single statement). `done` is
 * filled in when the state is given.
 */
export function conditionLines(world: WorldSpec, state: GameState | undefined, cond: Condition, depth = 0): ConditionLineView[] {
  const out: ConditionLineView[] = [];
  const done = (c: Condition): boolean | null => (state ? evalCondition(state, c) : null);
  const walk = (c: Condition, d: number, top: boolean) => {
    if (d > 8) return;
    switch (c.type) {
      case 'all':
        if (top) c.of.forEach((x) => walk(x, d, false));
        else {
          out.push({ text: t('cond.all'), depth: d, group: true, done: done(c) });
          c.of.forEach((x) => walk(x, d + 1, false));
        }
        return;
      case 'any':
        if (c.of.length === 1) return walk(c.of[0], d, top);
        out.push({ text: t('cond.any'), depth: d, group: true, done: done(c) });
        c.of.forEach((x) => walk(x, d + 1, false));
        return;
      case 'not': {
        const inner = c.cond;
        if (inner.type !== 'all' && inner.type !== 'any' && inner.type !== 'not') {
          out.push({ text: t('cond.never', { text: leafText(world, state, inner) }), depth: d, done: done(c), ...nowField(inner) });
          return;
        }
        out.push({ text: t('cond.avoid'), depth: d, group: true, done: done(c) });
        (inner.type === 'not' ? [inner.cond] : inner.of).forEach((x) => walk(x, d + 1, false));
        return;
      }
      case 'always':
        if (top && depth === 0) out.push({ text: leafText(world, state, c), depth: d, done: true });
        return;
      default:
        out.push({ text: withSource(c, leafText(world, state, c)), depth: d, done: done(c), ...nowField(c) });
    }
  };
  // a story flag names the item that makes it happen ("… — with The Prompter's Last Cue")
  const withSource = (c: Condition, text: string): string => {
    if (c.type !== 'flag') return text;
    const src = flagSource(world, c.flag, c.value ?? true);
    return src?.kind === 'item' ? t('cond.via', { text, item: itemName(world, state, src.id) }) : text;
  };
  const nowField = (c: Condition): { now?: string } => {
    const n = nowText(world, state, c);
    return n ? { now: n } : {};
  };
  walk(cond, depth, true);
  return out;
}

/**
 * leaves of `c` that still have to become true, in order (chance and "not" parts are skipped).
 * With `world`, a story flag the player already has in hand (its item carried, its own conditions
 * on the player met: see inHand) counts as nearly done, so the branch the player can finish with
 * what they carry wins over a fight (issues/M5-goal-route-items-unseen.md).
 */
export function unmetLeaves(state: GameState, c: Condition, depth = 0, world?: WorldSpec): Condition[] {
  if (depth > 32) return [];
  switch (c.type) {
    case 'all':
      return c.of.flatMap((x) => unmetLeaves(state, x, depth + 1, world));
    case 'any': {
      if (evalCondition(state, c) === true) return [];
      // pursue the branch closest to done: fewest leaves still out of hand, then fewest unmet
      // leaves; on a tie the branch with fewer opaque leaves (story flags, counters) wins over one
      // the player can act on directly (issues/M5-final-step-opaque-flag.md), then the first listed
      const rank = (u: Condition[]) => {
        const held = world ? u.filter((x) => inHand(world, state, x)).length : 0;
        return [u.length - held, u.length, opaqueCount(u) - held];
      };
      let best: Condition[] | null = null;
      let bestRank: number[] = [];
      for (const x of c.of) {
        const u = unmetLeaves(state, x, depth + 1, world);
        if (!u.length) continue;
        const r = rank(u);
        if (!best || r[0] < bestRank[0] || (r[0] === bestRank[0] && (r[1] < bestRank[1] || (r[1] === bestRank[1] && r[2] < bestRank[2])))) {
          best = u;
          bestRank = r;
        }
      }
      return best ?? [];
    }
    case 'not':
    case 'chance':
    case 'always':
      return [];
    default:
      return evalCondition(state, c) === true ? [] : [c];
  }
}

/** a leaf about someone other than the player (the target of a use, an NPC): not the player's to do */
function aboutOther(c: Condition): boolean {
  return 'who' in c && typeof c.who === 'string' && !aboutPlayer(c.who);
}

/** the leaves of an item's / tile's own condition the player still has to meet (target checks aside) */
function playerNeeds(state: GameState, cond: Condition | undefined): Condition[] {
  return cond ? unmetLeaves(state, cond).filter((x) => !aboutOther(x)) : [];
}

/**
 * A story flag the player can set right now with what they carry: its source item is in the bag and
 * the item's own conditions on the player hold (a condition on the target is checked on use).
 */
export function inHand(world: WorldSpec, state: GameState, c: Condition): boolean {
  if (c.type !== 'flag') return false;
  const src = flagSource(world, c.flag, c.value ?? true);
  if (!src || src.kind !== 'item' || itemCount(state, src.id) < 1) return false;
  return playerNeeds(state, src.condition).length === 0;
}

/** every leaf of `c` still unmet, across all branches ("not" parts skipped) */
function allUnmetLeaves(state: GameState, c: Condition, depth = 0): Condition[] {
  if (depth > 32) return [];
  switch (c.type) {
    case 'all':
    case 'any':
      return evalCondition(state, c) === true ? [] : c.of.flatMap((x) => allUnmetLeaves(state, x, depth + 1));
    case 'not':
    case 'chance':
    case 'always':
      return [];
    default:
      return evalCondition(state, c) === true ? [] : [c];
  }
}

/**
 * Items that lie in the current area and that a still-open way to win needs: an item the goal asks
 * for, the item that sets a story flag the goal asks for, or an item that item's use needs. There is
 * no going back, so the tracker names them while the player can still pick them up (Pianissimo's
 * Prompter's Last Cue, issues/M5-goal-route-items-unseen.md). `goal` is the goal line it serves.
 */
export function routeItemsHere(world: WorldSpec, state: GameState): { item: string; name: string; goal: string }[] {
  const wanted = new Map<string, Condition>();
  const want = (item: string, leaf: Condition) => {
    if (!wanted.has(item) && itemCount(state, item) < 1) wanted.set(item, leaf);
  };
  for (const leaf of allUnmetLeaves(state, world.goal.win)) {
    if (leaf.type === 'has_item' && aboutPlayer(leaf.who)) want(leaf.item, leaf);
    else if (leaf.type === 'flag') {
      const src = flagSource(world, leaf.flag, leaf.value ?? true);
      if (src?.kind === 'item') want(src.id, leaf);
      if (src?.condition) {
        for (const x of allUnmetLeaves(state, src.condition)) if (x.type === 'has_item' && aboutPlayer(x.who)) want(x.item, leaf);
      }
    }
  }
  if (!wanted.size) return [];
  const out: { item: string; name: string; goal: string }[] = [];
  const seen = new Set<string>();
  for (const f of state.area.items ?? []) {
    const id = f.item.defId;
    const leaf = wanted.get(id);
    if (!leaf || seen.has(id)) continue;
    seen.add(id);
    out.push({ item: id, name: itemName(world, state, id), goal: leafText(world, state, leaf) });
  }
  return out;
}

/** a story flag or counter: a state the player cannot read as an action by itself */
function isOpaque(c: Condition): boolean {
  return c.type === 'flag' || c.type === 'counter';
}

function opaqueCount(cs: readonly Condition[]): number {
  let n = 0;
  for (const c of cs) if (isOpaque(c)) n++;
  return n;
}

type FlagSource = { kind: 'item' | 'terrain'; id: string; condition?: Condition };

/** the item (on use) or terrain (interaction) whose effects set `flag` to `value`, if any */
export function flagSource(world: WorldSpec, flag: string, value = true): FlagSource | null {
  const sets = (effects: readonly Effect[] | undefined) => !!effects?.some((e) => e.type === 'set_flag' && e.flag === flag && (e.value ?? true) === value);
  for (const it of world.items) {
    if (sets(it.onUse?.effects)) return { kind: 'item', id: it.id, ...(it.onUse?.condition ? { condition: it.onUse.condition } : {}) };
  }
  for (const tr of world.terrains) {
    if (sets(tr.interact?.effects)) return { kind: 'terrain', id: tr.id, ...(tr.interact?.condition ? { condition: tr.interact.condition } : {}) };
  }
  return null;
}

/**
 * A leaf as the concrete thing to do. A story flag is replaced by what makes it happen: the item
 * that sets it (get it → meet its condition → use it) or the tile to use. "Make “The farewell speech
 * is given” happen" becomes "Mags Calloway must be left speechless", then "Use Junie's Speech
 * Notebook" (issues/M5-final-step-opaque-flag.md).
 */
export function actionableStep(world: WorldSpec, state: GameState, c: Condition, depth = 0): string {
  if (c.type === 'flag' && depth < 4) {
    const src = flagSource(world, c.flag, c.value ?? true);
    if (src) {
      if (src.kind === 'item' && itemCount(state, src.id) < 1) return t('step.getItem', { item: itemName(world, state, src.id) });
      // a check on the use's target (the rig worn down to half) is not a step of its own
      const need = playerNeeds(state, src.condition);
      if (need.length) return actionableStep(world, state, need[0], depth + 1);
      return t('ctx.use', { name: src.kind === 'item' ? itemName(world, state, src.id) : terrainName(world, src.id) });
    }
  }
  return stepText(world, state, c);
}

// ---------------------------------------------------------------------------
// goal tracker
// ---------------------------------------------------------------------------

function onExitTile(state: GameState): boolean {
  const p = player(state);
  if (!p) return false;
  const m = state.area.map;
  if (p.pos.x === m.exit.x && p.pos.y === m.exit.y) return true;
  return m.tiles[p.pos.y * m.width + p.pos.x]?.kind === 'transition';
}

function exitSeen(state: GameState): boolean {
  const m = state.area.map;
  return ((state.area.seen as ArrayLike<number>)[m.exit.y * m.width + m.exit.x] ?? 0) > 0;
}

/** the concrete next thing to do */
function baseStep(world: WorldSpec, state: GameState): GoalStepView {
  const quest = state.quests.find((q) => q.status === 'active');
  if (quest) return { kind: 'quest', text: quest.title, ...(quest.description ? { detail: quest.description } : {}) };
  const idx = state.area.index;
  const plan = world.areas[idx];
  const last = idx >= world.areas.length - 1;
  if (plan && !last) {
    const way = plan.transitionName;
    if (plan.transitionRequires) {
      const need = unmetLeaves(state, plan.transitionRequires);
      if (need.length) return { kind: 'unlock', text: actionableStep(world, state, need[0]), detail: t('goal.step.unlockFor', { way }) };
      if (evalCondition(state, plan.transitionRequires) === false) {
        return { kind: 'unlock', text: t('goal.step.unlockUnknown'), detail: t('goal.step.unlockFor', { way }) };
      }
    }
    if (onExitTile(state)) return { kind: 'exit', text: t('goal.step.takeExit', { way }) };
    if (exitSeen(state)) return { kind: 'exit', text: t('goal.step.goToExit', { way }) };
    return { kind: 'explore', text: t('goal.step.findExit', { area: plan.name }), detail: t('goal.step.findExitDetail', { way }) };
  }
  const need = unmetLeaves(state, world.goal.win, 0, world);
  if (need.length) return { kind: 'final', text: actionableStep(world, state, need[0]), ...(need.length > 1 ? { detail: t('goal.step.more', { n: need.length - 1 }) } : {}) };
  return { kind: 'final', text: world.goal.summary };
}

/**
 * The concrete next thing to do, plus "Also here: …" for items in this area that a way to win still
 * needs and the step does not already name (issues/M5-goal-route-items-unseen.md).
 */
export function currentStep(world: WorldSpec, state: GameState): GoalStepView {
  const step = baseStep(world, state);
  if (step.kind === 'quest') return step;
  const also = routeItemsHere(world, state)
    .filter((r) => !step.text.includes(r.name))
    .slice(0, 2)
    .map((r) => t('goal.step.alsoHere', { item: r.name, goal: r.goal }));
  if (!also.length) return step;
  // a typographic separator, as on item cards (common.ts), not words
  const detail = [step.detail, ...also].filter((x): x is string => !!x).join(' · ');
  return { ...step, detail };
}

/** the plain-word lines for what this area's way on still needs, or null when open / last area */
export function exitNeeds(world: WorldSpec, state: GameState): GoalView['exitNeeds'] {
  const plan = world.areas[state.area.index];
  if (!plan?.transitionRequires || state.area.index >= world.areas.length - 1) return null;
  if (evalCondition(state, plan.transitionRequires) === true) return null;
  return { way: plan.transitionName, lines: conditionLines(world, state, plan.transitionRequires) };
}

/** "you need the Speech Notebook" — why the way on is locked, in one line */
export function lockedReason(world: WorldSpec, state: GameState): string | null {
  const plan = world.areas[state.area.index];
  if (!plan?.transitionRequires) return null;
  const need = unmetLeaves(state, plan.transitionRequires);
  const texts = need.map((c) => stepText(world, state, c));
  if (!texts.length) return evalCondition(state, plan.transitionRequires) === true ? null : t('goal.step.unlockUnknown');
  return listJoin(texts.slice(0, 3), 'and');
}

export function loseLines(world: WorldSpec, state?: GameState): ConditionLineView[] {
  const hp = world.vocabulary.stats.hp.name;
  const out: ConditionLineView[] = [{ text: t('goal.lose.hp', { hp }), depth: 0, done: null }];
  for (const r of world.resources) if (r.emptyIsDeath) out.push({ text: t('goal.lose.resource', { resource: r.name }), depth: 0, done: null });
  if (world.goal.lose) for (const l of conditionLines(world, state, world.goal.lose)) out.push({ ...l, done: l.group ? null : l.done ? true : null });
  return out;
}

export function goalView(world: WorldSpec, state: GameState): GoalView {
  return {
    summary: world.goal.summary,
    step: currentStep(world, state),
    win: conditionLines(world, state, world.goal.win),
    lose: loseLines(world, state),
    exitNeeds: exitNeeds(world, state),
    progress: t('goal.progress', { area: world.vocabulary.area, n: state.area.index + 1, count: world.areas.length }),
  };
}

// ---------------------------------------------------------------------------
// context action bar
// ---------------------------------------------------------------------------

export interface ContextInput {
  /** engine legalActions(state) */
  legal: readonly PlayerAction[];
  /** the usable tile next to the player (terrain interaction), if any */
  interact?: { name: string } | null;
  /** the way on is open from where the player stands */
  canTransition: boolean;
}

function nearest<T extends { pos: { x: number; y: number } }>(xs: T[], p: { x: number; y: number }): T | undefined {
  return [...xs].sort((a, b) => Math.max(Math.abs(a.pos.x - p.x), Math.abs(a.pos.y - p.y)) - Math.max(Math.abs(b.pos.x - p.x), Math.abs(b.pos.y - p.y)))[0];
}

/** a person's name without the title or epithet after a comma, dash or parenthesis */
export function shortName(name: string): string {
  const cut = name.split(/\s*(?:,|\s[—–-]\s|\()/)[0]?.trim();
  return cut ? cut : name.trim();
}

/**
 * The buttons of the context action bar, most relevant first. Contextual ones (exit, pick up, talk,
 * persuade, use) appear only when they apply; search, sneak and wait are always offered when the
 * world has them, so touch play never needs a keyboard.
 */
/** below this share of health the open exit button glows */
const LOW_HP_ESCAPE = 0.35;

export function contextActions(world: WorldSpec, state: GameState, x: ContextInput): ContextActionView[] {
  if (state.status !== 'playing' || state.pendingChoice || state.player.pendingPerkChoice) return [];
  const out: ContextActionView[] = [];
  const p = player(state);
  if (!p) return [];
  const plan = world.areas[state.area.index];
  const last = state.area.index >= world.areas.length - 1;

  if (plan && !last && onExitTile(state)) {
    // at low health the way on is the escape (a playtest death came standing on an open exit)
    const low = p.hp < p.maxHp * LOW_HP_ESCAPE;
    if (x.canTransition) out.push({ id: 'exit', label: t('ctx.exit', { way: plan.transitionName }), key: '>', primary: true, ...(low ? { urgent: true } : {}) });
    else {
      const why = lockedReason(world, state);
      out.push({ id: 'exit', label: t('ctx.exitLocked', { way: plan.transitionName }), key: '>', blocked: why ? t('invalid.exitLocked', { way: plan.transitionName, needs: why }) : t('ctx.exitLockedPlain', { way: plan.transitionName }) });
    }
  }

  const here = state.area.items.filter((fi) => fi.pos.x === p.pos.x && fi.pos.y === p.pos.y);
  if (here.length && x.legal.some((a) => a.type === 'pickup')) {
    const first = itemName(world, state, here[0].item.defId);
    out.push({ id: 'pickup', label: t('ctx.pickup', { item: first, more: here.length - 1 }), key: 'g', primary: true });
  }

  const actorsFor = (type: 'talk' | 'persuade') =>
    x.legal
      .filter((a): a is { type: 'talk' | 'persuade'; targetId: string } => a.type === type)
      .map((a) => state.area.actors.find((ac) => ac.id === a.targetId))
      .filter((a): a is NonNullable<typeof a> => !!a);
  // the name without its title ("Hedda Imboden, Head Housekeeper" → "Hedda Imboden"): a button
  // label has little room on a phone (issues/M5-phone-talk-pushes-wait.md)
  const nameOf = (a: { defId: string }) => shortName(world.actors.find((d) => d.id === a.defId)?.name ?? t('common.someone'));
  if (world.verbs.talk) {
    const who = nearest(actorsFor('talk'), p.pos);
    if (who) out.push({ id: 'talk', label: t('ctx.talk', { name: nameOf(who) }), key: 't', primary: true });
  }
  if (world.verbs.persuade) {
    // persuasion is the non-violent answer to someone hostile; everyone else gets "Talk"
    const who = nearest(actorsFor('persuade').filter((a) => a.faction === 'hostile' && !a.allyOf), p.pos);
    if (who) {
      // the odds, so a failed attempt is not a mystery (FABLE-GAMEPLAY-REVIEW.md §1.4)
      const odds = persuadeOdds(state, who.id);
      const label = odds === null ? t('ctx.persuade', { name: nameOf(who) }) : t('ctx.persuadeOdds', { name: nameOf(who), pct: Math.round(odds * 100) });
      out.push({ id: 'persuade', label, key: 'p' });
    }
  }
  if (x.interact) out.push({ id: 'interact', label: t('ctx.use', { name: x.interact.name }), key: 'Enter', primary: true });
  if (world.verbs.search) out.push({ id: 'search', label: t('ctx.search'), key: 'f', secondary: true });
  if (world.verbs.sneak) out.push({ id: 'sneak', label: state.player.sneaking ? t('ctx.sneakStop') : t('ctx.sneak'), key: 'c', secondary: true });
  out.push({ id: 'wait', label: t('ctx.wait'), key: '.', secondary: true });
  return out;
}

// ---------------------------------------------------------------------------
// onboarding
// ---------------------------------------------------------------------------

/** a line of the onboarding card's "how conflict works" section, with the key that does it */
export interface ConflictEntry {
  text: string;
  /** keyboard key for the verb ('p', 't', 'c', 'f'), shown in keyboard/mouse mode */
  key?: string;
}

/** the equipped weapon's reach when it hits from more than one tile away */
function rangedWeapon(world: WorldSpec, state: GameState | undefined): { item: string; range: number; key?: string } | null {
  if (!state) return null;
  const slot = state.player.equipped?.weapon;
  if (slot === null || slot === undefined) return null;
  const inst = state.player.slots[slot];
  const def = inst ? world.items.find((i) => i.id === inst.defId) : undefined;
  const range = def?.weapon?.range ?? 1;
  // a weapon in a quick slot is aimed with its key (issues/M5-ranged-keyboard-fire.md)
  const key = slot >= 0 && slot < QUICK_SLOTS ? String(slot + 1) : undefined;
  return def && range > 1 ? { item: itemName(world, state, def.id), range, key } : null;
}

/**
 * How conflict works in this world, from its data (non-violent or not, verbs, health word), each
 * verb with its key (issues/M5-onboarding-verb-keys.md). With a state, a weapon that reaches
 * further than the next tile gets its own line: a gunslinger does not have to walk into anyone.
 */
export function conflictEntries(world: WorldSpec, state?: GameState): ConflictEntry[] {
  const v = world.vocabulary;
  const params = { conflict: v.conflict, hp: v.stats.hp.name, defeated: v.defeated };
  const out: ConflictEntry[] = [{ text: world.meta.nonViolent ? t('onboard.conflict.nonViolent', params) : t('onboard.conflict.violent', params) }];
  out.push({ text: t('onboard.conflict.weapon', params) });
  const ranged = rangedWeapon(world, state);
  if (ranged) {
    out.push(
      ranged.key
        ? { text: t('onboard.conflict.rangedKey', { ...params, item: ranged.item, range: ranged.range, key: ranged.key }), key: ranged.key }
        : { text: t('onboard.conflict.ranged', { ...params, item: ranged.item, range: ranged.range }) },
    );
  }
  if (world.verbs.persuade) out.push({ text: t('onboard.verb.persuade'), key: 'p' });
  if (world.verbs.talk) out.push({ text: t('onboard.verb.talk'), key: 't' });
  if (world.verbs.sneak) out.push({ text: t('onboard.verb.sneak'), key: 'c' });
  if (world.verbs.search) out.push({ text: t('onboard.verb.search'), key: 'f' });
  return out;
}

/** how conflict works in this world, as plain lines */
export function conflictLines(world: WorldSpec, state?: GameState): string[] {
  return conflictEntries(world, state).map((e) => e.text);
}

export function onboardingView(world: WorldSpec, worldId: string, state?: GameState): OnboardingView {
  const lose = loseLines(world, state).map((l) => l.text);
  const entries = conflictEntries(world, state);
  return {
    worldId,
    worldTitle: world.meta.title,
    goal: world.goal.summary,
    win: conditionLines(world, state, world.goal.win),
    conflict: entries.map((e) => e.text),
    conflictKeys: entries.map((e) => e.key ?? null),
    lose,
    verbs: { talk: !!world.verbs.talk, sneak: !!world.verbs.sneak, search: !!world.verbs.search, persuade: !!world.verbs.persuade },
  };
}
