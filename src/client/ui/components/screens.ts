/** Full-screen views: start, loading, end; and the settings dialog. */
import type { Vocabulary } from '../../../schema/world';
import type { EndView, InspirationPrompt, LoadingView, Settings, SettingsView, StartOptions, StartView, UiCallbacks, UiViewModel } from '../viewmodel';
import { dataKey, h, icon, ICONS, setChildren } from '../dom';
import { baseLang, clamp, DIFFICULTIES, difficultyHint, difficultyLabel, groupByLanguage, languageEndonym, pickInspiration, presetNotes, runStatLines, toDifficulty, weirdnessLabel } from '../format';
import { Modal } from './modals';
import { getLanguage, t } from '../../i18n/index';

type LanguageVm = UiViewModel['language'];

/** a language <select>; null while there is only one language */
export function languagePicker(lang: LanguageVm, onPick: ((code: string) => void) | undefined, id: string): HTMLElement | null {
  if (!lang || lang.options.length < 2 || !onPick) return null;
  return h(
    'select',
    { id, class: 'aw-lang-select', 'aria-label': t('settings.language'), onchange: (e: Event) => onPick((e.target as HTMLSelectElement).value) },
    lang.options.map((o) => h('option', { value: o.code, selected: o.code === lang.current }, o.name)),
  );
}

const CARD_COUNT = 4;

// ---------------------------------------------------------------------------
// Start screen
// ---------------------------------------------------------------------------

export class StartScreen {
  readonly el: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private diff: HTMLInputElement;
  private weird: HTMLInputElement;
  private diffOut: HTMLOutputElement;
  private weirdOut: HTMLOutputElement;
  private diffHint: HTMLElement;
  private cardsEl: HTMLElement;
  private sideEl: HTMLElement;
  private noteEl: HTMLElement;
  private view: StartView | null = null;
  private listKey = '';
  private cards: InspirationPrompt[] = [];
  private initialised = false;
  private langEl: HTMLElement;
  private langKey = '';
  /** the inspiration card last copied into the prompt box (its language goes with it while unedited) */
  private filled: { prompt: string; language: string } | null = null;

  constructor(private cb: UiCallbacks, private rand: () => number = Math.random) {
    this.langEl = h('div', { class: 'aw-start-lang' });
    this.textarea = h('textarea', {
      id: 'aw-prompt',
      class: 'aw-textarea',
      rows: '3',
      maxlength: '500',
      placeholder: t('start.placeholder'),
      'data-autofocus': true,
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.create(false);
        }
      },
    });
    this.diffOut = h('output', { class: 'aw-range-out', for: 'aw-diff' });
    this.weirdOut = h('output', { class: 'aw-range-out', for: 'aw-weird' });
    this.diff = h('input', {
      id: 'aw-diff',
      type: 'range',
      min: '0',
      max: String(DIFFICULTIES.length - 1),
      step: '1',
      value: String(DIFFICULTIES.indexOf('normal')),
      'aria-describedby': 'aw-diff-hint',
      oninput: () => this.syncOut(),
    });
    this.diffHint = h('p', { id: 'aw-diff-hint', class: 'aw-range-hint' });
    this.weird = h('input', { id: 'aw-weird', type: 'range', min: '0', max: '1', step: '0.05', value: '0.4', oninput: () => this.syncOut() });
    this.cardsEl = h('div', { class: 'aw-insp-cards' });
    this.sideEl = h('aside', { class: 'aw-start-side' });
    this.noteEl = h('p', { class: 'aw-start-note' });

    this.el = h(
      'main',
      { class: 'aw-screen aw-start', 'aria-label': t('start.label') },
      h(
        'div',
        { class: 'aw-start-inner' },
        h(
          'section',
          { class: 'aw-start-main' },
          h(
            'header',
            { class: 'aw-brand' },
            h('h1', { class: 'aw-logo' }, 'Any', h('span', null, 'World')),
            h('p', { class: 'aw-brand-sub' }, t('start.tagline')),
            this.langEl,
            h('button', { type: 'button', class: 'aw-icon-btn aw-start-settings', 'aria-label': t('settings.title'), dataset: { tip: t('settings.title') }, onclick: () => this.cb.onOpenSettings?.(true) }, icon(ICONS.gear)),
          ),
          h('label', { class: 'aw-label', for: 'aw-prompt' }, t('start.promptLabel')),
          this.textarea,
          h(
            'div',
            { class: 'aw-sliders' },
            h('label', { class: 'aw-range', for: 'aw-diff' }, h('span', null, t('start.difficulty')), this.diff, this.diffOut),
            h('label', { class: 'aw-range', for: 'aw-weird' }, h('span', null, t('start.weirdness')), this.weird, this.weirdOut),
          ),
          this.diffHint,
          h(
            'div',
            { class: 'aw-start-actions' },
            h('button', { type: 'button', class: 'aw-btn aw-btn-primary aw-btn-lg', onclick: () => this.create(false) }, icon(ICONS.play), t('start.create')),
            h('button', { type: 'button', class: 'aw-btn aw-btn-lg', onclick: () => this.create(true) }, icon(ICONS.sparkle), t('start.surprise')),
          ),
          this.noteEl,
          h(
            'section',
            { class: 'aw-insp' },
            h(
              'div',
              { class: 'aw-insp-head' },
              h('h2', null, t('start.inspiration')),
              h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-btn-ghost', onclick: () => this.shuffle(), 'aria-label': t('start.shuffleAria') }, icon(ICONS.shuffle), t('start.shuffle')),
            ),
            this.cardsEl,
          ),
        ),
        this.sideEl,
      ),
    );
    this.syncOut();
  }

  private syncOut(): void {
    const d = toDifficulty(Number(this.diff.value));
    this.diffOut.textContent = difficultyLabel(d);
    this.diffHint.textContent = difficultyHint(d);
    this.diff.setAttribute('aria-valuetext', difficultyLabel(d));
    this.weirdOut.textContent = weirdnessLabel(Number(this.weird.value));
    this.weird.setAttribute('aria-valuetext', weirdnessLabel(Number(this.weird.value)));
  }

  options(surprise: boolean): StartOptions {
    const prompt = surprise ? '' : this.textarea.value.trim();
    const fromCard = !!prompt && this.filled !== null && this.filled.prompt === prompt && baseLang(this.filled.language) !== baseLang(getLanguage());
    return {
      prompt,
      difficulty: toDifficulty(Number(this.diff.value)),
      weirdness: clamp(Number(this.weird.value), 0, 1),
      surprise,
      ...(fromCard ? { language: this.filled!.language } : {}),
    };
  }

  private create(surprise: boolean): void {
    if (this.view && !this.view.canGenerate) {
      this.cb.onOpenSettings?.(true);
      return;
    }
    this.cb.onStart?.(this.options(surprise));
  }

  shuffle(): void {
    if (!this.view) return;
    this.cards = pickInspiration(this.view.prompts, CARD_COUNT, getLanguage(), this.rand);
    this.renderCards();
  }

  private renderCards(): void {
    const ui = baseLang(getLanguage());
    setChildren(
      this.cardsEl,
      this.cards.map((p) =>
        h(
          'div',
          { class: 'aw-insp-card', lang: baseLang(p.language) },
          h(
            'button',
            {
              type: 'button',
              class: 'aw-insp-fill',
              'aria-label': t('start.usePrompt', { prompt: p.prompt }),
              onclick: () => {
                this.textarea.value = p.prompt;
                this.filled = { prompt: p.prompt.trim(), language: p.language ?? 'en' };
                this.textarea.focus();
              },
            },
            h(
              'span',
              { class: 'aw-insp-genre' },
              p.genre,
              baseLang(p.language) !== ui ? h('span', { class: 'aw-lang-badge', title: t('start.worldLanguage', { language: languageEndonym(p.language) }) }, baseLang(p.language).toUpperCase()) : null,
            ),
            h('span', { class: 'aw-insp-prompt' }, p.prompt),
            p.teaser ? h('span', { class: 'aw-insp-teaser' }, p.teaser) : null,
          ),
          p.worldId ? h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-insp-demo', onclick: () => this.cb.onPlayDemo?.(p.worldId!, this.options(false)) }, icon(ICONS.play), t('start.playDemo')) : null,
        ),
      ),
    );
  }

  update(v: StartView, lang?: LanguageVm): void {
    this.view = v;
    const lk = dataKey(lang ?? null);
    if (lk !== this.langKey) {
      this.langKey = lk;
      setChildren(this.langEl, languagePicker(lang, this.cb.onLanguage ? (c) => this.cb.onLanguage?.(c) : undefined, 'aw-start-lang'));
    }
    if (!this.initialised) {
      this.initialised = true;
      if (v.defaults?.prompt) this.textarea.value = v.defaults.prompt;
      if (v.defaults?.difficulty !== undefined) this.diff.value = String(Math.max(0, DIFFICULTIES.indexOf(toDifficulty(v.defaults.difficulty))));
      if (v.defaults?.weirdness !== undefined) this.weird.value = String(v.defaults.weirdness);
      this.syncOut();
    }
    const key = dataKey([v.prompts, v.demos, v.savedRun, v.providerLabel, v.canGenerate]);
    if (key === this.listKey) return;
    const promptsChanged = dataKey(v.prompts) !== dataKey(JSON.parse(this.listKey || '[[]]')[0]);
    this.listKey = key;
    if (promptsChanged || !this.cards.length) this.shuffle();

    this.noteEl.textContent = '';
    if (!v.canGenerate) {
      this.noteEl.append(
        icon(ICONS.alert),
        h('span', null, t('start.noProvider')),
        ' ',
        h('button', { type: 'button', class: 'aw-link', onclick: () => this.cb.onOpenSettings?.(true) }, t('start.openSettings')),
        ' ',
        h('span', null, t('start.orDemo')),
      );
    } else if (v.providerLabel) {
      this.noteEl.append(h('span', { class: 'aw-muted' }, v.providerLabel), ' · ', h('button', { type: 'button', class: 'aw-link', onclick: () => this.cb.onOpenSettings?.(true) }, t('start.change')));
    }

    setChildren(
      this.sideEl,
      v.savedRun
        ? h(
            'section',
            { class: 'aw-saved' },
            h('h2', null, t('start.continue')),
            h(
              'button',
              { type: 'button', class: 'aw-saved-card', onclick: () => this.cb.onContinue?.() },
              h('span', { class: 'aw-saved-title' }, v.savedRun.worldTitle),
              h('span', { class: 'aw-saved-sub' }, t('start.savedSub', { player: v.savedRun.playerName, area: v.savedRun.areaName, turn: v.savedRun.turn })),
            ),
          )
        : null,
      h(
        'section',
        { class: 'aw-demos' },
        h('h2', null, t('start.demos')),
        h('p', { class: 'aw-muted aw-small' }, t('start.demosSub')),
        v.demos.length ? this.demoGroups(v) : h('p', { class: 'aw-muted' }, t('start.noDemos')),
      ),
    );
  }

  /** the demo list, one labelled group per world language (no headings while there is only one) */
  private demoGroups(v: StartView): HTMLElement {
    const groups = groupByLanguage(v.demos, getLanguage());
    const list = (demos: StartView['demos']) =>
      h(
        'ul',
        { class: 'aw-demo-list' },
        demos.map((d) =>
          h(
            'li',
            null,
            h(
              'button',
              { type: 'button', class: 'aw-demo', lang: baseLang(d.language), dataset: { world: d.id }, style: { '--demo': d.color ?? 'var(--c-primary)' }, onclick: () => this.cb.onPlayDemo?.(d.id, this.options(false)) },
              h('span', { class: 'aw-demo-genre' }, d.genre),
              h('span', { class: 'aw-demo-title' }, d.title),
              h('span', { class: 'aw-demo-tag' }, d.tagline),
            ),
          ),
        ),
      );
    if (groups.length < 2) return list(v.demos);
    return h(
      'div',
      { class: 'aw-demo-groups' },
      groups.map((g) =>
        h(
          'section',
          { class: 'aw-demo-group', dataset: { lang: g.language }, 'aria-label': t('start.demosIn', { language: g.label, count: g.items.length }) },
          h('h3', { class: 'aw-demo-lang' }, h('span', { lang: g.language }, g.label), h('span', { class: 'aw-demo-count' }, String(g.items.length))),
          list(g.items),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Loading screen
// ---------------------------------------------------------------------------

export class LoadingScreen {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private key = '';

  constructor(private cb: UiCallbacks) {
    this.body = h('div', { class: 'aw-loading-inner' });
    this.el = h('main', { class: 'aw-screen aw-loading', 'aria-label': t('loading.label'), 'aria-busy': 'true' }, this.body);
  }

  update(v: LoadingView): void {
    const key = dataKey(v);
    if (key === this.key) return;
    this.key = key;
    const done = v.steps.filter((s) => s.status === 'done').length;
    const progress = v.steps.length ? Math.round((done / v.steps.length) * 100) : 0;
    this.el.setAttribute('aria-busy', String(!v.error));
    setChildren(
      this.body,
      h('div', { class: 'aw-loading-genre' }, v.genre ?? t('loading.inventing')),
      h('h1', { class: ['aw-loading-title', !v.title && 'is-placeholder'] }, v.title ?? '…'),
      v.tagline ? h('p', { class: 'aw-loading-tagline' }, v.tagline) : null,
      h('div', { class: 'aw-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(progress) }, h('span', { style: { width: `${progress}%` } })),
      h(
        'ol',
        { class: 'aw-steps' },
        v.steps.map((s) =>
          h(
            'li',
            { class: `step-${s.status}` },
            h('span', { class: 'aw-step-mark', 'aria-hidden': 'true' }, s.status === 'done' ? icon(ICONS.check) : s.status === 'error' ? icon(ICONS.alert) : null),
            h('span', { class: 'aw-step-label' }, s.label),
            s.detail ? h('span', { class: 'aw-step-detail' }, s.detail) : null,
            h('span', { class: 'aw-sr' }, ` (${t(`loading.status.${s.status}` as const)})`),
          ),
        ),
      ),
      v.error ? h('p', { class: 'aw-error', role: 'alert' }, v.error) : null,
      v.canRetry || v.canCancel
        ? h(
            'div',
            { class: 'aw-loading-actions' },
            v.canRetry ? h('button', { type: 'button', class: 'aw-btn aw-btn-primary', 'data-autofocus': true, onclick: () => this.cb.onRetryLoading?.() }, t('loading.retry')) : null,
            v.canCancel ? h('button', { type: 'button', class: 'aw-btn aw-btn-ghost', onclick: () => this.cb.onCancelLoading?.() }, t('loading.back')) : null,
          )
        : null,
    );
  }
}

// ---------------------------------------------------------------------------
// End screen
// ---------------------------------------------------------------------------

export class EndScreen {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private key = '';

  constructor(private cb: UiCallbacks) {
    this.body = h('div', { class: 'aw-end-inner' });
    this.el = h('main', { class: 'aw-screen aw-end', 'aria-label': t('end.label') }, this.body);
  }

  update(v: EndView, vocab: Vocabulary): void {
    const key = dataKey([v, vocab]);
    if (key === this.key) return;
    this.key = key;
    this.el.dataset.result = v.result;
    setChildren(
      this.body,
      h('div', { class: 'aw-end-world' }, v.worldTitle),
      h('h1', { class: 'aw-end-title' }, v.result === 'won' ? vocab.winTitle : vocab.lossTitle),
      h('p', { class: 'aw-end-text' }, v.text),
      v.reason ? h('p', { class: 'aw-end-reason' }, v.reason) : null,
      v.epitaph ? h('blockquote', { class: 'aw-end-epitaph' }, v.epitaph) : null,
      h(
        'dl',
        { class: 'aw-end-stats', 'aria-label': t('end.statsAria', { player: v.playerName }) },
        runStatLines(v.stats, vocab).map((s) => h('div', null, h('dt', null, s.label), h('dd', null, s.value))),
      ),
      v.difficulty !== undefined || v.weirdness !== undefined
        ? h(
            'p',
            { class: 'aw-end-settings' },
            v.difficulty !== undefined ? h('span', { class: 'aw-chip tone-muted' }, t('end.difficulty', { value: difficultyLabel(v.difficulty) })) : null,
            v.weirdness !== undefined ? h('span', { class: 'aw-chip tone-muted' }, t('end.weirdness', { value: weirdnessLabel(v.weirdness) })) : null,
          )
        : null,
      h(
        'div',
        { class: 'aw-end-actions' },
        h('button', { type: 'button', class: 'aw-btn aw-btn-primary aw-btn-lg', 'data-autofocus': true, onclick: () => this.cb.onEnd?.('new_world') }, t('end.newWorld')),
        h('button', { type: 'button', class: 'aw-btn aw-btn-lg', onclick: () => this.cb.onEnd?.('same_world') }, t('end.sameWorld')),
      ),
    );
    queueMicrotask(() => this.body.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true }));
  }
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

export class SettingsDialog {
  readonly modal = new Modal('aw-settings', t('settings.title'));
  private draft: Settings | null = null;
  private view: SettingsView | null = null;
  private lang: LanguageVm = undefined;

  constructor(private cb: UiCallbacks) {}

  get el(): HTMLElement {
    return this.modal.el;
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  update(v: SettingsView | null | undefined, lang?: LanguageVm): void {
    this.lang = lang;
    if (!v) {
      this.draft = null;
      this.view = null;
      return this.modal.hide();
    }
    const opening = !this.modal.isOpen;
    if (!this.modal.show([v, lang ?? null]) && !opening) return;
    this.view = v;
    this.draft = structuredClone(v.current);
    this.render(true);
  }

  private set(mut: (d: Settings) => void, rerender = false): void {
    if (!this.draft) return;
    mut(this.draft);
    if (rerender) this.render(false);
  }

  private render(focus: boolean): void {
    const v = this.view;
    const d = this.draft;
    if (!v || !d) return;
    const active = document.activeElement as HTMLElement | null;
    const activeId = active && this.modal.card.contains(active) ? active.id : null;
    const preset = v.presets.find((p) => p.id === d.provider.preset);
    const transports = v.transports ?? ['direct', 'backend'];
    const field = (label: string, id: string, input: HTMLElement, hint?: Node | string | null) =>
      h('div', { class: 'aw-field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'aw-field-hint' }, hint) : null);

    const presetSel = h(
      'select',
      {
        id: 'aw-set-preset',
        'data-autofocus': true,
        onchange: (e: Event) =>
          this.set((s) => {
            const id = (e.target as HTMLSelectElement).value;
            s.provider.preset = id;
            const p = v.presets.find((x) => x.id === id);
            s.provider.model = p?.defaultModel ?? s.provider.model;
            if (p) s.provider.baseUrl = undefined;
            if (p && !p.cors && transports.includes('backend')) s.provider.transport = 'backend';
          }, true),
      },
      v.presets.map((p) => h('option', { value: p.id, selected: p.id === d.provider.preset }, `${p.label} — ${p.region}`)),
      h('option', { value: 'custom', selected: d.provider.preset === 'custom' }, t('settings.custom')),
    );
    const models = preset?.models?.length ? preset.models : null;
    const modelInput = models
      ? h(
          'select',
          { id: 'aw-set-model', onchange: (e: Event) => this.set((s) => (s.provider.model = (e.target as HTMLSelectElement).value)) },
          models.map((m) => h('option', { value: m, selected: m === (d.provider.model ?? preset?.defaultModel) }, m)),
        )
      : h('input', {
          id: 'aw-set-model',
          type: 'text',
          class: 'aw-input',
          value: d.provider.model ?? preset?.defaultModel ?? '',
          placeholder: preset?.defaultModel ?? t('settings.modelPlaceholder'),
          oninput: (e: Event) => this.set((s) => (s.provider.model = (e.target as HTMLInputElement).value)),
        });
    const transportRadios = h(
      'div',
      { class: 'aw-seg', role: 'radiogroup', 'aria-label': t('settings.transport') },
      (['direct', 'backend'] as const).map((tr) =>
        h(
          'label',
          { class: ['aw-seg-opt', !transports.includes(tr) && 'is-disabled'] },
          h('input', {
            type: 'radio',
            name: 'aw-transport',
            id: `aw-set-transport-${tr}`,
            value: tr,
            checked: d.provider.transport === tr,
            disabled: !transports.includes(tr),
            onchange: () => this.set((s) => (s.provider.transport = tr), true),
          }),
          h('span', null, tr === 'direct' ? t('settings.direct') : t('settings.backend')),
        ),
      ),
    );
    const notes = presetNotes(preset, d.provider.transport);
    const keyDisabled = d.provider.transport === 'backend';
    const volume = h('input', {
      id: 'aw-set-volume',
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(d.audio.volume),
      oninput: (e: Event) => this.set((s) => (s.audio.volume = Number((e.target as HTMLInputElement).value))),
    });
    const speed = h('input', {
      id: 'aw-set-speed',
      type: 'range',
      min: '0.5',
      max: '3',
      step: '0.25',
      value: String(d.animationSpeed),
      oninput: (e: Event) => {
        this.set((s) => (s.animationSpeed = Number((e.target as HTMLInputElement).value)));
        speedOut.textContent = `${d.animationSpeed}×`;
      },
    });
    const speedOut = h('output', { class: 'aw-range-out' }, `${d.animationSpeed}×`);
    const langPick = languagePicker(this.lang, this.cb.onLanguage ? (c) => this.cb.onLanguage?.(c) : undefined, 'aw-set-lang');

    setChildren(
      this.modal.card,
      h('header', { class: 'aw-panel-head' }, h('h2', null, t('settings.title')), h('button', { type: 'button', class: 'aw-icon-btn', 'aria-label': t('settings.closeAria'), onclick: () => this.cb.onOpenSettings?.(false) }, icon(ICONS.close))),
      h(
        'form',
        {
          class: 'aw-settings-form',
          onsubmit: (e: Event) => {
            e.preventDefault();
            if (this.draft) this.cb.onSettings?.(structuredClone(this.draft));
            this.cb.onOpenSettings?.(false);
          },
        },
        langPick
          ? h('fieldset', null, h('legend', null, t('settings.language')), h('div', { class: 'aw-field' }, h('label', { for: 'aw-set-lang' }, t('settings.languageLabel')), langPick))
          : null,
        h(
          'fieldset',
          null,
          h('legend', null, t('settings.provider')),
          field(t('settings.providerLabel'), 'aw-set-preset', presetSel, h('ul', { class: 'aw-notes-list' }, notes.map((n) => h('li', { class: n.warn ? 'is-warn' : undefined }, n.text)))),
          d.provider.preset === 'custom'
            ? field(
                t('settings.baseUrl'),
                'aw-set-baseurl',
                h('input', {
                  id: 'aw-set-baseurl',
                  type: 'url',
                  class: 'aw-input',
                  value: d.provider.baseUrl ?? '',
                  placeholder: 'http://localhost:11434/v1',
                  oninput: (e: Event) => this.set((s) => (s.provider.baseUrl = (e.target as HTMLInputElement).value)),
                }),
              )
            : null,
          field(t('settings.model'), 'aw-set-model', modelInput),
          h('div', { class: 'aw-field' }, h('span', { class: 'aw-field-label' }, t('settings.transport')), transportRadios),
          field(
            t('settings.apiKey'),
            'aw-set-key',
            h('input', {
              id: 'aw-set-key',
              type: 'password',
              class: 'aw-input',
              autocomplete: 'off',
              spellcheck: 'false',
              disabled: keyDisabled,
              value: d.provider.apiKey ?? '',
              placeholder: keyDisabled ? t('settings.keyServer') : preset && !preset.needsKey ? t('settings.keyNotNeeded') : 'sk-…',
              oninput: (e: Event) => this.set((s) => (s.provider.apiKey = (e.target as HTMLInputElement).value || undefined)),
            }),
            t('settings.keyHint'),
          ),
        ),
        h(
          'fieldset',
          null,
          h('legend', null, t('settings.audioMotion')),
          h('div', { class: 'aw-field aw-field-row' }, h('label', { for: 'aw-set-volume' }, t('settings.volume')), volume),
          h(
            'label',
            { class: 'aw-check' },
            h('input', { type: 'checkbox', id: 'aw-set-mute', checked: d.audio.muted, onchange: (e: Event) => this.set((s) => (s.audio.muted = (e.target as HTMLInputElement).checked)) }),
            t('settings.mute'),
          ),
          h('div', { class: 'aw-field aw-field-row' }, h('label', { for: 'aw-set-speed' }, t('settings.animSpeed')), speed, speedOut),
          h(
            'label',
            { class: 'aw-check' },
            h('input', { type: 'checkbox', id: 'aw-set-reduce', checked: d.reduceMotion, onchange: (e: Event) => this.set((s) => (s.reduceMotion = (e.target as HTMLInputElement).checked)) }),
            t('settings.reduceMotion'),
          ),
        ),
        h(
          'footer',
          { class: 'aw-dlg-foot' },
          h('button', { type: 'button', class: 'aw-btn aw-btn-ghost', onclick: () => this.cb.onOpenSettings?.(false) }, t('common.cancel')),
          h('button', { type: 'submit', class: 'aw-btn aw-btn-primary' }, t('common.save')),
        ),
      ),
    );
    if (focus) this.modal.focusFirst();
    else if (activeId) document.getElementById(activeId)?.focus({ preventScroll: true });
  }
}
