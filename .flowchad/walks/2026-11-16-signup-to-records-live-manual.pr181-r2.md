# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T16:47:12.216Z
- **Target:** http://127.0.0.1:8852 (local-copy)
- **Commit:** c1069a7ec60c66e305b4fd0740c252180450c050
- **Kind:** screens
- **Gate:** FAIL
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Not ready: do not hand this to a human tester until these pass.

- blocker FOLD-01 failed: The first input is visible without scrolling
- blocker WORD-05 failed: What the screen says is true

### Blockers failed

- **FOLD-01** The first input is visible without scrolling — step 7 @375: the domain page's next action for the records, the link "Open the DMARC step", sits 0.08 viewport heights (about 65 px) below the fold at 375; at 1440 it is visible (0); step 7 @375: scroll_before_primary_vh = 0.08, needs scroll_before_primary_vh = 0
- **WORD-05** What the screen says is true — step 7: The domain page offers "Record offered at _dmarc.example.io: v=DMARC1; p=none" and says "p=none changes no delivery; it starts the reports", while the card that sent the person here says "Reports can only arrive once its DMARC record names our reporting address. The domain page shows the exact record." The record offered has no report address; the one that does appears only after "Connect reports" is pressed (on the DMARC step, step 8 to 9).

### Known rough edges (6)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: S2 asks name, organization, whose email and two optional answers; decisions = 2; step 2: decisions = 2, needs decisions <= 1; step 7: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: the optional "What is your role?" and "Where did you hear about us?" stay on S2
- **NOISE-01** (should-fix) Everything visible serves the step — step 7: domain page: sidebar, Analytics and Settings buttons, the SPF card, the DKIM card, the level panel and the email health report sit around the one DMARC action
- **PATH-03** (should-fix) Every step earns its place — step 2: the optional role and source questions earn nothing toward the records being live
- **WAIT-02** (should-fix) Show progress and an estimate for waits over 10 seconds — step 10: the wait for the record to show in public DNS took 47399 ms; the card says "When it is in public DNS this page notices by itself" but gives no estimate and no progress; step 10: wait_progress = false with wait_ms = 47399, needs wait_progress = true when wait_ms > 10000
- **WORD-04** (should-fix) One name for one thing — step 8: the DMARC step says "Step 4 of 4: DMARC" and "1 of 4 steps complete" and offers "Skip setup": a counter the first run does not use, reached right after a first run that has no counter

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 8 |  |
| `decisions_to_value` | — | 11 |  |
| `fields_to_value` | — | 6 |  |
| `clicks_to_value` | — | 10 |  |
| `words_to_value` | — | 1028 |  |
| `reading_time_to_value_s` | — | 259 |  |
| `max_scroll_before_primary_vh` | — | 375: 0.08 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 26 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 47399 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 68429 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Two records are offered for the same job. The card says the domain page shows the exact record; the domain page leads with "v=DMARC1; p=none" (no report address) and the record that carries the report address appears only after "Connect reports" is pressed, one screen further. Following the first offer would leave the card waiting for the report address (not tried).
- After publishing, the card changed by itself 31, 47 and 61 seconds after the record was in DNS across three walks of the same state, longer than the stated 15-second look; the page gives no estimate. Likely the DNS answer cache of the local fake (TTL 60) but not confirmed.
- "Exit" on the DMARC step lands on the domain page, not on the dashboard where the card that notices the record lives; the person has to go on to the domains list (one more click), otherwise nothing is polling.
- Sign-up from one address six times in a few minutes answered "Too many requests — try again later" with no time to wait (a limit that real people rarely meet).
- The domain page logs a 404 for a billing request on this local copy.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
