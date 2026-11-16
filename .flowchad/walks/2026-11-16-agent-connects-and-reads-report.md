# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T07:32:59.765Z
- **Target:** https://127.0.0.1:8860 (local-copy)
- **Commit:** 33f74b4943
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 5: consent asks domains, what the app may do and how long access lasts: one group of related choices, three decisions by count; the consent page is unchanged by this pull request; step 5: decisions = 3, needs decisions <= 1
- **NAV-02** (later) Every screen says where you are — step S2: S2 and S3 have no way back except "Start over" (which drops the attempt); the browser Back button works

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 5 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 5 |  |
| `words_to_value` | — | 612 |  |
| `reading_time_to_value_s` | — | 154 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 2 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 0 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 18520 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Where this local copy differs from production (read every finding with this in mind): Turnstile runs with Cloudflare's documented always-pass test keys (the widget loads from its real host and issues a dummy token; it never asked for a click); the sign-in code mail is captured in the Worker log (local send_email simulation) and read from there; the Cloudflare API and DNS-over-HTTPS are the in-memory fakes of the repo (e2e/support/fake-cloudflare.mjs); nothing reaches api.cloudflare.com; INTAKE_DOMAIN and HOSTED_CONNECT_REPORTS=all are set so the shared report address is written (the production default, owner, admits only the operator's own workspaces); Cloudflare's consent screen is a local stand-in page (Allow / Cancel, on 127.0.0.1, standing for dash.cloudflare.com) and the OAuth token [secret] is a local stub; the Worker's own redirect, state check, code exchange, connection and import after the return are the real code; the first read of public DNS (the S4 line, the first check the dashboard repeats) goes through the fake DoH and is real code; the domain page and the daily refresh read the real public DNS, where the made-up names do not exist: the browser answers the setup status and the other domains' check summaries as resolving names, the domain being set up is left as the Worker read it; this instance is served over https (wrangler's local certificate) with dynamic client registration on, and the app's redirect page is a stub.
- This walk (existing account, MCP client, new browser): 5 product screens, 3 typed fields, 51 keystrokes, 5 clicks, 612 words at 1440 / 607 at 375, farthest action bottom at 375 2.92 vh. The sign-in form was on screen 209 ms after the click on "Open the dashboard" (hosted sign-in now asks the server once whether a sign-up is pending; the skeleton it shows meanwhile is the only visible change on this flow from this pull request).
- Changed by this pull request on this flow: web/src/pages/auth/* (the sign-up screens, the invitee's code screen, a resume check on the sign-in page) and Turnstile's execute mode, used by sign-up only. In `web/src/pages/auth/AuthPage.tsx` only the sign-up branch moved out (to SignupFlow) and the resume check was added; the sign-in form, its code step (CodeForm), the signed-out page and the consent page are the same code as on main, and the consent page reads 319 words here against 322 in the 2026-11-15 baseline (the difference is the number of domains listed). The baseline recorded the consent page only, not the sign-in words.
- Not walkable on a local copy: a real MCP client's own consent redirect (a stub page stood in), real Cloudflare Turnstile that asks for a click at sign-in, real mail.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
