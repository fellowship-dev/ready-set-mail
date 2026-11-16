# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
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
| Product screens to value | 7 (sign-up, code, first screen, connect, dashboard, domain page, Apply) + Cloudflare consent |
| Fields | 3 (email, password, code) |
| Keystrokes | 51 + token paste |
| Clicks | 6 + consent |
| Decisions asked | 4 (Cloudflare or manual; consent; which domain; apply) |
| Words before the first action | 28 |
| Max Y of the step's action at 375 px (viewports) | 2.52 ("Fix <domain>" on the overview) |
| Machine time, clean run | 6.4 s to the dashboard; 15 s through Apply |
| Lands on | overview with 14 badges and a "Reports are not available" panel |

### Notes

- The Cloudflare connection was a pasted token on the fake (no OAuth fake exists); the OAuth return runs the same import code.
- Rough edge: after Cloudflare connects, the next action is 2.5 screens down.
- PR #177 rebuilds sign-up: re-walk and re-baseline this flow when it merges.
