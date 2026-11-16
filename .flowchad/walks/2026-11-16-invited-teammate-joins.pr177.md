# Walk record: invited-teammate-joins

- **Flow:** Owner invites a member; the member joins
- **Value moment:** The invited member sees the workspace domains
- **Walked:** 2026-11-16T10:37:20.710Z
- **Target:** http://127.0.0.1 (write-allowed-test)
- **Commit:** 48d3a1b4ac49c6512cb0ef31e2edc98b570b0cc8
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
| `screens_to_value` | — | 5 |  |
| `decisions_to_value` | — | 3 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 432 |  |
| `reading_time_to_value_s` | — | 109 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 0 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Where this local copy differs from production (read every finding with this in mind): a throwaway hosted instance on a devbox (wrangler dev --local, MODE=saas, SAAS_ENABLED=1, fresh local D1), built from the commit named above, not a deployed target; Turnstile runs with Cloudflare's documented always-pass test keys (it never asked for a click); sign-in code mail is captured in the Worker log; the Cloudflare API and DNS-over-HTTPS are the in-memory fakes of the repo (e2e/support/fake-cloudflare.mjs) and nothing reaches api.cloudflare.com; INTAKE_DOMAIN and HOSTED_CONNECT_REPORTS=all are set so the shared report address is written (the production default, owner, admits only the operator's own workspaces); Cloudflare's consent screen is a local stand-in page (Allow / Cancel) and the OAuth token is a local stub, while the Worker's own redirect, state check, code exchange and import are the real code; the domain page and the daily refresh read the real public DNS, where the made-up names do not exist (harbor-lane.org shows 'Needs attention' for that reason only).
- Record names: this record is <walked date>-<id>.pr177.md. The 2026-11-16 records of PR 178 are already in the base commit, and PR 181 adds same-day records for some of these flows, so this pull request's records carry the tag pr177 (scripts/check-flows.mjs allows <date>-<id>.<tag>.md). The Walked line is the real time of the walk, at the commit named above (round 3 of the review of PR 177); the code after that commit is documentation and these records only.
- Screenshots: 375 px PNGs of every step of this walk are committed under .flowchad/walks/pr177/<flow id>/; 1440 px and dark captures are in the walk's out-of-repo evidence folder, not committed.
- This walk: the owner makes a member link on the Members page; the member opens it in another browser, chooses a password, enters the code and sees the workspace's domains. The hand-off variant of this flow (an admin invited to finish a domain) is walked in handoff-to-developer.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Screenshots (375 px, light, one per step)

- step 1 `members`: `.flowchad/walks/pr177/invited-teammate-joins/01-members@375.png`
- step 2 `invite-link`: `.flowchad/walks/pr177/invited-teammate-joins/02-invite-link@375.png`
- step 3 `I1-member`: `.flowchad/walks/pr177/invited-teammate-joins/03-I1-member@375.png`
- step 4 `I1-code`: `.flowchad/walks/pr177/invited-teammate-joins/04-I1-code@375.png`
- step 5 `member-landing`: `.flowchad/walks/pr177/invited-teammate-joins/05-member-landing@375.png`
