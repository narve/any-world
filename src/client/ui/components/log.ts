/**
 * Message log, coloured by kind; GM narration styled distinctly with its speaker. Repeated lines
 * fold into one row with a counter (groupLog). The panel stays small (about five lines) so it never
 * covers the map: it expands only when its toggle is clicked and collapses again when the pointer
 * leaves it. While the player or someone next to them is under it, it fades out (setObscuring).
 */
import type { LogMessage } from '../../../engine/types';
import type { Vocabulary } from '../../../schema/world';
import { h, icon, ICONS } from '../dom';
import { displayLogText, groupLog, logKindClass, type LogGroup } from '../format';

const MAX_RENDERED = 200;

export class MessageLog {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private key = '';
  private expanded = false;
  private toggle: HTMLButtonElement;

  constructor() {
    this.list = h('ol', { class: 'aw-log-list', 'aria-live': 'polite', 'aria-relevant': 'additions', tabindex: '0', 'aria-label': 'Message log' });
    this.toggle = h(
      'button',
      { type: 'button', class: 'aw-icon-btn aw-log-toggle', 'aria-label': 'Expand log', 'aria-expanded': 'false', dataset: { tip: 'Show more of the log' }, onclick: () => this.setExpanded(!this.expanded) },
      icon(ICONS.scroll),
    );
    this.el = h('section', { class: 'aw-panel aw-log', 'aria-label': 'Messages', onmouseleave: () => this.expanded && this.setExpanded(false) }, this.toggle, this.list);
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  setExpanded(on: boolean): void {
    this.expanded = on;
    this.el.classList.toggle('is-expanded', on);
    this.toggle.setAttribute('aria-expanded', String(on));
    this.toggle.setAttribute('aria-label', on ? 'Collapse log' : 'Expand log');
    this.toggle.dataset.tip = on ? 'Show less' : 'Show more of the log';
    this.scrollToEnd();
  }

  /** fade the panel while it covers the player or an adjacent actor */
  setObscuring(on: boolean): void {
    this.el.classList.toggle('is-obscuring', on && !this.expanded);
  }

  update(log: LogMessage[], vocab?: Pick<Vocabulary, 'stats'>): void {
    const groups = groupLog(log).slice(-MAX_RENDERED);
    const last = groups[groups.length - 1];
    const key = `${groups.length}|${log.length}|${last ? `${last.count}:${last.lastTurn}:${last.msg.text}` : ''}|${vocab?.stats.hp.name ?? ''}`;
    if (key === this.key) return;
    this.key = key;
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 24;
    const keep = this.list.scrollTop;
    this.list.textContent = '';
    for (const g of groups) this.list.appendChild(row(g, vocab));
    // follow new lines unless the player scrolled up to read
    if (atBottom) this.scrollToEnd();
    else this.list.scrollTop = keep;
  }

  private scrollToEnd(): void {
    this.list.scrollTop = this.list.scrollHeight;
  }
}

function row(g: LogGroup, vocab?: Pick<Vocabulary, 'stats'>): HTMLElement {
  const m = g.msg;
  const speaker = m.speaker ? h('span', { class: 'aw-log-speaker' }, m.speaker) : null;
  const text = vocab && m.kind !== 'gm' && m.kind !== 'npc' ? displayLogText(m.text, vocab) : m.text;
  return h(
    'li',
    { class: ['aw-log-row', logKindClass(m.kind), g.count > 1 && 'is-folded'], dataset: { turn: g.lastTurn } },
    speaker,
    h('span', { class: 'aw-log-text' }, text),
    g.count > 1 ? h('span', { class: 'aw-log-count', 'aria-label': `${g.count} times`, title: g.firstTurn === g.lastTurn ? `${g.count}× this turn` : `turns ${g.firstTurn}–${g.lastTurn}` }, `×${g.count}`) : null,
  );
}
