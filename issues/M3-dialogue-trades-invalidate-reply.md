# Dialogue replies that offered a trade were rejected as a whole

- Severity: major
- Area: llm (src/llm/gm-checks.ts)
- Status: fixed
- Source: BUILD_LOG.md [M3/gate] Runtime/tool fixes; Back-filled in M5 (shell fixer) from BUILD_LOG.md; the fix itself landed in M3.

## Evidence
Agents acting as the provider wrote dialogue replies with trade actions in 8 of the recorded dialogue turns.
Dialogue may not trade, so the whole reply failed validation and the NPC fell back to a canned line,
losing the authored text.

## Fix
`gm-checks.dropTrades` removes the trade actions and keeps the rest of the reply. The dialogue prompt now
says "no trade in dialogue" explicitly (M3 gate prompt fixes).

## Regression tests
tests/llm/m3-gate.test.ts (dropTrades keeps the lines, drops the trade).
