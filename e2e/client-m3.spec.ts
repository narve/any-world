/**
 * M3 "clearer controls & goals" (PLAN backlog from the Lowmoor playtest), touch-first, in the real
 * app at desktop (1280×800) and iPhone (390×844, touch) sizes:
 *  - pressing / tapping the equipped Thesaurus explains it in a tip by the slot (no backpack)
 *  - the context action bar (Talk, Search, Wait…; a locked exit says why) with key hints only after
 *    a key was pressed
 *  - the goal tracker (summary + current step, expands into the win/lose conditions)
 *  - the onboarding card after the prologue, "don't show again" per world
 * Screenshots: docs/archive/progress/M3/client-*.png
 *
 * Runs against the config's baseURL; M3_UX_BASE=http://localhost:<port> points it at another dev server.
 */
import { test, expect, devices, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/archive/progress/M3' : 'test-results/shots/M3';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.M3_UX_BASE;
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/client-${name}.png` });
const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');

if (BASE) test.use({ baseURL: BASE });

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function open(page: Page, world: string, seed: number): Promise<void> {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('m3-init')) {
      localStorage.clear();
      localStorage.setItem('anyworld.lang.v1', 'en');
      sessionStorage.setItem('m3-init', '1');
    }
  });
  await page.goto(`/?world=${world}&seed=${seed}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(800);
}

/** click (or tap) the narration button until the prologue is gone */
async function closeNarration(page: Page, tap: boolean): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const btn = page.locator('.aw-narration:not([hidden]) .aw-narr-btn');
    if (!(await btn.isVisible().catch(() => false))) return;
    if (tap) await btn.tap();
    else await btn.click();
    await page.waitForTimeout(250);
  }
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Lowmoor: onboarding, goal tracker, slot tip, context bar, locked exit, help legend', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, 'fixture-teen', 7);
    await expect(page.locator('.aw-narration')).toBeVisible();
    // the onboarding waits for the prologue
    await expect(page.locator('.aw-onboard')).toBeHidden();
    await closeNarration(page, false);

    // --- onboarding card: how to win, how conflict works here, the controls for this input mode
    const card = page.locator('.aw-onboard');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Lowmoor Goes Under');
    await expect(card).toContainText('not about violence');
    await expect(card).toContainText('Comeback');
    await expect(card.locator('h3').filter({ hasText: 'Mouse & keyboard' })).toBeVisible();
    await shot(page, '01-onboarding-desktop');
    await card.locator('.aw-onboard-ok').click();
    await expect(card).toBeHidden();
    const seen = await page.evaluate(() => localStorage.getItem('anyworld.onboarded.v1'));
    expect(JSON.parse(seen ?? '[]')).toContain('fixture-teen');

    // --- goal tracker: summary + concrete step; expands into conditions in plain words
    const goal = page.locator('.aw-goal');
    await expect(goal).toBeVisible();
    await expect(goal.locator('.aw-goal-step')).toContainText('find the way on');
    await goal.locator('.aw-goal-head').click();
    await expect(goal.locator('.aw-goal-body')).toBeVisible();
    await expect(goal.locator('.aw-goal-body')).toContainText('One of these:');
    await expect(goal.locator('.aw-goal-body')).toContainText("Junie's Speech Notebook");
    await expect(goal.locator('.aw-goal-body')).toContainText('Detentions: 3 or more');
    await shot(page, '02-goal-expanded-desktop');
    await goal.locator('.aw-goal-head').click();
    await expect(goal.locator('.aw-goal-body')).toBeHidden();

    // --- the reported bug: "1" on the equipped Thesaurus explains it; the backpack stays shut
    const slot0 = await page.evaluate(() => {
      const s = window.__anyworld!.controller!.session.me.slots[0];
      return s?.defId ?? null;
    });
    expect(slot0).toBe('thesaurus');
    await page.keyboard.press('1');
    await page.waitForTimeout(300);
    await expect(page.locator('.aw-backpack')).toBeHidden();
    const tip = page.locator('.aw-slot-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Equipped as your Comeback');
    await expect(tip).toContainText('E badge');
    await shot(page, '03-slot-tip-desktop');
    // Details opens the full card on purpose
    await tip.locator('.aw-btn').click();
    await expect(page.locator('.aw-backpack')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.aw-backpack')).toBeHidden();

    // --- context bar: key hints show once a key was used (we pressed 1 already)
    const ctx = page.locator('.aw-ctx');
    await expect(ctx).toBeVisible();
    await expect(ctx.locator('.ctx-wait')).toBeVisible();
    await expect(ctx.locator('.ctx-wait kbd')).toBeVisible();
    await expect(ctx.locator('.ctx-search')).toBeVisible();
    const t0 = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
    await ctx.locator('.ctx-wait').click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.state.turn)).toBeGreaterThan(t0);

    // --- a locked way on: stand on Tuesday's exit without the notebook
    await page.evaluate(async () => {
      const c = window.__anyworld!.controller!;
      await c.setStateForTest((st) => {
        st.area.index = 1;
        const p = st.area.actors.find((a) => a.id === st.players[st.party[0]].actorId)!;
        st.area.actors = st.area.actors.filter((a) => a.id === st.players[st.party[0]].actorId);
        p.pos = { ...st.area.map.exit };
        st.players[st.party[0]].slots = st.players[st.party[0]].slots.map((it) => (it && it.defId === 'speech-notebook' ? null : it));
      });
    });
    await page.waitForTimeout(400);
    const exit = ctx.locator('.ctx-exit');
    await expect(exit).toBeVisible();
    await expect(exit).toHaveClass(/is-blocked/);
    await expect(page.locator('.aw-goal-step')).toContainText("Get Junie's Speech Notebook");
    await exit.click();
    await expect(page.locator('.aw-toast').filter({ hasText: 'First: Get Junie' })).toBeVisible();
    await shot(page, '04-locked-exit-desktop');
    // pressing > explains the same way
    await page.keyboard.press('>');
    await expect(page.locator('.aw-toast').filter({ hasText: 'is locked' }).first()).toBeVisible();

    // with the notebook the exit is the primary button
    await page.evaluate(async () => {
      const c = window.__anyworld!.controller!;
      await c.setStateForTest((st) => {
        st.players[st.party[0]].slots[12] = { id: 'test-notebook', defId: 'speech-notebook', count: 1 };
      });
    });
    await page.waitForTimeout(300);
    await expect(exit).toHaveClass(/is-primary/);
    await shot(page, '05-exit-open-desktop');

    // --- help: the E badge legend and "how this world works"
    await page.keyboard.press('?');
    const help = page.locator('.aw-help');
    await expect(help.locator('.aw-help-legend')).toContainText('Equipped');
    await page.waitForTimeout(400); // the modal fades in
    await shot(page, '06-help-legend-desktop');
    await help.locator('.aw-help-howto').click();
    await expect(page.locator('.aw-onboard')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.aw-onboard')).toBeHidden();
    expect(await layer(page)).toBe('game');

    // switching the UI language rebuilds the overlay in place; the run goes on
    const turn = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
    await page.evaluate(() => window.__anyworld!.setLanguage('en'));
    await page.waitForTimeout(300);
    await expect(page.locator('.aw-goal')).toBeVisible();
    await expect(page.locator('.aw-hotbar')).toHaveCount(1);
    await page.keyboard.press('.');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__anyworld!.controller!.session.state.turn)).toBeGreaterThan(turn);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    expect(errors).toEqual([]);
  });

  test('the onboarding is not shown again for a world once dismissed for good', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('anyworld.onboarded.v1', JSON.stringify(['fixture-western']));
    });
    await page.goto('/?world=fixture-western&seed=4');
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    await closeNarration(page, false);
    await page.waitForTimeout(300);
    await expect(page.locator('.aw-onboard')).toBeHidden();
    await expect(page.locator('.aw-goal')).toBeVisible();
    // no key pressed yet: the context bar has no key hints
    await expect(page.locator('.aw-ctx .ctx-wait')).toBeVisible();
    await expect(page.locator('.aw-ctx .ctx-wait kbd')).toBeHidden();
  });
});

test.describe('iPhone (touch)', () => {
  const iphone = devices['iPhone 13'];
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: iphone.userAgent });

  test('Lowmoor by touch: onboarding sheet, tap the Thesaurus, talk button, goal tracker', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, 'fixture-teen', 7);
    await shot(page, 'phone-00-prologue');
    await closeNarration(page, true);

    const card = page.locator('.aw-onboard');
    await expect(card).toBeVisible();
    // touch controls, not keys
    await expect(card.locator('h3').filter({ hasText: 'Touch' })).toBeVisible();
    await expect(card).toContainText('Tap a tile');
    await shot(page, 'phone-01-onboarding');
    await card.locator('.aw-onboard-ok').tap();
    await expect(card).toBeHidden();

    const ctx = page.locator('.aw-ctx');
    await expect(ctx).toBeVisible();
    // no keyboard used: no key hints
    await expect(ctx.locator('kbd').first()).toBeHidden();
    // every context button is a real tap target
    for (const b of await ctx.locator('.aw-ctx-btn').all()) {
      const box = await b.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await shot(page, 'phone-02-play');

    // tap the equipped Thesaurus: a tip, not the backpack
    await page.locator('.aw-hotbar .aw-slot[data-slot="0"]').tap();
    await page.waitForTimeout(300);
    await expect(page.locator('.aw-slot-tip')).toBeVisible();
    await expect(page.locator('.aw-slot-tip')).toContainText('Equipped as your Comeback');
    await expect(page.locator('.aw-backpack')).toBeHidden();
    // a tap is not a hover: the item's hover card stays closed
    await expect(page.locator('.aw-tooltip.is-visible')).toHaveCount(0);
    await shot(page, 'phone-03-slot-tip');
    // a tap elsewhere closes it
    await page.locator('.aw-goal-head').tap();
    await expect(page.locator('.aw-slot-tip')).toBeHidden();

    // the goal tracker expanded
    await expect(page.locator('.aw-goal-body')).toBeVisible();
    await shot(page, 'phone-04-goal');
    await page.locator('.aw-goal-head').tap();
    await expect(page.locator('.aw-goal-body')).toBeHidden();

    // talk by tapping the context button (the janitor starts next to Juniper on this seed)
    const talk = ctx.locator('.ctx-talk');
    if (await talk.isVisible()) {
      await talk.tap();
      await page.waitForTimeout(400);
      expect(await layer(page)).toBe('dialogue');
      await shot(page, 'phone-05-talk');
      await page.locator('.aw-dialogue .aw-btn-ghost').last().tap();
      await page.waitForTimeout(300);
    }
    // nothing on the page is wider than the screen
    const overflow = await page.evaluate(() => {
      const w = window.innerWidth;
      return [...document.querySelectorAll<HTMLElement>('.aw-game *')]
        .filter((e) => e.offsetParent !== null && !e.closest('.aw-ctx'))
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && (r.right > w + 1 || r.left < -1)).length;
    });
    expect(overflow).toBe(0);
    expect(errors).toEqual([]);
  });

  test('western by touch: locked mine gate explains itself', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, 'fixture-western', 11);
    await closeNarration(page, true);
    await page.locator('.aw-onboard-ok').tap();
    await page.evaluate(async () => {
      const c = window.__anyworld!.controller!;
      await c.setStateForTest((st) => {
        st.area.index = 1;
        const p = st.area.actors.find((a) => a.id === st.players[st.party[0]].actorId)!;
        st.area.actors = st.area.actors.filter((a) => a.id === st.players[st.party[0]].actorId);
        p.pos = { ...st.area.map.exit };
      });
    });
    await page.waitForTimeout(400);
    const exit = page.locator('.aw-ctx .ctx-exit');
    await expect(exit).toHaveClass(/is-blocked/);
    await exit.tap();
    await expect(page.locator('.aw-toast').first()).toContainText('First: Get');
    await shot(page, 'phone-06-locked-exit');
    expect(errors).toEqual([]);
  });
});
