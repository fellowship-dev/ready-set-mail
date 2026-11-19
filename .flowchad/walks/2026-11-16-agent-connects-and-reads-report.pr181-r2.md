# Walk record: agent-connects-and-reads-report

- **Flow:** An AI agent connects by MCP and reads its first email report
- **Value moment:** The agent receives its first useful report (get_email_report)
- **Walked:** 2026-11-16T16:34:23.973+00:00
- **Target:** https://127.0.0.1:8854 (local-copy)
- **Commit:** c1069a7ec60c66e305b4fd0740c252180450c050
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 7 @1440: the consent page asks three groups of answers: the domains, what the app may do, and how long; known from earlier walks of this flow (listed as a rough edge, not overridden); step 7: decisions = 3, needs decisions <= 1; step 8: decisions = 3, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 8 |  |
| `decisions_to_value` | — | 8 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 10 |  |
| `words_to_value` | — | 984 |  |
| `reading_time_to_value_s` | — | 248 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 4 |  |
| `longest_wait_ms` | — | 3167 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 22519 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- After signing in, the screen that sent the person to sign in must be reloaded by hand: it says 'Sign in to the dashboard in this browser, then come back to this tab and reload it'. Nothing in this branch changes it.
- In this local copy the dashboard Overview row for the subdomain agreed with the agent (same next step); after the agent's report call the domain page for the same name said 'Does not resolve / Check the spelling, or remove this domain', because the agent tools read real public DNS (they ignore the fake resolver) and the stored read was replaced. Almost certainly an artifact of the fictional name; not verified in production.
- get_email_report on this local hosted copy says intake is unavailable / not_configured while the same report carries the received counts (245 messages); the intake setting it reads is not set here. Not changed by this branch.
- Reusing an authorization code answers invalid_grant and also revokes the access token issued from it (the agent's next call gets 401 invalid_token); correct under the standard, but nothing tells the agent that.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
