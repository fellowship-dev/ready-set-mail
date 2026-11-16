# Walk record: invited-teammate-joins

- **Flow:** Invited teammate joins the workspace and sees its domains
- **Value moment:** The teammate (a read-only member unless invited as admin) sees the workspace's domains with each one's verdict
- **Walked:** 2026-11-16T07:22:02.835Z
- **Target:** http://127.0.0.1:8864 (local-copy)
- **Commit:** 33f74b4943
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (3)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: decisions = 2, needs decisions <= 1
- **NOISE-01** (should-fix) Everything visible serves the step — step 5: step 5: Export PDF, the repeated read-only notice and the long "Reports not connected yet" block above the rows; unchanged on main
- **NOISE-03** (should-fix) Words fit the action — step 5: step 5: 225 words, 70 of them the reports-not-connected block before the first domain row (unchanged on main)

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 3 |  |
| `words_to_value` | — | 480 |  |
| `reading_time_to_value_s` | — | 121 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 5 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 0 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 13235 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Where this local copy differs from production (read every finding with this in mind): a throwaway hosted instance on the devbox (wrangler dev --local, MODE=saas, SAAS_ENABLED=1, a fresh local D1) over plain http on 127.0.0.1, built from this commit, not a deployed target; product analytics OFF (no POSTHOG settings); Turnstile runs with Cloudflare's documented always-pass test keys (the widget loads from its real host and issues a dummy token; it never asked for a click); the sign-in code mail is captured in the Worker log (local send_email simulation) and read from there; the Cloudflare API and DNS-over-HTTPS are the in-memory fakes of the repo (e2e/support/fake-cloudflare.mjs); nothing reaches api.cloudflare.com; INTAKE_DOMAIN and HOSTED_CONNECT_REPORTS=all are set so the shared report address is written (the production default, owner, admits only the operator's own workspaces); Cloudflare's consent screen is a local stand-in page (Allow / Cancel, on 127.0.0.1, standing for dash.cloudflare.com) and the OAuth token [secret] is a local stub; the Worker's own redirect, state check, code exchange, connection and import after the return are the real code; the first read of public DNS (the S4 line, the first check the dashboard repeats) goes through the fake DoH and is real code; the domain page and the daily refresh read the real public DNS, where the made-up names do not exist: the browser answers the setup status and the other domains' check summaries as resolving names, the domain being set up is left as the Worker read it.
- This walk (owner creates an invite link, the teammate joins as a member): 4 product screens, 3 typed fields, 50 keystrokes, 3 clicks, 480 words at 1440 / 480 at 375, farthest action bottom at 375 0.88 vh; the owner's two screens (Members, link) and the teammate's three (invite, code, overview).
- Also walked, the hand-off to a teammate (the owner hands over setup of brightwave-mail.com; the admin teammate lands on that domain's S4): 9 product screens, 9 typed fields, 151 keystrokes, 9 clicks, 615 words at 1440 / 576 at 375, farthest action bottom at 375 0.96 vh for the whole of it (owner: S1-S4, H1, H1 sent, H2; teammate: I1, code, S4). Steps: S1-signup, S2-about, S3-code, S4-domain-empty, S4-result-cloudflare, H1-handoff, H1-sent, H2-inviter-dashboard, I1-invite, I1-code, I1-landing-S4, H2-after-join.
- Not walkable on a local copy: the hand-off email in a real inbox (the Worker logs it; its link was read from the captured mail), real delivery and spam placement.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
