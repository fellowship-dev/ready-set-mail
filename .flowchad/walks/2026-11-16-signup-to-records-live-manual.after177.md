# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports
- **Walked:** 2026-11-16T13:47:36.154Z
- **Target:** http://127.0.0.1:8901 (local-copy)
- **Commit:** 7c8df4e27c
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (5)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 3: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: S2 keeps two optional questions ("What is your role?", "Where did you hear about us?") the next step does not need; kept by the owner's explicit decision in PR 177
- **NAV-02** (later) Every screen says where you are — step 2: S2 and S3 offer only "Start over" (which drops the attempt) besides the browser Back button
- **PATH-03** (should-fix) Every step earns its place — step 2: the same two optional questions on S2 do not earn their place on the path to value (owner's decision)
- **WORD-04** (should-fix) One name for one thing — step 8: the DMARC step is the older setup wizard ("Step 4 of 4", and "Setup wizard: 1 of 4 steps done" on the domain page); the first run has no counter; slice 2 replaces it

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 6 |  |
| `decisions_to_value` | — | 3 |  |
| `fields_to_value` | — | 7 |  |
| `clicks_to_value` | — | 4 |  |
| `words_to_value` | — | 345 |  |
| `reading_time_to_value_s` | — | 87 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1831 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 45759 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The domain page, the daily refresh and the first read read the fake DNS-over-HTTPS here; the paste at a real DNS host (the TXT record, then the DMARC record) and real propagation time are outside a local copy: both records were added to the fake zone, standing in for the DNS host.
- Layout at 375x812 on the last two screens: the record to copy (DMARC step, Copy record) and the status refresh (Reports step, Check again) are now in the first screen; before this change they sat 0.06 and 0.35 viewport heights below it.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record name: `<walked date>-<id>.after177.md` (the walk after PR 177 merged). It was walked at commit 7c8df4e27c on the branch after merging main at 61e6b8f; no file the flow covers changes between that commit and the commit that adds this record (scripts/check-flows.mjs).
- Walked by a script outside the repository (a Playwright harness over the skill's own `guard.mjs` and `measure.mjs`) on a local copy of commit 7c8df4e27c: hosted mode, a GoDaddy-named domain, `HOSTED_CONNECT_REPORTS=all`; 11 steps at 1440x900 and 375x812, the tail after the value step added to the flow file in this change (domain page, DMARC step, Reports step).
- The FOLD-01 failures of the earlier gate walk of this branch (Copy record 0.06 and Check again 0.35 viewport heights below the first screen at 375 wide) are gone: both actions are now fully visible at both widths (step 8 DMARC step, step 9 DMARC step with the report address, step 10 Reports step). The change: the record and its Copy record come before where to add it and the explaining sentences; Check again sits beside the status it refreshes.
- The other FOLD-01 findings of that walk (the domain field, the claim's Verify) did not reproduce: with the primary left to `measure.mjs` (no selector) the domain field and Verify are at 0 at both widths on this commit and on origin/main 61e6b8f alike (the same script run against both).
- Dead ends walked: a wrong 6-digit code ("That code isn't right. Check the latest email.", recoverable); Verify pressed before the TXT record exists ("We don't see the record yet. DNS changes can take a few minutes to show up. Verify again in a minute.", recoverable).
- Where this differs from production: a local Worker with a fake Cloudflare and fake DNS-over-HTTPS in place of public DNS; `HOSTED_CONNECT_REPORTS=all` (production default: the operator's workspaces only); sign-in codes read from the Worker log; Cloudflare's published always-pass Turnstile test keys (the widget's own requests go to challenges.cloudflare.com, declared write-allowed-test for that reason); harbor-lane.org does not exist in public DNS, so both records were added to the fake zone, standing in for adding them at the DNS host.
- Screenshots: 375 px PNGs of every step are committed under `.flowchad/walks/after177/signup-to-records-live-manual/`; the 1440 px captures and the walk's `results.json` stay in the walk's out-of-repo evidence folder.

### Screenshots (375 px, light, one per step)

- step 1 `S1 sign-up`: `.flowchad/walks/after177/signup-to-records-live-manual/01-S1-signup.png`
- step 2 `S2 about you`: `.flowchad/walks/after177/signup-to-records-live-manual/02-S2-about.png`
- step 3 `S3 code`: `.flowchad/walks/after177/signup-to-records-live-manual/03-S3-code.png`
- step 4 `S4 which domain`: `.flowchad/walks/after177/signup-to-records-live-manual/04-S4-domain-empty.png`
- step 5 `S4 result and proof record`: `.flowchad/walks/after177/signup-to-records-live-manual/05-S4-result-records.png`
- step 6 `first-day dashboard`: `.flowchad/walks/after177/signup-to-records-live-manual/06-Verify-proven.png`
- step 7 `domain page`: `.flowchad/walks/after177/signup-to-records-live-manual/07-domain-page.png`
- step 8 `setup step 4 DMARC`: `.flowchad/walks/after177/signup-to-records-live-manual/08-DMARC-step.png`
- step 9 `setup step 4 DMARC with the report address`: `.flowchad/walks/after177/signup-to-records-live-manual/09-DMARC-connected.png`
- step 10 `setup step 5 reports`: `.flowchad/walks/after177/signup-to-records-live-manual/10-Reports-step.png`
- step 11 `setup step 5 reports waiting`: `.flowchad/walks/after177/signup-to-records-live-manual/11-Records-live.png`
