/**
 * Message catalog keys of every engine-generated log line (DESIGN §7b), with their English
 * templates. The engine renders `text` (the English fallback) from these same templates, so a
 * client catalog for another language only needs the same keys.
 *
 * Template syntax:
 * - `{name}` inserts params.name as is (numbers as decimal strings).
 * - `{name|cap}` inserts it with the first letter upper-cased (sentence starts: "The rat bites…").
 *
 * Params are numbers, or strings that are already world-language names (actor/item/status/terrain
 * names, vocabulary words, world-authored verbs). Lines the world/GM/NPC wrote themselves (GM
 * narration, NPC lines, the world's win/loss titles, transition names) carry no key: they are
 * already in the world's language.
 */
export const LOG_KEYS = {
  // areas
  'log.area.enter': '{area} {number}: {name}',
  'log.transition.locked': '{transition}: locked',

  // combat
  'log.attack.miss': '{attacker|cap} {verb} {target} but misses.',
  'log.attack.hit': '{attacker|cap} {verb} {target} for {amount}.',
  'log.attack.hit_typed': '{attacker|cap} {verb} {target} for {amount} {damageType}.',
  'log.attack.crit': '{attacker|cap} {verb} {target} (critical) for {amount}.',
  'log.attack.crit_typed': '{attacker|cap} {verb} {target} (critical) for {amount} {damageType}.',
  /** the built-in attack of an actor the world gave none (no world-authored verb) */
  'log.attack.miss_default': '{attacker|cap} strikes {target} but misses.',
  'log.attack.hit_default': '{attacker|cap} strikes {target} for {amount}.',
  'log.attack.crit_default': '{attacker|cap} strikes {target} (critical) for {amount}.',
  'log.provoke': '{target|cap} turns on you.',
  'log.damage.immune': '{target|cap} is unaffected.',
  'log.damage.take': '{target|cap} takes {amount}.',
  'log.damage.take_typed': '{target|cap} takes {amount} {damageType}.',
  'log.defeated': '{target|cap} is {defeated}.',
  'log.mercy': '{player} should have fallen, but gets back up.',
  'log.ability': '{actor|cap} uses {ability}.',
  'log.transform': '{actor} becomes {into}.',

  // turns
  'log.turn.act_again': '{player} can act again.',
  'log.turn.stunned': "{player} can't act.",

  // movement, search, terrain
  'log.sneak.on': '{player} moves quietly.',
  'log.sneak.off': '{player} stops sneaking.',
  'log.stumble': '{player} stumbles.',
  'log.here': 'Here: {items}',
  'log.here_more': 'Here: {items}…',
  'log.search.terrain': '{terrain}: {description}',
  'log.search.spot': '{player} spots {target}.',
  'log.search.nothing': 'Nothing of note nearby.',
  'log.interact.use': '{player} uses {terrain}.',
  'log.interact.nothing': 'Nothing happens.',

  // actors appearing, sides
  'log.appears': '{actor} appears.',
  'log.appears_many': '{actor} ×{count} appears.',
  'log.faction.hostile': '{actor} is now hostile.',
  'log.faction.neutral': '{actor} is now neutral.',
  'log.faction.friendly': '{actor} is now friendly.',

  // NPCs
  'log.persuade.backs_down': '{actor|cap} backs down.',
  'log.persuade.warms': '{actor|cap} warms to you.',
  'log.persuade.nods': '{actor|cap} nods.',
  'log.persuade.fail': '{actor|cap} is not convinced.',
  'log.ally.joins': '{actor|cap} joins you.',
  'log.trade.cannot_afford': 'You cannot afford any of it (not enough {currency}).',
  'log.trade.sold': '{player} sells {item} for {amount} {currency}.',

  // party
  /** a dialogue closed because its speaker died, left talking range or turned hostile meanwhile */
  'log.party.talk_gone': '{player} loses the thread: the conversation is over.',

  // quests, rules, currency, progression
  'log.quest.new': 'New: {title}',
  'log.quest.done': 'Done: {title}',
  'log.rule.new': 'New rule: {name}',
  'log.rule.new_desc': 'New rule: {name} — {description}',
  'log.rule.lifted': 'Rule lifted: {name}',
  'log.currency.gain': '+{amount} {currency}',
  'log.currency.spend': '-{amount} {currency}',
  'log.xp': '+{amount} {xp}',
  'log.levelup': '{levelUp}! ({level})',
  'log.perk': '{perk}: {description}',
  'log.resource.empty': '{resource} is empty.',

  // items
  'log.item.receive': '{player} receives {item}.',
  'log.item.receive_many': '{player} receives {item} ×{count}.',
  'log.item.pickup': '{player} picks up {item}.',
  'log.item.pickup_many': '{player} picks up {item} ×{count}.',
  'log.item.no_room': 'No room for the rest.',
  'log.item.equip': '{player} equips {item}.',
  'log.item.unequip': '{player} puts away {item}.',
  'log.item.drop': '{player} drops {item}.',
  'log.item.use': '{player} uses {item}.',
  'log.item.spent': '{item} is spent.',
  'log.item.breaks': '{item} breaks.',
  'log.identify.appearance': 'The {appearance} is {item}.',
  'log.identify.appearance_vague': 'The {appearance} is {item} (you have a rough idea what it does).',
  'log.identify.understand': 'You understand {item} now.',

  // statuses
  'log.status.applied': '{actor}: {status}.',
  'log.status.ends': '{status} ends.',
} as const satisfies Record<string, string>;

export type LogKey = keyof typeof LOG_KEYS;

/**
 * Keys of item effect lines (ItemView.effects: item cards, slot tips, trade rows), with their
 * English templates. Same template syntax as LOG_KEYS. `{amount}` is a formatted amount string
 * ("2d4+1", "+2" for modifiers), `{n}` a number of turns or tiles; `{who}` (targeting) is "" or a
 * rendered item.fx.who_* line; `{event}`/`{effects}` of a trigger line are rendered sub-lines.
 */
export const ITEM_FX_KEYS = {
  'item.fx.amount_scaled': '{amount} + {pct}% {stat}',
  'item.fx.damage': 'Deals {amount} {damageType} damage',
  'item.fx.heal': 'Restores {amount} {stat}',
  'item.fx.resource_gain': '+{amount} {stat}',
  'item.fx.resource_loss': '{amount} {stat}',
  'item.fx.stat_temp': '{amount} {stat} for {n} turns',
  'item.fx.stat_perm': '{amount} {stat} (permanent)',
  'item.fx.status_inflict': 'Inflicts {status} ({n} turns)',
  'item.fx.status_grant': 'Grants {status} ({n} turns)',
  'item.fx.cleanse': 'Removes harmful conditions',
  'item.fx.remove_status': 'Removes {status}',
  'item.fx.teleport_random': 'Teleports to a random spot',
  'item.fx.teleport_to_target': 'Teleports to the target',
  'item.fx.teleport_swap': 'Swaps places with the target',
  'item.fx.teleport_to_exit': 'Teleports near the way onward',
  'item.fx.push': 'Pushes back {n}',
  'item.fx.pull': 'Pulls in {n}',
  'item.fx.summon': 'Summons {actor}',
  'item.fx.summon_many': 'Summons {actor} ×{count}',
  'item.fx.summon_allied': 'Summons {actor} (allied)',
  'item.fx.summon_allied_many': 'Summons {actor} ×{count} (allied)',
  'item.fx.terrain': 'Creates {terrain}',
  'item.fx.terrain_radius': 'Creates {terrain} (radius {radius})',
  'item.fx.terrain_turns': 'Creates {terrain} for {n} turns',
  'item.fx.terrain_radius_turns': 'Creates {terrain} (radius {radius}) for {n} turns',
  'item.fx.spawn_item': 'Produces {item}',
  'item.fx.spawn_item_many': 'Produces {item} ×{count}',
  'item.fx.reveal_map': 'Reveals the map',
  'item.fx.reveal_near': 'Reveals the surroundings (radius {radius})',
  'item.fx.identify_one': 'Identifies an item you carry',
  'item.fx.identify_all': 'Identifies everything you carry',
  'item.fx.transform': 'Transforms into {actor}',
  'item.fx.light': 'Light (radius {radius}, {n} turns)',
  'item.fx.noise': 'Makes noise (radius {radius})',
  'item.fx.xp': '+{amount} {xp}',
  'item.fx.currency': '+{amount} {currency}',
  'item.fx.faction_hostile': 'Makes the target hostile',
  'item.fx.faction_neutral': 'Makes the target neutral',
  'item.fx.faction_friendly': 'Makes the target friendly',

  // targeting ({who} is "" for enemies, else an item.fx.who_* line)
  'item.fx.target_single': 'Target: one, range {range}{who}',
  'item.fx.target_adjacent': 'Target: all adjacent{who}',
  'item.fx.target_ray': 'Target: line, range {range}{who}',
  'item.fx.target_cone': 'Target: cone, length {range}{who}',
  'item.fx.target_area': 'Target: area radius {radius}, range {range}{who}',
  'item.fx.target_all_visible': 'Target: everything in sight{who}',
  'item.fx.who_allies': ', allies',
  'item.fx.who_all': ', everyone',
  'item.fx.chance': '{pct}% chance',

  // the item itself
  'item.fx.weapon': '{conflict}: {amount} {damageType} ({stat})',
  'item.fx.weapon_ranged': '{conflict}: {amount} {damageType}, range {range} ({stat})',
  'item.fx.modifier': '{amount} {stat}',
  'item.fx.modifier_carried': '{amount} {stat} while carried',
  'item.fx.cost': 'Costs {amount} {stat}',
  'item.fx.cooldown': 'Cooldown {n} turns',
  'item.fx.charges': 'Charges: {charges}/{max}',
  'item.fx.requires': 'Requires {stat} {min}',
  'item.fx.durability': 'Durability {n}',

  // triggers: "{event}: {effects}" (effects joined with ", ")
  'item.fx.trigger': '{event}: {effects}',
  'item.fx.trigger_every': '{event} (every {n}): {effects}',
  'item.fx.on.on_hit': 'On hit',
  'item.fx.on.on_hurt': 'On hurt',
  'item.fx.on.on_kill': 'On kill',
  'item.fx.on.on_death': 'On death',
  'item.fx.on.on_turn': 'On turn',
  'item.fx.on.on_enter_tile': 'On enter tile',
  'item.fx.on.on_pickup': 'On pickup',
  'item.fx.on.on_equip': 'On equip',
  'item.fx.on.on_unequip': 'On unequip',
  'item.fx.on.on_area_enter': 'On area enter',
  'item.fx.on.on_resource_empty': 'On resource empty',
  'item.fx.on.on_low_hp': 'On low hp',
} as const satisfies Record<string, string>;

export type ItemFxKey = keyof typeof ITEM_FX_KEYS;

/** catalog key of the "X is now <faction>" line */
export const FACTION_KEYS = {
  hostile: 'log.faction.hostile',
  neutral: 'log.faction.neutral',
  friendly: 'log.faction.friendly',
} as const satisfies Record<string, LogKey>;
export type LogParams = Record<string, string | number>;

/**
 * Keys of GameState.endReasonKey (the reason line of the end screen), with English templates.
 * Same template syntax as LOG_KEYS. A world-authored reason (the goal summary) has no key.
 */
export const END_REASON_KEYS = {
  /** "put in the dirt" */
  'end.loss.defeated': '{defeated}',
  /** "put in the dirt by Mesa Rattler" */
  'end.loss.by': '{defeated} by {by}',
  /** "put in the dirt (Lead)" */
  'end.loss.cause': '{defeated} ({cause})',
  /** "put in the dirt by Mesa Rattler (Lead)" */
  'end.loss.by_cause': '{defeated} by {by} ({cause})',
  /** a status/terrain and its damage type: "put in the dirt (Parched, Heat)" */
  'end.loss.cause_typed': '{defeated} ({cause}, {damageType})',
  /** "put in the dirt by Mesa Rattler (Rattler Venom, Poison)" */
  'end.loss.by_cause_typed': '{defeated} by {by} ({cause}, {damageType})',
  /** "Oxygen ran out" */
  'end.loss.resource': '{resource} ran out',
} as const satisfies Record<string, string>;

export type EndReasonKey = keyof typeof END_REASON_KEYS;

/**
 * The END_REASON_KEYS of a run lost because the player was defeated (hp reached 0), as opposed
 * to a fatal resource running out (end.loss.resource) or goal.lose (no key). Picks the ending text.
 */
export const DEATH_REASON_KEYS: ReadonlySet<string> = new Set<EndReasonKey>([
  'end.loss.defeated',
  'end.loss.by',
  'end.loss.cause',
  'end.loss.by_cause',
  'end.loss.cause_typed',
  'end.loss.by_cause_typed',
]);

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Renders a catalog template with params (`{name}` / `{name|cap}`). A param that is missing
 * renders as the empty string, never as "undefined". Exported for client catalogs.
 */
export function renderTemplate(template: string, params: LogParams = {}): string {
  return template.replace(/\{([A-Za-z0-9_]+)(\|cap)?\}/g, (_m, name: string, mod?: string) => {
    const v = params[name];
    const s = v === undefined || v === null ? '' : String(v);
    return mod ? cap(s) : s;
  });
}

/** the English text of a log key (unknown keys render as the key itself) */
export function renderLogKey(key: string, params?: LogParams): string {
  const t = (LOG_KEYS as Record<string, string>)[key] ?? (END_REASON_KEYS as Record<string, string>)[key];
  return t === undefined ? key : renderTemplate(t, params);
}

/** the param names a template uses, in order of first appearance (for catalog checks) */
export function templateParams(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/\{([A-Za-z0-9_]+)(?:\|cap)?\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
