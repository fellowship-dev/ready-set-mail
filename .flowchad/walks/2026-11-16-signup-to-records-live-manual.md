# Walk record: signup-to-records-live-manual

- **Flow:** New hosted user signs up and gets DMARC with the report address live by adding records by hand
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T03:30:20.044Z
- **Target:** http://127.0.0.1:8861 (local-copy)
- **Commit:** c07f39a41b096097fda13647874ebdb32ddc8df5
- **Kind:** screens
- **Gate:** PASS-WITH-OVERRIDES
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready only with overrides: blocker rules failed and were overridden. Tell the tester about every override below first, and fix them next.

### Known rough edges (3)

- **FOLD-01** (blocker, **OVERRIDDEN** by Claude (Fable 5.2) for Max F. Findel, PR #178; reviewer to accept on 2026-11-16) The first input is visible without scrolling — failed: step 4 @375: scroll_before_primary_vh = 0.09, needs scroll_before_primary_vh = 0; step 5 @375: scroll_before_primary_vh = 0.35, needs scroll_before_primary_vh = 0; step 5 @1440: scroll_before_primary_vh = 0.13, needs scroll_before_primary_vh = 0; step 6 @375: scroll_before_primary_vh = 0.13, needs scroll_before_primary_vh = 0; step 9 @375: scroll_before_primary_vh = 0.69, needs scroll_before_primary_vh = 0; step 9 @1440: scroll_before_primary_vh = 0.04, needs scroll_before_primary_vh = 0; step 10 @375: scroll_before_primary_vh = 0.71, needs scroll_before_primary_vh = 0; step 10 @1440: scroll_before_primary_vh = 0.19, needs scroll_before_primary_vh = 0; accepted because: Known rough edge of main, not changed by pull request 178: the Connect Cloudflare card and the stepper push the domain field and several next actions below the first screen (walk of 2026-11-16: 0.09 to 0.71 viewport heights at 375 px, up to 0.19 at 1440 px). It is recorded in the 2026-11-15 baseline; a layout change is a separate design task.
- **WORD-05** (blocker, **OVERRIDDEN** by Claude (Fable 5.2) for Max F. Findel, PR #178; reviewer to accept on 2026-11-16) What the screen says is true — failed: step 9: The heading "Reports not connected yet" still on screen above the record; independent source: reports are connected: domains.reports_connected_at is set in D1 (1); step 10: "No DMARC record found for _dmarc.<domain>" still on screen above the panel that says Published; independent source: the same DNS-over-HTTPS read returns a record (1 found); step 10: The heading "Reports not connected yet" still on screen; independent source: reports are connected (D1 reports_connected_at is set); accepted because: Pre-existing on main, not changed by pull request 178: in the setup wizard Check again refreshes only the reports panel, so the DMARC policy panel above it keeps saying No DMARC record found and Reports not connected yet while the panel below says Published and connected. The wizard files are unchanged since main; fixing it is a separate change.
- **NOISE-01** (should-fix) Everything visible serves the step — step 3: not needed for the step: Skip setup link in the header; step 4: not needed for the step: Connect Cloudflare card above the domain field; Skip setup link in the header; step 5: not needed for the step: Connect Cloudflare card above the claim; Skip setup link in the header; step 6: not needed for the step: Skip setup link in the header; step 7: not needed for the step: Skip setup link in the header; Rescan DNS button; step 8: not needed for the step: Skip setup link in the header; Copy record block (a record without the report address); step 9: not needed for the step: Skip setup link in the header; a second, shorter "Recommended record" block with no report address; Disconnect reports button; step 10: not needed for the step: Disconnect reports button; Copy record block

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 10 |  |
| `decisions_to_value` | — | 9 |  |
| `fields_to_value` | — | 4 |  |
| `clicks_to_value` | — | 8 |  |
| `words_to_value` | — | 1098 |  |
| `reading_time_to_value_s` | — | 277 |  |
| `max_scroll_before_primary_vh` | — | 375: 0.71 · 1440: 0.19 |  |
| `non_task_elements_to_value` | — | 15 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 793 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 23339 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Where this local copy differs from production (read the findings below with this in mind): built from the commit named here (HEAD of the branch), served by wrangler dev with MODE=saas and SAAS_ENABLED=1 over plain http on 127.0.0.1; Turnstile runs with Cloudflare's documented always-pass test keys; the widget loads from its real host, which the walk lets write (a write-allowed-test surface) so the dummy token can be issued; the sign-in code mail is captured in the Worker log (local send_email simulation) and read from there; the Cloudflare API and DNS-over-HTTPS are the in-memory fakes of the repo (e2e/support/fake-cloudflare.mjs); nothing reaches api.cloudflare.com; INTAKE_DOMAIN and HOSTED_CONNECT_REPORTS=all are set so the shared report address is written (the production default admits only the operator's own workspaces); product analytics is ON: POSTHOG_KEY and POSTHOG_HOST (the US ingestion host) are set and POSTHOG_API_BASE points at a local fake PostHog that keeps every request; this is the configuration under change; the person's DNS host is a zone in the fake that the workspace is not connected to; the TXT proof record and the DMARC record are added there by the walker, as the person would at their own DNS host; the wizard's live reads (onboarding status, the reports panel) go to public DNS, not the fake, and the fake names do not exist there: the browser answers those two responses from what the fake DNS-over-HTTPS returns for the DMARC name, which is what a public resolver would say once the record is published. The Worker's own live read of the DMARC name is therefore not exercised here.
- Analytics was ON during this walk. The fake PostHog received 9 events: Signup Started x2, Signup Code Sent x2, Code Verified x1, Workspace Created x1, Dashboard First Viewed x1, Workspace Active x1, Ownership Verified x1. Nothing on any screen mentions analytics, and no screen, word or step of the flow differs because of it.
- Control run with analytics OFF on the same commit: all 10 steps matched on status, screen, words seen, scroll and overflow measures at both widths, counts, dead ends and every cross-check (timings are not compared).
- Against the baseline of 2026-11-15 (measured by hand on main 6a7d775): the baseline counted 9 screens to the Reports step and the domain field 1.04 (375) and 0.82 (1440) viewport heights down. This walk counts 10 screens to "records live" (it stops at the DMARC step that shows the record published, one step before the Reports screen), 4 typed fields (email, password, code, domain), 8 clicks, 9 decisions (counted per screen) and 1098 words to value; the farthest the next action sits below the first screen at 375 is 0.71 viewport heights.
- Both widths were walked from the plain sign-up address. The link a website visitor arrives by (with a page class and, from the checker, a domain) was not walked: its reading is covered by web/test/signup-source.test.ts and its server side by test/product-analytics/analytics.test.ts, not by this walk.
- The typed domain was not among the analytics events: the fake PostHog received no Domain Added for it. The setup wizard's POST /api/settings/base-domain answers 202 for a pending claim without counting it (src/api/router.ts counts a Domain Added only when the row is inserted at once), so a person who types a domain in the wizard and proves it by TXT enters the manual funnel at Ownership Verified, not at Domain Added. This does not change what the person sees or does.
- The wizard's "Check again" refreshes only the reports panel: the DMARC policy panel above it keeps saying "No DMARC record found" until the page is read again. Not touched by this change (the setup wizard files are as on main).

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
