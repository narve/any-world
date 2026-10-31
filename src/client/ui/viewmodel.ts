/**
 * UI-facing view model + callbacks — the contract between the overlay UI (src/client/ui) and the
 * game controller (integrator). The controller builds a `UiViewModel` from GameState, the world spec
 * and the engine's describe functions (describeItem / describeActor), then calls `ui.render(vm)`.
 * The UI never reads GameState directly and never mutates anything: it only emits callbacks.
 *
 * All player-facing words come from the world (vocabulary, names); the UI only adds neutral
 * verbs such as "Use", "Drop", "Leave".
 */
import type { Vocabulary } from '../../schema/world';
import type { ActorView, Dir, ItemView, LogMessage, PlayerAction, Pos } from '../../engine/types';
import type { ProviderConfig, ProviderPreset } from '../../llm/types';

export type { Vocabulary, ItemView, ActorView, LogMessage, PlayerAction, Pos, Dir, ProviderPreset, ProviderConfig };

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** world.palette (or DEFAULT_PALETTE before a world exists). */
export interface PaletteView {
  primary: string;
  secondary: string;
  accent: string;
  danger: string;
  ui: string;
  text: string;
}

export interface ThemeView {
  palette: PaletteView;
  vocabulary: Vocabulary;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

export type CoreStatKey = 'str' | 'dex' | 'int' | 'ac';

export interface StatLineView {
  key: CoreStatKey;
  /** current value including modifiers */
  value: number;
  /** base value; when different, the UI shows a +/- hint */
  base: number;
}

export interface BarView {
  /** 'hp' | 'mp' | 'xp' | custom resource id */
  id: string;
  label: string;
  abbr?: string;
  description?: string;
  value: number;
  max: number;
  color: string;
  /** below the danger threshold: the bar pulses in the warn colour and shows its full name */
  low?: boolean;
}

/**
 * A vital that is low or empty (HP under 30 %, a resource under 25 %): the HUD warns, a screen-edge
 * vignette appears while it drains health, and hotbar items that restore it glow.
 */
export interface DangerView {
  /** 'hp' or a custom resource id */
  id: string;
  label: string;
  color: string;
  level: 'low' | 'empty';
  /** losing health because of it (an empty resource with harmful onEmpty, or HP itself) */
  draining: boolean;
  /** quick slot (0-based) holding an item that restores it, if any */
  slot?: number;
}

export interface StatusChipView {
  id: string;
  name: string;
  description: string;
  harmful: boolean;
  color: string;
  turnsLeft: number;
}

export interface HudView {
  playerName: string;
  playerTitle: string;
  /** player model colour, used for the portrait dot */
  playerColor?: string;
  stats: StatLineView[];
  hp: { value: number; max: number };
  /** null when the world has no MP (max 0) */
  mp: { value: number; max: number } | null;
  /** custom resources (world.resources), at most 2 */
  resources: BarView[];
  level: number;
  /** xp gathered since the current level began, and needed for the next */
  xpInLevel: number;
  xpForLevel: number;
  /** level-ups already earned but held back until the open perk choice is made */
  pendingLevels?: number;
  currency: number;
  statuses: StatusChipView[];
  areaName: string;
  /** 0-based */
  areaIndex: number;
  areaCount: number;
  turn: number;
  sneaking: boolean;
  /** derived from speed: shown as a chip, never as a number */
  speed: 'fast' | 'normal' | 'slow';
  /** low/empty vitals, most urgent first (empty = none) */
  danger?: DangerView[];
}

// ---------------------------------------------------------------------------
// Items & slots
// ---------------------------------------------------------------------------

/** an item in a generic slot: the engine's ItemView plus slot-level runtime data. */
export interface SlotItemView extends ItemView {
  instanceId: string;
  defId: string;
  stackable: boolean;
  maxCharges?: number;
  /** turns left before it can be used again */
  cooldown?: number;
  maxCooldown?: number;
  /** which equipment slot it fits, if any */
  equipSlot?: 'weapon' | 'armour' | 'trinket';
  durability?: number;
  maxDurability?: number;
  /** activating it needs a target tile/actor (the integrator runs targeting) */
  needsTarget?: boolean;
  /** it is aimed by direction (ray / cone): targeting picks one of eight directions */
  aimsDirection?: boolean;
  /** optional custom glyph (single character); default is the name's initial or '?' */
  glyph?: string;
  /** rarity hint for border colour */
  rarity?: 'common' | 'uncommon' | 'rare' | 'unique';
  /** rendered thumbnail (data URL) of the item's model; never set for unknown items */
  thumb?: string;
  /** vitals this item is known to restore ('hp', 'mp' or a resource id) */
  restores?: string[];
  /** a ranged weapon's reach in tiles (only set when > 1): equipped, its key aims it */
  range?: number;
  /** glow + hint: the item answers a current danger ("press 3") */
  urgent?: boolean;
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

export interface NarrationView {
  /** stable id; dismiss callbacks receive it */
  id: string;
  kind: 'intro' | 'area_enter' | 'event' | 'epitaph';
  /** e.g. world title or area name */
  title?: string;
  /** e.g. the GM persona name or an NPC */
  speaker?: string;
  text: string;
}

export interface DialogueView {
  npcId: string;
  npcName: string;
  npcTitle?: string;
  portraitColor: string;
  /** the NPC's current line; empty while `pending` */
  reply: string;
  /** player reply options (max 3) */
  options: string[];
  /** waiting for the GM to answer */
  pending: boolean;
  /** show a persuade button (verbs.persuade) */
  canPersuade?: boolean;
  /** show a trade button (trader NPCs) */
  canTrade?: boolean;
  /** last few exchanges, oldest first */
  history?: { who: 'npc' | 'player'; text: string }[];
}

export interface ChoiceView {
  prompt: string;
  speaker?: string;
  options: { label: string }[];
}

export interface PerkView {
  id: string;
  name: string;
  description: string;
  /** readable modifier lines, e.g. "+2 Draw" */
  lines?: string[];
}

export interface LevelUpView {
  level: number;
  perks: PerkView[];
}

export interface TradeOfferView {
  item: ItemView;
  price: number;
}

export interface TradeSellView {
  slot: number;
  item: SlotItemView;
  price: number;
}

export interface TradeView {
  traderId: string;
  traderName: string;
  traderColor: string;
  greeting?: string;
  currency: number;
  offers: TradeOfferView[];
  sellable: TradeSellView[];
}

export interface RuleView {
  id: string;
  name: string;
  description: string;
  /** "from the start", "Deck 2, turn 140" */
  since?: string;
  /** introduced by the GM during play */
  fromGm?: boolean;
  /** the GM's in-story announcement */
  reason?: string;
  /** added recently: highlighted until seen */
  isNew?: boolean;
}

export interface QuestView {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'done' | 'failed';
}

/**
 * One line of a condition rendered in plain words (goal tracker, onboarding, locked exits).
 * Groups ("One of these:") are lines too; their parts follow with depth + 1.
 */
export interface ConditionLineView {
  text: string;
  /** nesting level, 0 = top */
  depth: number;
  /** a heading for the lines under it ("One of these:"), not a requirement itself */
  group?: boolean;
  /** already true now (✓), not yet (false), or not knowable / not applicable (null) */
  done?: boolean | null;
  /** current progress in plain words ("now 1") */
  now?: string;
}

/** the concrete next thing to do, always shown under the goal */
export interface GoalStepView {
  kind: 'quest' | 'unlock' | 'exit' | 'explore' | 'final';
  text: string;
  /** second line ("Needed for: Walk home along the levee") */
  detail?: string;
}

/** goal tracker: compact (summary + step), expands on tap into the full conditions */
export interface GoalView {
  summary: string;
  step: GoalStepView;
  /** the win condition in plain words */
  win: ConditionLineView[];
  /** ways to lose: always "your <health> reaches 0" first, then the world's lose condition */
  lose: ConditionLineView[];
  /** what this area's way on needs (absent when it is open or this is the last area) */
  exitNeeds?: { way: string; lines: ConditionLineView[] } | null;
  /** "Day 1 of 3" */
  progress: string;
}

/** a contextual action button (touch-first): appears when relevant and doubles as a key hint */
export interface ContextActionView {
  id: 'exit' | 'pickup' | 'talk' | 'persuade' | 'interact' | 'search' | 'sneak' | 'wait';
  label: string;
  /** the keyboard key that does the same ('>', 'g', 't', 'Enter', 'f', 'c', '.') */
  key: string;
  /** can't be done yet: tapping it explains why (locked exit) instead of acting */
  blocked?: string;
  /** the important one right now (unlocked exit, something underfoot, someone to talk to) */
  primary?: boolean;
  /** always-available verbs are drawn smaller */
  secondary?: boolean;
  /** glows: the move that answers a current danger (the way on, open underfoot, at low health) */
  urgent?: boolean;
}

/** first-run onboarding card for one world (after the prologue) */
export interface OnboardingView {
  worldId: string;
  worldTitle: string;
  /** how to win: the goal summary, plus its conditions in plain words */
  goal: string;
  win: ConditionLineView[];
  /** how conflict works in this world, in plain words (from world data) */
  conflict: string[];
  /** the key for each `conflict` line that is a verb ('p' persuade, 't' talk…), else null */
  conflictKeys?: (string | null)[];
  /** how the run is lost */
  lose: string[];
  verbs: { talk: boolean; sneak: boolean; search: boolean; persuade: boolean };
}

/** actor tooltip on hover / look mode */
export interface ActorTooltipView extends ActorView {
  id: string;
  color?: string;
  /** status chips when known; ActorView.statuses names are used otherwise */
  statusChips?: StatusChipView[];
}

/** tile description for look mode / hover over terrain */
export interface TileTooltipView {
  title: string;
  description?: string;
  /** items lying here */
  items?: string[];
  /** the tile can be used (walk into it, click it or press Enter next to it), or is used up */
  usable?: 'usable' | 'used';
}

export interface GameView {
  hud: HudView;
  log: LogMessage[];
  /** length TOTAL_SLOTS (28): 0..7 quick, 8..27 backpack */
  slots: (SlotItemView | null)[];
  narration: NarrationView | null;
  dialogue: DialogueView | null;
  choice: ChoiceView | null;
  levelUp: LevelUpView | null;
  trade: TradeView | null;
  rules: RuleView[];
  quests: QuestView[];
  verbs: { talk: boolean; sneak: boolean; search: boolean; persuade: boolean };
  /** what moving on is called in this area ("Board the 6:15 train") */
  transitionName: string;
  /** the player stands on the exit and it is unlocked */
  canTransition: boolean;
  /** the world's goal summary */
  goalSummary?: string;
  /** 'look' while look mode is on; 'target' while picking a target for `targetingSlot` */
  mode: 'normal' | 'look' | 'target';
  targetingSlot?: number;
  /** busy indicator (e.g. waiting for the GM) */
  busy?: string | null;
  /** one-line objective under the area banner ("Find the way out of Main Street") */
  objective?: string;
  /** where to go next in this area; shown on its own line under `objective`, never truncated */
  objectiveHint?: string | null;
  /** an adjacent tile that can be used (Enter / click); the context bar shows it as a button */
  interactHint?: string | null;
  /** goal tracker (always visible, expands on tap) */
  goal?: GoalView;
  /** context action bar: buttons that appear when relevant and double as key hints */
  actions?: ContextActionView[];
  /** first-run onboarding card for this world (null hides it) */
  onboarding?: OnboardingView | null;
}

// ---------------------------------------------------------------------------
// Start / loading / end / settings
// ---------------------------------------------------------------------------

export interface InspirationPrompt {
  prompt: string;
  genre: string;
  tags?: string[];
  teaser?: string;
  /** BCP-47 language of the prompt (and of the world it asks for); default "en" */
  language?: string;
  /** id of a recorded world that plays in demo mode */
  worldId?: string;
}

export interface DemoWorldView {
  id: string;
  title: string;
  tagline: string;
  genre: string;
  color?: string;
  /** BCP-47 language of the world's text; the start screen groups demos by it (default "en") */
  language?: string;
}

export interface SavedRunView {
  worldTitle: string;
  playerName: string;
  areaName: string;
  turn: number;
}

export interface StartView {
  prompts: InspirationPrompt[];
  demos: DemoWorldView[];
  savedRun: SavedRunView | null;
  /** short "Provider: Claude (backend)" line; null hides it */
  providerLabel?: string | null;
  /** false when no LLM is configured: create buttons show a hint and open settings */
  canGenerate: boolean;
  defaults?: { prompt?: string; difficulty?: Difficulty; weirdness?: number; /** "For a party" on, for this many players (a room's maxPlayers) */ party?: number };
  /** M4: one status line about the AI provider (replaces providerLabel when present) */
  providerStatus?: ProviderStatusView;
  /** M4: worlds kept in this browser (AI-made or imported), newest first */
  recent?: RecentWorldView[];
  /** M4: true when a world file can be imported (onImportWorld is wired) */
  canImport?: boolean;
  /** MP3: the "Play together" card (absent: this build has no game server) */
  rooms?: RoomsCardView;
  /** the demo worlds shown big at the top of the start page, in order (ids in `demos`; unknown ids are skipped) */
  featured?: string[];
}

// ---------------------------------------------------------------------------
// Rooms (MP3)
// ---------------------------------------------------------------------------

export type RoomPhase = 'lobby' | 'playing' | 'ended';

/** one open room on the start page */
export interface RoomRowView {
  code: string;
  title: string;
  genre: string;
  players: number;
  maxPlayers: number;
  phase: RoomPhase;
  joinable: boolean;
  /** this browser holds a seat there */
  rejoin: boolean;
}

/** the start page's "Play together" card */
export interface RoomsCardView {
  /** ok: the list; unavailable: the server is offline; outdated: this page is older than the server */
  status: 'loading' | 'ok' | 'unavailable' | 'outdated';
  rooms: RoomRowView[];
  /** a create or join is under way ("Joining room K7QX…") */
  busy?: string | null;
}

/** the name and colour sheet (first create or join, and "Change" in a room) */
export interface ProfileSheetView {
  name: string;
  colour: string;
  /** every player colour, with its name */
  colours: { value: string; label: string }[];
  /** colours other seats hold (dimmed) */
  taken: string[];
  purpose: 'create' | 'join' | 'change';
}

export interface RoomRosterView {
  seat: string;
  name: string;
  colour: string;
  host: boolean;
  ready: boolean;
  /** the server's seat presence (active, busy, menu, idle, off, gone) */
  presence: string;
  you: boolean;
}

export interface RoomOptionsView {
  maxPlayers: number;
  deadlineMs: number;
  difficulty: Difficulty;
}

/** the lobby screen (screen: 'lobby') */
export interface LobbyView {
  code: string;
  /** the share link (the page's own origin) */
  link: string;
  /** the QR code's SVG markup (made lazily; null until then) */
  qr: string | null;
  world: { title: string; genre: string; tagline: string; color?: string };
  phase: RoomPhase;
  you: { seat: string; host: boolean; ready: boolean };
  roster: RoomRosterView[];
  readyCount: number;
  options: RoomOptionsView;
  limits: { maxPlayers: { min: number; max: number }; deadlineMs: { min: number; max: number } };
  /** the room's game master (RoomInfo.gm, MP4): the "reads the chat" line shows only for the AI GM */
  gm: 'ai' | 'recorded' | 'offline' | null;
  /** the host's world picker (open while `picking`) */
  host?: { worlds: DemoWorldView[]; own: RecentWorldView[]; picking: boolean };
}

/** the room around a run: the end screen's room block, the in-game "Leave room", the reconnect banner */
export interface RoomView {
  code: string;
  phase: RoomPhase;
  host: boolean;
  ready: boolean;
  readyCount: number;
  total: number;
  /** this client lost its connection and is trying again */
  reconnecting: boolean;
  /** reconnecting for a while: the banner offers "Leave room" */
  canLeave: boolean;
}

/** what the rooms UI asks the app to do */
export type RoomIntent =
  | { type: 'refresh' }
  /** a new room on `worldId` (a demo or a world kept in this browser; absent: the default demo) */
  | { type: 'create'; worldId?: string }
  | { type: 'join'; code: string }
  | { type: 'profile'; name: string; colour: string }
  | { type: 'profile_cancel' }
  | { type: 'change_profile' }
  | { type: 'ready'; on: boolean }
  /** host: start the run (or play again) */
  | { type: 'start' }
  /** host: the next run's world (a demo id, or a world kept in this browser) */
  | { type: 'world'; id: string }
  /** host: open or close the world picker (the end screen's "Choose another world" opens the lobby with it) */
  | { type: 'pick_world'; open: boolean }
  | { type: 'options'; options: Partial<RoomOptionsView> }
  | { type: 'share' }
  | { type: 'leave' }
  | { type: 'reload' }
  /** Enter / `/`: open the chat input (the phone's sheet) */
  | { type: 'chat' }
  /** `[` / `]`: watch the previous / next teammate while down */
  | { type: 'follow'; dir: -1 | 1 };

/** M4: the start screen's provider status line */
export interface ProviderStatusView {
  /** ok: worlds can be created; demo: no AI (demo worlds only); warn: set up but something is wrong */
  tone: 'ok' | 'demo' | 'warn';
  text: string;
  /** an extra hint (e.g. "the key lives in this browser") */
  detail?: string;
}

/** M4: a world kept in this browser: generated by the AI, or imported from a file */
export interface RecentWorldView {
  id: string;
  title: string;
  tagline: string;
  genre: string;
  color?: string;
  language?: string;
  /** demo: picked from the recorded worlds by the offline demo generator (M5; no AI involved) */
  source: 'generated' | 'imported' | 'demo';
  /** epoch ms */
  savedAt: number;
}

/** M4: a world file the player picked for import */
export interface WorldFileInput {
  name: string;
  text: string;
}

export type Difficulty = 'gentle' | 'normal' | 'hard' | 'brutal';

export interface StartOptions {
  prompt: string;
  difficulty: Difficulty;
  /** 0 (familiar) .. 1 (unhinged) */
  weirdness: number;
  /** true for "Surprise me" (prompt is ignored / empty) */
  surprise: boolean;
  /** language for the generated world when the prompt came from an inspiration card in another language */
  language?: string;
  /** "For a party" (MP4 design §5): a world for a room of this many players (absent: single player) */
  party?: number;
}

export interface LoadingStepView {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
}

export interface LoadingView {
  steps: LoadingStepView[];
  /** shown as soon as the world has a name */
  title?: string;
  tagline?: string;
  genre?: string;
  error?: string | null;
  canCancel?: boolean;
  canRetry?: boolean;
}

export interface RunStatsView {
  turns: number;
  kills: number;
  itemsUsed: number;
  damageDealt: number;
  damageTaken: number;
  areasCleared: number;
  areaCount: number;
  level: number;
}

export interface EndView {
  result: 'won' | 'lost';
  worldTitle: string;
  /** goal.winText / goal.deathText / goal.lossText, by how the run ended (engine endingText) */
  text: string;
  /** engine endReason */
  reason?: string;
  /** GM epitaph / victory narration if available */
  epitaph?: string;
  playerName: string;
  stats: RunStatsView;
  /** the run's settings, shown under the stats */
  difficulty?: Difficulty;
  weirdness?: number;
}

export interface Settings {
  /** the active provider; `provider.apiKey` is the key saved for this preset (and base URL) only */
  provider: ProviderConfig;
  /**
   * direct-mode API keys per provider (storage.keySlot: preset id, plus the base URL when one is
   * set), so a key typed for one host is never sent to another (issues/M5-api-key-leaks-across-presets.md)
   */
  apiKeys?: Record<string, string>;
  /** soundcloud (M4): also look for matching music on SoundCloud (default off); music: the generated music (default on) */
  audio: { volume: number; muted: boolean; soundcloud?: boolean; music?: boolean };
  /** 0.5 (slow) .. 3 (fast); multiplies animation speed */
  animationSpeed: number;
  reduceMotion: boolean;
  /** M4: render quality (renderer.setQuality); default 'auto' */
  quality?: 'auto' | 'low' | 'high';
  /** M4: the AI game master during play (false: offline/recorded GM only, no LLM calls in play); default true */
  gm?: boolean;
  /** MP0: access code for a server that asks for one (ANYWORLD_HOST_CODE); sent as X-AnyWorld-Code */
  accessCode?: string;
}

export interface SettingsView {
  presets: ProviderPreset[];
  current: Settings;
  /** transports this build allows (static builds have no backend) */
  transports?: ('direct' | 'backend')[];
  /** M4: offer the offline "recorded worlds" generator (preset id "mock") in the provider list */
  offlineDemo?: boolean;
  /** M4: what the backend said: null = not asked/unreachable, else the presets it holds keys for */
  serverPresets?: string[] | null;
  /** MP0: the backend asks for an access code before AI calls */
  codeRequired?: boolean;
  /** M4: a run is on: the audio section shows the world's music panel (onMountMusic fills it) */
  music?: boolean;
}

/** UI languages with a catalog (the picker is hidden while there is only one) */
export interface LanguageOptionView {
  code: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Root view model
// ---------------------------------------------------------------------------

export interface UiViewModel {
  screen: 'start' | 'loading' | 'lobby' | 'game' | 'end';
  theme: ThemeView;
  start?: StartView;
  loading?: LoadingView;
  game?: GameView;
  end?: EndView;
  /** MP3: the lobby screen */
  lobby?: LobbyView;
  /** MP3: in a room (the end screen's room block, "Leave room" in game, the reconnect banner) */
  room?: RoomView | null;
  /** MP3: the name and colour sheet, over any screen */
  profileSheet?: ProfileSheetView | null;
  /** settings dialog open when non-null (over any screen) */
  settings?: SettingsView | null;
  /** animation preferences (from Settings), applied to every screen */
  prefs?: { animationSpeed: number; reduceMotion: boolean };
  /** UI language picker (start screen and settings); absent hides it */
  language?: { current: string; options: LanguageOptionView[] };
}

// ---------------------------------------------------------------------------
// Events emitted by the UI
// ---------------------------------------------------------------------------

/** UI-level intents that are not engine actions; the integrator decides what they mean. */
export type UiIntent =
  | { type: 'rotate_camera'; dir: -1 | 1 }
  /** +1 zooms in (closer, the '+' key), -1 zooms out */
  | { type: 'zoom'; delta: -1 | 1 }
  /** look mode on/off (x) */
  | { type: 'look'; on: boolean }
  /** move the look cursor */
  | { type: 'look_move'; dir: Dir }
  /** start targeting with the item in `slot` (items with needsTarget) */
  | { type: 'begin_target'; slot: number }
  /** move the target cursor */
  | { type: 'target_move'; dir: Dir }
  /** confirm the current look/target cursor */
  | { type: 'confirm_cursor' }
  /** cancel targeting / look */
  | { type: 'cancel' }
  /** talk / persuade with an adjacent NPC (integrator picks the target) */
  | { type: 'talk' }
  | { type: 'persuade'; targetId?: string }
  /** mouse: click a tile (travel in normal mode, target in target mode, describe in look mode) */
  | { type: 'click_tile'; pos: Pos; button: 'primary' | 'secondary' }
  /** mouse: hover a tile (null = left the map) */
  | { type: 'hover_tile'; pos: Pos | null }
  /** use an adjacent usable tile (Enter): the integrator picks the tile */
  | { type: 'interact' }
  /** the onboarding card was closed; `forever` = don't show it again for this world */
  | { type: 'dismiss_onboarding'; forever: boolean }
  /** open the onboarding card again (help overlay / goal tracker) */
  | { type: 'show_onboarding' }
  /** open the trade panel from dialogue */
  | { type: 'open_trade'; npcId: string }
  /** the backpack / help / rules panels were opened or closed (pause hints, audio ducks…) */
  | { type: 'panel'; panel: 'backpack' | 'help' | 'rules'; open: boolean };

export type TradeIntent =
  | { type: 'buy'; offerIndex: number }
  | { type: 'sell'; slot: number }
  | { type: 'close' };

export interface UiCallbacks {
  onAction(action: PlayerAction): void;
  onIntent?(intent: UiIntent): void;
  onStart?(opts: StartOptions): void;
  /** play a recorded world; `opts` carries the start screen's difficulty/weirdness */
  onPlayDemo?(worldId: string, opts?: StartOptions): void;
  onContinue?(): void;
  onSettings?(settings: Settings): void;
  /** open/close the settings dialog (the controller sets vm.settings) */
  onOpenSettings?(open: boolean): void;
  /** the hotbar's sound button or the M key: flip the saved mute setting */
  onToggleSound?(): void;
  onDismissNarration?(id: string): void;
  /** player chose dialogue reply `index` (text included for convenience) */
  onDialogueReply?(index: number, text: string): void;
  onDialogueLeave?(): void;
  onTrade?(intent: TradeIntent): void;
  onEnd?(choice: 'new_world' | 'same_world'): void;
  onCancelLoading?(): void;
  onRetryLoading?(): void;
  /** the player picked a UI language */
  onLanguage?(code: string): void;
  /** M4: save a world (bundled or kept in this browser) as a JSON file */
  onExportWorld?(worldId: string): void;
  /** M4: a world file was picked: validate it, keep it and list it under recent worlds */
  onImportWorld?(file: WorldFileInput): void;
  /** M4: drop a world kept in this browser */
  onForgetWorld?(worldId: string): void;
  /** M4: the settings dialog's music slot (SettingsView.music) was rendered: put the panel in it */
  onMountMusic?(host: HTMLElement): void;
  /** MP3: the rooms UI (start page card, lobby, profile sheet, end-screen room block, Leave room) */
  onRoom?(intent: RoomIntent): void;
}
