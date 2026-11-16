# Walk record: enable-mta-sts

- **Flow:** Hosted owner turns on MTA-STS and sees TLS reports arrive
- **Value moment:** The first TLS report is on the page (reporter, period, successful and failed sessions) while MTA-STS is on in testing mode
- **Walked:** 2026-11-16T16:59:52.609Z
- **Target:** http://127.0.0.1:8851 (local-copy)
- **Commit:** 2afc3d378b1be092d59735a7d241cbe2f11426cc
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (3)

- **FOLD-02** (should-fix) Secondary content sits beside or below — step 1 @375: before the action the main column shows a four-line explanation, the MX hosts and a three-line paragraph (the records follow below it)
- **FOLD-03** (should-fix) One dominant action — step 3: the Testing screen has no filled action: its only action, Check now, is quiet because the next step is time, not a press; step 4: the reports screen has no filled action; Switch to enforce is quiet and disabled until the reports allow it
- **NOISE-01** (should-fix) Everything visible serves the step — step 4: not needed for reading the reports: the Check now button and the last-checked line

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 1 |  |
| `decisions_to_value` | — | 0 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 1091 |  |
| `reading_time_to_value_s` | — | 275 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 1 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 219 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 10839 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The door: the MTA-STS card sits under DNS tools at the bottom of the domain page, below its first screen at both widths (its button was 0.58 viewport heights below the first screen at 1440 and 1.42 at 375, measured on a signed-in owner's domain page); it is not a step of this flow, so the gate does not judge it. Its words are covered by web/test/mta-sts.test.tsx and e2e/mta-sts.spec.ts.
- A status screen whose only next step is time (waiting for a certificate, waiting for a sender's report) has no obvious thing to press; the rules ask for one dominant action per screen and cannot say that sometimes the right answer is to wait.
- The page checks by itself every 30 seconds while setup is waiting (the same check as the button), so a person who leaves it open sees it finish; the walk pressed Check now and did not watch the page do it.
- The domain page shows the MTA-STS card only after the DNS tools section is opened, at its bottom: discoverability of a capability that is off is not something the rules measure.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (how it was run)

- `node /workspace/notes/walk/mta.mjs` starts `e2e/support/dev-instance.mjs` `startInstance` (wrangler dev, hosted, MODE=saas, over plain http on 127.0.0.1:8851) from the dashboard built from this branch's HEAD. Cloudflare's API is the in-memory fake `e2e/support/fake-cloudflare.mjs` (zones, DNS records, custom hostnames, worker routes, `/__activate` to issue the certificate) through `CLOUDFLARE_API_BASE_URL`, and DNS-over-HTTPS is the fake's resolver through `DOH_BASE_URL`; nothing reaches api.cloudflare.com or a live instance. Turnstile uses Cloudflare's always-pass test keys; the sign-up code is read from the Worker log.
- The walk signs up, adds a domain with proven ownership and a Cloudflare connection to its fake zone, then walks the four steps at 375 and 1440: open the page, Turn on in testing mode, Check now after the certificate is issued, and the page with a TLS report that arrived through the real intake (the report is posted to the Worker's intake route).
- Truth checks compare the page with independent sources: the MX hosts against a DNS-over-HTTPS answer, the written records against the fake Cloudflare zone, the policy by a real HTTP request carrying the policy host's name, the published id against DNS, the report row against the database.
- Gate: `node .agents/skills/flow-gate/scripts/gate.mjs <results.json> --target http://127.0.0.1:8851 --record .flowchad/walks`, PASS, no overrides, exit 0.
- Screenshots of every step at 375 and 1440 are in `/workspace/notes/shots/` (out of the repository).
