/** Help overlay (key map) and the Rules & goals panel. */
import type { QuestView, RuleView } from '../viewmodel';
import { dataKey, h, icon, ICONS, setChildren } from '../dom';
import { keyHelp, type InputVerbs } from '../input';
import { Modal } from './modals';
import type { UiContext } from './common';

export class HelpOverlay {
  readonly modal = new Modal('aw-help', 'Controls');
  constructor(private close: () => void) {}

  get el(): HTMLElement {
    return this.modal.el;
  }

  update(open: boolean, verbs: InputVerbs, ctx: UiContext, transitionName?: string): void {
    if (!open) return this.modal.hide();
    if (!this.modal.show([verbs, ctx.vocab.conflict, transitionName])) return;
    const sections = keyHelp(verbs, ctx.vocab, transitionName);
    setChildren(
      this.modal.card,
      h(
        'header',
        { class: 'aw-panel-head' },
        h('h2', null, 'Controls'),
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': 'Close help', 'data-autofocus': true, onclick: () => this.close() }, icon(ICONS.close)),
      ),
      h(
        'div',
        { class: 'aw-help-grid' },
        sections.map((s) =>
          h(
            'section',
            null,
            h('h3', null, s.title),
            h(
              'dl',
              null,
              s.rows.map((r) => [h('dt', null, r.keys.map((k, i) => [i ? h('span', { class: 'aw-or' }, ' / ') : null, h('kbd', null, k)])), h('dd', null, r.what)]),
            ),
          ),
        ),
      ),
    );
    this.modal.focusFirst();
  }
}

export class RulesPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private key = '';

  constructor(private close: () => void) {
    this.body = h('div', { class: 'aw-rules-body' });
    this.el = h(
      'section',
      { class: 'aw-panel aw-rules', 'aria-label': 'Rules and goals', hidden: true },
      h('header', { class: 'aw-panel-head' }, h('h2', null, 'Rules & goals'), h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': 'Close rules', onclick: () => this.close() }, icon(ICONS.close))),
      this.body,
    );
  }

  update(open: boolean, goal: string | undefined, rules: RuleView[], quests: QuestView[]): void {
    this.el.hidden = !open;
    if (!open) return;
    const key = dataKey([goal, rules, quests]);
    if (key === this.key) return;
    this.key = key;
    setChildren(
      this.body,
      goal ? h('section', null, h('h3', null, 'Goal'), h('p', null, goal)) : null,
      h(
        'section',
        null,
        h('h3', null, `Active rules (${rules.length})`),
        rules.length
          ? h(
              'ul',
              { class: 'aw-rule-list' },
              rules.map((r) =>
                h(
                  'li',
                  { class: r.fromGm ? 'is-gm' : undefined },
                  h('div', { class: 'aw-rule-name' }, r.name, r.since ? h('span', { class: 'aw-rule-since' }, r.since) : null),
                  h('div', { class: 'aw-rule-desc' }, r.description),
                ),
              ),
            )
          : h('p', { class: 'aw-muted' }, 'No special rules.'),
      ),
      quests.length
        ? h(
            'section',
            null,
            h('h3', null, 'Threads'),
            h(
              'ul',
              { class: 'aw-quest-list' },
              quests.map((q) => h('li', { class: `q-${q.status}` }, h('div', { class: 'aw-rule-name' }, q.title, h('span', { class: 'aw-rule-since' }, q.status === 'active' ? 'open' : q.status)), h('div', { class: 'aw-rule-desc' }, q.description))),
            ),
          )
        : null,
    );
  }
}

/** compact always-visible rules strip (top-right) */
export function rulesBadge(rules: RuleView[], onClick: () => void): HTMLElement {
  return h(
    'button',
    { type: 'button', class: 'aw-rules-badge', onclick: onClick, 'aria-label': `${rules.length} active rules — open rules (r)` },
    icon(ICONS.scroll),
    rules.map((r) => h('span', { class: ['aw-rule-pill', r.fromGm && 'is-gm'], dataset: { tip: `${r.name} — ${r.description}` } }, r.name)),
  );
}
