# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T12:13:49.394Z
- **Target:** http://127.0.0.1:8860 (local-copy)
- **Commit:** 5a5caed85b
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (6)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: S2 asks name, organization, whose email and two optional answers; step 2: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision
- **NAV-02** (later) Every screen says where you are — step S2: S2 and S3 have no way back except "Start over" (which drops the attempt); the browser Back button works
- **NOISE-01** (should-fix) Everything visible serves the step — step 6: step 2: the two optional fields (owner decision); step 6: Export PDF and Add domain in the header
- **PATH-03** (should-fix) Every step earns its place — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision
- **WORD-04** (should-fix) One name for one thing — after the value step the DMARC step is the older setup wizard ("Step 4 of 4", "1 of 4 steps complete", "Skip setup"): its counter does not match the first run's no-counter wording; slice 2 replaces it (G1)

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 6 |  |
| `fields_to_value` | — | 6 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 373 |  |
| `reading_time_to_value_s` | — | 94 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 8 |  |
| `waits` | — | 3 |  |
| `longest_wait_ms` | — | 12058 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 27229 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- This walk (manual, a GoDaddy-hosted name) to the value step: 5 product screens, 6 typed fields, 82 keystrokes, 6 clicks, 373 words at 1440 / 345 at 375, farthest action bottom at 375 n/a vh; to "records live" through the older DMARC step: 0 product screens, 0 typed fields, 0 keystrokes, 0 clicks, 0 words at 1440 / 0 at 375, farthest action bottom at 375 n/a vh (the domain page, "See what to add", is not walkable here: see below, so the older DMARC step opened by its address stands in for it).
- Unreachable locally: the domain page of a resolving domain (D2). It, the daily refresh and the check summaries read the real public DNS, where harbor-lane.org does not exist, so it says "Check the spelling, or remove this domain"; the walker opened the DMARC step by its address, as e2e/cloudflare-first-run.spec.ts does. The article "How to add a TXT record at GoDaddy", the paste at a real DNS host and real propagation delay are outside a local copy.
- The first reads of public DNS go through the fake DoH (real code): the card flipped undefined s after the DMARC record was added, by itself.
- The manual path deliberately keeps the older screens after the proof (G1 all-records list with provider quirks, G2 share page, U1 are slice 2).

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record names: this record is <walked date>-<id>.pr177b.md (round 3 of PR 177), replacing the pr177 record of the same flow. It was walked at commit 5a5caed85b on the branch after merging main at db916a9; no file the flow covers changes between that commit and the records commit (scripts/check-flows.mjs).
- This walk: manual, a GoDaddy-hosted name; the value step is the one the flow file marks: the TXT proof record added at the DNS host is found by itself and the card says what comes next. The card did not flip to 'first reports on their way' in this walk: the domain page and daily refresh read real public DNS where harbor-lane.org does not exist (surface limit).
- Screenshots: 375 px PNGs of every step are committed under .flowchad/walks/pr177b/signup-to-records-live-manual/; the 1440 px captures (measured the same way, see the measures above, which cover both widths) and dark captures stay in the walk's out-of-repo evidence folder.

### Screenshots (375 px, light, one per step)

- step 1 `S1-signup`: `.flowchad/walks/pr177b/signup-to-records-live-manual/01-S1-signup@375.png`
- step 2 `S2-about`: `.flowchad/walks/pr177b/signup-to-records-live-manual/02-S2-about@375.png`
- step 3 `S3-code`: `.flowchad/walks/pr177b/signup-to-records-live-manual/03-S3-code@375.png`
- step 4 `S4-domain-empty`: `.flowchad/walks/pr177b/signup-to-records-live-manual/04-S4-domain-empty@375.png`
- step 5 `S4-result-godaddy-records`: `.flowchad/walks/pr177b/signup-to-records-live-manual/05-S4-result-godaddy-records@375.png`
- step 6 `after-proof`: `.flowchad/walks/pr177b/signup-to-records-live-manual/06-after-proof@375.png`
