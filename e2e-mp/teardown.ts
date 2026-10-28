/** removes the room specs' data dir (playwright.mp.config.ts) */
import { rmSync } from 'node:fs';

export default function teardown(): void {
  const dir = process.env.E2E_MP_DATA;
  if (dir && /[\\/]\.data[\\/]e2e-mp-\d+$/.test(dir)) rmSync(dir, { recursive: true, force: true });
}
