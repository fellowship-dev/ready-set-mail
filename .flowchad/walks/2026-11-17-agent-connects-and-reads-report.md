# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T06:15:51.002+00:00
- **Target:** https://127.0.0.1:8870 (local-copy)
- **Commit:** 7e55dc1433fd8ebb9e0e0ec5b96037bd9c7e93ad
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (8)

- **AGENT-04** (should-fix) Errors and exit codes an agent can act on — step 14: a tool outside the grant answers "resource or capability not authorized": no cause (which grant is missing) and no fix; a replayed authorization code answers 400 "Authorization code already used" and the access token it made stops working
- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 9: decisions = 4, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 9: one domain exists and a report is the goal, yet nothing is pre-ticked (domain, actions); three ticks are needed before Allow access works. Deliberate for a self-registered client, still a cost
- **ERR-02** (should-fix) Errors say what happened and how to fix it — step 4: signing in with a wrong credential answers "invalid credentials" with no fix, and the status line "Waiting for the human check…" stays beside it
- **FOLD-02** (should-fix) Secondary content sits beside or below — step 9 @1440: above the first domain checkbox sit three identity lines and a warning box (Name it gives, Access goes to, You are signed in as, This sends access to an app on your own computer); step 9 @375: the identity lines and the warning box fill the first screen; the first checkbox sits just above the bottom edge of the 812 px screen
- **NAV-04** (should-fix) Leaving the flow brings you back — step 8: after sign-in the person lands on the dashboard home, not the connection they left; nothing on it mentions the app, and the way back is the browser Back button
- **NOISE-01** (should-fix) Everything visible serves the step — step 8: checklist, notice and six-item menu on a screen the person only passes through; step 9: "Also allow one domain that is not added yet" and four permissions the first report does not need
- **PATH-03** (should-fix) Every step earns its place — step 8: the dashboard home after sign-in neither collects anything the report needs nor delivers part of it; sign-in could happen on the page that asked for it

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 9 |  |
| `decisions_to_value` | — | 8 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 7 |  |
| `words_to_value` | — | 2174 |  |
| `reading_time_to_value_s` | — | 548 |  |
| `non_task_elements_to_value` | — | 15 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 1306 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 16701 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- A sign-in detour that drops the pending request: the screen says to sign in and "come back to this tab and reload it", but its link opens the home screen in the same tab, the home screen does not mention the waiting request, and return depends on the browser Back button.
- On the permission screen the bottom of Allow access is 1.2 viewport heights below the fold at 1440 and 1.9 at 375 (340 words on the page), while the first input is visible, so FOLD-01 passes.
- A stale status line stays visible beside an error ("Waiting for the human check…" next to "invalid credentials").
- Using an authorization code twice also invalidates the access token that the first use returned; the second caller is told only that the code was used.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
### Walk context

- Surface: `local-copy` of 7e55dc1 (branch hosted-plan-payg, source unchanged by the walk), fresh Chromium at 1440 and 375, write guard on, two local hosts declared writable (the Worker and the stand-in client's callback), no write blocked.
- Differs from production: hosted mode with Turnstile test keys; HTTPS with a self-signed certificate; client self-registration switched on; Cloudflare, public DNS and Stripe are local fakes (the domain has no SPF or DMARC there); the sign-in code is read from the captured mail log; the MCP client is a script with a loopback callback, so the consent page shows an unverified app on the person's own computer; the domain row and 30 days of aggregate reports were inserted by SQL and the report says intake is not configured, so its aggregate evidence section was not exercised.
- Steps: the flow file's four steps were walked as 14 recorded steps. The flow file's step 3 (`button[type=submit]` on the first screen after `/mcp`) does not match the product: that screen is a link, "Open the dashboard", and the submit button is on the sign-in screen after it.
- Judgement calls a reviewer may flip: step 8 (home screen after sign-in) is recorded `dead_end: false` because the previous screen told the person to come back and the browser Back button returns to the consent page; marked `true`, ERR-01 would fail and the gate would say FAIL.
- Walker pause: 2.5 s at step 6 waiting for the human-check widget; included in `time_to_value_ms`.
- No video recorded; screenshots are local and git-ignored.
