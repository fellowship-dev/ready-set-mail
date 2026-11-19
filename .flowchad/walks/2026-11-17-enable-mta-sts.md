# Walk record: enable-mta-sts

- **Flow:** Hosted owner turns on MTA-STS and sees TLS reports arrive
- **Value moment:** The first TLS report is on the page (reporter, period, successful and failed sessions) while MTA-STS is on in testing mode
- **Walked:** 2026-11-17T01:41:33.699Z
- **Target:** http://127.0.0.1:8851 (local-copy)
- **Commit:** 27da30a05d7544b9eb61be27f3d8b6c6bc28ae59
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
| `words_to_value` | — | 429 |  |
| `reading_time_to_value_s` | — | 108 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 219 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 7802 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target
### Record notes (how it was run, round 4)

- Same setup as round 3 (a local hosted copy: `wrangler dev` with MODE=saas, plain http on 127.0.0.1:8851, the dashboard built at the walked commit; the in-memory fake Cloudflare of `e2e/support/fake-cloudflare.mjs` with the customer's zone quietfield.net (an MX at its apex) and the operator's zone with the ONE declared route; the policy fetch goes through `POLICY_FETCH_BASE_URL` to a local stand-in that asks the Worker with the policy host's name, once the fake hostname's certificate is active). The walk script is kept outside the repository, like the earlier rounds'; sign-up goes through the three screens, the domain question and the Cloudflare token path (not steps of the flow).
- The four steps at 1440 and 375: the page, Turn on in testing mode, Check now after the certificate is issued, the page after a **signed** report arrived through the Worker's email handler (stored as `counted`, `google`, 45 and 3 sessions). Words on the path (first width): 50, 43, 164, 172 = **429** (421 in round 3: "Checked <time>" and the small Check now on step 3). Action position 0 viewport heights at both widths on every step; overflow 0 px. The one 401 in the log is the signed-out `GET /api/me` on the sign-up page.
- Truth checks: the policy fetched with the policy host's name answers 200 `text/plain` with the published text; the report row is counted/google.
- The two states of this round, captured after the four steps (the row's last check aged by an hour in the database, then the page opened): with the stand-in answering 404 the page says "The policy cannot be reached", the policy address does not answer with the policy yet, "Checked <time of the walk>", a Check now, and the enforce line "The policy is served" is Missing ("The policy cannot be reached right now."); Check now with the stand-in answering again restored "Served at". With the stand-in not answering at all (the Worker's 4 second timeout) the page says "Could not check just now. Last known: served at <policy address>, checked <time an hour before the walk>." and the enforce line is Missing ("The policy could not be checked just now."). No "Served at" in either state. Screenshots of every step and of both states at 375 and 1440 are in `/workspace/notes/shots-r4/` (out of the repository).
- Gate: `node .agents/skills/flow-gate/scripts/gate.mjs /workspace/notes/shots-r4/results.json --target http://127.0.0.1:8851 --record .flowchad/walks`, PASS, no overrides, exit 0, no known rough edges.
