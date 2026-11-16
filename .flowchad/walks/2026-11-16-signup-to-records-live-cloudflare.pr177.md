# Walk record: signup-to-records-live-cloudflare

- **Flow:** Cloudflare, cold, company
- **Value moment:** Apply wrote the DMARC record with the report address; the dashboard says what happens next
- **Walked:** 2026-11-16T10:29:54.070Z
- **Target:** http://127.0.0.1 (write-allowed-test)
- **Commit:** 48d3a1b4ac49c6512cb0ef31e2edc98b570b0cc8
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (5)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: S2: name, organization, whose email, optional role, optional where-heard (owner decision); step 2: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: optional role and where-heard stay on S2 by the owner decision
- **ERR-03** (should-fix) Errors keep what was typed — step 2: S2 answers survive Start over (this tab) but are lost on a reload
- **NAV-02** (later) Every screen says where you are — step 2: S2/S3 have no back except Start over; browser Back works
- **NOISE-01** (should-fix) Everything visible serves the step — S2 two optional fields; S4 aside at 1440; D1 Export PDF/Add domain and the other imported domains under the card

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 6 |  |
| `fields_to_value` | — | 6 |  |
| `clicks_to_value` | — | 7 |  |
| `words_to_value` | — | 452 |  |
| `reading_time_to_value_s` | — | 114 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 8 |  |
| `waits` | — | 3 |  |
| `longest_wait_ms` | — | 2644 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Where this local copy differs from production (read every finding with this in mind): a throwaway hosted instance on a devbox (wrangler dev --local, MODE=saas, SAAS_ENABLED=1, fresh local D1), built from the commit named above, not a deployed target; Turnstile runs with Cloudflare's documented always-pass test keys (it never asked for a click); sign-in code mail is captured in the Worker log; the Cloudflare API and DNS-over-HTTPS are the in-memory fakes of the repo (e2e/support/fake-cloudflare.mjs) and nothing reaches api.cloudflare.com; INTAKE_DOMAIN and HOSTED_CONNECT_REPORTS=all are set so the shared report address is written (the production default, owner, admits only the operator's own workspaces); Cloudflare's consent screen is a local stand-in page (Allow / Cancel) and the OAuth token is a local stub, while the Worker's own redirect, state check, code exchange and import are the real code; the domain page and the daily refresh read the real public DNS, where the made-up names do not exist (harbor-lane.org shows 'Needs attention' for that reason only).
- Record names: this record is <walked date>-<id>.pr177.md. The 2026-11-16 records of PR 178 are already in the base commit, and PR 181 adds same-day records for some of these flows, so this pull request's records carry the tag pr177 (scripts/check-flows.mjs allows <date>-<id>.<tag>.md). The Walked line is the real time of the walk, at the commit named above (round 3 of the review of PR 177); the code after that commit is documentation and these records only.
- Screenshots: 375 px PNGs of every step of this walk are committed under .flowchad/walks/pr177/<flow id>/; 1440 px and dark captures are in the walk's out-of-repo evidence folder, not committed.
- This walk: cold sign-up, 'My company's', Cloudflare. Words: 452 at 1440 and 375 through the first-day card (S4 counted once), against 517 for the same steps on the base of this round (eca639a) measured the same way; across all nine screens (both S4 states and the card's flip) 667/639 against 765/726. The round-2 figure of 558/519 was measured at an earlier commit and could not be reproduced at eca639a. The from-the-checker walk (r177-cloudflare-checker, PASS) is 452 words, 5 fields.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Screenshots (375 px, light, one per step)

- step 1 `S1-signup`: `.flowchad/walks/pr177/signup-to-records-live-cloudflare/01-S1-signup@375.png`
- step 2 `S2-about`: `.flowchad/walks/pr177/signup-to-records-live-cloudflare/02-S2-about@375.png`
- step 3 `S3-code`: `.flowchad/walks/pr177/signup-to-records-live-cloudflare/03-S3-code@375.png`
- step 4 `S4-result`: `.flowchad/walks/pr177/signup-to-records-live-cloudflare/04-S4-result@375.png`
- step 5 `CF-consent-STANDIN`: `.flowchad/walks/pr177/signup-to-records-live-cloudflare/05-CF-consent-STANDIN@375.png`
- step 6 `C2-review`: `.flowchad/walks/pr177/signup-to-records-live-cloudflare/06-C2-review@375.png`
- step 7 `D1-after-apply`: `.flowchad/walks/pr177/signup-to-records-live-cloudflare/07-D1-after-apply@375.png`
