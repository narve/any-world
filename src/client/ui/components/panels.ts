/** Help overlay (key map + hotbar legend) and the Rules & goals panel. */
import type { QuestView, RuleView } from '../viewmodel';
import { dataKey, h, icon, ICONS, setChildren } from '../dom';
import { keyHelp, slotLegend, type InputVerbs } from '../input';
import { Modal } from './modals';
import type { UiContext } from './common';
import { t } from '../../i18n/index';

export class HelpOverlay {
  readonly modal = new Modal('aw-help', t('help.title'));
  constructor(
    private close: () => void,
    /** reopen this world's onboarding card (absent outside a run) */
    private howToPlay?: () => void,
  ) {}

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
        h('h2', null, t('help.title')),
        this.howToPlay
          ? h(
              'button',
              {
                type: 'button',
                class: 'aw-btn aw-btn-small aw-help-howto',
                onclick: () => {
                  this.close();
                  this.howToPlay?.();
                },
              },
              t('help.howToPlay'),
            )
          : null,
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': t('help.closeAria'), 'data-autofocus': true, onclick: () => this.close() }, icon(ICONS.close)),
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
        h(
          'section',
          { class: 'aw-help-legend' },
          h('h3', null, t('legend.title')),
          h(
            'dl',
            null,
            slotLegend().map((l) => [h('dt', null, h('span', { class: ['aw-legend-mark', l.mark === 'E' && 'is-eq'] }, l.mark)), h('dd', null, l.what)]),
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
      { class: 'aw-panel aw-rules', 'aria-label': t('rules.title'), hidden: true },
      h('header', { class: 'aw-panel-head' }, h('h2', null, t('rules.title')), h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': t('rules.closeAria'), onclick: () => this.close() }, icon(ICONS.close))),
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
      goal ? h('section', null, h('h3', null, t('rules.goal')), h('p', null, goal)) : null,
      h(
        'section',
        null,
        h('h3', null, t('rules.active', { n: rules.length })),
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
                    h('span', { class: ['aw-rule-src', r.fromGm ? 'src-gm' : 'src-world'], title: r.fromGm ? t('rules.srcGmTip') : t('rules.srcWorldTip') }, r.fromGm ? t('rules.srcGm') : t('rules.srcWorld')),
                  ),
                  r.since ? h('div', { class: 'aw-rule-since' }, r.fromGm ? t('rules.since', { since: r.since }) : r.since) : null,
                  h('div', { class: 'aw-rule-desc' }, r.description),
                  r.reason ? h('div', { class: 'aw-rule-reason' }, t('common.quoted', { text: r.reason })) : null,
                ),
              ),
            )
          : h('p', { class: 'aw-muted' }, t('rules.none')),
      ),
      quests.length
        ? h(
            'section',
            null,
            h('h3', null, t('rules.threads')),
            h(
              'ul',
              { class: 'aw-quest-list' },
              quests.map((q) =>
                h(
                  'li',
                  { class: `q-${q.status}` },
                  h('div', { class: 'aw-rule-name' }, q.title, h('span', { class: 'aw-rule-since' }, t(`quest.status.${q.status}` as const))),
                  h('div', { class: 'aw-rule-desc' }, q.description),
                ),
              ),
            ),
          )
        : null,
    );
  }
}

/** the hover text of a rule pill */
export function ruleTip(r: RuleView): string {
  const bits = [t('rules.tipHead', { name: r.name, description: r.description })];
  if (r.reason) bits.push(t('common.quoted', { text: r.reason }));
  bits.push(r.fromGm ? t('rules.tipGm', { since: r.since ?? t('rules.duringPlay') }) : t('rules.tipWorld'));
  return bits.join('\n');
}

/** compact always-visible rules strip (top-right); new rules pulse until the panel is opened */
export function rulesBadge(rules: RuleView[], onClick: () => void): HTMLElement {
  const fresh = rules.some((r) => r.isNew);
  return h(
    'button',
    {
      type: 'button',
      class: ['aw-rules-badge', fresh && 'has-new'],
      onclick: onClick,
      'aria-label': fresh ? t('rules.badgeAriaNew', { n: rules.length }) : t('rules.badgeAria', { n: rules.length }),
      dataset: { label: t('rules.badge') },
    },
    h('span', { class: 'aw-rules-badge-head' }, icon(ICONS.scroll), h('span', null, t('rules.badge')), fresh ? h('span', { class: 'aw-rules-new' }, t('rules.new')) : null),
    rules.map((r) => h('span', { class: ['aw-rule-pill', r.fromGm && 'is-gm', r.isNew && 'is-new'], dataset: { tip: ruleTip(r), rule: r.id } }, r.name)),
  );
}
