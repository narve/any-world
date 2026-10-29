/**
 * The room chat (MP3 design §4), loaded lazily with the rest of the room UI (room/room-ui.ts):
 *
 *  - ChatPanel: the history (colour dot, name in its colour, the text; own lines on the right; a
 *    ping reads "Kari: Follow me"), "Kari is typing…", the input, the one-tap emotes and the map
 *    pings. One panel per room, moved between three places: docked on the right of the desktop
 *    game (the last lines, fading after a while; the input opens with Enter or a click), the phone's
 *    chat sheet, and inline in the lobby and on the end screen.
 *  - ChatButton: the phone's always-visible chat button with its unread badge (hotbar tools row).
 *
 * Keys inside the input never reach the game: its own keydown takes Enter (send, through the form's
 * submit, skipped while an IME composes) and Esc (closes only the chat, not the backpack behind it),
 * and the UI's keyboard treats every other key in a text field as text. The length is counted in
 * code points like the server (❤️ is two) and the field stops at the limit. Text is always set with
 * textContent, never as markup.
 */
import type { PingKind } from '../../../net/protocol';
import { LIMITS } from '../../../net/protocol';
import { CHAT_TIMING, EMOTES } from '../../room/chat-model';
import { h, icon, ICONS, setChildren } from '../dom';
import { t } from '../../i18n/index';

/** one line as the panel shows it */
export interface ChatLineView {
  id: number;
  name: string;
  colour: string;
  text: string;
  own: boolean;
  emote: boolean;
  ping?: PingKind;
  /** the speaker was not on screen when it came: highlighted for a while */
  fresh: boolean;
}

/** what a send did: sent, too soon after the last one (the draft stays), or not connected */
export type SendResult = 'ok' | 'slow' | 'offline';

export interface ChatHandlers {
  send(text: string): SendResult;
  emote(e: string): SendResult;
  ping(kind: PingKind): SendResult;
  /** the draft is non-empty (true) or was cleared, sent or left (false) */
  typing(on: boolean): void;
  /** the input (desktop dock) or the sheet opened or closed: presence `menu` while open */
  opened(open: boolean): void;
}

/** where the panel is: the desktop game's dock, the phone's sheet, or inline (lobby, end screen) */
export type ChatMode = 'dock' | 'sheet' | 'inline';

export const PING_KINDS: readonly PingKind[] = ['follow', 'wait', 'help'];
const PING_GLYPH: Record<PingKind, string> = { follow: '➜', wait: '✋', help: '!' };

const CHAT_ICON = ['M4 5h16v11H9l-5 4z'];
const SEND_ICON = ['M4 12l16-8-6 16-3-7z'];

/** cut `text` to `max` code points (the server's count) */
export function clampCodePoints(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length > max ? cps.slice(0, max).join('') : text;
}

/** the line's words: its text, or for a map ping the ping's own words */
export function lineText(l: Pick<ChatLineView, 'text' | 'ping'>): string {
  return l.ping ? t(`ping.${l.ping}`) : l.text;
}

export class ChatPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private typingEl: HTMLElement;
  private form: HTMLFormElement;
  readonly input: HTMLInputElement;
  private counter: HTMLElement;
  private slowEls: HTMLElement[];
  private openBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private pingsEl: HTMLElement;
  private mode: ChatMode = 'inline';
  private inputOpen = false;
  private composing = false;
  private linesKey = '';
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLineAt = 0;
  /** the last line sent, until its echo comes back: given back to the input if the server drops it */
  private unsent: string | null = null;
  /** what had the focus before the input took it (given back on close) */
  private returnFocus: HTMLElement | null = null;

  constructor(private handlers: ChatHandlers) {
    this.list = h('ol', { class: 'aw-chat-list', 'aria-live': 'polite', 'aria-label': t('chat.history'), tabindex: '0' });
    this.typingEl = h('div', { class: 'aw-chat-typing', 'aria-live': 'polite' });
    this.input = h('input', {
      class: 'aw-input aw-chat-input',
      type: 'text',
      enterkeyhint: 'send',
      autocomplete: 'off',
      spellcheck: true,
      placeholder: t('chat.placeholder'),
      'aria-label': t('chat.placeholder'),
    }) as HTMLInputElement;
    this.counter = h('span', { class: 'aw-chat-counter', hidden: true });
    const slow = () => h('span', { class: 'aw-chat-slow', role: 'status', hidden: true }, t('chat.slowDown'));
    this.slowEls = [slow(), slow()];
    this.form = h(
      'form',
      { class: 'aw-chat-form', autocomplete: 'off' },
      this.input,
      this.counter,
      h('button', { type: 'submit', class: 'aw-icon-btn aw-chat-send', 'aria-label': t('chat.send') }, icon(SEND_ICON)),
    ) as HTMLFormElement;
    this.pingsEl = h(
      'div',
      { class: 'aw-chat-pings', role: 'group', 'aria-label': t('chat.pings') },
      PING_KINDS.map((k) => h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-chat-ping', dataset: { ping: k }, onclick: () => this.sent(this.handlers.ping(k)) }, h('span', { class: 'aw-ping-glyph', 'aria-hidden': 'true' }, PING_GLYPH[k]), t(`ping.${k}`))),
    );
    const emotes = h(
      'div',
      { class: 'aw-chat-quick' },
      h(
        'div',
        { class: 'aw-chat-emotes', role: 'group', 'aria-label': t('chat.emotes') },
        EMOTES.map((e) => h('button', { type: 'button', class: 'aw-chat-emote', dataset: { emote: e }, 'aria-label': e, onclick: () => this.sent(this.handlers.emote(e)) }, e)),
      ),
      this.pingsEl,
      this.slowEls[1],
    );
    this.openBtn = h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-chat-open', onclick: () => this.openInput() }, icon(CHAT_ICON), t('chat.open'), h('kbd', null, t('key.enter')));
    this.closeBtn = h('button', { type: 'button', class: 'aw-icon-btn aw-chat-close', 'aria-label': t('chat.close'), onclick: () => this.closeInput() }, icon(ICONS.close));
    this.el = h(
      'section',
      { class: 'aw-chat', dataset: { mode: this.mode }, 'aria-label': t('chat.history') },
      h('header', { class: 'aw-chat-head' }, h('span', { class: 'aw-chat-title' }, t('chat.history')), this.closeBtn),
      this.list,
      this.typingEl,
      this.openBtn,
      this.form,
      this.slowEls[0],
      emotes,
    );
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('compositionstart', () => (this.composing = true));
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
      this.onInput();
    });
    this.input.addEventListener('blur', (e: FocusEvent) => {
      this.handlers.typing(false);
      // (a dock input left empty for the map closes; a draft, or an emote or ping pressed, keeps it open)
      const to = e.relatedTarget as Node | null;
      if (this.mode === 'dock' && !this.input.value.trim() && !(to && this.el.contains(to))) queueMicrotask(() => document.activeElement !== this.input && this.closeInput(false));
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!this.composing) this.submit();
    });
    this.el.addEventListener('pointerenter', () => this.el.classList.add('is-hover'));
    this.el.addEventListener('pointerleave', () => this.el.classList.remove('is-hover'));
    this.syncOpen();
  }

  get isOpen(): boolean {
    return this.inputOpen;
  }

  get currentMode(): ChatMode {
    return this.mode;
  }

  /** dock: the input shows only while open; sheet and inline: always */
  setMode(mode: ChatMode): void {
    if (mode === this.mode) return;
    const was = this.inputOpen;
    // (an open dock input that leaves the dock closes as the dock's: its presence `menu` ends)
    if (was && this.mode === 'dock') this.handlers.opened(false);
    this.mode = mode;
    this.el.dataset.mode = mode;
    this.inputOpen = mode !== 'dock' ? true : false;
    if (was && mode === 'dock') this.handlers.opened(false);
    this.syncOpen();
  }

  /** map pings only while a run is played (they mark a tile) */
  setPings(on: boolean): void {
    this.pingsEl.hidden = !on;
  }

  private syncOpen(): void {
    const dock = this.mode === 'dock';
    this.form.hidden = dock && !this.inputOpen;
    this.openBtn.hidden = !dock || this.inputOpen;
    this.el.classList.toggle('is-open', this.inputOpen);
    this.closeBtn.hidden = this.mode === 'inline';
  }

  /** Enter, `/`, the dock's Chat button, the phone's sheet: the input takes the focus */
  openInput(): void {
    const a = document.activeElement as HTMLElement | null;
    this.returnFocus = a && a !== document.body && a !== this.input ? a : null;
    if (this.mode === 'dock' && !this.inputOpen) {
      this.inputOpen = true;
      this.syncOpen();
      this.handlers.opened(true);
    }
    this.input.focus({ preventScroll: true });
  }

  /** Esc, an empty Enter, a send in the dock, the sheet's ✕: the input closes (the draft stays) */
  closeInput(restoreFocus = true): void {
    this.handlers.typing(false);
    if (this.mode === 'dock' && this.inputOpen) {
      this.inputOpen = false;
      this.syncOpen();
      this.handlers.opened(false);
    } else if (this.mode === 'sheet') this.handlers.opened(false);
    if (document.activeElement === this.input) this.input.blur();
    const back = this.returnFocus;
    this.returnFocus = null;
    // the focus goes back where it was (a dialogue's option); else nowhere, so game keys work at once
    if (restoreFocus && back && back.isConnected) back.focus({ preventScroll: true });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      // (an IME composing a word takes its own Enter; Android reports key code 229)
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229 || this.composing) return;
      e.preventDefault();
      this.submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeInput();
    }
  }

  private onInput(): void {
    if (this.composing) return;
    const v = clampCodePoints(this.input.value, LIMITS.chatMax);
    if (v !== this.input.value) this.input.value = v;
    const n = Array.from(v).length;
    this.counter.hidden = n < CHAT_TIMING.counterFrom;
    this.counter.textContent = t('chat.left', { n: LIMITS.chatMax - n });
    this.counter.classList.toggle('is-full', n >= LIMITS.chatMax);
    this.handlers.typing(!!v.trim());
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text) {
      if (this.mode === 'dock') this.closeInput();
      return;
    }
    const r = this.handlers.send(text);
    if (r !== 'ok') return this.sent(r);
    this.unsent = text;
    this.input.value = '';
    this.onInput();
    this.handlers.typing(false);
    // the desktop dock closes after a line (the keys are the game's again); the sheet stays open
    if (this.mode === 'dock') this.closeInput();
  }

  private sent(r: SendResult): void {
    if (r === 'slow') this.slowDown(CHAT_TIMING.sendGapMs);
  }

  /** "Wait a moment" under the input and on the emote row (a send too soon, or the server's chat_rate / chat_long) */
  slowDown(ms: number): void {
    for (const el of this.slowEls) el.hidden = false;
    this.el.classList.add('is-slow');
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = setTimeout(() => {
      this.slowTimer = null;
      for (const el of this.slowEls) el.hidden = true;
      this.el.classList.remove('is-slow');
    }, Math.max(1200, ms + 200));
  }

  /** the own line came back from the server: it was not lost */
  confirmSent(text: string): void {
    if (text === this.unsent) this.unsent = null;
  }

  /**
   * the server dropped a send (chat_rate, chat_long, or the socket's rate): "Wait a moment", and the
   * last line sent goes back into an empty input, so the player only has to send it again
   */
  refused(ms: number): void {
    this.slowDown(ms);
    const text = this.unsent;
    this.unsent = null;
    if (!text || this.input.value.trim()) return;
    this.input.value = text;
    this.onInput();
  }

  /** the history (re-rendered when it changed); the dock fades after a quiet while */
  setLines(lines: readonly ChatLineView[], now: number): void {
    const last = lines[lines.length - 1];
    const key = `${lines.length}|${last?.id ?? ''}|${lines.filter((l) => l.fresh).map((l) => l.id).join(',')}`;
    if (key !== this.linesKey) {
      const grew = !this.linesKey.startsWith(`${lines.length}|${last?.id ?? ''}|`);
      this.linesKey = key;
      if (grew) this.lastLineAt = now;
      const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 24;
      setChildren(this.list, ...lines.map((l) => lineEl(l)));
      if (atBottom || grew) this.list.scrollTop = this.list.scrollHeight;
    }
    this.el.classList.toggle('is-quiet', now - this.lastLineAt > 20_000);
    this.el.classList.toggle('is-empty', !lines.length);
  }

  /** "Kari is typing…" at the foot of the history (one name; more are joined) */
  setTyping(names: readonly string[]): void {
    const text = names.length ? t('chat.typing', { name: names.join(', ') }) : '';
    if (this.typingEl.textContent !== text) this.typingEl.textContent = text;
  }

  dispose(): void {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.el.remove();
  }
}

function lineEl(l: ChatLineView): HTMLElement {
  return h(
    'li',
    { class: ['aw-chat-line', l.own && 'is-own', l.emote && 'is-emote', l.ping && 'is-ping', l.fresh && 'is-new'], dataset: { id: l.id }, style: { '--who': l.colour } },
    h('span', { class: 'aw-chat-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'aw-chat-name' }, l.name),
    h('span', { class: 'aw-chat-text' }, l.ping ? `${PING_GLYPH[l.ping]} ${lineText(l)}` : l.text),
  );
}

/** the phone's chat button (tools row) with its unread badge */
export class ChatButton {
  readonly el: HTMLButtonElement;
  private badge: HTMLElement;

  constructor(onClick: () => void) {
    this.badge = h('span', { class: 'aw-chat-badge', hidden: true });
    this.el = h('button', { type: 'button', class: 'aw-icon-btn aw-chat-button', 'aria-label': t('chat.open'), onclick: onClick }, icon(CHAT_ICON), this.badge) as HTMLButtonElement;
  }

  update(unread: number, open: boolean): void {
    const text = unread > 99 ? '99+' : String(unread);
    this.badge.hidden = !unread || open;
    if (this.badge.textContent !== text) this.badge.textContent = text;
    this.el.setAttribute('aria-label', unread && !open ? `${t('chat.open')}: ${t('chat.unread', { n: unread })}` : open ? t('chat.close') : t('chat.open'));
    this.el.classList.toggle('is-on', open);
  }
}
