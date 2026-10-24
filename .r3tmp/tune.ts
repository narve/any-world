import { readFileSync } from 'node:fs';
import { parseWorld } from '../src/schema/refs';
import { tuneWorld, analyseWorld, scaleAmount } from '../src/engine/balance/index';
const [file, mode, diff] = process.argv.slice(2);
const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${file}`, 'utf8')));
if (!r.ok) throw new Error('bad');
const w: any = structuredClone(r.world);
const f = mode === 'hard' ? 2.5 : mode === 'easy' ? 0.35 : 1;
if (f !== 1) for (const a of w.actors) { if (a.faction !== 'hostile') continue; a.stats.hp = Math.max(1, Math.round(a.stats.hp * f)); if (a.attack) a.attack.damage = scaleAmount(a.attack.damage, f); }
if (mode === 'nogoal') { const before = JSON.stringify(w).length; console.log('goal', JSON.stringify(w.goal.win)); }
const t0 = Date.now();
const res = tuneWorld(w, { difficulty: (diff as any) ?? 'normal' });
console.log(file, mode, diff, JSON.stringify(res.history, null, 0), 'final', res.report.verdict, res.report.winRate, (Date.now()-t0)/1000+'s');
const hold = analyseWorld(res.world, { seeds: Array.from({length:100},(_,i)=>1001+i), bots:['explorer'], difficulty: (diff as any) ?? 'normal' });
console.log('holdout', file, mode, hold.verdict, hold.winRate);
