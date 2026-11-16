# Walk record: connect-reports-cloudflare

- **Flow:** A hosted owner connects a verified domain's reports through Cloudflare
- **Value moment:** Reports connected, waiting for the first report - the live DMARC record lists the shared report address and the domain is connected
- **Walked:** 2026-11-16T13:55:34.823Z
- **Target:** http://127.0.0.1:8908 (local-copy)
- **Commit:** 7c8df4e27c
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **NOISE-01** (should-fix) Everything visible serves the step — step 1: besides the single action sit the policy badge, an Analytics and a Settings button, the operator settings banner (operator walk only) and, in "Do this next", a second "Connect reports so senders can be confirmed" item; the step does not need them

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 3 |  |
| `decisions_to_value` | — | 1 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 688 |  |
| `reading_time_to_value_s` | — | 173 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 866 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 4979 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- The state the person just reached moves on a reload: right after Apply the status panel is what the page shows; after a reload the same status sits lower, below the next-steps list.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record name: `<walked date>-<id>.after177.md` (the walk after PR 177 merged). It was walked at commit 7c8df4e27c on the branch after merging main at 61e6b8f; no file the flow covers changes between that commit and the commit that adds this record (scripts/check-flows.mjs).
- Walked by a script outside the repository (a Playwright harness over the skill's own `guard.mjs` and `measure.mjs`) on a local copy of commit 7c8df4e27c: hosted mode, `HOSTED_CONNECT_REPORTS=all`, a verified domain linked to the Cloudflare fake, live record `v=DMARC1; p=reject;`; 3 steps at 1440x900 and 375x812 as a non-operator. The review is the shared change card (`RecordChange.tsx`).
- The first-screen measures (same script, same state), at the new head: bottom of the Connect reports button, in viewport heights from the top of the page, 375x812 / 1440x900: non-operator 0.70 / 0.52 (93 words of `<main>` above it), operator (settings banner above every page) 0.83 / 0.64 (213 words above it). From the domain page to "waiting for the first report": 2 clicks (Connect reports, Apply), no typed address. The live record at the end: `v=DMARC1; p=reject; rua=mailto:rua@rua.readysetmail.com` (the policy unchanged, only rua= added). Before this branch, at v2.0.0: 2.54 / 1.49 (operator), 1.97 / 1.26 (non-operator), 225 to 345 words, 5 clicks and 3 scrolls or 1 click and 1 typed address.
- Where this differs from production: the domain is verified by a Cloudflare connection (token path on the fake) and linked to its zone; its live record is held by the fake and read through the fake DNS-over-HTTPS; `HOSTED_CONNECT_REPORTS=all`; sign-in codes read from the Worker log; the always-pass Turnstile test keys.
- Screenshots: 375 px PNGs of every step are committed under `.flowchad/walks/after177/connect-reports-cloudflare/`; the 1440 px captures and the walk's `results.json` stay in the walk's out-of-repo evidence folder.

### Screenshots (375 px, light, one per step)

- step 1 `domain page`: `.flowchad/walks/after177/connect-reports-cloudflare/01-domain-page.png`
- step 2 `review of the change`: `.flowchad/walks/after177/connect-reports-cloudflare/02-review.png`
- step 3 `waiting for the first report`: `.flowchad/walks/after177/connect-reports-cloudflare/03-apply.png`
