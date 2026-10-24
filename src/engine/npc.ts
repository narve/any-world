/**
 * NPC verbs (offline versions; the GM runtime can layer LLM dialogue on top through applyGmActions):
 * talk opens a dialogue choice built from the NPC's role, persuade is a stat check, and
 * choose_option resolves any pending choice.
 */
import type { GmAction } from '../schema/gm';
import type { ActorInstance, PendingChoice } from './types';
import { type Ctx, actorDef, actorName, emit, findActor, isAlive, isPlayer, log, playerActor } from './ctx';
import { type ActionOutcome, displayItemName, done, free, invalid } from './inventory';
import { applyGmList, optionPrice } from './gm';
import { GM_ACTION_COST } from '../schema/gm';
import { getStat, maxHp, side, statMod } from './stats';
import { isVisibleToPlayer } from './effects';
import { cap, cheb, clamp } from './util';

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
  const name = cap(actorName(ctx, a));
  if (roll !== 1 && (roll === 20 || total >= dc)) {
    if (a.faction === 'hostile') {
      a.faction = 'neutral';
      a.ai.alerted = false;
      delete a.ai.lastSeen;
      log(ctx, `${name} backs down.`, 'good');
    } else if (a.faction === 'neutral') {
      a.faction = 'friendly';
      log(ctx, `${name} warms to you.`, 'good');
    } else if (def.npc?.role === 'ally' || def.behaviour.type === 'follower') {
      a.allyOf = pl.id;
      a.faction = 'friendly';
      log(ctx, `${name} joins you.`, 'good');
    } else {
      const line = def.npc?.lines.length ? ctx.rng.pick(def.npc.lines) : def.npc?.greeting;
      if (line) log(ctx, line, 'npc', def.name);
      else log(ctx, `${name} nods.`, 'info');
    }
  } else {
    log(ctx, `${name} is not convinced.`, 'warning');
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
    log(ctx, `You cannot afford any of it (not enough ${ctx.world.vocabulary.currency}).`, 'info');
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
      log(ctx, `${cap(actorName(ctx, speaker))} joins you.`, 'good');
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
