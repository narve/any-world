/**
 * Round-3 desktop playtest driver: one long-lived headed chromium (1280x800) controlled through a
 * tiny local HTTP server, so a human-like tester can play one decision at a time (curl POST JSON).
 * Ops: goto {url}, key {keys[]}, click {sel|x,y}, hover {x,y}, shot {name}, eval {js}, look {}.
 * Run: xvfb-run -a node tests/review/m5/pt-desktop-r3-driver.mjs   (PT_PORT=5333 PT_BASE=http://127.0.0.1:5331)
 * The game is driven only through the keyboard/mouse; the automation handle is only READ (look).
 */
import { chromium } from 'playwright';
import http from 'node:http';

const BASE = process.env.PT_BASE ?? 'http://127.0.0.1:5331';
const OUT = 'docs/archive/progress/M5';
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
});

async function look() {
  return page.evaluate(() => {
    const app = window.__anyworld;
    const out = { layer: app?.ui.layer() ?? 'none', screen: document.getElementById('ui-root')?.dataset.screen };
    const s = app?.controller?.session;
    if (!s) return out;
    const st = s.state;
    const W = st.area.map.width;
    const pl = st.area.actors.find((a) => a.id === st.player.actorId);
    out.turn = st.turn; out.status = st.status; out.area = st.area.index; out.endReason = st.endReason;
    out.player = pl ? { pos: pl.pos, hp: pl.hp, maxHp: pl.maxHp, mp: pl.mp, lvl: st.player.level, xp: st.player.xp, cur: st.player.currency } : null;
    out.slots = st.player.slots.map((it, i) => (it ? `${i + 1}:${it.defId}${it.charges !== undefined ? '(' + it.charges + ')' : ''}${it.qty > 1 ? 'x' + it.qty : ''}` : null)).filter(Boolean);
    out.equipped = st.player.equipped;
    const R = 9;
    const rows = [];
    for (let y = pl.pos.y - R; y <= pl.pos.y + R; y++) {
      let row = '';
      for (let x = pl.pos.x - R * 2; x <= pl.pos.x + R * 2; x++) {
        if (x < 0 || y < 0 || x >= W || y >= st.area.map.height) { row += ' '; continue; }
        const i = y * W + x;
        const seen = st.area.seen[i];
        if (!seen) { row += ' '; continue; }
        const a = seen === 2 ? st.area.actors.find((q) => q.pos.x === x && q.pos.y === y) : null;
        if (a) { row += a.id === pl.id ? '@' : a.faction === 'hostile' ? 'H' : a.faction === 'friendly' ? 'F' : 'N'; continue; }
        if (st.area.items.some((it) => it.pos.x === x && it.pos.y === y)) { row += '*'; continue; }
        if (st.area.map.exit.x === x && st.area.map.exit.y === y) { row += '>'; continue; }
        const k = st.area.map.tiles[i].kind;
        row += k === 'wall' ? '#' : k === 'floor' ? (seen === 2 ? '.' : ',') : k === 'door' ? '+' : k === 'water' ? '~' : k === 'void' ? ' ' : k[0];
      }
      rows.push(row);
    }
    out.map = rows;
    out.actors = st.area.actors.filter((a) => a.id !== pl.id && st.area.seen[a.pos.y * W + a.pos.x] === 2).map((a) => `${a.defId}[${a.faction}] ${a.hp}/${a.maxHp} @${a.pos.x - pl.pos.x},${a.pos.y - pl.pos.y}`);
    out.exitRel = { dx: st.area.map.exit.x - pl.pos.x, dy: st.area.map.exit.y - pl.pos.y };
    out.log = st.log.slice(-8).map((l) => l.text);
    const txt = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null).map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
    out.goal = txt('.aw-goal');
    out.ctx = txt('.aw-ctx .aw-ctx-btn');
    out.cards = txt('.aw-narration:not([hidden]), .aw-onboard:not([hidden]), .aw-modal, .aw-sheet, .aw-end, .aw-dialogue');
    out.pending = st.pendingChoice ? { kind: st.pendingChoice.kind ?? '?', text: JSON.stringify(st.pendingChoice).slice(0, 300) } : null;
    out.perk = st.player.pendingPerkChoice;
    return out;
  });
}

async function handle(cmd) {
  switch (cmd.op) {
    case 'goto': await page.goto(BASE + (cmd.url ?? '/')); await page.waitForTimeout(cmd.wait ?? 1500); return { ok: true };
    case 'key': for (const k of cmd.keys) { await page.keyboard.press(k); await page.waitForTimeout(cmd.delay ?? 120); } await page.waitForTimeout(250); return look();
    case 'click':
      if (cmd.sel) await page.locator(cmd.sel).first().click({ timeout: 5000 });
      else await page.mouse.click(cmd.x, cmd.y, { button: cmd.button ?? 'left' });
      await page.waitForTimeout(cmd.wait ?? 400); return look();
    case 'hover': await page.mouse.move(cmd.x, cmd.y); await page.waitForTimeout(500); return { ok: true };
    case 'shot': await page.screenshot({ path: `${OUT}/pt-desktop-r3-${cmd.name}.png` }); return { ok: true, path: `${OUT}/pt-desktop-r3-${cmd.name}.png` };
    case 'eval': return { v: await page.evaluate(cmd.js) };
    case 'look': return look();
    case 'errors': return { errors: errors.splice(0) };
    case 'quit': setTimeout(() => process.exit(0), 100); return { ok: true };
    default: return { error: 'unknown op' };
  }
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    try {
      const out = await handle(JSON.parse(body || '{}'));
      res.end(JSON.stringify(out, null, 1));
    } catch (e) {
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
}).listen(Number(process.env.PT_PORT ?? 5333), '127.0.0.1');
console.log('driver ready');
