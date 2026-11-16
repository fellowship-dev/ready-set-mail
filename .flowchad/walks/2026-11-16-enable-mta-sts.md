# Walk record: enable-mta-sts

- **Flow:** Hosted owner turns on MTA-STS and sees TLS reports arrive
- **Value moment:** The first TLS report is on the page (reporter, period, successful and failed sessions) while MTA-STS is on in testing mode
- **Walked:** 2026-11-16T20:53:47.909Z
- **Target:** http://127.0.0.1:8851 (local-copy)
- **Commit:** 94e3840b0c2bdec4fa92bea68c0d629e8c0e6792
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **FOLD-03** (should-fix) One dominant action — step 3 @375: the filled action, Switch to enforce, is disabled until the reports allow it: the screen has no action to press yet, only time to wait; step 4 @375: the same: Switch to enforce is the filled action and is disabled until seven days and a signed report allow it

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 0 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 333 |  |
| `reading_time_to_value_s` | — | 84 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 920 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 4395 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The door: the MTA-STS card sits under DNS tools at the bottom of the domain page, below its first screen at both widths; it is not a step of this flow, so the gate does not judge it. Its words are covered by web/test/mta-sts.test.tsx and e2e/mta-sts.spec.ts.
- A status screen whose only next step is time (waiting for a certificate, for seven days of testing, for a sender's report) has no obvious thing to press; the rules ask for one dominant action per screen and cannot say that sometimes the right answer is to wait.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (how it was run, round 2)

- `node /workspace/notes/walk/mta.mjs` starts `e2e/support/dev-instance.mjs` `startInstance` (wrangler dev, hosted, MODE=saas, plain http on 127.0.0.1:8851) from the dashboard built at the walked commit, with the in-memory fake Cloudflare of `e2e/support/fake-cloudflare.mjs` (zones, DNS records, custom hostnames, routes, `/__activate` to issue the certificate) behind `CLOUDFLARE_API_BASE_URL`; nothing reaches api.cloudflare.com or a live instance. The policy fetch (`POLICY_FETCH_BASE_URL`, localhost only) goes to a local stand-in that asks the Worker with the policy host's name, and only once the fake custom hostname's certificate is active (before that the fetch fails like a TLS error, so "served" really is a fetch).
- The walk signs up, adds `quietfield.net` (a fake zone with an MX at its apex) with a Cloudflare connection, then walks the four steps at 1440 and 375: open the page, Turn on in testing mode, Check now after the certificate is issued, and the page after a **signed** report arrived through the Worker's email handler (a passing DKIM result from the receiving server, Google's TLS address and contact-info, the TLS-Report-Submitter header; counted as `google`).
- Truth checks: the written records against the fake zone, the policy by a real HTTP request carrying the policy host's name (200 `text/plain`, testing, `max_age: 86400`), the published `_mta-sts` id in the zone, no Check now button left once served, and the report row against the database (tier counted, identity google, 45 and 3 sessions).
- Words on the path (the walk's measure, first width): 50, 43, 115, 125 = 333, down from 1,054 (round 1). Action position: 0 viewport heights at 375 and 1440 on every step; Switch to enforce, the filled action once served, is fully visible on the first screen at 375 (step 3: bottom of the button at 0 vh). Horizontal overflow 0 at both widths.
- Gate: `node .agents/skills/flow-gate/scripts/gate.mjs /workspace/notes/shots-r2/results.json --target http://127.0.0.1:8851 --record .flowchad/walks`, PASS, no overrides, exit 0.
- Screenshots of every step at 375 and 1440 are in `/workspace/notes/shots-r2/` (out of the repository).
