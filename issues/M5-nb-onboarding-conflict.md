# Onboarding conflict text: gender mismatch and calque

Severity: minor · Owner: i18n · Status: fixed

## Evidence
'Den heter «Innvend»: … bruke det. Det tærer på Tålmodighet; på 0 er de henlagt.' (Den … det; 'på 0' is a calque of 'at 0').

## Fix
nonViolent: 'Her handler konflikt ikke om vold, men om «{conflict}»: gå inn i en motstander for å bruke det. Det tærer på {hp}, og når de er nede i 0, er de {defeated}.' violent: '… Hvert treff trekker fra {hp}, og når de er nede i 0, er de {defeated}.' I did not use the suggested 'når den når 0'. "den" would agree with the world's hp word, which can be any gender, and that breaks the catalog's house style. Here "de" refers to the rivals.

## Regression test
tests/i18n/m5-wording.test.ts.
