/**
 * localStorage persistence: the autosaved run and the player's settings. Every access is wrapped
 * in try/catch — storage can be missing, full or blocked, and the game must still run.
 */
import type { LogMessage } from '../engine/types';
import type { Difficulty, Settings } from './ui/viewmodel';
import type { RuleMemo } from './rules';
import type { HookTracker } from './gm-director';

const SAVE_KEY = 'anyworld.save.v1';
const SETTINGS_KEY = 'anyworld.settings.v1';
const ONBOARDED_KEY = 'anyworld.onboarded.v1';

export interface SavedRun {
  v: 1;
  /** bundled world id (content/worlds/<id>.json) */
  worldId: string;
  worldTitle: string;
  /** engine seed (GameState.seed): lets a reloaded `?world=&seed=` link find its own run */
  seed?: number;
  playerName: string;
  areaName: string;
  turn: number;
  /** engine serialize() output */
  state: string;
  /** controller-side GM narration lines */
  gmLog: LogMessage[];
  savedAt: number;
  /** the run's start options (M2; older saves have none) */
  difficulty?: Difficulty;
  weirdness?: number;
  /** what the client remembers about active rules (since-when, GM reasons) */
  rules?: RuleMemo[];
  /** GM hook timers */
  hooks?: HookTracker;
}

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadRun(): SavedRun | null {
  try {
    const txt = store()?.getItem(SAVE_KEY);
    if (!txt) return null;
    const v = JSON.parse(txt) as SavedRun;
    if (!v || v.v !== 1 || typeof v.state !== 'string' || typeof v.worldId !== 'string') return null;
    if (!Array.isArray(v.gmLog)) v.gmLog = [];
    if (v.seed !== undefined && typeof v.seed !== 'number') delete v.seed;
    if (v.rules !== undefined && !Array.isArray(v.rules)) delete v.rules;
    if (v.hooks !== undefined && (typeof v.hooks !== 'object' || v.hooks === null || typeof v.hooks.lastHookTurn !== 'number')) delete v.hooks;
    if (v.weirdness !== undefined && typeof v.weirdness !== 'number') delete v.weirdness;
    return v;
  } catch {
    return null;
  }
}

export function saveRun(run: SavedRun): boolean {
  try {
    store()?.setItem(SAVE_KEY, JSON.stringify(run));
    return true;
  } catch {
    return false;
  }
}

export function clearRun(): void {
  try {
    store()?.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

export function defaultSettings(transport: 'direct' | 'backend'): Settings {
  return {
    // the browser-only build (direct transport) starts with the offline demo generator ('mock', modes.ts
    // OFFLINE_PRESET), so a first visit works with no key; the backend build starts with Anthropic
    provider: { preset: transport === 'direct' ? 'mock' : 'anthropic', transport },
    audio: { volume: 0.6, muted: false, soundcloud: false },
    animationSpeed: 1,
    reduceMotion: false,
    quality: 'auto',
    gm: true,
  };
}

const QUALITIES = ['auto', 'low', 'high'] as const;
const TRANSPORTS = ['direct', 'backend'] as const;

/**
 * The stored settings over the defaults, with every field checked: a hand-edited or old entry
 * never breaks the start screen. `transports` are the transports this build allows (a static
 * build has no backend, so a stored "backend" falls back to the build's default).
 */
export function normalizeSettings(v: unknown, transport: 'direct' | 'backend', transports: readonly ('direct' | 'backend')[] = TRANSPORTS): Settings {
  const d = defaultSettings(transport);
  if (!v || typeof v !== 'object') return d;
  const o = v as Partial<Settings> & { provider?: Partial<Settings['provider']>; audio?: Partial<Settings['audio']> };
  const p: Partial<Settings['provider']> = o.provider && typeof o.provider === 'object' ? o.provider : {};
  const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x : undefined);
  const tr = (TRANSPORTS as readonly string[]).includes(p.transport as string) && transports.includes(p.transport as 'direct' | 'backend') ? (p.transport as 'direct' | 'backend') : transport;
  const provider: Settings['provider'] = { preset: str(p.preset) ?? d.provider.preset, transport: tr };
  if (str(p.model)) provider.model = p.model;
  if (str(p.baseUrl)) provider.baseUrl = p.baseUrl;
  // keys are kept per provider: an old single key belongs to the preset it was saved with
  const apiKeys: Record<string, string> = {};
  if (o.apiKeys && typeof o.apiKeys === 'object' && !Array.isArray(o.apiKeys)) {
    for (const [k, val] of Object.entries(o.apiKeys as Record<string, unknown>)) if (k && str(val)) apiKeys[k] = val as string;
  }
  const slot = keySlot(provider);
  if (str(p.apiKey) && !apiKeys[slot]) apiKeys[slot] = p.apiKey!;
  if (apiKeys[slot]) provider.apiKey = apiKeys[slot];
  const a: Partial<Settings['audio']> = o.audio && typeof o.audio === 'object' ? o.audio : {};
  const vol = typeof a.volume === 'number' && Number.isFinite(a.volume) ? Math.min(1, Math.max(0, a.volume)) : d.audio.volume;
  return {
    provider,
    ...(Object.keys(apiKeys).length ? { apiKeys } : {}),
    audio: { volume: vol, muted: !!a.muted, soundcloud: !!a.soundcloud },
    animationSpeed: typeof o.animationSpeed === 'number' && Number.isFinite(o.animationSpeed) ? Math.min(3, Math.max(0.5, o.animationSpeed)) : 1,
    reduceMotion: !!o.reduceMotion,
    quality: (QUALITIES as readonly string[]).includes(o.quality as string) ? (o.quality as Settings['quality']) : 'auto',
    gm: o.gm !== false,
    ...(str(o.accessCode) ? { accessCode: (o.accessCode as string).trim().slice(0, 200) } : {}),
  };
}

/**
 * Which saved key a provider config may use: the preset id, plus its base URL when one is set (a
 * custom endpoint, or a local server moved to another address), so a key never follows the player
 * to a different host.
 */
export function keySlot(p: Pick<Settings['provider'], 'preset' | 'baseUrl'>): string {
  const url = p.baseUrl?.trim().replace(/\/+$/, '');
  return url ? `${p.preset}@${url}` : p.preset;
}

/**
 * The settings the dialog saved, with keys kept per provider (issues/M5-api-key-leaks-across-presets.md):
 *  - a key the player typed (or cleared) belongs to the provider the dialog is set to,
 *  - otherwise switching provider swaps in that provider's own saved key, or none — the previous
 *    provider's key is never carried over to the new host.
 */
export function reconcileApiKeys(before: Settings, next: Settings): Settings {
  const keys: Record<string, string> = { ...(before.apiKeys ?? {}), ...(next.apiKeys ?? {}) };
  const prevSlot = keySlot(before.provider);
  if (before.provider.apiKey) keys[prevSlot] = before.provider.apiKey;
  const slot = keySlot(next.provider);
  const typed = (next.provider.apiKey ?? '') !== (before.provider.apiKey ?? '');
  const provider = { ...next.provider };
  if (typed) {
    if (provider.apiKey) keys[slot] = provider.apiKey;
    else delete keys[slot];
  } else if (slot !== prevSlot) {
    if (keys[slot]) provider.apiKey = keys[slot];
    else delete provider.apiKey;
  }
  const out: Settings = { ...next, provider };
  if (Object.keys(keys).length) out.apiKeys = keys;
  else delete out.apiKeys;
  return out;
}

/**
 * The provider config to call with: the key only when it is the one saved for this provider and
 * address (a hand-edited or stale entry never sends a key to another host).
 */
export function activeProvider(s: Settings): Settings['provider'] {
  const p = { ...s.provider };
  if (p.apiKey && s.apiKeys && s.apiKeys[keySlot(p)] !== p.apiKey) delete p.apiKey;
  return p;
}

export function loadSettings(transport: 'direct' | 'backend', transports?: readonly ('direct' | 'backend')[]): Settings {
  try {
    const txt = store()?.getItem(SETTINGS_KEY);
    if (!txt) return defaultSettings(transport);
    return normalizeSettings(JSON.parse(txt), transport, transports);
  } catch {
    return defaultSettings(transport);
  }
}

export function saveSettings(s: Settings): void {
  try {
    store()?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** world ids whose onboarding card the player asked not to see again */
export function onboardedWorlds(): string[] {
  try {
    const v = JSON.parse(store()?.getItem(ONBOARDED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** has the onboarding card for this world been dismissed with "don't show again"? */
export function onboardingSeen(worldId: string): boolean {
  return onboardedWorlds().includes(worldId);
}

export function markOnboardingSeen(worldId: string): void {
  try {
    const list = onboardedWorlds().filter((w) => w !== worldId);
    // newest last; keep the list small (generated worlds have fresh ids)
    list.push(worldId);
    store()?.setItem(ONBOARDED_KEY, JSON.stringify(list.slice(-200)));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Generated worlds (M3): kept so a saved run of an AI-made world can be resumed and the prompt can
// steer away from recent worlds. Newest last; only the last few are kept (a spec is ~50–100 kB).
// ---------------------------------------------------------------------------

const WORLDS_KEY = 'anyworld.worlds.v1';
export const MAX_GENERATED_WORLDS = 6;

export interface StoredWorld {
  id: string;
  /** the WorldSpec JSON as generated (validated again with parseWorld when read) */
  world: unknown;
  savedAt: number;
  /** how it got here (M4); older entries are AI-made */
  source?: 'generated' | 'imported';
  /** a bundled world this one was copied from (offline demo generator): its recordings voice the GM */
  origin?: string;
}

export type StoredWorldMeta = Pick<StoredWorld, 'source' | 'origin'>;

/**
 * How the start screen labels a kept world: imported from a file, AI-made, or "demo" — a copy of a
 * recorded world that the offline demo generator picked (it carries `origin`, and no AI made it).
 */
export function recentSource(w: StoredWorldMeta): 'generated' | 'imported' | 'demo' {
  if (w.source === 'imported') return 'imported';
  return w.origin ? 'demo' : 'generated';
}

export function loadGeneratedWorlds(): StoredWorld[] {
  try {
    const v = JSON.parse(store()?.getItem(WORLDS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((w): w is StoredWorld => !!w && typeof w === 'object' && typeof (w as StoredWorld).id === 'string' && !!(w as StoredWorld).world);
  } catch {
    return [];
  }
}

/**
 * Stores a generated world (replacing one with the same id). Only the newest MAX_GENERATED_WORLDS
 * are kept, and when storage is full the oldest worlds are dropped until it fits — but never the
 * world of the autosaved run in progress, or that run could no longer be continued
 * (issues/M5-stored-world-evicts-saved-run.md). Returns false (and changes nothing) when the world
 * does not fit even then.
 */
export function saveGeneratedWorld(id: string, world: unknown, now = Date.now(), meta: StoredWorldMeta = {}): boolean {
  const s = store();
  if (!s) return false;
  const entry: StoredWorld = { id, world, savedAt: now, ...(meta.source ? { source: meta.source } : {}), ...(meta.origin ? { origin: meta.origin } : {}) };
  const pinned = loadRun()?.worldId ?? null;
  const keep = (w: StoredWorld) => w.id === id || w.id === pinned;
  /** drops the oldest entry that may go; false when none may */
  const dropOldest = (xs: StoredWorld[]): StoredWorld[] | null => {
    const i = xs.findIndex((w) => !keep(w));
    return i < 0 ? null : [...xs.slice(0, i), ...xs.slice(i + 1)];
  };
  let list: StoredWorld[] | null = [...loadGeneratedWorlds().filter((w) => w.id !== id), entry];
  while (list && list.length > MAX_GENERATED_WORLDS) list = dropOldest(list);
  // more pinned entries than the cap is impossible (at most the run's world and the new one)
  if (!list) return false;
  for (;;) {
    try {
      s.setItem(WORLDS_KEY, JSON.stringify(list));
      return true;
    } catch {
      const next = dropOldest(list);
      if (!next) return false;
      list = next;
    }
  }
}

/** drops a stored world; returns false when it was not there (or storage failed) */
export function forgetGeneratedWorld(id: string): boolean {
  const s = store();
  if (!s) return false;
  const list = loadGeneratedWorlds();
  const next = list.filter((w) => w.id !== id);
  if (next.length === list.length) return false;
  try {
    s.setItem(WORLDS_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
