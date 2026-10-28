/**
 * Where the server keeps its files (MP2 design §7): rooms live in <data dir>/rooms.
 *   1. ANYWORLD_DATA_DIR when set (deploy/anyworld.env.example sets /var/lib/anyworld);
 *   2. else STATE_DIRECTORY, which systemd sets from StateDirectory=anyworld;
 *   3. else .data/ in the repo (gitignored; the development laptop).
 * NODE_ENV is not looked at: `npm start` sets production on the development laptop too.
 * main() refuses to start when the directory cannot be created or written.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from './engine-version';

export function resolveDataDir(env: Record<string, string | undefined>, repoRoot: string = REPO_ROOT): string {
  const own = env.ANYWORLD_DATA_DIR?.trim();
  if (own) return resolve(own);
  // systemd may list several directories (colon-separated) when a unit has several; ours has one
  const state = env.STATE_DIRECTORY?.split(':')[0]?.trim();
  if (state) return resolve(state);
  return resolve(repoRoot, '.data');
}

/** makes <dir>/rooms and checks that it is writable (a probe file); throws with the reason otherwise */
export function ensureDataDir(dir: string): string {
  const rooms = join(dir, 'rooms');
  mkdirSync(rooms, { recursive: true });
  const probe = join(rooms, `.probe-${process.pid}`);
  writeFileSync(probe, 'ok');
  rmSync(probe, { force: true });
  return rooms;
}
