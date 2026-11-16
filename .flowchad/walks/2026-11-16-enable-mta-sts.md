# Walk record: enable-mta-sts

- **Flow:** Hosted owner turns on MTA-STS and sees TLS reports arrive
- **Value moment:** The first TLS report is on the page (reporter, period, successful and failed sessions) while MTA-STS is on in testing mode
- **Walked:** 2026-11-16T23:42:22.256Z
- **Target:** http://127.0.0.1:8851 (local-copy)
- **Commit:** 56fb2118e12f4624febf1adf342dc18464d0d20c
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (0)

- none found by the rules

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 0 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 415 |  |
| `reading_time_to_value_s` | — | 105 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 227 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 40282 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
### Record notes (how it was run, round 3)

- `node /workspace/notes/walk/mta.mjs` (kept outside the repository, like round 2's) starts `e2e/support/dev-instance.mjs` `startInstance` (wrangler dev, hosted, MODE=saas, plain http on 127.0.0.1:8851) from the dashboard built at the walked commit, with the in-memory fake Cloudflare of `e2e/support/fake-cloudflare.mjs` (the customer's zone with an MX at its apex; the operator's zone `readysetmail.com` with the ONE declared route `*/.well-known/mta-sts.txt`; custom hostnames; `/__activate` issues the certificate) behind `CLOUDFLARE_API_BASE_URL`; nothing reaches api.cloudflare.com or a live instance. The policy fetch (`POLICY_FETCH_BASE_URL`, localhost only) goes to a local stand-in that asks the Worker with the policy host's name, and only once the fake hostname's certificate is active.
- The walk signs up through the three screens (S1, S2, the mailed code), connects the fake Cloudflare account by token, and walks the four steps at 1440 and 375: open the page, Turn on in testing mode, Check now after the certificate is issued, and the page after a **signed** report arrived through the Worker's email handler (a passing DKIM result from the receiving server and a DKIM-Signature header, Google's TLS address and contact-info, the TLS-Report-Submitter header; stored as `counted`, `google`).
- Truth checks: the three records in the fake zone; the policy by a real HTTP request carrying the policy host's name (200 `text/plain`, `mode: testing`, `max_age: 86400`); no Check now button once served; a non-policy path that reaches the Worker on a policy host (`/api/domains`) is a 404; the report row (tier counted, identity google, 45 and 3 sessions). The report in the walk ended a few seconds before the policy was published, so step 4 shows the true day-one state: "A verified report arrived, but it covers a period before this policy was published."
- Words on the path (the walk's measure, first width): 50, 43, 154, 168 = **415**, up from 333 in round 2: the whole enforce rule is now shown once (five lines, each Met or Missing, the missing ones with their reason). Action position: 0 viewport heights at 375 and 1440 on every step (the measured action is Switch to enforce, visible but not filled while it cannot be pressed). Horizontal overflow 0 at both widths. The one 401 in the log is the signed-out `GET /api/me` on the sign-up page.
- Gate: `node .agents/skills/flow-gate/scripts/gate.mjs /workspace/notes/shots-r3/results.json --target http://127.0.0.1:8851 --record .flowchad/walks`, PASS, no overrides, exit 0, no known rough edges (round 2 had FOLD-03: a filled action that could not be pressed; Switch to enforce is now filled only when it can be).
- Screenshots of every step at 375 and 1440 are in `/workspace/notes/shots-r3/` (out of the repository).
