# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T03:29:37.221Z
- **Target:** http://127.0.0.1:8851 (local-copy)
- **Commit:** c07f39a41b096097fda13647874ebdb32ddc8df5
- **Kind:** screens
- **Gate:** PASS-WITH-OVERRIDES
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready only with overrides: blocker rules failed and were overridden. Tell the tester about every override below first, and fix them next.

### Known rough edges (2)

- **FOLD-01** (blocker, **OVERRIDDEN** by Claude (Fable 5.2) for Max F. Findel, PR #178; reviewer to accept on 2026-11-16) The first input is visible without scrolling — failed: step 5 @375: scroll_before_primary_vh = 0.36, needs scroll_before_primary_vh = 0; step 8 @375: scroll_before_primary_vh = 0.31, needs scroll_before_primary_vh = 0; accepted because: Known rough edge of main, not changed by pull request 178: at 375 px the next action sits about a third of a screen below the first screen on the dashboard after Cloudflare connects and on the DMARC result screen (walk of 2026-11-16: 0.36 and 0.31 viewport heights). It is recorded in the 2026-11-15 baseline; a layout change is a separate design task.
- **NOISE-01** (should-fix) Everything visible serves the step — step 3: not needed for the step: Skip setup link in the header (the step does not need it); step 5: not needed for the step: 'Reports not connected yet' panel (about 70 words); Export PDF button; Add domain button; step 6: not needed for the step: Analytics button; Settings button; level ladder ("Level not known yet"); step 7: not needed for the step: Skip setup link in the header; step 8: not needed for the step: a toast repeating the inline result

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 8 |  |
| `decisions_to_value` | — | 7 |  |
| `fields_to_value` | — | 4 |  |
| `clicks_to_value` | — | 5 |  |
| `words_to_value` | — | 1022 |  |
| `reading_time_to_value_s` | — | 258 |  |
| `max_scroll_before_primary_vh` | — | 375: 0.36 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 9 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 813 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 16904 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Where this local copy differs from production (read the findings below with this in mind): built from the commit named here (HEAD of the branch), served by wrangler dev with MODE=saas and SAAS_ENABLED=1 over plain http on 127.0.0.1; Turnstile runs with Cloudflare's documented always-pass test keys; the widget loads from its real host, which the walk lets write (a write-allowed-test surface) so the dummy token can be issued; the sign-in code mail is captured in the Worker log (local send_email simulation) and read from there; the Cloudflare API and DNS-over-HTTPS are the in-memory fakes of the repo (e2e/support/fake-cloudflare.mjs); nothing reaches api.cloudflare.com; INTAKE_DOMAIN and HOSTED_CONNECT_REPORTS=all are set so the shared report address is written (the production default admits only the operator's own workspaces); product analytics is ON: POSTHOG_KEY and POSTHOG_HOST (the US ingestion host) are set and POSTHOG_API_BASE points at a local fake PostHog that keeps every request; this is the configuration under change; the Cloudflare connection is a pasted token (the fake has no OAuth screen): the import after it is the same code as after the OAuth return; public DNS reads of the fake names would say "does not exist" (the names are not real), so the setup wizard's status response is answered in the browser as if the name resolved with no DMARC record, as e2e/cloudflare-first-run.spec.ts does; the domain page and dashboard therefore say the names do not exist, which is true of public DNS; from the domain page the walker opens the DMARC setup step by its address: with these names the page offers "Check the spelling" instead of the link a real, resolving domain gets.
- Analytics was ON during this walk. The fake PostHog received 16 events: Signup Started x2, Signup Code Sent x2, Code Verified x1, Workspace Created x1, Dashboard First Viewed x1, Workspace Active x1, Cloudflare Connect Started x1, Cloudflare Connect Returned x1, Ownership Verified x3, Domain Added x1, Apply Clicked x1, Apply Done x1. Nothing on any screen mentions analytics, and no screen, word or step of the flow differs because of it.
- Control run with analytics OFF on the same commit: all 8 steps matched on status, screen, words seen, scroll and overflow measures at both widths, counts, dead ends and every cross-check (timings are not compared).
- Against the baseline of 2026-11-15 (measured by hand on main 6a7d775, a pasted Cloudflare token as here): the baseline counted 7 screens, 3 typed fields plus a token paste, 6 clicks plus consent and 4 decisions. This walk, which names its screens more finely (the DMARC step and its result are two screens here, the token screen is its own), counts 8 screens, 4 typed fields (email, password, code, token), 5 clicks, 7 decisions (counted per screen) and 1022 words to value; the farthest the next action sits below the first screen at 375 is 0.36 viewport heights.
- Both widths were walked from the plain sign-up address. The link a website visitor arrives by (with a page class and, from the checker, a domain) was not walked: its reading is covered by web/test/signup-source.test.ts and its server side by test/product-analytics/analytics.test.ts, not by this walk.
- On the final screen a toast says "Waiting to show in public DNS" while the page already says "Live in public DNS." (the toast is the answer to the Apply request, shown a moment after the read-back found the record). It goes away by itself and is not counted as a failed claim; worded as a rule it would be: a notice must not contradict what the screen shows a moment later.
- In this local copy the dashboard and domain page say the fake names "do not exist" (true of public DNS), so the domain page offers "Check the spelling" and not a link into the DMARC step; the walker opened that step by its address. A real, resolving domain is not covered by this walk.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
