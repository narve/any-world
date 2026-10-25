# Item card repeats cooldown/charges as a raw tag line

- Severity: minor (M5 review round 1)
- Area: src/client/ui/components/common.ts (itemMeta)
- Status: fixed

## Evidence
Dowsing Rod: '◆ Cooldown 15 turns' then grey 'cooldown 15'; Canteen 'Charges: 2/3' then '2/3 charges'.

## Fix
`itemMeta()` drops cooldown, charges and wear from the grey facts line when the item's effect bullets are shown (known item): the engine's describe lines always state them. 'ready in N', the stack size and 'equipped' still show.

## Regression tests
tests/client/m5-client-fixes.test.ts 'item card facts'.
