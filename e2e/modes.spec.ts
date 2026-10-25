/**
 * Deployment modes (DESIGN §4.4, DoD #1), end to end:
 *
 *   static build   `vite build --mode static` → dist/static, served by a plain static file server
 *                  (server/serve-static.ts): demo world with no LLM, the offline demo generator ("Create
 *                  world" / "Surprise me" with no AI), direct transport to an OpenAI-compatible endpoint
 *                  (a local fake LLM that allows CORS), a direct endpoint that cannot be reached (graceful
 *                  message + hint), world file export / import, settings, the start screen opening at
 *                  the top again after a run, offline-picked worlds labelled as recorded demos.
 *   backend        `server/dev.ts` (what `npm run dev` runs): the server lists its presets, worlds are
 *                  created through the backend proxy (POST /api/llm → the fake LLM via OLLAMA_BASE_URL)
 *                  with a prompt and with "Surprise me", and a demo world plays.
 *   production     `vite build` into a scratch folder, then `npm start` (server/index.ts, NODE_ENV=production)
 *                  serving it: the page loads from the API server, a demo world plays, "Surprise me" works.
 *
 * All groups use one port (MODES_PORT, default 5193), one after the other. The fake LLM answers every chat
 * completion with a recorded world (content/worlds/fixture-teen.json), so the real generation pipeline
 * runs: validation, bot play-test in a Web Worker, storage, run start.
 * Screenshots: test-results/shots/M4/shell-*.png (desktop 1280×800 and phone 390×844); with
 * SHOTS_TO_DOCS=1 they go to docs/progress/M4 (the committed milestone screenshots).
 * Run: xvfb-run -a npx playwright test e2e/modes.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startStaticServer } from '../server/serve-static';

const PORT = Number(process.env.MODES_PORT) || 5193;
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M4' : 'test-results/shots/M4';
mkdirSync(OUT, { recursive: true });

const WORLD_TEXT = readFileSync('content/worlds/fixture-teen.json', 'utf8');
const WORLD_TITLE = JSON.parse(WORLD_TEXT).meta.title as string;
const PHONE = { width: 390, height: 844 };

/** an OpenAI-compatible endpoint that "invents" fixture-teen for every request, with CORS */
async function startFakeLlm(): Promise<{ url: string; calls: () => number; close: () => Promise<void> }> {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, cors).end();
        return;
      }
      calls++;
      const model = (() => {
        try {
          return (JSON.parse(body) as { model?: string }).model ?? 'fake';
        } catch {
          return 'fake';
        }
      })();
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: `fake-${calls}`,
          object: 'chat.completion',
          created: 1,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: WORLD_TEXT }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls: () => calls,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** page errors and console errors (failed requests the test provokes on purpose are allowed) */
function collectErrors(page: Page, allow: RegExp[] = []): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = `${m.text()} ${m.location()?.url ?? ''}`;
    if (allow.some((r) => r.test(text))) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function prepare(page: Page, settings?: unknown) {
  await page.addInitScript((s) => {
    try {
      if (!sessionStorage.getItem('aw-e2e-init')) {
        sessionStorage.setItem('aw-e2e-init', '1');
        localStorage.clear();
        localStorage.setItem('anyworld.lang.v1', 'en');
        if (s) localStorage.setItem('anyworld.settings.v1', JSON.stringify(s));
      }
    } catch {
      /* storage blocked */
    }
    // the dev server's HMR socket: other agents edit files while this runs; never reload mid-test
    const Native = window.WebSocket;
    const Stub = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      if (String(protocols ?? '').includes('vite-hmr')) return { send() {}, close() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 } as unknown as WebSocket;
      return new Native(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Stub;
  }, settings ?? null);
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(300);
}

async function waitGame(page: Page, timeout = 90000) {
  await page.waitForFunction(() => document.getElementById('ui-root')?.dataset.screen === 'game' && !!window.__anyworld?.controller, null, { timeout });
  await page.waitForTimeout(800);
}

async function openSettings(page: Page) {
  await page.locator('.aw-start-settings').click();
  await expect(page.locator('#aw-set-preset')).toBeVisible();
}

async function saveSettings(page: Page) {
  await page.locator('#aw-set-save').click();
  await expect(page.locator('#aw-set-preset')).toBeHidden();
}

async function backToStart(page: Page) {
  await page.evaluate(() => window.__anyworld!.showStart());
  await expect(page.locator('.aw-start')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------------------
// static build
// ---------------------------------------------------------------------------

test.describe('static build (browser-only)', () => {
  let stat: Awaited<ReturnType<typeof startStaticServer>> | null = null;
  let llm: Awaited<ReturnType<typeof startFakeLlm>> | null = null;

  test.beforeAll(async () => {
    test.setTimeout(240000);
    execSync('npx vite build --mode static', { stdio: 'pipe', timeout: 200000 });
    stat = await startStaticServer({ dir: 'dist/static', port: PORT, host: '127.0.0.1' });
    llm = await startFakeLlm();
  });

  test.afterAll(async () => {
    await stat?.close();
    await llm?.close();
  });

  test('start screen: demo mode line, no backend calls, filters, phone layout', async ({ page }) => {
    const errors = collectErrors(page);
    const api: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/')) api.push(r.url());
    });
    await prepare(page);
    await page.goto(`${BASE}/`);
    await waitReady(page);
    await expect(page.locator('.aw-start')).toBeVisible();
    // static build: direct transport only, no server to ask; a first visit starts with the offline demo
    const note = page.locator('.aw-start-note');
    await expect(note).toHaveAttribute('data-tone', 'demo');
    expect(api).toEqual([]);
    // inspiration filters: a theme chip narrows the cards to prompts with that tag
    const chip = page.locator('.aw-tag-chip').first();
    const tag = (await chip.getAttribute('data-tag'))!;
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    const cards = page.locator('.aw-insp-card');
    expect(await cards.count()).toBeGreaterThan(0);
    // language filter: only Norwegian prompts
    await page.locator('#aw-insp-lang').selectOption('nb');
    await chip.click().catch(() => {}); // the chip may be gone in nb; clear the tag either way
    for (const lang of await page.locator('.aw-insp-card').evaluateAll((els) => els.map((e) => e.getAttribute('lang')))) expect(lang).toBe('nb');
    await page.locator('#aw-insp-lang').selectOption('all');
    const on = page.locator('.aw-tag-chip[aria-pressed="true"]');
    if (await on.count()) await on.click();
    await expect(page.locator('.aw-tag-chip[aria-pressed="true"]')).toHaveCount(0);
    expect(tag.length).toBeGreaterThan(0);
    await page.screenshot({ path: `${OUT}/shell-static-start-desktop.png` });
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/shell-static-start-phone-390x844.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test('demo world plays with no LLM at all', async ({ page }) => {
    const errors = collectErrors(page);
    await prepare(page);
    await page.goto(`${BASE}/`);
    await waitReady(page);
    await page.locator('.aw-demo[data-world="fixture-teen"]').click();
    await waitGame(page);
    await expect(page).toHaveURL(/world=fixture-teen/);
    const before = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
    await page.keyboard.press('Escape');
    for (const k of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Period']) await page.keyboard.press(k);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.state.turn)).toBeGreaterThan(before);
    expect(errors).toEqual([]);
  });

  test('settings: direct-mode key warning, forget key, quality, GM and SoundCloud toggles persist', async ({ page }) => {
    const errors = collectErrors(page);
    await prepare(page);
    await page.goto(`${BASE}/`);
    await waitReady(page);
    await openSettings(page);
    // the static build starts on the offline demo; choose a real provider to see the key and transport fields
    await page.locator('#aw-set-preset').selectOption('anthropic');
    // static build: the backend transport is not offered
    await expect(page.locator('#aw-set-transport-backend')).toBeDisabled();
    await expect(page.locator('#aw-set-keywarn')).toContainText('localStorage');
    await page.locator('#aw-set-key').fill('sk-test-123');
    await page.locator('#aw-set-quality').selectOption('low');
    await page.locator('#aw-set-gm').uncheck();
    await page.locator('#aw-set-soundcloud').check();
    await page.screenshot({ path: `${OUT}/shell-settings-desktop.png` });
    await saveSettings(page);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('anyworld.settings.v1') ?? '{}'));
    expect(stored).toMatchObject({ quality: 'low', gm: false, audio: { soundcloud: true }, provider: { apiKey: 'sk-test-123', transport: 'direct' } });
    // the status line now says the AI is ready, the key is local, and the GM is off
    const note = page.locator('.aw-start-note');
    await expect(note).toContainText('in the browser');
    await expect(note).toContainText('this browser only');
    await expect(note).toContainText('game master is off');
    // forget the key again
    await openSettings(page);
    await page.locator('#aw-set-clearkey').click();
    await expect(page.locator('#aw-set-key')).toHaveValue('');
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/shell-settings-phone-390x844.png` });
    await saveSettings(page);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('anyworld.settings.v1') ?? '{}').provider.apiKey)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('first visit: "Surprise me" plays a recorded demo world; the technical notes link works', async ({ page }) => {
    const errors = collectErrors(page);
    await prepare(page);
    await page.goto(`${BASE}/`);
    await waitReady(page);
    const tech = page.locator('.aw-start-tech');
    await expect(tech).toHaveAttribute('href', 'tech.html');
    await page.getByRole('button', { name: 'Surprise me' }).click();
    await waitGame(page);
    const id = await page.evaluate(() => window.__anyworld!.controller!.session.worldId);
    expect(id).not.toMatch(/^gen-|^fixture-/); // a demo world as it is, not a "generated" copy
    await backToStart(page);
    await tech.click();
    await expect(page.locator('h1')).toContainText('technical notes');
    await expect(page.locator('a[href="https://github.com/narve/any-world"]').first()).toBeVisible();
    await page.locator('a.back').click();
    await waitReady(page);
    await expect(page.locator('.aw-start')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('offline demo generator: "Create world" and "Surprise me" with no AI, then "Your worlds"', async ({ page }) => {
    const errors = collectErrors(page);
    await prepare(page, { provider: { preset: 'mock', transport: 'direct' }, audio: { volume: 0.6, muted: true }, animationSpeed: 1, reduceMotion: false });
    await page.goto(`${BASE}/`);
    await waitReady(page);
    await expect(page.locator('.aw-start-note')).toHaveAttribute('data-tone', 'demo');
    await page.locator('#aw-prompt').fill('A silent heist in a Vienna concert hall');
    await page.getByRole('button', { name: 'Create world' }).click();
    await expect(page.locator('.aw-loading')).toBeVisible();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${OUT}/shell-offline-loading-desktop.png` });
    await waitGame(page);
    const title = await page.evaluate(() => window.__anyworld!.controller!.session.world.meta.title);
    expect(title).toBe('Pianissimo');
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.worldId)).toMatch(/^gen-/);

    await backToStart(page);
    // "Surprise me" with no AI plays a demo world as it is, so it adds nothing to "Your worlds"
    await page.getByRole('button', { name: 'Surprise me' }).click();
    await waitGame(page);
    await backToStart(page);
    const recent = page.locator('.aw-recent-play');
    await expect(recent).toHaveCount(1);
    await expect(page.locator('.aw-recent')).toContainText('Pianissimo');
    // no AI made these: they are copies of recorded worlds (issues/M5-offline-demo-labelled-ai.md)
    for (const label of await recent.locator('.aw-demo-genre').allTextContents()) {
      expect(label).toContain('recorded demo');
      expect(label).not.toContain('made by AI');
    }
    await page.screenshot({ path: `${OUT}/shell-your-worlds-desktop.png` });
    // a kept world plays again from the list
    await recent.last().click();
    await waitGame(page);
    expect(errors).toEqual([]);
  });

  test('"New world" after a run opens the start screen at the top, prompt box in view', async ({ page }) => {
    // issues/M5-start-screen-keeps-scroll.md: it used to keep the scroll position of the demo card clicked before
    const errors = collectErrors(page);
    await prepare(page);
    await page.goto(`${BASE}/`);
    await waitReady(page);
    const start = page.locator('main.aw-start');
    const scrollTop = () => start.evaluate((el) => el.scrollTop);
    // pick a demo from far down the list (the start screen scrolls to it)
    const card = page.locator('.aw-demo').last();
    await card.scrollIntoViewIfNeeded();
    expect(await scrollTop()).toBeGreaterThan(100);
    await card.click();
    await waitGame(page);
    await page.evaluate(() => window.__anyworld!.controller!.setStateForTest((s) => { (s as { status: string }).status = 'lost'; }));
    await page.getByRole('button', { name: 'New world' }).click();
    await expect(start).toBeVisible();
    await expect.poll(scrollTop).toBe(0);
    await expect(page.locator('#aw-prompt')).toBeInViewport();
    await expect(page.locator('#aw-prompt')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('direct transport: a world created by an OpenAI-compatible endpoint (CORS) plays', async ({ page }) => {
    const errors = collectErrors(page);
    const before = llm!.calls();
    await prepare(page, { provider: { preset: 'custom', transport: 'direct', baseUrl: llm!.url, model: 'fake-model' }, audio: { volume: 0.6, muted: true }, animationSpeed: 1, reduceMotion: false });
    await page.goto(`${BASE}/`);
    await waitReady(page);
    await expect(page.locator('.aw-start-note')).toHaveAttribute('data-tone', 'ok');
    await page.locator('#aw-prompt').fill('A teen drama at a flooded school');
    await page.getByRole('button', { name: 'Create world' }).click();
    await waitGame(page);
    expect(llm!.calls()).toBeGreaterThan(before);
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.world.meta.title)).toBe(WORLD_TITLE);
    expect(errors).toEqual([]);
  });

  test('direct transport to an endpoint that does not answer: a clear error with a hint, then demo still works', async ({ page }) => {
    const errors = collectErrors(page, [/Failed to load resource|ERR_CONNECTION_REFUSED|net::/]);
    await prepare(page, { provider: { preset: 'custom', transport: 'direct', baseUrl: 'http://127.0.0.1:9/v1', model: 'x' }, audio: { volume: 0.6, muted: true }, animationSpeed: 1, reduceMotion: false });
    await page.goto(`${BASE}/`);
    await waitReady(page);
    await page.getByRole('button', { name: 'Surprise me' }).click();
    const err = page.locator('.aw-loading .aw-error');
    await expect(err).toBeVisible({ timeout: 60000 });
    await expect(err).toContainText('Could not reach the AI provider');
    await expect(err).toContainText('local AI server');
    await page.screenshot({ path: `${OUT}/shell-error-hint-desktop.png` });
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/shell-error-hint-phone-390x844.png` });
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.locator('.aw-start')).toBeVisible();
    await page.locator('.aw-demo[data-world="fixture-ship"]').click();
    await waitGame(page);
    expect(errors).toEqual([]);
  });

  test('world files: export a kept world, import it again, refuse a bad file', async ({ page }, info) => {
    const errors = collectErrors(page);
    await prepare(page, { provider: { preset: 'mock', transport: 'direct' }, audio: { volume: 0.6, muted: true }, animationSpeed: 1, reduceMotion: false });
    await page.goto(`${BASE}/`);
    await waitReady(page);
    // nothing kept yet: the import hint shows
    await expect(page.locator('.aw-recent')).toContainText('Open it here');
    // "Create world" keeps a copy under "Your worlds" ("Surprise me" with no AI just plays a demo world)
    await page.getByRole('button', { name: 'Create world' }).click();
    await waitGame(page);
    await backToStart(page);

    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.aw-recent-export').first().click()]);
    expect(download.suggestedFilename()).toMatch(/\.anyworld\.json$/);
    const path = info.outputPath(download.suggestedFilename());
    await download.saveAs(path);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file).toMatchObject({ format: 'anyworld-world', version: 1 });
    expect(file.world.specVersion).toBe(1);

    // forget it, then import it back from the file
    await page.locator('.aw-recent-forget').first().click();
    await expect(page.locator('.aw-recent-play')).toHaveCount(0);
    await page.locator('#aw-import-file').setInputFiles(path);
    await expect(page.locator('.aw-toasts')).toContainText('Opened');
    await expect(page.locator('.aw-recent-play')).toHaveCount(1);
    await expect(page.locator('.aw-recent-play')).toContainText('from a file');
    await expect(page.locator('.aw-recent-play')).toContainText(file.world.meta.title);

    // untrusted input: a broken file is refused with a message, nothing is added
    await page.locator('#aw-import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"meta": {"title": "x"}, "specVersion": 1}') });
    await expect(page.locator('.aw-toasts')).toContainText('has errors');
    await page.locator('#aw-import-file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(page.locator('.aw-toasts')).toContainText('not a world file');
    await expect(page.locator('.aw-recent-play')).toHaveCount(1);
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(300);
    await page.locator('.aw-recent').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/shell-your-worlds-phone-390x844.png` });

    // the imported world plays
    await page.locator('.aw-recent-play').click();
    await waitGame(page);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// backend (npm run dev)
// ---------------------------------------------------------------------------

test.describe('backend mode (server/dev.ts)', () => {
  let dev: ChildProcess | null = null;
  let llm: Awaited<ReturnType<typeof startFakeLlm>> | null = null;
  let log = '';

  test.beforeAll(async () => {
    test.setTimeout(120000);
    llm = await startFakeLlm();
    dev = spawn('npx', ['tsx', 'server/dev.ts'], {
      env: { ...process.env, PORT: '0', ANYWORLD_CLIENT_PORT: String(PORT), OLLAMA_BASE_URL: llm.url, OLLAMA_MODEL: 'fake-model', NO_PROXY: '*', no_proxy: '*' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    dev.stdout?.on('data', (d) => (log += String(d)));
    dev.stderr?.on('data', (d) => (log += String(d)));
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() - t0 > 90000) throw new Error(`dev server did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  test.afterAll(async () => {
    if (dev?.pid) {
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        dev.kill('SIGTERM');
      }
    }
    await llm?.close();
  });

  test('the server lists its presets; "Surprise me" creates a world through the backend proxy and it plays', async ({ page }) => {
    const errors = collectErrors(page);
    const presets = (await (await fetch(`${BASE}/api/presets`)).json()) as { presets: { id: string; configured: boolean }[] };
    expect(presets.presets.find((p) => p.id === 'ollama')?.configured).toBe(true);
    expect(presets.presets.find((p) => p.id === 'anthropic')?.configured).toBe(!!process.env.ANTHROPIC_API_KEY);

    await prepare(page, { provider: { preset: 'anthropic', transport: 'backend' }, audio: { volume: 0.6, muted: true }, animationSpeed: 1, reduceMotion: false });
    await page.goto(`${BASE}/`);
    await waitReady(page);
    if (!process.env.ANTHROPIC_API_KEY) {
      // the server has no Claude key: the line says which variable to set; demo worlds still work
      await expect(page.locator('.aw-start-note')).toContainText('ANTHROPIC_API_KEY');
      await page.screenshot({ path: `${OUT}/shell-backend-nokey-desktop.png` });
    }
    await openSettings(page);
    await expect(page.locator('#aw-set-server')).toContainText('Ollama');
    await page.locator('#aw-set-preset').selectOption('ollama');
    await page.locator('#aw-set-transport-backend').check();
    await saveSettings(page);
    await expect(page.locator('.aw-start-note')).toHaveAttribute('data-tone', 'ok');
    await expect(page.locator('.aw-start-note')).toContainText('via the server');

    const before = llm!.calls();
    await page.getByRole('button', { name: 'Surprise me' }).click();
    await waitGame(page);
    expect(llm!.calls()).toBeGreaterThan(before);
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.world.meta.title)).toBe(WORLD_TITLE);
    expect(errors).toEqual([]);
  });

  test('backend: a world from a typed prompt is created through /api/llm and plays', async ({ page }) => {
    const errors = collectErrors(page);
    await prepare(page, { provider: { preset: 'ollama', transport: 'backend' }, audio: { volume: 0.6, muted: true }, animationSpeed: 1, reduceMotion: false });
    await page.goto(`${BASE}/`);
    await waitReady(page);
    await expect(page.locator('.aw-start-note')).toHaveAttribute('data-tone', 'ok');
    const llmBody: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/llm')) llmBody.push(r.postData() ?? '');
    });
    const before = llm!.calls();
    await page.locator('#aw-prompt').fill('A teen drama at a flooded school');
    await page.getByRole('button', { name: 'Create world' }).click();
    await waitGame(page);
    expect(llm!.calls()).toBeGreaterThan(before);
    // the prompt reached the model through the backend proxy
    expect(llmBody.some((b) => b.includes('flooded school'))).toBe(true);
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.world.meta.title)).toBe(WORLD_TITLE);
    expect(errors).toEqual([]);
  });

  test('demo world in backend mode', async ({ page }) => {
    const errors = collectErrors(page);
    await prepare(page);
    await page.goto(`${BASE}/?world=nb-troll-direktoratet&seed=4`);
    await waitGame(page);
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.world.meta.language)).toBe('nb');
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// production (npm start)
// ---------------------------------------------------------------------------

test.describe('production server (npm start)', () => {
  let prod: ChildProcess | null = null;
  let llm: Awaited<ReturnType<typeof startFakeLlm>> | null = null;
  let log = '';
  // a scratch build, so a parallel `vite build` into dist/client cannot pull files from under the test
  const DIST = resolve('test-results/modes-prod-client');

  test.beforeAll(async () => {
    test.setTimeout(300000);
    execSync(`npx vite build --outDir ${JSON.stringify(DIST)} --emptyOutDir`, { stdio: 'pipe', timeout: 240000 });
    llm = await startFakeLlm();
    prod = spawn('npm', ['start'], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', STATIC_DIR: DIST, OLLAMA_BASE_URL: llm.url, OLLAMA_MODEL: 'fake-model', NO_PROXY: '*', no_proxy: '*' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    prod.stdout?.on('data', (d) => (log += String(d)));
    prod.stderr?.on('data', (d) => (log += String(d)));
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() - t0 > 60000) throw new Error(`npm start did not come up:\n${log}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  test.afterAll(async () => {
    if (prod?.pid) {
      try {
        process.kill(-prod.pid, 'SIGTERM');
      } catch {
        prod.kill('SIGTERM');
      }
    }
    await llm?.close();
  });

  test('the API server serves the built client; a demo world plays and "Surprise me" creates a world', async ({ page }) => {
    const errors = collectErrors(page);
    expect(log).toContain('serving');
    const html = await (await fetch(`${BASE}/`)).text();
    expect(html).toContain('<div id="ui-root"');
    await prepare(page, { provider: { preset: 'ollama', transport: 'backend' }, audio: { volume: 0.6, muted: true }, animationSpeed: 1, reduceMotion: false });
    await page.goto(`${BASE}/`);
    await waitReady(page);
    // the production build defaults to the backend transport and finds the server's key
    await expect(page.locator('.aw-start-note')).toHaveAttribute('data-tone', 'ok');
    await page.locator('.aw-demo[data-world="fixture-teen"]').click();
    await waitGame(page);
    const before = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
    await page.keyboard.press('Escape');
    for (const k of ['ArrowRight', 'ArrowDown', 'Period']) await page.keyboard.press(k);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.state.turn)).toBeGreaterThan(before);

    await backToStart(page);
    const calls = llm!.calls();
    await page.getByRole('button', { name: 'Surprise me' }).click();
    await waitGame(page);
    expect(llm!.calls()).toBeGreaterThan(calls);
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.worldId)).toMatch(/^gen-/);
    await page.screenshot({ path: `${OUT}/shell-production-desktop.png` });
    expect(errors).toEqual([]);
  });
});
