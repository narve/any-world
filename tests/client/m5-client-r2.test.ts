/**
 * M5 review round 2, client fixes (moved from tests/review/m5/pt-desktop-r2.test.ts and the
 * r2-code key-leak repro):
 *  - issues/M5-danger-hint-empty-item.md       the "press N" hint and an empty charged item
 *  - issues/M5-ranged-keyboard-fire.md         aiming and firing a ranged weapon with the keyboard
 *  - issues/M5-dialogue-history-english.md     the player's reply in the transcript, in the UI language
 *  - issues/M5-api-key-leaks-across-presets.md direct-mode keys stay with their provider
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createGame } from '../../src/engine';
import type { GameState, Pos } from '../../src/engine/types';
import { loadFixture, roomMap } from '../engine/helpers';
import { gameView, readyToUse, type GameViewExtras } from '../../src/client/view';
import { activateSlot, slotExplanation } from '../../src/client/ui/slots';
import { GameSession } from '../../src/client/session';
import { conflictEntries } from '../../src/client/guide';
import { keyHelp } from '../../src/client/ui/input';
import { activeProvider, keySlot, normalizeSettings, reconcileApiKeys } from '../../src/client/storage';
import type { Settings } from '../../src/client/ui/viewmodel';
import { setLanguage } from '../../src/client/i18n';

setLanguage('en');
afterEach(() => setLanguage('en'));

const extras = (o: Partial<GameViewExtras> = {}): GameViewExtras => ({ gmLog: [], narration: null, mode: 'normal', dialogueHistory: [], tradeOpen: false, ...o });
const western = loadFixture('fixture-western.json');

/** western run at low Blood: an empty canteen in its quick slot, one sarsaparilla (heals) in quick slot 5 */
function lowBloodEmptyCanteen(): GameState {
  const s = structuredClone(createGame(western, { seed: 7, map: roomMap() }));
  const canteen = s.player.slots.findIndex((x) => x?.defId === 'canteen');
  expect(canteen).toBeGreaterThanOrEqual(0);
  s.player.slots[canteen]!.charges = 0;
  s.player.slots[4] = { id: 'i-sars', defId: 'sarsaparilla', count: 1 };
  if (s.knowledge.sarsaparilla) s.knowledge.sarsaparilla.level = 'clear';
  else s.knowledge.sarsaparilla = { level: 'clear', notes: [], timesUsed: 1 };
  const me = s.area.actors.find((a) => a.id === s.player.actorId)!;
  me.hp = Math.max(1, Math.floor(me.maxHp * 0.2));
  return s;
}

describe('low-HP "press N" hint and an empty charged item (issues/M5-danger-hint-empty-item.md)', () => {
  it('the danger hint points at a heal that can be used, not at the canteen with 0/3 charges', () => {
    const s = lowBloodEmptyCanteen();
    const v = gameView(western, s, extras());
    const hp = v.hud.danger?.find((d) => d.id === 'hp');
    expect(hp).toBeDefined();
    const canteen = s.player.slots.findIndex((x) => x?.defId === 'canteen');
    expect(hp!.slot).not.toBe(canteen);
    expect(hp!.slot).toBe(4);
    expect(v.slots[4]!.urgent).toBe(true);
    expect(v.slots[canteen]!.urgent).toBeFalsy();
  });

  it('no hint at all when every restorative is empty', () => {
    const s = lowBloodEmptyCanteen();
    s.player.slots[4] = null;
    const v = gameView(western, s, extras());
    const hp = v.hud.danger?.find((d) => d.id === 'hp');
    expect(hp?.slot).toBeUndefined();
  });

  it('pressing an empty charged item says it is empty instead of "works just by being carried"', () => {
    const s = lowBloodEmptyCanteen();
    const v = gameView(western, s, extras());
    const canteen = s.player.slots.findIndex((x) => x?.defId === 'canteen');
    expect(readyToUse(v.slots[canteen]!)).toBe(false);
    const r = activateSlot(v.slots, canteen);
    expect(r?.kind).toBe('blocked');
    expect(r && r.kind === 'blocked' ? r.reason : '').toMatch(/is empty \(0\/3\)/);
    const tip = slotExplanation(v.slots[canteen]!, western.vocabulary, canteen).lines.join(' ');
    expect(tip).not.toMatch(/just by being carried/);
    expect(tip).toMatch(/empty/);
  });

  it('the empty-item notice is in bokmål in the nb UI', () => {
    setLanguage('nb');
    const s = lowBloodEmptyCanteen();
    const v = gameView(western, s, extras());
    const canteen = s.player.slots.findIndex((x) => x?.defId === 'canteen');
    const r = activateSlot(v.slots, canteen);
    expect(r && r.kind === 'blocked' ? r.reason : '').toMatch(/er tom \(0\/3\)/);
  });
});

function session(map = roomMap(14, 10)): GameSession {
  return new GameSession({ world: western, worldId: 'fixture-test', seed: 1, map });
}

/** only the player and one deputy, `dist` tiles east of the player, with FOV refreshed */
function deputyAt(s: GameSession, at: Pos): string {
  const st = structuredClone(s.state) as GameState;
  const me = st.area.actors.find((a) => a.id === st.player.actorId)!;
  me.pos = { x: 2, y: 5 };
  const dep = st.area.actors.find((a) => a.defId === 'company-deputy') ?? null;
  st.area.actors = st.area.actors.filter((a) => a.id === st.player.actorId || a === dep);
  if (!dep) throw new Error('no deputy in the first area');
  dep.pos = { ...at };
  s.state = st;
  s.act({ type: 'wait' }); // refresh FOV
  return dep.id;
}

describe('ranged weapon with the keyboard (issues/M5-ranged-keyboard-fire.md)', () => {
  it('the slot tip for a range-5 gun names its reach and the aim key, not "bump into"', () => {
    const s = createGame(western, { seed: 7, map: roomMap() });
    const v = gameView(western, s, extras());
    const gun = s.player.slots.findIndex((x) => x?.defId === 'peacemaker');
    expect(gun).toBeGreaterThanOrEqual(0);
    expect(v.slots[gun]!.range).toBe(5);
    const tip = slotExplanation(v.slots[gun]!, western.vocabulary, gun).lines.join(' ');
    expect(tip).not.toMatch(/bump into/);
    expect(tip).toMatch(/5 tiles/);
    expect(tip).toContain(`press ${gun + 1}`);
  });

  it("pressing the equipped gun's key starts aiming instead of explaining", () => {
    const s = createGame(western, { seed: 7, map: roomMap() });
    const v = gameView(western, s, extras());
    const gun = s.player.slots.findIndex((x) => x?.defId === 'peacemaker');
    expect(activateSlot(v.slots, gun)).toEqual({ kind: 'intent', intent: { type: 'begin_target', slot: gun } });
  });

  it('aiming starts on the nearest hostile in reach, and Enter shoots it from range', () => {
    const s = session();
    const id = deputyAt(s, { x: 6, y: 5 });
    const gun = s.state.player.slots.findIndex((x) => x?.defId === 'peacemaker');
    expect(s.state.player.equipped.weapon).toBe(gun);
    s.intent({ type: 'begin_target', slot: gun });
    expect(s.mode).toBe('target');
    expect(s.firingWeapon()).toBe(true);
    // on the deputy, wherever its turn after the FOV refresh took it (it may close in)
    const dep = s.state.area.actors.find((a) => a.id === id)!;
    expect(Math.abs(dep.pos.x - 2)).toBeGreaterThan(1);
    expect(s.cursor).toEqual(dep.pos);
    const turn = s.state.turn;
    const out = s.intent({ type: 'confirm_cursor' });
    expect(out.changed).toBe(true);
    expect(out.events.some((e) => e.type === 'attacked' && e.targetId === id && e.ranged)).toBe(true);
    expect(s.state.turn).toBeGreaterThan(turn);
    expect(s.mode).toBe('normal');
    // fired from where the player stood: the player did not move before the shot (the deputy's lasso may pull them after)
    const shot = out.events.findIndex((e) => e.type === 'attacked' && e.targetId === id);
    const moved = out.events.findIndex((e) => e.type === 'moved' && e.actorId === s.state.player.actorId);
    expect(moved === -1 || moved > shot).toBe(true);
  });

  it('confirming on an empty tile keeps aiming open and says why', () => {
    const s = session();
    deputyAt(s, { x: 6, y: 5 });
    const gun = s.state.player.slots.findIndex((x) => x?.defId === 'peacemaker');
    s.intent({ type: 'begin_target', slot: gun });
    s.intent({ type: 'target_move', dir: 'n' });
    const turn = s.state.turn;
    const out = s.intent({ type: 'confirm_cursor' });
    expect(out.changed).toBe(false);
    expect(out.toasts[0]?.text).toMatch(/No one hostile in reach/);
    expect(s.mode).toBe('target');
    expect(s.state.turn).toBe(turn);
  });

  it('the onboarding and help name the aim key', () => {
    const s = createGame(western, { seed: 7, map: roomMap() });
    const gun = s.player.slots.findIndex((x) => x?.defId === 'peacemaker');
    const lines = conflictEntries(western, s);
    const ranged = lines.find((l) => /reaches 5 tiles/.test(l.text));
    expect(ranged?.text).toContain(`press ${gun + 1} to aim`);
    expect(ranged?.key).toBe(String(gun + 1));
    const help = keyHelp({ talk: true, sneak: false, search: false, persuade: false }, western.vocabulary);
    expect(help[0]!.rows.some((r) => /ranged weapon/.test(r.what))).toBe(true);
  });
});

describe('dialogue transcript in the UI language (issues/M5-dialogue-history-english.md)', () => {
  it("in the nb UI the player's reply in the history is the bokmål button label, not the English engine label", () => {
    setLanguage('nb');
    const s = session();
    const st = structuredClone(s.state) as GameState;
    const me = st.area.actors.find((a) => a.id === st.player.actorId)!;
    me.pos = { x: 5, y: 5 };
    const kid = st.area.actors.find((a) => a.defId === 'kid-tobias');
    if (!kid) throw new Error('no informant in the first area');
    st.area.actors = st.area.actors.filter((a) => a.id === st.player.actorId || a === kid);
    kid.pos = { x: 6, y: 5 };
    s.state = st;
    s.intent({ type: 'talk' });
    const pc = s.state.pendingChoice!;
    expect(pc.kind).toBe('dialogue');
    const d = s.viewModel().game!.dialogue!;
    const ask = d.options.findIndex((o) => /Spør hva/.test(o));
    expect(ask).toBeGreaterThanOrEqual(0);
    const english = pc.options.map((o) => o.label);
    s.dialogueReply(ask);
    const mine = s.history.filter((h) => h.who === 'player').map((h) => h.text);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toBe(d.options[ask]);
    expect(english).not.toContain(mine[0]);
  });
});

describe('direct-mode API keys stay with their provider (issues/M5-api-key-leaks-across-presets.md)', () => {
  const SECRET = 'sk-ant-review-secret-0123456789';
  const base = (): Settings => normalizeSettings({ provider: { preset: 'anthropic', transport: 'direct', apiKey: SECRET } }, 'direct');

  it('an old single key migrates to the preset it was saved with', () => {
    const s = base();
    expect(s.apiKeys).toEqual({ anthropic: SECRET });
    expect(s.provider.apiKey).toBe(SECRET);
    expect(activeProvider(s).apiKey).toBe(SECRET);
  });

  it('switching preset without typing a key drops the previous key (it is not sent to the new host)', () => {
    const before = base();
    // what the settings dialog saves today: the preset changed, the key field kept its old value
    const draft = structuredClone(before);
    draft.provider.preset = 'openrouter';
    draft.provider.model = 'some/model';
    const after = reconcileApiKeys(before, draft);
    expect(after.provider.preset).toBe('openrouter');
    expect(after.provider.apiKey).toBeUndefined();
    expect(activeProvider(after).apiKey).toBeUndefined();
    // the Anthropic key is still remembered for Anthropic, and comes back when switching back
    expect(after.apiKeys).toEqual({ anthropic: SECRET });
    const back = structuredClone(after);
    back.provider.preset = 'anthropic';
    expect(reconcileApiKeys(after, back).provider.apiKey).toBe(SECRET);
    // a stored settings blob round-trips the same way
    expect(normalizeSettings(JSON.parse(JSON.stringify(after)), 'direct').provider.apiKey).toBeUndefined();
  });

  it('a key typed for the new preset belongs to it; clearing it removes only that one', () => {
    const before = base();
    const draft = structuredClone(before);
    draft.provider.preset = 'openrouter';
    draft.provider.apiKey = 'sk-or-123';
    const after = reconcileApiKeys(before, draft);
    expect(after.provider.apiKey).toBe('sk-or-123');
    expect(after.apiKeys).toEqual({ anthropic: SECRET, openrouter: 'sk-or-123' });
    const cleared = structuredClone(after);
    delete cleared.provider.apiKey;
    expect(reconcileApiKeys(after, cleared).apiKeys).toEqual({ anthropic: SECRET });
  });

  it('a key never follows a change of base URL (custom endpoints, moved local servers)', () => {
    const before = reconcileApiKeys(base(), { ...base(), provider: { preset: 'custom', transport: 'direct', baseUrl: 'https://a.example/v1', apiKey: 'sk-a' } });
    expect(keySlot(before.provider)).toBe('custom@https://a.example/v1');
    const moved = structuredClone(before);
    moved.provider.baseUrl = 'https://evil.example/v1';
    const after = reconcileApiKeys(before, moved);
    expect(after.provider.apiKey).toBeUndefined();
    // trailing slashes are the same address
    expect(keySlot({ preset: 'custom', baseUrl: 'https://a.example/v1/' })).toBe(keySlot({ preset: 'custom', baseUrl: 'https://a.example/v1' }));
  });

  it('a hand-edited entry whose key does not match its provider slot is not sent', () => {
    const s: Settings = { ...base(), provider: { preset: 'openrouter', transport: 'direct', apiKey: SECRET }, apiKeys: { anthropic: SECRET, openrouter: 'sk-or-1' } };
    expect(activeProvider(s).apiKey).toBeUndefined();
    // normalizing such an entry picks the key saved for the active slot
    expect(normalizeSettings(s, 'direct').provider.apiKey).toBe('sk-or-1');
  });
});
