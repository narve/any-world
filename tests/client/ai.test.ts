/**
 * Client AI wiring (src/client/ai.ts): provider selection from settings, the per-run GM director /
 * NPC voice (live, demo, offline), the world-generation loading view, and the session's NPC voice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameState, Pos } from '../../src/engine/types';
import { MockProvider, type Recording } from '../../src/llm/mock';
import { LlmDialogue } from '../../src/llm/gm-runtime';
import { WorldGenerationError } from '../../src/llm/generate';
import { providerFromSettings, runAi, voiceTurn, WorldGeneration } from '../../src/client/ai';
import { GameSession } from '../../src/client/session';
import { loadFixture, roomMap } from '../engine/helpers';
import { leadPlayer } from '../../src/engine';

const teenText = readFileSync(join(__dirname, '../../content/worlds/fixture-teen.json'), 'utf8');
const western = loadFixture('fixture-western.json');

describe('providerFromSettings', () => {
  it('needs a key for direct presets that need one, and a configured server preset for backend', () => {
    expect(providerFromSettings({ preset: 'anthropic', transport: 'direct' }, null)).toBeNull();
    expect(providerFromSettings({ preset: 'anthropic', transport: 'direct', apiKey: 'sk-test' }, null)).not.toBeNull();
    expect(providerFromSettings({ preset: 'anthropic', transport: 'backend' }, null)).toBeNull();
    expect(providerFromSettings({ preset: 'anthropic', transport: 'backend' }, new Set(['openai']))).toBeNull();
    expect(providerFromSettings({ preset: 'anthropic', transport: 'backend' }, new Set(['anthropic']))?.id).toBe('backend:anthropic');
  });

  it('never offers the mock preset or unknown presets as a world builder', () => {
    expect(providerFromSettings({ preset: 'mock', transport: 'direct' }, null)).toBeNull();
    expect(providerFromSettings({ preset: 'no-such-preset', transport: 'direct', apiKey: 'x' }, null)).toBeNull();
  });
});

describe('runAi', () => {
  it('live with a provider, demo with recordings, offline otherwise', async () => {
    const live = await runAi({ provider: new MockProvider(), worldId: 'fixture-teen' });
    expect(live.mode).toBe('live');
    expect(live.director).not.toBeNull();
    expect(live.dialogue).not.toBeNull();

    const rec: Recording[] = [{ purpose: 'gm:intro/fixture-teen/a0', json: { actions: [{ type: 'narrate', text: 'Monday.' }] } }];
    let asked = '';
    const demo = await runAi({
      provider: null,
      worldId: 'fixture-teen',
      loadRecordings: async (id) => {
        asked = id;
        return rec;
      },
    });
    expect(asked).toBe('fixture-teen');
    expect(demo.mode).toBe('demo');

    const off = await runAi({ provider: null, worldId: 'gen-x', loadRecordings: async () => [] });
    expect(off).toMatchObject({ mode: 'offline', director: null, dialogue: null });

    const broken = await runAi({ provider: null, worldId: 'x', loadRecordings: async () => Promise.reject(new Error('404')), onError: () => {} });
    expect(broken.mode).toBe('offline');
  });
});

describe('WorldGeneration (loading screen)', () => {
  it('generates through repair turns and shows the steps, title and tagline', async () => {
    const broken = JSON.parse(teenText);
    delete broken.meta.title;
    const provider = new MockProvider({ responses: { world: [JSON.stringify(broken), teenText] } });
    let changes = 0;
    const gen = new WorldGeneration(
      provider,
      { prompt: 'teen drama', surprise: false, difficulty: 'normal', weirdness: 0.4, language: 'en' },
      { balance: false, onChange: () => changes++ },
    );
    const world = await gen.run();
    expect(world.meta.title).toBe('Lowmoor Goes Under');
    expect(world.meta.prompt).toBe('teen drama');
    const v = gen.view();
    expect(changes).toBeGreaterThan(2);
    expect(v.title).toBe('Lowmoor Goes Under');
    expect(v.tagline).toBeTruthy();
    expect(v.error).toBeNull();
    expect(v.steps.length).toBeGreaterThanOrEqual(3);
    expect(v.steps.every((s) => s.status === 'done')).toBe(true);
    // the catalog labels the steps (no raw keys)
    expect(v.steps.some((s) => /Fixing 1 problem/.test(s.label))).toBe(true);
    expect(v.steps.every((s) => !s.label.startsWith('gen.'))).toBe(true);
  });

  it('a failure stays on the loading screen with a readable error and a retry', async () => {
    const provider = new MockProvider({ responses: { world: 'I would rather not.' } });
    const gen = new WorldGeneration(provider, { prompt: '', surprise: true, difficulty: 'normal', weirdness: 0.4, language: 'en', surpriseSeed: 3 }, { balance: false });
    await expect(gen.run()).rejects.toBeInstanceOf(WorldGenerationError);
    const v = gen.view();
    expect(v.error).toMatch(/valid world/);
    expect(v.canRetry).toBe(true);
    expect(v.canCancel).toBe(true);
    expect(v.steps.some((s) => s.status === 'error')).toBe(true);
  });

  it('cancelling aborts and offers no retry', async () => {
    const provider = new MockProvider({ responses: { world: teenText }, latencyMs: 200 });
    const gen = new WorldGeneration(provider, { prompt: 'x', surprise: false, difficulty: 'normal', weirdness: 0.4, language: 'en' }, { balance: false });
    const p = gen.run();
    gen.cancel();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
    expect(gen.view().canRetry).toBe(false);
  });
});

describe('NPC voice in the session', () => {
  function talking(): { s: GameSession; npcId: string } {
    const s = new GameSession({ world: western, worldId: 'fixture-western', seed: 1, map: roomMap(14, 10) });
    const st = structuredClone(s.state) as GameState;
    const me: Pos = { x: 5, y: 5 };
    st.area.actors = st.area.actors.filter((a) => a.id === leadPlayer(st).actorId || a.defId === 'widow-oquendo');
    st.area.actors.find((a) => a.id === leadPlayer(st).actorId)!.pos = me;
    const npc = st.area.actors.find((a) => a.defId === 'widow-oquendo')!;
    npc.pos = { x: 6, y: 5 };
    s.state = st;
    s.act({ type: 'wait' });
    s.intent({ type: 'talk' });
    return { s, npcId: npc.id };
  }

  it('asks for a turn when a conversation opens, shows the voiced line, and drops stale answers', () => {
    const { s, npcId } = talking();
    expect(leadPlayer(s.state).pendingChoice?.kind).toBe('dialogue');
    const engineLine = s.viewModel().game!.dialogue!.reply;
    const req = s.takeVoiceRequest();
    expect(req).toMatchObject({ npcId });
    expect(req!.playerLine).toBeUndefined();
    expect(s.takeVoiceRequest()).toBeNull(); // taken once

    s.setVoice(req!.token, { reply: 'Rain is a debt, stranger.', actions: [] });
    expect(s.viewModel().game!.dialogue!.reply).toBe('Rain is a debt, stranger.');
    expect(leadPlayer(s.state).pendingChoice!.prompt).toBe(engineLine); // the engine state is untouched

    // "Ask what they know": the conversation stays open with the engine's answer as the line, and
    // the next turn asks the voice with the player's question; a late answer to the old turn is dropped
    const asked = s.viewModel().game!.dialogue!.options[0];
    s.dialogueReply(0);
    expect(leadPlayer(s.state).pendingChoice?.kind).toBe('dialogue');
    const next = s.takeVoiceRequest();
    expect(next!.token).toBeGreaterThan(req!.token);
    expect(next!.playerLine).toBe(asked);
    expect(s.setVoice(req!.token, { reply: 'stale', actions: [] }).changed).toBe(false);
    expect(s.voiceLine()).not.toBe('stale');
    expect(s.voiceLine()).toBe(s.state.log[s.state.log.length - 1].text);
    // leaving ends it; talking again is a new conversation and a new turn
    s.dialogueLeave();
    expect(leadPlayer(s.state).pendingChoice).toBeNull();
    expect(s.voiceLine()).toBeNull();
    s.intent({ type: 'talk' });
    const again = s.takeVoiceRequest();
    expect(again!.token).toBeGreaterThan(next!.token);
    expect(again!.history).toEqual([]);
    expect(s.viewModel().game!.dialogue!.reply).toBe(leadPlayer(s.state).pendingChoice!.prompt);
  });

  it('keeps the voice when the shop reopens the conversation after a purchase', () => {
    const { s, npcId } = talking();
    const req = s.takeVoiceRequest()!;
    s.setVoice(req.token, { reply: 'Buy or go.', actions: [] });
    s.intent({ type: 'open_trade', npcId });
    s.state = { ...s.state, purse: 500 };
    s.trade({ type: 'buy', offerIndex: 0 });
    expect(leadPlayer(s.state).pendingChoice?.kind).toBe('dialogue');
    expect(s.takeVoiceRequest()).toBeNull();
    expect(s.voiceLine()).toBe('Buy or go.');
    expect(s.viewModel().game!.trade).toBeTruthy();
  });

  it('applies the voice actions through the GM path', () => {
    const { s } = talking();
    const req = s.takeVoiceRequest()!;
    const before = s.state.purse;
    const out = s.setVoice(req.token, { reply: 'Take this.', actions: [{ type: 'currency', amount: 5 }] });
    expect(out.changed).toBe(true);
    expect(s.state.purse).toBe(before + 5);
  });

  it('voiceTurn uses the LLM line and ignores canned fallbacks', async () => {
    const { s } = talking();
    const req = s.takeVoiceRequest()!;
    const ctx = { world: s.world, state: s.state, difficulty: s.difficulty };
    const good = new LlmDialogue({ provider: new MockProvider({ responses: { dialogue: JSON.stringify({ reply: 'Evening.', options: [], actions: [], end: false }) } }) });
    expect((await voiceTurn(good, req, ctx))?.response.reply).toBe('Evening.');
    const failing = new LlmDialogue({ provider: new MockProvider(), retries: 0, onError: () => {} });
    expect(await voiceTurn(failing, req, ctx)).toBeNull();
  });
});
