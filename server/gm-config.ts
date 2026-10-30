/**
 * The room server's game master provider (MP4 design §6): environment → GmConfig. Opt-in: only
 * ANYWORLD_GM_PRESET turns on real GM calls (a key in the environment alone never does), and it is
 * never the recorded "mock" preset. Unset means no provider (demo rooms play recorded lines, other
 * rooms the offline director); `off` puts every room on the offline director (tests, MP2's entries).
 *
 *   ANYWORLD_GM_PRESET          a configured preset id (anthropic, mistral, …) or off
 *   ANYWORLD_GM_MODEL           the GM's model; default the preset's gmModel, else <PRESET>_MODEL, else its defaultModel
 *   ANYWORLD_GM_TIMEOUT_MS      the room runner's timeout (default 5000); the model's deadline is 1000 ms less
 *   ANYWORLD_GM_CONCURRENCY     provider calls in flight over all rooms (default maxRooms × 2)
 *   ANYWORLD_GM_CALLS_PER_HOUR  server-wide calls per hour (default 3000); one room at most ANYWORLD_GM_ROOM_CALLS_PER_HOUR (400)
 *   ANYWORLD_TEST_GM            outside production only: a JSON file of scripted MockProvider answers
 *                               ({ responses, latencyMs, failure, seed }) for the child-process tests and e2e-mp
 *
 * The provider is built by the caller's `providerFor` (app.ts: keys stay on the server, and world
 * generation keeps its own model setting).
 */
import { readFileSync } from 'node:fs';
import { getPreset } from '../src/llm/presets';
import { MockProvider, type MockProviderOptions } from '../src/llm/mock';
import type { LLMProvider, ProviderPreset } from '../src/llm/types';

/** the room runner's timeout (ms) */
export const GM_TIMEOUT_MS = 5000;
/** the model's own deadline is this much shorter than the runner's timeout */
export const GM_DEADLINE_GAP_MS = 1000;
export const GM_CALLS_PER_HOUR = 3000;
export const GM_ROOM_CALLS_PER_HOUR = 400;

export interface GmConfig {
  /** 'unset': no ANYWORLD_GM_PRESET (demo rooms recorded); 'off': every room offline; 'ai': a provider */
  setting: 'unset' | 'off' | 'ai';
  /** the GM provider ('ai' only) */
  provider: LLMProvider | null;
  /** "preset model", for logs (never a key) */
  label: string;
  timeoutMs: number;
  deadlineMs: number;
  concurrency: number;
  callsPerHour: number;
  roomCallsPerHour: number;
}

export interface GmConfigDeps {
  /** open rooms at most (the default concurrency is twice this) */
  maxRooms: number;
  /** builds (or reuses) the upstream provider for a preset and model (app.ts providerFor) */
  providerFor: (preset: ProviderPreset, model: string) => LLMProvider;
  /** whether the server can serve the preset (its key or base URL is set) */
  isConfigured: (preset: ProviderPreset) => boolean;
  log?: (line: string) => void;
  /** reads ANYWORLD_TEST_GM's file (tests) */
  readFile?: (path: string) => string;
}

function envInt(v: string | undefined, min: number): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? n : undefined;
}

function envName(presetId: string, suffix: string): string {
  return `${presetId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`;
}

/** the GM's model for a preset: ANYWORLD_GM_MODEL, the preset's gmModel, <PRESET>_MODEL, its defaultModel */
export function gmModelFor(env: Record<string, string | undefined>, preset: ProviderPreset): string {
  return env.ANYWORLD_GM_MODEL?.trim() || preset.gmModel || env[envName(preset.id, 'MODEL')]?.trim() || preset.defaultModel;
}

/** every room offline (no provider, no recordings): the rooms' default when no config is given */
export function offGmConfig(maxRooms = 10): GmConfig {
  return { setting: 'off', provider: null, label: 'off', timeoutMs: GM_TIMEOUT_MS, deadlineMs: GM_TIMEOUT_MS - GM_DEADLINE_GAP_MS, concurrency: maxRooms * 2, callsPerHour: GM_CALLS_PER_HOUR, roomCallsPerHour: GM_ROOM_CALLS_PER_HOUR };
}

/** ANYWORLD_TEST_GM's file → a MockProvider (outside production only) */
function testProvider(path: string, read: (p: string) => string): MockProvider {
  const v = JSON.parse(read(path)) as Pick<MockProviderOptions, 'responses' | 'latencyMs' | 'failure' | 'seed'>;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('ANYWORLD_TEST_GM must name a JSON object file');
  return new MockProvider({
    ...(v.responses ? { responses: v.responses } : {}),
    ...(v.latencyMs !== undefined ? { latencyMs: v.latencyMs } : {}),
    ...(v.failure ? { failure: v.failure } : {}),
    ...(v.seed !== undefined ? { seed: v.seed } : {}),
    maxCalls: 0,
    model: 'test-gm',
  });
}

/** the GM configuration of the environment (see the module comment); problems are logged, never fatal */
export function gmConfigFor(env: Record<string, string | undefined>, deps: GmConfigDeps): GmConfig {
  const log = deps.log ?? ((l: string) => console.log(l));
  const timeoutMs = envInt(env.ANYWORLD_GM_TIMEOUT_MS, 500) ?? GM_TIMEOUT_MS;
  const base: GmConfig = {
    setting: 'unset',
    provider: null,
    label: 'none',
    timeoutMs,
    deadlineMs: Math.max(250, timeoutMs - GM_DEADLINE_GAP_MS),
    concurrency: envInt(env.ANYWORLD_GM_CONCURRENCY, 1) ?? Math.max(1, deps.maxRooms * 2),
    callsPerHour: envInt(env.ANYWORLD_GM_CALLS_PER_HOUR, 0) ?? GM_CALLS_PER_HOUR,
    roomCallsPerHour: envInt(env.ANYWORLD_GM_ROOM_CALLS_PER_HOUR, 0) ?? GM_ROOM_CALLS_PER_HOUR,
  };
  const presetId = env.ANYWORLD_GM_PRESET?.trim().toLowerCase() ?? '';
  if (presetId === 'off') return { ...base, setting: 'off', label: 'off' };
  const testFile = env.ANYWORLD_TEST_GM?.trim();
  if (testFile && env.NODE_ENV !== 'production') {
    return { ...base, setting: 'ai', provider: testProvider(testFile, deps.readFile ?? ((p) => readFileSync(p, 'utf8'))), label: 'test (scripted)' };
  }
  if (!presetId) return base;
  if (presetId === 'mock') {
    log('[gm] ANYWORLD_GM_PRESET=mock is not a GM provider (recordings are used without one); the rooms have no AI GM');
    return base;
  }
  const preset = getPreset(presetId);
  if (!preset) {
    log(`[gm] ANYWORLD_GM_PRESET: unknown preset "${presetId}"; the rooms have no AI GM`);
    return base;
  }
  if (!deps.isConfigured(preset)) {
    log(`[gm] ANYWORLD_GM_PRESET=${preset.id}, but that preset is not configured on this server (its key or base URL); the rooms have no AI GM`);
    return base;
  }
  const model = gmModelFor(env, preset);
  return { ...base, setting: 'ai', provider: deps.providerFor(preset, model), label: `${preset.id} ${model}` };
}
