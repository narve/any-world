/**
 * Rules in force (DESIGN §4.3 "New rules during play").
 *
 * GameState.activeRules is the live list: the world's starting rules plus the ones the GM adds,
 * minus the ones it retires. States from before M2 have no list and play with the world's rules.
 * Switches and player triggers are read from this list (switchesOf / activeRuleVariants), never
 * from the world spec directly.
 *
 * Also the rule power estimate (estimateRuleImpact, "player hp per 100 turns"), shared by the GM
 * add_rule / remove_rule check and by the balance code (balance/rules.ts re-exports it).
 */
import type { Amount, Condition, Effect, RuleVariant, Targeting, Trigger, WorldSpec } from '../schema/world';
import { MAX_ACTIVE_RULES, MAX_GM_RULES_PER_AREA } from '../schema/gm';
import type { ActiveRuleEntry, GameState } from './types';
import { type Ctx, type Switches, computeSwitches } from './ctx';
import { difficultyOf, profileOf } from './difficulty';
import { DEFAULT_DURABILITY } from './inventory';
import { POSITIONAL_SHAPES, isActorEffect } from './effects';
import { hideConsumablesForRule, unhideConsumablesForRule } from './knowledge';

// ---------------------------------------------------------------------------
// Rules in force
// ---------------------------------------------------------------------------

/** the starting list of a new run: every world rule, in force from the first turn */
export function initialActiveRules(world: WorldSpec): ActiveRuleEntry[] {
  return (world.rules ?? []).map((rule) => ({ rule: structuredClone(rule), source: 'world' as const, since: { area: 0, turn: 0 } }));
}

/** the live list of a state (the world's rules when the state predates activeRules) */
export function activeRuleEntries(world: WorldSpec, s: Pick<GameState, 'activeRules'>): ActiveRuleEntry[] {
  return Array.isArray(s.activeRules) ? s.activeRules : initialActiveRules(world);
}

/** the rule variants in force */
export function activeRuleVariants(ctx: Ctx): RuleVariant[] {
  const live = ctx.s.activeRules;
  return Array.isArray(live) ? live.map((e) => e.rule) : (ctx.world.rules ?? []);
}

/** the switches of the rules in force (cached on the context) */
export function switchesOf(ctx: Ctx): Switches {
  if (!ctx.sw) ctx.sw = Array.isArray(ctx.s.activeRules) ? computeSwitches(activeRuleVariants(ctx)) : ctx.ix.switches;
  return ctx.sw;
}

/** makes the state's list explicit (so it can change) and returns it */
function ensureList(ctx: Ctx): ActiveRuleEntry[] {
  if (!Array.isArray(ctx.s.activeRules)) ctx.s.activeRules = initialActiveRules(ctx.world);
  return ctx.s.activeRules;
}

// ---------------------------------------------------------------------------
// Power impact
// ---------------------------------------------------------------------------

export interface RuleImpact {
  id: string;
  /** hp-equivalent per 100 turns; positive = harmful (= harm + help) */
  hpPer100: number;
  /** the harmful part alone (≥ 0): every effect that may land on the player and hurt */
  harm: number;
  /**
   * the helpful part alone (≤ 0): only effects sure to land on the player (no condition, no
   * chance, targeting that always includes the player), each firing capped at a quarter of the
   * player's hp (a heal cannot raise hp above the maximum, so a huge rare heal offsets little)
   */
  help: number;
  magnitude: 'none' | 'minor' | 'moderate' | 'major';
  harmful: boolean;
  notes: string[];
}

function parseDice(dice: string | undefined): { n: number; k: number } | null {
  const m = dice ? /^(\d+)d(\d+)$/.exec(dice) : null;
  if (!m) return null;
  const n = Number(m[1]);
  const k = Number(m[2]);
  return n > 0 && k > 0 ? { n, k } : null;
}

function avgDice(dice: string | undefined): number {
  const d = parseDice(dice);
  return d ? (d.n * (d.k + 1)) / 2 : 0;
}

/** rough average of an Amount, assuming a stat of `statGuess` for scaled amounts */
export function avgAmount(a: Amount | undefined, statGuess = 12): number {
  if (!a) return 0;
  return (a.base ?? 0) + avgDice(a.dice) + (a.scale ? a.scale.factor * statGuess : 0);
}

/** standard normal cdf (Abramowitz–Stegun 7.1.26 erf, |error| < 1.5e-7) */
function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** largest exact dice convolution done (n² · k² steps); beyond it a normal approximation is used */
const EXACT_DICE_WORK = 4_000_000;

/**
 * E[max(0, c + roll)]: the expected value of a rolled amount after the engine clamps it at 0
 * (combat.dealDamage / heal ignore non-positive amounts, and each roll is clamped on its own, so a
 * negative base with a wide die still lands often). Exact for small dice pools, else normal.
 */
export function expectedPositive(c: number, dice: string | undefined): number {
  const d = parseDice(dice);
  if (!d) return Math.max(0, c);
  const { n, k } = d;
  const lo = c + n;
  const hi = c + n * k;
  if (lo >= 0) return c + (n * (k + 1)) / 2;
  if (hi <= 0) return 0;
  if (n * n * k * k <= EXACT_DICE_WORK) {
    // distribution of the sum of n dice: dist[i] = P(sum = n + i)
    let dist = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array<number>(dist.length + k - 1).fill(0);
      for (let j = 0; j < dist.length; j++) {
        const p = dist[j] / k;
        if (p === 0) continue;
        for (let f = 0; f < k; f++) next[j + f] += p;
      }
      dist = next;
    }
    let e = 0;
    for (let i = 0; i < dist.length; i++) e += dist[i] * Math.max(0, c + n + i);
    return e;
  }
  const mu = c + (n * (k + 1)) / 2;
  const sigma = Math.sqrt((n * (k * k - 1)) / 12);
  const z = mu / sigma;
  const pdf = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  return Math.max(0, mu * normCdf(z) + sigma * pdf);
}

/**
 * The highest value a stat the player holds may plausibly reach in a run (scaled amounts read the
 * holder's live stat, effects.evalAmount): base plus room for levels, perks and gear. Unknown
 * stats read as 0 (stats.getStat).
 */
export function statCeiling(world: WorldSpec, stat: string): number {
  const p = world.player;
  const LEVELS = 10;
  switch (stat) {
    case 'hp':
      return p.stats.hp + LEVELS * (p.growth?.hpPerLevel ?? 4);
    case 'mp':
      return p.stats.mp + LEVELS * (p.growth?.mpPerLevel ?? 2);
    case 'str':
    case 'dex':
    case 'int':
    case 'ac':
      return p.stats[stat] + 8;
    case 'sight':
      return (p.sight ?? 8) + 6;
    case 'speed':
      return 200;
    default:
      return (world.resources ?? []).find((r) => r.id === stat)?.max ?? 0;
  }
}

/**
 * The span [lo, hi] the scale term of an Amount may take: the holder's stat lies between 0 and its
 * ceiling, so a positive factor adds 0..factor·ceiling and a negative one factor·ceiling..0.
 */
function scaleSpan(world: WorldSpec, a: Amount): [number, number] {
  if (!a.scale) return [0, 0];
  const v = a.scale.factor * statCeiling(world, a.scale.stat);
  return [Math.min(0, v), Math.max(0, v)];
}

/** the worst case for the player of a hurtful rolled amount: its clamped mean at the top of its scale */
function worstPositive(world: WorldSpec, a: Amount): number {
  return expectedPositive((a.base ?? 0) + scaleSpan(world, a)[1], a.dice);
}

/** the least a helpful rolled amount gives: its clamped mean at the bottom of its scale */
function leastPositive(world: WorldSpec, a: Amount): number {
  return expectedPositive((a.base ?? 0) + scaleSpan(world, a)[0], a.dice);
}

/** expected turns the player stands on terrain spawned under them per firing, at most */
const STAND_TURNS = 5;

/**
 * Rough hp value of one effect landing on the player (positive = harm), valued pessimistically:
 * hurtful amounts at their worst (scale at the stat ceiling, rolls clamped at 0 one by one as the
 * engine does), helpful ones at their least. `stand` is how many turns the player may stand on
 * terrain this effect spawns (at most STAND_TURNS).
 */
export function effectHarm(world: WorldSpec, e: Effect, stand = STAND_TURNS): number {
  switch (e.type) {
    // the engine ignores non-positive damage and heals (combat.dealDamage / heal): a negative
    // damage is nothing, not a heal, and a negative heal is nothing, not damage
    case 'damage':
      return worstPositive(world, e.amount);
    case 'heal':
      return -leastPositive(world, e.amount);
    case 'resource': {
      // resources are not clamped per roll: the mean of the dice, at the scale end worst for the player
      const v = (e.amount.base ?? 0) + avgDice(e.amount.dice) + scaleSpan(world, e.amount)[0];
      if (e.resource === 'hp') return -v;
      const res = (world.resources ?? []).find((r) => r.id === e.resource);
      // resources that kill or hurt when empty matter more
      const weight = res?.emptyIsDeath ? 0.5 : res && res.onEmpty.length ? 0.25 : e.resource === 'mp' ? 0.3 : 0.1;
      return -v * weight;
    }
    case 'modify_stat':
      return -(e.amount * (e.stat === 'hp' ? 1 : e.stat === 'ac' ? 3 : 2)) * (e.duration ? Math.min(1, e.duration / 20) : 1);
    case 'apply_status': {
      const st = (world.statuses ?? []).find((s) => s.id === e.status);
      if (!st) return 0;
      let per = 0;
      for (const pe of st.perTurn) per += effectHarm(world, pe);
      let mods = 0;
      for (const m of st.modifiers) mods -= m.amount * (m.stat === 'ac' ? 0.6 : 0.3);
      const flags = st.flags.reduce((n, f) => n + (['stunned', 'rooted', 'afraid', 'blinded', 'confused', 'silenced', 'slowed', 'charmed'].includes(f) ? 1.5 : ['hasted', 'regenerating', 'invisible'].includes(f) ? -1.5 : 0), 0);
      const sign = st.harmful ? 1 : -1;
      return per * e.duration + (Math.abs(mods) + Math.abs(flags)) * sign * Math.min(1, e.duration / 5);
    }
    case 'spawn_terrain': {
      // terrain may be spawned under the player (self targeting, or an area reaching them) and hurt
      // every turn they stand on it; only its harm counts (spawned help may land anywhere)
      const t = (world.terrains ?? []).find((x) => x.id === e.terrain);
      if (!t) return 0;
      let per = 0;
      for (const se of t.onStand) per += effectHarm(world, se);
      const turns = Math.max(1, Math.min(stand, e.duration ?? STAND_TURNS, STAND_TURNS));
      // walls or pits around the player hem them in
      const blocking = t.walkable === false ? 1 + e.radius : 0;
      return Math.max(0, per) * turns + blocking;
    }
    case 'remove_status':
      return -0.5;
    case 'summon':
      return e.allied ? -3 * e.count : 6 * e.count;
    case 'spawn_item':
      return -1;
    case 'noise':
      return e.radius / 10;
    case 'teleport':
      return e.mode === 'random' ? 1 : 0;
    default:
      return 0;
  }
}

/**
 * Counters and flags the world's outcome reads: the win and lose conditions and every area's
 * transition lock. A GM rule may not write them (an on_turn "+3 detentions" would end the run at
 * once, and a "+1 relics" would hand it over), whatever the estimate says.
 */
export function goalRefs(world: WorldSpec): { counters: Set<string>; flags: Set<string> } {
  const counters = new Set<string>();
  const flags = new Set<string>();
  const walk = (c: Condition | undefined): void => {
    if (!c) return;
    switch (c.type) {
      case 'all':
      case 'any':
        c.of.forEach(walk);
        return;
      case 'not':
        walk(c.cond);
        return;
      case 'counter':
        counters.add(c.counter);
        return;
      case 'flag':
        flags.add(c.flag);
        return;
      default:
        return;
    }
  };
  walk(world.goal?.win);
  walk(world.goal?.lose);
  for (const a of world.areas ?? []) walk(a.transitionRequires);
  return { counters, flags };
}

/** the first counter / flag of the world's outcome that `rule` writes (directly or through a status it applies), if any */
export function ruleGoalWrite(world: WorldSpec, rule: RuleVariant): string | null {
  const refs = goalRefs(world);
  const seen = new Set<string>();
  const check = (effects: readonly Effect[]): string | null => {
    for (const e of effects) {
      if (e.type === 'counter' && refs.counters.has(e.counter)) return `counter "${e.counter}"`;
      if (e.type === 'set_flag' && refs.flags.has(e.flag)) return `flag "${e.flag}"`;
      if (e.type === 'apply_status' && !seen.has(e.status)) {
        seen.add(e.status);
        const st = (world.statuses ?? []).find((s) => s.id === e.status);
        const hit = st ? check(st.perTurn) : null;
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const tr of rule.playerTriggers ?? []) {
    const hit = check(tr.action?.effects ?? []);
    if (hit) return hit;
  }
  return null;
}

/**
 * Whether an action's actor effects reach the player who holds the trigger (effects.resolveTargets):
 * 'sure' when its targets are always exactly or include the user, 'never' when the filter rules the
 * user out (enemies of oneself), 'maybe' otherwise.
 */
function reachOfPlayer(t: Targeting | undefined): 'sure' | 'maybe' | 'never' {
  if (!t || t.shape === 'self') return 'sure';
  if (t.affects === 'self_only') return POSITIONAL_SHAPES.has(t.shape) ? 'maybe' : 'sure';
  if (t.affects === 'enemies') return 'never';
  if (t.shape === 'all_visible' && t.affects === 'allies') return 'sure';
  return 'maybe';
}

/** how often a trigger fires per 100 turns (rough) */
function firesPer100(tr: Trigger): number {
  switch (tr.on) {
    case 'on_turn':
      return 100 / (tr.every ?? 1);
    case 'on_hit':
    case 'on_hurt':
      return 25;
    case 'on_kill':
      return 4;
    case 'on_area_enter':
      return 0.4;
    case 'on_enter_tile':
      return 80;
    case 'on_low_hp':
      return 0.5;
    case 'on_resource_empty':
      return 1;
    default:
      return 1;
  }
}

/**
 * Expected harm and help of one trigger per 100 turns, kept apart so a large helpful term that may
 * never happen cannot hide a real drain: harm counts every hurtful effect that may reach the player
 * (at its chance); help counts only effects sure to happen and to reach the player.
 */
function triggerParts(world: WorldSpec, tr: Trigger): { harm: number; help: number } {
  const fires = firesPer100(tr);
  const chance = tr.chance ?? 1;
  const cond = tr.action.condition;
  const certain = chance >= 1 && (!cond || cond.type === 'always');
  const reach = reachOfPlayer(tr.action.targeting);
  // terrain spawned on every firing is stood on until the next one (or until the player moves off)
  const stand = Math.max(1, Math.min(STAND_TURNS, 100 / Math.max(1, fires)));
  let harm = 0;
  let help = 0;
  for (const e of tr.action.effects) {
    const actor = isActorEffect(e);
    if (actor && reach === 'never') continue;
    const h = effectHarm(world, e, stand);
    if (h > 0) harm += h;
    else if (h < 0 && certain && (!actor || reach === 'sure')) help += h;
  }
  const cap = Math.max(1, world.player.stats.hp / 4);
  return { harm: harm * fires * chance, help: Math.max(help, -cap) * fires };
}

export interface ImpactOptions {
  /**
   * Whether the rule's permadeathMercy switch would actually help (default true, the static view).
   * The GM-side checks pass false once the mercy is spent (GameState.mercyUsed) or another rule in
   * force already grants it: a switch that changes nothing is no counterweight.
   */
  mercyHelps?: boolean;
}

/** power impact of a rule variant, in player hp per 100 turns (positive = harms the player) */
export function estimateRuleImpact(world: WorldSpec, rule: RuleVariant, opts: ImpactOptions = {}): RuleImpact {
  const notes: string[] = [];
  let harm = 0;
  let help = 0;
  for (const tr of rule.playerTriggers ?? []) {
    const p = triggerParts(world, tr);
    const h = p.harm + p.help;
    if (Math.abs(h) >= 0.5) notes.push(`${tr.on}${tr.every ? ` every ${tr.every}` : ''}: ${h > 0 ? '+' : ''}${h.toFixed(1)} hp/100t`);
    harm += p.harm;
    help += p.help;
  }
  let hp = 0;
  const sw = rule.switches ?? {};
  const regenEvery = world.player.hpRegenEvery;
  if (sw.noNaturalHpRegen && regenEvery > 0) {
    const v = 100 / regenEvery;
    hp += v;
    notes.push(`no natural regeneration (−${v.toFixed(0)} hp/100t)`);
  }
  if (typeof sw.darkness === 'number' && sw.darkness < 1) {
    const v = (1 - sw.darkness) * 8;
    hp += v;
    notes.push(`darkness ×${sw.darkness}`);
  }
  if (sw.noLoot) {
    hp += 3;
    notes.push('no loot');
  }
  if (sw.durability) {
    hp += 2;
    notes.push('equipment wears out');
  }
  if (sw.allConsumablesUnknown) {
    hp += 2;
    notes.push('consumables unidentified');
  }
  harm += hp; // every switch above is harm
  if (sw.permadeathMercy) {
    if (opts.mercyHelps !== false) {
      help -= world.player.stats.hp / 3;
      notes.push('one mercy from death');
    } else notes.push('one mercy from death (already spent or granted)');
  }
  const r1 = (v: number) => Math.round(v * 10) / 10 + 0; // + 0 turns -0 into 0
  const net = harm + help;
  const a = Math.abs(net);
  const magnitude = a < 1 ? 'none' : a < 6 ? 'minor' : a < 15 ? 'moderate' : 'major';
  return { id: rule.id, hpPer100: r1(net), harm: r1(harm), help: r1(help), magnitude, harmful: net > 0, notes };
}

// ---------------------------------------------------------------------------
// GM changes (gm.ts add_rule / remove_rule)
// ---------------------------------------------------------------------------

const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

const grantsMercy = (r: RuleVariant): boolean => !!r.switches?.permadeathMercy;

/**
 * Impact of each entry of `live` as things stand: the mercy switch is credited to one rule at most
 * (a world rule first, then the earliest GM rule) and to none once it is spent.
 */
function liveImpacts(ctx: Ctx, live: readonly ActiveRuleEntry[]): Map<ActiveRuleEntry, RuleImpact> {
  const granted = mercyGranted(ctx);
  let credited = granted || live.some((e) => e.source !== 'gm' && grantsMercy(e.rule));
  const worldHolder = granted ? null : live.find((e) => e.source !== 'gm' && grantsMercy(e.rule));
  const out = new Map<ActiveRuleEntry, RuleImpact>();
  for (const e of live) {
    let mercyHelps = false;
    if (grantsMercy(e.rule)) {
      if (e === worldHolder) mercyHelps = true;
      else if (!credited) {
        mercyHelps = true;
        credited = true;
      }
    }
    out.set(e, estimateRuleImpact(ctx.world, e.rule, { mercyHelps }));
  }
  return out;
}

/** the mercy is spent, or the difficulty grants it anyway (Gentle's second chance): a mercy switch changes nothing */
function mercyGranted(ctx: Ctx): boolean {
  return !!ctx.s.mercyUsed || profileOf(ctx.s).secondChance;
}

/** whether a mercy switch on a rule joining (or staying in) `others` would help: not spent, not granted elsewhere */
function mercyWouldHelp(ctx: Ctx, others: readonly ActiveRuleEntry[]): boolean {
  return !mercyGranted(ctx) && !others.some((e) => grantsMercy(e.rule));
}

/**
 * Net harm the GM has done with rules so far: the GM-added rules in `live` (valued as things stand
 * now, see liveImpacts) plus the helpful world rules it has retired (GameState.gmRetiredHarm).
 * Bounded by the difficulty's ruleHarmTotal.
 */
export function gmRuleHarm(ctx: Ctx, live: readonly ActiveRuleEntry[] = activeRuleEntries(ctx.world, ctx.s)): number {
  let total = ctx.s.gmRetiredHarm ?? 0;
  const imp = liveImpacts(ctx, live);
  for (const e of live) if (e.source === 'gm') total += imp.get(e)!.hpPer100;
  return total;
}

/** harmful effect types a standing GM rule may not aim at the player's foes */
const FOE_STRIKES: ReadonlySet<string> = new Set(['damage', 'kill', 'drain', 'transform', 'change_faction', 'teleport']);

/**
 * Whether a player trigger of `rule` reaches the player's foes with a harmful effect. The engine's
 * impact estimate only scores what reaches the player, so such a rule would pass the harm limits
 * while killing every boss it sees (defence in depth: llm/gm-checks refuses these too).
 */
function strikesFoes(rule: RuleVariant): boolean {
  return (rule.playerTriggers ?? []).some((t) => {
    const tg = t.action?.targeting;
    if (!tg || tg.shape === 'self' || (tg.affects !== 'enemies' && tg.affects !== 'all')) return false;
    return (t.action.effects ?? []).some(
      (e) => FOE_STRIKES.has(e.type) || (e.type === 'resource' && (e.amount?.base ?? 0) < 0) || (e.type === 'modify_stat' && e.amount < 0),
    );
  });
}

/**
 * Why the GM may not add `rule` now (null = it may): the cap on active rules, one GM rule per
 * area, no duplicate ids, no writing the counters / flags the world's outcome reads, and the
 * difficulty's harm allowance (per rule and for all GM rules).
 */
export function addRuleRefusal(ctx: Ctx, rule: RuleVariant): string | null {
  const live = activeRuleEntries(ctx.world, ctx.s);
  if (live.some((e) => e.rule.id === rule.id)) return `rule "${rule.id}" is already in force`;
  if (live.length >= MAX_ACTIVE_RULES) return `at most ${MAX_ACTIVE_RULES} rules may be in force`;
  if ((ctx.s.area.gmRulesAdded ?? 0) >= MAX_GM_RULES_PER_AREA) return `at most ${MAX_GM_RULES_PER_AREA} new rule per area`;
  const goalWrite = ruleGoalWrite(ctx.world, rule);
  if (goalWrite) return `a rule may not change ${goalWrite}: the goal depends on it`;
  if (strikesFoes(rule)) return 'a GM rule may not strike the player\'s foes (it would fire at every later boss)';
  const prof = profileOf(ctx.s);
  const band = difficultyOf(ctx.s);
  const harm = estimateRuleImpact(ctx.world, rule, { mercyHelps: mercyWouldHelp(ctx, live) }).hpPer100;
  if (harm > prof.ruleHarm) return `too harsh for ${band} (${fmt(harm)} hp/100 turns, allowed ${prof.ruleHarm})`;
  const total = gmRuleHarm(ctx, live) + harm;
  if (harm > 0 && total > prof.ruleHarmTotal) return `GM rules too harsh together for ${band} (${fmt(total)} hp/100 turns, allowed ${prof.ruleHarmTotal})`;
  return null;
}

/**
 * Harm that retiring `e` from `live` adds to the GM ledger: the rule's impact as things stand now
 * (its mercy counts only if it is the one that would save the player), negated; a GM rule simply
 * leaves the sum, a helpful world rule joins the ledger.
 */
function retireHarm(ctx: Ctx, e: ActiveRuleEntry, live: readonly ActiveRuleEntry[]): number {
  const others = live.filter((x) => x !== e);
  const v = -estimateRuleImpact(ctx.world, e.rule, { mercyHelps: mercyWouldHelp(ctx, others) }).hpPer100;
  return e.source === 'gm' ? v : Math.max(0, v);
}

/**
 * Why the GM may not retire rule `id` now (null = it may): it must be in force, one retirement per
 * area, and retiring a helpful rule is harm, checked per rule and against the GM total (so a
 * helpful GM rule added as a counterweight cannot be taken back once harmful ones lean on it).
 */
export function removeRuleRefusal(ctx: Ctx, id: string): string | null {
  const live = activeRuleEntries(ctx.world, ctx.s);
  const e = live.find((x) => x.rule.id === id);
  if (!e) return `no rule "${id}" in force`;
  if ((ctx.s.area.gmRulesRemoved ?? 0) >= MAX_GM_RULES_PER_AREA) return `at most ${MAX_GM_RULES_PER_AREA} retired rule per area`;
  const prof = profileOf(ctx.s);
  const band = difficultyOf(ctx.s);
  const harm = e.source === 'gm' ? retireHarm(ctx, e, live) : -estimateRuleImpact(ctx.world, e.rule, { mercyHelps: mercyWouldHelp(ctx, live.filter((x) => x !== e)) }).hpPer100;
  if (harm > prof.ruleHarm) return `retiring it is too harsh for ${band} (${fmt(harm)} hp/100 turns, allowed ${prof.ruleHarm})`;
  // the GM total afterwards: the remaining GM rules re-valued without it, plus the ledger
  const rest = live.filter((x) => x !== e);
  const total = gmRuleHarm(ctx, rest) + (e.source === 'gm' ? 0 : retireHarm(ctx, e, live));
  if (total > gmRuleHarm(ctx, live) && total > prof.ruleHarmTotal) return `retiring it makes GM rules too harsh together for ${band} (${fmt(total)} hp/100 turns, allowed ${prof.ruleHarmTotal})`;
  return null;
}

/** puts a (checked) rule in force; returns its entry */
export function addActiveRule(ctx: Ctx, rule: RuleVariant, reason: string): ActiveRuleEntry {
  const before = switchesOf(ctx);
  const entry: ActiveRuleEntry = { rule, source: 'gm', since: { area: ctx.s.area.index, turn: ctx.s.turn } };
  if (reason.trim()) entry.reason = reason.trim();
  ensureList(ctx).push(entry);
  ctx.s.area.gmRulesAdded = (ctx.s.area.gmRulesAdded ?? 0) + 1;
  ctx.sw = undefined;
  applySwitchChange(ctx, before, switchesOf(ctx));
  return entry;
}

/** lifts a rule; returns the removed entry */
export function removeActiveRule(ctx: Ctx, id: string): ActiveRuleEntry | null {
  const before = switchesOf(ctx);
  const list = ensureList(ctx);
  const i = list.findIndex((e) => e.rule.id === id);
  if (i < 0) return null;
  const v = list[i].source === 'gm' ? 0 : retireHarm(ctx, list[i], list);
  const [gone] = list.splice(i, 1);
  if (gone.source !== 'gm') {
    if (v > 0) ctx.s.gmRetiredHarm = Math.round(((ctx.s.gmRetiredHarm ?? 0) + v) * 10) / 10;
  }
  ctx.s.area.gmRulesRemoved = (ctx.s.area.gmRulesRemoved ?? 0) + 1;
  ctx.sw = undefined;
  applySwitchChange(ctx, before, switchesOf(ctx));
  return gone;
}

/**
 * One-off consequences of a switch turning on or off mid-run, so no residue is left behind:
 *  - durability on: gear the player holds or that lies in the area starts wearing out;
 *    off: durability counters are dropped (nothing wears or shows a count any more)
 * Darkness, noLoot, noNaturalHpRegen, permadeathMercy and violenceCounter are read live and need
 * nothing here.
 *  - allConsumablesUnknown on: consumables the player knows only from the world (never used, not
 *    carried) become unknown with fresh appearances from their groups' pools
 *    (knowledge.ts hideConsumablesForRule); off: those go back to their own knowledge level.
 */
function applySwitchChange(ctx: Ctx, before: Switches, after: Switches): void {
  if (!before.allConsumablesUnknown && after.allConsumablesUnknown) hideConsumablesForRule(ctx);
  else if (before.allConsumablesUnknown && !after.allConsumablesUnknown) unhideConsumablesForRule(ctx);
  if (before.durability === after.durability) return;
  const items = [...ctx.s.player.slots, ...ctx.s.area.items.map((f) => f.item)];
  for (const it of items) {
    if (!it) continue;
    if (after.durability) {
      const def = ctx.ix.items.get(it.defId);
      if (def && (def.weapon || typeof def.armour === 'number') && typeof it.durability !== 'number') it.durability = DEFAULT_DURABILITY;
    } else delete it.durability;
  }
}
