/**
 * Pure generic-slot logic: grid navigation over the 28 slots, moves, context menus and what
 * activating a slot means. No DOM.
 *
 * Panel layout used for keyboard navigation:
 *   row "quick": slots 0..7 (8 columns)
 *   backpack:    slots 8..27 as 4 rows × 5 columns
 */
import { BACKPACK_SLOTS, QUICK_SLOTS, TOTAL_SLOTS } from '../../engine/types';
import type { Dir, PlayerAction } from '../../engine/types';
import type { Vocabulary } from '../../schema/world';
import type { SlotItemView, UiIntent } from './viewmodel';
import { t } from '../i18n/index';

export { QUICK_SLOTS, BACKPACK_SLOTS, TOTAL_SLOTS };
export const BACKPACK_COLS = 5;
export const BACKPACK_ROWS = BACKPACK_SLOTS / BACKPACK_COLS;

export type Slots = readonly (SlotItemView | null | undefined)[];

export function isQuickSlot(i: number): boolean {
  return i >= 0 && i < QUICK_SLOTS;
}

export function isBackpackSlot(i: number): boolean {
  return i >= QUICK_SLOTS && i < TOTAL_SLOTS;
}

export function isValidSlot(i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < TOTAL_SLOTS;
}

/** hotbar key label for a slot ("1".."8"), or "" for backpack slots */
export function slotKeyLabel(i: number): string {
  return isQuickSlot(i) ? String(i + 1) : '';
}

/** move the keyboard cursor one step in the panel grid. Returns the same index at edges. */
export function navigateSlot(index: number, dir: Dir): number {
  if (!isValidSlot(index)) return 0;
  const dx = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
  const dy = dir.startsWith('n') ? -1 : dir.startsWith('s') ? 1 : 0;
  let i = index;
  if (dx !== 0) i = stepH(i, dx);
  if (dy !== 0) i = stepV(i, dy);
  return i;
}

function stepH(i: number, dx: number): number {
  if (isQuickSlot(i)) {
    const c = i + dx;
    return c >= 0 && c < QUICK_SLOTS ? c : i;
  }
  const b = i - QUICK_SLOTS;
  const col = b % BACKPACK_COLS;
  const nc = col + dx;
  return nc >= 0 && nc < BACKPACK_COLS ? i + dx : i;
}

function stepV(i: number, dy: number): number {
  if (isQuickSlot(i)) {
    if (dy < 0) return i;
    const col = Math.round((i * (BACKPACK_COLS - 1)) / (QUICK_SLOTS - 1));
    return QUICK_SLOTS + col;
  }
  const b = i - QUICK_SLOTS;
  const row = Math.floor(b / BACKPACK_COLS);
  const col = b % BACKPACK_COLS;
  const nr = row + dy;
  if (nr < 0) return Math.round((col * (QUICK_SLOTS - 1)) / (BACKPACK_COLS - 1));
  if (nr >= BACKPACK_ROWS) return i;
  return QUICK_SLOTS + nr * BACKPACK_COLS + col;
}

/** a move_item action, or null when it would do nothing */
export function moveAction(slots: Slots, from: number, to: number): PlayerAction | null {
  if (!isValidSlot(from) || !isValidSlot(to) || from === to) return null;
  if (!slots[from]) return null;
  return { type: 'move_item', from, to };
}

export function firstEmpty(slots: Slots, start: number, end: number): number | null {
  for (let i = start; i < end; i++) if (!slots[i]) return i;
  return null;
}

export function firstEmptyQuick(slots: Slots): number | null {
  return firstEmpty(slots, 0, QUICK_SLOTS);
}

export function firstEmptyBackpack(slots: Slots): number | null {
  return firstEmpty(slots, QUICK_SLOTS, TOTAL_SLOTS);
}

export type ActivateResult =
  | { kind: 'action'; action: PlayerAction }
  | { kind: 'intent'; intent: UiIntent }
  | { kind: 'inspect' }
  /**
   * nothing to do on activation (already equipped, or passive): the UI explains the item in a small
   * tip anchored to the slot — it never opens the backpack by surprise
   */
  | { kind: 'explain' }
  /** cannot be used right now (cooldown); `reason` is shown as a notice */
  | { kind: 'blocked'; reason: string }
  | null;

/**
 * What pressing a hotbar key / double-clicking a slot does:
 *  - targeted items start targeting,
 *  - unequipped equipment is equipped ("activating a weapon swaps to it"),
 *  - usable items are used,
 *  - anything else (passive, already equipped) is explained in a tip next to the slot.
 */
export function activateSlot(slots: Slots, slot: number): ActivateResult {
  const it = slots[slot];
  if (!it) return null;
  if (it.usable && it.cooldown && it.cooldown > 0 && !(it.equipSlot && !it.equipped)) {
    return { kind: 'blocked', reason: t('slot.cooldown', { item: it.name, n: it.cooldown }) };
  }
  if (it.usable && it.needsTarget) {
    return { kind: 'intent', intent: { type: 'begin_target', slot } };
  }
  if (it.equipSlot && !it.equipped && !it.usable) return { kind: 'action', action: { type: 'equip', slot } };
  if (it.usable) return { kind: 'action', action: { type: 'use', slot } };
  if (it.equipSlot && !it.equipped) return { kind: 'action', action: { type: 'equip', slot } };
  return { kind: 'explain' };
}

/** what the slot tip says about an item that activating does nothing for */
export interface SlotExplanation {
  title: string;
  lines: string[];
}

/**
 * Plain words for an equipped or passive item, with the world's words: "Equipped as your
 * Comeback — bump into anyone hostile to use it" (PLAN backlog "Clearer controls & goals").
 */
export function slotExplanation(it: SlotItemView, vocab: Pick<Vocabulary, 'conflict'>): SlotExplanation {
  const lines: string[] = [];
  const conflict = vocab.conflict;
  if (it.equipped && it.equipSlot === 'weapon') lines.push(t('slot.explain.weapon', { item: it.name, conflict }));
  else if (it.equipped && it.equipSlot === 'armour') lines.push(t('slot.explain.armour', { item: it.name }));
  else if (it.equipped) lines.push(t('slot.explain.equipped', { item: it.name }));
  else lines.push(t('slot.explain.passive', { item: it.name }));
  // what it does, as far as the player knows
  if (it.knowledge === 'clear' && it.effectLines.length) lines.push(...it.effectLines.slice(0, 3));
  else if (it.knowledge === 'vague' && it.vagueText) lines.push(it.vagueText);
  else if (it.knowledge === 'unknown') lines.push(t('item.unknownText'));
  if (it.equipped) lines.push(t('slot.explain.badge'));
  return { title: it.name, lines };
}

export type SlotMenuId = 'use' | 'equip' | 'unequip' | 'to_quick' | 'to_backpack' | 'move' | 'drop';

export interface SlotMenuEntry {
  id: SlotMenuId;
  label: string;
  /** keyboard shortcut inside the backpack */
  key: string;
  result: ActivateResult | { kind: 'grab' };
  disabled?: boolean;
  hint?: string;
}

/** context actions for an item in `slot` (empty slot → []) */
export function slotMenu(slots: Slots, slot: number): SlotMenuEntry[] {
  const it = slots[slot];
  if (!it) return [];
  const out: SlotMenuEntry[] = [];
  if (it.usable) {
    const coolingDown = !!(it.cooldown && it.cooldown > 0);
    out.push({
      id: 'use',
      label: t('menu.use'),
      key: 'u',
      result: it.needsTarget
        ? { kind: 'intent', intent: { type: 'begin_target', slot } }
        : { kind: 'action', action: { type: 'use', slot } },
      disabled: coolingDown,
      hint: coolingDown ? t('menu.readyIn', { n: it.cooldown ?? 0 }) : undefined,
    });
  }
  if (it.equipSlot && !it.equipped) out.push({ id: 'equip', label: t('menu.equip'), key: 'e', result: { kind: 'action', action: { type: 'equip', slot } } });
  if (it.equipped) out.push({ id: 'unequip', label: t('menu.unequip'), key: 'e', result: { kind: 'action', action: { type: 'unequip', slot } } });
  if (isBackpackSlot(slot)) {
    const q = firstEmptyQuick(slots);
    out.push({
      id: 'to_quick',
      label: q === null ? t('menu.toQuickFull') : t('menu.toQuick', { n: q + 1 }),
      key: 'q',
      result: q === null ? null : { kind: 'action', action: { type: 'move_item', from: slot, to: q } },
      disabled: q === null,
    });
  } else {
    const b = firstEmptyBackpack(slots);
    out.push({
      id: 'to_backpack',
      label: b === null ? t('menu.toBackpackFull') : t('menu.toBackpack'),
      key: 'b',
      result: b === null ? null : { kind: 'action', action: { type: 'move_item', from: slot, to: b } },
      disabled: b === null,
    });
  }
  out.push({ id: 'move', label: t('menu.move'), key: 'm', result: { kind: 'grab' } });
  out.push({ id: 'drop', label: t('menu.drop'), key: 'Delete', result: { kind: 'action', action: { type: 'drop', slot } } });
  return out;
}

/** assign the item in `from` to quick slot `quickIndex` (0..7), swapping with what is there */
export function assignQuickAction(slots: Slots, from: number, quickIndex: number): PlayerAction | null {
  if (!isQuickSlot(quickIndex)) return null;
  return moveAction(slots, from, quickIndex);
}

/** encode/decode slot indices for HTML drag & drop */
export const DRAG_MIME = 'application/x-anyworld-slot';

export function encodeDrag(slot: number): string {
  return `slot:${slot}`;
}

export function decodeDrag(data: string | null | undefined): number | null {
  if (!data) return null;
  const m = /^slot:(\d+)$/.exec(data.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return isValidSlot(n) ? n : null;
}
