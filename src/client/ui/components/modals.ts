/**
 * Modal overlays: dialogue, GM choice, level-up perk cards, trade. Each modal traps focus while
 * open and restores it on close.
 */
import type { ChoiceView, DialogueView, LevelUpView, TradeIntent, TradeView } from '../viewmodel';
import { dataKey, focusables, h, icon, ICONS, setChildren, trapFocus } from '../dom';
import { glyph, itemCard, type Tooltip, type UiContext } from './common';
import { tradeColumns } from '../format';

export class Modal {
  readonly el: HTMLElement;
  readonly card: HTMLElement;
  private release: (() => void) | null = null;
  private key = '';

  constructor(cls: string, label: string, opts: { backdrop?: boolean } = {}) {
    this.card = h('div', { class: ['aw-modal-card', cls] });
    this.el = h('div', { class: ['aw-modal', opts.backdrop === false && 'no-backdrop'], role: 'dialog', 'aria-modal': 'true', 'aria-label': label, hidden: true }, this.card);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** returns true when the content must be re-rendered */
  show(data: unknown): boolean {
    const key = dataKey(data);
    const wasOpen = this.isOpen;
    this.el.hidden = false;
    if (!wasOpen) this.release = trapFocus(this.el, { initial: false });
    if (key === this.key && wasOpen) return false;
    this.key = key;
    return true;
  }

  hide(): void {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.key = '';
    const r = this.release;
    this.release = null;
    r?.();
  }

  focusFirst(): void {
    queueMicrotask(() => {
      const t = this.card.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(this.card)[0];
      t?.focus({ preventScroll: true });
    });
  }

  /** move focus among the card's focusables (arrow keys) */
  moveFocus(delta: number): void {
    const f = focusables(this.card);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    const n = i < 0 ? 0 : (i + delta + f.length) % f.length;
    f[n].focus();
  }
}

// ---------------------------------------------------------------------------

export interface DialogueHandlers {
  reply(index: number, text: string): void;
  leave(): void;
  persuade(npcId: string): void;
  trade(npcId: string): void;
}

export class DialoguePanel {
  readonly modal = new Modal('aw-dialogue', 'Conversation', { backdrop: false });
  private view: DialogueView | null = null;

  constructor(private handlers: DialogueHandlers) {}

  get el(): HTMLElement {
    return this.modal.el;
  }

  update(d: DialogueView | null): void {
    this.view = d;
    if (!d) return this.modal.hide();
    if (!this.modal.show(d)) return;
    const history = (d.history ?? []).slice(-4);
    const opts = d.options.map((o, i) =>
      h(
        'button',
        { type: 'button', class: 'aw-option', 'data-autofocus': i === 0 ? true : undefined, disabled: d.pending, onclick: () => this.handlers.reply(i, o) },
        h('kbd', null, String(i + 1)),
        h('span', null, o),
      ),
    );
    setChildren(
      this.modal.card,
      h(
        'header',
        { class: 'aw-dlg-head' },
        h('span', { class: 'aw-portrait aw-portrait-lg', style: { '--portrait': d.portraitColor }, 'aria-hidden': 'true' }),
        h('div', { class: 'aw-card-titles' }, h('h2', { class: 'aw-card-title' }, d.npcName), d.npcTitle ? h('div', { class: 'aw-card-sub' }, d.npcTitle) : null),
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': 'Leave conversation', onclick: () => this.handlers.leave() }, icon(ICONS.close)),
      ),
      history.length
        ? h(
            'ol',
            { class: 'aw-dlg-history' },
            history.map((x) => h('li', { class: `from-${x.who}` }, x.text)),
          )
        : null,
      h('blockquote', { class: ['aw-dlg-reply', d.pending && 'is-pending'], 'aria-live': 'polite' }, d.pending ? h('span', { class: 'aw-dots', 'aria-label': `${d.npcName} is thinking` }, h('i'), h('i'), h('i')) : d.reply),
      h('div', { class: 'aw-options' }, opts),
      h(
        'footer',
        { class: 'aw-dlg-foot' },
        d.canPersuade ? h('button', { type: 'button', class: 'aw-btn aw-btn-small', disabled: d.pending, onclick: () => this.handlers.persuade(d.npcId) }, 'Persuade', h('kbd', null, 'p')) : null,
        d.canTrade ? h('button', { type: 'button', class: 'aw-btn aw-btn-small', disabled: d.pending, onclick: () => this.handlers.trade(d.npcId) }, 'Trade', h('kbd', null, 't')) : null,
        h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-btn-ghost', 'data-autofocus': opts.length === 0 ? true : undefined, onclick: () => this.handlers.leave() }, 'Leave', h('kbd', null, 'Esc')),
      ),
    );
    this.modal.focusFirst();
  }

  option(i: number): void {
    const d = this.view;
    if (!d || d.pending || i < 0 || i >= d.options.length) return;
    this.handlers.reply(i, d.options[i]);
  }

  /** keyboard 'p': same as the Persuade button (only while it is shown and enabled) */
  persuade(): boolean {
    const d = this.view;
    if (!d || d.pending || !d.canPersuade) return false;
    this.handlers.persuade(d.npcId);
    return true;
  }

  /** keyboard 't': same as the Trade button */
  trade(): boolean {
    const d = this.view;
    if (!d || d.pending || !d.canTrade) return false;
    this.handlers.trade(d.npcId);
    return true;
  }
}

// ---------------------------------------------------------------------------

export class ChoiceModal {
  readonly modal = new Modal('aw-choice', 'A choice');
  private view: ChoiceView | null = null;

  constructor(private pick: (index: number) => void) {}

  get el(): HTMLElement {
    return this.modal.el;
  }

  update(c: ChoiceView | null): void {
    this.view = c;
    if (!c) return this.modal.hide();
    if (!this.modal.show(c)) return;
    setChildren(
      this.modal.card,
      c.speaker ? h('div', { class: 'aw-narr-kind' }, c.speaker) : null,
      h('p', { class: 'aw-choice-prompt' }, c.prompt),
      h(
        'div',
        { class: 'aw-options' },
        c.options.map((o, i) =>
          h('button', { type: 'button', class: 'aw-option', 'data-autofocus': i === 0 ? true : undefined, onclick: () => this.pick(i) }, h('kbd', null, String(i + 1)), h('span', null, o.label)),
        ),
      ),
    );
    this.modal.focusFirst();
  }

  option(i: number): void {
    if (this.view && i >= 0 && i < this.view.options.length) this.pick(i);
  }
}

// ---------------------------------------------------------------------------

export class LevelUpModal {
  readonly modal = new Modal('aw-levelup', 'Level up');
  private view: LevelUpView | null = null;

  constructor(private choose: (perkId: string) => void, private ctx: () => UiContext) {}

  get el(): HTMLElement {
    return this.modal.el;
  }

  update(l: LevelUpView | null): void {
    this.view = l;
    if (!l) return this.modal.hide();
    if (!this.modal.show([l, this.ctx().vocab.levelUp])) return;
    const vocab = this.ctx().vocab;
    setChildren(
      this.modal.card,
      h('div', { class: 'aw-narr-kind' }, `Level ${l.level}`),
      h('h2', { class: 'aw-levelup-title' }, vocab.levelUp),
      h('p', { class: 'aw-muted' }, 'Choose one.'),
      h(
        'div',
        { class: 'aw-perks' },
        l.perks.map((p, i) =>
          h(
            'button',
            { type: 'button', class: 'aw-perk', 'data-autofocus': i === 0 ? true : undefined, onclick: () => this.choose(p.id) },
            h('kbd', null, String(i + 1)),
            h('span', { class: 'aw-perk-name' }, p.name),
            h('span', { class: 'aw-perk-desc' }, p.description),
            p.lines?.length ? h('span', { class: 'aw-perk-lines' }, p.lines.map((x) => h('span', null, x))) : null,
          ),
        ),
      ),
    );
    this.modal.focusFirst();
  }

  option(i: number): void {
    const p = this.view?.perks[i];
    if (p) this.choose(p.id);
  }
}

// ---------------------------------------------------------------------------

export class TradePanel {
  readonly modal = new Modal('aw-trade', 'Trade');
  private view: TradeView | null = null;

  constructor(private emit: (t: TradeIntent) => void, private tooltip: Tooltip, private ctx: () => UiContext) {}

  get el(): HTMLElement {
    return this.modal.el;
  }

  update(t: TradeView | null): void {
    this.view = t;
    if (!t) return this.modal.hide();
    if (!this.modal.show([t, this.ctx().vocab.currency])) return;
    const cur = this.ctx().vocab.currency;
    const cols = tradeColumns(t);
    const row = (name: Node, price: number, label: string, onClick: () => void, disabled: boolean, keyHint?: string, tipNode?: () => Node) => {
      const b = h(
        'button',
        { type: 'button', class: 'aw-trade-row', disabled, onclick: onClick },
        keyHint ? h('kbd', null, keyHint) : h('span', { class: 'aw-kbd-pad' }),
        name,
        h('span', { class: 'aw-trade-price' }, `${price} ${cur}`),
        h('span', { class: 'aw-trade-act' }, label),
      );
      if (tipNode) this.tooltip.register(b, tipNode);
      return b;
    };
    setChildren(
      this.modal.card,
      h(
        'header',
        { class: 'aw-dlg-head' },
        h('span', { class: 'aw-portrait aw-portrait-lg', style: { '--portrait': t.traderColor }, 'aria-hidden': 'true' }),
        h('div', { class: 'aw-card-titles' }, h('h2', { class: 'aw-card-title' }, t.traderName), h('div', { class: 'aw-card-sub' }, `You have ${t.currency} ${cur}`)),
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': 'Close trade', onclick: () => this.emit({ type: 'close' }) }, icon(ICONS.close)),
      ),
      t.greeting ? h('blockquote', { class: 'aw-dlg-reply' }, t.greeting) : null,
      h(
        'div',
        { class: cols.sell ? 'aw-trade-cols' : 'aw-trade-cols aw-trade-cols-single' },
        h(
          'section',
          null,
          h('h3', null, 'Buy'),
          t.offers.length
            ? t.offers.map((o, i) =>
                row(
                  h('span', { class: 'aw-trade-name' }, glyph(o.item, 'sm'), o.item.name),
                  o.price,
                  'Buy',
                  () => this.emit({ type: 'buy', offerIndex: i }),
                  o.price > t.currency,
                  i < 9 ? String(i + 1) : undefined,
                  () => itemCard(o.item, this.ctx()),
                ),
              )
            : h('p', { class: 'aw-muted' }, 'Nothing for sale.'),
        ),
        cols.sell
          ? h(
              'section',
              null,
              h('h3', null, 'Sell'),
              t.sellable.map((s) =>
                row(h('span', { class: 'aw-trade-name' }, glyph(s.item, 'sm'), s.item.name), s.price, 'Sell', () => this.emit({ type: 'sell', slot: s.slot }), false, undefined, () => itemCard(s.item, this.ctx())),
              ),
            )
          : null,
      ),
      h('footer', { class: 'aw-dlg-foot' }, h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-btn-ghost', 'data-autofocus': true, onclick: () => this.emit({ type: 'close' }) }, 'Done', h('kbd', null, 'Esc'))),
    );
    this.modal.focusFirst();
  }

  option(i: number): void {
    const t = this.view;
    if (!t) return;
    const o = t.offers[i];
    if (o && o.price <= t.currency) this.emit({ type: 'buy', offerIndex: i });
  }
}
