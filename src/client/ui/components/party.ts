/**
 * The in-game party UI of a room (MP3 design §3.1, §3.2, §3.4, §3.5), loaded lazily with the room UI
 * (room/room-ui.ts) and put into the game layout's room slots (ui.ts RoomSlots):
 *
 *  - PartyStrip: one chip per member at the end of the status strip (colour, name, hp, what they
 *    are doing: acted ✓, deciding, busy, away, left, down). Phones show a dot per member and, while
 *    a turn is waiting, "2/3" with the deadline bar, in place of the turn counter. While this player
 *    is down a chip follows that teammate.
 *  - TurnPill: "2 of 3 acted" under the strip with a bar draining over the deadline, or "Kari is
 *    deciding" once this player acted; shown only while the turn waits (the delays are PillTimer's).
 *    Nothing ever waits on it: keys and taps still work.
 *  - PartyBanner: the banner row: "You are down…" with "Watching Kari ‹ ›", or the exit countdown
 *    ("Kari took the exit: the party moves on in 4" / "The party moves on in 4").
 *
 * Names are set with textContent (h() children), never as markup.
 */
import type { PlayerId } from '../../../engine/types';
import type { BannerView, MemberState, PartyMember, TurnView } from '../../room/party-view';
import { dataKey, h, setChildren } from '../dom';
import { t } from '../../i18n/index';

const STATE_GLYPH: Partial<Record<MemberState, string>> = { acted: '✓', deciding: '…', busy: '✎', down: '✚' };

function stateLabel(s: MemberState): string {
  switch (s) {
    case 'left':
      return t('party.tagLeft');
    case 'down':
      return t('party.tagDown');
    case 'away':
      return t('party.tagAway');
    case 'busy':
      return t('party.busy');
    default:
      return '';
  }
}

export class PartyStrip {
  readonly el: HTMLElement;
  private chips: HTMLElement;
  private turn: HTMLElement;
  private key = '';
  private turnKey = '';

  constructor(private onFollow: (pid: PlayerId) => void) {
    this.chips = h('span', { class: 'aw-party-chips' });
    this.turn = h('span', { class: 'aw-party-turn', hidden: true });
    this.el = h('span', { class: 'aw-party' }, this.chips, this.turn);
  }

  update(members: readonly PartyMember[], down: boolean): void {
    const key = dataKey([members.map((m) => [m.pid, m.name, m.colour, m.state, m.followed, m.maxHp ? Math.round((m.hp / m.maxHp) * 20) : 0]), down]);
    if (key === this.key) return;
    this.key = key;
    setChildren(
      this.chips,
      members.map((m) => {
        const label = stateLabel(m.state);
        const canFollow = down && !m.you && m.state !== 'down' && m.state !== 'left';
        return h(
          'button',
          {
            type: 'button',
            class: ['aw-party-chip', m.you && 'is-you', m.followed && 'is-followed'],
            dataset: { pid: m.pid, state: m.state },
            style: { '--who': m.colour },
            disabled: !canFollow,
            title: label ? `${m.name} · ${label}` : m.name,
            'aria-label': label ? `${m.name}, ${label}` : m.name,
            onclick: () => canFollow && this.onFollow(m.pid),
          },
          // (phones show the dot alone: with the name's first letter in it, MP5)
          h('span', { class: 'aw-party-dot', 'aria-hidden': 'true' }, h('span', { class: 'aw-party-initial' }, Array.from(m.name)[0]?.toUpperCase() ?? '')),
          h('span', { class: 'aw-party-name' }, m.name),
          h('span', { class: 'aw-party-hp', 'aria-hidden': 'true' }, h('span', { style: { width: `${m.maxHp ? Math.round((Math.max(0, m.hp) / m.maxHp) * 100) : 0}%` } })),
          STATE_GLYPH[m.state] ? h('span', { class: 'aw-party-state', 'aria-hidden': 'true' }, STATE_GLYPH[m.state]) : null,
        );
      }),
    );
  }

  /** phones: "2/3" with the deadline bar while the turn waits */
  setTurn(v: TurnView | null, barMs: number | null): void {
    const k = v ? `${v.acted}/${v.total}|${barMs ?? ''}` : '';
    if (k === this.turnKey) return;
    this.turnKey = k;
    this.turn.hidden = !v;
    if (v) setChildren(this.turn, h('span', null, `${v.acted}/${v.total}`), deadlineBar(barMs));
  }
}

/** a bar that drains over `ms` (CSS animation from full to empty); none without a deadline */
function deadlineBar(ms: number | null): HTMLElement | null {
  if (ms === null || ms <= 0) return null;
  return h('span', { class: 'aw-turn-bar', 'aria-hidden': 'true' }, h('span', { style: { 'animation-duration': `${ms}ms` } }));
}

export class TurnPill {
  readonly el: HTMLElement;
  private key = '';

  constructor() {
    this.el = h('div', { class: 'aw-turn-pill', role: 'status', hidden: true });
  }

  /** null hides; `barMs`: the deadline left when the pill (re)appeared */
  update(v: TurnView | null, barMs: number | null): void {
    const text = !v ? '' : v.mine && v.deciding ? t('party.deciding', { name: v.deciding }) : t('party.acted', { acted: v.acted, total: v.total });
    const key = `${text}|${barMs ?? ''}`;
    if (key === this.key) return;
    this.key = key;
    this.el.hidden = !v;
    if (v) setChildren(this.el, h('span', { class: 'aw-turn-text' }, text), deadlineBar(barMs));
  }
}

export class PartyBanner {
  readonly el: HTMLElement;
  private key = '';

  constructor(private onCycle: (dir: -1 | 1) => void) {
    this.el = h('div', { class: 'aw-party-banner', role: 'status', hidden: true });
  }

  update(v: BannerView | null): void {
    const key = dataKey(v);
    if (key === this.key) return;
    this.key = key;
    this.el.hidden = !v;
    this.el.dataset.kind = v?.kind ?? '';
    if (!v) return setChildren(this.el);
    if (v.kind === 'exit') {
      setChildren(this.el, h('span', { class: 'aw-party-banner-text' }, v.by ? t('party.exitCountdown', { name: v.by, n: v.turnsLeft }) : t('party.exitTaken', { n: v.turnsLeft })));
      return;
    }
    const cycle = (dir: -1 | 1, label: string, glyph: string) => h('button', { type: 'button', class: 'aw-icon-btn aw-spectate-cycle', dataset: { dir }, 'aria-label': label, title: label, onclick: () => this.onCycle(dir) }, glyph);
    setChildren(
      this.el,
      h('span', { class: 'aw-party-banner-text aw-down-text' }, t('party.down', { n: v.turnsLeft })),
      v.watching
        ? h(
            'span',
            { class: 'aw-spectate' },
            v.canCycle ? cycle(-1, t('party.prevTeammate'), '‹') : null,
            h('span', { class: 'aw-spectate-name' }, t('party.watching', { name: v.watching })),
            v.canCycle ? cycle(1, t('party.nextTeammate'), '›') : null,
          )
        : null,
    );
  }
}
