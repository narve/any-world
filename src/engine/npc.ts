/**
 * NPC verbs (offline versions; the GM runtime can layer LLM dialogue on top through applyGmActions):
 * talk opens a dialogue choice built from the NPC's role, persuade is a stat check, and
 * choose_option resolves any pending choice.
 */
import type { GmAction } from '../schema/gm';
import type { ActorInstance, PendingChoice } from './types';
import { type Ctx, actorDef, actorName, emit, findActor, isAlive, isPlayer, log, logKey, playerActor } from './ctx';
import { type ActionOutcome, displayItemName, done, equippedKindOf, free, invalid, removeFromSlot } from './inventory';
import { TOTAL_SLOTS } from './types';
import { progressRefs } from './goals';
import { applyGmList, optionPrice } from './gm';
import { GM_ACTION_COST } from '../schema/gm';
import { getStat, maxHp, side, statMod } from './stats';
import { isVisibleToPlayer } from './effects';
import { cheb, clamp } from './util';

/** most sell offers a trader makes at once */
export const MAX_SELL_OPTIONS = 8;

/** what a trader pays for one unit of an item: half its value, rounded down (0 = not bought) */
export function sellPrice(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value / 2) : 0;
}

/**
 * The trader's sell offers: one per kind of item the player carries, one unit each, at
 * sellPrice. Never bought: equipped items, keys, items worth nothing, and items the run's
 * progress needs (named by a has_item in the goal, a lock of a way onward or an active quest).
 */
export function sellOptions(ctx: Ctx): PendingChoice['options'] {
  const protectedItems = progressRefs(ctx).items;
  const cur = ctx.world.vocabulary.currency;
  const out: PendingChoice['options'] = [];
  const seen = new Set<string>();
  for (let slot = 0; slot < TOTAL_SLOTS && out.length < MAX_SELL_OPTIONS; slot++) {
    const it = ctx.s.player.slots[slot];
    if (!it || seen.has(it.defId) || equippedKindOf(ctx, slot)) continue;
    const def = ctx.ix.items.get(it.defId);
    if (!def || def.category === 'key' || protectedItems.has(def.id)) continue;
    const price = sellPrice(def.value);
    if (price <= 0) continue;
    seen.add(def.id);
    out.push({
      label: `${displayItemName(ctx, def.id)} (+${price} ${cur})`,
      actions: [{ type: 'currency', amount: price }],
      tag: 'sell',
      sell: { slot, defId: def.id },
    });
  }
  return out;
}

/** the slot to sell from: the offered one if it still holds the item, else any unequipped one */
function sellSlot(ctx: Ctx, sell: { slot: number; defId: string }): number {
  const ok = (i: number) => ctx.s.player.slots[i]?.defId === sell.defId && !equippedKindOf(ctx, i);
  if (Number.isInteger(sell.slot) && sell.slot >= 0 && sell.slot < TOTAL_SLOTS && ok(sell.slot)) return sell.slot;
  for (let i = 0; i < TOTAL_SLOTS; i++) if (ok(i)) return i;
  return -1;
}

export const TALK_RANGE = 2;

function npcTarget(ctx: Ctx, targetId: string): ActorInstance | string {
  const a = findActor(ctx, targetId);
  if (!a || !isAlive(ctx, a) || isPlayer(ctx, a)) return 'no one there';
  const d = cheb(a.pos, playerActor(ctx).pos);
  if (d > TALK_RANGE) return 'too far away';
  if (d > 1 && !isVisibleToPlayer(ctx, a)) return 'you cannot see them';
  return a;
}

export function canTalkTo(ctx: Ctx, a: ActorInstance): boolean {
  return !!ctx.world.verbs.talk && !!actorDef(ctx, a)?.npc;
}

export function doTalk(ctx: Ctx, targetId: string): ActionOutcome {
  if (!ctx.world.verbs.talk) return invalid('talking is not possible here');
  const a = npcTarget(ctx, targetId);
  if (typeof a === 'string') return invalid(a);
  const def = actorDef(ctx, a);
  if (!def?.npc) return invalid(`${actorName(ctx, a)} has nothing to say`);
  if (ctx.s.pendingChoice) return invalid('finish the current conversation first');
  const npc = def.npc;
  const first = !a.talkedTo;
  a.talkedTo = true;
  emit(ctx, { type: 'npc_talk', actorId: a.id });
  const line = first || !npc.lines.length ? npc.greeting : ctx.rng.pick(npc.lines);
  log(ctx, line, 'npc', def.name);
  let sells: PendingChoice['options'] = [];
  const used = new Set(a.npcUsed ?? []);
  const options: PendingChoice['options'] = [];
  const friendly = side(ctx, a) !== 'H';
  const cur = ctx.world.vocabulary.currency;
  if (friendly) {
    switch (npc.role) {
      case 'trader':
        // the whole stock (the schema caps it at 8): any menu paging is the view's job, cutting
        // the list here left most authored goods unbuyable
        for (const id of npc.stock) {
          const it = ctx.ix.items.get(id);
          if (!it) continue;
          const actions: GmAction[] = [];
          if (it.value > 0) actions.push({ type: 'currency', amount: -it.value });
          actions.push({ type: 'give_item', item: id, count: 1 });
          options.push({ label: `${displayItemName(ctx, id)} (${it.value} ${cur})`, actions, tag: 'buy' });
        }
        // and buys what the player carries; listed after "ask what they know" (dialogue views
        // show the first few untagged-or-unknown options as replies)
        sells = sellOptions(ctx);
        break;
      case 'healer':
        if (!used.has('heal')) {
          const amount = Math.max(5, Math.ceil(maxHp(ctx, playerActor(ctx)) * 0.5));
          options.push({
            label: 'Ask for help',
            actions: [{ type: 'effect', target: 'player', effects: [{ type: 'heal', amount: { base: amount } }, { type: 'remove_status', status: 'all_harmful' }] }],
            tag: 'service:heal',
          });
        }
        break;
      case 'quest_giver': {
        const gift = npc.stock.find((id) => ctx.ix.items.has(id));
        if (!used.has('gift') && gift) {
          options.push({ label: 'Offer to help', actions: [{ type: 'give_item', item: gift, count: 1 }, { type: 'grant_xp', amount: 10 }], tag: 'service:gift' });
        }
        break;
      }
      case 'ally':
        if (!a.allyOf && !used.has('recruit')) options.push({ label: 'Ask them to come along', actions: [], tag: 'service:recruit' });
        break;
      default:
        break;
    }
    if (npc.lines.length) {
      options.push({ label: 'Ask what they know', actions: [{ type: 'say', actorId: a.id, text: ctx.rng.pick(npc.lines) }] });
    }
    options.push(...sells);
  }
  options.push({ label: 'Goodbye', actions: [] });
  ctx.s.pendingChoice = { kind: 'dialogue', prompt: line, speakerId: a.id, options };
  return free();
}

export function doPersuade(ctx: Ctx, targetId: string): ActionOutcome {
  if (!ctx.world.verbs.persuade) return invalid('persuasion is not possible here');
  const a = npcTarget(ctx, targetId);
  if (typeof a === 'string') return invalid(a);
  if (a.allyOf) return invalid('already on your side');
  const def = actorDef(ctx, a);
  if (!def) return invalid('no one there');
  const stat = def.npc?.persuadeStat ?? 'int';
  let dc = def.npc?.persuadeDifficulty ?? def.persuadeDifficulty ?? clamp(10 + Math.floor(def.stats.hp / 6) + (def.unique ? 5 : 0), 8, 25);
  if (a.faction === 'hostile') dc += 2;
  const pl = playerActor(ctx);
  const roll = ctx.rng.int(1, 20);
  const total = roll + statMod(getStat(ctx, pl, stat)) + Math.floor(ctx.s.player.level / 2);
  const name = actorName(ctx, a);
  if (roll !== 1 && (roll === 20 || total >= dc)) {
    if (a.faction === 'hostile') {
      a.faction = 'neutral';
      a.ai.alerted = false;
      delete a.ai.lastSeen;
      logKey(ctx, 'log.persuade.backs_down', { actor: name }, 'good');
    } else if (a.faction === 'neutral') {
      a.faction = 'friendly';
      logKey(ctx, 'log.persuade.warms', { actor: name }, 'good');
    } else if (def.npc?.role === 'ally' || def.behaviour.type === 'follower') {
      a.allyOf = pl.id;
      a.faction = 'friendly';
      logKey(ctx, 'log.ally.joins', { actor: name }, 'good');
    } else {
      const line = def.npc?.lines.length ? ctx.rng.pick(def.npc.lines) : def.npc?.greeting;
      if (line) log(ctx, line, 'npc', def.name);
      else logKey(ctx, 'log.persuade.nods', { actor: name }, 'info');
    }
  } else {
    logKey(ctx, 'log.persuade.fail', { actor: name }, 'warning');
    if (a.faction === 'hostile') {
      a.ai.alerted = true;
      a.ai.lastSeen = { ...pl.pos };
    }
  }
  return done();
}

export function doChooseOption(ctx: Ctx, index: number): ActionOutcome {
  const pc = ctx.s.pendingChoice;
  if (!pc) return invalid('nothing to choose');
  if (!Number.isInteger(index) || index < 0 || index >= pc.options.length) return invalid('no such option');
  const opt = pc.options[index];
  if (optionPrice(opt.actions) > ctx.s.player.currency) {
    // a choice with no affordable option (e.g. from a save made before offers always carried a
    // free option) must not lock the run: any pick then declines it
    if (pc.options.some((o) => optionPrice(o.actions) <= ctx.s.player.currency)) return invalid(`not enough ${ctx.world.vocabulary.currency}`);
    ctx.s.pendingChoice = null;
    if (pc.kind === 'gm_offer' && pc.reservedBudget) ctx.s.area.gmBudget += pc.reservedBudget;
    logKey(ctx, 'log.trade.cannot_afford', { currency: ctx.world.vocabulary.currency }, 'info');
    return free();
  }
  if (opt.tag === 'sell' && opt.sell) {
    // the trader buys one unit: the item goes first, then the price (never via applyGmList, so a
    // stale offer can't pay for an item the player no longer has)
    const slot = sellSlot(ctx, opt.sell);
    if (slot < 0) return invalid('you no longer have that');
    const price = Math.max(0, opt.actions.reduce((n, x) => n + (x.type === 'currency' && x.amount > 0 ? x.amount : 0), 0));
    const shown = displayItemName(ctx, opt.sell.defId);
    ctx.s.pendingChoice = null;
    removeFromSlot(ctx, slot, 1);
    ctx.s.player.currency += price;
    logKey(ctx, 'log.trade.sold', { player: ctx.world.player.name, item: shown, amount: price, currency: ctx.world.vocabulary.currency }, 'loot');
    return free();
  }
  ctx.s.pendingChoice = null;
  const speaker = findActor(ctx, pc.speakerId);
  if (opt.tag?.startsWith('service:') && speaker) {
    const svc = opt.tag.slice('service:'.length);
    speaker.npcUsed = [...(speaker.npcUsed ?? []), svc];
    if (svc === 'recruit') {
      speaker.allyOf = ctx.s.player.actorId;
      speaker.faction = 'friendly';
      logKey(ctx, 'log.ally.joins', { actor: actorName(ctx, speaker) }, 'good');
    }
  }
  if (pc.kind === 'gm_offer' && pc.reservedBudget) {
    // the budget for the goods was reserved when the offer was made: refund what this option leaves unused
    const used = opt.actions.reduce((n, a) => n + (GM_ACTION_COST[a.type] ?? 0), 0);
    ctx.s.area.gmBudget += Math.max(0, pc.reservedBudget - used);
  }
  // never charged here: a GM offer's options were paid for (reserved) when it was made, and
  // dialogue options are engine-built
  applyGmList(ctx, opt.actions, { charge: false });
  return free();
}
