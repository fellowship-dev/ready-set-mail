# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T04:34:31.249Z
- **Target:** http://127.0.0.1:8862 (local-copy)
- **Commit:** 28b610cbd375930f2ba7fe9c7f674051c7f75bf0
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (3)

- **NOISE-01** (should-fix) Everything visible serves the step — step 5: overview shows Export PDF, Add domain, 16 status badges and a "Get to your first answer" checklist beside the one action; steps 6-8 keep the Do this next list, status badges and three disclosures beside the review
- **PATH-03** (should-fix) Every step earns its place — two consecutive clicks both labelled "Connect reports" (steps 6 and 7) before the review that holds the one real decision; the overview click could go straight to the review
- **WORD-02** (should-fix) Actions say what happens — step 6 @375: "Connect reports" on the overview row only opens the domain page; the same label there opens the review; the record is written by a third click, "Apply"

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 6 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 4 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 1530 |  |
| `reading_time_to_value_s` | — | 386 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 51 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 607 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 3139 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- After the value moment the page says "Reports for this domain cannot be counted yet. This is on our side; there is nothing for you to do." twice (also in Do this next). On this local copy the report-sender check is not configured, so it is true here; on a configured server it may not apply
- The first-screen "Connect Cloudflare" label appears twice on one screen (heading and button), and the same label opens a token form on the next screen: the person is asked to "Connect Cloudflare" and then to paste an API token before anything is connected
- The status chip next to the domain name turns red ("p=none") on the screen that reports success

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
### Walk notes (added by the walker; the gate wrote everything above)

- Re-walk on the merged head 28b610c (fix/connect-reports-one-click merged with origin/main, product analytics included), after the earlier walk at 5c4b7b1. `127.0.0.1:8862` is `local-copy @ 28b610c`: hosted mode, `HOSTED_CONNECT_REPORTS=all`, fake Cloudflare and fake DNS-over-HTTPS, Turnstile test keys, sign-up code read from the captured mail log. "Connect Cloudflare" is the pasted-token path (no OAuth fake), so there is no consent screen. Billing and report-sender authentication are not configured on this copy.
- Fresh headless Chromium at 375x812 and 1440x900, every step captured at both widths: sign-up, code, first screen, Connect Cloudflare, pasted token, overview (4 zones), "Connect reports" on the harbor-lane.org row, domain page, "Connect reports" panel, Apply review, Apply. The zone then holds `v=DMARC1; p=none; rua=mailto:[report address]` and the DNS-over-HTTPS answer matches. A `p=reject` domain without our rua, Cancel on the review, refresh and Back were also walked.
- Every measure in the table above equals the 5c4b7b1 walk (its snapshot was not kept, so the gate table has no previous column): screens 6, decisions 4, fields 4, clicks 6, words 1530, non-task 51, longest wait 607 ms; the analytics merge changed nothing the person sees on this path. Against the 2026-11-15 baseline of main 6a7d775: screens 6 (7), typed fields 3 plus a pasted token (same), clicks 6 (6 plus consent), decisions 4 (4), max scroll before the action at 375: 0 on every step (2.52 for "Fix <domain>"), 16 status badges on the overview (14).
- Console and network noise: 401 on /api/me before sign-in, a 400 on the deliberate wrong-code probe, 404 on /api/billing (billing not set up here). No write was blocked by the guard. No video recorded.
