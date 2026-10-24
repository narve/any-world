/** GM narration card: centred overlay with a typewriter effect; Enter/Space/Esc skip then dismiss. */
import type { NarrationView } from '../viewmodel';
import { h } from '../dom';
import { typewriterCount, typewriterSpeed } from '../format';
import { t } from '../../i18n/index';

export class NarrationCard {
  readonly el: HTMLElement;
  private current: NarrationView | null = null;
  private dismissed = new Set<string>();
  private start = 0;
  private raf = 0;
  private textEl: HTMLElement;
  private titleEl: HTMLElement;
  private speakerEl: HTMLElement;
  private kindEl: HTMLElement;
  private btn: HTMLButtonElement;
  private cps = 55;

  constructor(private onDismiss: (id: string) => void) {
    this.textEl = h('p', { class: 'aw-narr-text' });
    this.titleEl = h('h2', { class: 'aw-narr-title' });
    this.speakerEl = h('div', { class: 'aw-narr-speaker' });
    this.kindEl = h('div', { class: 'aw-narr-kind' });
    this.btn = h('button', { type: 'button', class: 'aw-btn aw-btn-ghost aw-narr-btn', onclick: (e: Event) => { e.stopPropagation(); this.skip(); } }, t('narr.continue'));
    this.el = h(
      'section',
      { class: 'aw-narration', role: 'dialog', 'aria-modal': 'false', 'aria-label': t('narr.label'), hidden: true, onclick: () => this.skip() },
      h('div', { class: 'aw-narr-card' }, this.kindEl, this.titleEl, this.textEl, h('div', { class: 'aw-narr-foot' }, this.speakerEl, this.btn)),
    );
  }

  get visible(): boolean {
    return !!this.current;
  }

  get typing(): boolean {
    return !!this.current && this.shownCount() < this.current.text.length;
  }

  setSpeed(animationSpeed: number, reduceMotion: boolean): void {
    this.cps = typewriterSpeed(animationSpeed, reduceMotion);
  }

  update(n: NarrationView | null): void {
    if (n && this.dismissed.has(n.id)) n = null;
    if (!n) {
      if (this.current) this.hide();
      return;
    }
    if (this.current && this.current.id === n.id && this.current.text === n.text) return;
    this.current = n;
    this.el.hidden = false;
    this.el.dataset.kind = n.kind;
    this.kindEl.textContent = n.kind === 'intro' ? t('narr.intro') : n.kind === 'area_enter' ? t('narr.arrival') : n.kind === 'epitaph' ? t('narr.epitaph') : n.kind === 'event' ? t('narr.event') : '';
    this.titleEl.textContent = n.title ?? '';
    this.titleEl.hidden = !n.title;
    this.speakerEl.textContent = n.speaker ? `— ${n.speaker}` : '';
    this.start = performance.now();
    this.textEl.setAttribute('aria-label', n.text);
    this.tick();
  }

  private shownCount(): number {
    if (!this.current) return 0;
    return typewriterCount(this.current.text, performance.now() - this.start, this.cps);
  }

  private tick = (): void => {
    cancelAnimationFrame(this.raf);
    if (!this.current) return;
    const n = this.shownCount();
    const text = this.current.text;
    this.textEl.textContent = '';
    this.textEl.append(text.slice(0, n), h('span', { class: 'aw-narr-rest', 'aria-hidden': 'true' }, text.slice(n)));
    this.btn.textContent = n < text.length ? t('narr.skip') : t('narr.continue');
    // no scrollbar flicker while the text types out (the full text is laid out from the start)
    this.el.classList.toggle('is-typing', n < text.length);
    if (n < text.length) this.raf = requestAnimationFrame(this.tick);
  };

  /** first press finishes the typing, second dismisses */
  skip(): void {
    if (!this.current) return;
    if (this.typing) {
      this.start = -1e9;
      this.tick();
      return;
    }
    const id = this.current.id;
    this.dismissed.add(id);
    this.hide();
    this.onDismiss(id);
  }

  private hide(): void {
    cancelAnimationFrame(this.raf);
    this.current = null;
    this.el.hidden = true;
  }
}
