# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T03:52:32.077Z
- **Target:** http://127.0.0.1:8862 (local-copy)
- **Commit:** 5c4b7b1b81177323e48b1cd10bdbe570bf06bfb2
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
| `time_to_value_ms` | — | 3145 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- After the value moment the page says "Reports for this domain cannot be counted yet. This is on our side; there is nothing for you to do." twice (also in Do this next). On this local copy the report-sender check is not configured, so it is true here; on a configured server it may not apply
- The first-screen "Connect Cloudflare" label appears twice on one screen (heading and button), and the same label opens a token form on the next screen: the person is asked to "Connect Cloudflare" and then to paste an API token before anything is connected
- The status chip next to the domain name turns red ("p=none") on the screen that reports success

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
### Walk notes (added by the walker; the gate wrote everything above)

- Surface: `127.0.0.1:8862` is `local-copy @ 5c4b7b1`: hosted mode, `HOSTED_CONNECT_REPORTS=all`, a fake Cloudflare and fake DNS-over-HTTPS (the same records answer both), Turnstile test keys, sign-up code read from the captured mail log. The "Connect Cloudflare" step is the pasted-token path (any token of 20+ characters; no OAuth fake exists), as in the baseline, so there is no Cloudflare consent screen. Billing is not set up and report-sender authentication is not configured on this copy.
- Walked in fresh headless Chromium at 375x812 and 1440x900 (every step captured at both widths on the same page). Path: sign-up (email, password, bot check) -> 6-digit code -> first screen -> Connect Cloudflare -> pasted token -> overview (4 zones imported) -> "Connect reports" on the harbor-lane.org row -> domain page -> "Connect reports" panel -> Apply review -> Apply. Value step: the page shows "Report address added." and the report address; the fake zone holds `v=DMARC1; p=none; rua=mailto:[report address]` and the DoH answer matches.
- Also checked: a domain at `p=reject` without our rua (review says only `rua=` changes; the zone afterwards holds the same policy plus the rua), Cancel on the review (nothing written), refresh, Back.
- Against the 2026-11-15 baseline of `main` 6a7d775 (that baseline had no results.json, so the gate table has no previous column): screens 6 (baseline 7: Apply is now in the domain page, not its own screen); typed fields 3 plus one pasted token (3 + token); clicks 6 (6 + consent; the sign-up code submits itself at the sixth digit); decisions 4 (4); words on the sign-up screen 55 by `measure.mjs` (baseline 28, counted another way, and sign-up is unchanged by this branch); max scroll before the step's action at 375: 0 on every step (baseline 2.52 for "Fix <domain>"; the "Connect reports" rows sit above 0.85 of the first screen, and the old "Fix" button still sits at 2.86 but is not on the path); the overview lands with 16 status badges for 4 domains (baseline 14); machine time on the clicks 3.1 s (the baseline's 15 s through Apply was counted differently and is not comparable).
- Findings from this branch: the overview and domain page both offer "Connect reports", two clicks before the one real decision (WORD-02, PATH-03). Findings already on `main`: sign-up and first screen are unchanged by this branch; the overview's badge load (NOISE-01).
- Console and network noise: 401 on /api/me before sign-in (expected), a 400 on the deliberate wrong-code probe, 404 on /api/billing on the domain page (billing not set up on this copy). No write was blocked by the guard.
