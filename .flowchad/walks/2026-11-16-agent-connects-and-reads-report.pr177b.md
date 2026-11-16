# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T12:23:27.767Z
- **Target:** https://127.0.0.1:8860 (local-copy)
- **Commit:** 5a5caed85b
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 5: decisions = 3, needs decisions <= 1
- **NAV-02** (later) Every screen says where you are — step S2: S2 and S3 have no way back except "Start over" (which drops the attempt); the browser Back button works

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 5 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 896 |  |
| `reading_time_to_value_s` | — | 226 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 2 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 0 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 17597 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- This walk (existing account, MCP client, new browser): 4 product screens + 1 consent, 3 typed fields, 51 keystrokes, 6 clicks, 896 words at 1440 / 891 at 375, farthest action bottom at 375 n/a vh. The sign-in form was on screen 192 ms after the click on "Open the dashboard" (hosted sign-in now asks the server once whether a sign-up is pending; the skeleton it shows meanwhile is the only visible change on this flow from this pull request).
- Changed by this pull request on this flow: web/src/pages/auth/* (the sign-up screens, the invitee's code screen, a resume check on the sign-in page) and Turnstile's execute mode, used by sign-up only. The sign-in screens, the code step, the signed-out and consent pages of the agent flow read the same words as on main (compare the 2026-11-15 baseline).
- Not walkable on a local copy: a real MCP client's own consent redirect (a stub page stood in), real Cloudflare Turnstile that asks for a click at sign-in, real mail.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record names: this record is <walked date>-<id>.pr177b.md (round 3 of PR 177), replacing the pr177 record of the same flow. It was walked at commit 5a5caed85b on the branch after merging main at db916a9; no file the flow covers changes between that commit and the records commit (scripts/check-flows.mjs).
- This walk: an existing account (brightwave-mail.com imported through the Cloudflare fake) and an MCP client in a new browser, over https with dynamic client registration on: the authorize link, sign-in (password, code), the consent page (the domain, 'See the domains you select' and 'Read email health reports' ticked), Allow access; the client's PKCE token [secret], whoami, list_domains and get_email_report then answered for brightwave-mail.com (outside the browser). The value step is the person's last click (the client reads the report right after it); the Agents page, observed afterwards, has its first action 0.15 of a screen below the fold at 375 (FOLD-01 would fail there): web/src/pages/agent/AgentSetupPage.tsx is not changed by this pull request, so it is recorded here as an observation, not scored.
- Screenshots: 375 px PNGs of every step are committed under .flowchad/walks/pr177b/agent-connects-and-reads-report/; the 1440 px captures (measured the same way, see the measures above, which cover both widths) and dark captures stay in the walk's out-of-repo evidence folder.

### Screenshots (375 px, light, one per step)

- step 1 `authorize-signed-out`: `.flowchad/walks/pr177b/agent-connects-and-reads-report/01-authorize-signed-out@375.png`
- step 2 `sign-in`: `.flowchad/walks/pr177b/agent-connects-and-reads-report/02-sign-in@375.png`
- step 3 `sign-in-code`: `.flowchad/walks/pr177b/agent-connects-and-reads-report/03-sign-in-code@375.png`
- step 4 `dashboard-after-sign-in`: `.flowchad/walks/pr177b/agent-connects-and-reads-report/04-dashboard-after-sign-in@375.png`
- step 5 `consent`: `.flowchad/walks/pr177b/agent-connects-and-reads-report/05-consent@375.png`
- step 6 `consent-chosen`: `.flowchad/walks/pr177b/agent-connects-and-reads-report/06-consent-chosen@375.png`
- step 7 `agents-page`: `.flowchad/walks/pr177b/agent-connects-and-reads-report/07-agents-page@375.png`
