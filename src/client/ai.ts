/**
 * The client's AI wiring (M3): which LLM provider the settings give, the GM director and NPC voice
 * of a run, and the world-generation flow behind the loading screen.
 *
 *   - live: a provider is configured (direct transport with its key, or a preset the server says it
 *     can serve). The GM is LlmGmDirector, NPCs speak through LlmDialogue; both fall back to the
 *     offline director / canned lines when the model fails.
 *   - demo: no provider, but the bundled world has recordings (content/recordings/<id>/): each
 *     recorded moment plays once, then the offline GM takes over (createDemoGm).
 *   - offline: neither; the offline director only.
 *
 * Kept free of DOM and Vite specifics except for the injected loaders, so it runs under vitest.
 */
import type { LLMProvider, ProviderConfig } from '../llm/types';
import { createProvider, type CreateProviderOptions } from '../llm/transport';
import { getPreset } from '../llm/presets';
import type { Recording } from '../llm/mock';
import { LlmDialogue, LlmGmDirector, createDemoGm, type DialogueTurnResult } from '../llm/gm-runtime';
import type { DialogueLine } from '../llm/prompts/dialogue';
import { generateWorld, WorldGenerationError, type Balancer, type GenerateProgress, type GenerateStage, type GenerateWorldOptions } from '../llm/generate';
import type { WorldSpec } from '../schema/world';
import type { Difficulty } from '../schema/gm';
import type { GameState } from '../engine/types';
import { OfflineGmDirector, type GmDirector } from './gm-director';
import type { LoadingStepView, LoadingView } from './ui/viewmodel';
import { t, tx } from './i18n/index';

export type AiMode = 'live' | 'demo' | 'offline';

/** per-request GM time limits: a live model needs longer than the offline director */
export const LIVE_GM_TIMEOUT_MS = 30000;
export const DEMO_GM_TIMEOUT_MS = 8000;

/**
 * The provider the settings describe, or null when it cannot work: the mock preset (no
 * recordings), an unknown preset, a direct preset without its key, or a backend preset the server
 * did not list as configured (`serverConfigured` null = not known yet: assume it is not).
 */
export function providerFromSettings(cfg: ProviderConfig, serverConfigured: ReadonlySet<string> | null, opts: CreateProviderOptions = {}): LLMProvider | null {
  if (!cfg || cfg.preset === 'mock') return null;
  const preset = getPreset(cfg.preset);
  if (cfg.transport === 'backend') {
    if (!serverConfigured?.has(cfg.preset)) return null;
  } else {
    if (cfg.preset !== 'custom' && !preset) return null;
    if (preset?.needsKey && !cfg.apiKey) return null;
    if (cfg.preset === 'custom' && !cfg.baseUrl) return null;
  }
  try {
    return createProvider(cfg, opts);
  } catch {
    return null;
  }
}

/** "Claude (via the server)" for the start screen */
export function providerLabel(cfg: ProviderConfig): string {
  const name = getPreset(cfg.preset)?.label ?? cfg.preset;
  return t('gen.provider', { name, transport: cfg.transport });
}

/** the AI side of one run */
export interface RunAi {
  mode: AiMode;
  /** GmRunner primary director (null = the offline director alone) */
  director: GmDirector | null;
  /** NPC voice (null = the engine's own lines) */
  dialogue: LlmDialogue | null;
  gmTimeoutMs: number;
}

export interface RunAiOptions {
  provider: LLMProvider | null;
  /** the world's id: a bundled file id doubles as its recordings key */
  worldId: string;
  /** recordings of a bundled world (demo mode); called only without a provider */
  loadRecordings?: (worldId: string) => Promise<Recording[]>;
  onError?: (err: unknown) => void;
}

export async function runAi(opts: RunAiOptions): Promise<RunAi> {
  const onError = opts.onError ?? ((e: unknown) => console.warn('[anyworld] AI:', e));
  if (opts.provider) {
    // the fallback labels its offers with the client's i18n
    const director = new LlmGmDirector({ provider: opts.provider, worldKey: opts.worldId, fallback: new OfflineGmDirector(), onError: (e) => onError(e) });
    // GM moments and conversations share one help ceiling
    const dialogue = new LlmDialogue({ provider: opts.provider, worldKey: opts.worldId, ledger: director.ledger, onError });
    return { mode: 'live', director, dialogue, gmTimeoutMs: LIVE_GM_TIMEOUT_MS };
  }
  let recordings: Recording[] = [];
  try {
    recordings = opts.loadRecordings ? await opts.loadRecordings(opts.worldId) : [];
  } catch (e) {
    onError(e);
  }
  if (recordings.length) {
    const demo = createDemoGm({ recordings, worldKey: opts.worldId, fallback: new OfflineGmDirector(), onError });
    return { mode: 'demo', director: demo.director, dialogue: demo.dialogue, gmTimeoutMs: DEMO_GM_TIMEOUT_MS };
  }
  return { mode: 'offline', director: null, dialogue: null, gmTimeoutMs: DEMO_GM_TIMEOUT_MS };
}

/** what the session wants voiced: one NPC turn of the open conversation */
export interface VoiceRequest {
  /** changes with every turn; a late answer for an older token is dropped */
  token: number;
  npcId: string;
  history: DialogueLine[];
  playerLine?: string;
}

/** asks the NPC voice for a turn; resolves null when it has nothing usable (or was aborted) */
export async function voiceTurn(
  dialogue: LlmDialogue,
  req: VoiceRequest,
  ctx: { world: WorldSpec; state: GameState; difficulty: Difficulty; signal?: AbortSignal },
): Promise<DialogueTurnResult | null> {
  try {
    const r = await dialogue.turn({
      world: ctx.world,
      state: ctx.state,
      npcId: req.npcId,
      difficulty: ctx.difficulty,
      history: req.history,
      ...(req.playerLine ? { playerLine: req.playerLine } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    // canned fallback lines add nothing over the engine's own greeting
    return r.source === 'llm' && r.response.reply.trim() ? r : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// World generation → loading screen
// ---------------------------------------------------------------------------

export interface GenerationRequest {
  prompt: string;
  surprise: boolean;
  difficulty: Difficulty;
  weirdness: number;
  language: string;
  /** titles of recently played worlds (the prompt steers away from them) */
  recentWorlds?: string[];
  /** "surprise me" draw */
  surpriseSeed?: number;
  /** a world for a room of this many players (2–12; MP4 design §5); absent = single player */
  party?: number;
}

/** loading-screen lines of the offline demo generator for the stages that would talk to an AI */
const OFFLINE_STAGE_KEYS: Partial<Record<GenerateStage, 'gen.progress.offlineRequest' | 'gen.progress.offlineReceived'>> = {
  request: 'gen.progress.offlineRequest',
  received: 'gen.progress.offlineReceived',
};

/**
 * One world generation with its loading-screen view. `view()` is rebuilt from the progress events;
 * `run()` resolves the world or rejects with a WorldGenerationError (the view then shows it).
 */
export class WorldGeneration {
  private steps: (LoadingStepView & { stage: GenerateStage })[] = [];
  private title?: string;
  private tagline?: string;
  private genre?: string;
  private error: string | null = null;
  private retryable = true;
  private readonly abort = new AbortController();
  done = false;

  constructor(
    private readonly provider: LLMProvider,
    private readonly req: GenerationRequest,
    private readonly opts: {
      balancer?: Balancer;
      balance?: GenerateWorldOptions['balance'];
      onChange?: () => void;
      timeoutMs?: number;
      /** the offline demo generator: no AI is asked, so the request steps say so */
      offline?: boolean;
    } = {},
  ) {}

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  cancel(): void {
    this.abort.abort();
  }

  view(): LoadingView {
    return {
      steps: this.steps.map(({ stage: _s, ...v }) => v),
      ...(this.title ? { title: this.title } : {}),
      ...(this.tagline ? { tagline: this.tagline } : {}),
      ...(this.genre ? { genre: this.genre } : {}),
      error: this.error,
      canCancel: true,
      canRetry: !!this.error && this.retryable,
    };
  }

  /** applies one progress event (exported behaviour for tests) */
  progress(p: GenerateProgress): void {
    if (p.title) this.title = p.title;
    if (p.tagline) this.tagline = p.tagline;
    const offlineKey = this.opts.offline ? OFFLINE_STAGE_KEYS[p.stage] : undefined;
    const label = offlineKey ? t(offlineKey) : tx(p.key, p.params, p.message);
    const last = this.steps[this.steps.length - 1];
    if (last && last.stage === p.stage) {
      last.label = label;
    } else {
      for (const s of this.steps) if (s.status === 'active') s.status = 'done';
      if (p.stage !== 'done') this.steps.push({ id: `${p.stage}-${this.steps.length}`, stage: p.stage, label, status: 'active' });
    }
    if (p.stage === 'done') for (const s of this.steps) s.status = 'done';
    this.opts.onChange?.();
  }

  async run(): Promise<WorldSpec> {
    this.error = null;
    try {
      const res = await generateWorld({
        provider: this.provider,
        prompt: this.req.surprise ? '' : this.req.prompt,
        language: this.req.language,
        difficulty: this.req.difficulty,
        weirdness: this.req.weirdness,
        ...(this.req.surprise ? { surpriseSeed: this.req.surpriseSeed ?? 1 } : {}),
        ...(this.req.recentWorlds?.length ? { recentWorlds: this.req.recentWorlds } : {}),
        ...(this.req.party && this.req.party > 1 ? { party: this.req.party } : {}),
        signal: this.abort.signal,
        ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
        ...(this.opts.balancer ? { balancer: this.opts.balancer } : {}),
        ...(this.opts.balance !== undefined ? { balance: this.opts.balance } : {}),
        onProgress: (p) => this.progress(p),
      });
      this.genre = res.world.meta.genre;
      this.title = res.world.meta.title;
      this.tagline = res.world.meta.tagline;
      this.done = true;
      this.opts.onChange?.();
      return res.world;
    } catch (e) {
      const err = e instanceof WorldGenerationError ? e : new WorldGenerationError('provider', e instanceof Error ? e.message : String(e), { cause: e });
      this.retryable = err.kind !== 'aborted';
      this.error = `${tx(err.key, {}, err.message)} ${t('gen.errorHint')}`;
      const active = this.steps.find((s) => s.status === 'active');
      if (active) {
        active.status = 'error';
        if (err.errors.length) active.detail = err.errors.slice(0, 3).join('; ');
      }
      this.opts.onChange?.();
      throw err;
    }
  }
}
