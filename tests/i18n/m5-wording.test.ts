/**
 * M5 language review (round 1) regressions: wording fixes in the bokmål / English catalogs and the
 * music-panel strings living in the shared catalogs (DESIGN §7b, DoD #11).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../src/client/i18n/en';
import nb from '../../src/client/i18n/nb';
import { availableLanguages, catalog, setLanguage, t, tx } from '../../src/client/i18n/index';
import { tagLabel } from '../../src/client/i18n/tags';
import { AUDIO_MESSAGES, at } from '../../src/client/audio/messages';

const NB = nb as Record<string, string>;
const EN = en as Record<string, string>;

afterEach(() => setLanguage('en', { persist: false }));

describe('lose-condition lines do not agree in number with the world word', () => {
  it('English: "You run out of {hp}" reads right for singular and plural names', () => {
    setLanguage('en', { persist: false });
    expect(t('goal.lose.hp', { hp: 'Vitals' })).toBe('You run out of Vitals');
    expect(t('goal.lose.resource', { resource: 'Supplies' })).toBe('You run out of Supplies');
    expect(EN['goal.lose.hp']).not.toMatch(/drops|Your/);
  });
  it('bokmål mirrors it', () => {
    setLanguage('nb', { persist: false });
    expect(t('goal.lose.hp', { hp: 'Tålmodighet' })).toBe('Du går tom for Tålmodighet');
    expect(t('goal.lose.resource', { resource: 'Blekk' })).toBe('Du går tom for Blekk');
  });
});

describe('bokmål wording (M5 review r1)', () => {
  it('search is "Let", look is "Se deg rundt" — never both "undersøk"', () => {
    for (const k of ['ctx.search', 'help.search', 'help.look', 'help.mouse.hover', 'onboard.verb.search']) {
      expect(NB[k].toLowerCase(), k).not.toContain('undersøk');
    }
    expect(NB['ctx.search']).toBe('Let');
    expect(NB['help.search']).toMatch(/^Let /);
    expect(NB['onboard.verb.search']).toMatch(/^Let: /);
    expect(NB['help.look']).toBe('Se deg rundt');
    expect(NB['help.mouse.hover']).toMatch(/^Se på · /);
  });

  it('typed damage is not the calque "tar {amount} {damageType}"', () => {
    setLanguage('nb', { persist: false });
    const line = tx('log.damage.take_typed', { target: 'kari', amount: 3, damageType: 'Skjemavelde' });
    expect(line).toBe('Kari mister 3 (Skjemavelde).');
  });

  it('the end-screen level stat does not build a compound from the xp word', () => {
    setLanguage('nb', { persist: false });
    expect(t('end.stat.level', { xp: 'Ansiennitet' })).toBe('Nivå (Ansiennitet)');
    expect(t('end.stat.harmDealt')).toBe('Skade påført');
    expect(t('end.stat.harmTaken')).toBe('Skade mottatt');
  });

  it('"snike" always comes with its reflexive pronoun', () => {
    for (const [k, v] of Object.entries(NB)) {
      for (const m of v.matchAll(/\b(snik\w*)\b(\s+\S+)?/gi)) {
        expect(m[2]?.trim().replace(/[^\wæøå]/gi, ''), `${k}: ${v}`).toMatch(/^(seg|deg|meg|oss|dere)$/i);
      }
    }
    expect(NB['log.sneak.off']).toBe('{player} slutter å snike seg.');
    expect(NB['ctx.sneakStop']).toBe('Slutt å snike deg');
  });

  it('bumping a wall says "Sperret", not "Stengt"', () => {
    expect(NB['engine.invalid.blocked']).toBe('Sperret');
  });

  it('the GM rule badge is in bokmål', () => {
    expect(NB['rules.srcGm']).toBe('Spillmester');
  });

  it('the conflict explanation has no "på 0" calque and no Den/det mismatch', () => {
    for (const k of ['onboard.conflict.violent', 'onboard.conflict.nonViolent']) {
      expect(NB[k], k).not.toMatch(/på 0|Den heter/);
      expect(NB[k], k).toContain('når de er nede i 0');
    }
  });

  it('level-up phrasing', () => {
    setLanguage('nb', { persist: false });
    expect(t('perk.gain', { item: 'Muntlig klage' })).toBe('Ny evne: Muntlig klage');
    expect(t('hud.pendingTip', { n: 1 })).toBe('1 nytt nivå opptjent – du velger ett om gangen');
    expect(t('hud.pendingTip', { n: 2 })).toBe('2 nye nivåer opptjent – du velger ett om gangen');
    expect(t('hud.levelAbbr', { level: 2 })).toBe('Niv. 2');
  });

  it('the "already full" toast does not inflect with the stat word', () => {
    setLanguage('nb', { persist: false });
    expect(t('toast.wasted', { full: 'Blekk', item: 'Blekkhus' })).toBe('Blekk: allerede på maks – bruke Blekkhus likevel? (trykk igjen)');
  });

  it('small wording fixes', () => {
    expect(NB['dlg.leave']).toBe('Avslutt');
    expect(NB['dlg.opt.leave']).toBe('Avslutt');
    expect(NB['weirdness.unhinged']).toBe('Helt sprøtt');
    expect(NB['settings.qualityHint'].startsWith(NB['settings.quality.auto'])).toBe(true);
    expect(tagLabel('non-earth', 'nb')).toBe('utenomjordisk');
  });
});

describe('music-panel strings live in the catalogs (§7b: a language is one catalog file)', () => {
  const audioDir = join(__dirname, '../../src/client/audio');
  const used = new Set<string>();
  for (const f of readdirSync(audioDir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(audioDir, f), 'utf8');
    for (const m of src.matchAll(/['`](audio\.(?:panel|mood)\.[\w]+)['`]/g)) used.add(m[1]);
  }

  it('every literal audio key used by the audio module is in en.ts', () => {
    expect(used.size).toBeGreaterThan(5);
    for (const k of used) expect(EN[k], k).toBeTruthy();
  });

  it('the audio module keeps no language map of its own', () => {
    const src = readFileSync(join(audioDir, 'messages.ts'), 'utf8');
    expect(src).not.toMatch(/'audio\.panel\.title'\s*:/);
  });

  it('every catalog has every English audio key (so the missing-key check covers them)', () => {
    const keys = Object.keys(EN).filter((k) => k.startsWith('audio.'));
    expect(keys.length).toBeGreaterThan(20);
    for (const { code } of availableLanguages()) {
      const c = catalog(code)!;
      for (const k of keys) expect(c[k], `${code}: ${k}`).toBeTruthy();
    }
  });

  it('at() is the catalog lookup and follows the language', () => {
    setLanguage('nb', { persist: false });
    expect(at('audio.panel.title')).toBe('Musikk');
    expect(at('audio.panel.mood', { mood: at('audio.mood.eerie') })).toBe('Stemning: uhyggelig');
    setLanguage('en', { persist: false });
    expect(at('audio.panel.title')).toBe('Music');
    expect(AUDIO_MESSAGES.nb['audio.mood.boss']).toBe('oppgjør');
  });
});
