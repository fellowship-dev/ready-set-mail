# Walk record: buy-fix-one-domain

- **Flow:** Hosted owner buys Fix one domain in the app
- **Value moment:** Fix ordered (invoice.paid)
- **Walked:** 2026-11-15 (date of the measurement; time not recorded)
- **Target:** http://127.0.0.1:8787 (local-copy)
- **Commit:** 6a7d775eb014bb5c314e70f0dad3455c47891df0
- **Kind:** baseline
- **Gate:** not run
- **Rules:** none

_Baseline transcribed from the 2026-11-15 measurement of `main` 6a7d775eb014bb5c314e70f0dad3455c47891df0 (one devbox, headless Chromium at 375x812 and 1440x900, local hosted instance with the repo's fakes: Turnstile test keys, the local mail log for codes, the Cloudflare API fake). It was not produced by `gate.mjs --record`. The next walk of this flow replaces it as the base `changed.sh` compares against._

### Measures

| Measure | Now |
|---|---|
| Product screens to value | 4 + 1-2 Stripe pages |
| Clicks | 3-4 |

### Notes

- Counted from the merged flow (docs/billing.md), not rendered: billing is off without Stripe secrets, so no billing element renders on the measured instance.
