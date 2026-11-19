# Walk record: invited-teammate-joins

- **Flow:** Invited teammate joins the workspace and sees its domains
- **Value moment:** The teammate (a read-only member unless invited as admin) sees the workspace's domains with each one's verdict
- **Walked:** 2026-11-16T16:58:12.731Z
- **Target:** http://127.0.0.1:8852 (local-copy)
- **Commit:** 2afc3d378b1be092d59735a7d241cbe2f11426cc
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: decisions = 2, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 3 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 448 |  |
| `reading_time_to_value_s` | — | 113 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 4 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 0 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 8171 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- A screen can show its result a few pixels below the first screen (the invite link at 375) while the action that made it is in view; the rule measures the first action, not whether the result needs a scroll.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (MTA-STS on the hosted service)

- Why this record: the only file on this flow's `covers:` list that this branch changes is `src/api/router.ts` (the MTA-STS block moved to `src/mta-sts/routes.ts`; no invite, sign-in, code or hand-off route is touched). A walk was preferred to a reasoned not-affected record, and it replaces the earlier not-affected file that carried a date it was not written on.
- How it was run: `node /workspace/notes/walk/invited.mjs` starts `e2e/support/dev-instance.mjs` `startInstance` (wrangler dev, MODE=saas, SAAS_ENABLED=1, hosted, over plain http on 127.0.0.1:8852) from the built dashboard of this branch's HEAD, with the in-memory fake Cloudflare and fake DNS-over-HTTPS; Turnstile uses Cloudflare's always-pass test keys; the owner is signed in with two proven domains; the teammate joins in a second browser context. Both widths (375 and 1440) were measured after each step; the gate was `node .agents/skills/flow-gate/scripts/gate.mjs <results.json> --target http://127.0.0.1:8852 --record .flowchad/walks`, verdict PASS, no overrides.
- Step 2's first action is the Create invite link button (the new link appears just below it, a few pixels under the first screen at 375).
- Screenshots of every step at 375 and 1440 are in `/workspace/notes/shots/` (out of the repository).
