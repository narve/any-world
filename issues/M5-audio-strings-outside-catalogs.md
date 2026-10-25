# §7b / DoD #11: music-panel strings live outside the i18n catalogs

Severity: minor · Owner: i18n · Status: fixed

## Evidence
src/client/audio/messages.ts held its own `en`/`nb` maps for audio.panel.* and audio.mood.*. No catalog had these keys, so the missing-key checks never saw them. A new catalog would have passed CI and still shown an English music panel.

## Fix
The 23 audio keys now live in src/client/i18n/en.ts and nb.ts. messages.ts has no maps of its own any more: `AudioMessageKey` = `Extract<MessageKey, `audio.${string}`>`, `at()` = `t()`, and `AUDIO_MESSAGES` is a per-language view read from the catalogs (kept for existing callers and tests). The existing "every catalog has every English key" checks (tests/i18n/nb.test.ts, tests/client/i18n.test.ts) now cover the music panel.

## Regression test
tests/i18n/m5-wording.test.ts checks three things: every literal audio key in src/client/audio is in en.ts, messages.ts has no map of its own, and every catalog has every audio key. tests/audio/music-panel.test.ts still passes.
