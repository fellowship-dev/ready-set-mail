# Walk record: agent-connects-and-reads-report

- **Flow:** MCP client authorised, reads the report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T10:38:21.151Z
- **Target:** http://127.0.0.1 (write-allowed-test)
- **Commit:** 48d3a1b4ac49c6512cb0ef31e2edc98b570b0cc8
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 5: consent asks domains, what the app may do and how long: one group of related choices; unchanged by this pull request; step 5: decisions = 3, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 5 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 3 |  |
| `words_to_value` | — | 604 |  |
| `reading_time_to_value_s` | — | 152 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 0 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Where this local copy differs from production (read every finding with this in mind): a throwaway hosted instance on a devbox (wrangler dev --local, MODE=saas, SAAS_ENABLED=1, fresh local D1), built from the commit named above, not a deployed target; Turnstile runs with Cloudflare's documented always-pass test keys (it never asked for a click); sign-in code mail is captured in the Worker log; the Cloudflare API and DNS-over-HTTPS are the in-memory fakes of the repo (e2e/support/fake-cloudflare.mjs) and nothing reaches api.cloudflare.com; INTAKE_DOMAIN and HOSTED_CONNECT_REPORTS=all are set so the shared report address is written (the production default, owner, admits only the operator's own workspaces); Cloudflare's consent screen is a local stand-in page (Allow / Cancel) and the OAuth token is a local stub, while the Worker's own redirect, state check, code exchange and import are the real code; the domain page and the daily refresh read the real public DNS, where the made-up names do not exist (harbor-lane.org shows 'Needs attention' for that reason only).
- Record names: this record is <walked date>-<id>.pr177.md. The 2026-11-16 records of PR 178 are already in the base commit, and PR 181 adds same-day records for some of these flows, so this pull request's records carry the tag pr177 (scripts/check-flows.mjs allows <date>-<id>.<tag>.md). The Walked line is the real time of the walk, at the commit named above (round 3 of the review of PR 177); the code after that commit is documentation and these records only.
- Screenshots: 375 px PNGs of every step of this walk are committed under .flowchad/walks/pr177/<flow id>/; 1440 px and dark captures are in the walk's out-of-repo evidence folder, not committed.
- This walk: an existing account (brightwave-mail.com imported through the Cloudflare fake) and an MCP client in a new browser, over https with dynamic client registration on: /llms.txt, sign-in (password, code), the consent page (domain and 'Read email health reports' ticked), Allow access; the client's PKCE token [secret], whoami and get_email_report then answered for brightwave-mail.com (outside the browser). Changed by this pull request on this flow: only web/src/pages/auth/* (the sign-up screens and the code screen the invite shares); the sign-in form, the consent page and src/mcp are unchanged. A real MCP client's redirect and real Turnstile are not walkable here (a stub stood in for the client's redirect page).

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Screenshots (375 px, light, one per step)

- step 1 `llms-txt`: `.flowchad/walks/pr177/agent-connects-and-reads-report/01-llms-txt@375.png`
- step 2 `signed-out`: `.flowchad/walks/pr177/agent-connects-and-reads-report/02-signed-out@375.png`
- step 3 `sign-in`: `.flowchad/walks/pr177/agent-connects-and-reads-report/03-sign-in@375.png`
- step 4 `sign-in-code`: `.flowchad/walks/pr177/agent-connects-and-reads-report/04-sign-in-code@375.png`
- step 5 `consent`: `.flowchad/walks/pr177/agent-connects-and-reads-report/05-consent@375.png`
