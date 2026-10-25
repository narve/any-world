# Settings: provider labels, regions and notes in English

- Severity: minor (M5 review round 1)
- Area: src/client/ui/format.ts (presetRegion, presetLabel, presetNote, localizedPreset), src/client/main.ts
- Status: fixed

## Evidence
nb settings: 'Ollama (local) — Local', 'DeepSeek — China', 'Region: US', the English Anthropic technical note.

## Fix
main.ts passes presets through `localizedPreset`: regions from catalog keys (settings.region.*), '(local)' and 'Custom (OpenAI-compatible)' translated, technical notes shown only in the English UI unless the catalog has settings.presetNote.<id>.

## Regression tests
tests/client/m5-client-fixes.test.ts 'settings presets in the UI language'.
