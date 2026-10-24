import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ambience, CROSSFADE, LOOKAHEAD } from '../../src/client/audio/ambience';
import { createAudio, installUnlock, type AudioWorld } from '../../src/client/audio';
import { makeRandom } from '../../src/client/audio/theory';
import { FakeAudioContext, FakeGain, FakeNode, FakeTimers, FakeVisibility, flush } from './fake-audio';

const world: AudioWorld = {
  meta: { title: 'Test World' },
  audio: {
    mood: 'dusty strings',
    synth: { key: 'D', scale: 'dorian', tempo: 100, timbre: 'pluck', drone: true, percussion: 'electronic', brightness: 0.5 },
    searchTerms: ['desert ambient'],
    suggestions: [],
  },
  areas: [{ music: 'calm' }, { music: 'boss' }],
};

function setup(settings = {}) {
  const ctx = new FakeAudioContext();
  const timers = new FakeTimers();
  const doc = new FakeVisibility();
  let made = 0;
  const audio = createAudio(world, { volume: 0.5, muted: false, ...settings }, {
    createContext: () => {
      made++;
      return ctx as unknown as AudioContext;
    },
    timers,
    doc: doc as unknown as Document,
    random: makeRandom(7),
  });
  return { ctx, timers, doc, audio, made: () => made };
}

/** run the scheduler for `seconds` of audio time */
function play(ctx: FakeAudioContext, timers: FakeTimers, seconds: number) {
  for (let t = 0; t < seconds; t += 0.1) {
    ctx.advance(0.1);
    timers.fire();
  }
}

describe('Ambience', () => {
  function amb(synth = world.audio.synth) {
    const ctx = new FakeAudioContext();
    ctx.state = 'running';
    const bus = new FakeNode(ctx, 'bus');
    const a = new Ambience(ctx as unknown as AudioContext, bus as unknown as AudioNode, synth, { random: makeRandom(3) });
    return { ctx, a };
  }

  it('schedules notes only within the look-ahead window', () => {
    const { ctx, a } = amb();
    a.start('explore');
    a.tick();
    const first = ctx.notes();
    expect(first.length).toBeGreaterThan(0);
    for (const s of first) expect(s.startTime!).toBeLessThanOrEqual(ctx.currentTime + LOOKAHEAD + 0.06);
    // ticking again without time passing schedules nothing new
    const n = ctx.started.length;
    a.tick();
    expect(ctx.started.length).toBe(n);
    for (let i = 0; i < 100; i++) {
      ctx.advance(0.1);
      a.tick();
    }
    // percussion (electronic kick+hat) and melody play over 10 s at 100 bpm
    expect(ctx.started.length).toBeGreaterThan(40);
    expect(a.budget.active).toBeLessThanOrEqual(a.budget.max);
  });

  it('crossfades to a new mood and tears the old layer down', () => {
    const { ctx, a } = amb();
    a.start('calm', 0.5);
    a.tick();
    const oldLayerGains = ctx.nodes.filter((n) => n instanceof FakeGain);
    ctx.advance(1);
    a.setMood('boss');
    expect(a.mood).toBe('boss');
    expect(a.arrangement!.mood).toBe('boss');
    // old layer output ramps to ~0 over the crossfade, new one ramps up
    const oldOut = oldLayerGains[0] as FakeGain;
    const lastOld = oldOut.gain.events[oldOut.gain.events.length - 1];
    expect(lastOld.kind).toBe('linear');
    expect(lastOld.value).toBeLessThan(0.001);
    expect(lastOld.time).toBeCloseTo(1 + CROSSFADE);
    for (let i = 0; i < 40; i++) {
      ctx.advance(0.1);
      a.tick();
    }
    expect(oldOut.disconnected).toBe(true);
    // same mood again: nothing changes
    const n = ctx.nodes.length;
    a.setMood('boss');
    expect(ctx.nodes.length).toBe(n);
  });

  it('never bursts to catch up after a stall', () => {
    const { ctx, a } = amb();
    a.start('boss');
    a.tick();
    const n = ctx.started.length;
    ctx.advance(30); // tab was frozen
    a.tick();
    const late = ctx.started.length - n;
    expect(late).toBeLessThan(20);
    for (const s of ctx.notes(30)) expect(s.startTime!).toBeLessThan(30 + LOOKAHEAD + 0.2);
  });

  it('plays every timbre, scale and percussion without throwing', () => {
    const timbres = ['pad', 'pluck', 'bell', 'organ', 'string', 'chip', 'noise', 'brass'] as const;
    const percs = ['none', 'soft', 'tribal', 'electronic', 'clockwork', 'heartbeat'] as const;
    const scales = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'pentatonic', 'blues', 'whole_tone', 'chromatic'] as const;
    for (let i = 0; i < timbres.length; i++) {
      for (const mood of ['explore', 'tense', 'calm', 'eerie', 'boss', 'upbeat'] as const) {
        const { ctx, a } = amb({ key: 'C#', scale: scales[i], tempo: 60 + i * 15, timbre: timbres[i], drone: i % 2 === 0, percussion: percs[i % percs.length], brightness: i / 8 });
        a.start(mood);
        for (let k = 0; k < 30; k++) {
          ctx.advance(0.1);
          a.tick();
        }
        expect(ctx.started.length).toBeGreaterThan(0);
        a.dispose();
      }
    }
  });
});

describe('createAudio', () => {
  it('is silent and context-free until unlocked by a gesture', async () => {
    const { audio, made, timers } = setup();
    audio.onEvents([{ type: 'item_picked', itemId: 'i', defId: 'lamp' }], 'p');
    audio.setMood('eerie');
    expect(made()).toBe(0);
    expect(audio.unlocked).toBe(false);
    expect(timers.active).toBe(0);
    expect(audio.mood).toBe('eerie');
    expect(await audio.unlock()).toBe(true);
    expect(made()).toBe(1);
    expect(audio.unlocked).toBe(true);
    expect(timers.active).toBe(1);
    // unlocking again reuses the context
    expect(await audio.unlock()).toBe(true);
    expect(made()).toBe(1);
  });

  it('plays sfx for events once running', async () => {
    const { audio, ctx } = setup();
    await audio.unlock();
    const before = ctx.started.length;
    audio.onEvents([{ type: 'attacked', attackerId: 'p', targetId: 'rat', hit: true, damage: 2, damageType: 'x', ranged: false }], 'p');
    expect(ctx.started.length).toBeGreaterThan(before);
  });

  it('throttles rapid footsteps', async () => {
    const { audio, ctx } = setup({ music: false });
    await audio.unlock();
    const mv = { type: 'moved' as const, actorId: 'p', from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
    const n0 = ctx.started.length;
    audio.onEvents([mv], 'p');
    const n1 = ctx.started.length;
    audio.onEvents([mv], 'p');
    expect(ctx.started.length).toBe(n1);
    ctx.advance(0.2);
    audio.onEvents([mv], 'p');
    expect(n1).toBeGreaterThan(n0);
    expect(ctx.started.length).toBeGreaterThan(n1);
  });

  it('follows area music and GM moods', async () => {
    const { audio, ctx, timers } = setup();
    await audio.unlock();
    expect(audio.mood).toBe('calm');
    audio.onEvents([{ type: 'area_entered', index: 1 }]);
    expect(audio.mood).toBe('boss');
    audio.onGmActions([{ type: 'mood', music: 'upbeat' }]);
    expect(audio.mood).toBe('upbeat');
    play(ctx, timers, 3);
    expect(ctx.started.length).toBeGreaterThan(5);
  });

  it('volume and mute drive the master gain; mute suspends the context and the clock', async () => {
    const { audio, ctx, timers } = setup();
    await audio.unlock();
    const master = ctx.nodes.find((n) => n instanceof FakeGain && n.outputs.some((o) => (o as FakeNode).kind === 'compressor')) as FakeGain;
    expect(master.gain.value).toBeCloseTo(0.25);
    audio.setVolume(1);
    expect(master.gain.value).toBeCloseTo(1);
    audio.setVolume(7);
    expect(audio.volume).toBe(1);
    audio.mute(true);
    await flush();
    expect(master.gain.value).toBe(0);
    expect(ctx.state).toBe('suspended');
    expect(timers.active).toBe(0);
    const n = ctx.started.length;
    audio.onEvents([{ type: 'item_picked', itemId: 'i', defId: 'x' }], 'p');
    expect(ctx.started.length).toBe(n);
    audio.mute(false);
    await flush();
    expect(ctx.state).toBe('running');
    expect(timers.active).toBe(1);
    expect(master.gain.value).toBeCloseTo(1);
  });

  it('starts muted from settings but still unlocks', async () => {
    const { audio, ctx, timers } = setup({ muted: true });
    expect(await audio.unlock()).toBe(true);
    expect(ctx.state).toBe('suspended');
    expect(timers.active).toBe(0);
    audio.mute(false);
    await flush();
    expect(ctx.state).toBe('running');
  });

  it('pauses while the tab is hidden', async () => {
    const { audio, ctx, timers, doc } = setup();
    await audio.unlock();
    doc.set(true);
    await flush();
    expect(ctx.state).toBe('suspended');
    expect(timers.active).toBe(0);
    doc.set(false);
    await flush();
    expect(ctx.state).toBe('running');
    expect(timers.active).toBe(1);
  });

  it('ambience and sfx toggles are independent', async () => {
    const { audio, ctx, timers } = setup();
    await audio.unlock();
    audio.setAmbience(false);
    expect(timers.active).toBe(0);
    ctx.advance(2);
    const n = ctx.started.length;
    audio.onEvents([{ type: 'item_picked', itemId: 'i', defId: 'x' }], 'p');
    expect(ctx.started.length).toBeGreaterThan(n);
    audio.setSfx(false);
    const m = ctx.started.length;
    audio.play('levelup');
    expect(ctx.started.length).toBe(m);
    audio.applySettings({ music: true, sfx: true });
    await flush();
    expect(audio.ambience).toBe(true);
    expect(audio.sfx).toBe(true);
    expect(timers.active).toBe(1);
  });

  it('ducking stops the generated music and un-ducking brings it back', async () => {
    const { audio, ctx, timers } = setup();
    await audio.unlock();
    audio.duck(true);
    ctx.advance(3);
    const n = ctx.started.length;
    timers.fire();
    expect(ctx.started.length).toBe(n);
    audio.duck(false);
    await flush();
    play(ctx, timers, 2);
    expect(ctx.started.length).toBeGreaterThan(n);
  });

  it('degrades: no WebAudio, blocked resume, disposed', async () => {
    const none = createAudio(world, {}, { createContext: undefined, doc: new FakeVisibility() as unknown as Document, timers: new FakeTimers() });
    // node has no AudioContext global
    expect(none.supported).toBe(false);
    expect(await none.unlock()).toBe(false);
    none.onEvents([{ type: 'level_up', level: 2, choices: [] }], 'p');
    none.setMood('boss');
    none.mute();
    none.dispose();

    const { audio, ctx } = setup();
    ctx.blockResume = true;
    expect(await audio.unlock()).toBe(false);
    audio.onEvents([{ type: 'level_up', level: 2, choices: [] }], 'p');

    const s = setup();
    await s.audio.unlock();
    s.audio.dispose();
    expect(s.ctx.state).toBe('closed');
    expect(s.timers.active).toBe(0);
    expect(s.doc.listeners).toBe(0);
    expect(await s.audio.unlock()).toBe(false);
    s.audio.onEvents([{ type: 'level_up', level: 2, choices: [] }], 'p');
  });

  it('notifies subscribers about mood and control changes', async () => {
    const { audio } = setup();
    let n = 0;
    const off = audio.subscribe(() => n++);
    audio.setMood('calm'); // the first area is already calm: no change
    expect(n).toBe(0);
    audio.setMood('boss');
    expect(n).toBe(1);
    audio.onEvents([{ type: 'area_entered', index: 0 }]);
    expect(n).toBe(2);
    audio.mute(true);
    audio.setVolume(0.3);
    expect(n).toBe(4);
    off();
    audio.setMood('eerie');
    expect(n).toBe(4);
  });

  it('switches world without a new context', async () => {
    const { audio, made } = setup();
    await audio.unlock();
    audio.setWorld({ audio: { mood: 'x', synth: { key: 'C', scale: 'major', tempo: 140, timbre: 'chip', drone: false, percussion: 'none', brightness: 0.9 }, searchTerms: [], suggestions: [] }, areas: [{ music: 'upbeat' }] });
    expect(audio.mood).toBe('upbeat');
    expect(made()).toBe(1);
  });

  it('installUnlock unlocks on the first gesture and removes its listeners', async () => {
    const ls = new Map<string, () => void>();
    const target = {
      addEventListener: (t: string, fn: () => void) => ls.set(t, fn),
      removeEventListener: (t: string) => ls.delete(t),
    };
    let calls = 0;
    installUnlock({ unlock: async () => (++calls, true) }, target as unknown as EventTarget);
    expect(ls.size).toBe(4);
    ls.get('pointerdown')!();
    await flush();
    expect(calls).toBe(1);
    expect(ls.size).toBe(0);
  });

  it('works with every bundled world', () => {
    const dir = join(__dirname, '../../content/worlds');
    for (const f of readdirSync(dir).filter((x: string) => x.endsWith('.json'))) {
      const w = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!w.audio) continue;
      const ctx = new FakeAudioContext();
      ctx.state = 'running';
      const a = new Ambience(ctx as unknown as AudioContext, new FakeNode(ctx, 'bus') as unknown as AudioNode, w.audio.synth, { seedText: f });
      for (const area of w.areas ?? []) {
        a.start(area.music ?? 'explore', 0.1);
        for (let i = 0; i < 20; i++) {
          ctx.advance(0.1);
          a.tick();
        }
      }
      expect(ctx.started.length, f).toBeGreaterThan(0);
      a.dispose();
    }
  });
});
