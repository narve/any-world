/**
 * The lobby screen (MP3 design §2.4, screen 'lobby'): the room code in large type with the share
 * link, Copy link / Share and the QR code; the world card (the host changes it from a picker of demo
 * worlds and the worlds kept in this browser); the roster (colour, name, host, ready, away); the
 * room options (the host edits them, everyone else reads them); the line that the game master reads
 * the chat; Ready, Start (host, never gated on everyone being ready: fast first) and Leave.
 *
 * Each part re-renders on its own when its data changes, so a roster update never takes the focus
 * from an options field. Names are set with textContent (h() children), never as markup; the QR
 * code is the SVG made by room/qr.ts from the link.
 *
 * Also the name and colour sheet (asked once before the first create or join, and opened by
 * "Change" in a room). The UI loads this module lazily (ui.ts), so the start bundle stays small.
 */
import type { LobbyView, ProfileSheetView, RoomIntent, RoomRosterView } from '../viewmodel';
import { dataKey, h, icon, ICONS, setChildren } from '../dom';
import { DIFFICULTIES, difficultyLabel, toDifficulty } from '../format';
import { t } from '../../i18n/index';
import { phaseLabel } from './rooms';
import { Modal } from './modals';
import '../../styles/rooms.css';

const COPY_ICON = ['M9 9h11v11H9z', 'M5 15H4V4h11v1'];

/** presences shown as "away" on a roster row (not `idle`: nobody acts in the lobby, chatting counts as here) */
const AWAY = new Set(['off', 'gone']);

export class LobbyScreen {
  readonly el: HTMLElement;
  private shareEl: HTMLElement;
  private worldEl: HTMLElement;
  private rosterEl: HTMLElement;
  private optionsEl: HTMLElement;
  private actionsEl: HTMLElement;
  private gmEl: HTMLElement;
  /** where the room UI puts the chat panel (chat works in the lobby too) */
  readonly chatHost: HTMLElement;
  private keys: Record<string, string> = {};

  constructor(private onRoom: (i: RoomIntent) => void) {
    this.shareEl = h('section', { class: 'aw-lobby-share', 'aria-label': t('lobby.code') });
    this.worldEl = h('section', { class: 'aw-lobby-worldbox' });
    this.rosterEl = h('section', { class: 'aw-lobby-rosterbox', 'aria-labelledby': 'aw-lobby-players' });
    this.optionsEl = h('section', { class: 'aw-lobby-options', 'aria-labelledby': 'aw-lobby-options-title' });
    this.actionsEl = h('div', { class: 'aw-lobby-actions' });
    this.chatHost = h('section', { class: 'aw-lobby-chat', 'aria-label': t('chat.history') });
    // (only for the AI GM: recorded lines and the offline director send nothing anywhere)
    this.gmEl = h('p', { class: 'aw-lobby-gm aw-muted aw-small', hidden: true }, icon(ICONS.alert), h('span', null, t('lobby.gmReadsChat')));
    this.el = h(
      'main',
      { class: 'aw-screen aw-lobby', 'aria-label': t('room.title') },
      h(
        'div',
        { class: 'aw-lobby-inner' },
        h('div', { class: 'aw-lobby-col' }, this.shareEl, this.worldEl, this.optionsEl),
        h('div', { class: 'aw-lobby-col' }, this.rosterEl, this.gmEl, this.actionsEl, this.chatHost),
      ),
    );
  }

  /** renders `part` only when `data` changed since its last render */
  private part(name: string, data: unknown, el: HTMLElement, build: () => (Node | null)[]): void {
    const k = dataKey(data);
    if (this.keys[name] === k) return;
    this.keys[name] = k;
    setChildren(el, ...build());
  }

  update(v: LobbyView): void {
    this.el.dataset.phase = v.phase;
    this.el.dataset.code = v.code;
    this.gmEl.hidden = v.gm !== 'ai';
    this.part('share', [v.code, v.link, v.qr], this.shareEl, () => this.share(v));
    this.part('world', [v.world, v.you.host, v.host], this.worldEl, () => this.world(v));
    this.part('roster', [v.roster, v.phase], this.rosterEl, () => this.roster(v));
    this.part('options', [v.options, v.limits, v.you.host], this.optionsEl, () => this.options(v));
    this.part('actions', [v.you, v.readyCount, v.roster.length, v.phase], this.actionsEl, () => this.actions(v));
  }

  private share(v: LobbyView): (Node | null)[] {
    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    const qr = h('div', { class: 'aw-lobby-qr', 'aria-label': v.link });
    // (qr.ts builds the SVG from the link only, with its label escaped: no outside markup)
    if (v.qr) qr.innerHTML = v.qr;
    else qr.classList.add('is-empty');
    return [
      h(
        'div',
        { class: 'aw-lobby-codebox' },
        h('span', { class: 'aw-label' }, t('lobby.code')),
        h('span', { class: 'aw-lobby-code' }, v.code),
        h('input', { class: 'aw-input aw-lobby-link', type: 'text', readonly: true, value: v.link, 'aria-label': t('room.copyLink'), onfocus: (e: FocusEvent) => (e.target as HTMLInputElement).select() }),
        h(
          'button',
          { type: 'button', class: 'aw-btn aw-lobby-copy', onclick: () => this.onRoom({ type: 'share' }) },
          icon(canShare ? ICONS.play : COPY_ICON),
          canShare ? t('room.share') : t('room.copyLink'),
        ),
      ),
      qr,
    ];
  }

  private world(v: LobbyView): (Node | null)[] {
    const w = v.world;
    const picking = !!v.host?.picking;
    const pick = (id: string, title: string, sub: string, color?: string) =>
      h(
        'li',
        null,
        h(
          'button',
          { type: 'button', class: ['aw-demo', w.title === title && 'is-current'], dataset: { world: id }, style: { '--demo': color ?? 'var(--c-primary)' }, onclick: () => this.onRoom({ type: 'world', id }) },
          h('span', { class: 'aw-demo-title' }, title),
          h('span', { class: 'aw-demo-tag' }, sub),
        ),
      );
    return [
      h(
        'div',
        { class: 'aw-lobby-world', style: { '--demo': w.color ?? 'var(--c-primary)' } },
        h('span', { class: 'aw-demo-genre' }, w.genre),
        h('span', { class: 'aw-lobby-world-title' }, w.title),
        w.tagline ? h('span', { class: 'aw-demo-tag' }, w.tagline) : null,
        v.you.host
          ? h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-lobby-change-world', 'aria-expanded': String(picking), onclick: () => this.onRoom({ type: 'pick_world', open: !picking }) }, t('lobby.changeWorld'))
          : null,
      ),
      picking && v.host
        ? h(
            'div',
            { class: 'aw-lobby-picker' },
            h('ul', { class: 'aw-demo-list' }, v.host.worlds.map((d) => pick(d.id, d.title, d.tagline, d.color)), v.host.own.map((d) => pick(d.id, d.title, d.tagline, d.color))),
            // (the new-world form lives on the start page; a world made there is kept and listed above)
            h('p', { class: 'aw-muted aw-small aw-lobby-newworld' }, t('lobby.newPartyWorld')),
          )
        : null,
    ];
  }

  private roster(v: LobbyView): (Node | null)[] {
    const row = (r: RoomRosterView) => {
      const away = AWAY.has(r.presence);
      return h(
        'li',
        { class: ['aw-roster-row', r.you && 'is-you', away && 'is-away'], dataset: { seat: r.seat } },
        h('span', { class: 'aw-roster-dot', style: { background: r.colour }, 'aria-hidden': 'true' }),
        h('span', { class: 'aw-roster-name', style: { color: r.colour } }, r.name),
        r.you ? h('span', { class: 'aw-chip tone-muted' }, t('lobby.you')) : null,
        r.host ? h('span', { class: 'aw-chip tone-accent aw-roster-host' }, t('lobby.host')) : null,
        away ? h('span', { class: 'aw-chip tone-muted aw-roster-away' }, r.presence === 'gone' ? t('party.tagLeft') : t('party.tagAway')) : null,
        h('span', { class: ['aw-roster-ready', r.ready && 'is-ready'], 'aria-label': r.ready ? t('lobby.ready') : t('lobby.notReady'), title: r.ready ? t('lobby.ready') : t('lobby.notReady') }, r.ready ? icon(ICONS.check) : null),
        r.you ? h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-btn-ghost aw-roster-change', onclick: () => this.onRoom({ type: 'change_profile' }) }, t('lobby.change')) : null,
      );
    };
    return [
      h('div', { class: 'aw-lobby-roster-head' }, h('h2', { id: 'aw-lobby-players' }, t('lobby.players')), h('span', { class: 'aw-chip tone-muted' }, phaseLabel(v.phase))),
      h('ul', { class: 'aw-lobby-roster' }, v.roster.map(row)),
    ];
  }

  private options(v: LobbyView): (Node | null)[] {
    const o = v.options;
    const head = h('h2', { id: 'aw-lobby-options-title' }, t('lobby.options.title'));
    const deadlineText = (ms: number) => t('lobby.options.deadlineValue', { s: Math.round(ms / 1000) });
    if (!v.you.host) {
      return [
        head,
        h(
          'dl',
          { class: 'aw-lobby-optlist' },
          h('div', null, h('dt', null, t('lobby.options.maxPlayers')), h('dd', null, String(o.maxPlayers))),
          h('div', null, h('dt', null, t('lobby.options.deadline')), h('dd', null, deadlineText(o.deadlineMs))),
          h('div', null, h('dt', null, t('lobby.options.difficulty')), h('dd', null, difficultyLabel(o.difficulty))),
        ),
      ];
    }
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    const players = range(Math.max(v.limits.maxPlayers.min, v.roster.length), v.limits.maxPlayers.max);
    const secs = range(Math.ceil(v.limits.deadlineMs.min / 1000), Math.floor(v.limits.deadlineMs.max / 1000));
    const select = (id: string, label: string, opts: { value: string; label: string; on: boolean }[], set: (val: string) => void) =>
      h(
        'label',
        { class: 'aw-field aw-lobby-opt', for: id },
        h('span', { class: 'aw-field-label' }, label),
        h('select', { id, onchange: (e: Event) => set((e.target as HTMLSelectElement).value) }, opts.map((x) => h('option', { value: x.value, selected: x.on }, x.label))),
      );
    return [
      head,
      h(
        'div',
        { class: 'aw-lobby-optgrid' },
        select('aw-opt-max', t('lobby.options.maxPlayers'), players.map((n) => ({ value: String(n), label: String(n), on: n === o.maxPlayers })), (x) => this.onRoom({ type: 'options', options: { maxPlayers: Number(x) } })),
        select('aw-opt-deadline', t('lobby.options.deadline'), secs.map((s) => ({ value: String(s * 1000), label: deadlineText(s * 1000), on: s * 1000 === o.deadlineMs })), (x) =>
          this.onRoom({ type: 'options', options: { deadlineMs: Number(x) } }),
        ),
        select('aw-opt-diff', t('lobby.options.difficulty'), DIFFICULTIES.map((d) => ({ value: d, label: difficultyLabel(d), on: d === o.difficulty })), (x) =>
          this.onRoom({ type: 'options', options: { difficulty: toDifficulty(x) } }),
        ),
      ),
    ];
  }

  private actions(v: LobbyView): (Node | null)[] {
    const ready = v.you.ready;
    return [
      h(
        'button',
        { type: 'button', class: ['aw-btn', 'aw-btn-lg', 'aw-lobby-ready', ready && 'is-on'], 'aria-pressed': String(ready), onclick: () => this.onRoom({ type: 'ready', on: !ready }) },
        ready ? icon(ICONS.check) : null,
        t('lobby.ready'),
      ),
      v.you.host
        ? h(
            'button',
            { type: 'button', class: 'aw-btn aw-btn-primary aw-btn-lg aw-lobby-start', 'data-autofocus': true, onclick: () => this.onRoom({ type: 'start' }) },
            icon(ICONS.play),
            v.phase === 'ended' ? t('lobby.playAgain') : t('lobby.start'),
          )
        : h('p', { class: 'aw-muted aw-lobby-waiting' }, t('lobby.waitingHost')),
      h('span', { class: 'aw-lobby-count aw-muted' }, t('lobby.readyCount', { ready: v.readyCount, total: v.roster.length })),
      h('button', { type: 'button', class: 'aw-btn aw-btn-ghost aw-lobby-leave', onclick: () => this.onRoom({ type: 'leave' }) }, t('room.leave')),
    ];
  }
}

/** the name and colour sheet: a name field and the player colours as swatches */
export class ProfileSheet {
  readonly modal = new Modal('aw-profile-sheet', t('lobby.name'));
  private nameInput: HTMLInputElement;
  private swatches: HTMLElement;
  private go: HTMLButtonElement;
  private colour = '';
  private view: ProfileSheetView | null = null;

  constructor(private onRoom: (i: RoomIntent) => void) {
    this.nameInput = h('input', {
      id: 'aw-profile-name',
      class: 'aw-input',
      type: 'text',
      maxlength: '24',
      autocomplete: 'nickname',
      enterkeyhint: 'done',
      'data-autofocus': true,
      oninput: () => this.syncGo(),
      // (the field holds a name, often the generated "Player 92": a tap then typing replaces it, MP5)
      // (after the tap's own caret placement, so the selection stays)
      onfocus: () => setTimeout(() => document.activeElement === this.nameInput && this.nameInput.select(), 0),
    });
    this.swatches = h('div', { class: 'aw-swatches', role: 'radiogroup', 'aria-label': t('lobby.colour') });
    this.go = h('button', { type: 'submit', class: 'aw-btn aw-btn-primary aw-profile-go' });
  }

  get el(): HTMLElement {
    return this.modal.el;
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  private syncGo(): void {
    const name = this.nameInput.value.trim();
    this.go.disabled = !name;
    this.go.textContent = t('lobby.joinAs', { name: name || '…' });
  }

  private pick(c: string): void {
    this.colour = c;
    for (const b of Array.from(this.swatches.children) as HTMLElement[]) {
      const on = b.dataset.colour === c;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }

  update(v: ProfileSheetView | null): void {
    if (!v) {
      this.view = null;
      return this.modal.hide();
    }
    this.view = v;
    // (built once per opening: a roster change while it is open must not reset the typed name)
    if (!this.modal.show([v.purpose, v.name, v.colour])) return;
    this.nameInput.value = v.name;
    this.colour = v.colour;
    setChildren(
      this.swatches,
      v.colours.map(({ value: c, label }) =>
        h('button', {
          type: 'button',
          role: 'radio',
          class: ['aw-swatch', v.taken.includes(c) && c !== v.colour && 'is-taken'],
          style: { '--swatch': c },
          dataset: { colour: c, tip: label },
          'aria-label': label,
          onclick: () => this.pick(c),
        }),
      ),
    );
    this.pick(v.colour);
    this.syncGo();
    setChildren(
      this.modal.card,
      h(
        'form',
        {
          class: 'aw-profile-form',
          onsubmit: (e: Event) => {
            e.preventDefault();
            const name = this.nameInput.value.trim();
            if (name) this.onRoom({ type: 'profile', name, colour: this.colour });
          },
        },
        h('header', { class: 'aw-panel-head' }, h('h2', null, t('lobby.name')), h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': t('common.cancel'), onclick: () => this.onRoom({ type: 'profile_cancel' }) }, icon(ICONS.close))),
        h('label', { class: 'aw-label', for: 'aw-profile-name' }, t('lobby.name')),
        this.nameInput,
        h('span', { class: 'aw-label' }, t('lobby.colour')),
        this.swatches,
        h('div', { class: 'aw-profile-actions' }, h('button', { type: 'button', class: 'aw-btn aw-btn-ghost', onclick: () => this.onRoom({ type: 'profile_cancel' }) }, t('common.cancel')), this.go),
      ),
    );
    this.modal.focusFirst();
  }
}
