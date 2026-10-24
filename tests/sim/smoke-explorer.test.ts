/** Smoke: the explorer bot plays 20 seeds of every world without crashes or soft-locks. */
import { describe } from 'vitest';
import { smoke, worldFiles } from './smoke-helpers';

describe('explorer smoke', () => {
  for (const f of worldFiles) smoke(f, [{ bot: 'explorer', seeds: 20 }]);
});
