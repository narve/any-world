/// <reference types="vite/client" />
/**
 * Browser (Vite) access to the recorded LLM responses in content/recordings/<worldKey>/*.json, for
 * demo mode. Files are lazy chunks: a world's recordings are only fetched when that world is played.
 * Vite-only (import.meta.glob); Node code uses recordings-node.ts instead. Not re-exported from
 * src/llm/index.ts so the server and tools never evaluate it.
 */
import { parseRecordingsFile, type Recording } from './mock';
import { safeKey } from './recording-keys';

type Loader = () => Promise<unknown>;

let files: Record<string, Loader> | null = null;

function table(): Record<string, Loader> {
  if (files) return files;
  try {
    files = import.meta.glob('../../content/recordings/**/*.json', { import: 'default' }) as Record<string, Loader>;
  } catch {
    files = {};
  }
  return files;
}

/** world keys that have recordings bundled */
export function recordedWorldKeys(): string[] {
  const keys = new Set<string>();
  for (const path of Object.keys(table())) {
    const m = /content\/recordings\/([^/]+)\/[^/]+\.json$/.exec(path);
    if (m) keys.add(m[1]!);
  }
  return [...keys].sort();
}

/** all recordings of one world (empty when it has none, or a file fails to load) */
export async function loadBundledRecordings(worldKey: string, onError?: (path: string, err: unknown) => void): Promise<Recording[]> {
  const key = safeKey(worldKey);
  const out: Recording[] = [];
  const entries = Object.entries(table())
    .filter(([p]) => p.includes(`/content/recordings/${key}/`))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, load] of entries) {
    try {
      out.push(...parseRecordingsFile(await load()));
    } catch (e) {
      onError?.(path, e);
    }
  }
  return out;
}
