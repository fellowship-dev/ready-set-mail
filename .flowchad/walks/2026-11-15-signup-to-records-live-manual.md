# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live
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
| Screens to value | 9 (sign-up, code, first screen, domain step, claim, SPF, DKIM, DMARC, Reports) |
| Y of the domain input (375 / 1440) | 1.04 / 0.82 (below the fold at 375) |
| Y of Verify on the claim (375 / 1440) | 1.21 / 1.06 |
| Visits to the DNS panel | 2 (proof record, then DMARC) |
| Waits | DNS propagation after each record |

### Notes

- Rough edge: the Connect Cloudflare card and the stepper push the only input below the fold.
- PR #177 rebuilds sign-up: re-walk and re-baseline this flow when it merges.
