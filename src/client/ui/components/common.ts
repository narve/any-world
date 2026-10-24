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
  capitalize,
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
  const where = index < 8 ? `Quick slot ${index + 1}` : `Backpack slot ${index - 7}`;
  if (!item) return `${where}: empty`;
  const bits = [item.name];
  if (item.count > 1) bits.push(`${item.count}`);
  if (item.charges !== undefined) bits.push(`${item.charges} charges`);
  if (item.equipped) bits.push('equipped');
  if (item.cooldown && item.cooldown > 0) bits.push(`ready in ${item.cooldown}`);
  return `${where}: ${bits.join(', ')}`;
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
    item?.equipped ? h('span', { class: 'aw-slot-eq', 'aria-hidden': 'true', title: 'Equipped' }, 'E') : null,
    item?.urgent && key ? h('span', { class: 'aw-slot-urgent', 'aria-hidden': 'true' }, `press ${key}`) : null,
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
      dataset: { tip: `${s.name} (${s.turnsLeft} turns) — ${s.description}` },
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

export function itemCard(item: ItemView | SlotItemView, ctx: UiContext, extra?: Child): HTMLElement {
  const k = knowledgeLines(item);
  const slotItem = item as SlotItemView;
  const meta: string[] = [];
  if (item.count > 1) meta.push(`×${item.count}`);
  if (item.charges !== undefined) meta.push(slotItem.maxCharges ? `${item.charges}/${slotItem.maxCharges} charges` : `${item.charges} charges`);
  if (slotItem.cooldown && slotItem.cooldown > 0) meta.push(`ready in ${slotItem.cooldown} turns`);
  else if (slotItem.maxCooldown) meta.push(`cooldown ${slotItem.maxCooldown}`);
  if (slotItem.durability !== undefined) meta.push(`wear ${slotItem.durability}${slotItem.maxDurability ? '/' + slotItem.maxDurability : ''}`);
  if (item.equipped) meta.push('equipped');
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
        h('div', { class: 'aw-card-sub' }, [item.kind, slotItem.rarity && slotItem.rarity !== 'common' ? capitalize(slotItem.rarity) : null].filter(Boolean).join(' · ')),
      ),
      h('span', { class: ['aw-kbadge', `k-${item.knowledge}`] }, knowledgeBadge(item.knowledge)),
    ),
    item.description ? h('p', { class: 'aw-card-desc' }, item.description) : null,
    k.kind === 'exact' && k.lines.length ? h('ul', { class: 'aw-effects' }, k.lines.map((l) => h('li', null, l))) : null,
    k.kind === 'vague' && k.lines.length ? h('p', { class: 'aw-vague' }, k.lines[0]) : null,
    k.kind === 'vague' && !k.lines.length ? h('p', { class: 'aw-vague' }, 'You have a feeling about this, nothing more.') : null,
    k.kind === 'unknown' ? h('p', { class: 'aw-unknown' }, k.lines[0]) : null,
    meta.length ? h('div', { class: 'aw-card-meta' }, meta.join(' · ')) : null,
    item.notes.length
      ? h('div', { class: 'aw-notes' }, h('div', { class: 'aw-notes-title' }, 'Your notes'), h('ul', null, item.notes.map((n) => h('li', null, n))))
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
      a.faction === 'hostile' || !a.isNpc ? plainChip(threatLabel(a.threat), THREAT_TONE[a.threat]) : plainChip(a.isNpc ? 'Talk' : factionLabel(a.faction), 'good'),
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

export function tileCard(t: TileTooltipView): HTMLElement {
  return h(
    'div',
    { class: ['aw-card', 'aw-tile-card'] },
    h('div', { class: 'aw-card-head' }, h('div', { class: 'aw-card-title' }, t.title), t.usable ? plainChip(t.usable === 'usable' ? 'Usable' : 'Used up', t.usable === 'usable' ? 'good' : 'muted') : null),
    t.description ? h('p', { class: 'aw-card-desc' }, t.description) : null,
    t.items?.length ? h('ul', { class: 'aw-tile-items' }, t.items.map((i) => h('li', null, i))) : null,
    t.usable === 'usable' ? h('div', { class: 'aw-card-hint' }, 'Walk into it, click it, or press Enter next to it') : null,
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
export class Tooltip {
  readonly el: HTMLElement;
  private rich = new WeakMap<Element, () => Node | null>();
  private owner: Element | null = null;
  private pinned = false;

  constructor(private root: HTMLElement) {
    this.el = h('div', { class: 'aw-tooltip', role: 'tooltip', 'aria-hidden': 'true' });
    root.appendChild(this.el);
    root.addEventListener('mouseover', (e) => this.onOver(e));
    root.addEventListener('mouseout', (e) => this.onOut(e));
    root.addEventListener('focusin', (e) => this.onOver(e));
    root.addEventListener('focusout', () => this.hideOwned());
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
