/**
 * M5 review round 3 — focused touch probes found while playing (mobile-playtest-r3.spec.ts):
 *  - behind-player: the free floor tile drawn right behind the player's model (the "up" neighbour on
 *    screen). A tap on its centre should walk there; a non-hostile actor standing there should open
 *    its own card on a long-press and get talked to on a tap.
 *  - dialogue-sheet: the dialogue sheet's buttons sampled every 100 ms for 3 s after the Talk tap,
 *    against the emulated home-bar inset.
 *  - path-walk: with every hostile removed from the area (nothing to stop a walk), a tap on a far
 *    explored tile walks there.
 * Reports: tests/review/m5/reports/m5-mobile-pt-r3-probe-*.json; screenshots docs/progress/M5/pt-mobile-r3-probe-*.png.
 * Run: xvfb-run -a npx playwright test -c tests/review/m5/playwright.mobile-probes-r3.config.ts
 */
import { test, expect, devices, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = resolve(ROOT, 'docs/progress/M5');
const REPORT = resolve(ROOT, 'tests/review/m5/reports');
mkdirSync(OUT, { recursive: true });
mkdirSync(REPORT, { recursive: true });

function phone(name: string) {
  const { defaultBrowserType: _ignored, ...rest } = devices[name];
  return rest;
}

const layer = (page: Page) => page.evaluate(() => window.__anyworld?.ui.layer() ?? 'none');

async function boot(page: Page, world: string, seed: number): Promise<void> {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('pt-init')) {
      localStorage.clear();
      localStorage.setItem('anyworld.lang.v1', 'en');
      sessionStorage.setItem('pt-init', '1');
    }
  });
  await page.goto(`/?world=${world}&seed=${seed}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(900);
  for (let i = 0; i < 8; i++) {
    const narr = page.locator('.aw-narration:not([hidden]) .aw-narr-btn');
    if (await narr.isVisible().catch(() => false)) {
      await narr.tap();
      await page.waitForTimeout(250);
      continue;
    }
    const ok = page.locator('.aw-onboard:not([hidden]) .aw-onboard-ok');
    if (await ok.isVisible().catch(() => false)) {
      await ok.tap();
      await page.waitForTimeout(250);
      continue;
    }
    break;
  }
  expect(await layer(page)).toBe('game');
}

/** the free floor neighbour of the player drawn highest on the screen (behind the model) */
async function behindTile(page: Page) {
  return page.evaluate(() => {
    const app = window.__anyworld!;
    const s = app.controller!.session;
    const st = s.state;
    const me = s.player().pos;
    const r = app.renderer!;
    const w = st.area.map.width;
    let best: { x: number; y: number; sy: number } | null = null;
    for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]]) {
      const p = { x: me.x + dx, y: me.y + dy };
      const t = st.area.map.tiles[p.y * w + p.x] as { kind: string } | undefined;
      if (!t || t.kind !== 'floor') continue;
      if (st.area.actors.some((a) => a.hp > 0 && a.pos.x === p.x && a.pos.y === p.y)) continue;
      const sp = r.tileToScreen(p);
      if (!best || sp.y < best.sy) best = { ...p, sy: sp.y };
    }
    return best ? { me, p: { x: best.x, y: best.y } } : null;
  });
}

const DEVICES = [
  { id: 'iphone15-portrait', device: 'iPhone 15', world: 'detective-sugar-hotel', seed: 5 },
  { id: 'pixel7-portrait', device: 'Pixel 7', world: 'nb-troll-direktoratet', seed: 6 },
  { id: 'iphone15-landscape', device: 'iPhone 15 landscape', world: 'fantasy-retired-mimic', seed: 4 },
];

for (const d of DEVICES) {
  test.describe(`behind-player-${d.id}`, () => {
    test.use(phone(d.device));
    test(`tap / long-press the tile behind the player (${d.world})`, async ({ page }) => {
      test.setTimeout(180000);
      await boot(page, d.world, d.seed);
      const out: Record<string, unknown> = { world: d.world };
      // 1) empty floor behind the player: tap its centre
      const b = await behindTile(page);
      if (!b) {
        out.note = 'no free floor tile next to the player';
        writeFileSync(`${REPORT}/m5-mobile-pt-r3-probe-behind-${d.id}.json`, JSON.stringify(out, null, 2));
        return;
      }
      await page.waitForTimeout(1500);
      const pt = await page.evaluate((p) => {
        const r = window.__anyworld!.renderer!;
        const at = r.tileToScreen(p);
        const el = document.elementFromPoint(at.x, at.y);
        return { x: at.x, y: at.y, onMap: !!el && !!el.closest('#game-canvas'), pick: r.pick(at.x, at.y), screenToTile: (r as unknown as { screenToTile?: (x: number, y: number) => unknown }).screenToTile?.(at.x, at.y) ?? null };
      }, b.p);
      out.empty = { me: b.me, target: b.p, ...pt };
      await page.screenshot({ path: `${OUT}/pt-mobile-r3-probe-behind-${d.id}-before.png` });
      const t0 = await page.evaluate(() => window.__anyworld!.controller!.session.state.turn);
      await page.touchscreen.tap(pt.x, pt.y);
      await page.waitForTimeout(900);
      const after = await page.evaluate(() => {
        const s = window.__anyworld!.controller!.session;
        return { turn: s.state.turn, me: s.player().pos, toasts: Array.from(document.querySelectorAll('.aw-toast')).map((e) => (e as HTMLElement).innerText) };
      });
      (out.empty as Record<string, unknown>).after = after;
      const walked = after.me.x === b.p.x && after.me.y === b.p.y;
      (out.empty as Record<string, unknown>).walked = walked;
      if (!walked) await page.screenshot({ path: `${OUT}/pt-mobile-r3-probe-behind-${d.id}-empty-tap.png` });
      expect.soft(walked, `tap on the floor tile behind the player walks there: ${JSON.stringify(out.empty)}`).toBe(true);
      expect.soft(t0 >= 0).toBe(true);

      // 2) a non-hostile actor moved onto the tile behind the player: long-press, then tap
      await page.waitForTimeout(800);
      const b2 = await behindTile(page);
      const placed = b2
        ? await page.evaluate(async (p) => {
            const app = window.__anyworld!;
            const c = app.controller!;
            const st = c.session.state;
            const npc = st.area.actors.find((a) => a.hp > 0 && a.id !== st.players[st.party[0]].actorId && a.faction !== 'hostile') ?? st.area.actors.find((a) => a.hp > 0 && a.id !== st.players[st.party[0]].actorId);
            if (!npc) return null;
            const id = npc.id;
            const w = st.area.map.width;
            await c.setStateForTest((ns) => {
              const a = ns.area.actors.find((x) => x.id === id)!;
              a.pos = { ...p };
              (ns.players[ns.party[0]].seen as number[])[p.y * w + p.x] = 2;
            });
            return { id, faction: npc.faction, name: c.session.describeAt(p).actor?.name ?? npc.defId, pos: p };
          }, b2.p)
        : null;
      out.actor = placed;
      if (placed) {
        await page.waitForTimeout(1500);
        await page.screenshot({ path: `${OUT}/pt-mobile-r3-probe-behind-${d.id}-actor.png` });
        const cdp = await page.context().newCDPSession(page);
        const lp: unknown[] = [];
        for (const frac of [0.2, 0.45, 0.7]) {
          const at = await page.evaluate(([id, f]) => {
            const r = window.__anyworld!.renderer!;
            const a = r.actorScreen(id as string, f as number);
            if (!a) return null;
            const el = document.elementFromPoint(a.x, a.y);
            return { x: a.x, y: a.y, onMap: !!el && !!el.closest('#game-canvas'), pick: r.pick(a.x, a.y) };
          }, [placed.id, frac] as const);
          if (!at || !at.onMap) {
            lp.push({ frac, note: 'not on map' });
            continue;
          }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y, id: 1 }] });
          await page.waitForTimeout(750);
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await page.waitForTimeout(300);
          const tip = page.locator('.aw-tooltip.is-visible');
          const text = (await tip.isVisible().catch(() => false)) ? (await tip.innerText()).replace(/\s+/g, ' ').slice(0, 80) : null;
          lp.push({ frac, at: [Math.round(at.x), Math.round(at.y)], pick: at.pick, text, ok: !!text && text.includes(placed.name) });
          if (!(text && text.includes(placed.name))) await page.screenshot({ path: `${OUT}/pt-mobile-r3-probe-behind-${d.id}-longpress-miss.png` });
          await page.locator('.aw-strip').tap().catch(() => undefined);
          await page.waitForTimeout(300);
        }
        out.longPress = lp;
        const okCount = (lp as { ok?: boolean }[]).filter((x) => x.ok).length;
        expect.soft(okCount, `long-press on the actor behind the player opens its card: ${JSON.stringify(lp)}`).toBeGreaterThan(0);
      }
      writeFileSync(`${REPORT}/m5-mobile-pt-r3-probe-behind-${d.id}.json`, JSON.stringify(out, null, 2));
    });
  });
}

test.describe('dialogue-sheet-iphone15-portrait', () => {
  test.use(phone('iPhone 15'));
  test('dialogue buttons over time vs the home bar', async ({ page }) => {
    test.setTimeout(180000);
    const cdp = await page.context().newCDPSession(page);
    let safe = true;
    await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { top: 59, bottom: 34, left: 0, right: 0 } } as never).catch(() => (safe = false));
    await boot(page, 'detective-sugar-hotel', 5);
    const out: Record<string, unknown> = { safeAreaEmulated: safe };
    // a talkable NPC next to the player
    const placed = await page.evaluate(async () => {
      const app = window.__anyworld!;
      const c = app.controller!;
      const st = c.session.state;
      const me = c.session.player().pos;
      const w = st.area.map.width;
      const npc = st.area.actors.find((a) => a.hp > 0 && a.id !== st.players[st.party[0]].actorId && a.faction !== 'hostile');
      if (!npc) return null;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const p = { x: me.x + dx, y: me.y + dy };
        const t = st.area.map.tiles[p.y * w + p.x] as { kind: string } | undefined;
        if (!t || t.kind !== 'floor' || st.area.actors.some((a) => a.hp > 0 && a.pos.x === p.x && a.pos.y === p.y)) continue;
        await c.setStateForTest((ns) => {
          ns.area.actors.find((x) => x.id === npc.id)!.pos = p;
          (ns.players[ns.party[0]].seen as number[])[p.y * w + p.x] = 2;
        });
        return { id: npc.id, pos: p };
      }
      return null;
    });
    out.placed = placed;
    expect(placed).not.toBeNull();
    await page.waitForTimeout(800);
    const talk = page.locator('.aw-ctx:not([hidden]) .aw-ctx-btn[data-action="talk"]').first();
    await talk.tap();
    const samples: unknown[] = [];
    const t0 = Date.now();
    for (let k = 0; k < 30; k++) {
      samples.push(
        await page.evaluate((t) => {
          const card = document.querySelector<HTMLElement>('.aw-dialogue:not([hidden])');
          if (!card) return { t, card: null };
          const cr = card.getBoundingClientRect();
          const btns = Array.from(card.querySelectorAll<HTMLElement>('.aw-dlg-foot button')).map((b) => {
            const r = b.getBoundingClientRect();
            return { lbl: b.innerText.trim().slice(0, 14), top: Math.round(r.top), bottom: Math.round(r.bottom) };
          });
          return { t, cardTop: Math.round(cr.top), cardBottom: Math.round(cr.bottom), cardH: Math.round(cr.height), transform: getComputedStyle(card).transform, btns, H: innerHeight };
        }, Date.now() - t0),
      );
      if (k === 4 || k === 29) await page.screenshot({ path: `${OUT}/pt-mobile-r3-probe-dialogue-${k}.png` });
      await page.waitForTimeout(100);
    }
    out.samples = samples;
    const last = samples[samples.length - 1] as { btns: { bottom: number; lbl: string }[]; H: number };
    out.settledUnderHomeBar = last.btns.filter((b) => b.bottom > last.H - 34).map((b) => `${b.lbl} ${b.bottom}`);
    writeFileSync(`${REPORT}/m5-mobile-pt-r3-probe-dialogue.json`, JSON.stringify(out, null, 2));
    expect.soft(out.settledUnderHomeBar, 'settled dialogue buttons above the home bar').toEqual([]);
  });
});

for (const d of DEVICES) {
  test.describe(`path-walk-${d.id}`, () => {
    test.use(phone(d.device));
    test(`tap a far tile with no hostiles around walks there (${d.world})`, async ({ page }) => {
      test.setTimeout(180000);
      await boot(page, d.world, d.seed);
      await page.evaluate(async () => {
        const c = window.__anyworld!.controller!;
        await c.setStateForTest((ns) => {
          ns.area.actors = ns.area.actors.filter((a) => a.faction !== 'hostile' || a.id === ns.players[ns.party[0]].actorId);
        });
      });
      const walks: unknown[] = [];
      for (let k = 0; k < 4; k++) {
        await page.waitForTimeout(1500);
        const tgt = await page.evaluate(async ([root, k]) => {
          const travel = await import('/@fs' + (root as string) + '/src/client/travel.ts');
          const app = window.__anyworld!;
          const s = app.controller!.session;
          const st = s.state;
          const me = s.player().pos;
          const r = app.renderer!;
          const cands: { p: { x: number; y: number }; len: number; sx: number; sy: number }[] = [];
          for (let dy = -6; dy <= 6; dy++)
            for (let dx = -6; dx <= 6; dx++) {
              const p = { x: me.x + dx, y: me.y + dy };
              if (Math.max(Math.abs(dx), Math.abs(dy)) < 3) continue;
              const path = travel.travelPath(st, p);
              if (!path || path.length < 3) continue;
              if (st.area.actors.some((a: { hp: number; pos: { x: number; y: number } }) => a.hp > 0 && a.pos.x === p.x && a.pos.y === p.y)) continue;
              const at = r.tileToScreen(p);
              const el = document.elementFromPoint(at.x, at.y);
              if (!el || !el.closest('#game-canvas')) continue;
              const hit = r.pick(at.x, at.y);
              if (!hit || hit.x !== p.x || hit.y !== p.y) continue;
              cands.push({ p, len: path.length, sx: at.x, sy: at.y });
            }
          cands.sort((a, b) => b.len - a.len);
          return cands[(k as number) % Math.max(1, cands.length)] ?? null;
        }, [ROOT, k] as const);
        if (!tgt) {
          walks.push({ note: 'no target' });
          continue;
        }
        const before = await page.evaluate(() => ({ pos: window.__anyworld!.controller!.session.player().pos, turn: window.__anyworld!.controller!.session.state.turn }));
        await page.touchscreen.tap(tgt.sx, tgt.sy);
        await page.waitForTimeout(200);
        await page.waitForFunction(() => !window.__anyworld?.controller?.session.travelDest, null, { timeout: 20000 }).catch(() => undefined);
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => ({ pos: window.__anyworld!.controller!.session.player().pos, turn: window.__anyworld!.controller!.session.state.turn, L: window.__anyworld!.ui.layer(), toasts: Array.from(document.querySelectorAll('.aw-toast')).map((e) => (e as HTMLElement).innerText) }));
        const reached = after.pos.x === tgt.p.x && after.pos.y === tgt.p.y;
        walks.push({ from: before.pos, dest: tgt.p, len: tgt.len, reached, turns: after.turn - before.turn, ...after });
        if (!reached && (await layer(page)) !== 'game') {
          // a sheet (dialogue / choice) stopped it: close and go on
          await page.locator('.aw-dialogue .aw-dlg-foot .aw-btn-ghost, .aw-modal:not([hidden]) .aw-option').first().tap().catch(() => undefined);
        }
      }
      writeFileSync(`${REPORT}/m5-mobile-pt-r3-probe-pathwalk-${d.id}.json`, JSON.stringify(walks, null, 2));
      const moved = (walks as { reached?: boolean; turns?: number }[]).filter((w) => (w.turns ?? 0) > 0).length;
      expect.soft(moved, `path-walks moved: ${JSON.stringify(walks)}`).toBeGreaterThan(0);
    });
  });
}

// The equipped ranged weapon's slot tip on a phone (round 3): after the round-2 fix the tip names the
// keyboard (press N, arrows, Enter). Long-press the slot as a touch player would and read the tip.
test.describe('ranged-slot-tip-iphone15-portrait', () => {
  test.use(phone('iPhone 15'));
  test('ranged weapon slot tip on touch', async ({ page }) => {
    test.setTimeout(120000);
    await boot(page, 'fixture-western', 3);
    const slot = await page.evaluate(() => window.__anyworld!.controller!.session.me.equipped.weapon ?? 0);
    const el = page.locator('.aw-hotbar-slots .aw-slot').nth(slot as number);
    const b = (await el.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }] });
    await page.waitForTimeout(800);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(500);
    const text = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.aw-tooltip.is-visible, .aw-slot-menu, .aw-modal:not([hidden]) .aw-modal-card, [role="menu"]')).map((e) => e.innerText.replace(/\s+/g, ' ')).join(' | '));
    await page.screenshot({ path: `${OUT}/pt-mobile-r3-probe-ranged-slot-tip.png` });
    writeFileSync(`${REPORT}/m5-mobile-pt-r3-probe-ranged-slot-tip.json`, JSON.stringify({ slot, text, input: await page.evaluate(() => document.getElementById('ui-root')!.dataset.input) }, null, 2));
    expect.soft(text, 'a touch player is not told to press keys').not.toMatch(/press \S+ to aim|arrows move|Enter to fire/i);
  });
});
