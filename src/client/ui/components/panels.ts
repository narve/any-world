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
    // what changed during play comes first: new rules, then GM rules, then the world's own
    rules = [...rules].sort((a, b) => Number(!!b.isNew) - Number(!!a.isNew) || Number(!!b.fromGm) - Number(!!a.fromGm));
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
                  { class: [r.fromGm && 'is-gm', r.isNew && 'is-new'], dataset: { rule: r.id } },
                  h(
                    'div',
                    { class: 'aw-rule-name' },
                    h('span', null, r.name),
                    h('span', { class: ['aw-rule-src', r.fromGm ? 'src-gm' : 'src-world'], title: r.fromGm ? 'Introduced by the game master during play' : 'Part of this world from the start' }, r.fromGm ? 'GM' : 'World'),
                  ),
                  r.since ? h('div', { class: 'aw-rule-since' }, r.fromGm ? `since ${r.since}` : r.since) : null,
                  h('div', { class: 'aw-rule-desc' }, r.description),
                  r.reason ? h('div', { class: 'aw-rule-reason' }, `“${r.reason}”`) : null,
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

/** the hover text of a rule pill */
export function ruleTip(r: RuleView): string {
  const bits = [`${r.name} — ${r.description}`];
  if (r.reason) bits.push(`“${r.reason}”`);
  bits.push(r.fromGm ? `Added by the GM, ${r.since ?? 'during play'}` : 'In force from the start');
  return bits.join('\n');
}

/** compact always-visible rules strip (top-right); new rules pulse until the panel is opened */
export function rulesBadge(rules: RuleView[], onClick: () => void): HTMLElement {
  const fresh = rules.some((r) => r.isNew);
  return h(
    'button',
    { type: 'button', class: ['aw-rules-badge', fresh && 'has-new'], onclick: onClick, 'aria-label': `${rules.length} active rules${fresh ? ', new rule added' : ''} — open rules (r)` },
    h('span', { class: 'aw-rules-badge-head' }, icon(ICONS.scroll), h('span', null, 'Rules'), fresh ? h('span', { class: 'aw-rules-new' }, 'new') : null),
    rules.map((r) => h('span', { class: ['aw-rule-pill', r.fromGm && 'is-gm', r.isNew && 'is-new'], dataset: { tip: ruleTip(r), rule: r.id } }, r.name)),
  );
}
