/**
 * issues/M1-narration-covers-player.md — the prologue/arrival card stayed centred over the player
 * while they moved, traded and fought, and the backpack opened underneath it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { GameState } from '../../src/engine/types';
import { GameSession } from '../../src/client/session';
import { loadFixture, roomMap } from '../engine/helpers';
import { leadPlayer } from '../../src/engine';

const western = loadFixture('fixture-western.json');
const ship = loadFixture('fixture-ship.json');

function alone(s: GameSession): void {
  const st = structuredClone(s.state) as GameState;
  st.area.actors = st.area.actors.filter((a) => a.id === leadPlayer(st).actorId);
  s.state = st;
}

describe('narration gets out of the way once the player acts', () => {
  it('the prologue is dismissed by the first engine action', () => {
    const s = new GameSession({ world: western, worldId: 'w', seed: 1, map: roomMap(14, 10) });
    alone(s);
    expect(s.viewModel().game!.narration?.kind).toBe('intro');
    // UI-only intents (camera, look) do not dismiss it
    s.intent({ type: 'rotate_camera', dir: 1 });
    expect(s.viewModel().game!.narration?.kind).toBe('intro');
    // a refused action does not either
    s.uiAction({ type: 'pickup' });
    expect(s.viewModel().game!.narration?.kind).toBe('intro');
    s.uiAction({ type: 'wait' });
    expect(s.viewModel().game!.narration).toBeNull();
  });

  it('an arrival card opened by the transition stays until the next action', () => {
    const s = new GameSession({ world: ship, worldId: 's', seed: 2 });
    alone(s);
    const st = structuredClone(s.state) as GameState;
    st.area.actors.find((a) => a.id === leadPlayer(st).actorId)!.pos = { ...st.area.map.exit };
    s.state = st;
    s.uiAction({ type: 'wait' });
    expect(s.viewModel().game!.narration).toBeNull();
    const out = s.uiAction({ type: 'transition' });
    expect(out.areaChanged).toBe(true);
    expect(s.viewModel().game!.narration?.kind).toBe('area_enter');
    s.uiAction({ type: 'wait' });
    expect(s.viewModel().game!.narration).toBeNull();
  });

  it('the autosave carries the seed so a reloaded link finds its run', () => {
    const s = new GameSession({ world: western, worldId: 'w', seed: 77, map: roomMap(14, 10) });
    expect(s.savedRun(0).seed).toBe(77);
  });
});

describe('narration card layout (ui.css)', () => {
  const css = readFileSync(new URL('../../src/client/styles/ui.css', import.meta.url), 'utf8');
  const rule = (sel: string) => {
    const m = css.match(new RegExp(`(^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
    if (!m) throw new Error(`no rule for ${sel}`);
    return m[2];
  };
  const num = (body: string, prop: string) => {
    const m = body.match(new RegExp(`(^|[;\\s])${prop}:\\s*(-?[\\d.]+)`));
    if (!m) throw new Error(`no ${prop}`);
    return Number(m[2]);
  };

  it('stacks under the backpack, modals and the rules column', () => {
    const narr = num(rule('.aw-narration'), 'z-index');
    expect(narr).toBeLessThan(num(rule('.aw-backpack'), 'z-index'));
    expect(narr).toBeLessThan(num(rule('.aw-modal'), 'z-index'));
    expect(narr).toBeLessThan(num(rule('.aw-top-right-col'), 'z-index'));
  });

  it('never reaches the middle of the screen, where the player is', () => {
    const body = rule('.aw-narration');
    const top = num(body, 'top');
    const maxH = num(body, 'max-height');
    expect(body).toMatch(/top:\s*[\d.]+%/);
    expect(body).toMatch(/max-height:\s*[\d.]+%/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(top + maxH).toBeLessThan(50);
    // the small-screen override keeps the same bound
    const small = css.match(/@media \(max-height: 640px\)[\s\S]*?\.aw-narration\s*\{([^}]*)\}/);
    expect(small).toBeTruthy();
    expect(num(small![1], 'top') + num(small![1], 'max-height')).toBeLessThan(50);
  });
});
