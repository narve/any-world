/**
 * Backpack panel: all 28 generic slots (quick row + 20-slot grid), an inspect pane for the
 * cursor slot and its context actions. Keyboard state (cursor, grab, menu) is owned by GameUi.
 */
import type { SlotItemView } from '../viewmodel';
import { dataKey, h, icon, ICONS, setChildren } from '../dom';
import { QUICK_SLOTS, TOTAL_SLOTS, slotMenu, type SlotMenuEntry } from '../slots';
import { itemCard, slotButton, type Tooltip, type UiContext } from './common';
import { bindLongPress } from './hotbar';
import { t } from '../../i18n/index';

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
    this.quickEl = h('div', { class: 'aw-bp-quick', role: 'grid', 'aria-label': t('hotbar.label') });
    this.gridEl = h('div', { class: 'aw-bp-grid', role: 'grid', 'aria-label': t('bp.title') });
    this.inspectEl = h('div', { class: 'aw-bp-inspect', 'aria-live': 'polite' });
    this.hintEl = h('div', { class: 'aw-bp-hint' });
    this.el = h(
      'section',
      { class: 'aw-panel aw-backpack', role: 'dialog', 'aria-label': t('bp.title'), hidden: true },
      h(
        'header',
        { class: 'aw-panel-head' },
        h('h2', null, t('bp.title')),
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': t('bp.closeAria'), onclick: () => handlers.close() }, icon(ICONS.close)),
      ),
      h(
        'div',
        { class: 'aw-bp-body' },
        h('div', { class: 'aw-bp-slots' }, h('div', { class: 'aw-bp-label' }, t('bp.quick')), this.quickEl, h('div', { class: 'aw-bp-label' }, t('bp.carried')), this.gridEl),
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
      if (it) bindLongPress(b, () => this.handlers.openMenu(i));
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
        ? t('bp.hintMoving')
        : t('bp.hint');
    const inModal = !!(document.activeElement as HTMLElement | null)?.closest?.('.aw-modal:not([hidden])');
    if (!inModal) {
      const target = st.menuIndex !== null ? this.inspectEl.querySelector<HTMLElement>(`[data-menu="${st.menuIndex}"]`) : this.slotEls[st.cursor];
      target?.focus({ preventScroll: true });
    }
  }

  private renderInspect(slots: (SlotItemView | null)[], st: BackpackState): void {
    const it = slots[st.cursor] ?? null;
    if (!it) {
      setChildren(this.inspectEl, h('div', { class: 'aw-bp-empty' }, st.cursor < QUICK_SLOTS ? t('bp.emptyQuick', { n: st.cursor + 1 }) : t('bp.empty')));
      return;
    }
    const entries = slotMenu(slots, st.cursor);
    const actions = h(
      'div',
      { class: 'aw-bp-actions', role: 'menu', 'aria-label': t('bp.actionsFor', { item: it.name }) },
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
          h('kbd', { class: 'aw-key' }, e.key === 'Delete' ? t('key.del') : e.key),
        ),
      ),
    );
    setChildren(this.inspectEl, itemCard(it, this.ctx()), actions);
  }
}
