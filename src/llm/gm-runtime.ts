/**
 * The LLM game master at runtime (DESIGN §4.3): `LlmGmDirector` implements the client's
 * `GmDirector` (src/client/gm-director.ts) and `LlmDialogue` voices NPC conversations.
 *
 *  - Never blocks turns: the client's GmRunner queues requests, times them out and drops stale
 *    answers by epoch; this module only answers one request, honouring `req.signal`.
 *  - Every answer is checked like a world: zod (GmResponse / DialogueResponse), then the actions are
 *    dry-run through the engine (applyGmActions on the snapshot: references, budget, rule limits);
 *    refusals are sent back to the model for one repair turn. If the model still fails, the valid
 *    actions of its last reply are kept, and otherwise the offline director answers.
 *  - Discipline the model cannot be trusted with is enforced here too: a ceiling on helpful actions
 *    per area (HELPFUL_CEILING by difficulty, the M2 "helpful ceiling" known issue) and the hook rules
 *    (death / victory only narrate).
 *  - Demo mode: `createDemoGm` serves recorded responses (content/recordings/<worldKey>/, see
 *    recording-keys.ts) through the MockProvider, each recorded moment once, and falls back to the
 *    offline director / canned NPC lines when nothing is recorded.
 */
import { z } from 'zod';
import { DialogueResponse, GmResponse, type GmAction, type GmHook } from '../schema/gm';
import type { GameState } from '../engine/types';
import {
  applyHelpCeiling,
  dialogueJsonSchema,
  dialogueResponseErrors,
  dropTrades,
  gmJsonSchema,
  gmResponseErrors,
  keepValidActions,
  npcStock,
} from './gm-checks';
import { OfflineGmDirector, sanitizeResponse, type GmDirector, type GmRequest } from '../client/gm-director';
import type { LLMProvider } from './types';
import { LLMAbortedError } from './errors';
import { completeStructured, extractJson, StructuredOutputError } from './structured';
import { gmRequest, HELPFUL_CEILING } from './prompts/gm';
import { dialogueRequest, npcOf, type DialogueLine, type DialoguePromptInput } from './prompts/dialogue';
import { dialoguePurpose, gmPurpose, worldKeyOf } from './recording-keys';
import { MockProvider, type Recording } from './mock';

/** salvage the parseable, valid part of a failed reply */
function salvage<T extends { actions: GmAction[] }>(text: string, schema: z.ZodType<T>, keep: (v: T) => T): T | null {
  const ex = extractJson(text);
  if (!ex.ok) return null;
  const p = schema.safeParse(ex.value);
  if (p.success) return keep(p.data);
  // last resort: keep the actions that parse on their own
  const raw = ex.value as { actions?: unknown[] } | null;
  if (!raw || !Array.isArray(raw.actions)) return null;
  const actions: GmAction[] = [];
  for (const a of raw.actions) {
    const one = GmResponse.safeParse({ actions: [a] });
    if (one.success) actions.push(one.data.actions[0]!);
  }
  const whole = schema.safeParse({ ...(raw as object), actions });
  return whole.success ? keep(whole.data) : null;
}

// ---------------------------------------------------------------------------
// Help ledger (per run and area)
// ---------------------------------------------------------------------------

class HelpLedger {
  private used = new Map<string, number>();
  private key(state: GameState): string {
    return `${state.worldId}:${state.seed}:${state.area.index}`;
  }
  get(state: GameState): number {
    return this.used.get(this.key(state)) ?? 0;
  }
  add(state: GameState, n: number): void {
    if (n <= 0) return;
    const k = this.key(state);
    this.used.set(k, (this.used.get(k) ?? 0) + n);
    if (this.used.size > 64) this.used.delete(this.used.keys().next().value!);
  }
}

// ---------------------------------------------------------------------------
// GM director
// ---------------------------------------------------------------------------

export interface LlmGmDirectorOptions {
  provider: LLMProvider;
  /** recordings key of the world (a bundled world's file id); default worldKeyOf(world) */
  worldKey?: string;
  /** answers when the model fails (default: the offline director); null = answer nothing */
  fallback?: GmDirector | null;
  /** repair turns after a bad reply (default 1: GM moments should be quick) */
  retries?: number;
  /** errors (logging only; the director never throws them) */
  onError?: (err: unknown, hook: GmHook) => void;
  /** shared with LlmDialogue so gifts in conversations and GM moments share one ceiling */
  ledger?: HelpLedger;
  maxTokens?: number;
  /**
   * Time the model gets before the director gives up on it and answers through its (capped)
   * fallback itself (default DEFAULT_GM_DEADLINE_MS). Keep it below the GmRunner's timeout: the
   * runner's own fallback answers outside this director and so outside the help ceiling.
   */
  deadlineMs?: number;
}

/** default LlmGmDirectorOptions.deadlineMs; below the client's live GM timeout (30 s) */
export const DEFAULT_GM_DEADLINE_MS = 20000;

/**
 * A director whose answers pass the same checks as the model's: goal protection and engine dry
 * run (keepValidActions), then the area's help ceiling, charged to `ledger`. Used for the LLM
 * director's offline fallback, and usable as the GmRunner's fallback so a timeout cannot hand out
 * help past the ceiling either (share the LLM director's ledger).
 */
export class CappedGmDirector implements GmDirector {
  readonly name: string;
  constructor(
    private readonly inner: GmDirector,
    readonly ledger: HelpLedger,
  ) {
    this.name = inner.name;
  }

  async respond(req: GmRequest): Promise<GmResponse | null> {
    const r = await this.inner.respond(req);
    return r ? capResponse(this.ledger, req, r.actions) : null;
  }
}

/** goal protection + engine checks + help ceiling (charged to the ledger) for one answer */
function capResponse(ledger: HelpLedger, req: GmRequest, actions: readonly GmAction[]): GmResponse | null {
  const { world, state, difficulty } = req.ctx;
  const valid = keepValidActions(world, state, actions, req.hook);
  const ceiling = HELPFUL_CEILING[difficulty] ?? 2;
  const capped = applyHelpCeiling(world, valid, Math.max(0, ceiling - ledger.get(state)), state);
  ledger.add(state, capped.used);
  return capped.actions.length ? sanitizeResponse({ actions: capped.actions }) : null;
}

export class LlmGmDirector implements GmDirector {
  readonly name: string;
  readonly ledger: HelpLedger;
  private readonly fallback: GmDirector | null;

  constructor(private readonly opts: LlmGmDirectorOptions) {
    this.name = `llm:${opts.provider.id}`;
    this.ledger = opts.ledger ?? new HelpLedger();
    const fb = opts.fallback === undefined ? new OfflineGmDirector() : opts.fallback;
    this.fallback = fb ? this.capped(fb) : null;
  }

  /** `d` behind this director's checks and help ceiling (e.g. the GmRunner's fallback) */
  capped(d: GmDirector): GmDirector {
    return d instanceof CappedGmDirector && d.ledger === this.ledger ? d : new CappedGmDirector(d, this.ledger);
  }

  async respond(req: GmRequest): Promise<GmResponse | null> {
    const { world, state, difficulty } = req.ctx;
    const worldKey = this.opts.worldKey ?? worldKeyOf(world);
    const helpfulUsed = this.ledger.get(state);
    const ceiling = HELPFUL_CEILING[difficulty] ?? 2;
    const input = {
      world,
      state,
      difficulty,
      weirdness: req.ctx.weirdness,
      recentLog: req.ctx.recentLog,
      areaEnteredTurn: req.ctx.areaEnteredTurn,
      hook: req.hook,
      area: req.area,
      turn: req.turn,
      detail: req.detail,
      helpfulUsed,
    };
    const request = gmRequest(input, gmPurpose(req.hook, worldKey, req.area), {
      signal: req.signal,
      jsonSchema: gmJsonSchema(),
      schemaInPrompt: false,
      ...(this.opts.maxTokens ? { maxTokens: this.opts.maxTokens } : {}),
    });
    let actions: GmAction[] | null = null;
    // the model's own deadline (below the runner's timeout): past it the capped fallback answers here
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      ctrl.abort();
    }, this.opts.deadlineMs ?? DEFAULT_GM_DEADLINE_MS);
    try {
      const r = await completeStructured(this.opts.provider, { ...request, signal: ctrl.signal }, GmResponse, {
        retries: this.opts.retries ?? 1,
        validate: (v) => gmResponseErrors(world, state, v, req.hook),
      });
      actions = r.value.actions;
    } catch (e) {
      if (req.signal.aborted) return null;
      if (e instanceof LLMAbortedError && !late) return null;
      this.opts.onError?.(e, req.hook);
      if (e instanceof StructuredOutputError && e.lastText) {
        const s = salvage(e.lastText, GmResponse, (v) => ({ actions: keepValidActions(world, state, v.actions, req.hook) }));
        if (s && s.actions.length) actions = s.actions;
      }
      if (!actions) return this.fallback ? this.fallback.respond(req) : null;
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
    }
    // re-read the shared ledger: an NPC voice turn (or another director) may have spent help while
    // this request was in flight, and `helpfulUsed` above is the number from before the await
    const capped = applyHelpCeiling(world, actions, Math.max(0, ceiling - this.ledger.get(state)), state);
    this.ledger.add(state, capped.used);
    return capped.actions.length ? sanitizeResponse({ actions: capped.actions }) : null;
  }
}

// ---------------------------------------------------------------------------
// Dialogue
// ---------------------------------------------------------------------------

export interface DialogueTurnInput extends DialoguePromptInput {
  signal?: AbortSignal;
}

export interface DialogueTurnResult {
  response: DialogueResponse;
  source: 'llm' | 'offline';
}

/**
 * Canned conversation for offline / demo play: the greeting first, then the NPC's lines in order
 * (one per turn), then a farewell that ends the talk. Deterministic.
 */
export function offlineDialogueTurn(input: Pick<DialoguePromptInput, 'world' | 'state' | 'npcId' | 'history'>): DialogueResponse {
  const found = npcOf(input.world, input.state, input.npcId);
  const npc = found?.def.npc;
  const said = new Set((input.history ?? []).filter((h) => h.speaker === 'npc').map((h) => h.text));
  const lines = npc ? [npc.greeting, ...npc.lines] : [];
  const next = lines.find((l) => !said.has(l));
  if (!next) return { reply: lines[lines.length - 1] ?? '…', options: [], actions: [], end: true };
  return { reply: next, options: [], actions: [], end: false };
}

export interface LlmDialogueOptions {
  provider: LLMProvider;
  worldKey?: string;
  retries?: number;
  onError?: (err: unknown) => void;
  ledger?: HelpLedger;
  maxTokens?: number;
}

export class LlmDialogue {
  readonly ledger: HelpLedger;
  constructor(private readonly opts: LlmDialogueOptions) {
    this.ledger = opts.ledger ?? new HelpLedger();
  }

  /** one NPC turn; never throws (falls back to canned lines) except when aborted */
  async turn(input: DialogueTurnInput): Promise<DialogueTurnResult> {
    const { world, state } = input;
    const found = npcOf(world, state, input.npcId);
    const worldKey = this.opts.worldKey ?? worldKeyOf(world);
    const helpfulUsed = this.ledger.get(state);
    const ceiling = HELPFUL_CEILING[input.difficulty] ?? 2;
    const request = dialogueRequest({ ...input, helpfulUsed }, dialoguePurpose(worldKey, found?.def.id ?? input.npcId), {
      ...(input.signal ? { signal: input.signal } : {}),
      jsonSchema: dialogueJsonSchema(),
      schemaInPrompt: false,
      ...(this.opts.maxTokens ? { maxTokens: this.opts.maxTokens } : {}),
    });
    let resp: DialogueResponse | null = null;
    try {
      const r = await completeStructured(this.opts.provider, request, DialogueResponse, {
        retries: this.opts.retries ?? 1,
        validate: (v) => dialogueResponseErrors(world, state, input.npcId, v),
      });
      resp = r.value;
    } catch (e) {
      if (input.signal?.aborted || e instanceof LLMAbortedError) throw e;
      this.opts.onError?.(e);
      if (e instanceof StructuredOutputError && e.lastText) {
        resp = salvage(e.lastText, DialogueResponse, (v) => ({
          ...v,
          actions: keepValidActions(world, state, v.actions, undefined, npcStock(world, state, input.npcId)),
          options: v.end ? [] : v.options,
        }));
        if (resp && !resp.reply.trim()) resp = null;
      }
    }
    if (!resp) return { response: offlineDialogueTurn(input), source: 'offline' };
    resp = dropTrades(resp);
    // re-read the shared ledger after the await (a GM moment may have spent help meanwhile)
    const capped = applyHelpCeiling(world, resp.actions, Math.max(0, ceiling - this.ledger.get(state)), state);
    this.ledger.add(state, capped.used);
    return { response: { ...resp, actions: capped.actions }, source: 'llm' };
  }
}

// ---------------------------------------------------------------------------
// Demo mode (recordings)
// ---------------------------------------------------------------------------

export interface DemoGmOptions {
  /** recordings for this world (content/recordings/<worldKey>/*.json) */
  recordings: Recording[];
  /** the bundled world's id (its recordings directory) */
  worldKey: string;
  fallback?: GmDirector | null;
  onError?: (err: unknown) => void;
}

/**
 * GM director + dialogue for demo mode: recorded responses served once per recorded moment; a
 * moment without a recording (or with an invalid one) falls back to the offline director / canned
 * NPC lines. No repair turns (a recording cannot fix itself).
 */
export function createDemoGm(opts: DemoGmOptions): { director: LlmGmDirector; dialogue: LlmDialogue; provider: MockProvider } {
  const provider = new MockProvider({ recordings: opts.recordings, repeatLast: false, matchPrefix: false, maxCalls: 0, model: 'recorded' });
  const ledger = new HelpLedger();
  const director = new LlmGmDirector({
    provider,
    worldKey: opts.worldKey,
    retries: 0,
    ledger,
    fallback: opts.fallback === undefined ? new OfflineGmDirector() : opts.fallback,
    ...(opts.onError ? { onError: (e: unknown) => opts.onError!(e) } : {}),
  });
  const dialogue = new LlmDialogue({ provider, worldKey: opts.worldKey, retries: 0, ledger, ...(opts.onError ? { onError: opts.onError } : {}) });
  return { director, dialogue, provider };
}

export { HelpLedger, type DialogueLine };
export {
  isHelpfulAction,
  goalWriteProblem,
  goalRefs,
  applyHelpCeiling,
  gmActionProblems,
  gmResponseErrors,
  dialogueResponseErrors,
  keepValidActions,
  gmJsonSchema,
  dialogueJsonSchema,
  type GmCheckOptions,
} from './gm-checks';
