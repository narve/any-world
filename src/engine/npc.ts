/**
 * NPC verbs (offline versions; the GM runtime can layer LLM dialogue on top through applyGmActions):
 * talk opens a dialogue choice built from the NPC's role, persuade is a stat check, and
 * choose_option resolves any pending choice.
 */
import type { GmAction } from '../schema/gm';
import type { ActorInstance, PendingChoice, PlayerId, PlayerState } from './types';
import { type Ctx, actorDef, actorName, emit, findActor, isAlive, isPlayer, log, logKey, me, playerActor, playerActorOf, playerName } from './ctx';
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
    const it = me(ctx).slots[slot];
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
  const ok = (i: number) => me(ctx).slots[i]?.defId === sell.defId && !equippedKindOf(ctx, i);
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

/** the other player (not the acting one) who has a dialogue with `a` open, if any: one per NPC */
export function talkingWith(ctx: Ctx, a: ActorInstance): PlayerId | undefined {
  for (const id of ctx.s.party) {
    if (id === ctx.pid) continue;
    if (ctx.s.players[id].pendingChoice?.speakerId === a.id) return id;
  }
  return undefined;
}

/**
 * Why an open choice can no longer be answered (null = it still can): its speaker died, left
 * talking range or turned hostile. In a party the world moves while a choice is open; a party of
 * one never gets here (nothing moves until the choice is made), so solo play is unchanged.
 */
function choiceStale(ctx: Ctx, ps: PlayerState): boolean {
  const pc = ps.pendingChoice;
  if (!pc?.speakerId || ctx.s.party.length < 2) return false;
  const speaker = findActor(ctx, pc.speakerId);
  const pa = playerActorOf(ctx, ps.id);
  if (!speaker || !isAlive(ctx, speaker) || side(ctx, speaker) === 'H') return true;
  return !pa || cheb(speaker.pos, pa.pos) > TALK_RANGE;
}

/** closes a player's open choice; a GM offer gives back the budget reserved for it */
export function closeChoice(ctx: Ctx, ps: PlayerState): void {
  const pc = ps.pendingChoice;
  if (!pc) return;
  ps.pendingChoice = null;
  if (pc.kind === 'gm_offer' && pc.reservedBudget) ctx.s.area.gmBudget += pc.reservedBudget;
}

/** end of round: every player's choice whose speaker is gone is closed (log.party.talk_gone) */
export function closeStaleChoices(ctx: Ctx): void {
  for (const id of ctx.s.party) {
    const ps = ctx.s.players[id];
    if (!choiceStale(ctx, ps)) continue;
    closeChoice(ctx, ps);
    logKey(ctx, 'log.party.talk_gone', { player: ps.name }, 'info');
  }
}

export function doTalk(ctx: Ctx, targetId: string): ActionOutcome {
  if (!ctx.world.verbs.talk) return invalid('talking is not possible here');
  const a = npcTarget(ctx, targetId);
  if (typeof a === 'string') return invalid(a);
  const def = actorDef(ctx, a);
  if (!def?.npc) return invalid(`${actorName(ctx, a)} has nothing to say`);
  if (me(ctx).pendingChoice) return invalid('finish the current conversation first');
  if (talkingWith(ctx, a)) return invalid(`${actorName(ctx, a)} is talking with someone else`);
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
  me(ctx).pendingChoice = { kind: 'dialogue', prompt: line, speakerId: a.id, options };
  return free();
}

/** the persuasion roll against `a`: d20 + bonus must reach dc (natural 20 wins, natural 1 fails) */
function persuadeCheck(ctx: Ctx, a: ActorInstance): { dc: number; bonus: number } {
  const def = actorDef(ctx, a);
  const stat = def?.npc?.persuadeStat ?? 'int';
  let dc = def ? (def.npc?.persuadeDifficulty ?? def.persuadeDifficulty ?? clamp(10 + Math.floor(def.stats.hp / 6) + (def.unique ? 5 : 0), 8, 25)) : 20;
  if (a.faction === 'hostile') dc += 2;
  const bonus = statMod(getStat(ctx, playerActor(ctx), stat)) + Math.floor(me(ctx).level / 2);
  return { dc, bonus };
}

/** chance (0.05–0.95) that persuading `a` works right now, as the UI shows it */
export function persuadeChance(ctx: Ctx, a: ActorInstance): number {
  const { dc, bonus } = persuadeCheck(ctx, a);
  let wins = 0;
  for (let roll = 1; roll <= 20; roll++) if (roll !== 1 && (roll === 20 || roll + bonus >= dc)) wins++;
  return wins / 20;
}

export function doPersuade(ctx: Ctx, targetId: string): ActionOutcome {
  if (!ctx.world.verbs.persuade) return invalid('persuasion is not possible here');
  const a = npcTarget(ctx, targetId);
  if (typeof a === 'string') return invalid(a);
  if (a.allyOf) return invalid('already on your side');
  const def = actorDef(ctx, a);
  if (!def) return invalid('no one there');
  const { dc, bonus } = persuadeCheck(ctx, a);
  const pl = playerActor(ctx);
  const roll = ctx.rng.int(1, 20);
  const total = roll + bonus;
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
  const pc = me(ctx).pendingChoice;
  if (!pc) return invalid('nothing to choose');
  if (!Number.isInteger(index) || index < 0 || index >= pc.options.length) return invalid('no such option');
  const opt = pc.options[index];
  // the world kept moving while the choice was open (a party): the speaker may be gone, and a
  // once-only service or a recruit may have been taken by now
  const svcTaken = (sp: ActorInstance | undefined): boolean => {
    if (!sp || !opt.tag?.startsWith('service:') || ctx.s.party.length < 2) return false;
    const svc = opt.tag.slice('service:'.length);
    return (sp.npcUsed ?? []).includes(svc) || (svc === 'recruit' && !!sp.allyOf);
  };
  if (choiceStale(ctx, me(ctx)) || svcTaken(findActor(ctx, pc.speakerId))) {
    closeChoice(ctx, me(ctx));
    logKey(ctx, 'log.party.talk_gone', { player: playerName(ctx) }, 'info');
    return free();
  }
  if (optionPrice(opt.actions) > ctx.s.purse) {
    // a choice with no affordable option (e.g. from a save made before offers always carried a
    // free option) must not lock the run: any pick then declines it
    if (pc.options.some((o) => optionPrice(o.actions) <= ctx.s.purse)) return invalid(`not enough ${ctx.world.vocabulary.currency}`);
    closeChoice(ctx, me(ctx));
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
    me(ctx).pendingChoice = null;
    removeFromSlot(ctx, slot, 1);
    ctx.s.purse += price;
    logKey(ctx, 'log.trade.sold', { player: playerName(ctx), item: shown, amount: price, currency: ctx.world.vocabulary.currency }, 'loot');
    return free();
  }
  me(ctx).pendingChoice = null;
  const speaker = findActor(ctx, pc.speakerId);
  if (opt.tag?.startsWith('service:') && speaker) {
    const svc = opt.tag.slice('service:'.length);
    speaker.npcUsed = [...(speaker.npcUsed ?? []), svc];
    if (svc === 'recruit') {
      speaker.allyOf = me(ctx).actorId;
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
