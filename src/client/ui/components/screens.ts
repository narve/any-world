/** Full-screen views: start, loading, end; and the settings dialog. */
import type { Vocabulary } from '../../../schema/world';
import type { EndView, InspirationPrompt, LoadingView, RecentWorldView, RoomView, Settings, SettingsView, StartOptions, StartView, UiCallbacks, UiViewModel } from '../viewmodel';
import { dataKey, h, icon, ICONS, setChildren } from '../dom';
import { baseLang, clamp, DIFFICULTIES, difficultyHint, difficultyLabel, groupByLanguage, languageEndonym, pickInspiration, presetNotes, runStatLines, toDifficulty, weirdnessLabel } from '../format';
import { Modal } from './modals';
import { RoomsCard } from './rooms';
import { getLanguage, t } from '../../i18n/index';
import { tagLabel } from '../../i18n/tags';
import '../../styles/shell.css';

/** icons only the shell screens use (24×24 strokes, like dom.ts ICONS) */
const SHELL_ICONS = {
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  upload: ['M12 20V9', 'M7 14l5-5 5 5', 'M5 4h14'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  ok: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M8 12l3 3 5-6'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 11v6', 'M12 7h.01'],
  person: ICONS.person,
  people: ICONS.people,
} as const;

/** how many theme tags the inspiration filter offers */
const TAG_CHIPS = 8;
/** "For a party" without a room to size it: a world for this many players */
const DEFAULT_PARTY = 4;

/** the language and theme filter of the inspiration cards; 'all' / null = no filter */
export interface InspirationFilter {
  language: string;
  tag: string | null;
}

/** prompts that pass the filter (pure; exported for tests) */
export function filterInspiration<T extends Pick<InspirationPrompt, 'language' | 'tags'>>(list: readonly T[], f: InspirationFilter): T[] {
  return list.filter((p) => (f.language === 'all' || baseLang(p.language) === f.language) && (!f.tag || (p.tags ?? []).includes(f.tag)));
}

/** the most common tags (ties alphabetical), for the filter chips (pure; exported for tests) */
export function topTags(list: readonly Pick<InspirationPrompt, 'tags'>[], n: number): string[] {
  const count = new Map<string, number>();
  for (const p of list) for (const tag of new Set(p.tags ?? [])) count.set(tag, (count.get(tag) ?? 0) + 1);
  return [...count.entries()]
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([tag]) => tag);
}

type LanguageVm = UiViewModel['language'];

/** a language <select>; null while there is only one language */
export function languagePicker(lang: LanguageVm, onPick: ((code: string) => void) | undefined, id: string): HTMLElement | null {
  if (!lang || lang.options.length < 2 || !onPick) return null;
  return h(
    'select',
    { id, class: 'aw-lang-select', 'aria-label': t('settings.language'), dataset: { tip: t('settings.language') }, onchange: (e: Event) => onPick((e.target as HTMLSelectElement).value) },
    lang.options.map((o) => h('option', { value: o.code, selected: o.code === lang.current }, o.name)),
  );
}

/**
 * how a kept world got here: AI-made, opened from a file, or picked from the recorded demo worlds by
 * the offline demo generator (no AI involved, so it must not say "made by AI")
 */
export function recentSourceLabel(source: RecentWorldView['source']): string {
  return source === 'imported' ? t('start.recentImported') : source === 'demo' ? t('start.recentDemo') : t('start.recentGenerated');
}

const CARD_COUNT = 4;

/** this browser keeps "Bring your own AI" open once the player opened it ('1') or shut it ('0') */
export const BYO_KEY = 'anyworld.byo';

function storedByo(): boolean | null {
  try {
    const v = globalThis.localStorage?.getItem(BYO_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

/** the offline demo generator's preset id (modes.ts OFFLINE_PRESET) */
const OFFLINE_PRESET_ID = 'mock';

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
  private party: HTMLInputElement;
  private partyEl: HTMLElement;
  private partySize = DEFAULT_PARTY;
  private partyDefault: number | undefined;
  private cardsEl: HTMLElement;
  private noteEl: HTMLElement;
  /** the start page's blocks that change with the view: saved run, featured world, worlds, own worlds */
  private savedEl: HTMLElement;
  private featuredEl: HTMLElement;
  private demosEl: HTMLElement;
  private legendEl: HTMLElement;
  private recentEl: HTMLElement;
  /** the hero row: featured world beside "Play together" */
  private heroEl: HTMLElement;
  /** "Bring your own AI": everything that needs an AI provider (key or access code), folded away */
  private byoBtn: HTMLButtonElement;
  /** what creating a world needs: nothing on a server with AI, a key in Settings without one */
  private byoSubEl: HTMLElement;
  private byoBody: HTMLElement;
  /** null until the player (or the first view) decides */
  private byoOpen: boolean | null = null;
  /** the player folded or opened it (now or on an earlier visit): no more automatic choices */
  private byoChosen = false;
  private view: StartView | null = null;
  private listKey = '';
  private cards: InspirationPrompt[] = [];
  private initialised = false;
  private langEl: HTMLElement;
  private langKey = '';
  /** the inspiration card last copied into the prompt box (its language goes with it while unedited) */
  private filled: { prompt: string; language: string } | null = null;
  private filter: InspirationFilter = { language: 'all', tag: null };
  private filterEl: HTMLElement;
  private fileInput: HTMLInputElement;
  /** MP3: the "Play together" card (kept across re-renders: its code field keeps what was typed) */
  private rooms: RoomsCard;

  constructor(private cb: UiCallbacks, private rand: () => number = Math.random) {
    this.rooms = new RoomsCard((i) => this.cb.onRoom?.(i));
    this.langEl = h('div', { class: 'aw-start-lang' });
    this.textarea = h('textarea', {
      id: 'aw-prompt',
      class: 'aw-textarea',
      rows: '3',
      maxlength: '500',
      placeholder: t('start.placeholder'),
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
    this.party = h('input', { id: 'aw-party', type: 'checkbox' });
    this.partyEl = h('label', { class: 'aw-check aw-start-party', for: 'aw-party', hidden: true }, this.party, h('span', null, t('start.forParty')), h('span', { class: 'aw-muted' }, t('start.forPartyHint')));
    this.weird = h('input', { id: 'aw-weird', type: 'range', min: '0', max: '1', step: '0.05', value: '0.4', oninput: () => this.syncOut() });
    this.cardsEl = h('div', { class: 'aw-insp-cards' });
    this.filterEl = h('div', { class: 'aw-insp-filters' });
    this.fileInput = h('input', {
      type: 'file',
      id: 'aw-import-file',
      class: 'aw-sr',
      accept: '.json,application/json',
      tabindex: '-1',
      'aria-hidden': 'true',
      onchange: () => void this.readImport(),
    });
    this.noteEl = h('p', { class: 'aw-start-note' });
    this.savedEl = h('div', { class: 'aw-start-saved' });
    this.featuredEl = h('div', { class: 'aw-featured-host' });
    this.heroEl = h('div', { class: 'aw-start-hero' }, this.featuredEl);
    this.demosEl = h('div', { class: 'aw-demos-body' });
    this.legendEl = h('p', { class: 'aw-demos-legend aw-small', hidden: true });
    this.recentEl = h('div', { class: 'aw-start-recent' });
    this.byoBody = h(
      'div',
      { class: 'aw-byo-body', id: 'aw-byo-body', hidden: true },
      h('label', { class: 'aw-label', for: 'aw-prompt' }, t('start.promptLabel')),
      this.textarea,
      h('label', { class: 'aw-range', for: 'aw-weird' }, h('span', null, t('start.weirdness')), this.weird, this.weirdOut),
      this.partyEl,
      h(
        'div',
        { class: 'aw-start-actions' },
        h('button', { type: 'button', class: 'aw-btn aw-btn-primary aw-btn-lg', dataset: { tip: t('start.createTip') }, onclick: () => this.create(false) }, icon(ICONS.play), t('start.create')),
        h('button', { type: 'button', class: 'aw-btn aw-btn-lg', dataset: { tip: t('start.surpriseTip') }, onclick: () => this.create(true) }, icon(ICONS.sparkle), t('start.surprise')),
      ),
      this.noteEl,
      h(
        'section',
        { class: 'aw-insp' },
        h(
          'div',
          { class: 'aw-insp-head' },
          h('h3', null, t('start.inspiration')),
          h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-btn-ghost', onclick: () => this.shuffle(), 'aria-label': t('start.shuffleAria'), dataset: { tip: t('start.shuffleAria') } }, icon(ICONS.shuffle), t('start.shuffle')),
        ),
        this.filterEl,
        this.cardsEl,
      ),
    );
    this.byoBtn = h(
      'button',
      { type: 'button', class: 'aw-btn aw-byo-toggle', 'aria-expanded': 'false', 'aria-controls': 'aw-byo-body', dataset: { tip: t('start.byoTip') }, onclick: () => this.setByo(!this.byoOpen, true) },
      icon(ICONS.sparkle),
      h('span', null, t('start.byo')),
    ) as HTMLButtonElement;
    this.byoSubEl = h('p', { class: 'aw-muted aw-small' }, t('start.byoSub'));

    this.el = h(
      'main',
      { class: 'aw-screen aw-start', 'aria-label': t('start.label') },
      h(
        'div',
        { class: 'aw-start-inner' },
        h(
          'header',
          { class: 'aw-brand' },
          h('h1', { class: 'aw-logo' }, 'Any', h('span', null, 'World')),
          h('p', { class: 'aw-brand-sub' }, t('start.tagline')),
          h(
            'div',
            { class: 'aw-brand-tools' },
            this.langEl,
            h('button', { type: 'button', class: 'aw-icon-btn aw-start-settings', 'aria-label': t('settings.title'), dataset: { tip: t('settings.title') }, onclick: () => this.cb.onOpenSettings?.(true) }, icon(ICONS.gear)),
          ),
        ),
        h(
          'section',
          { class: 'aw-about', 'aria-labelledby': 'aw-about-title' },
          h('h2', { id: 'aw-about-title', class: 'aw-sr' }, t('start.aboutTitle')),
          h('p', { class: 'aw-about-lead' }, t('start.about')),
          h(
            'ul',
            { class: 'aw-about-points' },
            (['start.about1', 'start.about2', 'start.about3', 'start.about4'] as const).map((k) => h('li', null, t(k))),
          ),
        ),
        this.savedEl,
        this.heroEl,
        // right under the featured worlds, so inventing a world is not buried below every demo
        h(
          'section',
          { class: 'aw-byo', 'aria-labelledby': 'aw-byo-title' },
          h('div', { class: 'aw-byo-head' }, h('div', null, h('h2', { id: 'aw-byo-title' }, t('start.byoTitle')), this.byoSubEl)),
          this.byoBody,
          // bottom right, under the form when it is open
          h('div', { class: 'aw-byo-foot' }, this.byoBtn),
        ),
        h(
          'section',
          { class: 'aw-demos', 'aria-labelledby': 'aw-demos-title' },
          h('div', { class: 'aw-demos-head' }, h('h2', { id: 'aw-demos-title' }, t('start.demos')), h('p', { class: 'aw-muted aw-small' }, t('start.demosSub')), this.legendEl),
          h('div', { class: 'aw-start-difficulty' }, h('label', { class: 'aw-range', for: 'aw-diff' }, h('span', null, t('start.difficulty')), this.diff, this.diffOut), this.diffHint),
          this.demosEl,
        ),
        this.recentEl,
        h('p', { class: 'aw-start-foot' }, h('a', { href: 'tech.html', class: 'aw-start-tech' }, t('start.techNotes'))),
      ),
      this.fileInput,
    );
    this.syncOut();
    // shown again (after a run, "New world", "Back"): open at the top with the prompt box in view,
    // not where the last demo card was clicked (ui.ts toggles `hidden`; focus uses preventScroll)
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => {
        if (!this.el.hidden) this.resetScroll();
      }).observe(this.el, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  /** scrolls the start screen (and its inner columns, which scroll on their own on some layouts) to the top */
  resetScroll(): void {
    for (const el of [this.el, ...this.el.querySelectorAll<HTMLElement>('.aw-start-inner, .aw-start-main, .aw-start-side')]) {
      if (el.scrollTop) el.scrollTop = 0;
      if (el.scrollLeft) el.scrollLeft = 0;
    }
  }

  /** fold "Bring your own AI" open or shut; `user`: the player clicked (moves focus into it) */
  setByo(open: boolean, user = false): void {
    this.byoOpen = open;
    if (user) this.byoChosen = true;
    this.byoBody.hidden = !open;
    this.byoBtn.setAttribute('aria-expanded', String(open));
    this.byoBtn.classList.toggle('is-open', open);
    this.byoBtn.lastElementChild!.textContent = open ? t('start.byoHide') : t('start.byo');
    if (user) {
      try {
        globalThis.localStorage?.setItem(BYO_KEY, open ? '1' : '0');
      } catch {
        /* private mode: open for this page only */
      }
    }
    if (open && user) {
      this.textarea.focus({ preventScroll: true });
      this.byoBody.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    }
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
      ...(this.party.checked && !this.partyEl.hidden ? { party: this.partySize } : {}),
    };
  }

  private create(surprise: boolean): void {
    if (!this.byoOpen) this.setByo(true);
    // with no AI, "Surprise me" still works: the app plays a random demo world (main.ts onStart)
    if (!surprise && this.view && !this.view.canGenerate) {
      this.cb.onOpenSettings?.(true);
      return;
    }
    this.cb.onStart?.(this.options(surprise));
  }

  shuffle(): void {
    if (!this.view) return;
    this.cards = pickInspiration(filterInspiration(this.view.prompts, this.filter), CARD_COUNT, getLanguage(), this.rand);
    this.renderCards();
  }

  private setFilter(f: Partial<InspirationFilter>): void {
    this.filter = { ...this.filter, ...f };
    this.renderFilters();
    this.shuffle();
  }

  /** language select + theme chips over the inspiration cards */
  private renderFilters(): void {
    const prompts = this.view?.prompts ?? [];
    const langs = [...new Set(prompts.map((p) => baseLang(p.language)))].sort();
    const inLang = filterInspiration(prompts, { language: this.filter.language, tag: null });
    const tags = topTags(inLang, TAG_CHIPS);
    if (this.filter.tag && !tags.includes(this.filter.tag)) tags.push(this.filter.tag);
    setChildren(
      this.filterEl,
      langs.length > 1
        ? h(
            'select',
            {
              id: 'aw-insp-lang',
              class: 'aw-insp-lang',
              'aria-label': t('start.filterLanguage'),
              onchange: (e: Event) => this.setFilter({ language: (e.target as HTMLSelectElement).value }),
            },
            h('option', { value: 'all', selected: this.filter.language === 'all' }, t('start.filterAllLanguages')),
            langs.map((l) => h('option', { value: l, selected: this.filter.language === l, lang: l }, languageEndonym(l))),
          )
        : null,
      tags.length
        ? h(
            'div',
            { class: 'aw-insp-tags', role: 'group', 'aria-label': t('start.filterTags') },
            tags.map((tag) =>
              h(
                'button',
                {
                  type: 'button',
                  class: ['aw-tag-chip', this.filter.tag === tag && 'is-on'],
                  'aria-pressed': String(this.filter.tag === tag),
                  dataset: { tag },
                  onclick: () => this.setFilter({ tag: this.filter.tag === tag ? null : tag }),
                },
                tagLabel(tag, getLanguage()),
              ),
            ),
          )
        : null,
    );
  }

  private renderCards(): void {
    const ui = baseLang(getLanguage());
    if (!this.cards.length) {
      setChildren(
        this.cardsEl,
        h(
          'p',
          { class: 'aw-insp-empty aw-muted' },
          t('start.noMatches'),
          ' ',
          h('button', { type: 'button', class: 'aw-link', onclick: () => this.setFilter({ language: 'all', tag: null }) }, t('start.clearFilter')),
        ),
      );
      return;
    }
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
              dataset: { tip: t('start.usePromptTip') },
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
          p.worldId ? h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-insp-demo', dataset: { tip: t('start.playDemoTip') }, onclick: () => this.cb.onPlayDemo?.(p.worldId!, this.options(false)) }, icon(ICONS.play), t('start.playDemo')) : null,
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
    // "For a party": only with a game server (off by default; on for a room's world, sized to its maxPlayers)
    this.partyEl.hidden = !v.rooms;
    if (v.defaults?.party !== undefined && v.defaults.party !== this.partyDefault) {
      this.partyDefault = v.defaults.party;
      this.party.checked = true;
    }
    this.partySize = Math.min(12, Math.max(2, v.defaults?.party ?? DEFAULT_PARTY));
    if (v.rooms) this.rooms.update(v.rooms);
    // open at first as this browser left it; else for a player whose own AI already works, or when a
    // prompt or party was handed over
    this.byoSubEl.textContent = t(v.providerLabel ? 'start.byoSub' : 'start.byoSubNoAi');
    // until the player chooses, follow the provider: the first render comes before the server has
    // said it can create worlds, so a one-time choice there kept the section folded for everyone
    const stored = this.byoChosen ? null : storedByo();
    if (stored !== null) {
      this.byoChosen = true;
      this.setByo(stored);
    } else if (!this.byoChosen) {
      const auto = (v.canGenerate && v.providerStatus?.tone === 'ok') || !!v.defaults?.prompt || v.defaults?.party !== undefined;
      if (auto !== this.byoOpen) this.setByo(auto);
    }
    const key = dataKey([v.prompts, v.demos, v.savedRun, v.providerLabel, v.canGenerate, v.providerStatus, v.recent, v.canImport, v.rooms ? v.rooms.status : null]);
    if (key === this.listKey) return;
    const promptsChanged = dataKey(v.prompts) !== dataKey(JSON.parse(this.listKey || '[[]]')[0]);
    this.listKey = key;
    if (promptsChanged || !this.cards.length) {
      this.renderFilters();
      this.shuffle();
    }

    this.noteEl.textContent = '';
    delete this.noteEl.dataset.tone;
    if (v.providerStatus) {
      const st = v.providerStatus;
      this.noteEl.dataset.tone = st.tone;
      this.noteEl.append(
        icon(st.tone === 'ok' ? SHELL_ICONS.ok : st.tone === 'warn' ? ICONS.alert : SHELL_ICONS.info),
        h('span', { class: 'aw-status-text' }, st.text),
        ...(st.detail ? [h('span', { class: 'aw-status-detail aw-muted' }, st.detail)] : []),
        h('button', { type: 'button', class: 'aw-link', onclick: () => this.cb.onOpenSettings?.(true) }, v.canGenerate ? t('start.change') : t('start.openSettings')),
      );
    } else if (!v.canGenerate) {
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

    const featured = (v.featured ?? []).map((id) => v.demos.find((d) => d.id === id)).filter((d): d is StartView['demos'][number] => !!d);
    setChildren(
      this.savedEl,
      v.savedRun
        ? h(
            'section',
            { class: 'aw-saved' },
            h('h2', null, t('start.continue')),
            h(
              'button',
              { type: 'button', class: 'aw-saved-card', dataset: { tip: t('start.continueTip') }, onclick: () => this.cb.onContinue?.() },
              h('span', { class: 'aw-saved-title' }, v.savedRun.worldTitle),
              h('span', { class: 'aw-saved-sub' }, t('start.savedSub', { player: v.savedRun.playerName, area: v.savedRun.areaName, turn: v.savedRun.turn })),
            ),
          )
        : null,
    );
    setChildren(this.featuredEl, featured.map((d, i) => this.featuredCard(v, d, i)));
    // several featured worlds: compact cards, stacked beside "Play together"
    this.featuredEl.classList.toggle('is-multi', featured.length > 1);
    this.featuredEl.hidden = !featured.length;
    this.heroEl.classList.toggle('has-rooms', !!v.rooms);
    if (v.rooms && this.rooms.el.parentElement !== this.heroEl) this.heroEl.append(this.rooms.el);
    else if (!v.rooms) this.rooms.el.remove();
    const rest = featured.length ? { ...v, demos: v.demos.filter((d) => !featured.includes(d)) } : v;
    setChildren(this.demosEl, rest.demos.length ? this.demoGroups(rest) : h('p', { class: 'aw-muted' }, t('start.noDemos')));
    // with a game server every card has a "play with friends" corner button: say which tap is which
    const party = v.rooms?.status === 'ok';
    this.legendEl.hidden = !party;
    setChildren(
      this.legendEl,
      party
        ? [
            h('span', { class: 'aw-legend-item' }, icon(SHELL_ICONS.person), t('start.legendSolo')),
            h('span', { class: 'aw-legend-item' }, h('span', { class: 'aw-legend-friends', 'aria-hidden': 'true' }, icon(SHELL_ICONS.people)), t('start.legendParty')),
          ]
        : [],
    );
    setChildren(this.recentEl, v.recent?.length || v.canImport ? this.recentSection(v) : null);
  }

  /** a featured world (StartView.featured): a big card at the top of the page */
  private featuredCard(v: StartView, d: StartView['demos'][number], i: number): HTMLElement {
    const lang = baseLang(d.language);
    const titleId = `aw-featured-title-${i}`;
    return h(
      'section',
      { class: 'aw-featured', lang, style: { '--demo': d.color ?? 'var(--c-accent)' }, 'aria-labelledby': titleId },
      h(
        'span',
        { class: 'aw-featured-kicker' },
        h('span', { lang: baseLang(getLanguage()) }, t('start.featured')),
        ' · ',
        d.genre,
        lang !== baseLang(getLanguage()) ? h('span', { class: 'aw-lang-badge', title: t('start.worldLanguage', { language: languageEndonym(d.language) }) }, lang.toUpperCase()) : null,
      ),
      h('h2', { id: titleId, class: 'aw-featured-title' }, d.title),
      h('p', { class: 'aw-featured-tag' }, d.tagline),
      h(
        'div',
        { class: 'aw-featured-actions', lang: baseLang(getLanguage()) },
        h('button', { type: 'button', class: 'aw-btn aw-btn-primary aw-btn-lg aw-featured-play', dataset: { world: d.id, tip: t('start.soloTip', { title: d.title }) }, onclick: () => this.cb.onPlayDemo?.(d.id, this.options(false)) }, icon(ICONS.play), t('start.featuredPlay')),
        this.friendsButton(v, d.id, d.title),
      ),
    );
  }

  /** worlds kept in this browser (AI-made or imported): play, save as a file, forget; plus import */
  private recentSection(v: StartView): HTMLElement {
    const recent = v.recent ?? [];
    const ui = baseLang(getLanguage());
    const item = (w: RecentWorldView) =>
      h(
        'li',
        { class: 'aw-recent-item' },
        h(
          'button',
          {
            type: 'button',
            class: 'aw-recent-play',
            lang: baseLang(w.language),
            dataset: { world: w.id, tip: t('start.soloTip', { title: w.title }) },
            style: { '--demo': w.color ?? 'var(--c-accent)' },
            onclick: () => this.cb.onPlayDemo?.(w.id, this.options(false)),
          },
          h(
            'span',
            { class: 'aw-demo-genre' },
            w.genre,
            ' · ',
            recentSourceLabel(w.source),
            baseLang(w.language) !== ui ? h('span', { class: 'aw-lang-badge' }, baseLang(w.language).toUpperCase()) : null,
          ),
          h('span', { class: 'aw-demo-title' }, w.title),
          h('span', { class: 'aw-demo-tag' }, w.tagline),
        ),
        h(
          'div',
          { class: 'aw-recent-tools' },
          this.friendsButton(v, w.id, w.title),
          this.cb.onExportWorld
            ? h(
                'button',
                { type: 'button', class: 'aw-icon-btn aw-recent-export', 'aria-label': t('start.exportAria', { title: w.title }), dataset: { tip: t('start.export') }, onclick: () => this.cb.onExportWorld?.(w.id) },
                icon(SHELL_ICONS.download),
              )
            : null,
          this.cb.onForgetWorld
            ? h(
                'button',
                { type: 'button', class: 'aw-icon-btn aw-recent-forget', 'aria-label': t('start.forgetAria', { title: w.title }), dataset: { tip: t('start.forget') }, onclick: () => this.cb.onForgetWorld?.(w.id) },
                icon(SHELL_ICONS.trash),
              )
            : null,
        ),
      );
    return h(
      'section',
      { class: 'aw-recent' },
      h(
        'div',
        { class: 'aw-recent-head' },
        h('h2', null, t('start.recent')),
        v.canImport
          ? h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-btn-ghost aw-import-btn', dataset: { tip: t('start.importTip') }, onclick: () => this.fileInput.click() }, icon(SHELL_ICONS.upload), t('start.import'))
          : null,
      ),
      h('p', { class: 'aw-muted aw-small' }, recent.length ? t('start.recentSub') : t('start.importHint')),
      recent.length ? h('ul', { class: 'aw-demo-list aw-recent-list' }, recent.map(item)) : null,
    );
  }

  /** MP3: "Play with friends" on a world card: a room on that world with the default options */
  private friendsButton(v: StartView, worldId: string, title: string): HTMLElement | null {
    if (v.rooms?.status !== 'ok') return null;
    return h(
      'button',
      { type: 'button', class: 'aw-btn aw-btn-small aw-btn-ghost aw-friends', dataset: { friends: worldId, tip: t('start.partyTip', { title }) }, 'aria-label': `${t('lobby.playWithFriends')}: ${title}`, onclick: () => this.cb.onRoom?.({ type: 'create', worldId }) },
      icon(SHELL_ICONS.people),
      h('span', { class: 'aw-friends-label' }, t('lobby.playWithFriends')),
    );
  }

  private async readImport(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      text = '';
    }
    this.cb.onImportWorld?.({ name: file.name, text });
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
            { class: v.rooms?.status === 'ok' ? 'aw-demo-item has-friends' : undefined },
            h(
              'button',
              { type: 'button', class: 'aw-demo', lang: baseLang(d.language), dataset: { world: d.id, tip: t('start.soloTip', { title: d.title }) }, style: { '--demo': d.color ?? 'var(--c-primary)' }, onclick: () => this.cb.onPlayDemo?.(d.id, this.options(false)) },
              h('span', { class: 'aw-demo-genre' }, d.genre),
              h('span', { class: 'aw-demo-title' }, d.title),
              h('span', { class: 'aw-demo-tag' }, d.tagline),
            ),
            this.friendsButton(v, d.id, d.title),
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

  private roomBlock(room: RoomView): HTMLElement {
    return roomEndBlock(room, this.cb);
  }

  update(v: EndView, vocab: Vocabulary, room?: RoomView | null): void {
    const key = dataKey([v, vocab, room ?? null]);
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
      room
        ? this.roomBlock(room)
        : h(
            'div',
            { class: 'aw-end-actions' },
            h('button', { type: 'button', class: 'aw-btn aw-btn-primary aw-btn-lg', 'data-autofocus': true, onclick: () => this.cb.onEnd?.('new_world') }, t('end.newWorld')),
            h('button', { type: 'button', class: 'aw-btn aw-btn-lg', onclick: () => this.cb.onEnd?.('same_world') }, t('end.sameWorld')),
          ),
    );
    queueMicrotask(() => this.body.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true }));
  }
}

/** MP3: the end screen in a room: play again in the same room (host), ready, leave */
function roomEndBlock(room: RoomView, cb: UiCallbacks): HTMLElement {
  const go = (i: Parameters<NonNullable<UiCallbacks['onRoom']>>[0]) => cb.onRoom?.(i);
  return h(
    'div',
    { class: 'aw-end-room', dataset: { code: room.code } },
    h(
      'div',
      { class: 'aw-end-actions' },
      room.host ? h('button', { type: 'button', class: 'aw-btn aw-btn-primary aw-btn-lg aw-end-again', 'data-autofocus': true, onclick: () => go({ type: 'start' }) }, icon(ICONS.play), t('lobby.playAgain')) : null,
      room.host ? h('button', { type: 'button', class: 'aw-btn aw-btn-lg aw-end-another', onclick: () => go({ type: 'pick_world', open: true }) }, t('lobby.anotherWorld')) : null,
      h(
        'button',
        { type: 'button', class: ['aw-btn', 'aw-btn-lg', 'aw-lobby-ready', room.ready && 'is-on'], 'aria-pressed': String(room.ready), 'data-autofocus': room.host ? undefined : true, onclick: () => go({ type: 'ready', on: !room.ready }) },
        room.ready ? icon(ICONS.check) : null,
        t('lobby.ready'),
      ),
      h('button', { type: 'button', class: 'aw-btn aw-btn-ghost aw-btn-lg aw-end-leave', onclick: () => go({ type: 'leave' }) }, t('room.leave')),
    ),
    h('p', { class: 'aw-muted aw-small' }, room.host ? t('lobby.readyCount', { ready: room.readyCount, total: room.total }) : `${t('lobby.waitingHost')} · ${t('lobby.readyCount', { ready: room.readyCount, total: room.total })}`),
  );
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
    const offline = d.provider.preset === OFFLINE_PRESET_ID;
    // the world's music panel (mood, SoundCloud links / player) is filled in by the app
    const musicHost = v.music ? h('div', { class: 'aw-music-host', id: 'aw-set-music' }) : null;
    const preset = v.presets.find((p) => p.id === d.provider.preset);
    const transports = v.transports ?? ['direct', 'backend'];
    const field = (label: string, id: string, input: HTMLElement, hint?: Node | string | null) =>
      h('div', { class: 'aw-field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'aw-field-hint' }, hint) : null);
    const check = (id: string, checked: boolean, label: string, onChange: (on: boolean) => void, hint?: string) =>
      h(
        'div',
        { class: 'aw-field' },
        h('label', { class: 'aw-check' }, h('input', { type: 'checkbox', id, checked, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }), label),
        hint ? h('div', { class: 'aw-field-hint' }, hint) : null,
      );

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
            s.provider.model = p?.defaultModel ?? (id === OFFLINE_PRESET_ID ? undefined : s.provider.model);
            if (p || id === OFFLINE_PRESET_ID) s.provider.baseUrl = undefined;
            if (id === OFFLINE_PRESET_ID) s.provider.transport = transports.includes('direct') ? 'direct' : s.provider.transport;
            if (p && !p.cors && transports.includes('backend')) s.provider.transport = 'backend';
          }, true),
      },
      v.offlineDemo ? h('option', { value: OFFLINE_PRESET_ID, selected: offline }, t('settings.mockPreset')) : null,
      v.presets.map((p) => h('option', { value: p.id, selected: p.id === d.provider.preset }, `${p.label} — ${p.region}`)),
      v.presets.some((p) => p.id === 'custom') ? null : h('option', { value: 'custom', selected: d.provider.preset === 'custom' }, t('settings.custom')),
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
    const notes = offline ? [{ text: t('settings.note.mock'), warn: false }] : presetNotes(preset, d.provider.transport);
    const backend = d.provider.transport === 'backend';
    const serverLine =
      backend && !offline && v.serverPresets !== undefined
        ? h(
            'p',
            { class: ['aw-server-line', v.serverPresets === null && 'is-warn'], id: 'aw-set-server' },
            v.serverPresets === null
              ? t('settings.server.unreachable')
              : v.serverPresets.filter((id) => id !== OFFLINE_PRESET_ID).length
                ? t('settings.server.has', { list: v.serverPresets.filter((id) => id !== OFFLINE_PRESET_ID).map((id) => v.presets.find((p) => p.id === id)?.label ?? id).join(', ') })
                : t('settings.server.none'),
          )
        : null;
    const keyNeeded = !backend && !offline && (preset ? preset.needsKey : true);
    const keyInput = h('input', {
      id: 'aw-set-key',
      type: 'password',
      class: 'aw-input',
      autocomplete: 'off',
      spellcheck: 'false',
      disabled: backend,
      value: backend ? '' : (d.provider.apiKey ?? ''),
      placeholder: backend ? t('settings.keyServer') : preset && !preset.needsKey ? t('settings.keyNotNeeded') : 'sk-…',
      oninput: (e: Event) => this.set((s) => (s.provider.apiKey = (e.target as HTMLInputElement).value || undefined)),
    });
    const keyWarn = !backend && !offline ? h('div', { class: 'aw-key-warn', role: 'note', id: 'aw-set-keywarn' }, icon(ICONS.alert), h('span', null, t('settings.keyWarnDirect'))) : null;
    const keyRow = h(
      'div',
      { class: 'aw-key-row' },
      keyInput,
      !backend && d.provider.apiKey
        ? h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-btn-ghost', id: 'aw-set-clearkey', onclick: () => this.set((s) => delete s.provider.apiKey, true) }, t('settings.clearKey'))
        : null,
    );
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
    const quality = h(
      'select',
      { id: 'aw-set-quality', onchange: (e: Event) => this.set((s) => (s.quality = (e.target as HTMLSelectElement).value as Settings['quality'])) },
      (['auto', 'low', 'high'] as const).map((q) => h('option', { value: q, selected: (d.quality ?? 'auto') === q }, t(`settings.quality.${q}` as const))),
    );
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
          !offline && d.provider.preset === 'custom'
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
          offline ? null : field(t('settings.model'), 'aw-set-model', modelInput),
          offline ? null : h('div', { class: 'aw-field' }, h('span', { class: 'aw-field-label' }, t('settings.transport')), transportRadios, serverLine),
          offline ? null : field(keyNeeded ? t('settings.apiKey') : t('settings.apiKeyOptional'), 'aw-set-key', keyRow, keyWarn),
          !offline && backend
            ? field(
                t('settings.accessCode'),
                'aw-set-code',
                h('input', {
                  id: 'aw-set-code',
                  type: 'password',
                  class: ['aw-input', v.codeRequired && !d.accessCode && 'is-needed'],
                  autocomplete: 'off',
                  spellcheck: 'false',
                  maxlength: '200',
                  value: d.accessCode ?? '',
                  oninput: (e: Event) => this.set((s) => (s.accessCode = (e.target as HTMLInputElement).value.trim() || undefined)),
                }),
                t('settings.accessCodeHint'),
              )
            : null,
          check('aw-set-gm', d.gm !== false, t('settings.gm'), (on) => this.set((s) => (s.gm = on)), t('settings.gmHint')),
        ),
        h(
          'fieldset',
          null,
          h('legend', null, t('settings.audio')),
          h('div', { class: 'aw-field aw-field-row' }, h('label', { for: 'aw-set-volume' }, t('settings.volume')), volume),
          check('aw-set-mute', d.audio.muted, t('settings.mute'), (on) => this.set((s) => (s.audio.muted = on))),
          check('aw-set-music', d.audio.music !== false, t('settings.music'), (on) => this.set((s) => (s.audio.music = on)), t('settings.musicHint')),
          check('aw-set-soundcloud', !!d.audio.soundcloud, t('settings.soundcloud'), (on) => this.set((s) => (s.audio.soundcloud = on)), t('settings.soundcloudHint')),
          musicHost,
        ),
        h(
          'fieldset',
          null,
          h('legend', null, t('settings.display')),
          field(t('settings.quality'), 'aw-set-quality', quality, t('settings.qualityHint')),
          h('div', { class: 'aw-field aw-field-row' }, h('label', { for: 'aw-set-speed' }, t('settings.animSpeed')), speed, speedOut),
          check('aw-set-reduce', d.reduceMotion, t('settings.reduceMotion'), (on) => this.set((s) => (s.reduceMotion = on))),
        ),
        h(
          'footer',
          { class: 'aw-dlg-foot' },
          h('button', { type: 'button', class: 'aw-btn aw-btn-ghost', onclick: () => this.cb.onOpenSettings?.(false) }, t('common.cancel')),
          h('button', { type: 'submit', class: 'aw-btn aw-btn-primary', id: 'aw-set-save' }, t('common.save')),
        ),
      ),
    );
    if (musicHost) this.cb.onMountMusic?.(musicHost);
    if (focus) this.modal.focusFirst();
    else if (activeId) document.getElementById(activeId)?.focus({ preventScroll: true });
  }
}
