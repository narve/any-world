/**
 * MP3 D4: what the in-game party UI shows (src/client/room/party-view.ts), on real rooms through
 * the in-memory harness: one member per party player (this player first, the seat's name and
 * colour), their state from the roster, the replica and the clock (acted, deciding, busy, away,
 * down, left), the turn indicator ("2 of 3 acted", "Kari is deciding"), the pill's show / hide
 * delays, the banner (down with the spectator, the exit countdown) and the ring colours.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { GameState } from '../../src/engine/types';
import type { ClockMsg, RosterEntry } from '../../src/net/protocol';
import { REVIVE_SELF_TURNS } from '../../src/engine/turn';
import { bannerView, partyColours, partyMembers, PillTimer, PILL_TIMING, turnView } from '../../src/client/room/party-view';
import { RoomSession } from '../../src/client/room/room-session';
import { MemRoom } from './room-harness';

let h: MemRoom | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

async function room3() {
  const room = new MemRoom({ seed: 5 });
  h = room;
  const cs = ['Kari', 'Ola', 'Siv'].map((n, i) => room.client(n, { host: i === 0 }));
  await room.join(...cs);
  cs[0].start();
  await room.flush();
  return { room, cs };
}

const clock = (n: number, acted: string[], waiting: string[], deadlineInMs?: number): ClockMsg => ({ t: 'clock', n, acted, waiting, ...(deadlineInMs !== undefined ? { deadlineInMs } : {}) });

describe('partyMembers', () => {
  it('this player first, then the party in order, with seat names and colours, actors and hp', async () => {
    const { cs } = await room3();
    const [kari, ola] = cs;
    const s = ola.state!;
    const ms = partyMembers(s, ola.roster, null, ola.n, ola.pid!, null);
    expect(ms.map((m) => m.name)).toEqual(['Ola', 'Kari', 'Siv']);
    expect(ms[0].you).toBe(true);
    expect(ms[1].pid).toBe(kari.pid);
    expect(ms[1].colour).toBe(kari.roster.find((r) => r.pid === kari.pid)!.colour);
    for (const m of ms) {
      expect(m.actorId).toBe(s.players[m.pid].actorId);
      expect(m.hp).toBeGreaterThan(0);
      expect(m.state).toBe('playing');
    }
  });

  it('states: acted and deciding from a fresh clock (a stale one counts for nothing), busy, away, down, left', async () => {
    const { cs } = await room3();
    const [kari, ola, siv] = cs;
    const s = kari.state!;
    const n = kari.n;
    const c = clock(n, [kari.pid!], [ola.pid!, siv.pid!], 600);
    let ms = partyMembers(s, kari.roster, c, n, kari.pid!, null);
    expect(ms.map((m) => m.state)).toEqual(['acted', 'deciding', 'deciding']);
    ms = partyMembers(s, kari.roster, c, n + 1, kari.pid!, null);
    expect(ms.map((m) => m.state)).toEqual(['playing', 'playing', 'playing']);
    const roster: RosterEntry[] = kari.roster.map((r) => (r.pid === ola.pid ? { ...r, presence: 'menu' } : r.pid === siv.pid ? { ...r, presence: 'off', connected: false } : r));
    ms = partyMembers(s, roster, c, n, kari.pid!, null);
    expect(ms.map((m) => m.state)).toEqual(['acted', 'busy', 'away']);
    // idle (connected, no input for a while) is not away; this page's own player is never tagged away or idle
    const idle: RosterEntry[] = kari.roster.map((r) => ({ ...r, presence: 'idle' }));
    expect(partyMembers(s, idle, null, n, kari.pid!, null).map((m) => m.state)).toEqual(['playing', 'idle', 'idle']);
    const offMe: RosterEntry[] = kari.roster.map((r) => (r.pid === kari.pid ? { ...r, presence: 'off', connected: false } : r));
    expect(partyMembers(s, offMe, null, n, kari.pid!, null)[0].state).toBe('playing');
    const down: GameState = { ...s, players: { ...s.players, [ola.pid!]: { ...s.players[ola.pid!], down: { since: s.turn, helpedTurns: 0 } } } };
    expect(partyMembers(down, kari.roster, null, n, kari.pid!, ola.pid!).find((m) => m.pid === ola.pid)).toMatchObject({ state: 'down', followed: true });
    // a player who left the map is out of `party` but keeps a greyed chip
    const left: GameState = { ...s, party: s.party.filter((p) => p !== siv.pid), players: { ...s.players, [siv.pid!]: { ...s.players[siv.pid!], left: { turn: s.turn, actor: s.area.actors.find((a) => a.id === s.players[siv.pid!].actorId)! } } } };
    const gone = partyMembers(left, kari.roster.filter((r) => r.pid !== siv.pid), null, n, kari.pid!, null);
    expect(gone.map((m) => [m.name, m.state])).toContainEqual(['Siv', 'left']);
    expect(gone.find((m) => m.pid === siv.pid)!.colour).toBe('#8a8f98');
  });

  it('ring colours: actor id → seat colour for every seated member', async () => {
    const { cs } = await room3();
    const k = cs[0];
    const cols = partyColours(partyMembers(k.state!, k.roster, null, k.n, k.pid!, null));
    expect(cols.size).toBe(3);
    for (const r of k.roster) expect(cols.get(k.state!.players[r.pid!].actorId)).toBe(r.colour);
  });
});

describe('turn indicator', () => {
  it('"2 of 3 acted" while someone acted and an active player has not; "Kari is deciding" once this player acted', async () => {
    const { cs } = await room3();
    const [kari, ola, siv] = cs;
    const n = ola.n;
    const ms = partyMembers(ola.state!, ola.roster, null, n, ola.pid!, null);
    // nobody acted: the world does not move, nothing waits
    expect(turnView(ms, clock(n, [], [kari.pid!, ola.pid!, siv.pid!]), n, ola.pid!).waiting).toBe(false);
    const v = turnView(ms, clock(n, [kari.pid!, siv.pid!], [ola.pid!], 400), n, ola.pid!);
    expect(v).toMatchObject({ waiting: true, acted: 2, total: 3, mine: false, deadlineMs: 400 });
    const mine = turnView(ms, clock(n, [ola.pid!], [kari.pid!, siv.pid!]), n, ola.pid!);
    expect(mine).toMatchObject({ waiting: true, mine: true, deciding: 'Kari' });
    // a resolved turn's clock is stale
    expect(turnView(ms, clock(n - 1, [kari.pid!], [ola.pid!]), n, ola.pid!).waiting).toBe(false);
    // a party of one never shows it
    expect(turnView(ms.slice(0, 1), clock(n, [kari.pid!], [ola.pid!]), n, ola.pid!).waiting).toBe(false);
  });

  it('PillTimer: shows after 450 ms of waiting, hides 250 ms after; a new wait keeps it up (no flicker)', () => {
    const p = new PillTimer();
    expect(p.update(true, 0)).toBe(false);
    expect(p.update(true, PILL_TIMING.showMs - 1)).toBe(false);
    expect(p.update(true, PILL_TIMING.showMs)).toBe(true);
    expect(p.update(false, 600)).toBe(true);
    expect(p.update(false, 600 + PILL_TIMING.hideMs - 1)).toBe(true);
    // the next turn waits again before the hide delay ran out: the pill stays
    expect(p.update(true, 800)).toBe(true);
    expect(p.update(false, 900)).toBe(true);
    expect(p.update(false, 900 + PILL_TIMING.hideMs)).toBe(false);
    // the wait counts from the clock frame's arrival when the page notices it later
    const late = new PillTimer();
    expect(late.update(true, 1100, 1000)).toBe(false);
    expect(late.update(true, 1000 + PILL_TIMING.showMs, 1000)).toBe(true);
    // walking: turns resolve within the show delay, the pill never shows
    const q = new PillTimer();
    for (let t = 0; t < 5000; t += 300) {
      expect(q.update(true, t)).toBe(false);
      expect(q.update(false, t + 200)).toBe(false);
    }
  });
});

describe('banner', () => {
  it('down (with whom the camera follows) comes before the exit countdown; the countdown names who took the exit', async () => {
    const { cs } = await room3();
    const [kari, ola] = cs;
    const s = kari.state!;
    const ms = partyMembers(s, kari.roster, null, kari.n, kari.pid!, null);
    expect(bannerView(s, ms, kari.pid!)).toBeNull();
    const cd: GameState = { ...s, area: { ...s.area, exitCountdown: { turnsLeft: 4, by: ola.pid! } } };
    expect(bannerView(cd, ms, kari.pid!)).toEqual({ kind: 'exit', turnsLeft: 4, by: 'Ola' });
    expect(bannerView({ ...s, area: { ...s.area, exitCountdown: { turnsLeft: 3, by: kari.pid! } } }, ms, kari.pid!)).toEqual({ kind: 'exit', turnsLeft: 3, by: null });
    const down: GameState = { ...cd, turn: s.turn + 5, players: { ...s.players, [kari.pid!]: { ...s.players[kari.pid!], down: { since: s.turn, helpedTurns: 0 } } } };
    const dm = partyMembers(down, kari.roster, null, kari.n, kari.pid!, ola.pid!);
    expect(bannerView(down, dm, kari.pid!)).toEqual({ kind: 'down', turnsLeft: REVIVE_SELF_TURNS - 5, watching: 'Ola', canCycle: true });
  });

  it('a RoomSession that is down follows the nearest teammate; follow(pid) picks a standing one', async () => {
    const { cs } = await room3();
    const [kari, ola, siv] = cs;
    const s = new RoomSession({ client: kari });
    expect(s.follow(ola.pid!)).toBeNull();
    const st = kari.state!;
    // (a write to the replica's view, as an entry would make it: the session reads me.down from `state`)
    (s as unknown as { state: GameState }).state = { ...st, players: { ...st.players, [kari.pid!]: { ...st.players[kari.pid!], down: { since: st.turn, helpedTurns: 0 } } } };
    expect(s.follow(siv.pid!)).toBe(siv.pid);
    expect(s.follow('p99')).toBe(siv.pid);
  });
});
