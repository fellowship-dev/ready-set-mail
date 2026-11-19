# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-19T21:17:47.557Z
- **Target:** http://127.0.0.1:8921 (local-copy)
- **Commit:** caaa76aaf87bb5b44a2c57e7fa62b2754b986226
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (4)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 3: S2 asks name and organization and whose email: decisions = 2, plus two optional questions (role, where heard); step 3: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 3: the optional role and "where did you hear about us" questions are asked and cannot be derived
- **NOISE-01** (should-fix) Everything visible serves the step — step 7: the review shows "Also in Example Co: 2 more domains", Skip for now and "Hand setup to a teammate" beside the one Apply
- **WAIT-02** (should-fix) Show progress and an estimate for waits over 10 seconds — step 8: the card waited about 60 s: "We look again every 15 seconds while this page is open." says no estimate and nothing about leaving the page; step 8: wait_progress = false with wait_ms = 60844, needs wait_progress = true when wait_ms > 10000

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 8 |  |
| `fields_to_value` | — | 7 |  |
| `clicks_to_value` | — | 7 |  |
| `words_to_value` | — | 540 |  |
| `reading_time_to_value_s` | — | 136 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 6 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 60844 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 79369 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- After Apply the first-day card said "waiting for public DNS to show the new record" for about a minute while public DNS (the fake DoH) already answered with the record: the stored read reuses the claim preview cache (src/domains/first-check.ts cachedPreview, 60 s), so a person who applies within a minute of the S4 check waits a minute longer than DNS needs. Not distinguishable from real propagation delay on production.
- Hosted sign-up: the browser's request to the Turnstile host was aborted by the walk guard (ERR_ABORTED, a non-GET to a host not declared local); sign-up still passed on the always-pass test keys.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
