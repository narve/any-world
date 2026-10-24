/** HUD: character panel (top-left) and status strip (top-centre). */
import type { HudView } from '../viewmodel';
import { dataKey, h, setChildren } from '../dom';
import { areaLabel, signed, speedLabel, turnLabel } from '../format';
import { bar, plainChip, statusChip, type UiContext } from './common';

export class Hud {
  readonly panel: HTMLElement;
  readonly strip: HTMLElement;
  private key = '';

  constructor() {
    this.panel = h('section', { class: 'aw-panel aw-hud', 'aria-label': 'Character' });
    this.strip = h('div', { class: 'aw-strip', role: 'status', 'aria-live': 'off' });
  }

  update(v: HudView, ctx: UiContext): void {
    const key = dataKey([v, ctx.vocab]);
    if (key === this.key) return;
    this.key = key;
    const vocab = ctx.vocab;
    const hpS = vocab.stats.hp;
    const mpS = vocab.stats.mp;

    const bars = [bar({ id: 'hp', label: hpS.name, abbr: hpS.abbr, description: hpS.description, value: v.hp.value, max: v.hp.max, color: 'var(--c-danger)' })];
    if (v.mp) bars.push(bar({ id: 'mp', label: mpS.name, abbr: mpS.abbr, description: mpS.description, value: v.mp.value, max: v.mp.max, color: 'var(--c-secondary)' }));
    for (const r of v.resources) bars.push(bar(r));
    const xpBar = bar(
      { id: 'xp', label: `${vocab.xp} — level ${v.level}`, abbr: `Lv ${v.level}`, value: v.xpInLevel, max: v.xpForLevel, color: 'var(--c-accent)' },
      { compact: true },
    );

    const stats = h(
      'div',
      { class: 'aw-stats' },
      v.stats.map((s) => {
        const sv = vocab.stats[s.key];
        const diff = s.value - s.base;
        return h(
          'div',
          { class: 'aw-stat', dataset: { tip: `${sv.name} — ${sv.description}${diff ? ` (base ${s.base}, ${signed(diff)})` : ''}` }, tabindex: '0' },
          h('span', { class: 'aw-stat-abbr' }, sv.abbr),
          h('span', { class: ['aw-stat-val', diff > 0 && 'is-up', diff < 0 && 'is-down'] }, String(s.value)),
        );
      }),
    );

    setChildren(
      this.panel,
      h(
        'div',
        { class: 'aw-hud-head' },
        h('span', { class: 'aw-portrait', style: { '--portrait': v.playerColor ?? 'var(--c-primary)' }, 'aria-hidden': 'true' }),
        h('div', { class: 'aw-hud-names' }, h('div', { class: 'aw-hud-name' }, v.playerName), h('div', { class: 'aw-hud-title' }, v.playerTitle)),
      ),
      h('div', { class: 'aw-bars' }, bars),
      xpBar,
      stats,
      v.statuses.length ? h('div', { class: 'aw-chips', 'aria-label': 'Conditions' }, v.statuses.map(statusChip)) : null,
    );

    const speed = speedLabel(v.speed);
    setChildren(
      this.strip,
      h('span', { class: 'aw-strip-area' }, h('span', { class: 'aw-strip-label' }, areaLabel(vocab, v.areaIndex, v.areaCount)), h('span', { class: 'aw-strip-name' }, v.areaName)),
      h('span', { class: 'aw-strip-sep', 'aria-hidden': 'true' }),
      h('span', { class: 'aw-strip-turn' }, turnLabel(v.turn)),
      h('span', { class: 'aw-strip-money', dataset: { tip: vocab.currency } }, `${v.currency} ${vocab.currency}`),
      v.sneaking ? plainChip('Sneaking', 'good', 'Moving quietly (c to stop)') : null,
      speed ? plainChip(speed, v.speed === 'fast' ? 'good' : 'danger') : null,
    );
  }
}
