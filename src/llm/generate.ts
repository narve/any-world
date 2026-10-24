/**
 * World generation pipeline (DESIGN §3.1 "Run start", §4.1; PLAN M3):
 *
 *   prompt (prompts/world.ts) → provider.complete → extract JSON → zod WorldSpec → validateWorldRefs
 *     → on errors: send them back to the model (repair turns, default 2)
 *     → balance: static analysis + bot simulations (tuneWorld: rebalance automatically)
 *     → still unwinnable / broken: one round of balance feedback to the model, then re-check
 *     → { world, report, attempts }
 *
 * Progress callbacks drive the loading screen (the world's title and tagline appear as soon as a
 * reply contains them). Failures are WorldGenerationError with a `kind` and an i18n `key` the UI can
 * show, always with the option to play a demo world instead (`canPlayDemo`).
 *
 * Browser-safe (runs in the browser for the direct transport, on the server for /api/generate, and
 * in tools/agent-provider.ts). The balance step is synchronous CPU work; `yieldToUi` runs between
 * stages so a loading screen can repaint.
 */
import { WorldSpec } from '../schema/world';
import { validateWorldRefs } from '../schema/refs';
import type { Difficulty } from '../schema/gm';
import type { ChatMessage, CompletionRequest, CompletionResponse, LLMProvider } from './types';
import { LLMAbortedError, LLMError, LLMTimeoutError } from './errors';
import { checkStructuredText, completeStructured, extractJson, repairMessage, StructuredOutputError, type CheckResult, type Usage } from './structured';
import { worldRequest, WORLD_MAX_TOKENS, type WorldPromptOptions } from './prompts/world';
import { normaliseLanguage } from './prompts/common';
import { tuneWorld, type BalanceReport, type TuneStep, type Verdict } from '../engine/balance/index';
import type { BotName } from '../engine/sim/bots';

type WorldSpecT = WorldSpec;

/** small JSON Schema hint sent with world requests: asks providers for JSON mode without the 110k schema */
export const WORLD_JSON_HINT_SCHEMA = {
  type: 'object',
  title: 'WorldSpec',
  description: 'A complete AnyWorld World Spec as described in the system prompt.',
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GenerateStage =
  | 'request' // sending the prompt
  | 'received' // a reply arrived (title/tagline may be known)
  | 'repairing' // the reply had problems; asking the model to fix them
  | 'validated' // a valid world
  | 'balancing' // bot simulations
  | 'feedback' // balance problems sent back to the model
  | 'done';

export interface GenerateProgress {
  stage: GenerateStage;
  /** provider call number (1-based), across repair and feedback turns */
  attempt: number;
  /** rough overall progress 0..1 for a progress bar */
  fraction: number;
  /** English log line (the UI renders `key` through its catalog) */
  message: string;
  /** i18n catalog key for the UI, e.g. "gen.progress.balancing" */
  key: string;
  params?: Record<string, string | number>;
  title?: string;
  tagline?: string;
  /** problems found in the last reply */
  errors?: number;
  verdict?: Verdict;
  winRate?: number;
}

export interface BalanceOptions {
  /** seeds per analysis (default 12) */
  seeds?: number;
  bots?: BotName[];
  /** automatic rebalance rounds (default 2) */
  rounds?: number;
  /** re-check verdicts on fresh seeds before changing the world (default true) */
  confirm?: boolean;
}

export interface GenerateWorldOptions extends WorldPromptOptions {
  provider: LLMProvider;
  signal?: AbortSignal;
  /** total time limit for the whole pipeline's provider calls, ms (default 300 000) */
  timeoutMs?: number;
  /** repair turns after an invalid reply (default 2, i.e. up to 3 calls) */
  repairs?: number;
  /** balance check; false skips it (tests, very slow devices) */
  balance?: false | BalanceOptions;
  /** rounds of balance feedback to the model when tuning cannot fix the world (default 1) */
  balanceFeedback?: number;
  maxTokens?: number;
  /**
   * Runs the balance step; default `balanceWorld` on this thread. The browser passes a Web Worker
   * based balancer (balance-worker.ts: `workerBalancer`) so the loading screen stays responsive.
   */
  balancer?: Balancer;
  onProgress?: (p: GenerateProgress) => void;
  /** called between stages so a UI can repaint (default: a macrotask) */
  yieldToUi?: () => Promise<void>;
}

export interface GenerateResult {
  world: WorldSpecT;
  /** balance report of the returned world (null when balance was skipped) */
  report: BalanceReport | null;
  /** provider calls made */
  attempts: number;
  usage: Usage;
  model: string;
  /** automatic rebalance steps (empty when nothing changed) */
  tuneHistory: TuneStep[];
  /** the accepted reply text (before rebalancing) */
  text: string;
}

export type WorldGenerationErrorKind = 'timeout' | 'aborted' | 'invalid' | 'unbalanced' | 'auth' | 'rate_limit' | 'network' | 'refused' | 'config' | 'provider';

/** a typed failure the UI can show ("play a demo world instead" is always possible) */
export class WorldGenerationError extends Error {
  readonly kind: WorldGenerationErrorKind;
  /** i18n catalog key, e.g. "gen.error.timeout" */
  readonly key: string;
  readonly canPlayDemo = true;
  /** last validation / balance problems (invalid, unbalanced) */
  readonly errors: string[];
  readonly attempts: number;
  /** a provider error is worth retrying later (rate limit, network, server, timeout) */
  readonly retryable: boolean;

  constructor(kind: WorldGenerationErrorKind, message: string, data: { errors?: string[]; attempts?: number; cause?: unknown; retryable?: boolean } = {}) {
    super(message, data.cause !== undefined ? { cause: data.cause } : undefined);
    this.name = 'WorldGenerationError';
    this.kind = kind;
    this.key = `gen.error.${kind}`;
    this.errors = data.errors ?? [];
    this.attempts = data.attempts ?? 0;
    this.retryable = data.retryable ?? false;
  }

  toJSON(): { kind: WorldGenerationErrorKind; key: string; message: string; errors: string[]; attempts: number; retryable: boolean; canPlayDemo: true } {
    return { kind: this.kind, key: this.key, message: this.message, errors: this.errors, attempts: this.attempts, retryable: this.retryable, canPlayDemo: true };
  }
}

// ---------------------------------------------------------------------------
// Validation steps (shared with tools/agent-provider.ts)
// ---------------------------------------------------------------------------

/** semantic checks after zod: cross references and consistency (validateWorldRefs) */
export function worldErrors(world: WorldSpecT): string[] {
  return validateWorldRefs(world);
}

/**
 * Check one model reply exactly as the pipeline does. On failure `repair` is the message the model
 * would get back (repairMessage format).
 */
export async function checkWorldReply(text: string, truncated = false): Promise<(CheckResult<WorldSpecT> & { repair?: undefined }) | { ok: false; errors: string[]; repair: string }> {
  const r = await checkStructuredText(text, WorldSpec, worldErrors);
  if (r.ok) return r;
  return { ok: false, errors: r.errors, repair: repairMessage(r.errors, truncated) };
}

/** settle fields the player chose, whatever the model wrote (language, prompt) */
export function finaliseWorld(world: WorldSpecT, opts: Pick<WorldPromptOptions, 'language' | 'prompt'>): WorldSpecT {
  const language = normaliseLanguage(opts.language);
  const prompt = (opts.prompt ?? '').trim().slice(0, 500);
  if (world.meta.language === language && world.meta.prompt === prompt) return world;
  return { ...world, meta: { ...world.meta, language, prompt } };
}

/** balance verdicts that tuning could not fix and that make a world unfit to play */
export function isUnplayable(v: Verdict): boolean {
  return v === 'unwinnable' || v === 'broken';
}

/** run the automatic balance step (static analysis + bots + rebalance) on a valid world */
export function balanceWorld(world: WorldSpecT, difficulty: Difficulty, opts: BalanceOptions = {}): BalanceOutcome {
  const res = tuneWorld(world, {
    seeds: opts.seeds ?? 12,
    bots: opts.bots ?? ['explorer', 'cautious'],
    rounds: opts.rounds ?? 2,
    confirm: opts.confirm ?? true,
    difficulty,
    fast: true,
  });
  return { world: res.world, report: res.report, history: res.history.filter((h) => h.changes.length > 0) };
}

export type BalanceOutcome = { world: WorldSpecT; report: BalanceReport; history: TuneStep[] };
export type Balancer = (world: WorldSpecT, difficulty: Difficulty, opts: BalanceOptions, signal?: AbortSignal) => BalanceOutcome | Promise<BalanceOutcome>;

/** the message that sends balance problems back to the model */
export function balanceFeedbackMessage(report: Pick<BalanceReport, 'verdict' | 'reasons' | 'suggestions'>): string {
  const lines = [
    `Your world is valid, but the balance check found it ${report.verdict === 'unwinnable' ? 'UNWINNABLE' : report.verdict === 'broken' ? 'BROKEN (bots soft-lock or the engine fails)' : report.verdict.toUpperCase().replace('_', ' ')}:`,
    ...report.reasons.slice(0, 12).map((r) => `- ${r}`),
  ];
  if (report.suggestions.length) lines.push('Suggestions:', ...report.suggestions.slice(0, 8).map((s) => `- ${s}`));
  lines.push('', 'Reply with the complete, corrected World Spec JSON (the whole value, not a patch). Keep everything that works. Output JSON only.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function errorKind(e: unknown): WorldGenerationErrorKind {
  if (e instanceof LLMTimeoutError) return 'timeout';
  if (e instanceof LLMAbortedError) return 'aborted';
  if (e instanceof StructuredOutputError) return 'invalid';
  if (e instanceof LLMError) {
    switch (e.kind) {
      case 'auth':
        return 'auth';
      case 'rate_limit':
        return 'rate_limit';
      case 'network':
        return 'network';
      case 'refusal':
        return 'refused';
      case 'config':
        return 'config';
      default:
        return 'provider';
    }
  }
  return 'provider';
}

const defaultYield = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** title / tagline from a (possibly invalid) reply, for the loading screen */
export function peekTitle(text: string): { title?: string; tagline?: string } {
  const ex = extractJson(text);
  if (ex.ok && ex.value && typeof ex.value === 'object') {
    const meta = (ex.value as { meta?: { title?: unknown; tagline?: unknown } }).meta;
    return {
      ...(typeof meta?.title === 'string' ? { title: meta.title.slice(0, 60) } : {}),
      ...(typeof meta?.tagline === 'string' ? { tagline: meta.tagline.slice(0, 140) } : {}),
    };
  }
  const t = /"title"\s*:\s*"((?:[^"\\]|\\.){1,120})"/.exec(text);
  const g = /"tagline"\s*:\s*"((?:[^"\\]|\\.){1,200})"/.exec(text);
  const un = (s: string) => {
    try {
      return JSON.parse(`"${s}"`) as string;
    } catch {
      return s;
    }
  };
  return { ...(t ? { title: un(t[1]!).slice(0, 60) } : {}), ...(g ? { tagline: un(g[1]!).slice(0, 140) } : {}) };
}

/** provider wrapper that reports every reply (for title peeking and attempt counting) */
function tap(provider: LLMProvider, onReply: (res: CompletionResponse) => void, onRequest: () => void): LLMProvider {
  return {
    id: provider.id,
    model: provider.model,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      onRequest();
      const res = await provider.complete(req);
      onReply(res);
      return res;
    },
  };
}

export async function generateWorld(opts: GenerateWorldOptions): Promise<GenerateResult> {
  const difficulty: Difficulty = opts.difficulty ?? 'normal';
  const repairs = Math.max(0, opts.repairs ?? 2);
  const feedbackRounds = Math.max(0, opts.balanceFeedback ?? 1);
  const yieldToUi = opts.yieldToUi ?? defaultYield;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let calls = 0;
  let title: string | undefined;
  let tagline: string | undefined;
  let model = opts.provider.model;

  // one controller for the whole pipeline: the caller's signal or our own deadline aborts it
  const ctrl = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const timer = timeoutMs > 0 && Number.isFinite(timeoutMs)
    ? setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, timeoutMs)
    : null;

  const progress = (p: Omit<GenerateProgress, 'attempt' | 'title' | 'tagline'> & Partial<Pick<GenerateProgress, 'title' | 'tagline'>>) => {
    opts.onProgress?.({ attempt: calls, ...(title ? { title } : {}), ...(tagline ? { tagline } : {}), ...p });
  };

  const provider = tap(
    opts.provider,
    (res) => {
      model = res.model || model;
      const peek = peekTitle(res.text);
      title = peek.title ?? title;
      tagline = peek.tagline ?? tagline;
      progress({ stage: 'received', fraction: Math.min(0.6, 0.35 + 0.1 * (calls - 1)), message: title ? `Received "${title}"` : 'Received a reply', key: 'gen.progress.received', ...(title ? { params: { title } } : {}) });
    },
    () => {
      calls++;
      if (calls === 1) progress({ stage: 'request', fraction: 0.05, message: 'Inventing the world…', key: 'gen.progress.request' });
    },
  );

  const fail = (e: unknown): never => {
    if (e instanceof WorldGenerationError) throw e;
    if (timedOut || (ctrl.signal.aborted && !opts.signal?.aborted && e instanceof LLMAbortedError)) {
      throw new WorldGenerationError('timeout', `World generation timed out after ${Math.round(timeoutMs / 1000)} s`, { attempts: calls, cause: e, retryable: true });
    }
    if (opts.signal?.aborted) throw new WorldGenerationError('aborted', 'World generation was cancelled', { attempts: calls, cause: e });
    const kind = errorKind(e);
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof StructuredOutputError) {
      throw new WorldGenerationError('invalid', `The AI did not produce a valid world after ${e.attempts} attempts`, { errors: e.errors, attempts: calls, cause: e });
    }
    throw new WorldGenerationError(kind, msg, { attempts: calls, cause: e, retryable: e instanceof LLMError && e.retryable });
  };

  const ask = async (messages: ChatMessage[]) => {
    const req = worldRequest(opts, {
      messages,
      signal: ctrl.signal,
      jsonSchema: WORLD_JSON_HINT_SCHEMA,
      schemaInPrompt: false,
      maxTokens: opts.maxTokens ?? WORLD_MAX_TOKENS,
    });
    const r = await completeStructured(provider, req, WorldSpec, {
      retries: repairs,
      validate: worldErrors,
      onAttempt: (a) => {
        if (!a.ok) {
          progress({
            stage: 'repairing',
            fraction: Math.min(0.6, 0.4 + 0.1 * a.attempt),
            message: `Fixing ${a.errors.length} problem${a.errors.length === 1 ? '' : 's'} in the world…`,
            key: 'gen.progress.repairing',
            params: { count: a.errors.length },
            errors: a.errors.length,
          });
        }
      },
    });
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    return r;
  };

  try {
    const first = worldRequest(opts);
    let messages: ChatMessage[] = first.messages;
    let res = await ask(messages).catch(fail);
    let world = finaliseWorld(res.value, opts);
    title = world.meta.title;
    tagline = world.meta.tagline;
    progress({ stage: 'validated', fraction: 0.62, message: `"${world.meta.title}" is valid`, key: 'gen.progress.validated', params: { title: world.meta.title } });

    if (opts.balance === false) {
      progress({ stage: 'done', fraction: 1, message: 'Ready', key: 'gen.progress.done' });
      return { world, report: null, attempts: calls, usage, model, tuneHistory: [], text: res.text };
    }

    let feedbackLeft = feedbackRounds;
    for (;;) {
      progress({ stage: 'balancing', fraction: 0.7, message: 'Play-testing the world with bots…', key: 'gen.progress.balancing' });
      await yieldToUi();
      if (ctrl.signal.aborted) fail(new LLMAbortedError());
      const bal = await (opts.balancer ?? balanceWorld)(world, difficulty, opts.balance ?? {}, ctrl.signal);
      if (ctrl.signal.aborted) fail(new LLMAbortedError());
      await yieldToUi();
      const rep = bal.report;
      if (!isUnplayable(rep.verdict)) {
        progress({ stage: 'done', fraction: 1, message: `Ready (bots win ${Math.round(rep.winRate * 100)}%)`, key: 'gen.progress.done', verdict: rep.verdict, winRate: rep.winRate });
        return { world: bal.world, report: rep, attempts: calls, usage, model, tuneHistory: bal.history, text: res.text };
      }
      if (feedbackLeft <= 0) {
        throw new WorldGenerationError('unbalanced', `The generated world is ${rep.verdict} and could not be fixed automatically`, {
          errors: [...rep.reasons, ...rep.suggestions.map((s) => `suggestion: ${s}`)],
          attempts: calls,
        });
      }
      feedbackLeft--;
      progress({ stage: 'feedback', fraction: 0.75, message: 'Sending balance problems back to the AI…', key: 'gen.progress.feedback', verdict: rep.verdict, winRate: rep.winRate, errors: rep.reasons.length });
      messages = [...first.messages, { role: 'assistant', content: res.text }, { role: 'user', content: balanceFeedbackMessage(rep) }];
      res = await ask(messages).catch(fail);
      world = finaliseWorld(res.value, opts);
      title = world.meta.title;
      tagline = world.meta.tagline;
      progress({ stage: 'validated', fraction: 0.8, message: `"${world.meta.title}" is valid`, key: 'gen.progress.validated', params: { title: world.meta.title } });
    }
  } catch (e) {
    return fail(e);
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}
