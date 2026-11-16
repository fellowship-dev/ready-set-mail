# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T11:57:11.852Z
- **Target:** http://127.0.0.1:8862 (local-copy)
- **Commit:** ae97122754d42f1564f82e2f59a33c4a7a8afdf0
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (3)

- **NOISE-01** (should-fix) Everything visible serves the step — step 5: overview shows Export PDF, Add domain, 16 status badges and a "Get to your first answer" checklist beside the one action; step 6: the Do this next list, status badges and the DNS records / Email health disclosures sit beside the one action; step 7: the Do this next list, status badges and the DNS records / Email health disclosures sit beside the one action; step 8: the Do this next list, status badges and the DNS records / Email health disclosures sit beside the one action
- **PATH-03** (should-fix) Every step earns its place — two consecutive clicks both labelled "Connect reports" (steps 6 and 7) before the review that holds the one real decision; the overview click could go straight to the review
- **WORD-02** (should-fix) Actions say what happens — step 6 @375: "Connect reports" on the overview row only opens the domain page; the same label there opens the review; the record is written by a third click, "Apply"

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 6 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 4 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 1509 |  |
| `reading_time_to_value_s` | — | 380 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 40 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 831 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 17696 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- After the value moment the page says "Reports for this domain cannot be counted yet. This is on our side; there is nothing for you to do." three times on one screen (panel, Do this next, the Reports line). On this local copy the report-sender check is not configured, so it is true here; on a configured server it may not apply
- The first-screen "Connect Cloudflare" label appears twice on one screen (heading and button), and the same label opens a token form on the next screen: the person is asked to "Connect Cloudflare" and then to paste an API token before anything is connected
- The status chip next to the domain name turns red ("p=none") on the screen that reports success
- Right after the Cloudflare import, three of the four rows say "DNS says [domain] does not exist ... Check the spelling, or remove this domain" for domains the person has just imported from their own Cloudflare account. Here it is true of public DNS (the demo names are not registered), but the domain page for the same name, opened seconds later, says "no SPF and no DMARC record": two screens read the same domain differently within a minute. Cause on this copy: the first check after an import reads the real internet while every later read uses the fake DNS

### Notes

- override for FOLD-01 not used: the rule did not fail
- staleness not checked: no deploy time given and no deploy check configured for the target

### Walk notes (added by the walker; the gate wrote everything above)

- Re-walk on head ae97122 (fix/connect-reports-one-click; the hosted domain page with the Connect reports panel at the top, the Apply review, no self-host-only sections and no SPF flattening on hosted), after the record at 28b610c. `127.0.0.1:8862` is `local-copy @ ae97122`: hosted mode, `HOSTED_CONNECT_REPORTS=all`, fake Cloudflare and fake DNS-over-HTTPS, Turnstile test keys, sign-up code read from the captured mail log. "Connect Cloudflare" is the pasted-token path (no OAuth fake), so there is no consent screen. Billing and report-sender authentication are not configured on this copy. The first DNS check after an import reads real public DNS, not the fake (see the last finding above).
- Fresh headless Chromium at 375x812 and 1440x900, every step captured at both widths: sign-up, code, first screen, Connect Cloudflare, pasted token, overview (4 zones: one with SPF, one p=quarantine pct=50, one p=reject without our rua, one with no DMARC), "Connect reports" on the harbor-lane.org row, domain page with the Connect reports panel, panel click (the review), Apply. The zone then holds `v=DMARC1; p=none; rua=mailto:[report address]` and the DNS-over-HTTPS answer matches.
- Also walked: the p=reject domain without our rua (review says "Only rua= changes", Cancel leaves the zone as it was, refresh closes the review, Apply writes `p=reject` plus our rua=), the p=quarantine; pct=50 review (same sentence, pct kept), wrong code, Back to the overview, a domain id that is not in the workspace.
- Against the 28b610c record (its snapshot was not kept, so the gate table has no previous column), identical: screens 6, decisions 4, fields 4, clicks 6, waits 0, dead ends 0, loops 0, max scroll before the primary action 0 at both widths, the three known rough edges (NOISE-01, PATH-03, WORD-02) and the three not-covered findings. Different: words to value 1509 (1530), reading time 380 s (386), longest wait 831 ms (607; the Apply wait, as before the slowest step), judged non-task elements 40 (51; I counted the sidebar and the footer links out and the per-screen buttons and disclosures in, so this is a different count, not a cleaner screen), time to value 17.7 s (3.1 s; this walk waits for the human check and for the mail log before typing the code, which the earlier walk did not). Nothing the person sees on the path got longer or shorter in steps, fields, clicks or decisions.
- New finding on this walk: the overview's first read of the imported domains ("DNS says ... does not exist"), see above. The code that reads it (src/domains/service.ts and src/api/router.ts call recordFirstDnsCheck without the test resolver) is not in the diff from 28b610c to ae97122. Not checked at 28b610c.
- Console and network noise: 401 on /api/me before sign-in, 404 on /api/billing (billing not set up here), one aborted GET to the Turnstile challenge. No write was blocked by the guard. No video recorded.
