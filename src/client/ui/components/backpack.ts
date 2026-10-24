/**
 * Backpack panel: all 28 generic slots (quick row + 20-slot grid), an inspect pane for the
 * cursor slot and its context actions. Keyboard state (cursor, grab, menu) is owned by GameUi.
 */
import type { SlotItemView } from '../viewmodel';
import { dataKey, h, icon, ICONS, setChildren } from '../dom';
import { QUICK_SLOTS, TOTAL_SLOTS, slotMenu, type SlotMenuEntry } from '../slots';
import { itemCard, slotButton, type Tooltip, type UiContext } from './common';

export interface BackpackState {
  open: boolean;
  cursor: number;
  grabbed: number | null;
  /** index into slotMenu(cursor) while the action menu has keyboard focus */
  menuIndex: number | null;
}

export interface BackpackHandlers {
  select(slot: number): void;
  activate(slot: number): void;
  openMenu(slot: number): void;
  runEntry(slot: number, entry: SlotMenuEntry): void;
  close(): void;
  bindSlot(el: HTMLElement, slot: number): void;
}

export class Backpack {
  readonly el: HTMLElement;
  private quickEl: HTMLElement;
  private gridEl: HTMLElement;
  private inspectEl: HTMLElement;
  private hintEl: HTMLElement;
  private key = '';
  private slotEls: HTMLButtonElement[] = [];

  constructor(private handlers: BackpackHandlers, _tooltip: Tooltip, private ctx: () => UiContext) {
    this.quickEl = h('div', { class: 'aw-bp-quick', role: 'grid', 'aria-label': 'Quick slots' });
    this.gridEl = h('div', { class: 'aw-bp-grid', role: 'grid', 'aria-label': 'Backpack' });
    this.inspectEl = h('div', { class: 'aw-bp-inspect', 'aria-live': 'polite' });
    this.hintEl = h('div', { class: 'aw-bp-hint' });
    this.el = h(
      'section',
      { class: 'aw-panel aw-backpack', role: 'dialog', 'aria-label': 'Backpack', hidden: true },
      h(
        'header',
        { class: 'aw-panel-head' },
        h('h2', null, 'Backpack'),
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': 'Close backpack', onclick: () => handlers.close() }, icon(ICONS.close)),
      ),
      h(
        'div',
        { class: 'aw-bp-body' },
        h('div', { class: 'aw-bp-slots' }, h('div', { class: 'aw-bp-label' }, 'Quick slots 1–8'), this.quickEl, h('div', { class: 'aw-bp-label' }, 'Carried'), this.gridEl),
        this.inspectEl,
      ),
      this.hintEl,
    );
  }

  update(slots: (SlotItemView | null)[], st: BackpackState): void {
    this.el.hidden = !st.open;
    if (!st.open) {
      this.key = '';
      return;
    }
    const key = dataKey([slots, st]);
    if (key === this.key) return;
    this.key = key;
    this.slotEls = [];
    const q: HTMLElement[] = [];
    const g: HTMLElement[] = [];
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const it = slots[i] ?? null;
      const b = slotButton(i, it, { cursor: st.cursor === i, grabbed: st.grabbed === i, dropTarget: st.grabbed !== null && st.cursor === i });
      b.tabIndex = st.cursor === i ? 0 : -1;
      b.setAttribute('role', 'gridcell');
      b.setAttribute('aria-selected', String(st.cursor === i));
      b.addEventListener('click', () => this.handlers.select(i));
      b.addEventListener('dblclick', () => this.handlers.activate(i));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.handlers.openMenu(i);
      });
      this.handlers.bindSlot(b, i);
      this.slotEls.push(b);
      (i < QUICK_SLOTS ? q : g).push(b);
    }
    setChildren(this.quickEl, q);
    setChildren(this.gridEl, g);
    this.renderInspect(slots, st);
    this.hintEl.textContent =
      st.grabbed !== null
        ? 'Moving: pick a slot with the arrows and press Enter (Esc cancels). You can also drag.'
        : 'Arrows move · Enter actions · 1–8 to quick slot · u use · e equip · m move · Del drop · Esc close';
    const inModal = !!(document.activeElement as HTMLElement | null)?.closest?.('.aw-modal:not([hidden])');
    if (!inModal) {
      const target = st.menuIndex !== null ? this.inspectEl.querySelector<HTMLElement>(`[data-menu="${st.menuIndex}"]`) : this.slotEls[st.cursor];
      target?.focus({ preventScroll: true });
    }
  }

  private renderInspect(slots: (SlotItemView | null)[], st: BackpackState): void {
    const it = slots[st.cursor] ?? null;
    if (!it) {
      setChildren(this.inspectEl, h('div', { class: 'aw-bp-empty' }, st.cursor < QUICK_SLOTS ? `Quick slot ${st.cursor + 1} is empty.` : 'Empty slot.'));
      return;
    }
    const entries = slotMenu(slots, st.cursor);
    const actions = h(
      'div',
      { class: 'aw-bp-actions', role: 'menu', 'aria-label': `Actions for ${it.name}` },
      entries.map((e, idx) =>
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            class: ['aw-btn', 'aw-btn-small', st.menuIndex === idx && 'is-active', e.id === 'drop' && 'aw-btn-danger'],
            disabled: e.disabled,
            dataset: { menu: idx, tip: e.hint },
            tabindex: st.menuIndex === idx ? '0' : '-1',
            onclick: () => this.handlers.runEntry(st.cursor, e),
          },
          e.label,
          h('kbd', null, e.key === 'Delete' ? 'Del' : e.key),
        ),
      ),
    );
    setChildren(this.inspectEl, itemCard(it, this.ctx()), actions);
  }
}
