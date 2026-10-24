/** HUD: character panel (top-left) and status strip (top-centre). */
import type { HudView } from '../viewmodel';
import { dataKey, h, setChildren } from '../dom';
import { areaLabel, signed, speedLabel, turnLabel } from '../format';
import { bar, plainChip, statusChip, type UiContext } from './common';
import { t } from '../../i18n/index';

export class Hud {
  readonly panel: HTMLElement;
  readonly strip: HTMLElement;
  private key = '';

  constructor() {
    this.panel = h('section', { class: 'aw-panel aw-hud', 'aria-label': t('hud.character') });
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
      { id: 'xp', label: t('hud.xpLabel', { xp: vocab.xp, level: v.level }), abbr: t('hud.levelAbbr', { level: v.level }), value: v.xpInLevel, max: v.xpForLevel, color: 'var(--c-accent)' },
      { compact: true },
    );
    if (v.pendingLevels) {
      const n = v.pendingLevels;
      xpBar.append(
        h(
          'span',
          { class: 'aw-xp-pending', dataset: { tip: t('hud.pendingTip', { n }) } },
          t('hud.pending', { n }),
        ),
      );
    }

    const stats = h(
      'div',
      { class: 'aw-stats' },
      v.stats.map((s) => {
        const sv = vocab.stats[s.key];
        const diff = s.value - s.base;
        return h(
          'div',
          { class: 'aw-stat', dataset: { tip: diff ? t('hud.statTipMod', { name: sv.name, description: sv.description, base: s.base, diff: signed(diff) }) : t('hud.statTip', { name: sv.name, description: sv.description }) }, tabindex: '0' },
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
      v.danger?.length
        ? h(
            'div',
            { class: 'aw-danger', role: 'alert' },
            v.danger.map((d) =>
              h(
                'div',
                { class: ['aw-danger-row', `is-${d.level}`], style: { '--danger': d.color } },
                h('span', { class: 'aw-danger-dot', 'aria-hidden': 'true' }),
                h('span', null, d.draining && d.id !== 'hp' ? t('hud.dangerDraining', { label: d.label, level: d.level, hp: hpS.name }) : t('hud.danger', { label: d.label, level: d.level })),
                d.slot !== undefined ? h('kbd', { class: 'aw-danger-key', title: t('slot.aria.quick', { n: d.slot + 1 }) }, t('slot.press', { key: d.slot + 1 })) : null,
              ),
            ),
          )
        : null,
      xpBar,
      stats,
      v.statuses.length ? h('div', { class: 'aw-chips', 'aria-label': t('hud.conditions') }, v.statuses.map(statusChip)) : null,
    );

    const speed = speedLabel(v.speed);
    setChildren(
      this.strip,
      h('span', { class: 'aw-strip-area' }, h('span', { class: 'aw-strip-label' }, areaLabel(vocab, v.areaIndex, v.areaCount)), h('span', { class: 'aw-strip-name' }, v.areaName)),
      h('span', { class: 'aw-strip-sep', 'aria-hidden': 'true' }),
      h('span', { class: 'aw-strip-turn' }, turnLabel(v.turn)),
      h('span', { class: 'aw-strip-money', dataset: { tip: vocab.currency } }, t('hud.money', { n: v.currency, currency: vocab.currency })),
      v.sneaking ? plainChip(t('hud.sneaking'), 'good', t('hud.sneakingTip')) : null,
      speed ? plainChip(speed, v.speed === 'fast' ? 'good' : 'danger') : null,
    );
  }
}
