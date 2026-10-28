/**
 * MP2 C1: the offline GM moved to src/gm/offline.ts (shared by the client and the room server).
 * Offer labels come through an injected `t` (English without one); the client's re-exported
 * director labels them with the client's i18n, so its answers are unchanged.
 */
import { describe, it, expect } from 'vitest';
import { createGame } from '../../src/engine';
import type { GameState } from '../../src/engine/types';
import type { GmAction, GmResponse } from '../../src/schema/gm';
import { OfflineGmDirector, type GmContext, type GmTranslate } from '../../src/gm/offline';
import * as client from '../../src/client/gm-director';
import { loadFixture, roomMap } from '../engine/helpers';

const ship = loadFixture('fixture-ship.json');

function ctx(seed: number): GmContext {
  const state: GameState = createGame(ship, { seed, map: roomMap(16, 12) });
  return { world: ship, state, difficulty: 'normal', weirdness: 0.3, recentLog: [], areaEnteredTurn: 0 };
}

const offerOf = (r: GmResponse | null) => r?.actions.find((a): a is Extract<GmAction, { type: 'offer_choice' }> => a.type === 'offer_choice');

/** the first seed whose area-0 event is an offer */
function offerSeed(): number {
  const d = new OfflineGmDirector({ eventDelay: 0 });
  for (let seed = 1; seed < 200; seed++) if (offerOf(d.respondSync({ hook: 'idle', area: 0, turn: 30, ctx: ctx(seed) }))) return seed;
  throw new Error('no seed with an offer');
}

describe('src/gm/offline', () => {
  const seed = offerSeed();
  const ask = (d: OfflineGmDirector) => offerOf(d.respondSync({ hook: 'idle', area: 0, turn: 30, ctx: ctx(seed) }))!;

  it('labels offers in English without a catalog, and through an injected t', () => {
    const en = ask(new OfflineGmDirector({ eventDelay: 0 }));
    expect(en.options[0].label).toMatch(/^Take the /);
    expect(en.options[1].label).toBe('Leave it be');
    const keys: string[] = [];
    const t: GmTranslate = (key, params) => {
      keys.push(key);
      return `[${key}${params?.item ? `:${params.item}` : ''}]`;
    };
    const mine = ask(new OfflineGmDirector({ eventDelay: 0, t }));
    expect(keys).toEqual(['gm.offer.take', 'gm.offer.leave']);
    expect(mine.options[0].label).toBe(`[gm.offer.take:${en.options[0].label.replace(/^Take the /, '')}]`);
    // only the labels differ
    expect(mine.options.map((o) => o.actions)).toEqual(en.options.map((o) => o.actions));
  });

  it('the client re-exports the same names, its director labelled by the client i18n', () => {
    expect(client.gmHooksFor).toBeTypeOf('function');
    expect(client.sanitizeResponse).toBeTypeOf('function');
    const d = new client.OfflineGmDirector({ eventDelay: 0 });
    expect(d).toBeInstanceOf(OfflineGmDirector);
    expect(ask(d)).toEqual(ask(new OfflineGmDirector({ eventDelay: 0 })));
  });
});
