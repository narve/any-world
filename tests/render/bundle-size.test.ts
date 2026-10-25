/**
 * DoD §10 item 12 (performance budget): what a player downloads. Builds the static (browser-only)
 * bundle into a temporary directory — the same `vite build --mode static` as `npm run build:static`,
 * but never touching dist/ — and asserts gzip budgets for the chunks:
 *   - main entry (start screen, UI, engine, i18n)   < 300 kB gzip
 *   - render chunk (three.js + renderer, lazy)      < 200 kB gzip
 *   - stylesheet                                     <  40 kB gzip
 *   - web workers (the world balancer, lazy)         < 150 kB gzip
 *   - every other chunk (a recorded world, …)        <  40 kB gzip
 * The renderer must stay out of the entry chunk (the start screen does not need WebGL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(__dirname, '../..');
const KB = 1000;

const BUNDLE_BUDGET = {
  main: 300 * KB,
  render: 200 * KB,
  css: 40 * KB,
  worker: 150 * KB,
  otherChunk: 40 * KB,
} as const;

interface Chunk {
  file: string;
  raw: number;
  gzip: number;
}

let out = '';
let html = '';
let chunks: Chunk[] = [];

function measure(dir: string): Chunk[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
    .map((f) => {
      const buf = readFileSync(join(dir, f));
      return { file: f, raw: statSync(join(dir, f)).size, gzip: gzipSync(buf, { level: 9 }).length };
    });
}

const kb = (n: number) => `${(n / KB).toFixed(1)} kB`;

describe('static bundle size budget', () => {
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), 'anyworld-bundle-'));
    execFileSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'static', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 180000,
    });
    html = readFileSync(join(out, 'index.html'), 'utf8');
    chunks = measure(join(out, 'assets'));
  }, 200000);

  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  const entryName = () => /<script[^>]+src="\.\/assets\/([^"]+\.js)"/.exec(html)?.[1];

  it('builds an entry script, a lazy render chunk and a stylesheet', () => {
    expect(entryName()).toBeTruthy();
    expect(chunks.some((c) => c.file === entryName())).toBe(true);
    expect(chunks.filter((c) => /^render-.*\.js$/.test(c.file))).toHaveLength(1);
    expect(chunks.some((c) => c.file.endsWith('.css'))).toBe(true);
  });

  it(`main entry stays under ${kb(BUNDLE_BUDGET.main)} gzip`, () => {
    const main = chunks.find((c) => c.file === entryName())!;
    console.log(`main ${main.file}: ${kb(main.raw)} raw, ${kb(main.gzip)} gzip`);
    expect(main.gzip).toBeLessThan(BUNDLE_BUDGET.main);
  });

  it(`render chunk (three.js) stays under ${kb(BUNDLE_BUDGET.render)} gzip and out of the entry`, () => {
    const render = chunks.find((c) => /^render-.*\.js$/.test(c.file))!;
    console.log(`render ${render.file}: ${kb(render.raw)} raw, ${kb(render.gzip)} gzip`);
    expect(render.gzip).toBeLessThan(BUNDLE_BUDGET.render);
    // three.js is loaded lazily: the entry must not contain the WebGL renderer
    const main = readFileSync(join(out, 'assets', entryName()!), 'utf8');
    expect(main.includes('WebGLRenderer')).toBe(false);
  });

  it(`stylesheet stays under ${kb(BUNDLE_BUDGET.css)} gzip`, () => {
    for (const c of chunks.filter((c) => c.file.endsWith('.css'))) expect(c.gzip, c.file).toBeLessThan(BUNDLE_BUDGET.css);
  });

  const isWorker = (f: string) => /worker/i.test(f);

  it(`web workers stay under ${kb(BUNDLE_BUDGET.worker)} gzip`, () => {
    for (const c of chunks.filter((c) => c.file.endsWith('.js') && isWorker(c.file))) {
      console.log(`worker ${c.file}: ${kb(c.gzip)} gzip`);
      expect(c.gzip, c.file).toBeLessThan(BUNDLE_BUDGET.worker);
    }
  });

  it(`every other chunk stays under ${kb(BUNDLE_BUDGET.otherChunk)} gzip`, () => {
    const rest = chunks.filter((c) => c.file.endsWith('.js') && c.file !== entryName() && !/^render-/.test(c.file) && !isWorker(c.file));
    const worst = [...rest].sort((a, b) => b.gzip - a.gzip)[0];
    if (worst) console.log(`largest other chunk ${worst.file}: ${kb(worst.gzip)} gzip (${rest.length} chunks)`);
    for (const c of rest) expect(c.gzip, c.file).toBeLessThan(BUNDLE_BUDGET.otherChunk);
  });
});
