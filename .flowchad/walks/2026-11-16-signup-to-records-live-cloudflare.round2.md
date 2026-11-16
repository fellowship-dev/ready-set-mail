# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports
- **Walked:** 2026-11-16T17:40:50.791Z
- **Target:** http://127.0.0.1:8933 (local-copy)
- **Commit:** 75b712e3cd1c8576c54415c1118a83659ddd967e
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 3: decisions = 2, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 7 |  |
| `clicks_to_value` | — | 7 |  |
| `words_to_value` | — | 674 |  |
| `reading_time_to_value_s` | — | 170 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 15000 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 77323 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record name: `<date>-signup-to-records-live-cloudflare.round2.md`: the walk after the review fixes of PR #183. Walked at the commit above on a real local hosted instance (`e2e/support/dev-instance.mjs`, `wrangler dev --local`, the fake Cloudflare answering DNS-over-HTTPS), `HOSTED_CONNECT_REPORTS=all`, `INTAKE_DOMAIN=rua.readysetmail.com`, by a Playwright harness outside the repository over the skill's own `guard.mjs` and `measure.mjs` (fresh headless Chromium), at 1440x900 and 375x812: S1, S2, S3 (the mailed code), S4 (the domain, one line of public DNS, Connect Cloudflare), the token step, C2 (the review), Apply and the first-day card, until it says the first reports are on their way.
- What changed on this flow in this pull request: the first-run plan's DMARC write that carries our address now comes from the one function that writes it (`applyReportRecord`), so it refuses when the record moved after the plan; the first-day card's records sentence says what the domain page shows. The screens the person sees on this path are the same; the record written is `v=DMARC1; p=none; rua=mailto:rua@rua.readysetmail.com` (read back from the fake zone). 9 steps, 7 typed fields (email, password, name, organization, code, domain, token) and 7 clicks to the value moment.
- Where this differs from production: Cloudflare's consent screen is replaced by a pasted token on the fake (the fake has no consent screen; everything after it is the same code); the zone and its records are held by the fake and public DNS is answered by the fake; `HOSTED_CONNECT_REPORTS=all`; sign-in codes read from the Worker log; the always-pass Turnstile test keys.
- Screenshots (both widths, one per step): `/workspace/shots/round2/signup-to-records-live-cloudflare-<nn>-<step>-<1440|375>.png`.
