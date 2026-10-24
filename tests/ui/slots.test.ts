import { describe, expect, it } from 'vitest';
import {
  activateSlot,
  assignQuickAction,
  decodeDrag,
  encodeDrag,
  firstEmptyBackpack,
  firstEmptyQuick,
  isBackpackSlot,
  isQuickSlot,
  moveAction,
  navigateSlot,
  slotKeyLabel,
  slotMenu,
  TOTAL_SLOTS,
} from '../../src/client/ui/slots';
import type { SlotItemView } from '../../src/client/ui/viewmodel';
import { demoSlots } from '../../src/client/ui/demo-data';

function it_(over: Partial<SlotItemView> = {}): SlotItemView {
  return {
    instanceId: 'i1',
    defId: 'thing',
    name: 'Thing',
    kind: 'Thing',
    description: '',
    knowledge: 'clear',
    effectLines: [],
    notes: [],
    count: 1,
    equipped: false,
    usable: true,
    stackable: false,
    color: '#888888',
    ...over,
  };
}

function slotsWith(entries: Record<number, SlotItemView>): (SlotItemView | null)[] {
  const s: (SlotItemView | null)[] = new Array(TOTAL_SLOTS).fill(null);
  for (const [k, v] of Object.entries(entries)) s[Number(k)] = v;
  return s;
}

describe('slot geometry', () => {
  it('classifies slots and labels hotbar keys', () => {
    expect(TOTAL_SLOTS).toBe(28);
    expect(isQuickSlot(0) && isQuickSlot(7)).toBe(true);
    expect(isQuickSlot(8)).toBe(false);
    expect(isBackpackSlot(8) && isBackpackSlot(27)).toBe(true);
    expect(isBackpackSlot(28)).toBe(false);
    expect(slotKeyLabel(0)).toBe('1');
    expect(slotKeyLabel(7)).toBe('8');
    expect(slotKeyLabel(8)).toBe('');
  });

  it('navigates the quick row horizontally and stops at edges', () => {
    expect(navigateSlot(0, 'e')).toBe(1);
    expect(navigateSlot(0, 'w')).toBe(0);
    expect(navigateSlot(7, 'e')).toBe(7);
    expect(navigateSlot(3, 'n')).toBe(3);
  });

  it('moves between the quick row and the 5-wide backpack grid', () => {
    expect(navigateSlot(0, 's')).toBe(8);
    expect(navigateSlot(7, 's')).toBe(12);
    expect(navigateSlot(8, 'n')).toBe(0);
    expect(navigateSlot(12, 'n')).toBe(7);
    expect(navigateSlot(8, 's')).toBe(13);
    expect(navigateSlot(23, 's')).toBe(23); // bottom row stays
    expect(navigateSlot(12, 'e')).toBe(12);
    expect(navigateSlot(13, 'w')).toBe(13);
    expect(navigateSlot(9, 'se')).toBe(15);
  });

  it('every slot is reachable from slot 0 with arrow navigation', () => {
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length) {
      const i = queue.shift()!;
      for (const d of ['n', 's', 'e', 'w'] as const) {
        const j = navigateSlot(i, d);
        if (!seen.has(j)) {
          seen.add(j);
          queue.push(j);
        }
      }
    }
    expect(seen.size).toBe(TOTAL_SLOTS);
  });
});

describe('moving items', () => {
  it('builds move_item actions only when meaningful', () => {
    const s = slotsWith({ 2: it_() });
    expect(moveAction(s, 2, 10)).toEqual({ type: 'move_item', from: 2, to: 10 });
    expect(moveAction(s, 2, 2)).toBeNull();
    expect(moveAction(s, 3, 10)).toBeNull();
    expect(moveAction(s, 2, 28)).toBeNull();
    expect(moveAction(s, -1, 0)).toBeNull();
  });

  it('assigns to quick slots by swapping', () => {
    const s = slotsWith({ 0: it_(), 12: it_() });
    expect(assignQuickAction(s, 12, 0)).toEqual({ type: 'move_item', from: 12, to: 0 });
    expect(assignQuickAction(s, 12, 8)).toBeNull();
  });

  it('finds empty slots', () => {
    const s = slotsWith({ 0: it_(), 1: it_(), 8: it_() });
    expect(firstEmptyQuick(s)).toBe(2);
    expect(firstEmptyBackpack(s)).toBe(9);
    const full = new Array(TOTAL_SLOTS).fill(it_());
    expect(firstEmptyQuick(full)).toBeNull();
    expect(firstEmptyBackpack(full)).toBeNull();
  });

  it('drag payloads round-trip and reject junk', () => {
    expect(decodeDrag(encodeDrag(17))).toBe(17);
    expect(decodeDrag('slot:28')).toBeNull();
    expect(decodeDrag('hello')).toBeNull();
    expect(decodeDrag(null)).toBeNull();
  });
});

describe('activating a slot', () => {
  it('empty slot does nothing', () => {
    expect(activateSlot(slotsWith({}), 0)).toBeNull();
  });

  it('uses usable items', () => {
    expect(activateSlot(slotsWith({ 1: it_() }), 1)).toEqual({ kind: 'action', action: { type: 'use', slot: 1 } });
  });

  it('targeted items begin targeting', () => {
    expect(activateSlot(slotsWith({ 2: it_({ needsTarget: true }) }), 2)).toEqual({ kind: 'intent', intent: { type: 'begin_target', slot: 2 } });
  });

  it('items on cooldown are blocked with a reason', () => {
    const r = activateSlot(slotsWith({ 2: it_({ name: 'Ricochet Shot', needsTarget: true, cooldown: 2 }) }), 2);
    expect(r).toEqual({ kind: 'blocked', reason: 'Ricochet Shot is ready in 2 turns' });
  });

  it('unequipped equipment gets equipped; equipped passive items are inspected', () => {
    expect(activateSlot(slotsWith({ 0: it_({ usable: false, equipSlot: 'weapon' }) }), 0)).toEqual({ kind: 'action', action: { type: 'equip', slot: 0 } });
    expect(activateSlot(slotsWith({ 0: it_({ usable: false, equipSlot: 'weapon', equipped: true }) }), 0)).toEqual({ kind: 'inspect' });
    expect(activateSlot(slotsWith({ 0: it_({ usable: false }) }), 0)).toEqual({ kind: 'inspect' });
  });
});

describe('context menu', () => {
  it('offers use/equip/move/drop for backpack items', () => {
    const s = slotsWith({ 0: it_(), 9: it_({ equipSlot: 'trinket' }) });
    const ids = slotMenu(s, 9).map((e) => e.id);
    expect(ids).toEqual(['use', 'equip', 'to_quick', 'move', 'drop']);
    const toQuick = slotMenu(s, 9).find((e) => e.id === 'to_quick')!;
    expect(toQuick.result).toEqual({ kind: 'action', action: { type: 'move_item', from: 9, to: 1 } });
    expect(toQuick.label).toBe('To quick slot 2');
  });

  it('offers unequip and to_backpack for equipped quick items', () => {
    const s = slotsWith({ 0: it_({ usable: false, equipSlot: 'weapon', equipped: true }) });
    const menu = slotMenu(s, 0);
    expect(menu.map((e) => e.id)).toEqual(['unequip', 'to_backpack', 'move', 'drop']);
    expect(menu[1].result).toEqual({ kind: 'action', action: { type: 'move_item', from: 0, to: 8 } });
    expect(menu.find((e) => e.id === 'drop')!.result).toEqual({ kind: 'action', action: { type: 'drop', slot: 0 } });
  });

  it('disables use while cooling down and quick move when full', () => {
    const full = new Array(TOTAL_SLOTS).fill(it_());
    full[10] = it_({ cooldown: 3 });
    const m = slotMenu(full, 10);
    expect(m.find((e) => e.id === 'use')!.disabled).toBe(true);
    expect(m.find((e) => e.id === 'use')!.hint).toBe('Ready in 3 turns');
    expect(m.find((e) => e.id === 'to_quick')!.disabled).toBe(true);
  });

  it('menu shortcut keys are unique per menu and avoid backpack navigation keys', () => {
    const slots = demoSlots();
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const keys = slotMenu(slots, i).map((e) => e.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(['w', 'a', 's', 'd', 'h', 'j', 'k', 'l']).not.toContain(k);
    }
  });

  it('empty slot has no menu', () => {
    expect(slotMenu(slotsWith({}), 5)).toEqual([]);
  });
});
