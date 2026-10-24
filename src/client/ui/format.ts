/**
 * Pure formatting helpers for the UI (no DOM). Everything world-specific comes from the
 * vocabulary; the only fixed words are neutral UI verbs.
 */
import type { Vocabulary } from '../../schema/world';
import type { ActorView, ItemView, LogMessage } from '../../engine/types';
import type { CoreStatKey, Difficulty, RunStatsView, SlotItemView, TradeView } from './viewmodel';
import type { ProviderPreset } from '../../llm/types';

export const UNKNOWN_ITEM_TEXT = 'Unknown — could be anything';

export const DEFAULT_VOCABULARY: Vocabulary = {
  stats: {
    str: { name: 'Strength', abbr: 'STR', description: 'Raw power. Melee damage and carrying.' },
    dex: { name: 'Dexterity', abbr: 'DEX', description: 'Aim, speed of hand, dodging.' },
    int: { name: 'Intelligence', abbr: 'INT', description: 'Ability power and focus.' },
    hp: { name: 'Health', abbr: 'HP', description: 'You are out of the run at 0.' },
    mp: { name: 'Mana', abbr: 'MP', description: 'Spent on abilities; returns slowly.' },
    ac: { name: 'Armour', abbr: 'AC', description: 'Reduces and avoids incoming harm.' },
  },
  conflict: 'Attack',
  defeated: 'defeated',
  xp: 'XP',
  levelUp: 'Level up',
  currency: 'coins',
  lossTitle: 'You have fallen',
  winTitle: 'Victory',
  area: 'Area',
};

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 0..100 fill percentage, safe for max<=0 */
export function pct(value: number, max: number): number {
  if (!(max > 0)) return 0;
  return clamp((value / max) * 100, 0, 100);
}

export function barText(value: number, max: number): string {
  return `${Math.max(0, Math.round(value))} / ${Math.max(0, Math.round(max))}`;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export function statLabel(vocab: Vocabulary, key: CoreStatKey | 'hp' | 'mp'): { name: string; abbr: string; description: string } {
  return vocab.stats[key];
}

/** "Turn 42" → we keep the neutral word "Turn"; areas use vocabulary.area */
export function turnLabel(turn: number): string {
  return `Turn ${turn}`;
}

/** "Stretch 2 / 4 · Dry Creek Flats" */
export function areaLabel(vocab: Vocabulary, index: number, count: number): string {
  return count > 0 ? `${vocab.area} ${index + 1} / ${count}` : `${vocab.area} ${index + 1}`;
}

/** single display character for an item icon; unknown items always show '?' */
export function itemGlyph(item: Pick<ItemView, 'name' | 'knowledge'> & { glyph?: string }): string {
  if (item.knowledge === 'unknown') return '?';
  if (item.glyph && item.glyph.trim()) return Array.from(item.glyph.trim())[0].toUpperCase();
  const words = item.name.replace(/^(the|a|an)\s+/i, '').match(/[\p{L}\p{N}]/u);
  return words ? words[0].toUpperCase() : '•';
}

/** the knowledge-aware description body for an item */
export function knowledgeLines(item: ItemView): { kind: 'exact' | 'vague' | 'unknown'; lines: string[] } {
  if (item.knowledge === 'clear') return { kind: 'exact', lines: item.effectLines.length ? item.effectLines : [] };
  if (item.knowledge === 'vague') return { kind: 'vague', lines: item.vagueText ? [item.vagueText] : [] };
  return { kind: 'unknown', lines: [UNKNOWN_ITEM_TEXT] };
}

export function knowledgeBadge(k: ItemView['knowledge']): string {
  return k === 'clear' ? 'Known' : k === 'vague' ? 'Partly known' : 'Unknown';
}

/** small badge text for stack/charges: "×3", "2/3" */
export function stackText(item: Pick<SlotItemView, 'count' | 'stackable' | 'charges' | 'maxCharges'>): string {
  if (item.charges !== undefined && item.charges !== null) {
    return item.maxCharges ? `${item.charges}/${item.maxCharges}` : `${item.charges}`;
  }
  if (item.count > 1 || (item.stackable && item.count !== 1)) return `×${item.count}`;
  return '';
}

/** cooldown overlay fraction 0..1 (1 = just used) */
export function cooldownFraction(item: Pick<SlotItemView, 'cooldown' | 'maxCooldown'>): number {
  const cd = item.cooldown ?? 0;
  if (cd <= 0) return 0;
  const max = item.maxCooldown && item.maxCooldown > 0 ? item.maxCooldown : cd;
  return clamp(cd / max, 0, 1);
}

export const THREAT_LABEL: Record<ActorView['threat'], string> = {
  trivial: 'Harmless',
  even: 'Even match',
  dangerous: 'Dangerous',
  deadly: 'Deadly',
};

export function threatLabel(t: ActorView['threat']): string {
  return THREAT_LABEL[t] ?? t;
}

export function factionLabel(f: ActorView['faction']): string {
  switch (f) {
    case 'hostile':
      return 'Hostile';
    case 'friendly':
      return 'Friendly';
    case 'neutral':
      return 'Neutral';
    default:
      return 'You';
  }
}

/** css class suffix for a log kind */
export function logKindClass(kind: LogMessage['kind']): string {
  return `log-${kind}`;
}

/** run stats for the end screen, labelled through the vocabulary */
export function runStatLines(s: RunStatsView, vocab: Vocabulary): { label: string; value: string }[] {
  return [
    { label: 'Turns', value: String(s.turns) },
    { label: `${vocab.area} reached`, value: `${Math.min(s.areaCount, s.areasCleared + 1)} / ${s.areaCount}` },
    { label: capitalize(vocab.defeated), value: String(s.kills) },
    { label: 'Items used', value: String(s.itemsUsed) },
    { label: 'Harm dealt', value: String(s.damageDealt) },
    { label: 'Harm taken', value: String(s.damageTaken) },
    { label: `${vocab.xp} level`, value: String(s.level) },
  ];
}

/** typewriter: how many characters of `text` are visible after `elapsedMs` */
export function typewriterCount(text: string, elapsedMs: number, charsPerSecond: number): number {
  if (charsPerSecond <= 0 || !Number.isFinite(charsPerSecond)) return text.length;
  return clamp(Math.floor((elapsedMs / 1000) * charsPerSecond), 0, text.length);
}

/** base typing speed scaled by settings.animationSpeed; reduce motion → instant */
export function typewriterSpeed(animationSpeed: number, reduceMotion: boolean): number {
  if (reduceMotion) return Infinity;
  return 90 * clamp(animationSpeed || 1, 0.25, 4);
}

/** the four difficulty levels, easiest first (StartOptions.difficulty) */
export const DIFFICULTIES: readonly Difficulty[] = ['gentle', 'normal', 'hard', 'brutal'];

const DIFFICULTY_TEXT: Record<Difficulty, { label: string; hint: string }> = {
  gentle: { label: 'Gentle', hint: 'Forgiving. The GM may not add harsh rules without a counterweight.' },
  normal: { label: 'Normal', hint: 'Fair but deadly. Permadeath, as intended.' },
  hard: { label: 'Hard', hint: 'Tougher foes, sharper rules, fewer second chances.' },
  brutal: { label: 'Brutal', hint: 'Everything bites. The GM is allowed to be cruel.' },
};

export function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === 'string' && (DIFFICULTIES as readonly string[]).includes(v);
}

/** label for a difficulty; numbers are slider positions (0..3, out of range clamps) */
export function difficultyLabel(d: Difficulty | number): string {
  return DIFFICULTY_TEXT[toDifficulty(d)].label;
}

export function difficultyHint(d: Difficulty | number): string {
  return DIFFICULTY_TEXT[toDifficulty(d)].hint;
}

/** slider position (0..3) or name → Difficulty ('normal' for anything unreadable) */
export function toDifficulty(d: unknown): Difficulty {
  if (isDifficulty(d)) return d;
  if (typeof d === 'number' && Number.isFinite(d)) return DIFFICULTIES[clamp(Math.round(d), 0, DIFFICULTIES.length - 1)];
  return 'normal';
}

export function weirdnessLabel(w: number): string {
  const v = clamp(w, 0, 1);
  if (v < 0.15) return 'Familiar';
  if (v < 0.4) return 'Off-kilter';
  if (v < 0.65) return 'Strange';
  if (v < 0.85) return 'Uncanny';
  return 'Unhinged';
}

/** deterministic-if-you-want shuffle pick: n distinct entries using `rand` in [0,1) */
export function pickCards<T>(list: readonly T[], n: number, rand: () => number): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, n));
}

/** "Fast"/"Slow" chip text; null for normal */
export function speedLabel(speed: 'fast' | 'normal' | 'slow'): string | null {
  return speed === 'fast' ? 'Fast' : speed === 'slow' ? 'Slow' : null;
}

/** truncate for tooltips */
export function ellipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** pure: notes shown under the provider select */
export function presetNotes(p: ProviderPreset | undefined, transport: 'direct' | 'backend'): { text: string; warn: boolean }[] {
  if (!p) return [{ text: 'Custom OpenAI-compatible endpoint. Enter its base URL and model.', warn: false }];
  const out: { text: string; warn: boolean }[] = [{ text: `Region: ${p.region}`, warn: false }];
  if (!p.cors && transport === 'direct') out.push({ text: 'This provider blocks browser calls (no CORS). Use the backend transport.', warn: true });
  else if (!p.cors) out.push({ text: 'Browser calls are blocked by this provider; the backend proxies them.', warn: false });
  if (transport === 'backend') out.push({ text: 'Backend: the server holds the API key; nothing is sent from this browser.', warn: false });
  else if (p.needsKey) out.push({ text: 'Your API key is stored only in this browser (localStorage).', warn: false });
  if (p.notes) out.push({ text: p.notes, warn: false });
  return out;
}


// ---------------------------------------------------------------------------
// Message log grouping
// ---------------------------------------------------------------------------

/** one displayed log row: a message and how often it repeated */
export interface LogGroup {
  msg: LogMessage;
  count: number;
  firstTurn: number;
  lastTurn: number;
}

/** how many recent rows a repeat may fold into (periodic ticks interleave: heat, venom, heat…) */
export const LOG_FOLD_ROWS = 4;
/** a repeat folds into a row only while it keeps coming (at most this many turns apart) */
export const LOG_FOLD_TURNS = 3;

function sameLine(a: LogMessage, b: LogMessage): boolean {
  return a.text === b.text && a.kind === b.kind && a.speaker === b.speaker;
}

/**
 * Folds repeated lines: an identical line (text, kind, speaker) within the last few rows and turns
 * becomes a counter on that row, which moves to the bottom ("takes 1 Heat. ×5"). GM narration and
 * NPC speech are never folded. Ten turns of a damage-over-time status give one row.
 */
export function groupLog(log: readonly LogMessage[]): LogGroup[] {
  const out: LogGroup[] = [];
  for (const m of log) {
    if (m.kind !== 'gm' && m.kind !== 'npc') {
      let hit = -1;
      for (let i = out.length - 1; i >= Math.max(0, out.length - LOG_FOLD_ROWS); i--) {
        const g = out[i];
        if (sameLine(g.msg, m) && m.turn - g.lastTurn <= LOG_FOLD_TURNS) {
          hit = i;
          break;
        }
      }
      if (hit >= 0) {
        const [g] = out.splice(hit, 1);
        g.count++;
        g.lastTurn = m.turn;
        out.push(g);
        continue;
      }
    }
    out.push({ msg: m, count: 1, firstTurn: m.turn, lastTurn: m.turn });
  }
  return out;
}

/**
 * Names untyped harm in engine log lines with the world's word for health: "snips at Ines for 5."
 * → "snips at Ines for 5 Integrity.", "takes 1." → "takes 1 Integrity.".
 */
export function displayLogText(text: string, vocab: Pick<Vocabulary, 'stats'>): string {
  const hp = vocab.stats.hp.name;
  return text.replace(/\b(for|takes|loses) (\d+)([.!])$/u, (_m, verb: string, n: string, end: string) => `${verb} ${n} ${hp}${end}`);
}

/**
 * Which columns the trade window shows. The Sell column only appears when the trader actually
 * buys something: a permanent "Nothing they want" column was dead UI, because no trader buys
 * anything yet (issues/M2-sell-column-dead-ui.md). The Buy column is always shown so an empty shop
 * still says "Nothing for sale."
 */
export function tradeColumns(t: Pick<TradeView, 'sellable'>): { buy: true; sell: boolean } {
  return { buy: true, sell: t.sellable.length > 0 };
}
