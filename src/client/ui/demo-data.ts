/**
 * Fake view-model data for the UI demo / screenshots / tests. Pure data, no DOM.
 * Flavoured after the "Rain Broker of Sweetwater" fixture world; nothing here is engine output.
 */
import type { Vocabulary } from '../../schema/world';
import type { ProviderPreset } from '../../llm/types';
import type {
  ActorTooltipView,
  GameView,
  PaletteView,
  SettingsView,
  SlotItemView,
  StartView,
  UiViewModel,
} from './viewmodel';
import { TOTAL_SLOTS } from './slots';

export const DEMO_PALETTE: PaletteView = {
  primary: '#c8743a',
  secondary: '#5b7fa3',
  accent: '#e8c35a',
  danger: '#a8322d',
  ui: '#2a1f19',
  text: '#f3e6cf',
};

export const DEMO_VOCAB: Vocabulary = {
  stats: {
    str: { name: 'Grit', abbr: 'GRT', description: 'Muscle and stubbornness. Melee punch and how much iron you can haul.' },
    dex: { name: 'Draw', abbr: 'DRW', description: 'Speed of hand and eye. Aim, dodging and anything with a trigger.' },
    int: { name: 'Savvy', abbr: 'SAV', description: 'Frontier sense and folk magic. Powers dowsing and rain-craft.' },
    hp: { name: 'Blood', abbr: 'BLD', description: 'How much you can bleed before the buzzards get interested.' },
    mp: { name: 'Instinct', abbr: 'INS', description: 'The prickle at the back of the neck. Spent on dowsing and tricks.' },
    ac: { name: 'Leather', abbr: 'LTH', description: 'Hide, hat brim and luck between you and lead.' },
  },
  conflict: 'Draw on',
  defeated: 'put in the dirt',
  xp: 'Reputation',
  levelUp: 'Word gets around',
  currency: 'silver',
  lossTitle: 'Buried in dry ground',
  winTitle: 'The sky breaks open',
  area: 'Stretch',
};

function item(p: Partial<SlotItemView> & Pick<SlotItemView, 'name' | 'kind' | 'color'>): SlotItemView {
  return {
    instanceId: 'i' + Math.abs(hash(p.name)),
    defId: p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    description: '',
    knowledge: 'clear',
    effectLines: [],
    notes: [],
    count: 1,
    equipped: false,
    usable: false,
    stackable: false,
    ...p,
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export function demoSlots(): (SlotItemView | null)[] {
  const s: (SlotItemView | null)[] = new Array(TOTAL_SLOTS).fill(null);
  s[0] = item({
    name: 'Postal Peacemaker',
    kind: 'Six-shooter',
    color: '#7c8590',
    description: 'Issued by the Territorial Post with a brass plate reading THE MAIL MUST GO THROUGH.',
    effectLines: ['Shoots for 1d8+1 physical, range 6', 'Uses Draw to hit'],
    equipped: true,
    equipSlot: 'weapon',
    rarity: 'uncommon',
  });
  s[1] = item({
    name: 'Army Canteen',
    kind: 'Canteen',
    color: '#6b7b5a',
    description: 'Dented tin under felt. Three good swallows if you are honest with yourself.',
    effectLines: ['Restores 8 Blood', 'Removes Parched'],
    usable: true,
    charges: 2,
    maxCharges: 3,
  });
  s[2] = item({
    name: 'Ricochet Shot',
    kind: 'Trick',
    color: '#c9b27c',
    description: 'Bank a bullet off a bell, a rock and a deputy\'s tin star. Burns three rounds; never misses.',
    effectLines: ['Deals 2d6 physical to one target in sight', 'Costs 3 Rounds'],
    usable: true,
    needsTarget: true,
    cooldown: 2,
    maxCooldown: 3,
  });
  s[3] = item({
    name: 'Stick of Dynamite',
    kind: 'Explosive',
    color: '#c4302b',
    description: 'Sweating a little. Do not think about that.',
    effectLines: ['Deals 3d6 fire in radius 2', 'Throw range 5'],
    usable: true,
    needsTarget: true,
    stackable: true,
    count: 3,
  });
  s[4] = item({
    name: 'milky flask that smells of anise',
    kind: 'Patent medicine',
    color: '#e8e2d0',
    description: 'A patent medicine bottle. The label has been scratched off.',
    knowledge: 'unknown',
    usable: true,
    stackable: true,
    count: 2,
    notes: ['Bought from a man who would not meet my eye.'],
  });
  s[5] = item({
    name: 'Rain Bead',
    kind: 'Bead',
    color: '#bfe6ff',
    description: 'A single drop of rain, held round by something. It is cold. It should not still be cold.',
    knowledge: 'vague',
    vagueText: 'It smells like the morning after a storm. Something in it wants to soak into you.',
    usable: true,
    stackable: true,
    count: 1,
    rarity: 'rare',
  });
  s[7] = item({
    name: 'Hazel Dowsing Rod',
    kind: 'Dowsing rod',
    color: '#b58a52',
    description: 'Forked hazel, cut on a wet day forty years ago by your grandmother.',
    effectLines: ['Reveals the map within 12 tiles', 'Costs 4 Instinct'],
    usable: true,
    maxCooldown: 15,
  });
  s[8] = item({
    name: 'Postal Duster',
    kind: 'Coat',
    color: '#4f6c8a',
    description: 'Canvas duster, dyed post-office blue once upon a time.',
    effectLines: ['+2 Leather'],
    equipped: true,
    equipSlot: 'armour',
    durability: 14,
    maxDurability: 20,
  });
  s[9] = item({
    name: 'Coach Scattergun',
    kind: 'Shotgun',
    color: '#4a4f57',
    description: 'Sawed short for riding shotgun on the mail coach. Loud enough to scare off weather.',
    effectLines: ['Blasts for 2d6 physical in a cone, range 3', 'Requires Grit 12'],
    equipSlot: 'weapon',
  });
  s[10] = item({
    name: 'Lucky Horseshoe',
    kind: 'Charm',
    color: '#a9b0b8',
    description: "Off a horse that outran a tornado. Worn points up so the luck can't run out.",
    effectLines: ['+1 Draw', '+1 Leather'],
    equipSlot: 'trinket',
  });
  s[11] = item({
    name: 'Warm Sarsaparilla',
    kind: 'Tonic',
    color: '#5a2e14',
    description: 'Brown, sweet, fizzless. In this drought it is practically holy water.',
    effectLines: ['Restores 6 Blood'],
    usable: true,
    stackable: true,
    count: 4,
  });
  s[12] = item({
    name: 'cobalt vial sealed with red wax',
    kind: 'Patent medicine',
    color: '#2e5ec9',
    knowledge: 'unknown',
    usable: true,
    stackable: true,
    count: 1,
  });
  s[14] = item({
    name: 'The Deed to the Sky',
    kind: 'Document',
    color: '#efe2c2',
    description: "Signed by a territorial judge who has since bought a lake house.",
    knowledge: 'vague',
    vagueText: 'Legal language so dense it has its own weather. Someone wrote something in the margin.',
    usable: true,
    rarity: 'unique',
    notes: ['The margin note is in Vane\'s hand.', 'Mentions "the cistern".'],
  });
  s[15] = item({
    name: 'Lodestone Gate Key',
    kind: 'Key',
    color: '#4a4f57',
    description: 'Iron, heavy, magnetised so badly it tugs at your belt buckle.',
    rarity: 'unique',
  });
  s[19] = item({
    name: 'Box of .45 Cartridges',
    kind: 'Ammunition',
    color: '#b33a2a',
    description: 'Six fat brass promises.',
    effectLines: ['+6 Rounds'],
    usable: true,
    stackable: true,
    count: 2,
  });
  return s;
}

export const DEMO_ACTOR: ActorTooltipView = {
  id: 'a12',
  name: 'Company Deputy',
  description: 'Tin star stamped COPPERHEAD RAINWORKS. Paid in water, and it shows: he is the only plump man in town.',
  hp: 9,
  maxHp: 12,
  faction: 'hostile',
  statuses: ['Rattled'],
  statusChips: [{ id: 'rattled', name: 'Rattled', description: 'Spooked clean through. Wants to be anywhere else.', harmful: true, color: '#c9b8ff', turnsLeft: 3 }],
  threat: 'dangerous',
  isNpc: false,
  color: '#4b5b3a',
};

export function demoGame(): GameView {
  return {
    hud: {
      playerName: 'Dolores Aguila',
      playerTitle: 'Postwoman of the Dry Route, Last Dowser',
      playerColor: '#4f6c8a',
      stats: [
        { key: 'str', value: 11, base: 11 },
        { key: 'dex', value: 15, base: 14 },
        { key: 'int', value: 12, base: 12 },
        { key: 'ac', value: 13, base: 11 },
      ],
      hp: { value: 9, max: 32 },
      mp: { value: 10, max: 14 },
      resources: [{ id: 'rounds', label: 'Rounds', abbr: 'RND', description: 'Cartridges in your belt. Trick shots burn through them.', value: 9, max: 24, color: '#c9b27c' }],
      level: 2,
      xpInLevel: 31,
      xpForLevel: 48,
      currency: 37,
      statuses: [
        { id: 'parched', name: 'Parched', description: 'Your tongue is leather. You lose a little Blood each turn until you drink.', harmful: true, color: '#d8a15a', turnsLeft: 6 },
        { id: 'steady-hand', name: 'Steady Hand', description: 'Breath slow, sights true.', harmful: false, color: '#e8c35a', turnsLeft: 4 },
      ],
      areaName: 'Dry Creek Flats',
      areaIndex: 1,
      areaCount: 4,
      turn: 214,
      sneaking: false,
      speed: 'normal',
    },
    log: [
      { turn: 180, kind: 'gm', speaker: 'The Territory', text: 'The flats open up like a held breath. Somewhere out there a coyote laughs at a joke you were not told.' },
      { turn: 190, kind: 'info', text: 'You step over a cattle skull bleached the colour of paper.' },
      { turn: 195, kind: 'loot', text: 'You pick up a Box of .45 Cartridges.' },
      { turn: 201, kind: 'combat', text: 'The Dust Coyote snaps at you for 3.' },
      { turn: 202, kind: 'combat', text: 'You shoot the Dust Coyote for 7. It is put in the dirt.' },
      { turn: 205, kind: 'npc', speaker: 'Tobias Ruiz-Hale', text: 'Extra, extra! Postwoman back in town! That\'s news. That\'s a nickel.' },
      { turn: 208, kind: 'warning', text: 'You are Parched.' },
      { turn: 209, kind: 'bad', text: 'Drought: Blood does not come back on its own.' },
      { turn: 211, kind: 'good', text: 'Steady Hand: breath slow, sights true.' },
      { turn: 212, kind: 'system', text: 'Game saved.' },
      { turn: 214, kind: 'combat', text: 'The Company Deputy draws on you and misses.' },
    ],
    slots: demoSlots(),
    narration: null,
    dialogue: null,
    choice: null,
    levelUp: null,
    trade: null,
    rules: [
      { id: 'drought', name: 'Drought', description: 'There is no water to spare. Blood does not come back on its own, and every new stretch of country leaves you parched.', since: 'from the start' },
      { id: 'dust-storms', name: 'Dust on the Wind', description: 'The air is brown with blown topsoil. Everyone sees a little less far than they should.', since: 'from the start' },
      { id: 'gm-thirst', name: 'The Well Is Watched', description: 'Company men guard every water source; drinking draws attention.', since: 'since turn 190', fromGm: true },
    ],
    quests: [{ id: 'q1', title: 'Paper Route', description: 'Deliver Tobias\'s bundle of newspapers to the cantina.', status: 'active' }],
    verbs: { talk: true, sneak: false, search: true, persuade: true },
    transitionName: 'Unlock the Lodestone mine gate',
    canTransition: false,
    goalSummary: 'Put Absalom Vane in the dirt and take back the Thunder Jar from the cistern under the mesa.',
    mode: 'normal',
  };
}

export const DEMO_PRESETS: ProviderPreset[] = [
  { id: 'anthropic', label: 'Anthropic Claude', region: 'US', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet', structuredOutput: 'json_schema', cors: true, needsKey: true, contextTokens: 200000 },
  { id: 'mistral', label: 'Mistral', region: 'EU', kind: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest', models: ['mistral-large-latest', 'mistral-small-latest'], structuredOutput: 'json_schema', cors: true, needsKey: true, contextTokens: 128000 },
  { id: 'deepseek', label: 'DeepSeek', region: 'China', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', structuredOutput: 'json_object', cors: false, needsKey: true, contextTokens: 64000, notes: 'JSON mode only; responses are validated and repaired.' },
  { id: 'ollama', label: 'Ollama', region: 'Local', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.1', structuredOutput: 'json_schema', cors: true, needsKey: false, contextTokens: 32000, notes: 'Runs on your machine. Start Ollama with OLLAMA_ORIGINS set to allow the browser.' },
];

export function demoSettings(): SettingsView {
  return {
    presets: DEMO_PRESETS,
    current: {
      provider: { preset: 'deepseek', model: 'deepseek-chat', transport: 'direct' },
      audio: { volume: 0.6, muted: false },
      animationSpeed: 1,
      reduceMotion: false,
    },
  };
}

export function demoStart(): StartView {
  return {
    prompts: [
      { prompt: 'a drought town where the rain was stolen', genre: 'weird western', teaser: 'A dowser postwoman versus a man who sells the sky.', worldId: 'fixture-western' },
      { prompt: 'the last week of school before a town floods', genre: 'teen drama', teaser: 'Out-talk the board member\'s daughter before the floodgates close.', worldId: 'fixture-teen' },
      { prompt: 'a generation ship where the caretaker AI has gone quiet', genre: 'sci-fi mystery', teaser: 'Oxygen is a clock. MATRON is not answering.', worldId: 'fixture-ship' },
      { prompt: 'a heist inside a sleeping giant\'s dream', genre: 'surreal', teaser: 'Steal a memory before he wakes.' },
      { prompt: 'a Viking feud settled by a poetry duel', genre: 'saga', teaser: 'Your verses cut deeper than axes.' },
      { prompt: 'a rain-soaked noir city where the dead file complaints', genre: 'noir', teaser: 'Interrogate ghosts. Mind your Nerve.' },
      { prompt: 'abstract art gallery where the paintings are hungry', genre: 'abstract', teaser: 'Navigate colour fields and angry triangles.' },
    ],
    demos: [
      { id: 'fixture-western', title: 'The Rain Broker of Sweetwater', tagline: 'Nine weeks without rain. A land agent keeps the storm corked in a copper jar.', genre: 'weird western', color: '#c8743a' },
      { id: 'fixture-teen', title: 'Lowmoor Goes Under', tagline: 'Five school days until the reservoir swallows the town.', genre: 'teen social drama', color: '#6c9bd2' },
      { id: 'fixture-ship', title: 'The Long Quiet of the Halcyon Tithe', tagline: 'The caretaker is silent and the air is running out.', genre: 'sci-fi mystery', color: '#5fc1b5' },
    ],
    savedRun: { worldTitle: 'The Rain Broker of Sweetwater', playerName: 'Dolores Aguila', areaName: 'Dry Creek Flats', turn: 214 },
    providerLabel: 'Provider: DeepSeek (direct)',
    canGenerate: true,
    defaults: { difficulty: 'normal', weirdness: 0.4 },
  };
}

export type DemoScene =
  | 'start'
  | 'settings'
  | 'loading'
  | 'game'
  | 'narration'
  | 'backpack'
  | 'dialogue'
  | 'choice'
  | 'levelup'
  | 'trade'
  | 'help'
  | 'rules'
  | 'target'
  | 'won'
  | 'lost';

export const DEMO_SCENES: DemoScene[] = ['start', 'settings', 'loading', 'game', 'narration', 'backpack', 'dialogue', 'choice', 'levelup', 'trade', 'help', 'rules', 'target', 'won', 'lost'];

/** a complete view model for a demo scene (UI-local overlays such as backpack/help are opened by the demo) */
export function demoViewModel(scene: DemoScene): UiViewModel {
  const theme = { palette: DEMO_PALETTE, vocabulary: DEMO_VOCAB };
  const base: UiViewModel = { screen: 'game', theme, prefs: { animationSpeed: 1, reduceMotion: false } };
  switch (scene) {
    case 'start':
      return { ...base, screen: 'start', start: demoStart() };
    case 'settings':
      return { ...base, screen: 'start', start: demoStart(), settings: demoSettings() };
    case 'loading':
      return {
        ...base,
        screen: 'loading',
        loading: {
          title: 'The Rain Broker of Sweetwater',
          tagline: 'Nine weeks without rain. A land agent keeps the storm corked in a copper jar under the mesa.',
          genre: 'weird western',
          steps: [
            { id: 'concept', label: 'Inventing the premise', status: 'done' },
            { id: 'world', label: 'Writing the world', status: 'done', detail: '14 characters, 24 things' },
            { id: 'validate', label: 'Checking the rules hold together', status: 'active' },
            { id: 'balance', label: 'Simulating a few runs', status: 'pending' },
            { id: 'map', label: 'Laying out the first stretch', status: 'pending' },
          ],
          canCancel: true,
        },
      };
    case 'won':
    case 'lost':
      return {
        ...base,
        screen: 'end',
        end: {
          result: scene === 'won' ? 'won' : 'lost',
          worldTitle: 'The Rain Broker of Sweetwater',
          playerName: 'Dolores Aguila',
          text:
            scene === 'won'
              ? 'You pull the copper cork. The storm does not explode; it simply leaves, the way a held breath leaves, up the shaft and out over the mesa.'
              : 'The buzzards had been patient. Out on the flats your letters scatter, addresses fading in the sun. Somewhere under the mesa, the storm keeps pacing.',
          reason: scene === 'won' ? undefined : 'Put in the dirt by Sabine Lark.',
          epitaph: scene === 'won' ? undefined : 'Here lies the last dowser. The water was always closer than she thought.',
          stats: { turns: 612, kills: 17, itemsUsed: 23, damageDealt: 241, damageTaken: 198, areasCleared: scene === 'won' ? 4 : 2, areaCount: 4, level: 4 },
        },
      };
    default:
      break;
  }
  const g = demoGame();
  switch (scene) {
    case 'narration':
      g.narration = {
        id: 'n-area-1',
        kind: 'area_enter',
        title: 'Dry Creek Flats',
        speaker: 'The Territory',
        text: 'The creek is a scar the width of a wagon. Somewhere ahead, past the bones and the rusted windpump, the Lodestone mine gate hums with a magnetism that pulls the nails half out of the fence posts. Your hazel rod twitches. It knows.',
      };
      break;
    case 'dialogue':
      g.dialogue = {
        npcId: 'a3',
        npcName: 'Widow Marisol Oquendo',
        npcTitle: 'Keeper of the Thirsty Saint',
        portraitColor: '#5a1f2b',
        reply: 'If you\'re buying, sit. If you\'re company, keep walking. ...You\'re the post. Then you\'ve got a letter for Vane, and I\'ve got a mind to help you deliver it.',
        options: ['What do you know about the mine?', 'I need water. What will it cost?', 'Vane will hang for this.'],
        pending: false,
        canPersuade: true,
        canTrade: true,
        history: [{ who: 'player', text: 'Evening, Señora.' }],
      };
      break;
    case 'choice':
      g.choice = {
        speaker: 'The Territory',
        prompt: 'A thunderhead the size of a church stands over the mesa, motionless, as if waiting for permission. The rod in your hand points at it, then at you.',
        options: [{ label: 'Ask it politely to come down (lose 4 Instinct)' }, { label: 'Fire a round into it' }, { label: 'Walk on. It is not your weather.' }],
      };
      break;
    case 'levelup':
      g.levelUp = {
        level: 3,
        perks: [
          { id: 'quick-draw', name: 'Quick Draw', description: 'Your hand is on the grip before the thought is finished.', lines: ['+2 Draw'] },
          { id: 'rawhide', name: 'Rawhide', description: 'Tanned by nine weeks of sun.', lines: ['+8 Blood', '+1 Leather'] },
          { id: 'far-sight', name: 'Desert Eyes', description: 'You read the horizon like a letter.', lines: ['+2 sight'] },
        ],
      };
      break;
    case 'trade': {
      const slots = g.slots;
      g.trade = {
        traderId: 'a3',
        traderName: 'Widow Marisol Oquendo',
        traderColor: '#5a1f2b',
        greeting: 'Fair prices. Fairer than the company, anyhow.',
        currency: 37,
        offers: [
          { item: slots[11]!, price: 8 },
          { item: { ...slots[1]!, charges: 3 }, price: 25 },
          { item: slots[19]!, price: 12 },
          { item: { ...slots[9]!, equipped: false }, price: 60 },
        ],
        sellable: [
          { slot: 10, item: slots[10]!, price: 15 },
          { slot: 12, item: slots[12]!, price: 4 },
        ],
      };
      break;
    }
    case 'target':
      g.mode = 'target';
      g.targetingSlot = 2;
      break;
    default:
      break;
  }
  if (scene === 'game' || scene === 'backpack' || scene === 'help' || scene === 'rules' || scene === 'target') {
    g.busy = scene === 'game' ? 'The Territory is thinking…' : null;
  }
  return { ...base, game: g };
}
