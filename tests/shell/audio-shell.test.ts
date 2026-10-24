/** Audio over the session lifecycle (DESIGN §5b): situation cues, the session listener, AudioBridge. */
import { describe, it, expect, vi } from 'vitest';
import type { GameState } from '../../src/engine/types';
import { GameSession } from '../../src/client/session';
import { audioCueFor, type AudioUpdate } from '../../src/client/audio-cues';
import { AudioBridge, type AudioModule, type BridgeAudio } from '../../src/client/audio-bridge';
import { loadFixture, roomMap } from '../engine/helpers';

const western = loadFixture('fixture-western.json');

function session(seed = 1) {
  return new GameSession({ world: western, worldId: 'fixture-western', seed, map: roomMap(14, 10) });
}

/** moves one actor of `defId` next to the player and refreshes FOV with a wait */
function bringNear(s: GameSession, defId: string): void {
  const st = structuredClone(s.state) as GameState;
  const me = st.area.actors.find((a) => a.id === st.player.actorId)!;
  st.area.actors = st.area.actors.filter((a) => a.id === me.id);
  const id = `t-${defId}`;
  const proto = structuredClone(s.state.area.actors.find((a) => a.id !== me.id) ?? me);
  st.area.actors.push({ ...proto, id, defId, faction: 'hostile', hp: 50, pos: { x: me.pos.x + 2, y: me.pos.y } });
  s.state = st;
  s.act({ type: 'wait' });
}

describe('audioCueFor', () => {
  it('explore with nobody around; the area music mood comes from the plan', () => {
    const s = session();
    const st = structuredClone(s.state) as GameState;
    st.area.actors = st.area.actors.filter((a) => a.id === st.player.actorId);
    const cue = audioCueFor(western, st);
    expect(cue).toEqual({ situation: 'explore', area: 0, music: western.areas[0]!.music });
  });

  it('combat near a hostile, boss when a unique is in view, victory/death at the end', () => {
    const s = session();
    const grunt = western.actors.find((d) => !d.unique && !d.npc)!;
    bringNear(s, grunt.id);
    expect(s.audioCue().situation).toBe('combat');
    // the same actor, as a unique (boss) of another world
    const bossWorld = structuredClone(western);
    bossWorld.actors.find((d) => d.id === grunt.id)!.unique = true;
    expect(audioCueFor(bossWorld, s.state).situation).toBe('boss');
    expect(audioCueFor(western, { ...s.state, status: 'won' }).situation).toBe('victory');
    expect(audioCueFor(western, { ...s.state, status: 'lost' }).situation).toBe('death');
  });
});

describe('GameSession.audioListener', () => {
  it('gets the events of every engine change, and GM actions with their mood', () => {
    const s = session();
    const got: AudioUpdate[] = [];
    s.audioListener = (u) => got.push(u);
    s.act({ type: 'wait' });
    expect(got).toHaveLength(1);
    expect(got[0]!.playerId).toBe(s.state.player.actorId);
    expect(Array.isArray(got[0]!.events)).toBe(true);
    s.applyGm([{ type: 'mood', music: 'eerie' } as never]);
    const last = got.at(-1)!;
    expect(last.gmActions).toEqual([{ type: 'mood', music: 'eerie' }]);
    s.act({ type: 'wait' });
    expect(got.at(-1)!.gmActions).toBeUndefined();
  });

  it('a throwing listener never breaks the run', () => {
    const s = session();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.audioListener = () => {
      throw new Error('boom');
    };
    expect(() => s.act({ type: 'wait' })).not.toThrow();
    expect(s.state.turn).toBeGreaterThan(0);
    warn.mockRestore();
  });
});

function fakeAudio() {
  const calls: [string, ...unknown[]][] = [];
  const audio: BridgeAudio = {
    onEvents: (e, p) => calls.push(['onEvents', e.length, p]),
    onGmActions: (a) => calls.push(['onGmActions', a]),
    setMood: (m) => calls.push(['setMood', m]),
    mute: (on) => calls.push(['mute', on]),
    applySettings: (s) => calls.push(['applySettings', s]),
    setWorld: (w, i) => calls.push(['setWorld', w.meta.title, i]),
    dispose: () => calls.push(['dispose']),
  };
  const mod: AudioModule = {
    createAudio: (w, s) => {
      calls.push(['createAudio', w.meta.title, s]);
      return audio;
    },
    installUnlock: () => {
      calls.push(['installUnlock']);
      return () => calls.push(['offUnlock']);
    },
  };
  return { calls, mod };
}

const update = (situation: AudioUpdate['cue']['situation'], extra: Partial<AudioUpdate> = {}): AudioUpdate => ({
  events: [{ type: 'low_hp' }],
  playerId: 'p',
  cue: { situation, area: 0, music: 'explore' },
  ...extra,
});

describe('AudioBridge', () => {
  it('loads the engine with the first run, unmuted per settings, and installs the gesture unlock', async () => {
    const { calls, mod } = fakeAudio();
    const b = new AudioBridge({ volume: 0.5, muted: false }, async () => mod);
    await b.startRun(western, 1);
    expect(calls[0]).toEqual(['createAudio', western.meta.title, { volume: 0.5, muted: false }]);
    expect(calls).toContainEqual(['setWorld', western.meta.title, 1]);
    expect(calls).toContainEqual(['installUnlock']);
  });

  it('passes events and GM actions on; sets the boss mood once per sighting', async () => {
    const { calls, mod } = fakeAudio();
    const b = new AudioBridge({ volume: 0.5, muted: false }, async () => mod);
    await b.startRun(western);
    calls.length = 0;
    b.update(update('combat', { gmActions: [{ type: 'mood', music: 'calm' }] }));
    b.update(update('boss'));
    b.update(update('boss'));
    b.update(update('explore'));
    b.update(update('boss'));
    expect(calls.filter((c) => c[0] === 'setMood')).toEqual([
      ['setMood', 'boss'],
      ['setMood', 'boss'],
    ]);
    expect(calls).toContainEqual(['onGmActions', [{ type: 'mood', music: 'calm' }]]);
    expect(calls.filter((c) => c[0] === 'onEvents')).toHaveLength(5);
  });

  it('silent on the start screen, back on for the next run; settings apply live', async () => {
    const { calls, mod } = fakeAudio();
    const b = new AudioBridge({ volume: 0.5, muted: false }, async () => mod);
    await b.startRun(western);
    b.stopRun();
    expect(calls.at(-1)).toEqual(['mute', true]);
    b.update(update('combat'));
    expect(calls.at(-1)).toEqual(['mute', true]); // no updates between runs
    b.applySettings({ volume: 0.3, muted: false, soundcloud: true });
    expect(calls.at(-1)).toEqual(['applySettings', { volume: 0.3, soundcloud: true, muted: true }]);
    await b.startRun(western, 2);
    expect(calls.slice(-2)).toEqual([
      ['setWorld', western.meta.title, 2],
      ['mute', false],
    ]);
    b.dispose();
    expect(calls.slice(-2)).toEqual([['offUnlock'], ['dispose']]);
  });

  it('a module that fails to load leaves the game silent, never broken', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = new AudioBridge({ volume: 0.5, muted: false }, async () => {
      throw new Error('chunk failed');
    });
    await expect(b.startRun(western)).resolves.toBeUndefined();
    expect(b.failed).toBe(true);
    expect(() => b.update(update('boss'))).not.toThrow();
    expect(() => b.applySettings({ volume: 1, muted: false })).not.toThrow();
    expect(b.engine).toBeNull();
    warn.mockRestore();
  });

  it('an engine call that throws is contained', async () => {
    const { mod } = fakeAudio();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = new AudioBridge({ volume: 0.5, muted: false }, async () => mod);
    await b.startRun(western);
    b.engine!.onEvents = () => {
      throw new Error('ctx closed');
    };
    expect(() => b.update(update('explore'))).not.toThrow();
    warn.mockRestore();
  });
});
