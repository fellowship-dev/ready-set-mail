# Walk record: invited-teammate-joins

- **Flow:** Invited teammate joins the workspace and sees its domains
- **Value moment:** The teammate (a read-only member unless invited as admin) sees the workspace's domains with each one's verdict
- **Walked:** 2026-11-16T21:47:31.511Z
- **Target:** http://127.0.0.1:8852 (local-copy)
- **Commit:** 37de17df8e8d0521c4ca8b0af4169b97c72ec70c
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: two decisions on the members screen: the email and the role (prefilled with read-only member); step 1: decisions = 2, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 3 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 535 |  |
| `reading_time_to_value_s` | — | 135 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 805 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 6491 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- A screen can show its result a few pixels below the first screen (the invite link at 375) while the action that made it is in view.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
### Record notes (MTA-STS round 2)

- Why this record: `src/api/router.ts` changed again in this pull request (the MTA-STS handler now receives the instance-owner flag, and the domain removal answer carries `mta_sts` when a policy is retiring); no invite, sign-in, code or hand-off route is touched. A walk was preferred to a reasoned not-affected record.
- How it was run: `node /workspace/notes/walk/invited.mjs` starts `e2e/support/dev-instance.mjs` `startInstance` (wrangler dev, MODE=saas, hosted, plain http on 127.0.0.1:8852) from the dashboard built at the walked commit, with the in-memory fake Cloudflare; Turnstile uses the always-pass test keys; the owner signs up and imports a zone, invites `teammate@quietfield.net` as a read-only member (step 2 types the email and creates the link), and the teammate joins in a second browser context (the join form, the code read from the Worker log, the overview). Both widths (375 and 1440) were measured after each step.
- Words on the path (first width): 67, 114, 50, 24, 268 = 535 after the merge of PR 183. The primary element of the last step is the verdict sentence of the overview (a read-only member has nothing to press there). Screenshots are in `/workspace/notes/shots-r2/invited/` (out of the repository).
- Gate: `node .agents/skills/flow-gate/scripts/gate.mjs /workspace/notes/shots-r2/invited/results.json --target http://127.0.0.1:8852 --record .flowchad/walks`, PASS, no overrides, exit 0.

- Re-walked at the merge commit of PR 183 into this branch (37de17d); measures unchanged for the MTA-STS flow, the invite overview grew to 280 words (535 on the path) from main's own changes.
