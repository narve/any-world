/** Scrollable message log, coloured by kind; GM narration styled distinctly with its speaker. */
import type { LogMessage } from '../../../engine/types';
import { h, icon, ICONS } from '../dom';
import { logKindClass } from '../format';

const MAX_RENDERED = 200;

export class MessageLog {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private rendered: LogMessage[] = [];
  private expanded = false;
  private toggle: HTMLButtonElement;

  constructor() {
    this.list = h('ol', { class: 'aw-log-list', 'aria-live': 'polite', 'aria-relevant': 'additions', tabindex: '0', 'aria-label': 'Message log' });
    this.toggle = h(
      'button',
      { type: 'button', class: 'aw-icon-btn aw-log-toggle', 'aria-label': 'Expand log', 'aria-expanded': 'false', onclick: () => this.setExpanded(!this.expanded) },
      icon(ICONS.scroll),
    );
    this.el = h('section', { class: 'aw-panel aw-log', 'aria-label': 'Messages' }, this.toggle, this.list);
  }

  setExpanded(on: boolean): void {
    this.expanded = on;
    this.el.classList.toggle('is-expanded', on);
    this.toggle.setAttribute('aria-expanded', String(on));
    this.toggle.setAttribute('aria-label', on ? 'Collapse log' : 'Expand log');
    this.scrollToEnd();
  }

  update(log: LogMessage[]): void {
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 24;
    const prefixOk =
      this.rendered.length <= log.length &&
      this.rendered.length > 0 &&
      log[this.rendered.length - 1] !== undefined &&
      sameMsg(this.rendered[this.rendered.length - 1], log[this.rendered.length - 1]) &&
      sameMsg(this.rendered[0], log[0]);
    if (prefixOk) {
      for (let i = this.rendered.length; i < log.length; i++) this.list.appendChild(row(log[i]));
      while (this.list.childElementCount > MAX_RENDERED) this.list.firstElementChild?.remove();
    } else {
      this.list.textContent = '';
      for (const m of log.slice(-MAX_RENDERED)) this.list.appendChild(row(m));
    }
    this.rendered = log.slice();
    if (atBottom || !prefixOk) this.scrollToEnd();
  }

  private scrollToEnd(): void {
    this.list.scrollTop = this.list.scrollHeight;
  }
}

function sameMsg(a: LogMessage | undefined, b: LogMessage | undefined): boolean {
  return !!a && !!b && a.turn === b.turn && a.text === b.text && a.kind === b.kind && a.speaker === b.speaker;
}

function row(m: LogMessage): HTMLElement {
  const speaker = m.speaker ? h('span', { class: 'aw-log-speaker' }, m.speaker) : null;
  return h(
    'li',
    { class: ['aw-log-row', logKindClass(m.kind)], dataset: { turn: m.turn } },
    speaker,
    h('span', { class: 'aw-log-text' }, m.text),
  );
}
