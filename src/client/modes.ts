/**
 * How this build is talking to an AI (DESIGN §4.4), as the start screen and the error messages see it:
 *
 *   - backend transport: the Node server holds the keys (`npm run dev` / `npm start`); GET /api/presets
 *     says which presets it can serve. Unreachable server → demo worlds only, with a clear line.
 *   - direct transport (the static build's default): the browser calls the provider with a key kept in
 *     localStorage. Presets without CORS cannot work there and say so.
 *   - offline demo (preset "mock"): no AI at all. "Create world" picks the recorded world that best fits
 *     the prompt and the GM plays its recorded lines (demoGenerator below). Lets a static build with no
 *     key and no network show the whole create → play flow.
 *   - no provider: demo worlds only (recorded narration).
 *
 * Pure apart from the injected world list, so it runs under vitest.
 */
import type { LLMProvider, ProviderConfig, ProviderPreset } from '../llm/types';
import { MockProvider } from '../llm/mock';
import { getPreset } from '../llm/presets';
import type { PromptEntry } from '../schema/prompts';
import type { WorldMeta, WorldSpec } from '../schema/world';
import type { ProviderStatusView } from './ui/viewmodel';
import { WorldGenerationError } from '../llm/generate';
import { normalizeLanguage, t } from './i18n/index';

/** the preset id of the offline demo generator */
export const OFFLINE_PRESET = 'mock';

/** what the backend said about its presets: unknown (not asked yet), unreachable, or the configured ids */
export type ServerState = { kind: 'unknown' } | { kind: 'unreachable' } | { kind: 'ok'; configured: ReadonlySet<string>; codeRequired?: boolean; passRequired?: boolean };

/** why the configured provider cannot be used right now (null = it can) */
export type ProviderProblem =
  | { kind: 'server_unreachable' }
  | { kind: 'server_no_key'; preset: ProviderPreset }
  | { kind: 'server_code' }
  | { kind: 'missing_key'; preset: ProviderPreset }
  | { kind: 'missing_base_url' }
  | { kind: 'cors'; preset: ProviderPreset }
  | { kind: 'unknown_preset'; id: string };

/**
 * The problem with a provider config, if any (the direct-mode CORS problem is reported, not fatal).
 * `accessCode`: the code the player entered for a server that asks for one (ANYWORLD_HOST_CODE).
 */
export function providerProblem(cfg: ProviderConfig, server: ServerState, accessCode?: string): ProviderProblem | null {
  if (cfg.preset === OFFLINE_PRESET) return null;
  const preset = getPreset(cfg.preset);
  if (cfg.transport === 'backend') {
    if (server.kind === 'unreachable') return { kind: 'server_unreachable' };
    if (!preset) return { kind: 'unknown_preset', id: cfg.preset };
    if (server.kind === 'ok' && !server.configured.has(cfg.preset)) return { kind: 'server_no_key', preset };
    if (server.kind === 'ok' && server.codeRequired && !accessCode?.trim()) return { kind: 'server_code' };
    return null;
  }
  if (cfg.preset === 'custom') return cfg.baseUrl?.trim() ? null : { kind: 'missing_base_url' };
  if (!preset) return { kind: 'unknown_preset', id: cfg.preset };
  if (preset.needsKey && !cfg.apiKey) return { kind: 'missing_key', preset };
  if (!preset.cors) return { kind: 'cors', preset };
  return null;
}

/** the human text for a problem */
export function problemText(p: ProviderProblem): string {
  switch (p.kind) {
    case 'server_unreachable':
      return t('status.serverUnreachable');
    case 'server_no_key':
      return t('status.serverNoKey', { name: p.preset.label, env: p.preset.envKey ?? p.preset.baseUrlEnv ?? `${p.preset.id.toUpperCase()}_API_KEY` });
    case 'server_code':
      return t('status.serverCode');
    case 'missing_key':
      return t('status.missingKey', { name: p.preset.label });
    case 'missing_base_url':
      return t('status.missingBaseUrl');
    case 'cors':
      return t('status.corsDirect', { name: p.preset.label });
    case 'unknown_preset':
      return t('status.unknownPreset', { id: p.id });
  }
}

/**
 * The start screen's provider line. `canGenerate` is whether a provider was built from the settings
 * (ai.ts providerFromSettings, or the offline demo generator).
 */
export function providerStatus(cfg: ProviderConfig, server: ServerState, canGenerate: boolean, opts: { gm?: boolean; accessCode?: string } = {}): ProviderStatusView {
  const gmOff = opts.gm === false ? t('status.gmOff') : undefined;
  if (cfg.preset === OFFLINE_PRESET) return { tone: 'demo', text: t('status.offlineGenerator'), ...(gmOff ? { detail: gmOff } : {}) };
  const problem = providerProblem(cfg, server, opts.accessCode);
  const name = getPreset(cfg.preset)?.label ?? (cfg.preset === 'custom' ? t('settings.custom') : cfg.preset);
  if (canGenerate) {
    const details = [
      problem?.kind === 'cors' ? problemText(problem) : null,
      cfg.transport === 'direct' && cfg.apiKey ? t('status.directKey') : null,
      gmOff ?? null,
    ].filter((x): x is string => !!x);
    return {
      tone: problem ? 'warn' : 'ok',
      text: t('status.ready', { name, transport: cfg.transport }),
      ...(details.length ? { detail: details.join(' ') } : {}),
    };
  }
  if (problem && problem.kind !== 'cors') return { tone: problem.kind === 'server_unreachable' ? 'demo' : 'warn', text: problemText(problem), detail: t('status.demoStill') };
  if (cfg.transport === 'backend' && server.kind === 'unknown') return { tone: 'demo', text: t('status.checking') };
  return { tone: 'demo', text: t('status.demo') };
}

/**
 * Extra advice for a failed world generation, by error kind and transport: the loading screen shows
 * it under the error. Most important case: a direct call that never got an answer is usually a CORS
 * block (the browser hides the reason), or a wrong address for a local server.
 */
export function generationHint(err: unknown, cfg: ProviderConfig): string | null {
  const kind = err instanceof WorldGenerationError ? err.kind : null;
  switch (kind) {
    case 'network':
      if (cfg.transport === 'backend') return t('gen.hint.server');
      return cfg.preset === 'ollama' || cfg.preset === 'lmstudio' || cfg.preset === 'custom' ? t('gen.hint.local') : t('gen.hint.cors');
    case 'timeout':
      return t('gen.hint.timeout');
    case 'auth':
      if (cfg.transport !== 'backend') return t('gen.hint.authDirect');
      // the server refused our access code (not its own provider key)
      return /access code/i.test(`${(err as Error).message ?? ''} ${((err as Error).cause as Error | undefined)?.message ?? ''}`) ? t('gen.hint.serverCode') : t('gen.hint.authServer');
    case 'config':
      return cfg.transport === 'backend' ? t('gen.hint.configServer') : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Offline demo generator
// ---------------------------------------------------------------------------

/** a recorded world as the picker sees it (worlds.ts WorldIndexEntry: no full spec needed) */
export interface DemoWorldChoice {
  id: string;
  meta: Pick<WorldMeta, 'title' | 'tagline' | 'genre' | 'language' | 'tags' | 'tone' | 'premise' | 'prompt'>;
}

/** a small stable string hash (FNV-1a) */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9æøå]+/)
      .filter((w) => w.length > 3),
  );
}

/**
 * The recorded world that best fits a request: the library prompt's own world when the prompt is
 * one of the library's; else the world sharing the most words with the prompt (title, genre,
 * tagline, premise) in the requested language; ties and blank prompts ("Surprise me") are broken
 * by `seed`. Worlds in the requested language are preferred; any world will do when none is.
 */
export function pickDemoWorld<T extends DemoWorldChoice>(
  worlds: readonly T[],
  req: { prompt: string; language: string; seed: number },
  library: readonly Pick<PromptEntry, 'prompt' | 'worldId'>[] = [],
): T | null {
  if (!worlds.length) return null;
  const prompt = req.prompt.trim();
  if (prompt) {
    const lib = library.find((p) => p.worldId && p.prompt.trim().toLowerCase() === prompt.toLowerCase());
    const hit = lib && worlds.find((w) => w.id === lib.worldId);
    if (hit) return hit;
  }
  const lang = normalizeLanguage(req.language);
  const inLang = worlds.filter((w) => normalizeLanguage(w.meta.language || 'en') === lang && !w.id.startsWith('fixture-'));
  const pool = inLang.length ? inLang : worlds;
  if (!prompt) return pool[hash(`${req.seed}`) % pool.length]!;
  const want = words(prompt);
  let best: T[] = [];
  let bestScore = -1;
  for (const w of pool) {
    const m = w.meta;
    const have = words(`${m.title} ${m.genre} ${m.tagline} ${m.premise} ${m.tone} ${m.tags.join(' ')} ${m.prompt}`);
    let score = 0;
    for (const x of want) if (have.has(x)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = [w];
    } else if (score === bestScore) best.push(w);
  }
  return best[hash(`${req.seed}:${prompt}`) % best.length]!;
}

/**
 * A provider that "invents" `world` instantly: every world-generation request (first try, repairs,
 * balance feedback) is answered with that world's JSON. The rest of the pipeline (validation, bot
 * play-test) runs for real.
 */
export function demoGenerator(id: string, world: WorldSpec, opts: { latencyMs?: number } = {}): LLMProvider {
  const text = JSON.stringify(world);
  return new MockProvider({
    model: `offline:${id}`,
    maxCalls: 4,
    ...(opts.latencyMs ? { latencyMs: opts.latencyMs } : {}),
    fallback: () => text,
  });
}
