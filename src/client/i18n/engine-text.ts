/**
 * Engine-made text that is not a log line, in the UI language (DESIGN §7b). The engine still
 * produces a few short English strings outside LogMessage key/params: refusal reasons of `invalid`
 * events ("blocked"), the labels of its built-in dialogue options ("Ask what they know"), and the
 * NPC role enum. These helpers map them onto catalog keys; anything unknown is returned as the
 * engine wrote it (capitalised), so a new engine string is never lost, only untranslated.
 */
import type { ItemEffectLine, ItemView } from '../../engine/types';
import { capitalizeFirst, t, tx, type MessageParams } from './index';

/** "you cannot move" → "you_cannot_move" (the key suffix under engine.invalid.*) */
export function reasonSlug(reason: string): string {
  return reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** reasons with a world word in them: the pattern and the catalog key + param it fills */
const DYNAMIC: { re: RegExp; key: string; param: string }[] = [
  { re: /^not enough (.+)$/i, key: 'engine.invalid.not_enough', param: 'currency' },
  { re: /^(.+): nothing more to find$/i, key: 'engine.invalid.nothing_more_to_find', param: 'terrain' },
  { re: /^(.+) cannot be equipped$/i, key: 'engine.invalid.cannot_be_equipped', param: 'item' },
  { re: /^(.+) has nothing to say$/i, key: 'engine.invalid.nothing_to_say', param: 'name' },
];

/** an engine refusal reason ("blocked", "Kari has nothing to say") as a UI sentence */
export function engineReason(reason: string): string {
  const fallback = capitalizeFirst(reason.trim());
  if (!reason.trim()) return fallback;
  for (const d of DYNAMIC) {
    const m = d.re.exec(reason.trim());
    if (m) return tx(d.key, { [d.param]: m[1] }, fallback);
  }
  return tx(`engine.invalid.${reasonSlug(reason)}`, {}, fallback);
}

/** labels of the engine's built-in dialogue options (src/engine/npc.ts, gm.ts offers) */
const OPTION_LABELS: Record<string, string> = {
  'Ask for help': 'dlg.opt.askHelp',
  'Offer to help': 'dlg.opt.offerHelp',
  'Ask them to come along': 'dlg.opt.recruit',
  'Ask what they know': 'dlg.opt.askKnow',
  Goodbye: 'dlg.opt.goodbye',
  Leave: 'dlg.opt.leave',
};
const OPTION_TAGS: Record<string, string> = {
  'service:heal': 'dlg.opt.askHelp',
  'service:gift': 'dlg.opt.offerHelp',
  'service:recruit': 'dlg.opt.recruit',
};

/**
 * A dialogue option's label in the UI language. Built-in options (by tag, or by the engine's exact
 * English label) come from the catalog; anything else (buy/sell offers with world item names,
 * GM- or AI-written replies) is already world text and is returned unchanged.
 */
export function dialogueOptionLabel(option: { label: string; tag?: string }): string {
  const key = (option.tag && OPTION_TAGS[option.tag]) || OPTION_LABELS[option.label];
  return key ? tx(key, {}, option.label) : option.label;
}

/** an NPC role ("quest_giver") as a short title ("quest giver" / "oppdragsgiver") */
export function npcRoleLabel(role: string): string {
  return tx(`npc.role.${role}`, {}, role.replace(/_/g, ' '));
}

/** the floating text over a target that was missed */
export function missLabel(): string {
  return t('fx.miss');
}

/**
 * An item effect line (engine ItemEffectLine: item.fx.* key + params) in the UI language. Sub-lines
 * (a trigger's event and effects, a scaled amount, the "allies" suffix) are rendered first and
 * replace their English params; a key no catalog has shows the engine's English text.
 */
export function itemEffectText(line: ItemEffectLine): string {
  const params: MessageParams = { ...line.params };
  for (const [name, sub] of Object.entries(line.sub ?? {})) params[name] = Array.isArray(sub) ? sub.map(itemEffectText).join(', ') : itemEffectText(sub);
  return tx(line.key, params, line.text);
}

/** an item's effect lines in the UI language (the English effectLines when it has no keyed lines) */
export function itemEffectTexts(item: Pick<ItemView, 'effectLines' | 'effects'>): string[] {
  const fx = item.effects;
  return fx && fx.length === item.effectLines.length ? fx.map(itemEffectText) : item.effectLines;
}
