/**
 * Pure formatting helpers for the UI (no DOM). Everything world-specific comes from the
 * vocabulary; every fixed word comes from the UI message catalog (src/client/i18n).
 */
import type { Vocabulary } from '../../schema/world';
import type { ActorView, ItemView, LogMessage } from '../../engine/types';
import type { CoreStatKey, Difficulty, RunStatsView, SlotItemView, TradeView } from './viewmodel';
import type { ProviderPreset } from '../../llm/types';
import { catalog, getLanguage, t, type MessageKey } from '../i18n/index';
import { itemEffectTexts } from '../i18n/engine-text';

/** the text for an unknown item, in the current UI language */
export function unknownItemText(): string {
  return t('item.unknownText');
}

/** @deprecated the English text at load time; use unknownItemText() */
export const UNKNOWN_ITEM_TEXT = unknownItemText();

/** the generic vocabulary used before a world exists (start screen), in the current UI language */
export function defaultVocabulary(): Vocabulary {
  const stat = (k: 'str' | 'dex' | 'int' | 'hp' | 'mp' | 'ac') => ({
    name: t(`vocab.${k}.name` as const),
    abbr: t(`vocab.${k}.abbr` as const),
    description: t(`vocab.${k}.desc` as const),
  });
  return {
    stats: { str: stat('str'), dex: stat('dex'), int: stat('int'), hp: stat('hp'), mp: stat('mp'), ac: stat('ac') },
    conflict: t('vocab.conflict'),
    defeated: t('vocab.defeated'),
    xp: t('vocab.xp'),
    levelUp: t('vocab.levelUp'),
    currency: t('vocab.currency'),
    lossTitle: t('vocab.lossTitle'),
    winTitle: t('vocab.winTitle'),
    area: t('vocab.area'),
  };
}

/** @deprecated the vocabulary at load time; use defaultVocabulary() */
export const DEFAULT_VOCABULARY: Vocabulary = defaultVocabulary();

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

/** "Turn 42" (a neutral UI word); areas use vocabulary.area */
export function turnLabel(turn: number): string {
  return t('hud.turn', { n: turn });
}

/** "Stretch 2 / 4" */
export function areaLabel(vocab: Vocabulary, index: number, count: number): string {
  return count > 0 ? t('hud.areaOf', { area: vocab.area, n: index + 1, count }) : t('hud.area', { area: vocab.area, n: index + 1 });
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
  if (item.knowledge === 'clear') return { kind: 'exact', lines: itemEffectTexts(item) };
  if (item.knowledge === 'vague') return { kind: 'vague', lines: item.vagueText ? [item.vagueText] : [] };
  return { kind: 'unknown', lines: [unknownItemText()] };
}

export function knowledgeBadge(k: ItemView['knowledge']): string {
  return k === 'clear' ? t('item.known') : k === 'vague' ? t('item.partlyKnown') : t('item.unknown');
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

const THREATS: readonly ActorView['threat'][] = ['trivial', 'even', 'dangerous', 'deadly'];

export function threatLabel(threat: ActorView['threat']): string {
  return THREATS.includes(threat) ? t(`actor.threat.${threat}` as const) : threat;
}

export function factionLabel(f: ActorView['faction']): string {
  switch (f) {
    case 'hostile':
      return t('actor.faction.hostile');
    case 'friendly':
      return t('actor.faction.friendly');
    case 'neutral':
      return t('actor.faction.neutral');
    default:
      return t('actor.faction.player');
  }
}

/** css class suffix for a log kind */
export function logKindClass(kind: LogMessage['kind']): string {
  return `log-${kind}`;
}

/** run stats for the end screen, labelled through the vocabulary */
export function runStatLines(s: RunStatsView, vocab: Vocabulary): { label: string; value: string }[] {
  return [
    { label: t('end.stat.turns'), value: String(s.turns) },
    { label: t('end.stat.areas', { area: vocab.area }), value: t('common.fraction', { n: Math.min(s.areaCount, s.areasCleared + 1), of: s.areaCount }) },
    { label: capitalize(vocab.defeated), value: String(s.kills) },
    { label: t('end.stat.itemsUsed'), value: String(s.itemsUsed) },
    { label: t('end.stat.harmDealt'), value: String(s.damageDealt) },
    { label: t('end.stat.harmTaken'), value: String(s.damageTaken) },
    { label: t('end.stat.level', { xp: vocab.xp }), value: String(s.level) },
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


export function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === 'string' && (DIFFICULTIES as readonly string[]).includes(v);
}

/** label for a difficulty; numbers are slider positions (0..3, out of range clamps) */
export function difficultyLabel(d: Difficulty | number): string {
  return t(`difficulty.${toDifficulty(d)}.label` as const);
}

export function difficultyHint(d: Difficulty | number): string {
  return t(`difficulty.${toDifficulty(d)}.hint` as const);
}

/** slider position (0..3) or name → Difficulty ('normal' for anything unreadable) */
export function toDifficulty(d: unknown): Difficulty {
  if (isDifficulty(d)) return d;
  if (typeof d === 'number' && Number.isFinite(d)) return DIFFICULTIES[clamp(Math.round(d), 0, DIFFICULTIES.length - 1)];
  return 'normal';
}

export function weirdnessLabel(w: number): string {
  const v = clamp(w, 0, 1);
  if (v < 0.15) return t('weirdness.familiar');
  if (v < 0.4) return t('weirdness.offKilter');
  if (v < 0.65) return t('weirdness.strange');
  if (v < 0.85) return t('weirdness.uncanny');
  return t('weirdness.unhinged');
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
  return speed === 'fast' ? t('hud.fast') : speed === 'slow' ? t('hud.slow') : null;
}

/** truncate for tooltips */
export function ellipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** pure: notes shown under the provider select */
const REGION_KEYS: Record<string, MessageKey> = {
  us: 'settings.region.us',
  china: 'settings.region.china',
  eu: 'settings.region.eu',
  global: 'settings.region.global',
  local: 'settings.region.local',
  custom: 'settings.region.custom',
};

/** a preset's region in the UI language ("China" → "Kina"); unknown regions are shown as given */
export function presetRegion(region: string): string {
  const k = REGION_KEYS[region.trim().toLowerCase()];
  return k ? t(k) : region;
}

/** a preset's name in the UI language: brand names stay, "(local)" and "Custom (…)" are translated */
export function presetLabel(p: Pick<ProviderPreset, 'id' | 'label'>): string {
  if (p.id === 'custom') return t('settings.preset.custom');
  const m = /^(.*?)\s*\(local\)\s*$/i.exec(p.label);
  return m ? t('settings.preset.local', { name: m[1] }) : p.label;
}

/**
 * The technical preset note (presets.ts) in the UI language: a catalog entry
 * `settings.presetNote.<id>` when the UI language has one, the English note in the English UI, and
 * nothing otherwise (no English paragraph in a Norwegian settings dialog).
 */
export function presetNote(p: Pick<ProviderPreset, 'id' | 'notes'>): string | undefined {
  const lang = getLanguage();
  const own = catalog(lang)?.[`settings.presetNote.${p.id}`];
  if (own) return own;
  return lang === 'en' ? p.notes : undefined;
}

/** a preset as the settings dialog shows it: label, region and note in the UI language */
export function localizedPreset<P extends ProviderPreset>(p: P): P {
  const notes = presetNote(p);
  const out: P = { ...p, label: presetLabel(p), region: presetRegion(p.region) };
  if (notes) out.notes = notes;
  else delete out.notes;
  return out;
}

export function presetNotes(p: ProviderPreset | undefined, transport: 'direct' | 'backend'): { text: string; warn: boolean }[] {
  if (!p) return [{ text: t('settings.note.custom'), warn: false }];
  const out: { text: string; warn: boolean }[] = [{ text: t('settings.note.region', { region: presetRegion(p.region) }), warn: false }];
  if (!p.cors && transport === 'direct') out.push({ text: t('settings.note.noCorsDirect'), warn: true });
  else if (!p.cors) out.push({ text: t('settings.note.noCors'), warn: false });
  if (transport === 'backend') out.push({ text: t('settings.note.backend'), warn: false });
  else if (p.needsKey) out.push({ text: t('settings.note.keyLocal'), warn: false });
  const note = presetNote(p);
  if (note) out.push({ text: note, warn: false });
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

/** the base language of a BCP-47 tag ("nb-NO" → "nb", "" → "en") */
export function baseLang(tag: string | undefined | null): string {
  const b = String(tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return b === 'no' ? 'nb' : b || 'en';
}

/**
 * A language's own name with a capital first letter ("nb" → "Norsk bokmål", "en" → "English"),
 * which reads right whatever the UI language is; the upper-cased tag when Intl cannot name it.
 */
export function languageEndonym(tag: string | undefined | null): string {
  const code = baseLang(tag);
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (name && name.toLowerCase() !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    /* no Intl.DisplayNames, or an unknown tag */
  }
  return code.toUpperCase();
}

/**
 * Groups items by base language, the UI language's group first, then the rest by endonym; the
 * order inside a group is kept.
 */
export function groupByLanguage<T extends { language?: string }>(items: readonly T[], uiLang: string): { language: string; label: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = baseLang(it.language);
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  const ui = baseLang(uiLang);
  return [...groups.entries()]
    .map(([language, list]) => ({ language, label: languageEndonym(language), items: list }))
    .sort((a, b) => (a.language === ui ? -1 : b.language === ui ? 1 : a.label.localeCompare(b.label)));
}

/**
 * Inspiration cards: `n` random prompts, those in the UI language first (others fill up when there
 * are too few).
 */
export function pickInspiration<T extends { language?: string }>(list: readonly T[], n: number, uiLang: string, rand: () => number): T[] {
  const ui = baseLang(uiLang);
  const mine = pickCards(list.filter((p) => baseLang(p.language) === ui), n, rand);
  if (mine.length >= n) return mine;
  return [...mine, ...pickCards(list.filter((p) => baseLang(p.language) !== ui), n - mine.length, rand)];
}
