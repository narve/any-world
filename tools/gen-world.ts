/**
 * Generate a world with a real (or recorded) LLM through the game's own pipeline (src/llm/generate.ts):
 * prompt → provider → validate → repair turns → balance check → automatic rebalance.
 *
 *   ANTHROPIC_API_KEY=… npx tsx tools/gen-world.ts --preset anthropic --prompt "a lighthouse keeper's last winter" \
 *       [--model claude-…] [--language nb] [--difficulty normal] [--weirdness 0.5] [--seed 7] \
 *       [--seeds 16] [--rounds 2] [--no-balance] [--repairs 2] [--timeout 600] [--record] [--id my-world] [--force]
 *
 *   --preset     any preset id from src/llm/presets.ts (keys come from the preset's env var, e.g.
 *                DEEPSEEK_API_KEY; base URLs from e.g. OLLAMA_BASE_URL), or "mock" to replay
 *                content/recordings (purpose "world")
 *   --response a.json[,b.json]  with --preset mock: replay these files as the model's replies, in
 *                order (the first answer, then one per repair / balance-feedback turn); runs the whole
 *                pipeline offline on an agent-written world
 *   --record     write the result to content/worlds/<id>.json (id: --id or a slug of the title)
 *   --out <file> write the result there instead
 *   --transcript <file>  save every request and reply (JSON) for prompt tuning
 *
 * Prints progress lines, the balance report and the usage; exits 1 on WorldGenerationError (its kind
 * and problems are printed).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, str, num, difficultyArg, root } from './print-prompt';
import { getPreset } from '../src/llm/presets';
import { createDirectProvider } from '../src/llm/transport';
import { MockProvider } from '../src/llm/mock';
import { loadRecordingsFromDir } from '../src/llm/recordings-node';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../src/llm/types';
import { generateWorld, WorldGenerationError } from '../src/llm/generate';
import { worldKeyOf } from '../src/llm/recording-keys';
import { formatAnalysis } from '../src/engine/balance/index';

async function providerFor(presetId: string, model: string | undefined, timeoutMs: number, responses: string[] = []): Promise<LLMProvider> {
  if (presetId === 'mock') {
    // --response a.json[,b.json…]: serve these replies in order (first reply, then repair turns)
    if (responses.length) return new MockProvider({ responses: { world: responses.map((f) => readFileSync(f, 'utf8')) } });
    return new MockProvider({ recordings: await loadRecordingsFromDir(join(root, 'content', 'recordings')) });
  }
  const preset = getPreset(presetId);
  if (!preset) throw new Error(`unknown preset "${presetId}"`);
  const apiKey = preset.envKey ? process.env[preset.envKey] : undefined;
  const baseUrl = preset.baseUrlEnv ? process.env[preset.baseUrlEnv] : undefined;
  return createDirectProvider(preset, { apiKey, baseUrl, model }, { browser: false, timeoutMs, totalTimeoutMs: timeoutMs });
}

function recorder(inner: LLMProvider, log: { request: unknown; response?: CompletionResponse; error?: string }[]): LLMProvider {
  return {
    id: inner.id,
    model: inner.model,
    async complete(req: CompletionRequest) {
      const { signal: _s, ...plain } = req;
      void _s;
      const entry: { request: unknown; response?: CompletionResponse; error?: string } = { request: plain };
      log.push(entry);
      try {
        entry.response = await inner.complete(req);
        return entry.response;
      } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const presetId = str(args, 'preset');
  if (!presetId) throw new Error('--preset <id|mock> is required');
  const timeoutMs = num(args, 'timeout', 600) * 1000;
  const transcript: { request: unknown; response?: CompletionResponse; error?: string }[] = [];
  const provider = recorder(await providerFor(presetId, str(args, 'model'), timeoutMs, (str(args, 'response') ?? '').split(',').filter(Boolean)), transcript);
  const t0 = Date.now();
  try {
    const res = await generateWorld({
      provider,
      prompt: str(args, 'prompt') ?? '',
      language: str(args, 'language') ?? 'en',
      difficulty: difficultyArg(args),
      weirdness: num(args, 'weirdness', 0.5),
      surpriseSeed: num(args, 'seed', Date.now() % 100000),
      repairs: num(args, 'repairs', 2),
      timeoutMs,
      balance: args['no-balance'] ? false : { seeds: num(args, 'seeds', 16), rounds: num(args, 'rounds', 2) },
      onProgress: (p) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${p.stage}: ${p.message}${p.errors ? ` (${p.errors} problems)` : ''}`),
    });
    console.log(`\n"${res.world.meta.title}" — ${res.world.meta.tagline}`);
    console.log(`attempts ${res.attempts}, model ${res.model}, tokens in ${res.usage.inputTokens} / out ${res.usage.outputTokens}`);
    for (const h of res.tuneHistory) console.log(`rebalanced (round ${h.round}): ${h.changes.join('; ')}`);
    if (res.report) console.log(formatAnalysis(res.report.static, res.report));
    const outFile = str(args, 'out') ?? (args.record ? join(root, 'content', 'worlds', `${str(args, 'id') ?? worldKeyOf(res.world)}.json`) : undefined);
    if (outFile) {
      if (existsSync(outFile) && !args.force) throw new Error(`${outFile} exists (pass --force or another --id)`);
      writeFileSync(outFile, JSON.stringify(res.world, null, 2) + '\n');
      console.log(`wrote ${outFile}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof WorldGenerationError) {
      console.error(`FAILED (${e.kind}): ${e.message}`);
      for (const x of e.errors.slice(0, 30)) console.error(`  - ${x}`);
      return 1;
    }
    throw e;
  } finally {
    const tr = str(args, 'transcript');
    if (tr) {
      writeFileSync(resolve(tr), JSON.stringify(transcript, null, 2) + '\n');
      console.log(`transcript: ${tr}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
