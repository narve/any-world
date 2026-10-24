/** Hotbar: quick slots 1-8 plus panel buttons. Slot interaction is delegated to SlotDnD. */
import type { SlotItemView } from '../viewmodel';
import { dataKey, h, icon, ICONS, setChildren } from '../dom';
import { QUICK_SLOTS } from '../slots';
import { slotButton, type Tooltip, itemCard, type UiContext } from './common';

export interface HotbarHandlers {
  activate(slot: number): void;
  openMenu(slot: number): void;
  toggleBackpack(): void;
  toggleRules(): void;
  toggleHelp(): void;
  bindSlot(el: HTMLElement, slot: number): void;
}

export class Hotbar {
  readonly el: HTMLElement;
  private slotsEl: HTMLElement;
  private key = '';

  constructor(private handlers: HotbarHandlers, private tooltip: Tooltip, private ctx: () => UiContext) {
    this.slotsEl = h('div', { class: 'aw-hotbar-slots', role: 'toolbar', 'aria-label': 'Quick slots' });
    this.el = h(
      'nav',
      { class: 'aw-panel aw-hotbar', 'aria-label': 'Quick slots' },
      this.slotsEl,
      h(
        'div',
        { class: 'aw-hotbar-tools' },
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': 'Backpack (i)', dataset: { tip: 'Backpack (i / Tab)' }, onclick: () => handlers.toggleBackpack() }, icon(ICONS.bag)),
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': 'Rules and goals (r)', dataset: { tip: 'Rules & goals (r)' }, onclick: () => handlers.toggleRules() }, icon(ICONS.scroll)),
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': 'Help (?)', dataset: { tip: 'Controls (?)' }, onclick: () => handlers.toggleHelp() }, icon(ICONS.help)),
      ),
    );
  }

  update(slots: (SlotItemView | null)[], targetingSlot: number | null): void {
    const key = dataKey([slots.slice(0, QUICK_SLOTS), targetingSlot]);
    if (key === this.key) return;
    this.key = key;
    const els: HTMLElement[] = [];
    for (let i = 0; i < QUICK_SLOTS; i++) {
      const it = slots[i] ?? null;
      const b = slotButton(i, it, { cursor: targetingSlot === i });
      b.addEventListener('click', () => this.handlers.activate(i));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.handlers.openMenu(i);
      });
      if (it) this.tooltip.register(b, () => itemCard(it, this.ctx(), h('div', { class: 'aw-card-hint' }, `Press ${i + 1} to use · right-click for more`)));
      this.handlers.bindSlot(b, i);
      els.push(b);
    }
    setChildren(this.slotsEl, els);
  }
}
