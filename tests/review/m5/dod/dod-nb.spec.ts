/**
 * M5 DoD audit (DESIGN §10 item 11): every Norwegian (language "nb") recorded world is played to its
 * end in the browser with the UI in bokmål, driven by the sim's talker bot through the real controller.
 * Every few turns the visible overlay text (log, GM narration, dialogue, HUD, tooltips' attributes) is
 * captured and scanned for English. Leaks go to test-results/shots/M5-dod/nb-leaks.json.
 * Run: xvfb-run -a npx playwright test -c tests/review/m5/dod/playwright.dod.config.ts dod-nb
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = join(ROOT, 'test-results/shots/M5-dod');
mkdirSync(OUT, { recursive: true });

const NB_WORLDS = readdirSync(join(ROOT, 'content/worlds'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((id) => (JSON.parse(readFileSync(join(ROOT, `content/worlds/${id}.json`), 'utf8')).meta.language ?? 'en') === 'nb')
  .sort();

/** English words that do not belong in bokmål text (same list as tests/i18n/e2e/nb-play.spec.ts) */
const ENGLISH =
  /\b(the|The|you|You|your|Your|and|with|click|Click|tap|Tap|turn|Turn|turns|level|Level|items?|slot|Slot|backpack|Backpack|rules?|Rules?|goal|Goal|nothing|Nothing|someone|Someone|Ask|Goodbye|Offer|Wait|Search|Talk|Pick up|Use|Close|Continue|Skip|Settings|Language|Difficulty|Weirdness|Inspiration|Demo|worlds?|Worlds?|picks up|takes|misses|appears|of|are|from|here|Here|Blocked|direction|trader|healer|informant|quest giver|Health|Strength|Mana|Armour|Victory)\b/;
const ALLOW = /AnyWorld|SoundCloud|OpenAI|localStorage|CORS|API|URL/g;

async function overlayText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [document.body.innerText];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[aria-label], [title], [data-tip], [placeholder]'))) {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      for (const a of ['aria-label', 'title', 'data-tip', 'placeholder']) {
        const v = el.getAttribute(a);
        if (v) parts.push(v);
      }
    }
    return parts.join('\n');
  });
}

const leaks: Record<string, string[]> = {};

test.describe.configure({ mode: "default" });

for (const id of NB_WORLDS) {
  test(`DoD nb: ${id} plays in bokmål with no English on screen`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        localStorage.setItem('anyworld.lang.v1', 'nb');
      } catch {
        /* storage blocked */
      }
      const Native = window.WebSocket;
      const Stub = function (this: unknown, url: string | URL, protocols?: string | string[]) {
        if (String(protocols ?? '').includes('vite-hmr')) return { send() {}, close() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 } as unknown as WebSocket;
        return new Native(url, protocols);
      } as unknown as typeof WebSocket;
      Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
      window.WebSocket = Stub;
    });
    await page.goto('/');
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    const card = page.locator(`.aw-demo[data-world="${id}"]`);
    expect(await card.count(), `${id} is listed on the bokmål start screen`).toBeGreaterThan(0);
    await card.click();
    await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });

    const texts = new Set<string>();
    const grab = async () => {
      for (const l of (await overlayText(page)).split('\n')) if (l.trim()) texts.add(l.trim());
    };
    await grab();
    const botPath = '/@fs' + join(ROOT, 'src/engine/sim/bots.ts');
    await page.evaluate(async (botPath) => {
      const mod = (await import(/* @vite-ignore */ botPath)) as typeof import('../../../../src/engine/sim/bots');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      w.__dodBot = { bot: mod.botByName('talker'), mem: mod.newMemory(11) };
    }, botPath);
    let status = 'playing';
    for (let chunk = 0; chunk < 300 && status === 'playing'; chunk++) {
      status = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const c = w.__anyworld.controller;
        for (let i = 0; i < 15 && c.session.state.status === 'playing'; i++) c.actNow(w.__dodBot.bot.decide(c.session.state, c.session.world, w.__dodBot.mem));
        return c.session.state.status as string;
      });
      await page.waitForTimeout(120);
      await grab();
    }
    await page.waitForTimeout(1500);
    await grab();
    await page.screenshot({ path: join(OUT, `nb-${id}-end.png`) });

    const found = [...texts].filter((l) => ENGLISH.test(l.replace(ALLOW, '')));
    leaks[id] = found;
    writeFileSync(join(OUT, 'nb-leaks.json'), JSON.stringify(leaks, null, 2));
    console.log(`${id}: ${status}, ${texts.size} lines seen, ${found.length} English: ${found.slice(0, 15).join(' | ')}`);
    expect(['won', 'lost']).toContain(status);
    expect(errors).toEqual([]);
    expect(found, `English on screen in ${id}`).toEqual([]);
  });
}
