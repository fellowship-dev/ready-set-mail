# Walk record: connect-reports-cloudflare

- **Flow:** A hosted owner connects a verified domain's reports through Cloudflare
- **Value moment:** Reports connected, waiting for the first report - the live DMARC record lists the shared report address and the domain is connected
- **Walked:** 2026-11-16T17:49:34.928Z
- **Target:** http://127.0.0.1:8931 (local-copy)
- **Commit:** 7d03993f647e0179923a808a468d98a586a008f6
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
| `screens_to_value` | — | 1 |  |
| `decisions_to_value` | — | 1 |  |
| `fields_to_value` | — | 0 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 688 |  |
| `reading_time_to_value_s` | — | 173 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 2 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 0 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 5674 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record name: `<date>-connect-reports-cloudflare.round2.md`: the walk after the review fixes of PR #183 (one function writes the report address; the panel sends a reviewed hash and a choice; our address is only the first or second address).
- Walked by a script outside the repository (a Playwright harness over the skill's own `guard.mjs` and `measure.mjs`, fresh headless Chromium) on a real local hosted instance of the commit above (`e2e/support/dev-instance.mjs`, `wrangler dev --local`, the fake Cloudflare answering DNS-over-HTTPS from its records): `HOSTED_CONNECT_REPORTS=all`, `INTAKE_DOMAIN=rua.readysetmail.com`, a verified domain linked to the fake zone through a Cloudflare connection, live record `v=DMARC1; p=reject;`, no report address. 3 steps at 1440x900 and 375x812, a non-operator owner, no billing (so no offer card on the page).
- Measures: no billing on this instance, so no offer card is on the page and the panel is first under the header: the Connect reports button's bottom is 0.70 / 0.52 viewport heights at 375x812 / 1440x900 with 9 words above it; the review's Apply bottom is 0.87 / 0.65 with 49 words above it (the panel stays first once a review is open). With the offer on the page (the buy flow) the panel follows the offer and the steps, and the "Do this next" step's button presses the panel's. 2 clicks (Connect reports, Apply), 0 typed fields. Live record at the end: `v=DMARC1; p=reject; rua=mailto:rua@rua.readysetmail.com` (only rua= added).
- Other states of the same panel, walked on the same build (screenshots in the evidence folder `/workspace/shots/round2/states-*`): the review right after Connect, "Written to Cloudflare; public DNS can take a few minutes to show it" while public DNS still shows the old record, the changed-record screen (the record changed after the review: 409, "The record changed since you looked: here it is now", the fresh record, one Apply; nothing was written until the fresh Apply, which kept the policy and the third-party address), a write failure at 375 (the error is the first thing in the panel, above the state), two addresses (replace the first or the second, or leave the record as it is; no third) and the domain page of a domain with no Cloudflare connection (manual).
- Where this differs from production: the domain is verified by a pasted token on the fake; the live record is held by the fake; `HOSTED_CONNECT_REPORTS=all`; sign-in codes read from the Worker log; Turnstile test keys.
