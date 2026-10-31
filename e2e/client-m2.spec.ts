/**
 * M2 client features in the real browser: start options, GM narration (offline director), hover
 * route preview, terrain interaction (ship bridge console), click-attack tooltip refresh, GM rules
 * in the rules panel, danger feedback, docked dialogue, log folding and the end screen.
 * Screenshots go to docs/archive/progress/M2/client-*.png.
 * Run: xvfb-run -a npx playwright test e2e/client-m2.spec.ts
 */
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';


// committed milestone screenshots are history: reruns write to test-results unless SHOTS_TO_DOCS=1
const OUT = process.env.SHOTS_TO_DOCS ? 'docs/archive/progress/M2' : 'test-results/shots/M2';
mkdirSync(OUT, { recursive: true });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(400);
}

async function layer(page: Page): Promise<string> {
  return page.evaluate(() => window.__anyworld!.ui.layer());
}

async function skipNarration(page: Page) {
  for (let i = 0; i < 4 && (await layer(page)) === 'narration'; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}

async function playerScreen(page: Page) {
  return page.evaluate(() => {
    const app = window.__anyworld!;
    const s = app.controller!.session;
    return app.renderer!.tileToScreen(s.player().pos);
  });
}

test.describe.configure({ mode: 'serial' });

test('start options, GM intro, objective, hints and hover route preview', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('anyworld.byo', '1'); // "Bring your own AI" open: these specs use the new-world form
  });
  await page.goto('/');
  await waitReady(page);
  // difficulty is a 4-step slider: gentle / normal / hard / brutal
  const diff = page.locator('#aw-diff');
  await diff.fill('2');
  await expect(page.locator('.aw-range-out').first()).toHaveText('Hard');
  await expect(page.locator('#aw-diff-hint')).not.toBeEmpty();
  await page.locator('#aw-weird').fill('0.8');
  await page.screenshot({ path: `${OUT}/client-00-start-options.png` });

  await page.locator('.aw-demo', { hasText: 'Moss' }).first().click().catch(async () => {
    await page.locator('.aw-demo').first().click();
  });
  await page.waitForFunction(() => window.__anyworld?.controller != null, null, { timeout: 60000 });
  await waitReady(page);
  const opts = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    return { difficulty: s.difficulty, weirdness: s.weirdness, world: s.worldId };
  });
  expect(opts.difficulty).toBe('hard');
  expect(opts.weirdness).toBeCloseTo(0.8);

  // the GM narrated the intro (card + log): in demo mode the recorded intro (M3), offline gm.fallback.intro otherwise
  await page.waitForFunction(() => window.__anyworld!.controller!.gm.pending === 0);
  const intro = await page.evaluate(() => {
    const s = window.__anyworld!.controller!.session;
    return { logged: s.state.log.some((l) => l.kind === 'gm' && l.text.trim().length > 20) };
  });
  expect(intro.logged).toBe(true);
  await expect(page.locator('.aw-narration')).toBeVisible();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/client-01-intro.png` });
  // no scrollbar on the prologue card
  const scroll = await page.locator('.aw-narration').evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(scroll).toBeLessThanOrEqual(2);
  await skipNarration(page);

  // M3: the goal tracker replaces the objective line, the onboarding card the first-run hints
  await expect(page.locator('.aw-goal')).toBeVisible();
  await expect(page.locator('.aw-onboard')).toBeVisible();
  await page.screenshot({ path: `${OUT}/client-02-objective-hints.png` });
  await page.locator('.aw-onboard-ok').click();

  // hover a visible floor tile a few steps away: outline + route dots
  const target = await page.evaluate(() => {
    const app = window.__anyworld!;
    app.renderer!.rig.settle();
    app.renderer!.renderNow();
    const s = app.controller!.session;
    const st = s.state;
    const p = s.player().pos;
    let best: { x: number; y: number } | null = null;
    for (let y = 0; y < st.area.map.height; y++)
      for (let x = 0; x < st.area.map.width; x++) {
        const d = Math.max(Math.abs(x - p.x), Math.abs(y - p.y));
        if (d < 3 || d > 5) continue;
        const pv = s.preview({ x, y });
        if (pv?.kind !== 'walk' || pv.path.length < 3) continue;
        // only tiles the mouse can reach (not under a panel)
        const sc = app.renderer!.tileToScreen({ x, y });
        if (document.elementFromPoint(sc.x, sc.y)?.tagName === 'CANVAS') best = { x, y };
      }
    return best ? { tile: best, screen: app.renderer!.tileToScreen(best) } : null;
  });
  expect(target).not.toBeNull();
  await page.mouse.move(target!.screen.x, target!.screen.y);
  await page.waitForTimeout(300);
  await expect(page.locator('.aw-map-overlay .ov-hover')).toHaveAttribute('visibility', 'visible');
  const dots = await page.locator('.aw-map-overlay .ov-dots circle:not([hidden])').count();
  expect(dots).toBeGreaterThan(0);
  await page.screenshot({ path: `${OUT}/client-03-hover-route.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('ship: the bridge console can be used (Enter) and clicked hostiles refresh their tooltip', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('anyworld.byo', '1'); // "Bring your own AI" open: these specs use the new-world form
  });
  await page.goto('/?world=fixture-ship&seed=5');
  await waitReady(page);
  await skipNarration(page);

  // ride the lifts to the bridge (area 3): stand on the exit, take it
  for (let i = 0; i < 2; i++) {
    await page.evaluate(async () => {
      const c = window.__anyworld!.controller!;
      // the bridge lift wants a keycard
      const req = c.session.world.areas[c.session.state.area.index].transitionRequires as { item?: string } | undefined;
      if (req?.item) c.gmNow([{ type: 'give_item', item: req.item, count: 1 }]);
      const ex = c.session.state.area.map.exit;
      await c.setStateForTest((st) => {
        st.area.actors = st.area.actors.filter((a) => a.id === st.players[st.party[0]].actorId || a.faction !== 'hostile');
        st.area.actors.find((a) => a.id === st.players[st.party[0]].actorId)!.pos = { ...ex };
      });
      c.actNow({ type: 'transition' });
    });
    await page.waitForTimeout(800);
    await skipNarration(page);
  }
  const area = await page.evaluate(() => window.__anyworld!.controller!.session.state.area.index);
  expect(area).toBe(2);
  // the GM narrated the arrival: the recorded area_enter narration in demo mode (M3), else gm.fallback.areaEnter
  const recorded = (JSON.parse(readFileSync('content/recordings/fixture-ship/gm-area_enter-a2.json', 'utf8')).recordings as { json: { actions: { type: string; text?: string }[] } }[])
    .flatMap((r) => r.json.actions)
    .filter((a) => a.type === 'narrate')
    .map((a) => a.text!);
  const arrival = await page.evaluate((texts) => {
    const s = window.__anyworld!.controller!.session;
    const ok = new Set([...texts, s.world.gm.fallback.areaEnter[2]]);
    return s.state.log.some((l) => l.kind === 'gm' && ok.has(l.text));
  }, recorded);
  expect(arrival).toBe(true);

  // stand next to a bridge console
  const spot = await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    const st = c.session.state;
    const m = st.area.map;
    for (let y = 1; y < m.height - 1; y++)
      for (let x = 1; x < m.width - 1; x++) {
        const t = m.tiles[y * m.width + x];
        if (t.terrain !== 'bridge-console' || t.interacted) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = m.tiles[(y + dy) * m.width + x + dx];
          if (n && (n.kind === 'floor' || n.kind === 'start') && !n.terrain && !st.area.actors.some((a) => a.pos.x === x + dx && a.pos.y === y + dy)) {
            await c.setStateForTest((s2) => {
              s2.area.actors = s2.area.actors.filter((a) => a.id === s2.players[s2.party[0]].actorId || a.faction !== 'hostile');
              s2.area.actors.find((a) => a.id === s2.players[s2.party[0]].actorId)!.pos = { x: x + dx, y: y + dy };
            });
            c.actNow({ type: 'wait' });
            return { console: { x, y } };
          }
        }
      }
    return null;
  });
  expect(spot).not.toBeNull();
  await page.waitForTimeout(500);
  await skipNarration(page);
  // M3: the usable console is a context bar button ("Use …"); Enter still does the same
  await expect(page.locator('.aw-ctx .ctx-interact')).toBeVisible();
  await page.screenshot({ path: `${OUT}/client-10-console-hint.png` });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const used = await page.evaluate(({ x, y }) => {
    const st = window.__anyworld!.controller!.session.state;
    return { flag: !!st.flags['saw-orbit-trace'], interacted: !!st.area.map.tiles[y * st.area.map.width + x].interacted };
  }, spot!.console);
  expect(used).toEqual({ flag: true, interacted: true });
  await page.screenshot({ path: `${OUT}/client-11-console-used.png` });

  // a hostile next to the player: hover it, click it, the card shows its HP after the hit
  const spawnLog = await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    const drone = c.session.world.actors.find((a) => !a.npc && !a.unique && a.faction === 'hostile')!;
    c.gmNow([{ type: 'spawn', actor: drone.id, count: 1, near: 'player' }]);
    // make sure it stands right next to the player (GM spawns pick any free tile nearby)
    const s = c.session;
    const p = s.player().pos;
    const m = s.state.area.map;
    const free = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
      .map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy }))
      .find((q) => {
        const t = m.tiles[q.y * m.width + q.x];
        return t && (t.kind === 'floor' || t.kind === 'start') && !t.terrain && !s.state.area.actors.some((a) => a.hp > 0 && a.pos.x === q.x && a.pos.y === q.y);
      });
    const spawned = s.state.area.actors.filter((a) => a.defId === drone.id && a.hp > 0).pop();
    if (spawned && free && Math.max(Math.abs(spawned.pos.x - p.x), Math.abs(spawned.pos.y - p.y)) > 1) {
      await c.setStateForTest((st) => {
        st.area.actors.find((a) => a.id === spawned.id)!.pos = free;
      });
    }
    return s.state.log.slice(-3).map((l) => l.text);
  });
  console.log('spawn:', spawnLog.join(' | '));
  await page.waitForTimeout(600);
  const foe = await page.evaluate(() => {
    const app = window.__anyworld!;
    // finish the camera's follow/reframe so screen positions are final
    app.renderer!.rig.settle();
    app.renderer!.renderNow();
    const s = app.controller!.session;
    const p = s.player().pos;
    const a = s.state.area.actors.find((x) => x.faction === 'hostile' && x.hp > 0 && Math.max(Math.abs(x.pos.x - p.x), Math.abs(x.pos.y - p.y)) === 1);
    return a ? { id: a.id, screen: app.renderer!.tileToScreen(a.pos) } : null;
  });
  expect(foe).not.toBeNull();
  await page.mouse.move(foe!.screen.x, foe!.screen.y);
  await page.waitForTimeout(250);
  await expect(page.locator('.aw-tooltip.is-visible .aw-actor-card')).toBeVisible();
  // tooltip never covers the player
  const pl = await playerScreen(page);
  const box = await page.locator('.aw-tooltip').boundingBox();
  expect(pl.x >= box!.x && pl.x <= box!.x + box!.width && pl.y >= box!.y && pl.y <= box!.y + box!.height).toBe(false);
  await page.screenshot({ path: `${OUT}/client-12-hover-hostile.png` });
  for (let i = 0; i < 3; i++) {
    const alive = await page.evaluate((id) => (window.__anyworld!.controller!.session.state.area.actors.find((a) => a.id === id)?.hp ?? 0) > 0, foe!.id);
    if (!alive) break;
    await page.mouse.click(foe!.screen.x, foe!.screen.y);
    await page.waitForTimeout(500);
  }
  const after = await page.evaluate((id) => {
    const a = window.__anyworld!.controller!.session.state.area.actors.find((x) => x.id === id);
    const tip = document.querySelector('.aw-tooltip.is-visible .aw-bar-value')?.textContent ?? null;
    return { hp: a && a.hp > 0 ? a.hp : 0, max: a?.maxHp ?? 0, tip, pos: a?.pos };
  }, foe!.id);
  if (after.hp > 0) {
    // the card under the mouse shows the HP after the hit (it went stale before)
    const stillThere = await page.evaluate((p) => {
      const h = window.__anyworld!.controller!.hovered;
      return !!p && !!h && h.x === p.x && h.y === p.y;
    }, after.pos);
    if (stillThere) expect(after.tip).toBe(`${after.hp} / ${after.max}`);
  }
  await page.screenshot({ path: `${OUT}/client-13-after-click-attack.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('GM rules, danger feedback and log folding on the ship', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('anyworld.byo', '1'); // "Bring your own AI" open: these specs use the new-world form
  });
  await page.goto('/?world=fixture-ship&seed=8');
  await waitReady(page);
  await skipNarration(page);

  // the engine reports a GM-added rule: toast + log line + highlighted badge
  await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    const w = c.session.world;
    await c.setStateForTest((st) => {
      // engine-shaped ActiveRuleEntry objects ({rule, source, since}), not bare RuleVariants
      (st as unknown as { activeRules: unknown[] }).activeRules = [
        ...w.rules.map((rule) => ({ rule, source: 'world', since: { area: 0, turn: 0 } })),
        { rule: { id: 'stale-air', name: 'Stale air', description: 'Every breath costs a little more O2.', playerTriggers: [], switches: {} }, source: 'gm', since: { area: st.area.index, turn: st.turn }, reason: 'MATRON has quietly turned the scrubbers down.' },
      ];
    });
    c.actNow({ type: 'wait' });
  });
  await page.waitForTimeout(400);
  await expect(page.locator('.aw-rules-badge.has-new')).toBeVisible();
  await expect(page.locator('.aw-toast', { hasText: 'New rule: Stale air' })).toBeVisible();
  await page.screenshot({ path: `${OUT}/client-20-new-rule.png` });
  // hovering a rule pill explains it
  await page.locator('.aw-rule-pill', { hasText: 'Stale air' }).hover();
  await page.waitForTimeout(250);
  await expect(page.locator('.aw-tooltip.is-visible')).toContainText('Every breath');
  await page.screenshot({ path: `${OUT}/client-21-rule-tooltip.png` });
  await page.keyboard.press('r');
  await page.waitForTimeout(300);
  await expect(page.locator('.aw-rules li.is-gm')).toContainText('MATRON has quietly');
  await expect(page.locator('.aw-rules li.is-gm .aw-rule-src')).toHaveText('GM');
  await page.screenshot({ path: `${OUT}/client-22-rules-panel.png` });
  await page.keyboard.press('Escape');

  // O2 runs out: warning row, vignette, the canister slot glows
  await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    await c.setStateForTest((st) => {
      st.players[st.party[0]].resources.oxygen = 0;
      st.players[st.party[0]].knowledge['o2-canister'].level = 'clear';
      st.area.actors = st.area.actors.filter((a) => a.id === st.players[st.party[0]].actorId);
    });
  });
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('.');
    await page.waitForTimeout(120);
  }
  await expect(page.locator('.aw-danger-row')).toBeVisible();
  await expect(page.locator('.aw-vignette')).toBeVisible();
  await expect(page.locator('.aw-slot.is-urgent')).toHaveCount(1);
  // the hypoxia ticks fold into a counter instead of one line per turn
  const rows = await page.locator('.aw-log-row').allTextContents();
  const ticks = rows.filter((r) => /Vacuum|Integrity|takes 1/.test(r));
  expect(ticks.length).toBeLessThanOrEqual(2);
  await page.screenshot({ path: `${OUT}/client-23-danger.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('western: the dialogue docks beside the speaker; the end screen shows the run options', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('anyworld.byo', '1'); // "Bring your own AI" open: these specs use the new-world form
  });
  await page.goto('/?world=fixture-western&seed=7');
  await waitReady(page);
  await skipNarration(page);
  const ok = await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    const s = c.session;
    const npc = s.state.area.actors.find((a) => s.world.actors.find((d) => d.id === a.defId)?.npc);
    if (!npc) return false;
    const m = s.state.area.map;
    for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) {
      const x = npc.pos.x + dx;
      const y = npc.pos.y + dy;
      const t = m.tiles[y * m.width + x];
      if (!t || (t.kind !== 'floor' && t.kind !== 'start') || t.terrain) continue;
      if (s.state.area.actors.some((a) => a.pos.x === x && a.pos.y === y)) continue;
      await c.setStateForTest((st) => {
        st.area.actors = st.area.actors.filter((a) => a.id === st.players[st.party[0]].actorId || a.faction !== 'hostile');
        st.area.actors.find((a) => a.id === st.players[st.party[0]].actorId)!.pos = { x, y };
      });
      c.actNow({ type: 'talk', targetId: npc.id });
      return true;
    }
    return false;
  });
  expect(ok).toBe(true);
  await page.waitForTimeout(700);
  await expect(page.locator('.aw-dialogue')).toBeVisible();
  // the speaker is not under the panel
  const sp = await page.evaluate(() => {
    const app = window.__anyworld!;
    const pc = app.controller!.session.me.pendingChoice!;
    const a = app.controller!.session.state.area.actors.find((x) => x.id === pc.speakerId)!;
    return app.renderer!.tileToScreen(a.pos);
  });
  const box = await page.locator('.aw-dialogue').boundingBox();
  const covered = sp.x >= box!.x && sp.x <= box!.x + box!.width && sp.y >= box!.y && sp.y <= box!.y + box!.height;
  expect(covered).toBe(false);
  await expect(page.locator('.aw-map-overlay .ov-speaker')).toHaveAttribute('visibility', 'visible');
  await page.screenshot({ path: `${OUT}/client-30-dialogue-docked.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // lose the run: the end screen names difficulty and weirdness
  await page.evaluate(async () => {
    const c = window.__anyworld!.controller!;
    await c.setStateForTest((st) => {
      st.area.actors.find((a) => a.id === st.players[st.party[0]].actorId)!.hp = 1;
    });
    c.gmNow([{ type: 'effect', target: 'player', effects: [{ type: 'damage', amount: { base: 50 }, damageType: c.session.world.damageTypes[0].id }] }]);
  });
  await page.waitForTimeout(800);
  await expect(page.locator('.aw-end')).toBeVisible();
  await expect(page.locator('.aw-end-settings')).toContainText('Difficulty');
  await page.screenshot({ path: `${OUT}/client-31-end-screen.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});
