/**
 * "Clearer controls & goals", touch-first (DESIGN §6/§6b):
 *  - GoalTracker: always-visible goal + current step; tap to expand into the win/lose conditions
 *  - ContextBar: buttons that appear when relevant (talk, pick up, exit…) and double as key hints
 *  - OnboardingCard: how to win, how conflict works here and the main controls for this input mode
 *  - SlotTip: a small tip anchored to a slot whose item does nothing when activated (equipped,
 *    passive) — instead of opening the backpack by surprise
 * Every tap target is at least 44 px; nothing is hover-only.
 */
import type { ConditionLineView, ContextActionView, GoalView, OnboardingView, QuestView } from '../viewmodel';
import type { Vocabulary } from '../../../schema/world';
import { dataKey, h, icon, ICONS, setChildren } from '../dom';
import { onboardingControls, type InputMode } from '../onboarding';
import type { SlotExplanation } from '../slots';
import { t } from '../../i18n/index';

/** a key as shown on a key cap ("T", "Enter", ">") */
export function keyCap(key: string): string {
  if (key === 'Enter') return t('key.enter');
  if (key === '.') return '.';
  return key.length === 1 ? key.toUpperCase() : key;
}

function conditionList(lines: ConditionLineView[], cls: string): HTMLElement {
  return h(
    'ul',
    { class: ['aw-cond-list', cls] },
    lines.map((l) =>
      h(
        'li',
        {
          class: ['aw-cond', l.group && 'is-group', l.done === true && 'is-done', l.done === false && 'is-open'],
          style: { '--depth': l.depth },
        },
        // a nested group ("All of these:" as one alternative of "One of these:") is an entry of its
        // parent list like any other line, so it gets its bullet (issues/M5-nested-goal-group-bullet.md)
        l.group && l.depth === 0 ? null : h('span', { class: 'aw-cond-mark', 'aria-hidden': 'true' }, l.done === true ? '✓' : '•'),
        h('span', { class: 'aw-cond-text' }, l.text, l.done === true ? h('span', { class: 'aw-sr' }, ` (${t('goal.doneSr')})`) : null),
        l.now ? h('span', { class: 'aw-cond-now' }, l.now) : null,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// goal tracker
// ---------------------------------------------------------------------------

export interface GoalTrackerHandlers {
  howToPlay(): void;
  /** expanded/collapsed (the UI pauses travel while it is open, like a panel) */
  toggled?(open: boolean): void;
}

export class GoalTracker {
  readonly el: HTMLElement;
  private head: HTMLButtonElement;
  private body: HTMLElement;
  private expanded = false;
  private key = '';
  private view: { goal: GoalView; quests: QuestView[] } | null = null;

  constructor(private handlers: GoalTrackerHandlers) {
    this.head = h('button', { type: 'button', class: 'aw-goal-head', 'aria-expanded': 'false', onclick: () => this.setExpanded(!this.expanded) });
    this.body = h('div', { class: 'aw-goal-body', hidden: true, id: 'aw-goal-body' });
    this.head.setAttribute('aria-controls', 'aw-goal-body');
    this.el = h('section', { class: 'aw-goal', 'aria-label': t('goal.label'), hidden: true }, this.head, this.body);
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  setExpanded(on: boolean): void {
    if (on === this.expanded) return;
    this.expanded = on;
    this.el.classList.toggle('is-expanded', on);
    this.head.setAttribute('aria-expanded', String(on));
    this.body.hidden = !on;
    this.key = '';
    if (this.view) this.update(this.view.goal, this.view.quests, false);
    this.handlers.toggled?.(on);
  }

  update(goal: GoalView | undefined, quests: QuestView[], hidden: boolean): void {
    this.el.hidden = hidden || !goal;
    if (!goal) return;
    this.view = { goal, quests };
    const key = dataKey([goal, quests, this.expanded]);
    if (key === this.key) return;
    this.key = key;
    const s = goal.step;
    setChildren(
      this.head,
      h('span', { class: 'aw-goal-summary' }, h('span', { class: 'aw-goal-kicker' }, t('goal.kicker')), goal.summary),
      h(
        'span',
        { class: ['aw-goal-step', `step-${s.kind}`] },
        h('span', { class: 'aw-goal-step-label' }, t(`goal.stepLabel.${s.kind}` as const)),
        h('span', { class: 'aw-goal-step-text' }, s.text),
        s.detail ? h('span', { class: 'aw-goal-step-detail' }, s.detail) : null,
      ),
      h('span', { class: 'aw-goal-more', 'aria-hidden': 'true' }, this.expanded ? '▴' : '▾'),
      h('span', { class: 'aw-sr' }, this.expanded ? t('goal.collapseSr') : t('goal.expandSr')),
    );
    if (!this.expanded) {
      setChildren(this.body);
      return;
    }
    const open = quests.filter((q) => q.status === 'active');
    setChildren(
      this.body,
      h('div', { class: 'aw-goal-progress' }, goal.progress),
      h('section', null, h('h3', null, t('goal.win')), conditionList(goal.win, 'is-win')),
      goal.exitNeeds ? h('section', null, h('h3', null, t('goal.exitNeeds', { way: goal.exitNeeds.way })), conditionList(goal.exitNeeds.lines, 'is-exit')) : null,
      open.length
        ? h(
            'section',
            null,
            h('h3', null, t('rules.threads')),
            h('ul', { class: 'aw-cond-list' }, open.map((q) => h('li', { class: 'aw-cond' }, h('span', { class: 'aw-cond-mark', 'aria-hidden': 'true' }, '•'), h('span', { class: 'aw-cond-text' }, h('strong', null, q.title), q.description ? ` — ${q.description}` : '')))),
          )
        : null,
      h('section', null, h('h3', null, t('goal.lose')), conditionList(goal.lose, 'is-lose')),
      h(
        'div',
        { class: 'aw-goal-actions' },
        h('button', { type: 'button', class: 'aw-btn aw-btn-small', onclick: () => this.handlers.howToPlay() }, t('goal.howToPlay')),
        h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-btn-ghost', onclick: () => this.setExpanded(false) }, t('common.close')),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// context action bar
// ---------------------------------------------------------------------------

export class ContextBar {
  readonly el: HTMLElement;
  private key = '';

  constructor(private run: (a: ContextActionView, el: HTMLElement) => void) {
    this.el = h('div', { class: 'aw-ctx', role: 'toolbar', 'aria-label': t('ctx.label'), hidden: true });
  }

  update(actions: ContextActionView[] | undefined, hidden: boolean): void {
    const list = actions ?? [];
    this.el.hidden = hidden || !list.length;
    if (this.el.hidden) return;
    const key = dataKey(list);
    if (key === this.key) return;
    this.key = key;
    setChildren(
      this.el,
      list.map((a) => {
        const b: HTMLButtonElement = h(
          'button',
          {
            type: 'button',
            class: ['aw-ctx-btn', `ctx-${a.id}`, a.primary && 'is-primary', a.secondary && 'is-secondary', a.blocked && 'is-blocked', a.urgent && 'is-urgent'],
            dataset: { action: a.id },
            'aria-label': a.blocked ? `${a.label} — ${a.blocked}` : a.label,
            onclick: () => this.run(a, b),
          },
          a.blocked ? h('span', { class: 'aw-ctx-lock' }, icon(ICONS.lock)) : null,
          h('span', { class: 'aw-ctx-label' }, a.label),
          h('kbd', { class: 'aw-key', 'aria-hidden': 'true' }, keyCap(a.key)),
        );
        return b;
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// onboarding card
// ---------------------------------------------------------------------------

export class OnboardingCard {
  readonly el: HTMLElement;
  private forever: HTMLInputElement;
  private key = '';
  private view: OnboardingView | null = null;

  constructor(private dismiss: (forever: boolean) => void) {
    this.forever = h('input', { type: 'checkbox', id: 'aw-onboard-forever', props: { checked: true } });
    this.el = h('aside', { class: 'aw-panel aw-onboard', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'aw-onboard-title', hidden: true });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  /** close it, honouring the "don't show again" box */
  close(): void {
    if (!this.view) return;
    this.dismiss(this.forever.checked);
  }

  update(v: OnboardingView | null | undefined, mode: InputMode, vocab: Vocabulary, transitionName: string | undefined, hidden: boolean): void {
    this.view = v ?? null;
    this.el.hidden = hidden || !v;
    if (!v || this.el.hidden) return;
    const key = dataKey([v, mode, vocab.conflict, transitionName]);
    if (key === this.key) return;
    this.key = key;
    const controls = onboardingControls(mode, vocab, transitionName);
    // the whole win condition when it is short; a long one is summed up by the goal text alone
    const winLines = v.win.length <= 8 ? v.win : [];
    setChildren(
      this.el,
      h(
        'header',
        { class: 'aw-onboard-head' },
        h('div', null, h('div', { class: 'aw-onboard-kicker' }, t('onboard.kicker')), h('h2', { id: 'aw-onboard-title' }, v.worldTitle)),
        h('button', { type: 'button', class: 'aw-icon-btn aw-onboard-x', 'aria-label': t('common.close'), onclick: () => this.close() }, icon(ICONS.close)),
      ),
      h(
        'div',
        { class: 'aw-onboard-body' },
        h('section', null, h('h3', null, t('onboard.win')), h('p', null, v.goal), winLines.length > 1 ? conditionList(winLines, 'is-win') : null),
        h(
          'section',
          null,
          h('h3', null, t('onboard.conflict')),
          h(
            'ul',
            { class: 'aw-onboard-list' },
            v.conflict.map((c, i) => {
              // the verb's key on a key cap, for keyboard and mouse players (touch uses the buttons)
              const k = mode !== 'touch' ? v.conflictKeys?.[i] : null;
              return h('li', null, k ? h('kbd', { class: 'aw-key aw-onboard-verbkey' }, keyCap(k)) : null, k ? ' ' : null, c);
            }),
          ),
        ),
        h(
          'section',
          null,
          h('h3', null, t(`onboard.controls.${mode}` as const)),
          h(
            'dl',
            { class: 'aw-onboard-controls' },
            controls.map((c) => [h('dt', null, c.key ? h('kbd', null, c.how) : c.how), h('dd', null, c.what)]),
          ),
        ),
        h('section', null, h('h3', null, t('onboard.lose')), h('ul', { class: 'aw-onboard-list' }, v.lose.map((c) => h('li', null, c)))),
      ),
      h(
        'footer',
        { class: 'aw-onboard-foot' },
        h('label', { class: 'aw-check', for: 'aw-onboard-forever' }, this.forever, t('onboard.dontShow')),
        h('button', { type: 'button', class: 'aw-btn aw-btn-primary aw-onboard-ok', onclick: () => this.close() }, t('onboard.ok')),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// slot tip
// ---------------------------------------------------------------------------

/** how long the anchored slot tip stays (ms) */
export const SLOT_TIP_MS = 6000;

export class SlotTip {
  readonly el: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private slot: number | null = null;

  constructor(private root: HTMLElement) {
    this.el = h('div', { class: 'aw-slot-tip', role: 'status', 'aria-live': 'polite', hidden: true });
  }

  get shownFor(): number | null {
    return this.slot;
  }

  show(anchor: HTMLElement, slot: number, exp: SlotExplanation, onDetails: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.slot = slot;
    setChildren(
      this.el,
      h('div', { class: 'aw-slot-tip-title' }, exp.title),
      exp.lines.map((l, i) => h('p', { class: i === 0 ? 'aw-slot-tip-main' : 'aw-slot-tip-line' }, l)),
      h(
        'div',
        { class: 'aw-slot-tip-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'aw-btn aw-btn-small aw-btn-ghost',
            onclick: () => {
              this.hide();
              onDetails();
            },
          },
          t('slot.tip.details'),
        ),
        h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': t('common.close'), onclick: () => this.hide() }, icon(ICONS.close)),
      ),
    );
    this.el.hidden = false;
    // anchor above the slot, centred, kept inside the UI root
    const r = anchor.getBoundingClientRect();
    const rootR = this.root.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const hgt = this.el.offsetHeight;
    let x = r.left + r.width / 2 - w / 2 - rootR.left;
    x = Math.max(8, Math.min(rootR.width - w - 8, x));
    let y = r.top - hgt - 10 - rootR.top;
    if (y < 8) y = r.bottom + 10 - rootR.top;
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    const arrow = r.left + r.width / 2 - rootR.left - x;
    this.el.style.setProperty('--arrow-x', `${Math.round(Math.max(14, Math.min(w - 14, arrow)))}px`);
    this.timer = setTimeout(() => this.hide(), SLOT_TIP_MS);
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.slot = null;
    this.el.hidden = true;
  }
}
