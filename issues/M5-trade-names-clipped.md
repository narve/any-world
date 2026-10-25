# Trade rows clip item names with no ellipsis

- Severity: major (M5 review round 1)
- Area: src/client/ui/components/modals.ts (tradeName), src/client/styles/ui.css
- Status: fixed

## Evidence
390x844 nb: 'Termos med kokel', 'Mørkleggingsgardi' cut by the price; name span 150 px vs 152–205 px content.

## Fix
The name is its own element that wraps to two lines (line clamp) with the full name in the title; the action word never wraps. On phones the row is a grid with the price under the name.

## Regression tests
Visual (trade screenshots); layout covered by the phone runs.
