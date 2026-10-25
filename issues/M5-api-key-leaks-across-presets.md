# Direct-mode API key leaks to another provider when switching presets

- Severity: major (M5 review round 2, code review)
- Area: src/client/storage.ts, src/client/main.ts, src/client/ui/viewmodel.ts (Settings); dialog in src/client/ui/components/screens.ts
- Status: fixed for storage and sending; the dialog's live key field still needs a one-line change in screens.ts (not owned by the client fixer)

## Evidence
tests/review/m5/r2-code-key-leak.spec.ts: settings {preset:'anthropic', transport:'direct', apiKey:'sk-ant-…'}; picking OpenRouter in the dialog and saving stored {preset:'openrouter', apiKey:'sk-ant-…'}, and "Create world" sent `Authorization: Bearer sk-ant-…` to openrouter.ai. Same for Ollama / LM Studio / a custom base URL.

## Cause
`Settings.provider` holds one `apiKey` for every preset; the dialog's preset onchange resets model / base URL / transport but not the key.

## Fix
- `Settings.apiKeys: Record<slot, key>` with `keySlot(provider)` = preset id, plus the base URL when one is set (trailing slashes ignored): a key never follows a change of host.
- `normalizeSettings` migrates an old single key to the slot it was saved with, and sets `provider.apiKey` from the active slot.
- `reconcileApiKeys(before, saved)` (main.ts `onSettings`): a key the player typed or cleared belongs to the provider the dialog is set to; otherwise a provider change swaps in that provider's own saved key, or none. Switching back restores the old key.
- `activeProvider(settings)` is what main.ts hands to `providerFromSettings`, `providerProblem` and `providerStatus`: the key is dropped unless it is the one saved for the active slot (hand-edited storage).
- Result for the repro: stored `provider.apiKey` is absent and nothing is sent to OpenRouter (the start screen reports the missing key).

## Remaining (screens.ts owner)
While the dialog is open the key field still shows the previous provider's key after a preset change (the spec's `shown` value). Suggested: in SettingsDialog's preset onchange, `s.provider.apiKey = s.apiKeys?.[keySlot(s.provider)]` (import keySlot from storage). Saving is already safe without it. The review spec also expects a request to reach openrouter.ai; with no key the client correctly sends none, so the spec's `expect.poll(seen.length > 0)` must change when it is moved.

## Regression tests
tests/client/m5-client-r2.test.ts "direct-mode API keys stay with their provider" (migration, switch without typing, typed/cleared key, base-URL change, hand-edited entry).
