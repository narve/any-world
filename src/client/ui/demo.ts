/**
 * `mountUiDemo(root)` renders every UI component with fake view-model data (no engine, no
 * renderer) — for screenshots and visual review. A small scene switcher (PageUp/PageDown or the
 * dropdown) cycles through scenes; `?scene=<name>` in the URL picks one. Callbacks are logged to
 * the in-UI message log so interactions are visible.
 */
import { createUi, type GameUi } from './ui';
import { DEMO_ACTOR, DEMO_SCENES, demoViewModel, type DemoScene } from './demo-data';
import type { UiCallbacks, UiViewModel } from './viewmodel';
import { h } from './dom';

export interface UiDemo {
  ui: GameUi;
  show(scene: DemoScene): void;
  scenes: readonly DemoScene[];
  current(): DemoScene;
}

export function mountUiDemo(root: HTMLElement, opts: { scene?: DemoScene; switcher?: boolean } = {}): UiDemo {
  let vm: UiViewModel;
  let scene: DemoScene = opts.scene ?? 'game';
  const say = (text: string) => {
    if (vm.game) {
      vm = { ...vm, game: { ...vm.game, log: [...vm.game.log, { turn: vm.game.hud.turn, kind: 'system', text }] } };
      ui.render(vm);
    }
    console.info('[ui-demo]', text);
  };
  const cb: UiCallbacks = {
    onAction: (a) => {
      if (a.type === 'move_item' && vm.game) {
        const slots = vm.game.slots.slice();
        [slots[a.from], slots[a.to]] = [slots[a.to], slots[a.from]];
        vm = { ...vm, game: { ...vm.game, slots } };
        ui.render(vm);
      }
      if (a.type === 'choose_option' || a.type === 'choose_perk') {
        vm = { ...vm, game: vm.game && { ...vm.game, choice: null, levelUp: null } };
        ui.render(vm);
      }
      say(`action: ${JSON.stringify(a)}`);
    },
    onIntent: (i) => {
      if (i.type === 'begin_target' && vm.game) {
        vm = { ...vm, game: { ...vm.game, mode: 'target', targetingSlot: i.slot } };
        ui.render(vm);
      } else if ((i.type === 'cancel' || i.type === 'confirm_cursor') && vm.game) {
        vm = { ...vm, game: { ...vm.game, mode: 'normal', targetingSlot: undefined } };
        ui.render(vm);
      } else if (i.type === 'look' && vm.game) {
        vm = { ...vm, game: { ...vm.game, mode: i.on ? 'look' : 'normal' } };
        ui.render(vm);
      }
      if (i.type !== 'hover_tile') say(`intent: ${JSON.stringify(i)}`);
    },
    onStart: (o) => console.info('[ui-demo] start', o),
    onPlayDemo: (id) => console.info('[ui-demo] demo', id),
    onContinue: () => console.info('[ui-demo] continue'),
    onSettings: (s) => console.info('[ui-demo] settings', s),
    onOpenSettings: (open) => {
      vm = { ...vm, settings: open ? demoViewModel('settings').settings : null };
      ui.render(vm);
    },
    onDismissNarration: (id) => {
      if (vm.game) vm = { ...vm, game: { ...vm.game, narration: null } };
      ui.render(vm);
      say(`narration dismissed: ${id}`);
    },
    onDialogueReply: (i, t) => {
      if (!vm.game?.dialogue) return;
      const d = vm.game.dialogue;
      vm = { ...vm, game: { ...vm.game, dialogue: { ...d, pending: true, history: [...(d.history ?? []), { who: 'npc', text: d.reply }, { who: 'player', text: t }] } } };
      ui.render(vm);
      setTimeout(() => {
        if (!vm.game?.dialogue) return;
        vm = { ...vm, game: { ...vm.game, dialogue: { ...vm.game.dialogue, pending: false, reply: 'The mine? Nobody goes in who works for the company. Nobody comes out who doesn\'t.', options: ['Then I\'ll be the first.', 'Who has the key?'] } } };
        ui.render(vm);
      }, 900);
      say(`reply ${i}: ${t}`);
    },
    onDialogueLeave: () => {
      if (vm.game) vm = { ...vm, game: { ...vm.game, dialogue: null } };
      ui.render(vm);
    },
    onTrade: (t) => {
      if (t.type === 'close' && vm.game) vm = { ...vm, game: { ...vm.game, trade: null } };
      ui.render(vm);
      say(`trade: ${JSON.stringify(t)}`);
    },
    onEnd: (c) => console.info('[ui-demo] end', c),
    onCancelLoading: () => show('start'),
  };
  const ui = createUi(root, cb);

  function show(s: DemoScene): void {
    scene = s;
    vm = demoViewModel(s);
    ui.render(vm);
    ui.hideTooltip();
    ui.setBackpackOpen(s === 'backpack');
    if (s === 'help') root.ownerDocument.defaultView?.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    if (s === 'rules') root.ownerDocument.defaultView?.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    if (s === 'game') {
      const r = root.getBoundingClientRect();
      ui.showActorTooltip(DEMO_ACTOR, { x: r.left + r.width * 0.62, y: r.top + r.height * 0.36 });
    }
    if (select) select.value = s;
  }

  let select: HTMLSelectElement | null = null;
  if (opts.switcher !== false) {
    select = h(
      'select',
      { class: 'aw-demo-switch', 'aria-label': 'Demo scene', onchange: (e: Event) => show((e.target as HTMLSelectElement).value as DemoScene) },
      DEMO_SCENES.map((s) => h('option', { value: s }, s)),
    );
    root.ownerDocument.body.appendChild(select);
    root.ownerDocument.defaultView?.addEventListener('keydown', (e) => {
      if (e.key !== 'PageDown' && e.key !== 'PageUp') return;
      if (!e.shiftKey) return;
      const i = DEMO_SCENES.indexOf(scene);
      show(DEMO_SCENES[(i + (e.key === 'PageDown' ? 1 : -1) + DEMO_SCENES.length) % DEMO_SCENES.length]);
    });
  }

  const fromUrl = new URLSearchParams(root.ownerDocument.defaultView?.location.search ?? '').get('scene') as DemoScene | null;
  show(opts.scene ?? (fromUrl && DEMO_SCENES.includes(fromUrl) ? fromUrl : 'game'));
  return { ui, show, scenes: DEMO_SCENES, current: () => scene };
}
