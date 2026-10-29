/**
 * The App's room flow (MP3 design §1.2, §2, §5), loaded lazily with the rest of the room runtime so
 * the start bundle grows by the "Play together" card only: the start page's room list, creating and
 * joining rooms (the name sheet the first time), the RoomLink for as long as the player stays, one
 * RoomSession and room-mode GameController per run (the session built synchronously on the welcome
 * or `run`, so no entry is missed while the renderer loads; both relaunched on the next run), the
 * lobby and end-of-run views, notices and the reconnect banner. A room never reads, clears or
 * writes the single-player save; the address bar keeps `?room=CODE`.
 *
 * It drives the App through RoomAppHost (main.ts): screens, the renderer, the controller and the UI.
 */
import type { GameUi, LobbyView, ProfileSheetView, RoomIntent, RoomOptionsView, RoomsCardView, RoomView, SettingsView, StartView, UiViewModel } from '../ui/index';
import { DEFAULT_PALETTE } from '../ui/index';
import { defaultVocabulary } from '../ui/format';
import type { Renderer } from '../render/index';
import type { AudioBridge } from '../audio-bridge';
import type { Difficulty } from '../ui/viewmodel';
import type { GameState } from '../../engine/types';
import { hashState } from '../../engine/index';
import type { RoomInfo } from '../../net/protocol';
import { LIMITS, PLAYER_COLOURS } from '../../net/protocol';
import { t, type MessageKey } from '../i18n/index';
import { GameController } from '../game-controller';
import { emptyOutcome, merge, type Outcome } from '../session';
import { endView } from '../view';
import { loadWorld, worldIndex } from '../worlds';
import { roomLink, type RoomsEndpoint } from './config';
import { RoomsApi, type ApiResult } from './api';
import { RECONNECT_LEAVE_MS, RoomLink, roomWorldEntry, type LinkEvent } from './link';
import { RoomSession } from './room-session';
import { RoomUi } from './room-ui';
import type { Autoplay, AutoplayOptions, AutoplayStats } from './autoplay';
import { colourName, defaultProfile, loadProfile, saveProfile, saveSeat, seatCodes, seatToken, type PlayerColour, type Profile } from './profile';

/** what the room flow needs of the App (main.ts) */
export interface RoomAppHost {
  readonly ui: GameUi;
  screen: 'start' | 'loading' | 'lobby' | 'game';
  readonly canvasHost: HTMLElement;
  controller: GameController | null;
  readonly audio: AudioBridge;
  readonly runOptions: { difficulty: Difficulty; weirdness: number };
  render(): void;
  showStart(error?: string): void;
  settingsView(): SettingsView | null;
  languageView(): UiViewModel['language'];
  prefs(): { animationSpeed: number; reduceMotion: boolean };
  startView(): StartView;
  ensureRenderer(): Promise<Renderer>;
}

/** what the automation handle `__anyworld.room` exposes (e2e-mp specs) */
export interface RoomHandle {
  code: string;
  status: string;
  phase: string | null;
  seat: string | null;
  pid: string | null;
  host: boolean;
  run: number;
  n: number;
  /** the room's replica (raw party order) */
  state(): GameState | null;
  /** hashState of the replica */
  hash(): string | null;
  chat(): { seat: string; name: string; text: string }[];
  /** the speech and typing bubbles shown over the map now */
  bubbles(): { seat: string; text: string; kind: 'bubble' | 'typing' }[];
  /** the NPC lines shown over the map now (MP4) */
  npcBubbles(): { actorId: string; text: string }[];
  /** whether `seat`'s player is on screen (bubble) or not (the line goes to the chat column) */
  onScreen(seat: string): boolean;
  roster(): { seat: string; name: string; colour: string; host: boolean; ready: boolean; pid: string | null; presence: string }[];
  session: RoomSession | null;
  link: RoomLink;
  /**
   * Dev and test builds: a sim bot plays this page's player through the session (the exit check);
   * resolves once it is on or off. Rejects in other builds.
   */
  autoplay(on: boolean, opts?: AutoplayOptions): Promise<void>;
  /** what the autoplay did (null before the first autoplay call) */
  autoplayStats(): AutoplayStats | null;
}

export class RoomFlow {
  private readonly roomsApi: RoomsApi;
  private roomsCard: Pick<RoomsCardView, 'status'> & { rooms: RoomInfo[] } = { status: 'loading', rooms: [] };
  /** a create or join under way (the card's status line) */
  private roomBusy: string | null = null;
  /** the room this page is in */
  link: RoomLink | null = null;
  /** its party and chat UI */
  private roomUi: RoomUi | null = null;
  /** the current run's session in the room, and the outcomes that came before its controller was ready */
  private roomSession: RoomSession | null = null;
  private roomDetach: (() => void) | null = null;
  private roomBuffered: Outcome[] = [];
  private roomLive: RoomSession | null = null;
  /** the host's world picker is open (lobby, or "Choose another world" after a run) */
  private lobbyPicking = false;
  private lobbyQr: { link: string; svg: string } | null = null;
  /** the name and colour sheet, and what happens with its answer */
  private sheet: { view: ProfileSheetView; done: (p: Profile | null) => void } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** the in-page bot of the room this page is in (dev and test builds) */
  private autoplayer: Autoplay | null = null;

  constructor(
    private readonly app: RoomAppHost,
    private readonly endpoint: RoomsEndpoint,
  ) {
    this.roomsApi = new RoomsApi({ base: endpoint.api });
  }

  /** the name sheet's view while it is open */
  get sheetView(): ProfileSheetView | null {
    return this.sheet?.view ?? null;
  }

  /** the automation handle of the room this page is in (e2e-mp specs, debugging) */
  get handle(): RoomHandle | null {
    const l = this.link;
    if (!l) return null;
    const c = l.client;
    return {
      code: l.code,
      status: c.status,
      phase: c.phase,
      seat: c.seat,
      pid: c.pid,
      host: c.host,
      run: c.run,
      n: c.n,
      state: () => c.state,
      hash: () => (c.state ? hashState(c.state) : null),
      chat: () => l.chat.lines.map((x) => ({ seat: x.seat, name: x.name, text: x.text })),
      bubbles: () => this.roomUi?.bubbles() ?? [],
      npcBubbles: () => this.roomUi?.npcBubbles() ?? [],
      onScreen: (seat) => !!this.roomUi?.onScreen(seat),
      roster: () => c.roster.map((r) => ({ seat: r.seat, name: r.name, colour: r.colour, host: r.host, ready: r.ready, pid: r.pid, presence: r.presence })),
      session: this.roomSession,
      link: l,
      autoplay: (on, opts) => this.setAutoplay(l, on, opts),
      autoplayStats: () => (this.link === l ? (this.autoplayer?.snapshot() ?? null) : null),
    };
  }

  private async setAutoplay(link: RoomLink, on: boolean, opts?: AutoplayOptions): Promise<void> {
    if (typeof __ANYWORLD_AUTOPLAY__ === 'undefined' || !__ANYWORLD_AUTOPLAY__) throw new Error('autoplay is only in dev and test builds');
    if (!this.autoplayer && !on) return;
    if (!this.autoplayer) {
      const { Autoplay } = await import('./autoplay');
      if (this.link !== link) return;
      this.autoplayer ??= new Autoplay(
        {
          client: link.client,
          live: () => {
            const session = this.roomLive;
            const controller = this.app.controller;
            return session && controller?.session === session ? { session, controller } : null;
          },
          say: (text) => {
            if (!this.roomUi) return false;
            this.roomUi.say(text);
            return true;
          },
        },
        opts,
      );
    }
    this.autoplayer.set(on);
  }

  roomsCardView(): RoomsCardView {
    const mine = new Set(seatCodes(Date.now()));
    return {
      status: this.roomsCard.status,
      rooms: this.roomsCard.rooms.map((r) => ({
        code: r.code,
        title: r.world.title,
        genre: r.world.genre,
        players: r.players,
        maxPlayers: r.maxPlayers,
        phase: r.phase,
        joinable: r.joinable,
        rejoin: mine.has(r.code),
      })),
      busy: this.roomBusy,
    };
  }

  /** asks the server for its version and the open rooms (start page) */
  async refreshRooms(): Promise<void> {
    const api = this.roomsApi;
    const health = await api.health();
    if (!health.ok) this.roomsCard = { status: health.kind === 'outdated' ? 'outdated' : 'unavailable', rooms: [] };
    else {
      const list = await api.listRooms();
      this.roomsCard = list.ok ? { status: 'ok', rooms: list.value.rooms } : { status: list.kind === 'outdated' ? 'outdated' : 'unavailable', rooms: [] };
    }
    if (this.app.screen === 'start' && !this.link) this.app.render();
  }

  onRoom(i: RoomIntent): void {
    const c = this.link?.client;
    switch (i.type) {
      case 'refresh':
        void this.refreshRooms();
        return;
      case 'create':
        void this.createRoom(i.worldId);
        return;
      case 'join':
        void this.joinRoom(i.code);
        return;
      case 'profile':
      case 'profile_cancel': {
        const sh = this.sheet;
        this.sheet = null;
        this.link?.setMenu('profile', false);
        const p = i.type === 'profile' ? this.cleanProfile(i.name, i.colour) : null;
        if (p) saveProfile(p);
        sh?.done(p);
        this.app.render();
        return;
      }
      case 'change_profile':
        void this.askProfile('change').then((p) => {
          if (p && this.link && !this.link.setProfile(p)) this.app.ui.toast(t('room.offline'), 'warn');
        });
        return;
      case 'ready':
        c?.ready(i.on);
        return;
      case 'start':
        this.lobbyPicking = false;
        c?.start();
        return;
      case 'world':
        this.lobbyPicking = false;
        void this.pickRoomWorld(i.id);
        this.app.render();
        return;
      case 'pick_world':
        this.lobbyPicking = i.open;
        // (the end screen's "Choose another world" opens the lobby's picker)
        if (i.open && this.app.screen === 'game') {
          this.app.screen = 'lobby';
          this.app.canvasHost.hidden = true;
        }
        this.app.render();
        return;
      case 'options':
        this.setRoomOptions(i.options);
        return;
      case 'share':
        void this.shareRoom();
        return;
      case 'leave':
        this.leaveRoom();
        return;
      case 'reload':
        location.reload();
        return;
      case 'chat':
        this.roomUi?.openChat();
        return;
      case 'follow':
        this.roomUi?.follow(i.dir);
        return;
    }
  }

  private cleanProfile(name: string, colour: string): Profile | null {
    const colours: readonly string[] = PLAYER_COLOURS;
    const c = colours.includes(colour) ? (colour as PlayerColour) : null;
    const n = name.trim();
    return c && n ? { name: n, colour: c } : null;
  }

  /** the name and colour sheet; resolves with the answer (null: cancelled) */
  private askProfile(purpose: ProfileSheetView['purpose']): Promise<Profile | null> {
    this.sheet?.done(null);
    const p = (purpose === 'change' ? this.link?.asked : null) ?? loadProfile() ?? defaultProfile();
    const c = this.link?.client;
    const taken = c ? c.roster.filter((r) => r.seat !== c.seat).map((r) => r.colour) : [];
    return new Promise((resolve) => {
      this.sheet = {
        view: { name: p.name, colour: p.colour, colours: PLAYER_COLOURS.map((value) => ({ value, label: colourName(value) })), taken, purpose },
        done: resolve,
      };
      this.link?.setMenu('profile', true);
      this.app.render();
    });
  }

  /** the stored profile, or the sheet's answer the first time */
  private async ensureProfile(purpose: 'create' | 'join'): Promise<Profile | null> {
    return loadProfile() ?? (await this.askProfile(purpose));
  }

  /** a failed rooms call: the toast that says why */
  private roomError(r: Exclude<ApiResult<unknown>, { ok: true }>): void {
    if (r.kind === 'outdated') return this.reloadToast();
    if (r.kind === 'unavailable') return this.app.ui.toast(t('room.unavailable'), 'warn');
    const key: MessageKey =
      r.code === 'server_full' ? 'net.serverFull' : r.code === 'rate_limit' ? 'room.tooMany' : r.code === 'no_room' ? 'net.noRoom' : r.code === 'invalid_world' ? 'room.worldInvalid' : 'room.notAllowed';
    this.app.ui.toast(t(key, { error: r.message.replace(/^Invalid world:\s*/, '') }), 'warn');
  }

  private reloadToast(): void {
    this.app.ui.toast(t('net.outdated'), 'warn', { label: t('net.reload'), run: () => location.reload(), sticky: true });
  }

  /** a demo world (the default: the first one in the UI language) or one of "Your worlds" for a new room */
  private async roomWorldRequest(worldId?: string): Promise<{ demo: string } | { world: unknown } | null> {
    const demos = this.app.startView().demos;
    const id = worldId ?? demos[0]?.id;
    if (!id) return null;
    if (worldIndex().some((w) => w.id === id)) return { demo: id };
    const entry = await loadWorld(id);
    return entry ? { world: entry.world } : null;
  }

  /** "Create a room" / "Play with friends": a room with the default options, joined at once as its host */
  async createRoom(worldId?: string): Promise<boolean> {
    const api = this.roomsApi;
    if (this.roomBusy) return false;
    const profile = await this.ensureProfile('create');
    if (!profile) return false;
    const req = await this.roomWorldRequest(worldId);
    if (!req) {
      this.app.ui.toast(t('app.noWorld', { id: worldId ?? '' }), 'warn');
      return false;
    }
    this.roomBusy = t('room.creating');
    this.app.render();
    const r = await api.createRoom({ ...req, options: { difficulty: this.app.runOptions.difficulty } } as Parameters<RoomsApi['createRoom']>[0]);
    this.roomBusy = null;
    if (!r.ok) {
      this.roomError(r);
      this.app.render();
      return false;
    }
    saveSeat(r.value.code, r.value.token, Date.now());
    await this.openRoom(r.value.code, profile, r.value.token);
    return true;
  }

  /** joins a room by its code (the card, a room row, a ?room= link): the stored seat or profile, else the sheet */
  async joinRoom(code: string): Promise<boolean> {
    const api = this.roomsApi;
    if (this.roomBusy) return false;
    this.roomBusy = t('room.joining', { code });
    this.app.render();
    const info = await api.getRoom(code);
    if (!info.ok) {
      this.roomBusy = null;
      if (info.kind === 'refused' && info.code === 'no_room') this.app.showStart(t('net.noRoom'));
      else {
        this.roomError(info);
        this.app.render();
      }
      return false;
    }
    const token = seatToken(code, Date.now());
    const profile = token ? (loadProfile() ?? defaultProfile()) : await this.ensureProfile('join');
    if (!profile) {
      this.roomBusy = null;
      this.app.render();
      return false;
    }
    await this.openRoom(code, profile, token);
    return true;
  }

  private async openRoom(code: string, profile: Profile, token: string | null): Promise<void> {
    this.closeRoom();
    this.roomBusy = t('room.joining', { code });
    const link = new RoomLink({ code, url: this.endpoint.ws, profile, token });
    this.link = link;
    this.roomUi = new RoomUi(link, this.app.ui);
    link.on((e) => this.onLink(link, e));
    setAddress(`${location.pathname}?room=${encodeURIComponent(code)}`);
    this.app.render();
    link.connect();
  }

  private onLink(link: RoomLink, e: LinkEvent): void {
    if (link !== this.link) return;
    switch (e.t) {
      case 'welcome': {
        this.roomBusy = null;
        const c = link.client;
        if (e.renamed) {
          const text = t('lobby.youAre', { name: e.renamed.name, colour: colourName(e.renamed.colour) });
          // (a new name and colour can be asked for in the lobby or after a run only)
          if (c.phase === 'playing') this.app.ui.toast(text, 'info');
          else this.app.ui.toast(text, 'info', { label: t('lobby.change'), run: () => this.onRoom({ type: 'change_profile' }) });
        }
        this.syncRoomScreen();
        return;
      }
      case 'run':
        this.lobbyPicking = false;
        this.startRoomRun();
        return;
      case 'end':
        this.app.showStart(t(e.key));
        return;
      case 'reload':
        this.reloadToast();
        return;
      case 'toast':
        this.app.ui.toast(t(e.key), e.tone);
        return;
      case 'status':
        if (e.status === 'reconnecting' && !this.reconnectTimer) {
          // the banner offers "Leave room" once the reconnect has taken a while
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.app.render();
          }, RECONNECT_LEAVE_MS + 50);
        }
        this.app.render();
        return;
      case 'changed':
      case 'chat':
        // (the end screen of a finished run shows the roster's ready count)
        if (this.app.screen !== 'game' || this.app.controller?.session.ended) this.app.render();
        return;
    }
  }

  /** after a welcome: the screen of the room's phase (lobby, the run, or the end of the last run) */
  private syncRoomScreen(): void {
    const c = this.link!.client;
    if (c.phase === 'playing' && c.state && c.pid && c.world) {
      // (a reconnect into the same run: the session has rebuilt itself on the state event)
      if (!this.roomSession || this.roomSession.run !== c.run) this.startRoomRun();
      else this.app.render();
      return;
    }
    // the run this page played has ended: its end screen stays (with the room block)
    if (c.phase === 'ended' && this.roomSession?.run === c.run && this.app.screen === 'game') return this.app.render();
    this.disposeRoomRun();
    this.app.screen = 'lobby';
    this.app.canvasHost.hidden = true;
    this.app.render();
    document.body.dataset.ready = '1';
  }

  /** a new run in the room (a playing welcome, or `run`): a new session at once, the controller when the renderer is there */
  private startRoomRun(): void {
    const link = this.link;
    const c = link?.client;
    if (!link || !c?.state || !c.pid || !c.world) {
      this.syncRoomScreenIdle();
      return;
    }
    this.disposeRoomRun();
    const session = new RoomSession({ client: c, prefs: this.app.prefs() });
    this.roomSession = session;
    this.roomBuffered = [];
    this.roomDetach = session.attach((out) => {
      if (this.roomSession !== session) return;
      if (this.roomLive === session && this.app.controller?.session === session) this.app.controller.applyRemote(out);
      else this.roomBuffered.push(out);
    });
    void this.launchRoom(link, session);
  }

  private syncRoomScreenIdle(): void {
    this.disposeRoomRun();
    this.app.screen = 'lobby';
    this.app.canvasHost.hidden = true;
    this.app.render();
  }

  private async launchRoom(link: RoomLink, session: RoomSession): Promise<void> {
    const entry = roomWorldEntry(session.world, session.worldId, worldIndex());
    const renderer = await this.app.ensureRenderer();
    if (this.roomSession !== session || this.link !== link) return;
    this.app.controller?.dispose();
    this.app.canvasHost.hidden = false;
    this.app.screen = 'game';
    const host = this.app;
    session.audioListener = (u) => this.app.audio.update(u);
    const controller = new GameController(session, {
      dialogue: null,
      get ui() {
        return host.ui;
      },
      renderer,
      canvasHost: this.app.canvasHost,
      extraVm: () => ({ settings: this.app.settingsView(), language: this.app.languageView(), room: this.roomView(), ...(this.sheet ? { profileSheet: this.sheet.view } : {}) }),
      onEnded: () => this.app.render(),
      room: link,
    });
    this.app.controller = controller;
    void this.app.audio.startRun(entry.world, session.state.area.index);
    await controller.start();
    if (this.roomSession !== session || this.app.controller !== controller) return;
    this.roomLive = session;
    this.roomUi?.attachRun({ session, controller, renderer, canvasHost: this.app.canvasHost });
    // what arrived while the renderer loaded: the controller already started from the session's state
    const held = this.roomBuffered.splice(0);
    if (held.length) controller.applyRemote(held.reduce((a, b) => merge(a, b), emptyOutcome()));
    document.body.dataset.ready = '1';
  }

  private disposeRoomRun(): void {
    this.roomUi?.detachRun();
    this.roomDetach?.();
    this.roomDetach = null;
    this.roomSession = null;
    this.roomLive = null;
    this.roomBuffered = [];
    if (this.link) {
      this.app.controller?.dispose();
      this.app.controller = null;
    }
  }

  /** forgets the room on this page (the link stops; the seat token stays for a rejoin) */
  closeRoom(): void {
    if (!this.link) return;
    this.disposeRoomRun();
    this.roomUi?.dispose();
    this.roomUi = null;
    this.link.dispose();
    this.link = null;
    this.lobbyPicking = false;
    this.lobbyQr = null;
    this.roomBusy = null;
    this.sheet?.done(null);
    this.sheet = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.autoplayer?.dispose();
    this.autoplayer = null;
    this.app.audio.stopRun();
  }

  /** "Leave room": the seat is given up (no character in the next run); the single-player save is untouched */
  leaveRoom(): void {
    this.link?.leave();
    this.app.showStart();
  }

  roomView(): RoomView | null {
    const l = this.link;
    if (!l) return null;
    const c = l.client;
    const me = c.roster.find((r) => r.seat === c.seat);
    const since = l.reconnectingSince;
    return {
      code: l.code,
      phase: c.phase ?? 'lobby',
      host: c.host,
      ready: !!me?.ready,
      readyCount: c.roster.filter((r) => r.ready).length,
      total: c.roster.length,
      reconnecting: c.status === 'reconnecting',
      canLeave: since !== null && Date.now() - since >= RECONNECT_LEAVE_MS,
    };
  }

  /** the lobby screen, or the end screen of the room's last run when this page joined after it ended */
  lobbyVm(): UiViewModel {
    const l = this.link!;
    const c = l.client;
    const base = {
      theme: { palette: DEFAULT_PALETTE, vocabulary: defaultVocabulary() },
      settings: this.app.settingsView(),
      prefs: this.app.prefs(),
      language: this.app.languageView(),
      room: this.roomView(),
      ...(this.sheet ? { profileSheet: this.sheet.view } : {}),
    };
    if (c.phase === 'ended' && !this.lobbyPicking && c.state && c.world && c.state.status !== 'playing') {
      return { ...base, screen: 'end', end: endView(c.world, c.state) };
    }
    if (!c.room || !c.options || !c.seat) {
      // (not joined yet: the start page with the card's "Joining room…")
      return { ...base, screen: 'start', start: this.app.startView() };
    }
    return { ...base, screen: 'lobby', lobby: this.lobbyView() };
  }

  private lobbyView(): LobbyView {
    const l = this.link!;
    const c = l.client;
    const info = c.room!;
    const link = roomLink(location, l.code);
    const start = this.app.startView();
    const demo = worldIndex().find((w) => w.meta.title === info.world.title && (w.meta.language || 'en') === (info.world.language || 'en'));
    if (this.lobbyQr?.link !== link) {
      void import('./qr').then((m) => {
        if (this.link !== l) return;
        this.lobbyQr = { link, svg: m.qrSvg(link, link) };
        this.app.render();
      });
    }
    const o = c.options!;
    return {
      code: l.code,
      link,
      qr: this.lobbyQr?.link === link ? this.lobbyQr.svg : null,
      world: { title: info.world.title, genre: info.world.genre, tagline: demo?.meta.tagline ?? '', ...(demo?.color ? { color: demo.color } : {}) },
      phase: c.phase ?? 'lobby',
      you: { seat: c.seat!, host: c.host, ready: !!c.roster.find((r) => r.seat === c.seat)?.ready },
      roster: c.roster.map((r) => ({ seat: r.seat, name: r.name, colour: r.colour, host: r.host, ready: r.ready, presence: r.presence, you: r.seat === c.seat })),
      readyCount: c.roster.filter((r) => r.ready).length,
      options: { maxPlayers: o.maxPlayers, deadlineMs: o.deadlineMs, difficulty: o.difficulty },
      limits: { maxPlayers: { ...LIMITS.maxPlayers }, deadlineMs: { ...LIMITS.deadlineMs } },
      gm: info.gm ?? null,
      ...(c.host ? { host: { worlds: start.demos, own: start.recent ?? [], picking: this.lobbyPicking } } : {}),
    };
  }

  /** host: the next run's world (a demo by id, a world kept in this browser by upload) */
  private async pickRoomWorld(id: string): Promise<void> {
    const l = this.link;
    if (!l || !this.roomsApi) return;
    if (worldIndex().some((w) => w.id === id)) {
      l.client.pickWorld(id);
      return;
    }
    const entry = await loadWorld(id);
    const token = l.client.token;
    if (!entry || !token) return;
    const r = await this.roomsApi.uploadWorld(l.code, token, entry.world);
    if (!r.ok) this.roomError(r);
  }

  private setRoomOptions(o: Partial<RoomOptionsView>): void {
    this.link?.client.setOptions(o);
  }

  /** Share (phones: the system sheet) or Copy link */
  private async shareRoom(): Promise<void> {
    const l = this.link;
    if (!l) return;
    const url = roomLink(location, l.code);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ url, title: t('lobby.title', { code: l.code }) });
        return;
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.app.ui.toast(t('room.linkCopied'), 'info');
    } catch {
      // no clipboard (insecure origin, denied): the link is shown in the lobby to copy by hand
      this.app.ui.toast(url, 'info');
    }
  }
}

function setAddress(url: string): void {
  try {
    const next = new URL(url, location.href);
    if (next.href !== location.href) history.replaceState(history.state, '', next.href);
  } catch {
    /* history can be unavailable (sandboxed frames) */
  }
}
