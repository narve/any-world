/** M4 integration: the world's music panel is mounted through AudioBridge (settings dialog, in a run). */
import { describe, expect, it } from 'vitest';
import * as realAudio from '../../src/client/audio/index';
import { AudioBridge, type AudioModule, type BridgeAudio, type BridgeMusicPanel } from '../../src/client/audio-bridge';
import { loadFixture } from '../engine/helpers';

const western = loadFixture('fixture-western.json');
const ship = loadFixture('fixture-ship.json');

// the real module fits the bridge's view of it (a compile-time check: the bridge casts its import)
const real: Pick<AudioModule, 'createMusicPanel'> = realAudio;

interface FakeHost {
  children: unknown[];
  replaceChildren(el: unknown): void;
}
function host(): FakeHost & HTMLElement {
  const h: FakeHost = {
    children: [],
    replaceChildren(el) {
      for (const c of h.children) (c as { parentElement: unknown }).parentElement = null;
      h.children = [el];
      (el as { parentElement: unknown }).parentElement = h;
    },
  };
  return h as unknown as FakeHost & HTMLElement;
}

function fake() {
  const log: string[] = [];
  const audio: BridgeAudio = {
    onEvents: () => undefined,
    onGmActions: () => undefined,
    setMood: () => undefined,
    mute: () => undefined,
    applySettings: () => undefined,
    setWorld: () => undefined,
    dispose: () => undefined,
  };
  const panels: BridgeMusicPanel[] = [];
  const mod: AudioModule = {
    createAudio: () => audio,
    installUnlock: () => () => undefined,
    createMusicPanel: (o) => {
      log.push(`create:${o.audio?.mood ?? ''}:${o.settings?.soundcloud}`);
      const node: { parentElement: unknown; remove(): void } = { parentElement: null, remove: () => (node.parentElement = null) };
      const el = node as unknown as HTMLElement;
      const p: BridgeMusicPanel = {
        el,
        update: (u) => log.push(`update:${u?.audio ? 'audio' : ''}${u?.settings ? `sc=${u.settings.soundcloud}` : ''}`),
        dispose: () => log.push('dispose'),
      };
      panels.push(p);
      return p;
    },
  };
  return { log, mod, panels };
}

describe('AudioBridge.mountPanel', () => {
  it('real audio module exports a music panel factory', () => {
    expect(typeof real.createMusicPanel).toBe('function');
  });

  it('does nothing outside a run', async () => {
    const { mod, log } = fake();
    const b = new AudioBridge({ volume: 0.5, muted: false }, async () => mod);
    expect(await b.mountPanel(host())).toBe(false);
    expect(log).toEqual([]);
  });

  it('creates one panel per run, moves it between hosts, follows settings, drops it at run end', async () => {
    const { mod, log, panels } = fake();
    const b = new AudioBridge({ volume: 0.5, muted: false, soundcloud: true }, async () => mod);
    await b.startRun(western, 0);
    const h1 = host();
    expect(await b.mountPanel(h1)).toBe(true);
    expect(log).toEqual([`create:${western.audio.mood}:true`]);
    expect(h1.children).toEqual([panels[0]!.el]);
    const h2 = host();
    await b.mountPanel(h2);
    expect(panels).toHaveLength(1);
    expect(h2.children).toEqual([panels[0]!.el]);
    b.applySettings({ volume: 0.5, muted: false, soundcloud: false });
    expect(log).toContain('update:sc=false');
    b.stopRun();
    expect(log).toContain('dispose');
    await b.startRun(ship, 0);
    await b.mountPanel(host());
    expect(panels).toHaveLength(2);
    expect(log.at(-1)).toBe(`create:${ship.audio.mood}:false`);
  });

  it('a module without the panel reports false', async () => {
    const { mod } = fake();
    delete mod.createMusicPanel;
    const b = new AudioBridge({ volume: 0.5, muted: false }, async () => mod);
    await b.startRun(western, 0);
    expect(await b.mountPanel(host())).toBe(false);
  });
});
