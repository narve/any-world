/**
 * Hotbar: quick slots 1-8 plus panel buttons. Slot drag & drop is delegated to bindSlot. Touch: a
 * tap activates a slot, a long press opens its actions (the same as a right click).
 */
import type { SlotItemView } from '../viewmodel';
import { dataKey, h, icon, ICONS, setChildren } from '../dom';
import { QUICK_SLOTS } from '../slots';
import { slotButton, type Tooltip, itemCard, type UiContext } from './common';
import { t } from '../../i18n/index';

export interface HotbarHandlers {
  activate(slot: number): void;
  openMenu(slot: number): void;
  toggleBackpack(): void;
  toggleRules(): void;
  toggleHelp(): void;
  toggleSound(): void;
  openSettings(): void;
  bindSlot(el: HTMLElement, slot: number): void;
}

/** how long a press must be held to count as a long press (touch "right click") */
export const LONG_PRESS_MS = 500;

/**
 * Long-press on touch: calls `onLong` after LONG_PRESS_MS unless the finger moved or lifted, and
 * swallows the click that follows. Mouse and pen clicks are untouched.
 */
export function bindLongPress(el: HTMLElement, onLong: () => void): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  el.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      onLong();
    }, LONG_PRESS_MS);
  });
  el.addEventListener('pointermove', (e: PointerEvent) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener(
    'click',
    (e) => {
      if (!fired) return;
      fired = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true,
  );
  // the browser's own long-press menu would duplicate ours
  el.addEventListener('contextmenu', (e) => {
    if (fired) e.preventDefault();
  });
}

export class Hotbar {
  readonly el: HTMLElement;
  private slotsEl: HTMLElement;
  private key = '';
  private slotEls: HTMLElement[] = [];
  private soundBtn: HTMLButtonElement;
  private muted: boolean | null = null;

  constructor(private handlers: HotbarHandlers, private tooltip: Tooltip, private ctx: () => UiContext) {
    this.soundBtn = h('button', { type: 'button', class: 'aw-icon-btn aw-hotbar-sound', onclick: () => handlers.toggleSound() }) as HTMLButtonElement;
    this.setMuted(false);
    this.slotsEl = h('div', { class: 'aw-hotbar-slots', role: 'toolbar', 'aria-label': t('hotbar.label') });
    this.el = h(
      'nav',
      { class: 'aw-panel aw-hotbar', 'aria-label': t('hotbar.label') },
      this.slotsEl,
      h(
        'div',
        { class: 'aw-hotbar-tools' },
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': t('hotbar.backpackAria'), dataset: { tip: t('hotbar.backpackTip') }, onclick: () => handlers.toggleBackpack() }, icon(ICONS.bag)),
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': t('hotbar.rulesAria'), dataset: { tip: t('hotbar.rulesTip') }, onclick: () => handlers.toggleRules() }, icon(ICONS.scroll)),
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': t('hotbar.helpAria'), dataset: { tip: t('hotbar.helpTip') }, onclick: () => handlers.toggleHelp() }, icon(ICONS.help)),
        this.soundBtn,
        h('button', { type: 'button', class: 'aw-icon-btn aw-hotbar-settings', 'aria-label': t('hotbar.settingsAria'), dataset: { tip: t('hotbar.settingsTip') }, onclick: () => handlers.openSettings() }, icon(ICONS.gear)),
      ),
    );
  }

  /** the sound toggle shows the saved mute setting */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    const label = muted ? t('hotbar.soundOnAria') : t('hotbar.soundOffAria');
    this.soundBtn.setAttribute('aria-label', label);
    this.soundBtn.setAttribute('aria-pressed', String(muted));
    this.soundBtn.dataset.tip = label;
    this.soundBtn.replaceChildren(icon(muted ? ICONS.soundOff : ICONS.sound));
  }

  /** the element of quick slot `i` (anchors the slot tip) */
  slotEl(i: number): HTMLElement | null {
    return this.slotEls[i] ?? null;
  }

  update(slots: (SlotItemView | null)[], targetingSlot: number | null): void {
    const key = dataKey([slots.slice(0, QUICK_SLOTS), targetingSlot]);
    if (key === this.key) return;
    this.key = key;
    const els: HTMLElement[] = [];
    for (let i = 0; i < QUICK_SLOTS; i++) {
      const it = slots[i] ?? null;
      const b = slotButton(i, it, { cursor: targetingSlot === i });
      // first, so its click-swallowing listener runs before activate
      if (it) bindLongPress(b, () => this.handlers.openMenu(i));
      b.addEventListener('click', () => this.handlers.activate(i));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.handlers.openMenu(i);
      });
      if (it) {
        const hint = it.equipped ? t('hotbar.cardHintEquipped', { n: i + 1 }) : t('hotbar.cardHint', { n: i + 1 });
        this.tooltip.register(b, () => itemCard(it, this.ctx(), h('div', { class: 'aw-card-hint' }, hint)));
      }
      this.handlers.bindSlot(b, i);
      els.push(b);
    }
    this.slotEls = els;
    setChildren(this.slotsEl, els);
  }
}
