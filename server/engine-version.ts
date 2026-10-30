/**
 * The engine version (MP2 design §8): a hash of the code that decides how a room's state moves, so a
 * page and a server only play together when they run the same lockstep code.
 *
 * computeEngineVersion(root): the git-tracked `*.ts` files (`git ls-files`; a directory walk when git
 * is not there) under src/engine, src/schema and src/net, leaving out src/engine/sim/ and
 * src/engine/balance/ (bots and static balance, never loaded by the runtime engine) and
 * src/net/client.ts / src/net/messages.ts (no effect on lockstep). Sorted by relative path, each fed
 * to sha256 as `path \0 content \0` with CRLF normalised to LF; the first 16 hex characters.
 *
 * Used by vite.config.ts and vitest.config.ts (the client's __ANYWORLD_ENGINE_VERSION__), server
 * start-up (AppOptions.engineVersion) and Node tools. Node only; the page reads src/net/version.ts.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { type Dirent, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** the directories whose code is the engine, relative to the repo root */
export const ENGINE_DIRS = ['src/engine', 'src/schema', 'src/net'];
const EXCLUDED_DIRS = ['src/engine/sim/', 'src/engine/balance/'];
const EXCLUDED_FILES = new Set(['src/net/client.ts', 'src/net/messages.ts']);

/** the repository root (this file lives in <root>/server) */
export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function counts(path: string): boolean {
  return path.endsWith('.ts') && !EXCLUDED_FILES.has(path) && !EXCLUDED_DIRS.some((d) => path.startsWith(d));
}

function gitFiles(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...ENGINE_DIRS], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\0').filter(Boolean);
    return files.length ? files : null;
  } catch {
    return null;
  }
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const full = join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (d.isFile()) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  for (const d of ENGINE_DIRS) walk(join(root, d));
  return out;
}

/** the engine files that count, relative with `/` separators, sorted */
export function engineFiles(root: string = REPO_ROOT): string[] {
  return (gitFiles(root) ?? walkFiles(root)).filter(counts).sort();
}

/** 16 hex characters identifying the engine code under `root` */
export function computeEngineVersion(root: string = REPO_ROOT): string {
  const h = createHash('sha256');
  for (const path of engineFiles(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue; // tracked but deleted in the working tree
    }
    h.update(path);
    h.update('\0');
    h.update(text.replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

const cache = new Map<string, string>();

/**
 * The version this process plays: ANYWORLD_ENGINE_VERSION when set and NODE_ENV is not
 * 'production' (child-process tests of a deploy), else computeEngineVersion(root), computed once
 * per root.
 */
export function engineVersionFor(env: Record<string, string | undefined> = process.env, root: string = REPO_ROOT): string {
  const override = env.ANYWORLD_ENGINE_VERSION?.trim();
  if (override && env.NODE_ENV !== 'production') return override.slice(0, 64);
  let v = cache.get(root);
  if (v === undefined) {
    v = computeEngineVersion(root);
    cache.set(root, v);
  }
  return v;
}
