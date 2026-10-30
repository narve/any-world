/**
 * Shared component pieces: item glyph icons, slot buttons, bars, chips, inspect cards and the
 * floating tooltip.
 */
import type { Vocabulary } from '../../../schema/world';
import type { ActorTooltipView, BarView, SlotItemView, StatusChipView, TileTooltipView } from '../viewmodel';
import type { ItemView } from '../../../engine/types';
import { h, type Child } from '../dom';
import {
  barText,
  cooldownFraction,
  factionLabel,
  itemGlyph,
  knowledgeBadge,
  knowledgeLines,
  pct,
  stackText,
  threatLabel,
} from '../format';
import { slotKeyLabel as slotKeyLabelFor } from '../slots';
import { textOn } from '../theme';
import { t } from '../../i18n/index';

export interface UiContext {
  vocab: Vocabulary;
}

// ---------------------------------------------------------------------------
// Glyphs & slots
// ---------------------------------------------------------------------------

export function glyph(item: Pick<ItemView, 'name' | 'knowledge' | 'color'> & { glyph?: string; thumb?: string }, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  const color = item.color || '#888888';
  // a rendered model thumbnail when the renderer provides one (never for unknown items)
  if (item.thumb && item.knowledge !== 'unknown') {
    return h(
      'span',
      { class: ['aw-glyph', `aw-glyph-${size}`, 'has-thumb'], style: { '--item': color }, 'aria-hidden': 'true' },
      h('img', { src: item.thumb, alt: '', draggable: 'false' }),
    );
  }
  return h(
    'span',
    {
      class: ['aw-glyph', `aw-glyph-${size}`, item.knowledge === 'unknown' && 'is-unknown'],
      style: { '--item': color, '--item-fg': textOn(color) },
      'aria-hidden': 'true',
    },
    itemGlyph(item),
  );
}

export interface SlotRenderOpts {
  cursor?: boolean;
  grabbed?: boolean;
  dropTarget?: boolean;
  compact?: boolean;
}

export function slotAriaLabel(index: number, item: SlotItemView | null | undefined): string {
  const where = index < 8 ? t('slot.aria.quick', { n: index + 1 }) : t('slot.aria.backpack', { n: index - 7 });
  if (!item) return t('slot.aria.empty', { where });
  const bits = [item.name];
  if (item.count > 1) bits.push(`${item.count}`);
  if (item.charges !== undefined) bits.push(t('slot.aria.charges', { n: item.charges }));
  if (item.equipped) bits.push(t('slot.aria.equipped'));
  if (item.cooldown && item.cooldown > 0) bits.push(t('slot.aria.cooldown', { n: item.cooldown }));
  return t('slot.aria.item', { where, what: bits.join(', ') });
}

export function slotButton(index: number, item: SlotItemView | null | undefined, opts: SlotRenderOpts = {}): HTMLButtonElement {
  const key = slotKeyLabelFor(index);
  const cd = item ? cooldownFraction(item) : 0;
  const count = item ? stackText(item) : '';
  const btn = h(
    'button',
    {
      type: 'button',
      class: [
        'aw-slot',
        !item && 'is-empty',
        item?.equipped && 'is-equipped',
        item?.knowledge === 'unknown' && 'is-unknown',
        item?.rarity && `rarity-${item.rarity}`,
        opts.cursor && 'is-cursor',
        opts.grabbed && 'is-grabbed',
        opts.dropTarget && 'is-drop',
        cd > 0 && 'is-cooling',
        item?.urgent && 'is-urgent',
      ],
      dataset: { slot: index },
      draggable: item ? 'true' : undefined,
      'aria-label': slotAriaLabel(index, item),
    },
    key ? h('span', { class: 'aw-slot-key', 'aria-hidden': 'true' }, key) : null,
    item ? glyph(item, opts.compact ? 'sm' : 'md') : null,
    count ? h('span', { class: 'aw-slot-count', 'aria-hidden': 'true' }, count) : null,
    cd > 0
      ? h('span', { class: 'aw-slot-cd', style: { '--cd': cd.toFixed(3) }, 'aria-hidden': 'true' }, h('span', null, String(item?.cooldown ?? '')))
      : null,
    item?.equipped ? h('span', { class: 'aw-slot-eq', 'aria-hidden': 'true', dataset: { tip: t('slot.badge.equipped') } }, t('slot.badge.e')) : null,
    item?.urgent && key ? h('span', { class: 'aw-slot-urgent', 'aria-hidden': 'true' }, t('slot.press', { key })) : null,
    item?.durability !== undefined && item.maxDurability
      ? h('span', { class: 'aw-slot-dur', style: { '--wear': pct(item.durability, item.maxDurability) + '%' }, 'aria-hidden': 'true' })
      : null,
  );
  return btn;
}

// ---------------------------------------------------------------------------
// Bars & chips
// ---------------------------------------------------------------------------

export function bar(b: BarView, opts: { compact?: boolean } = {}): HTMLElement {
  const p = pct(b.value, b.max);
  const low = b.low ?? (b.id === 'hp' && p < 30);
  return h(
    'div',
    {
      class: ['aw-bar', opts.compact && 'is-compact', low && 'is-low', low && b.value <= 0 && 'is-empty'],
      dataset: { tip: b.description ? `${b.label} — ${b.description}` : b.label, bar: b.id },
      role: 'meter',
      'aria-label': b.label,
      'aria-valuemin': '0',
      'aria-valuemax': String(b.max),
      'aria-valuenow': String(Math.round(b.value)),
      tabindex: '0',
    },
    // a low vital shows its full name (no abbreviation to decode while in trouble)
    h('span', { class: 'aw-bar-label' }, low ? b.label : (b.abbr ?? b.label)),
    h('span', { class: 'aw-bar-track' }, h('span', { class: 'aw-bar-fill', style: { width: `${p}%`, '--bar': b.color } })),
    h('span', { class: 'aw-bar-value' }, barText(b.value, b.max)),
  );
}

export function statusChip(s: StatusChipView): HTMLElement {
  return h(
    'span',
    {
      class: ['aw-chip', s.harmful ? 'is-harmful' : 'is-helpful'],
      style: { '--chip': s.color },
      dataset: { tip: t('status.tip', { name: s.name, n: s.turnsLeft, description: s.description }) },
      tabindex: '0',
    },
    h('span', { class: 'aw-chip-dot', 'aria-hidden': 'true' }),
    s.name,
    s.turnsLeft > 0 && s.turnsLeft < 1000 ? h('span', { class: 'aw-chip-n' }, String(s.turnsLeft)) : null,
  );
}

export function plainChip(text: string, tone: 'muted' | 'accent' | 'danger' | 'good' = 'muted', tip?: string): HTMLElement {
  return h('span', { class: ['aw-chip', `tone-${tone}`], dataset: { tip }, tabindex: tip ? '0' : undefined }, text);
}

// ---------------------------------------------------------------------------
// Inspect cards
// ---------------------------------------------------------------------------

/**
 * The small grey facts line under an item card. A known item's effect bullets (engine describe)
 * already state its cooldown, charges and durability, so those are not repeated here
 * (issues/M5-tooltip-duplicate-tags.md); what the bullets never say — the turns until it is ready
 * again, the stack size, "equipped" — always shows.
 */
export function itemMeta(item: ItemView | SlotItemView): string[] {
  const slotItem = item as SlotItemView;
  const described = item.knowledge === 'clear' && item.effectLines.length > 0;
  const meta: string[] = [];
  if (item.count > 1) meta.push(`×${item.count}`);
  if (item.charges !== undefined && !described) meta.push(slotItem.maxCharges ? t('item.meta.chargesOf', { n: item.charges, max: slotItem.maxCharges }) : t('item.meta.charges', { n: item.charges }));
  if (slotItem.cooldown && slotItem.cooldown > 0) meta.push(t('item.meta.readyIn', { n: slotItem.cooldown }));
  else if (slotItem.maxCooldown && !described) meta.push(t('item.meta.cooldown', { n: slotItem.maxCooldown }));
  if (slotItem.durability !== undefined && !described) meta.push(slotItem.maxDurability ? t('item.meta.wearOf', { n: slotItem.durability, max: slotItem.maxDurability }) : t('item.meta.wear', { n: slotItem.durability }));
  if (item.equipped) meta.push(t('item.meta.equipped'));
  return meta;
}

export function itemCard(item: ItemView | SlotItemView, ctx: UiContext, extra?: Child): HTMLElement {
  const k = knowledgeLines(item);
  const slotItem = item as SlotItemView;
  const meta = itemMeta(item);
  return h(
    'div',
    { class: ['aw-card', 'aw-item-card', `knowledge-${item.knowledge}`] },
    h(
      'div',
      { class: 'aw-card-head' },
      glyph(item, 'lg'),
      h(
        'div',
        { class: 'aw-card-titles' },
        h('div', { class: 'aw-card-title' }, item.name),
        h('div', { class: 'aw-card-sub' }, [item.kind, slotItem.rarity && slotItem.rarity !== 'common' ? t(`item.rarity.${slotItem.rarity}`) : null].filter(Boolean).join(' · ')),
      ),
      h('span', { class: ['aw-kbadge', `k-${item.knowledge}`] }, knowledgeBadge(item.knowledge)),
    ),
    item.description ? h('p', { class: 'aw-card-desc' }, item.description) : null,
    k.kind === 'exact' && k.lines.length ? h('ul', { class: 'aw-effects' }, k.lines.map((l) => h('li', null, l))) : null,
    k.kind === 'vague' && k.lines.length ? h('p', { class: 'aw-vague' }, k.lines[0]) : null,
    k.kind === 'vague' && !k.lines.length ? h('p', { class: 'aw-vague' }, t('item.vagueFallback')) : null,
    k.kind === 'unknown' ? h('p', { class: 'aw-unknown' }, k.lines[0]) : null,
    meta.length ? h('div', { class: 'aw-card-meta' }, meta.join(' · ')) : null,
    item.notes.length
      ? h('div', { class: 'aw-notes' }, h('div', { class: 'aw-notes-title' }, t('item.notes')), h('ul', null, item.notes.map((n) => h('li', null, n))))
      : null,
    extra ?? null,
  );
}

const THREAT_TONE: Record<ActorTooltipView['threat'], 'muted' | 'accent' | 'danger' | 'good'> = {
  trivial: 'muted',
  even: 'good',
  dangerous: 'accent',
  deadly: 'danger',
};

export function actorCard(a: ActorTooltipView, ctx: UiContext, hint?: string): HTMLElement {
  const hp = ctx.vocab.stats.hp;
  return h(
    'div',
    { class: ['aw-card', 'aw-actor-card', `faction-${a.faction}`] },
    h(
      'div',
      { class: 'aw-card-head' },
      h('span', { class: 'aw-portrait', style: { '--portrait': a.color ?? 'var(--c-secondary)' }, 'aria-hidden': 'true' }),
      h('div', { class: 'aw-card-titles' }, h('div', { class: 'aw-card-title' }, a.name), h('div', { class: 'aw-card-sub' }, factionLabel(a.faction))),
      a.faction === 'hostile' || !a.isNpc ? plainChip(threatLabel(a.threat), THREAT_TONE[a.threat]) : plainChip(a.isNpc ? t('actor.talkChip') : factionLabel(a.faction), 'good'),
    ),
    bar({ id: 'hp', label: hp.name, abbr: hp.abbr, value: a.hp, max: a.maxHp, color: 'var(--c-danger)' }, { compact: true }),
    a.statusChips?.length
      ? h('div', { class: 'aw-chips' }, a.statusChips.map(statusChip))
      : a.statuses.length
        ? h('div', { class: 'aw-chips' }, a.statuses.map((s) => plainChip(s)))
        : null,
    a.description ? h('p', { class: 'aw-card-desc' }, a.description) : null,
    hint ? h('div', { class: 'aw-card-hint' }, hint) : null,
  );
}

/** `room`: in a room Enter is the chat, so the hint names Shift+Enter (MP3) */
export function tileCard(tile: TileTooltipView, room = false): HTMLElement {
  return h(
    'div',
    { class: ['aw-card', 'aw-tile-card'] },
    h('div', { class: 'aw-card-head' }, h('div', { class: 'aw-card-title' }, tile.title), tile.usable ? plainChip(tile.usable === 'usable' ? t('tile.usable') : t('tile.usedUp'), tile.usable === 'usable' ? 'good' : 'muted') : null),
    tile.description ? h('p', { class: 'aw-card-desc' }, tile.description) : null,
    tile.items?.length ? h('ul', { class: 'aw-tile-items' }, tile.items.map((i) => h('li', null, i))) : null,
    tile.usable === 'usable' ? h('div', { class: 'aw-card-hint' }, t(room ? 'tile.usableHintRoom' : 'tile.usableHint')) : null,
  );
}

// ---------------------------------------------------------------------------
// Floating tooltip

/** gap between the anchor point and the card */
const TIP_GAP = 18;

/**
 * Pure placement of a tooltip card of size `size` near `at` inside `box`: by default below-right;
 * with `avoid`, on the side of `at` facing away from it (vertically and horizontally), so a card
 * about a target never covers the player. Always clamped into the box.
 */
export function placeTooltip(
  at: { x: number; y: number },
  size: { w: number; h: number },
  box: { w: number; h: number },
  avoid: { x: number; y: number } | null,
): { px: number; py: number } {
  let right = true;
  let below = true;
  if (avoid) {
    if (Math.abs(avoid.y - at.y) > 4) below = avoid.y < at.y;
    if (Math.abs(avoid.x - at.x) > 4) right = avoid.x < at.x;
  }
  let px = right ? at.x + TIP_GAP : at.x - size.w - TIP_GAP;
  let py = below ? at.y + TIP_GAP : at.y - size.h - TIP_GAP;
  // flip when there is no room on the preferred side
  if (px + size.w > box.w - 8) px = at.x - size.w - TIP_GAP;
  if (px < 8) px = at.x + TIP_GAP;
  if (py + size.h > box.h - 8) py = at.y - size.h - TIP_GAP;
  if (py < 8) py = at.y + TIP_GAP;
  px = Math.max(8, Math.min(box.w - size.w - 8, px));
  py = Math.max(8, Math.min(box.h - size.h - 8, py));
  return { px, py };
}
// ---------------------------------------------------------------------------

/**
 * One floating tooltip element. Elements with `data-tip` get a plain text tip on hover/focus;
 * richer content is registered through `register(el, () => Node)`.
 */
/** how long a tapped tip stays up (touch) */
export const TAP_TIP_MS = 3500;

export class Tooltip {
  readonly el: HTMLElement;
  private rich = new WeakMap<Element, () => Node | null>();
  private owner: Element | null = null;
  private pinned = false;

  private abort = new AbortController();
  /** time of the last touch: touch taps fire mouseover/focus too, which must not open hover cards */
  private touchAt = -Infinity;

  constructor(private root: HTMLElement) {
    this.el = h('div', { class: 'aw-tooltip', role: 'tooltip', 'aria-hidden': 'true' });
    root.appendChild(this.el);
    const signal = this.abort.signal;
    root.addEventListener(
      'pointerdown',
      (e: PointerEvent) => {
        if (e.pointerType !== 'touch') return;
        this.touchAt = performance.now();
        this.hideOwned();
      },
      { signal, capture: true },
    );
    root.addEventListener('mouseover', (e) => !this.recentTouch() && this.onOver(e), { signal });
    root.addEventListener('mouseout', (e) => this.onOut(e), { signal });
    // keyboard focus shows the tip; focus from a tap or click does not
    root.addEventListener('focusin', (e) => !this.recentTouch() && (e.target as Element | null)?.matches?.(':focus-visible') !== false && this.onOver(e), { signal });
    root.addEventListener('focusout', () => this.hideOwned(), { signal });
    // touch has no hover: tapping something that only explains itself (a stat, a money count, a
    // rule pill) shows its tip for a few seconds. Buttons keep their own tap action.
    root.addEventListener(
      'click',
      (e) => {
        if (!this.recentTouch() || this.pinned) return;
        const el = this.find(e.target);
        if (!el || el.closest('button, a, input, select, textarea, [role="button"]')) return;
        const make = this.rich.get(el);
        const content = make ? make() : document.createTextNode((el as HTMLElement).dataset.tip ?? '');
        if (!content) return;
        this.owner = el;
        this.showNear(el, content, !make);
        if (this.tapTimer) clearTimeout(this.tapTimer);
        this.tapTimer = setTimeout(() => {
          this.tapTimer = null;
          if (this.owner === el) this.hideOwned();
        }, TAP_TIP_MS);
      },
      { signal },
    );
  }

  private tapTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Phones: map cards (long-press inspect) dock as a bottom sheet instead of floating next to the
   * tile, where a thumb or the edge of a small screen would hide them.
   */
  setSheet(on: boolean): void {
    this.el.classList.toggle('is-sheet', on);
  }

  private recentTouch(): boolean {
    return performance.now() - this.touchAt < 1200;
  }

  /** stop listening on the root (the UI is being rebuilt) */
  dispose(): void {
    this.abort.abort();
    if (this.tapTimer) clearTimeout(this.tapTimer);
    this.el.remove();
  }

  register(el: Element, content: () => Node | null): void {
    this.rich.set(el, content);
  }

  private find(t: EventTarget | null): Element | null {
    let el = t as Element | null;
    while (el && el !== this.root) {
      if (this.rich.has(el) || (el as HTMLElement).dataset?.tip) return el;
      el = el.parentElement;
    }
    return null;
  }

  private onOver(e: Event): void {
    if (this.pinned) return;
    const el = this.find(e.target);
    if (!el || el === this.owner) return;
    const make = this.rich.get(el);
    const content = make ? make() : document.createTextNode((el as HTMLElement).dataset.tip ?? '');
    if (!content) return;
    this.owner = el;
    this.showNear(el, content, !make);
  }

  private onOut(e: MouseEvent): void {
    if (this.pinned || !this.owner) return;
    const to = e.relatedTarget as Node | null;
    if (to && this.owner.contains(to)) return;
    this.hideOwned();
  }

  private hideOwned(): void {
    if (this.pinned) return;
    this.owner = null;
    this.hide();
  }

  showNear(anchor: Element, content: Node, plain = false): void {
    this.el.classList.remove('is-sheet');
    this.fill(content, plain);
    const r = anchor.getBoundingClientRect();
    const rootR = this.root.getBoundingClientRect();
    const tw = this.el.offsetWidth;
    const th = this.el.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2 - rootR.left;
    let y = r.top - th - 8 - rootR.top;
    if (y < 8) y = r.bottom + 8 - rootR.top;
    x = Math.max(8, Math.min(rootR.width - tw - 8, x));
    y = Math.max(8, Math.min(rootR.height - th - 8, y));
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /**
   * Show at a viewport point (map hover); pinned until hideAt(). With `avoid` (the player's screen
   * position) the card goes on the side of the point away from it, so it never lands on the player.
   */
  showAt(content: Node, x: number, y: number, avoid?: { x: number; y: number } | null): void {
    this.pinned = true;
    this.owner = null;
    this.fill(content, false);
    const rootR = this.root.getBoundingClientRect();
    const tw = this.el.offsetWidth;
    const th = this.el.offsetHeight;
    const { px, py } = placeTooltip({ x: x - rootR.left, y: y - rootR.top }, { w: tw, h: th }, { w: rootR.width, h: rootR.height }, avoid ? { x: avoid.x - rootR.left, y: avoid.y - rootR.top } : null);
    this.el.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
  }

  hideAt(): void {
    this.pinned = false;
    this.hide();
  }

  /** is a map card (showAt: hover / long-press inspect) on screen? */
  get pinnedVisible(): boolean {
    return this.pinned && this.el.classList.contains('is-visible');
  }

  /** hide a map card (showAt) but leave a hover tip on a panel element alone */
  hidePinned(): void {
    if (this.pinned) this.hideAt();
  }

  /** forget the hovered element too (its element may be about to leave the DOM) */
  clear(): void {
    this.pinned = false;
    this.owner = null;
    this.hide();
  }

  private fill(content: Node, plain: boolean): void {
    this.el.textContent = '';
    this.el.classList.toggle('is-plain', plain);
    this.el.appendChild(content);
    this.el.classList.add('is-visible');
    this.el.setAttribute('aria-hidden', 'false');
  }

  hide(): void {
    this.el.classList.remove('is-visible');
    this.el.setAttribute('aria-hidden', 'true');
  }
}
