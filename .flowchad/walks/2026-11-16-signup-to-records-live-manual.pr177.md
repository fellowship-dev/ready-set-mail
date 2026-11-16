# Walk record: signup-to-records-live-manual

- **Flow:** Manual DNS (GoDaddy)
- **Value moment:** Ownership record found by itself; the card says what comes next
- **Walked:** 2026-11-16T10:33:11.567Z
- **Target:** http://127.0.0.1 (write-allowed-test)
- **Commit:** 48d3a1b4ac49c6512cb0ef31e2edc98b570b0cc8
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (6)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: S2: name, organization, whose email, optional role, optional where-heard (owner decision); step 2: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: optional role and where-heard stay on S2 by the owner decision
- **ERR-03** (should-fix) Errors keep what was typed — step 2: S2 answers survive Start over (this tab) but are lost on a reload
- **NAV-02** (later) Every screen says where you are — step 2: S2/S3 have no back except Start over; browser Back works
- **NOISE-01** (should-fix) Everything visible serves the step — S2 two optional fields; S4 aside at 1440; D1 Export PDF/Add domain and the other imported domains under the card
- **WAIT-02** (should-fix) Show progress and an estimate for waits over 10 seconds — step 5: wait_progress = false with wait_ms = 14058, needs wait_progress = true when wait_ms > 10000

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 6 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 328 |  |
| `reading_time_to_value_s` | — | 83 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 2 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 14058 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Where this local copy differs from production (read every finding with this in mind): a throwaway hosted instance on a devbox (wrangler dev --local, MODE=saas, SAAS_ENABLED=1, fresh local D1), built from the commit named above, not a deployed target; Turnstile runs with Cloudflare's documented always-pass test keys (it never asked for a click); sign-in code mail is captured in the Worker log; the Cloudflare API and DNS-over-HTTPS are the in-memory fakes of the repo (e2e/support/fake-cloudflare.mjs) and nothing reaches api.cloudflare.com; INTAKE_DOMAIN and HOSTED_CONNECT_REPORTS=all are set so the shared report address is written (the production default, owner, admits only the operator's own workspaces); Cloudflare's consent screen is a local stand-in page (Allow / Cancel) and the OAuth token is a local stub, while the Worker's own redirect, state check, code exchange and import are the real code; the domain page and the daily refresh read the real public DNS, where the made-up names do not exist (harbor-lane.org shows 'Needs attention' for that reason only).
- Record names: this record is <walked date>-<id>.pr177.md. The 2026-11-16 records of PR 178 are already in the base commit, and PR 181 adds same-day records for some of these flows, so this pull request's records carry the tag pr177 (scripts/check-flows.mjs allows <date>-<id>.<tag>.md). The Walked line is the real time of the walk, at the commit named above (round 3 of the review of PR 177); the code after that commit is documentation and these records only.
- Screenshots: 375 px PNGs of every step of this walk are committed under .flowchad/walks/pr177/<flow id>/; 1440 px and dark captures are in the walk's out-of-repo evidence folder, not committed.
- This walk: manual, a GoDaddy-hosted name; the value step is the one the flow file marks: the TXT proof record added at the DNS host is found by itself and the card says what comes next. The card did not flip to 'first reports on their way' in this walk: the domain page and daily refresh read real public DNS where harbor-lane.org does not exist (surface limit, the same as in round 2).

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Screenshots (375 px, light, one per step)

- step 1 `S1-signup`: `.flowchad/walks/pr177/signup-to-records-live-manual/01-S1-signup@375.png`
- step 2 `S2-about`: `.flowchad/walks/pr177/signup-to-records-live-manual/02-S2-about@375.png`
- step 3 `S3-code`: `.flowchad/walks/pr177/signup-to-records-live-manual/03-S3-code@375.png`
- step 4 `S4-records`: `.flowchad/walks/pr177/signup-to-records-live-manual/04-S4-records@375.png`
- step 5 `after-proof`: `.flowchad/walks/pr177/signup-to-records-live-manual/05-after-proof@375.png`
