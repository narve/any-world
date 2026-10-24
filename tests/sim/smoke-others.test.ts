/**
 * Smoke: cautious (with the scripted GM feeding spawn / offer_choice / add_rule / remove_rule),
 * talker and random bots on every world — no crashes, and no soft-locks for the goal-seeking bots.
 */
import { describe } from 'vitest';
import { smoke, worldFiles } from './smoke-helpers';

describe('cautious / talker / random smoke', () => {
  for (const f of worldFiles)
    smoke(f, [
      { bot: 'cautious', seeds: 10, opts: { gm: true } },
      { bot: 'talker', seeds: 5 },
      { bot: 'random', seeds: 5, opts: { maxTurns: 400, gm: true }, allowStuck: true },
    ]);
});
