# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T20:38:31.188Z
- **Target:** https://127.0.0.1:8861 (local-copy)
- **Commit:** ea024c9b13
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (2)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 5: the consent page asks which domains, what the app may do and when access ends on one screen (decisions = 3); step 5: decisions = 3, needs decisions <= 1
- **NOISE-01** (should-fix) Everything visible serves the step — step 4: on the dashboard the person passes through after sign-in: Export PDF and Add domain in the page header

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 5 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 898 |  |
| `reading_time_to_value_s` | — | 226 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 2 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1618 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 10792 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Discovery outside the browser: /llms.txt names the MCP endpoint (yes); /mcp without a token answers 401 with OAuth metadata (Bearer [secret], resource_metadata, scope).
- Turnstile: the browser's request to challenges.cloudflare.com for the always-pass test widget ended net::ERR_ABORTED (guarded browser; sign-in still went through with the test keys).
- Not walkable on a local copy: a real MCP client's own consent redirect (a stub page stood in), real Turnstile that asks for a click, real mail.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record names: this record is <walked date>-<id>.checker-s1.md (the sign-up from the website checker's link, S1 names the domain), next to the pr177b record of the same flow. It was walked at commit ea024c9b13 (the branch head before the records commit); the records commit adds only .flowchad/walks files, so no file the flow covers changes between the walked commit and the records commit (scripts/check-flows.mjs).
- Why this flow: the change in web/src/pages/auth/SignupFlow.tsx is the sign-up S1 line ("You're setting up <domain>." when the link carries a domain), which matches this flow's `web/src/pages/auth/*`. This flow's person does not sign up: they sign in (sign-in mode of AuthPage), and none of the six screens walked here is SignupFlow. The walk was made anyway, as the check asks for a record, and shows the same screens and measures as the previous record.
- This walk: an existing account (brightwave-mail.com imported through the Cloudflare fake, set up before the walk) and an MCP client in a new browser, over https with dynamic client registration on: the authorize link (signed out), "Open the dashboard", sign-in (password, code), the dashboard, the authorize page again (the person reloads the app's tab), the consent page, the domain, "See the domains you select" and "Read email health reports" ticked, Allow access. The client's redirect went to a stub page; its PKCE token exchange, whoami, list_domains and get_email_report then ran outside the browser: a token was issued, list_domains returned only the ticked domain, get_email_report returned a ready-set-mail-health/v1 report with sections dmarc, tls, google, inbox_placement, and a domain that was not ticked was denied. /llms.txt names the MCP endpoint and /mcp without a token answers 401 with OAuth metadata.
- Walked twice at both widths (once with the window starting at 1440x900 and once at 375x812; each step captured at both widths in the same session): the same measures apart from timings, gate PASS with no overrides. The gate record above is the 1440-first run.
- Against the previous record (pr177b, 5a5caed85b): screens 5 and 5, decisions 5 and 5, typed fields 3 and 3, clicks 6 and 6, reading time 226 s and 226 s, max scroll 0 and 0, non-task elements 2 and 2, dead ends and loops 0 and 0. Words: 898 now at both widths against 896 at 1440 and 891 at 375 (+2 and +7: the sign-in screen's status line "Waiting for the human check…" was on screen when it was counted). Waits over a second: 1 against 0 (the code screen, 1.6 s after the password, with the code on its way). Differences in the rough edges: NAV-02 is not listed this time (its pr177b text is about the sign-up screens S2 and S3, which this flow does not pass; the code screen here has "Send a new code" and "Use a different email"), and NOISE-01 is listed for the dashboard the person passes through (Export PDF and Add domain; the count of 2 is the same as before and nothing on that screen changed).
- Per step, at 375 / 1440: words above the action, where the action's bottom sits (in screens, 1 = the bottom of the first screen) and the scroll before the first input (FOLD-01):

| Step | Screen | Action | Words | Words above the action | Action bottom (screens) | Scroll before first input |
|---|---|---|---|---|---|---|
| 1 | authorize-signed-out | Open the dashboard | 49 | 46 / 46 | 0.46 / 0.35 | 0 / 0 |
| 2 | sign-in | Sign in | 22 | 10 / 10 | 0.5 / 0.62 | 0 / 0 |
| 3 | sign-in-code | Continue | 57 | 31 / 31 | 0.52 / 0.6 | 0 / 0 |
| 4 | dashboard | Add domain | 130 | 1 / 0 | 0.21 / 0.15 | 0 / 0 |
| 5 | consent | Allow access | 320 | 287 / 287 | 2.92 / 2.25 | 0 / 0 |
| 6 | consent | Allow access | 320 | 287 / 287 | 2.92 / 2.25 | 0 / 0 |

  The consent page's Allow access sits 2.92 screens down at 375 (2.25 at 1440), below its six permissions and the expiry choices; every input the person must use first (the domains) is on the first screen.
- Not re-walked: the Agents settings page that pr177b observed after the value step (web/src/pages/agent/AgentSetupPage.tsx is not changed by this change).
- Tooling note: the walk used a copy of e2e/support/dev-instance.mjs with `--local-protocol https` (kept outside the repository), because the authorize flow needs https; the gate was run from `.agents/skills/flow-gate/scripts/gate.mjs`.
- Screenshots: 375 px PNGs of every step are committed under .flowchad/walks/checker-s1/agent-connects-and-reads-report/; the 1440 px captures (measured the same way) stay in the walk's out-of-repo evidence folder.

### Screenshots (375 px, light, one per step)

- step 1 `authorize-signed-out`: `.flowchad/walks/checker-s1/agent-connects-and-reads-report/01-authorize-signed-out@375.png`
- step 2 `sign-in`: `.flowchad/walks/checker-s1/agent-connects-and-reads-report/02-sign-in@375.png`
- step 3 `sign-in-code`: `.flowchad/walks/checker-s1/agent-connects-and-reads-report/03-sign-in-code@375.png`
- step 4 `dashboard-after-sign-in`: `.flowchad/walks/checker-s1/agent-connects-and-reads-report/04-dashboard-after-sign-in@375.png`
- step 5 `consent`: `.flowchad/walks/checker-s1/agent-connects-and-reads-report/05-consent@375.png`
- step 6 `consent-chosen`: `.flowchad/walks/checker-s1/agent-connects-and-reads-report/06-consent-chosen@375.png`
