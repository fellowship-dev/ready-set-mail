# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports
- **Walked:** 2026-11-16T17:50:11.032Z
- **Target:** http://127.0.0.1:8934 (local-copy)
- **Commit:** 7d03993f647e0179923a808a468d98a586a008f6
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
| `screens_to_value` | — | 6 |  |
| `decisions_to_value` | — | 5 |  |
| `fields_to_value` | — | 7 |  |
| `clicks_to_value` | — | 8 |  |
| `words_to_value` | — | 1377 |  |
| `reading_time_to_value_s` | — | 347 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 2 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1500 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 18003 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record name: `<date>-signup-to-records-live-manual.round2.md`: the walk after the review fixes of PR #183. Walked at the commit above on a real local hosted instance (`e2e/support/dev-instance.mjs`, `wrangler dev --local`; the fake Cloudflare stands for the DNS host: its name servers answer as GoDaddy's, its zone holds the records and it answers DNS-over-HTTPS), `HOSTED_CONNECT_REPORTS=all`, `INTAKE_DOMAIN=rua.readysetmail.com`, by a Playwright harness outside the repository over the skill's own `guard.mjs` and `measure.mjs` (fresh headless Chromium), at 1440x900 and 375x812: S1, S2, S3 (the mailed code), S4 with the TXT proof record to add, Verify, the first-day card waiting for the report address, "See what to add" to the domain page, Connect reports, the record to publish, and Check again until "Published, waiting for the first report". The proof record and the DMARC record are added to the fake zone through its API where a person would use the host's own screen.
- What changed on this flow in this pull request: the panel that "See what to add" leads to (Connect reports) and what it shows once connected; the sentence on the first-day card now says what the domain page shows first: "The domain page has Connect reports, which shows the exact record to add once the domain is connected". Item 4 check: on the domain page of this domain (no DMARC record, no Cloudflare connection) the first screen is the Connect reports panel and its button, bottom 0.70 / 0.52 viewport heights at 375x812 / 1440x900 with 11 words above it; the exact record to add appears on the next screen, after one click (Connect reports), at the top of the panel. So the sentence is true: the record is shown by Connect reports once the domain is connected, and the first screen carries that action.
- Counts to the value moment: 7 typed fields (email, password, name, organization, code, domain, and the DMARC record added at the host), 8 clicks.
- Where this differs from production: the DNS host is the fake; public DNS is answered by the fake DNS-over-HTTPS; `HOSTED_CONNECT_REPORTS=all`; sign-in codes read from the Worker log; the always-pass Turnstile test keys.
- Screenshots (both widths, one per step): `/workspace/shots/round2/signup-to-records-live-manual-<nn>-<step>-<1440|375>.png`.
