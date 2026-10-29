/** removes the room specs' data dirs (playwright.mp.config.ts: the GM server's has "-gm" after it) */
import { rmSync } from 'node:fs';

export default function teardown(): void {
  const dir = process.env.E2E_MP_DATA;
  if (!dir || !/[\\/]\.data[\\/]e2e-mp-\d+$/.test(dir)) return;
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}-gm`, { recursive: true, force: true });
}
