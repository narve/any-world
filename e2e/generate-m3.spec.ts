/**
 * M3 integration: live world generation and the live GM in the real app. The backend is stood in
 * for by Playwright routes: GET /api/presets says "anthropic" is configured, POST /api/llm answers
 * the world request with content/worlds/fixture-teen.json (first with a broken copy, so a repair
 * turn happens) and GM / dialogue requests with small valid answers. The balance play-test runs in
 * the Web Worker (src/llm/balance-worker.ts).
 * Screenshots: docs/progress/M3/generate-*.png
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/progress/M3' : 'test-results/shots/M3';
mkdirSync(OUT, { recursive: true });
const teen = readFileSync('content/worlds/fixture-teen.json', 'utf8');

interface LlmBody {
  preset: string;
  request: { purpose: string };
}

async function backend(page: Page, opts: { world: (n: number) => string; gm?: string }): Promise<{ purposes: string[] }> {
  const seen = { purposes: [] as string[] };
  let worldCalls = 0;
  await page.route('**/api/presets', (r: Route) =>
    r.fulfill({
      json: { presets: [{ id: 'anthropic', label: 'Claude', region: 'us', kind: 'anthropic', defaultModel: 'claude-test', structuredOutput: 'native', configured: true }] },
    }),
  );
  await page.route('**/api/llm', async (r: Route) => {
    const body = r.request().postDataJSON() as LlmBody;
    const purpose = body.request.purpose;
    seen.purposes.push(purpose);
    let text: string;
    if (purpose === 'world') {
      await new Promise((res) => setTimeout(res, 400)); // long enough to see the first step
      text = opts.world(worldCalls++);
    } else if (purpose.startsWith('gm:')) text = opts.gm ?? JSON.stringify({ actions: [{ type: 'narrate', text: 'The live GM watches the flood come in.' }] });
    else text = JSON.stringify({ reply: 'Mops first, questions later.', options: [], actions: [], end: false });
    await r.fulfill({ json: { response: { text, model: 'claude-test', stopReason: 'end_turn' } } });
  });
  return seen;
}

async function fresh(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('gen-init')) {
      localStorage.clear();
      localStorage.setItem('anyworld.lang.v1', 'en');
      sessionStorage.setItem('gen-init', '1');
    }
  });
}

test('create a world with the (stubbed) LLM: progress, repair, balance in a worker, play, resume', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await fresh(page);
  const broken = JSON.parse(teen);
  delete broken.meta.title;
  const seen = await backend(page, { world: (n) => (n === 0 ? JSON.stringify(broken) : teen) });
  await page.goto('/');
  await expect(page.locator('.aw-start-note')).toContainText('Claude', { timeout: 15000 });
  await page.locator('.aw-textarea').fill('A school in a town that will be flooded on Friday');
  await page.getByRole('button', { name: 'Create world' }).click();
  await expect(page.locator('.aw-loading')).toBeVisible();
  await expect(page.locator('.aw-loading')).toContainText('invent');
  await page.screenshot({ path: `${OUT}/generate-loading.png` });
  // repair turn, then the title appears while the bots play-test
  await expect(page.locator('.aw-loading-title')).toHaveText('Lowmoor Goes Under', { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/generate-balancing.png` });
  await page.waitForFunction(() => window.__anyworld?.controller?.session.worldId.startsWith('gen-'), null, { timeout: 120000 });
  expect(seen.purposes.filter((p) => p === 'world').length).toBe(2);
  const run = await page.evaluate(() => ({
    worldId: window.__anyworld!.controller!.session.worldId,
    title: window.__anyworld!.controller!.session.world.meta.title,
    prompt: window.__anyworld!.controller!.session.world.meta.prompt,
    stored: (JSON.parse(localStorage.getItem('anyworld.worlds.v1') ?? '[]') as { id: string }[]).map((w) => w.id),
    url: location.search,
  }));
  expect(run.title).toBe('Lowmoor Goes Under');
  expect(run.prompt).toBe('A school in a town that will be flooded on Friday');
  expect(run.stored).toContain(run.worldId);
  expect(run.url).toContain(`world=${run.worldId}`);
  // the live GM answers the intro hook
  await expect.poll(() => seen.purposes.some((p) => p.startsWith('gm:intro/')), { timeout: 30000 }).toBe(true);
  await page.screenshot({ path: `${OUT}/generate-playing.png` });

  // a reload resumes the generated world's run
  await page.reload();
  await page.waitForFunction(() => window.__anyworld?.controller?.session.worldId.startsWith('gen-'), null, { timeout: 60000 });
  expect(await page.evaluate(() => window.__anyworld!.controller!.session.worldId)).toBe(run.worldId);
  expect(errors).toEqual([]);
});

test('a failed generation stays on the loading screen with a readable error, Try again and Back', async ({ page }) => {
  await fresh(page);
  await backend(page, { world: () => 'I would rather write a poem.' });
  await page.goto('/');
  await expect(page.locator('.aw-start-note')).toContainText('Claude', { timeout: 15000 });
  await page.getByRole('button', { name: 'Surprise me' }).click();
  await expect(page.locator('.aw-loading')).toContainText('could not produce a valid world', { timeout: 60000 });
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.screenshot({ path: `${OUT}/generate-error.png` });
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('.aw-textarea')).toBeVisible();
});
