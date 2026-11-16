# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC live on a Cloudflare-hosted domain with one Apply
- **Value moment:** Records live - ownership proven by the TXT record and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports
- **Walked:** 2026-11-16T13:54:27.323Z
- **Target:** http://127.0.0.1:8907 (local-copy)
- **Commit:** 7c8df4e27c
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (4)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 3: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: S2 keeps two optional questions ("What is your role?", "Where did you hear about us?") the next step does not need; kept by the owner's explicit decision in PR 177
- **NAV-02** (later) Every screen says where you are — step 2: S2 and S3 offer only "Start over" (which drops the attempt) besides the browser Back button
- **PATH-03** (should-fix) Every step earns its place — step 2: the same two optional questions on S2 do not earn their place on the path to value (owner's decision)

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 8 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 8 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 504 |  |
| `reading_time_to_value_s` | — | 127 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 0 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 1831 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 43861 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- After a reload the domain page does not open on the state just reached: the status "waiting for the first report" ends 1.21 viewport heights down at 1440x900 and 1.86 at 375x812, below the next-steps list.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record name: `<walked date>-<id>.after177.md` (the walk after PR 177 merged). It was walked at commit 7c8df4e27c on the branch after merging main at 61e6b8f; no file the flow covers changes between that commit and the commit that adds this record (scripts/check-flows.mjs).
- Walked by a script outside the repository (a Playwright harness over the skill's own `guard.mjs` and `measure.mjs`) on a local copy of commit 7c8df4e27c: hosted mode, the token path on the Cloudflare fake (it has no consent screen), `HOSTED_CONNECT_REPORTS=all`; 8 steps at 1440x900 and 375x812. The C2 review now renders the change card from `web/src/components/domain/RecordChange.tsx`, the same card "Connect reports" uses on the domain page.
- The tail the first walk of this branch added (the domain page after Apply) is not a step of this flow; the finding is under "not covered".
- Where this differs from production: Cloudflare is the fake (token path, no consent screen); its zones brightwave-mail.com, harbor-lane.org and quietfield.net answer public DNS through the fake DNS-over-HTTPS; `HOSTED_CONNECT_REPORTS=all`; sign-in codes read from the Worker log; Cloudflare's published always-pass Turnstile test keys (challenges.cloudflare.com declared write-allowed-test).
- Screenshots: 375 px PNGs of every step are committed under `.flowchad/walks/after177/signup-to-records-live-cloudflare/`; the 1440 px captures and the walk's `results.json` stay in the walk's out-of-repo evidence folder.

### Screenshots (375 px, light, one per step)

- step 1 `S1 sign-up`: `.flowchad/walks/after177/signup-to-records-live-cloudflare/01-S1-signup.png`
- step 2 `S2 about you`: `.flowchad/walks/after177/signup-to-records-live-cloudflare/02-S2-about.png`
- step 3 `S3 code`: `.flowchad/walks/after177/signup-to-records-live-cloudflare/03-S3-code.png`
- step 4 `S4 which domain`: `.flowchad/walks/after177/signup-to-records-live-cloudflare/04-S4-domain-empty.png`
- step 5 `S4 result and the choice`: `.flowchad/walks/after177/signup-to-records-live-cloudflare/05-S4-result-cloudflare.png`
- step 6 `Cloudflare token (the fake has no consent screen)`: `.flowchad/walks/after177/signup-to-records-live-cloudflare/06-Connect-token.png`
- step 7 `C2 review`: `.flowchad/walks/after177/signup-to-records-live-cloudflare/07-C2-review.png`
- step 8 `first-day dashboard`: `.flowchad/walks/after177/signup-to-records-live-cloudflare/08-Apply-first-day.png`
