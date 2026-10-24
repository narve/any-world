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
const HINTS_KEY = 'anyworld.hints-seen.v1';

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
    provider: { preset: 'anthropic', transport },
    audio: { volume: 0.6, muted: false },
    animationSpeed: 1,
    reduceMotion: false,
  };
}

export function loadSettings(transport: 'direct' | 'backend'): Settings {
  const d = defaultSettings(transport);
  try {
    const txt = store()?.getItem(SETTINGS_KEY);
    if (!txt) return d;
    const v = JSON.parse(txt) as Partial<Settings>;
    return {
      provider: { ...d.provider, ...(v.provider ?? {}) },
      audio: { ...d.audio, ...(v.audio ?? {}) },
      animationSpeed: typeof v.animationSpeed === 'number' ? Math.min(3, Math.max(0.5, v.animationSpeed)) : 1,
      reduceMotion: !!v.reduceMotion,
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings): void {
  try {
    store()?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** the first-run hint card has been seen (shown once per browser) */
export function hintsSeen(): boolean {
  try {
    return store()?.getItem(HINTS_KEY) === '1';
  } catch {
    return false;
  }
}

export function markHintsSeen(): void {
  try {
    store()?.setItem(HINTS_KEY, '1');
  } catch {
    /* ignore */
  }
}
