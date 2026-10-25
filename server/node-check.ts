/**
 * Refuse to serve on a Node.js runtime with known remote-code-execution flaws.
 *
 * CVE-2026-111497 ("HTTP2Shell" / "Node2Shell"): an out-of-bounds write in the Brotli decoder bundled
 * with Node.js. The server's fetch() to LLM providers decompresses `Content-Encoding: br` responses,
 * so an unpatched runtime is exposed. Fixed in 22.23.4, 24.22.1 and 26.12.1 (Node.js security release,
 * 21 Oct 2026: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
 * Lines with no fix (20, 21, 23, 25 and older) are end-of-life and refused.
 *
 * Distribution builds that link a shared libbrotli (Debian/Ubuntu `nodejs`) report their own version
 * but get the Brotli fix from the system library; they are still refused below the fixed versions,
 * because the version alone cannot prove the library was patched. Use the official nodejs.org build.
 */

/** the first patched release per supported major line */
export const MIN_PATCHED: Readonly<Record<number, readonly [number, number, number]>> = {
  22: [22, 23, 4],
  24: [24, 22, 1],
  26: [26, 12, 1],
};

/** a newer major line than any listed is assumed to include the fix */
const NEWEST_LISTED = Math.max(...Object.keys(MIN_PATCHED).map(Number));

function parse(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function lessThan(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** why this Node.js version must not run the server, or null when it is fine */
export function nodeSecurityProblem(version: string): string | null {
  const v = parse(version);
  if (!v) return `cannot read the Node.js version "${version}"`;
  const [major] = v;
  if (major > NEWEST_LISTED) return null;
  const min = MIN_PATCHED[major];
  if (!min) return `Node.js ${version} is an end-of-life line without the fix for CVE-2026-111497 (HTTP2Shell); use 22.23.4+, 24.22.1+ or 26.12.1+`;
  if (lessThan(v, min)) return `Node.js ${version} is vulnerable to CVE-2026-111497 (HTTP2Shell, Brotli RCE); upgrade to ${min.join('.')} or newer`;
  return null;
}

/**
 * Startup check: throws on a vulnerable runtime unless ANYWORLD_ALLOW_UNPATCHED_NODE=1 (then it only
 * warns, e.g. for an isolated development machine).
 */
export function assertSafeNode(version = process.version, env: Record<string, string | undefined> = process.env, warn: (l: string) => void = console.warn): void {
  const problem = nodeSecurityProblem(version);
  if (!problem) return;
  if (env.ANYWORLD_ALLOW_UNPATCHED_NODE === '1') {
    warn(`[server] WARNING: ${problem} (allowed by ANYWORLD_ALLOW_UNPATCHED_NODE=1)`);
    return;
  }
  throw new Error(`${problem}. Set ANYWORLD_ALLOW_UNPATCHED_NODE=1 to start anyway (not for an exposed server).`);
}
