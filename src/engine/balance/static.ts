/**
 * Static power budget of a WorldSpec: per area, the player's expected strength (level, hp, damage
 * per turn, armour) against the expected hostiles (count, hp, damage per turn, time to kill), the
 * healing on offer and the rules' drain; plus feasibility checks (can every goal / transition
 * requirement be met with what the world actually places?).
 *
 * All numbers are expectations, not guarantees: they are meant to rank worlds and areas and to
 * catch gross mistakes (a boss that one-shots a level 2 player, a key that never spawns).
 */
import type { ActorDef, Attack, Condition, Effect, ItemDef, WorldSpec } from '../../schema/world';
import { avgAmount, itemProfile } from '../sim/view';
import { PLAYER_HIT_CHANCE } from '../combat';
import { AREA_TURNS, estimateRuleImpact, resourceDrainHarm, type RuleImpact } from './rules';

/** extra spawns per area size (mirrors engine/area.ts EXTRA_SPAWNS) */
const EXTRA_SPAWNS: Record<string, number> = { small: 2, medium: 4, large: 6 };

const statMod = (v: number) => Math.floor((v - 10) / 2);
const hitChance = (bonus: number, ac: number) => Math.min(0.95, Math.max(0.05, (21 + bonus - ac) / 20));

export interface HostileBudget {
  id: string;
  name: string;
  /** expected number in the area */
  count: number;
  hp: number;
  /** expected damage per player turn against the player */
  dpt: number;
  /** player turns to defeat one */
  ttk: number;
  /** expected damage the player takes defeating one */
  damagePerFight: number;
  unique: boolean;
  xp: number;
}

export interface AreaBudget {
  index: number;
  name: string;
  playerLevel: number;
  playerHp: number;
  /** expected player damage per turn with the best weapon so far (the player hits PLAYER_HIT_CHANCE of the time) */
  playerDpt: number;
  playerAc: number;
  hostiles: HostileBudget[];
  expectedHostiles: number;
  /** expected damage from fighting everything */
  fightDamage: number;
  /** expected damage from rules/resources over the expected turns here */
  ruleDamage: number;
  /** expected healing found or offered here (items, loot, healers, regeneration, spells) */
  healing: number;
  /** (fight + rule damage) / (hp + healing): > 1 means attrition alone likely kills */
  risk: number;
  /** worst unique: damage per fight / (hp + healing); null without uniques */
  bossRisk: number | null;
  xp: number;
}

export interface ItemPower {
  id: string;
  name: string;
  /** rough power score (damage per turn for weapons, hp for heals…) */
  power: number;
  note: string;
}

export interface StaticAnalysis {
  areas: AreaBudget[];
  rules: RuleImpact[];
  resources: ReturnType<typeof resourceDrainHarm>;
  /** hard failures: the goal or a transition can never be completed */
  issues: string[];
  /** soft problems worth a look */
  warnings: string[];
  items: ItemPower[];
  /** highest per-area risk */
  maxRisk: number;
  /** mean per-area risk */
  meanRisk: number;
}

// ---------------------------------------------------------------------------
// Sources: where items, actors, flags and counters can come from
// ---------------------------------------------------------------------------

export interface Sources {
  /** item id → earliest area index it can be obtained in (-1 = carried from the start) */
  items: Map<string, number>;
  /** actor id → earliest area it appears in */
  actors: Map<string, number>;
  /** flag ids some effect can set */
  flags: Set<string>;
  /** counter ids some effect can raise */
  counters: Set<string>;
}

function effectsOf(world: WorldSpec): Effect[][] {
  const out: Effect[][] = [];
  for (const it of world.items) {
    if (it.onUse) out.push(it.onUse.effects);
    for (const tr of it.triggers) out.push(tr.action.effects);
  }
  for (const a of world.actors) {
    for (const ab of a.abilities) out.push(ab.action.effects);
    for (const tr of a.triggers) out.push(tr.action.effects);
  }
  for (const t of world.terrains ?? []) {
    out.push(t.onStand);
    if (t.interact) out.push(t.interact.effects);
  }
  for (const r of world.rules ?? []) for (const tr of r.playerTriggers) out.push(tr.action.effects);
  for (const p of world.player.growth.perks) for (const tr of p.triggers) out.push(tr.action.effects);
  for (const r of world.resources ?? []) out.push(r.onEmpty);
  for (const s of world.statuses ?? []) out.push(s.perTurn);
  return out;
}

export function collectSources(world: WorldSpec): Sources {
  const items = new Map<string, number>();
  const actors = new Map<string, number>();
  const flags = new Set<string>();
  const counters = new Set<string>();
  const addItem = (id: string, area: number) => {
    const cur = items.get(id);
    if (cur === undefined || area < cur) items.set(id, area);
  };
  const addActor = (id: string, area: number) => {
    const cur = actors.get(id);
    if (cur === undefined || area < cur) actors.set(id, area);
  };
  for (const si of world.player.startingItems) addItem(si.item, -1);
  for (const p of world.player.growth.perks) for (const g of p.grantItems) addItem(g, Math.max(0, Math.min(world.areas.length - 1, p.minLevel - 2)));
  world.areas.forEach((plan, i) => {
    for (const e of plan.items) if (e.weight > 0) addItem(e.item, i);
    for (const e of plan.placedItems) addItem(e.item, i);
    for (const e of plan.actors) if (e.weight > 0 || e.min > 0) addActor(e.actor, i);
    for (const e of plan.placed) addActor(e.actor, i);
  });
  // actors summoned / transformed into, loot and npc stock (iterate to a fixpoint)
  for (let pass = 0; pass < 4; pass++) {
    for (const a of world.actors) {
      const at = actors.get(a.id);
      if (at === undefined) continue;
      for (const l of a.loot) if (l.chance > 0) addItem(l.item, at);
      if (a.npc && (a.npc.role === 'trader' || a.npc.role === 'quest_giver')) for (const s of a.npc.stock) addItem(s, at);
      const effs = [...a.abilities.map((x) => x.action.effects), ...a.triggers.map((x) => x.action.effects)].flat();
      for (const e of effs) {
        if (e.type === 'summon') addActor(e.actor, at);
        if (e.type === 'transform') addActor(e.into, at);
        if (e.type === 'spawn_item') addItem(e.item, at);
      }
    }
    for (const it of world.items) {
      const at = items.get(it.id);
      if (at === undefined) continue;
      const effs = [...(it.onUse?.effects ?? []), ...it.triggers.flatMap((x) => x.action.effects)];
      for (const e of effs) {
        if (e.type === 'summon') addActor(e.actor, Math.max(0, at));
        if (e.type === 'spawn_item') addItem(e.item, Math.max(0, at));
      }
    }
  }
  for (const t of world.terrains ?? []) {
    for (const e of [...t.onStand, ...(t.interact?.effects ?? [])]) {
      if (e.type === 'spawn_item') {
        const area = world.areas.findIndex((p) => p.terrain.some((x) => x.terrain === t.id));
        if (area >= 0) addItem(e.item, area);
      }
    }
  }
  for (const effects of effectsOf(world)) {
    for (const e of effects) {
      if (e.type === 'set_flag' && e.value !== false) flags.add(e.flag);
      if (e.type === 'counter' && e.add > 0) counters.add(e.counter);
    }
  }
  const vc = (world.rules ?? []).map((r) => r.switches?.violenceCounter).filter((x): x is string => !!x);
  for (const c of vc) counters.add(c);
  return { items, actors, flags, counters };
}

/** null when the condition can be met using areas 0..areaLimit, else why not */
export function infeasible(world: WorldSpec, src: Sources, c: Condition | undefined, areaLimit: number, depth = 0): string | null {
  if (!c || depth > 16) return null;
  switch (c.type) {
    case 'all': {
      for (const x of c.of) {
        const r = infeasible(world, src, x, areaLimit, depth + 1);
        if (r) return r;
      }
      return null;
    }
    case 'any': {
      const rs = c.of.map((x) => infeasible(world, src, x, areaLimit, depth + 1));
      return rs.some((r) => r === null) ? null : rs.join(' and ');
    }
    case 'has_item': {
      const at = src.items.get(c.item);
      if (at === undefined) return `item "${c.item}" is never placed, spawned, dropped or sold`;
      if (at > areaLimit) return `item "${c.item}" first appears in area ${at + 1}, after area ${areaLimit + 1} where it is needed`;
      return null;
    }
    case 'actor_defeated': {
      const at = src.actors.get(c.actor);
      if (at === undefined) return `actor "${c.actor}" never appears`;
      if (at > areaLimit) return `actor "${c.actor}" first appears in area ${at + 1}, after area ${areaLimit + 1} where it is needed`;
      const def = world.actors.find((a) => a.id === c.actor);
      if (def && (c.count ?? 1) > 1 && def.unique) return `actor "${c.actor}" is unique but must be defeated ${c.count} times`;
      return null;
    }
    case 'flag':
      if (c.value === false) return null;
      return src.flags.has(c.flag) ? null : `flag "${c.flag}" is never set by any effect`;
    case 'counter':
      if (c.cmp === 'gte' || c.cmp === 'gt' || c.cmp === 'eq') return c.value <= 0 || src.counters.has(c.counter) ? null : `counter "${c.counter}" is never raised`;
      return null;
    case 'in_area':
      return c.area < world.areas.length ? null : `area ${c.area + 1} does not exist`;
    case 'not':
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Combat numbers
// ---------------------------------------------------------------------------

function attackDamage(atk: Attack, stats: { str: number; dex: number; int: number }): number {
  const s = stats[atk.accuracyStat];
  let d = avgAmount(atk.damage, s);
  if (atk.range <= 1 && atk.accuracyStat === 'str') d += Math.max(0, statMod(stats.str));
  return Math.max(1, d);
}

const DEFAULT_ATTACK: Attack = { name: 'Strike', verb: 'strikes', damage: { base: 0, dice: '1d3' }, damageType: 'physical', range: 1, accuracyStat: 'dex' };

function actorDpt(a: ActorDef, playerAc: number): number {
  const atk = a.attack ?? (a.faction === 'hostile' && !a.npc ? DEFAULT_ATTACK : null);
  let dpt = 0;
  if (atk) dpt += hitChance(statMod(a.stats[atk.accuracyStat]), playerAc) * attackDamage(atk, a.stats);
  for (const ab of a.abilities) {
    let dmg = 0;
    for (const e of ab.action.effects) if (e.type === 'damage') dmg += avgAmount(e.amount, a.stats.int);
    if (dmg > 0 && ab.action.targeting.affects !== 'allies' && ab.action.targeting.affects !== 'self_only') dpt += (dmg / (ab.cooldown + 1)) * 0.5;
  }
  // ranged attackers get free shots while the player closes in
  const rangedBonus = atk && atk.range > 1 ? 1.25 : 1;
  return dpt * (a.speed / 100) * rangedBonus;
}

function weaponDpt(world: WorldSpec, def: ItemDef | null, stats: { str: number; dex: number; int: number }): number {
  const atk = def?.weapon ?? world.player.unarmed;
  return PLAYER_HIT_CHANCE * attackDamage(atk, stats);
}

function levelFor(world: WorldSpec, xp: number): number {
  const g = world.player.growth;
  let level = 1;
  let need = g.firstLevelXp;
  let left = xp;
  while (left >= need && level < 20) {
    left -= need;
    level++;
    need = Math.max(1, Math.round(g.firstLevelXp * Math.pow(g.curve, level - 1)));
  }
  return level;
}

/** expected count of each spawn-table actor + placements in an area */
export function expectedActors(world: WorldSpec, index: number): Map<string, number> {
  const plan = world.areas[index];
  const out = new Map<string, number>();
  const add = (id: string, n: number) => out.set(id, (out.get(id) ?? 0) + n);
  for (const p of plan.placed) add(p.actor, 1);
  const entries = plan.actors.filter((e) => world.actors.some((a) => a.id === e.actor));
  for (const e of entries) add(e.actor, e.min);
  const extra = EXTRA_SPAWNS[plan.size] ?? 4;
  const room = entries.map((e) => Math.max(0, Math.max(e.min, e.max) - e.min));
  const wsum = entries.reduce((n, e, k) => n + (room[k] > 0 ? e.weight : 0), 0);
  if (wsum > 0) {
    entries.forEach((e, k) => {
      if (room[k] <= 0) return;
      add(e.actor, Math.min(room[k], (extra * e.weight) / wsum));
    });
  }
  return out;
}

function healValue(world: WorldSpec, def: ItemDef, playerInt: number, maxMp: number, mpRegenEvery: number, turns: number): number {
  const pr = itemProfile(world, def);
  if (pr.heal <= 0 || pr.offensive) return 0;
  const heal = def.onUse ? def.onUse.effects.reduce((n, e) => n + (e.type === 'heal' ? avgAmount(e.amount, playerInt) : 0), 0) : pr.heal;
  switch (def.useMode) {
    case 'consumed':
      return heal;
    case 'charges':
      return heal * (def.charges ?? 1);
    case 'reusable': {
      // limited by its cost (mp / a resource) and cooldown over the area
      const byCooldown = turns / Math.max(1, def.cooldown + 1);
      let uses = byCooldown;
      if (def.cost && def.cost.amount > 0) {
        if (def.cost.resource === 'mp') uses = Math.min(uses, (maxMp + turns / Math.max(1, mpRegenEvery)) / def.cost.amount);
        else uses = Math.min(uses, 3);
      }
      // nobody casts heals every turn: cap at what is useful
      return heal * Math.min(uses, 6);
    }
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export function staticAnalysis(world: WorldSpec): StaticAnalysis {
  const src = collectSources(world);
  const issues: string[] = [];
  const warnings: string[] = [];
  const last = world.areas.length - 1;

  // feasibility
  const goalWhy = infeasible(world, src, world.goal.win, last);
  if (goalWhy) issues.push(`goal cannot be met: ${goalWhy}`);
  world.areas.forEach((plan, i) => {
    if (i === last || !plan.transitionRequires) return;
    const why = infeasible(world, src, plan.transitionRequires, i);
    if (why) issues.push(`area ${i + 1} (${plan.name}) can never be left: ${why}`);
  });
  if (world.goal.lose) {
    const always = world.goal.lose.type === 'always';
    if (always) issues.push('the lose condition is always true');
  }
  for (const r of world.resources ?? []) {
    if (r.emptyIsDeath && r.perTurn < 0) {
      const refills = world.items.some((it) => (itemProfile(world, it).resources[r.id] ?? 0) > 0) || (world.terrains ?? []).some((t) => t.onStand.some((e) => e.type === 'resource' && e.resource === r.id && avgAmount(e.amount) > 0));
      if (!refills) issues.push(`resource "${r.id}" drains to death in ${Math.round(r.start / -r.perTurn)} turns and nothing refills it`);
    }
  }

  // rules and resources
  const rules = (world.rules ?? []).map((r) => estimateRuleImpact(world, r));
  const resources = resourceDrainHarm(world);
  const ruleHarmPer100 = rules.reduce((n, r) => n + Math.max(0, r.hpPer100), 0);
  for (const r of rules) if (r.magnitude === 'major' && r.harmful) warnings.push(`rule "${r.id}" is harsh (${r.hpPer100} hp per 100 turns: ${r.notes.join(', ')})`);

  // items
  const ps = world.player;
  const startEquip = (kind: 'weapon' | 'armour') => {
    const si = ps.startingItems.find((s) => {
      const d = world.items.find((i) => i.id === s.item);
      return d && s.equipped && (d.equipSlot ?? (d.category === kind ? kind : undefined)) === kind;
    });
    return si ? (world.items.find((i) => i.id === si.item) ?? null) : null;
  };
  let weapon: ItemDef | null = startEquip('weapon');
  let armour: ItemDef | null = startEquip('armour');
  const items: ItemPower[] = [];
  const baseStats = { str: ps.stats.str, dex: ps.stats.dex, int: ps.stats.int };
  for (const it of world.items) {
    const pr = itemProfile(world, it);
    if (it.weapon) items.push({ id: it.id, name: it.name, power: Math.round(weaponDpt(world, it, baseStats) * 10) / 10, note: 'weapon dmg/turn' });
    else if (it.armour) items.push({ id: it.id, name: it.name, power: it.armour, note: 'armour' });
    else if (pr.heal > 0) items.push({ id: it.id, name: it.name, power: Math.round(pr.heal), note: `heal (${it.useMode})` });
    else if (pr.damage > 0) items.push({ id: it.id, name: it.name, power: Math.round(pr.damage), note: `damage (${it.useMode})` });
  }
  const startDpt = weaponDpt(world, weapon, baseStats);
  for (const ip of items) {
    if (ip.note.startsWith('weapon') && ip.power > startDpt * 3) warnings.push(`weapon "${ip.id}" deals ${ip.power}/turn, over 3× the starting weapon`);
    if (ip.note.startsWith('heal') && ip.power > ps.stats.hp * 1.5) warnings.push(`"${ip.id}" heals ${ip.power}, more than 1.5× the player's starting hp`);
  }

  // per-area budgets
  const areas: AreaBudget[] = [];
  let xp = 0;
  let carriedHeal = 0;
  for (const si of ps.startingItems) {
    const d = world.items.find((i) => i.id === si.item);
    if (d && d.useMode !== 'reusable') carriedHeal += healValue(world, d, ps.stats.int, ps.stats.mp, ps.mpRegenEvery, 0) * si.count;
  }
  const avail = new Set(ps.startingItems.map((s) => s.item));
  world.areas.forEach((plan, i) => {
    const level = levelFor(world, xp);
    const hp = ps.stats.hp + ps.growth.hpPerLevel * (level - 1);
    const maxMp = ps.stats.mp + ps.growth.mpPerLevel * (level - 1);
    const turns = AREA_TURNS[plan.size] ?? 250;
    const stats = { str: ps.stats.str, dex: ps.stats.dex, int: ps.stats.int };
    const playerAc = ps.stats.ac + (armour?.armour ?? 0) + (armour?.modifiers.find((m) => m.stat === 'ac')?.amount ?? 0);
    const counts = expectedActors(world, i);
    const hostiles: HostileBudget[] = [];
    let fight = 0;
    let areaXp = 0;
    let bossRisk: number | null = null;
    let lootHeal = 0;
    for (const [id, count] of counts) {
      const def = world.actors.find((a) => a.id === id);
      if (!def || def.faction !== 'hostile' || count <= 0) continue;
      const atkDef = weapon?.weapon ?? ps.unarmed;
      const resist = def.resistances.find((r) => r.damageType === atkDef.damageType)?.multiplier ?? 1;
      const pdpt = Math.max(0.2, weaponDpt(world, weapon, stats) * resist);
      const ttk = def.stats.hp / pdpt;
      const dpt = actorDpt(def, playerAc);
      const group = def.behaviour.type === 'pack' ? 1.3 : 1;
      const perFight = dpt * ttk * group;
      fight += perFight * count;
      areaXp += def.xp * count;
      for (const l of def.loot) {
        const ld = world.items.find((x) => x.id === l.item);
        if (ld && !(world.rules ?? []).some((r) => r.switches?.noLoot)) lootHeal += l.chance * count * healValue(world, ld, stats.int, maxMp, ps.mpRegenEvery, turns);
      }
      hostiles.push({ id, name: def.name, count: Math.round(count * 10) / 10, hp: def.stats.hp, dpt: round1(dpt), ttk: round1(ttk), damagePerFight: round1(perFight), unique: def.unique, xp: def.xp });
    }
    // healing: floor items, loot, healers, regeneration, healing spells carried
    const table = plan.items.filter((e) => world.items.some((x) => x.id === e.item));
    const wsum = table.reduce((n, e) => n + e.weight, 0);
    let floorHeal = 0;
    for (const e of table) {
      const d = world.items.find((x) => x.id === e.item)!;
      if (wsum > 0) floorHeal += (plan.itemCount * e.weight * healValue(world, d, stats.int, maxMp, ps.mpRegenEvery, turns)) / wsum;
      avail.add(d.id);
    }
    for (const pi of plan.placedItems) {
      const d = world.items.find((x) => x.id === pi.item);
      if (d) floorHeal += healValue(world, d, stats.int, maxMp, ps.mpRegenEvery, turns);
    }
    let healer = 0;
    for (const p of plan.placed) {
      const d = world.actors.find((a) => a.id === p.actor);
      if (d?.npc?.role === 'healer' && d.faction !== 'hostile') healer += hp * 0.5;
      if (d?.npc?.role === 'trader') for (const s of d.npc.stock) avail.add(s);
    }
    const noRegen = (world.rules ?? []).some((r) => r.switches?.noNaturalHpRegen);
    const regen = ps.hpRegenEvery > 0 && !noRegen ? turns / ps.hpRegenEvery : 0;
    let spells = 0;
    for (const id of avail) {
      const d = world.items.find((x) => x.id === id);
      if (d && d.useMode === 'reusable' && (i === 0 ? ps.startingItems.some((s) => s.item === id) : true)) spells = Math.max(spells, healValue(world, d, stats.int, maxMp, ps.mpRegenEvery, turns));
    }
    const healing = floorHeal + lootHeal + healer + regen + spells + (i === 0 ? carriedHeal : 0);
    const ruleDamage = (ruleHarmPer100 * turns) / 100 + resources.reduce((n, r) => n + (r.perArea[i] ?? 0), 0);
    const risk = (fight + ruleDamage) / Math.max(1, hp + healing);
    for (const h of hostiles) {
      if (!h.unique) continue;
      const r = h.damagePerFight / Math.max(1, hp + Math.min(healing, hp));
      bossRisk = Math.max(bossRisk ?? 0, r);
      if (r > 1.2) warnings.push(`area ${i + 1}: unique "${h.id}" is expected to deal ${h.damagePerFight} damage in a straight fight (player hp ${hp} at level ${level})`);
    }
    if (risk > 1.2) warnings.push(`area ${i + 1} (${plan.name}): expected damage ${round1(fight + ruleDamage)} vs hp ${hp} + healing ${round1(healing)} (risk ${round1(risk)})`);
    if (!hostiles.length && world.meta.nonViolent === false && i > 0) warnings.push(`area ${i + 1} (${plan.name}) has no hostiles`);
    // upgrades found here carry into later areas
    for (const e of table) {
      const d = world.items.find((x) => x.id === e.item)!;
      if (d.weapon && weaponDpt(world, d, stats) > weaponDpt(world, weapon, stats) && d.requires.every((rq) => stats[rq.stat] >= rq.min)) weapon = d;
      if (d.armour && d.armour > (armour?.armour ?? 0)) armour = d;
    }
    areas.push({
      index: i,
      name: plan.name,
      playerLevel: level,
      playerHp: hp,
      playerDpt: round1(weaponDpt(world, weapon, stats)),
      playerAc,
      hostiles,
      expectedHostiles: round1(hostiles.reduce((n, h) => n + h.count, 0)),
      fightDamage: round1(fight),
      ruleDamage: round1(ruleDamage),
      healing: round1(healing),
      risk: Math.round(risk * 100) / 100,
      bossRisk: bossRisk === null ? null : Math.round(bossRisk * 100) / 100,
      xp: Math.round(areaXp),
    });
    xp += areaXp;
  });
  const risks = areas.map((a) => a.risk);
  return {
    areas,
    rules,
    resources,
    issues,
    warnings,
    items: items.sort((a, b) => b.power - a.power),
    maxRisk: Math.max(0, ...risks),
    meanRisk: risks.length ? Math.round((risks.reduce((a, b) => a + b, 0) / risks.length) * 100) / 100 : 0,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
