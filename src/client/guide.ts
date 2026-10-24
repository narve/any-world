/**
 * "Clearer controls & goals" (PLAN backlog, user playtest of Lowmoor): pure builders for the goal
 * tracker, the context action bar, locked-exit explanations and the onboarding card. Everything is
 * derived from the world spec + game state and rendered in plain words through the UI catalog, with
 * genre words from the world's vocabulary and names from its content. DOM-free and unit-tested
 * (tests/client/guide.test.ts).
 */
import type { Condition, WorldSpec } from '../schema/world';
import type { GameState, PlayerAction } from '../engine/types';
import { describeItemDef, playerSheet, type PlayerSheet } from '../engine/index';
import { listJoin, t } from './i18n/index';
import type { ContextActionView, ConditionLineView, GoalStepView, GoalView, OnboardingView } from './ui/viewmodel';

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
  const l = world.goal.labels?.[id];
  return l && l.trim() ? l.trim() : humanizeId(id);
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
      return (state.flags[c.flag] ?? false) === (c.value ?? true);
    case 'counter':
      return compare(state.counters[c.counter] ?? 0, c.cmp, c.value);
    case 'actor_defeated':
      return (state.defeated[c.actor] ?? 0) >= (c.count ?? 1);
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
    case 'flag':
      return c.value === false ? t('cond.flagNot', { flag: stateLabel(world, c.flag) }) : t('cond.flag', { flag: stateLabel(world, c.flag) });
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
    case 'flag':
      return c.value === false ? t('step.avoidFlag', { flag: stateLabel(world, c.flag) }) : t('step.flag', { flag: stateLabel(world, c.flag) });
    case 'counter':
      return t('step.counter', { counter: stateLabel(world, c.counter), cmp: cmpWords(c.cmp, c.value), now: state?.counters[c.counter] ?? 0 });
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
  if (c.type === 'counter') return t('cond.now', { value: state.counters[c.counter] ?? 0 });
  if (c.type === 'has_item' && (c.count ?? 1) > 1 && aboutPlayer(c.who)) return t('cond.now', { value: itemCount(state, c.item) });
  if (c.type === 'actor_defeated' && (c.count ?? 1) > 1) return t('cond.now', { value: state.defeated[c.actor] ?? 0 });
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
        out.push({ text: leafText(world, state, c), depth: d, done: done(c), ...nowField(c) });
    }
  };
  const nowField = (c: Condition): { now?: string } => {
    const n = nowText(world, state, c);
    return n ? { now: n } : {};
  };
  walk(cond, depth, true);
  return out;
}

/** leaves of `c` that still have to become true, in order (chance and "not" parts are skipped) */
export function unmetLeaves(state: GameState, c: Condition, depth = 0): Condition[] {
  if (depth > 32) return [];
  switch (c.type) {
    case 'all':
      return c.of.flatMap((x) => unmetLeaves(state, x, depth + 1));
    case 'any': {
      if (evalCondition(state, c) === true) return [];
      // pursue the branch closest to done: fewest unmet leaves, ties → the first listed
      let best: Condition[] | null = null;
      for (const x of c.of) {
        const u = unmetLeaves(state, x, depth + 1);
        if (!u.length) continue;
        if (!best || u.length < best.length) best = u;
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
export function currentStep(world: WorldSpec, state: GameState): GoalStepView {
  const quest = state.quests.find((q) => q.status === 'active');
  if (quest) return { kind: 'quest', text: quest.title, ...(quest.description ? { detail: quest.description } : {}) };
  const idx = state.area.index;
  const plan = world.areas[idx];
  const last = idx >= world.areas.length - 1;
  if (plan && !last) {
    const way = plan.transitionName;
    if (plan.transitionRequires) {
      const need = unmetLeaves(state, plan.transitionRequires);
      if (need.length) return { kind: 'unlock', text: stepText(world, state, need[0]), detail: t('goal.step.unlockFor', { way }) };
      if (evalCondition(state, plan.transitionRequires) === false) {
        return { kind: 'unlock', text: t('goal.step.unlockUnknown'), detail: t('goal.step.unlockFor', { way }) };
      }
    }
    if (onExitTile(state)) return { kind: 'exit', text: t('goal.step.takeExit', { way }) };
    if (exitSeen(state)) return { kind: 'exit', text: t('goal.step.goToExit', { way }) };
    return { kind: 'explore', text: t('goal.step.findExit', { area: plan.name }), detail: t('goal.step.findExitDetail', { way }) };
  }
  const need = unmetLeaves(state, world.goal.win);
  if (need.length) return { kind: 'final', text: stepText(world, state, need[0]), ...(need.length > 1 ? { detail: t('goal.step.more', { n: need.length - 1 }) } : {}) };
  return { kind: 'final', text: world.goal.summary };
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

/**
 * The buttons of the context action bar, most relevant first. Contextual ones (exit, pick up, talk,
 * persuade, use) appear only when they apply; search, sneak and wait are always offered when the
 * world has them, so touch play never needs a keyboard.
 */
export function contextActions(world: WorldSpec, state: GameState, x: ContextInput): ContextActionView[] {
  if (state.status !== 'playing' || state.pendingChoice || state.player.pendingPerkChoice) return [];
  const out: ContextActionView[] = [];
  const p = player(state);
  if (!p) return [];
  const plan = world.areas[state.area.index];
  const last = state.area.index >= world.areas.length - 1;

  if (plan && !last && onExitTile(state)) {
    if (x.canTransition) out.push({ id: 'exit', label: t('ctx.exit', { way: plan.transitionName }), key: '>', primary: true });
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
  const nameOf = (a: { defId: string }) => world.actors.find((d) => d.id === a.defId)?.name ?? t('common.someone');
  if (world.verbs.talk) {
    const who = nearest(actorsFor('talk'), p.pos);
    if (who) out.push({ id: 'talk', label: t('ctx.talk', { name: nameOf(who) }), key: 't', primary: true });
  }
  if (world.verbs.persuade) {
    // persuasion is the non-violent answer to someone hostile; everyone else gets "Talk"
    const who = nearest(actorsFor('persuade').filter((a) => a.faction === 'hostile' && !a.allyOf), p.pos);
    if (who) out.push({ id: 'persuade', label: t('ctx.persuade', { name: nameOf(who) }), key: 'p' });
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

/** how conflict works in this world, from its data (non-violent or not, verbs, health word) */
export function conflictLines(world: WorldSpec): string[] {
  const v = world.vocabulary;
  const params = { conflict: v.conflict, hp: v.stats.hp.name, defeated: v.defeated };
  const out = [world.meta.nonViolent ? t('onboard.conflict.nonViolent', params) : t('onboard.conflict.violent', params)];
  out.push(t('onboard.conflict.weapon', params));
  if (world.verbs.persuade) out.push(t('onboard.verb.persuade'));
  if (world.verbs.talk) out.push(t('onboard.verb.talk'));
  if (world.verbs.sneak) out.push(t('onboard.verb.sneak'));
  if (world.verbs.search) out.push(t('onboard.verb.search'));
  return out;
}

export function onboardingView(world: WorldSpec, worldId: string, state?: GameState): OnboardingView {
  const lose = loseLines(world, state).map((l) => l.text);
  return {
    worldId,
    worldTitle: world.meta.title,
    goal: world.goal.summary,
    win: conditionLines(world, state, world.goal.win),
    conflict: conflictLines(world),
    lose,
    verbs: { talk: !!world.verbs.talk, sneak: !!world.verbs.sneak, search: !!world.verbs.search, persuade: !!world.verbs.persuade },
  };
}
