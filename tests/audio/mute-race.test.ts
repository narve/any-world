/**
 * Regression (issues/M5-audio-mute-race.md). Review M5 round 1: audio/index.ts promises "muting suspends [the context] too, so a muted game
 * costs no CPU". A real AudioContext changes `state` only when resume() settles. Unmuting and
 * muting again before that (a quick double tap on the mute button, or the settings dialog applying
 * muted after the audio bridge unmuted on startRun) leaves the context running, with the ambience
 * oscillators playing into a zero gain, for as long as the player stays muted.
 */
import { describe, it, expect } from 'vitest';
import { createAudio, type AudioWorld } from '../../src/client/audio';
import { makeRandom } from '../../src/client/audio/theory';
import { FakeAudioContext, FakeTimers, FakeVisibility } from './fake-audio';

const world: AudioWorld = {
  meta: { title: 'Race World' },
  audio: {
    mood: 'dusty strings',
    synth: { key: 'D', scale: 'dorian', tempo: 100, timbre: 'pluck', drone: true, percussion: 'electronic', brightness: 0.5 },
    searchTerms: ['ambient'],
    suggestions: [],
  },
  areas: [{ music: 'calm' }],
};

/** like a browser: resume() / suspend() change `state` asynchronously, when they settle */
class AsyncStateContext extends FakeAudioContext {
  override async resume() {
    this.resumeCalls++;
    await new Promise((r) => setTimeout(r, 5));
    if (this.state !== 'closed') this.state = 'running';
  }
  override async suspend() {
    this.suspendCalls++;
    await new Promise((r) => setTimeout(r, 5));
    if (this.state !== 'closed') this.state = 'suspended';
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('mute right after unmute', () => {
  it('ends suspended when the last call was mute(true)', async () => {
    const ctx = new AsyncStateContext();
    const timers = new FakeTimers();
    const audio = createAudio(world, { volume: 0.5, muted: true }, {
      createContext: () => ctx as unknown as AudioContext,
      timers,
      doc: new FakeVisibility() as unknown as Document,
      random: makeRandom(3),
    });
    await audio.unlock();
    await settle();
    expect(ctx.state).toBe('suspended');

    audio.mute(false);
    audio.mute(true);
    await settle();

    expect(audio.muted).toBe(true);
    expect(ctx.state).toBe('suspended');
  });

  function setup() {
    const ctx = new AsyncStateContext();
    const audio = createAudio(world, { volume: 0.5, muted: false }, {
      createContext: () => ctx as unknown as AudioContext,
      timers: new FakeTimers(),
      doc: new FakeVisibility() as unknown as Document,
      random: makeRandom(3),
    });
    return { ctx, audio };
  }

  it('ends running when the last call was mute(false) (mute then unmute before suspend settles)', async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    await settle();
    expect(ctx.state).toBe('running');

    audio.mute(true);
    audio.mute(false);
    await settle();

    expect(audio.muted).toBe(false);
    expect(ctx.state).toBe('running');
  });

  it('follows the last of many rapid toggles', async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    await settle();
    for (let i = 0; i < 7; i++) audio.mute(i % 2 === 0);
    await settle();
    await settle();
    expect(audio.muted).toBe(true);
    expect(ctx.state).toBe('suspended');
  });
});
