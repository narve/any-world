/**
 * MP3 rooms on the start page (design §2.1–§2.3): the "Play together" card (open rooms, Create a
 * room, Join by code, Refresh; "unavailable" when the server is offline, Reload when this page is
 * outdated). Names are always set as text, never as markup. The lobby and the name sheet are in
 * lobby.ts, loaded only when a room needs them.
 */
import type { RoomIntent, RoomRowView, RoomsCardView } from '../viewmodel';
import { dataKey, h, icon, ICONS, setChildren } from '../dom';
import { t, type MessageKey } from '../../i18n/index';
import '../../styles/rooms.css';

/** the room-code alphabet (protocol Code: no 0/O/1/I/L) */
const CODE_CHARS = /[^2-9A-HJ-NP-Z]/g;
const REFRESH_ICON = ['M21 12a9 9 0 1 1-3-6.7', 'M21 3v6h-6'];

/** a typed room code as the field keeps it: upper case, code characters only, at most 4 */
export function cleanCode(s: string): string {
  return s.toUpperCase().replace(CODE_CHARS, '').slice(0, 4);
}

const PHASE_KEYS: Record<RoomRowView['phase'], MessageKey> = { lobby: 'lobby.phase.lobby', playing: 'lobby.phase.playing', ended: 'lobby.phase.ended' };

export function phaseLabel(p: RoomRowView['phase']): string {
  return t(PHASE_KEYS[p]);
}

export class RoomsCard {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private code: HTMLInputElement;
  private joinBtn: HTMLButtonElement;
  private createBtn: HTMLButtonElement;
  private busyEl: HTMLElement;
  private key = '';

  constructor(private onRoom: (i: RoomIntent) => void) {
    this.body = h('div', { class: 'aw-rooms-body' });
    this.code = h('input', {
      id: 'aw-room-code',
      class: 'aw-input aw-room-code',
      type: 'text',
      inputmode: 'text',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      maxlength: '4',
      placeholder: 'K7QX',
      'aria-label': t('room.joinCode'),
      enterkeyhint: 'go',
      oninput: () => {
        const v = cleanCode(this.code.value);
        if (v !== this.code.value) this.code.value = v;
        this.syncJoin();
      },
    });
    this.joinBtn = h('button', { type: 'submit', class: 'aw-btn aw-room-join-btn' }, t('room.join'));
    this.createBtn = h('button', { type: 'button', class: 'aw-btn aw-btn-primary aw-room-create', onclick: () => this.onRoom({ type: 'create' }) }, icon(ICONS.play), t('room.create'));
    this.busyEl = h('p', { class: 'aw-rooms-busy', role: 'status', hidden: true });
    this.el = h(
      'section',
      { class: 'aw-rooms', 'aria-labelledby': 'aw-rooms-title' },
      h(
        'div',
        { class: 'aw-rooms-head' },
        h('h2', { id: 'aw-rooms-title' }, t('room.title')),
        h('button', { type: 'button', class: 'aw-icon-btn aw-rooms-refresh', 'aria-label': t('room.refresh'), dataset: { tip: t('room.refresh') }, onclick: () => this.onRoom({ type: 'refresh' }) }, icon(REFRESH_ICON)),
      ),
      h('p', { class: 'aw-muted aw-small' }, t('room.sub')),
      this.body,
      h(
        'div',
        { class: 'aw-rooms-actions' },
        this.createBtn,
        h(
          'form',
          {
            class: 'aw-room-join',
            onsubmit: (e: Event) => {
              e.preventDefault();
              const c = cleanCode(this.code.value);
              if (c.length === 4) this.onRoom({ type: 'join', code: c });
            },
          },
          h('label', { class: 'aw-label', for: 'aw-room-code' }, t('room.joinCode')),
          this.code,
          this.joinBtn,
        ),
      ),
      this.busyEl,
    );
  }

  private syncJoin(): void {
    this.joinBtn.disabled = this.code.disabled || cleanCode(this.code.value).length !== 4;
  }

  update(v: RoomsCardView): void {
    const usable = v.status === 'ok' && !v.busy;
    this.createBtn.disabled = !usable;
    this.code.disabled = !usable;
    this.syncJoin();
    this.busyEl.hidden = !v.busy;
    this.busyEl.textContent = v.busy ?? '';
    this.el.dataset.status = v.status;
    const key = dataKey([v.status, v.rooms, !!v.busy]);
    if (key === this.key) return;
    this.key = key;
    setChildren(this.body, this.statusBody(v));
  }

  private statusBody(v: RoomsCardView): HTMLElement {
    if (v.status === 'loading') return h('p', { class: 'aw-muted aw-rooms-note' }, '…');
    if (v.status === 'unavailable')
      return h(
        'p',
        { class: 'aw-rooms-note is-warn', role: 'status' },
        icon(ICONS.alert),
        h('span', null, t('room.unavailable')),
        h('button', { type: 'button', class: 'aw-btn aw-btn-small', onclick: () => this.onRoom({ type: 'refresh' }) }, t('room.retry')),
      );
    if (v.status === 'outdated')
      return h(
        'p',
        { class: 'aw-rooms-note is-warn', role: 'status' },
        icon(ICONS.alert),
        h('span', null, t('room.outdatedPage')),
        h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-btn-primary', onclick: () => this.onRoom({ type: 'reload' }) }, t('net.reload')),
      );
    if (!v.rooms.length) return h('p', { class: 'aw-muted aw-rooms-note' }, t('room.empty'));
    return h(
      'ul',
      { class: 'aw-room-list' },
      v.rooms.map((r) =>
        h(
          'li',
          { class: 'aw-room-row', dataset: { code: r.code } },
          h(
            'span',
            { class: 'aw-room-info' },
            h('span', { class: 'aw-room-title' }, r.title),
            h('span', { class: 'aw-room-sub' }, [r.genre, t('room.players', { players: r.players, max: r.maxPlayers }), phaseLabel(r.phase)].filter(Boolean).join(' · ')),
          ),
          h(
            'button',
            { type: 'button', class: ['aw-btn', 'aw-btn-small', r.rejoin && 'aw-btn-primary'], disabled: !r.joinable && !r.rejoin, dataset: { join: r.code }, onclick: () => this.onRoom({ type: 'join', code: r.code }) },
            r.rejoin ? t('room.rejoin') : t('room.join'),
          ),
        ),
      ),
    );
  }
}
