/**
 * RoomUi (MP3 design §3, §4): a room's party and chat UI on this page, for as long as the page is
 * in the room (RoomFlow makes one per RoomLink). It lives in the lazy room chunk and puts its
 * elements into the game layout's room slots (ui.ts RoomSlots), so the start bundle carries only
 * the empty hosts.
 *
 *  - The chat panel moves with the screen: docked on the right of the desktop game, a bottom sheet
 *    behind the chat button on phones, inline in the lobby and on the end screen. Enter and `/`
 *    open it (ui.ts → RoomIntent 'chat'); while its input or sheet is open the seat's presence is
 *    `menu`, so a player reading or writing never holds up a turn. Sends share the 1/s chat bucket
 *    (ChatModel.canSend) and a send too soon keeps the draft with "Wait a moment".
 *  - Per run (attachRun): the party strip, the turn pill, the banner (down / spectator, exit
 *    countdown), the PartyOverlay over the map (name tags, bubbles, typing, pings, edge arrows), the
 *    players' ring colours (renderer.setPartyColours) and the spectator's cycling (`[` / `]`, the
 *    banner's ‹ ›, a party chip).
 *  - A line whose speaker is not on screen (or any line outside the game) is highlighted in the
 *    history; on phones it also shows for a few seconds over the log ticker.
 *
 * One animation-frame loop re-projects the overlay and refreshes the rest (each part skips
 * unchanged data). Nothing here ever waits on the clock.
 */
import type { PingKind } from '../../net/protocol';
import type { ClockMsg } from '../../net/protocol';
import type { GameUi, RoomSlots } from '../ui/ui';
import type { Renderer } from '../render/index';
import type { GameController } from '../game-controller';
import { leadPlayer } from '../../engine/index';
import { isCompact } from '../ui/layout';
import { h } from '../ui/dom';
import { t } from '../i18n/index';
import { ChatButton, ChatPanel, lineText, type ChatLineView, type ChatMode, type SendResult } from '../ui/components/chat';
import { PartyBanner, PartyStrip, TurnPill } from '../ui/components/party';
import { PartyOverlay, type OverlayMember, type OverlayPing } from '../party-overlay';
import { CHAT_TIMING, GmChatLog, isEmote } from './chat-model';
import { bannerView, partyColours, partyMembers, PillTimer, turnView, type PartyMember, type TurnView } from './party-view';
import type { LinkEvent, RoomLink } from './link';
import type { RoomSession } from './room-session';
import '../styles/party.css';

/** the run on screen: its session, controller and renderer (the map overlay goes into canvasHost) */
export interface RoomUiRun {
  session: RoomSession;
  controller: GameController;
  renderer: Renderer;
  canvasHost: HTMLElement;
}

/** the GM's lines in the chat panel (a neutral gold, no seat has it) */
export const GM_CHAT_COLOUR = '#c9a54a';

/** design constants: typing is repeated this often while the draft changes; ticker lines show this long */
export const ROOM_UI_TIMING = { typingRefreshMs: 3000, tickerMs: 4000, freshMs: 6000, refreshMs: 100 } as const;

export class RoomUi {
  readonly chat: ChatPanel;
  private button: ChatButton;
  private sheet: HTMLElement;
  private strip: PartyStrip;
  private pill = new TurnPill();
  private banner: PartyBanner;
  private ticker: HTMLElement;
  private tickerUntil = 0;
  private overlay: PartyOverlay | null = null;
  private run: RoomUiRun | null = null;
  private raf = 0;
  private disposed = false;
  private sheetOpen = false;
  private placeKey = '';
  private pillTimer = new PillTimer();
  private lastTurn: TurnView | null = null;
  private clockSeen: { msg: ClockMsg; at: number } | null = null;
  private pillBar: number | null = null;
  /** line id → until when it is highlighted (its speaker was not on screen) */
  private fresh = new Map<number, number>();
  /** ping line id → when it arrived (live pings only: a welcome's history shows no markers) */
  private pingAt = new Map<number, number>();
  /** the GM's answers to the chat (shown among the lines, never as a card) */
  readonly gmChat = new GmChatLog();
  private typingOn = false;
  private typingAt = 0;
  private coloursKey = '';
  private refreshAt = 0;
  private offLink: () => void;
  private offClock: () => void;

  constructor(
    private readonly link: RoomLink,
    private readonly ui: GameUi,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.chat = new ChatPanel({
      send: (text) => this.trySend(() => this.link.client.say(text)),
      emote: (e) => this.trySend(() => this.link.client.say(e)),
      ping: (k) => this.sendPing(k),
      typing: (on) => this.typing(on),
      opened: (open) => this.chatOpened(open),
    });
    this.button = new ChatButton(() => this.setSheet(!this.sheetOpen));
    this.sheet = h('div', { class: 'aw-chat-sheet', hidden: true });
    this.strip = new PartyStrip((pid) => this.followPid(pid));
    this.banner = new PartyBanner((dir) => this.follow(dir));
    this.ticker = h('div', { class: 'aw-log-chat', 'aria-hidden': 'true', hidden: true });
    this.offLink = link.on((e) => this.onLink(e));
    // (a clock frame refreshes at once: the pill's delay counts from when the turn started waiting)
    this.offClock = link.client.on((e) => {
      if (e.t === 'message' && e.msg.t === 'clock') {
        this.clockSeen = { msg: e.msg, at: this.now() };
        this.pillBar = null;
        this.refresh(true);
      } else if (e.t === 'entries' && !e.catchUp) this.gmEntries(e.steps);
    });
    ui.root.dataset.room = '1';
    this.loop();
  }

  // ---------------------------------------------------------------------------
  // runs
  // ---------------------------------------------------------------------------

  /** a run is on screen: the party UI and the map overlay follow it */
  attachRun(run: RoomUiRun): void {
    this.detachRun();
    this.run = run;
    const r = run.renderer;
    this.overlay = new PartyOverlay(run.canvasHost, { actor: (id, frac) => r.actorScreen(id, frac), tile: (p) => r.tileToScreen(p) });
    this.coloursKey = '';
    this.pillTimer = new PillTimer();
    this.lastTurn = null;
  }

  detachRun(): void {
    // (the renderer outlives the room: a later single-player run must not keep the seat colours)
    this.run?.renderer.setPartyColours(new Map());
    this.overlay?.dispose();
    this.overlay = null;
    this.run = null;
    delete this.ui.root.dataset.roomDown;
  }

  /** what the automation handle's bubbles() reads: the bubbles shown over the map now */
  bubbles(): { seat: string; text: string; kind: 'bubble' | 'typing' }[] {
    return this.overlay?.shown() ?? [];
  }

  /** the NPC lines shown over the map now (the automation handle) */
  npcBubbles(): { actorId: string; text: string }[] {
    return this.overlay?.shownNpc() ?? [];
  }

  /** whether `seat`'s player is on screen now (the automation handle) */
  onScreen(seat: string): boolean {
    return !!this.overlay?.onScreen(seat);
  }

  // ---------------------------------------------------------------------------
  // chat
  // ---------------------------------------------------------------------------

  /** Enter / `/` (any layer but text fields), the dock's button: the input takes the focus (phones: the sheet opens) */
  openChat(): void {
    this.place();
    if (this.screen() === 'game' && this.compact()) {
      this.setSheet(true);
      this.chat.openInput();
      return;
    }
    if (this.chat.el.isConnected) this.chat.openInput();
  }

  private setSheet(open: boolean): void {
    if (open === this.sheetOpen) return;
    this.sheetOpen = open;
    this.sheet.hidden = !open;
    // (phones: toasts move to the top while it is open, as for the game's own sheets: ui.css)
    if (open) this.ui.root.dataset.roomChat = '1';
    else delete this.ui.root.dataset.roomChat;
    this.link.chat.setSheetOpen(open);
    this.link.setMenu('chat', open);
    if (!open && this.sheet.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    this.refresh(true);
    // (the sheet covers the bottom of the map: the camera's insets and the layout are measured again)
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  private chatOpened(open: boolean): void {
    if (this.chat.currentMode === 'sheet') {
      if (!open) this.setSheet(false);
      return;
    }
    // (the desktop dock: presence `menu` while its input is open; inline in the lobby it does not matter)
    if (this.chat.currentMode === 'dock') this.link.setMenu('chat', open);
  }

  private trySend(send: () => boolean): SendResult {
    const now = this.now();
    if (!this.link.chat.canSend(now).ok) return 'slow';
    if (!send()) {
      this.ui.toast(t('room.offline'), 'warn');
      return 'offline';
    }
    this.link.chat.noteSent(now);
    this.typing(false);
    return 'ok';
  }

  /** a line sent as the chat panel sends it, after `typingMs` of typing (the autoplay's chat) */
  say(text: string, typingMs = 300): void {
    this.typing(true);
    setTimeout(() => {
      if (!this.disposed && this.trySend(() => this.link.client.say(text)) !== 'ok') this.typing(false);
    }, typingMs);
  }

  /** a map ping at this player's own position (one tap: that is what they mean) */
  private sendPing(kind: PingKind): SendResult {
    const s = this.run?.session;
    if (!s || s.ended) return 'offline';
    const pos = s.player().pos;
    return this.trySend(() => this.link.client.ping(kind, pos));
  }

  private typing(on: boolean): void {
    const c = this.link.client;
    const now = this.now();
    if (on) {
      if (this.typingOn && now - this.typingAt < ROOM_UI_TIMING.typingRefreshMs) return;
      if (c.typing(true)) {
        this.typingOn = true;
        this.typingAt = now;
      }
    } else if (this.typingOn) {
      this.typingOn = false;
      c.typing(false);
    }
  }

  private onLink(e: LinkEvent): void {
    if (e.t === 'chatError') return this.chat.refused(CHAT_TIMING.sendGapMs);
    if (e.t !== 'chat') return;
    const now = this.now();
    const line = e.line;
    if (line.ping) this.pingAt.set(line.id, now);
    const mine = line.seat === this.link.client.seat;
    if (mine && !line.ping) this.chat.confirmSent(line.text);
    // a speaker who is not on screen (or anyone outside the game): the line is highlighted in the history
    if (!mine && !(this.screen() === 'game' && this.overlay?.onScreen(line.seat))) {
      this.fresh.set(line.id, now + ROOM_UI_TIMING.freshMs);
      if (this.screen() === 'game' && this.compact() && !this.sheetOpen) {
        this.ticker.textContent = `${line.name}: ${lineText({ text: line.text, ...(line.ping ? { ping: line.ping.kind } : {}) })}`;
        this.ticker.style.setProperty('--who', line.colour);
        this.ticker.hidden = false;
        this.tickerUntil = now + ROOM_UI_TIMING.tickerMs;
      }
    }
    this.refresh(true);
  }

  /** the GM's chat answers (gm entries of the `chat` hook): into the panel, highlighted, on the phone's ticker */
  private gmEntries(steps: readonly { entry: { k: string }; after: { area: { actors: readonly { id: string; defId: string }[] } } }[]): void {
    const world = this.link.client.world;
    let added = false;
    for (const st of steps) {
      const e = st.entry as { k: string; hook?: string; actions?: { type: string; text?: string; actorId?: string }[] };
      if (e.k !== 'gm' || e.hook !== 'chat' || !e.actions) continue;
      const afterId = this.link.chat.lines[this.link.chat.lines.length - 1]?.id ?? 0;
      const names = (id: string) => {
        const a = st.after.area.actors.find((x) => x.id === id || x.defId === id);
        return (a && world?.actors.find((d) => d.id === a.defId)?.name) ?? null;
      };
      const now = this.now();
      for (const l of this.gmChat.add(e.actions, afterId, names)) {
        added = true;
        this.fresh.set(l.id, now + ROOM_UI_TIMING.freshMs);
        if (this.screen() === 'game' && this.compact() && !this.sheetOpen) {
          this.ticker.textContent = `${l.name ?? t('chat.gm')}: ${l.text}`;
          this.ticker.style.setProperty('--who', GM_CHAT_COLOUR);
          this.ticker.hidden = false;
          this.tickerUntil = now + ROOM_UI_TIMING.tickerMs;
        }
      }
    }
    if (added) this.refresh(true);
  }

  // ---------------------------------------------------------------------------
  // spectator
  // ---------------------------------------------------------------------------

  /** `[` / `]` and the banner's ‹ ›: the previous / next standing teammate (while down) */
  follow(dir: -1 | 1): void {
    const r = this.run;
    if (!r || !r.session.me.down) return;
    const before = r.session.followed;
    if (r.session.cycleFollow(dir) !== before) r.controller.cameraChanged();
  }

  private followPid(pid: string): void {
    const r = this.run;
    if (!r) return;
    const before = r.session.followed;
    if (r.session.follow(pid) !== before) r.controller.cameraChanged();
  }

  // ---------------------------------------------------------------------------
  // the frame loop
  // ---------------------------------------------------------------------------

  private screen(): string {
    return this.ui.root.dataset.screen ?? '';
  }

  private compact(): boolean {
    return isCompact(this.ui.layoutMode());
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    try {
      this.frame();
    } catch (e) {
      console.warn('[anyworld] room UI frame failed:', e);
    }
  };

  /** the chat panel, the chat button and the party parts in the places of the current screen */
  private place(): void {
    const screen = this.screen();
    const compact = this.compact();
    const slots = this.ui.roomSlots();
    const game = screen === 'game';
    let host: HTMLElement | null = null;
    let mode: ChatMode = 'inline';
    if (game) [host, mode] = compact ? [this.sheet, 'sheet'] : [slots.side, 'dock'];
    else if (screen === 'lobby') host = slots.lobby;
    else if (screen === 'end') host = slots.end;
    const key = `${screen}|${compact}|${host ? 1 : 0}`;
    if (key === this.placeKey) return;
    this.placeKey = key;
    if (game && compact) {
      slots.tools.append(this.button.el);
      slots.sheet.append(this.sheet);
    } else {
      this.button.el.remove();
      this.sheet.remove();
      this.setSheet(false);
    }
    if (host) {
      if (this.chat.el.parentElement !== host) host.append(this.chat.el);
      this.chat.setMode(mode);
    } else this.chat.el.remove();
    this.chat.setPings(game);
    this.mountParty(game, slots);
    this.refresh(true);
  }

  private mountParty(on: boolean, slots: RoomSlots): void {
    const parts: [HTMLElement, HTMLElement][] = [
      [this.strip.el, slots.strip],
      [this.pill.el, slots.pill],
      [this.banner.el, slots.banner],
      [this.ticker, slots.log],
    ];
    for (const [el, slot] of parts) {
      if (on && el.parentElement !== slot) slot.append(el);
      else if (!on) el.remove();
    }
    if (!on) this.overlay?.clear();
  }

  private frame(): void {
    this.place();
    const now = this.now();
    if (now >= this.refreshAt) this.refresh(false);
    const run = this.run;
    if (!run || this.screen() !== 'game' || run.session.ended || !this.overlay) return;
    this.overlay.frame(this.overlayFrame(run, now));
  }

  /** the parts that do not move with the camera (each skips unchanged data) */
  private refresh(force: boolean): void {
    const now = this.now();
    if (!force && now < this.refreshAt) return;
    this.refreshAt = now + ROOM_UI_TIMING.refreshMs;
    this.renderChat(now);
    if (!this.ticker.hidden && now >= this.tickerUntil) this.ticker.hidden = true;
    const run = this.run;
    if (run && this.screen() === 'game' && !run.session.ended) this.renderParty(run, now);
  }

  private renderChat(now: number): void {
    const model = this.link.chat;
    const self = this.link.client.seat;
    for (const [id, until] of this.fresh) if (until <= now) this.fresh.delete(id);
    const players: ChatLineView[] = model.lines.map((l) => ({
      id: l.id,
      name: l.name,
      colour: l.colour,
      text: l.text,
      own: l.seat === self,
      emote: !l.ping && isEmote(l.text),
      ...(l.ping ? { ping: l.ping.kind } : {}),
      fresh: this.fresh.has(l.id),
    }));
    const lines = this.gmChat.merge(players, (g) => ({ id: g.id, name: g.name ?? t('chat.gm'), colour: GM_CHAT_COLOUR, text: g.text, own: false, emote: false, gm: true, fresh: this.fresh.has(g.id) }));
    this.chat.setLines(lines, now);
    const roster = this.link.client.roster;
    this.chat.setTyping([...model.typing(now)].map((seat) => roster.find((r) => r.seat === seat)?.name ?? '').filter(Boolean));
    this.button.update(model.unread, this.sheetOpen);
  }

  private members(run: RoomUiRun): PartyMember[] {
    const c = this.link.client;
    return partyMembers(run.session.replica, c.roster, c.clock, c.n, run.session.pid, run.session.followed);
  }

  private renderParty(run: RoomUiRun, now: number): void {
    const c = this.link.client;
    const s = run.session;
    const members = this.members(run);
    const down = !!s.me.down;
    if (down) this.ui.root.dataset.roomDown = '1';
    else delete this.ui.root.dataset.roomDown;
    this.strip.update(members, down);
    // the turn pill (shown after a while of waiting, hidden a little after the turn resolved)
    if (c.clock && c.clock !== this.clockSeen?.msg) {
      this.clockSeen = { msg: c.clock, at: now };
      this.pillBar = null;
    }
    const tv = turnView(members, c.clock, c.n, s.pid);
    if (tv.waiting) this.lastTurn = tv;
    const shown = this.pillTimer.update(tv.waiting, now, this.clockSeen?.at) && !down;
    if (shown && this.pillBar === null && this.clockSeen?.msg.deadlineInMs !== undefined) this.pillBar = Math.max(0, this.clockSeen.msg.deadlineInMs - (now - this.clockSeen.at));
    const pv = shown ? this.lastTurn : null;
    this.pill.update(pv, this.pillBar);
    this.strip.setTurn(pv, this.pillBar);
    // the banner (the reconnect banner of the UI root comes first)
    this.banner.update(c.status === 'reconnecting' ? null : bannerView(s.state, members, s.pid));
    // the players' rings in their seat colours
    const colours = partyColours(members);
    const key = JSON.stringify([...colours]);
    if (key !== this.coloursKey) {
      this.coloursKey = key;
      run.renderer.setPartyColours(colours);
    }
  }

  private overlayFrame(run: RoomUiRun, now: number): Parameters<PartyOverlay['frame']>[0] {
    const cam = run.session.cameraState;
    const seen = leadPlayer(cam).seen as ArrayLike<number>;
    const w = cam.area.map.width;
    const members: OverlayMember[] = this.members(run).map((m) => ({
      seat: m.seat,
      name: m.name,
      colour: m.colour,
      actorId: m.actorId,
      pos: m.pos,
      visible: !!m.pos && (seen[m.pos.y * w + m.pos.x] ?? 0) === 2,
      you: m.you,
      away: m.state === 'away',
      busy: m.state === 'busy',
      down: m.state === 'down',
      left: m.state === 'left',
    }));
    const model = this.link.chat;
    const area = run.session.replica.area.index;
    const pings: OverlayPing[] = [];
    for (const l of model.lines) {
      const at = l.ping ? this.pingAt.get(l.id) : undefined;
      if (!l.ping || at === undefined) continue;
      if (now - at > CHAT_TIMING.pingMs) {
        this.pingAt.delete(l.id);
        continue;
      }
      if (l.ping.area === area) pings.push({ id: l.id, kind: l.ping.kind, label: t(`ping.${l.ping.kind}`), colour: l.colour, pos: { x: l.ping.x, y: l.ping.y } });
    }
    const lead = leadPlayer(cam);
    const leadPos = cam.area.actors.find((a) => a.id === lead.actorId)?.pos;
    return {
      members,
      bubbles: model.bubbles(now).filter((b) => !b.ping).map((b) => ({ id: b.id, seat: b.seat, text: b.text, emote: b.emote })),
      typing: model.typing(now),
      pings,
      npcBubbles: run.session.npcBubbles.visible(cam, now),
      avoid: this.ui.panelRects().hud,
      from: leadPos ? run.renderer.tileToScreen(leadPos) : null,
      labels: { away: t('party.tagAway'), busy: t('party.busy'), down: t('party.tagDown') },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.offLink();
    this.offClock();
    this.typing(false);
    this.setSheet(false);
    this.link.setMenu('chat', false);
    this.detachRun();
    this.chat.dispose();
    for (const el of [this.button.el, this.sheet, this.strip.el, this.pill.el, this.banner.el, this.ticker]) el.remove();
    delete this.ui.root.dataset.room;
  }
}
