# Walk record: invited-teammate-joins

- **Flow:** Invited teammate joins the workspace and sees its domains
- **Value moment:** The teammate (a read-only member unless invited as admin) sees the workspace's domains with each one's verdict
- **Walked:** 2026-11-16T12:16:59.287Z
- **Target:** http://127.0.0.1:8860 (local-copy)
- **Commit:** 5a5caed85b
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (3)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: decisions = 2, needs decisions <= 1
- **NOISE-01** (should-fix) Everything visible serves the step — step 5: step 5: Export PDF, the repeated read-only notice and the long "Reports not connected yet" block above the rows; unchanged on main
- **NOISE-03** (should-fix) Words fit the action — step 5: step 5: 232 words, 70 of them the reports-not-connected block before the first domain row (unchanged on main)

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 4 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 3 |  |
| `words_to_value` | — | 487 |  |
| `reading_time_to_value_s` | — | 123 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 5 |  |
| `waits` | — | 0 |  |
| `longest_wait_ms` | — | 0 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 13029 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- This walk (owner creates an invite link, the teammate joins as a member): 4 product screens, 3 typed fields, 50 keystrokes, 3 clicks, 487 words at 1440 / 487 at 375, farthest action bottom at 375 n/a vh; the owner's two screens (Members, link) and the teammate's three (invite, code, overview).
- Also walked, the hand-off to a teammate (the owner hands over setup of brightwave-mail.com; the admin teammate lands on that domain's S4): 9 product screens, 9 typed fields, 151 keystrokes, 9 clicks, 570 words at 1440 / 542 at 375, farthest action bottom at 375 n/a vh for the whole of it (owner: S1-S4, H1, H1 sent, H2; teammate: I1, code, S4). Steps: S1-signup, S2-about, S3-code, S4-domain-empty, S4-result-cloudflare, H1-handoff, H1-sent, H2-inviter-dashboard, I1-invite, I1-code, I1-landing-S4, H2-after-join.
- Not walkable on a local copy: the hand-off email in a real inbox (the Worker logs it; its link was read from the captured mail), real delivery and spam placement.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record names: this record is <walked date>-<id>.pr177b.md (round 3 of PR 177), replacing the pr177 record of the same flow. It was walked at commit 5a5caed85b on the branch after merging main at db916a9; no file the flow covers changes between that commit and the records commit (scripts/check-flows.mjs).
- This walk: the owner creates an invite link at Members, the teammate opens it in another browser, sets a password, enters the code and lands on the workspace's domains; the hand-off variant (H1 to I1, the inviter's card showing who finished setup) was walked too and is not part of the value path measured here.
- Screenshots: 375 px PNGs of every step are committed under .flowchad/walks/pr177b/invited-teammate-joins/; the 1440 px captures (measured the same way, see the measures above, which cover both widths) and dark captures stay in the walk's out-of-repo evidence folder.

### Screenshots (375 px, light, one per step)

- step 1 `members`: `.flowchad/walks/pr177b/invited-teammate-joins/01-members@375.png`
- step 2 `members-link`: `.flowchad/walks/pr177b/invited-teammate-joins/02-members-link@375.png`
- step 3 `I1-invite`: `.flowchad/walks/pr177b/invited-teammate-joins/03-I1-invite@375.png`
- step 4 `S3-invitee-code`: `.flowchad/walks/pr177b/invited-teammate-joins/04-S3-invitee-code@375.png`
- step 5 `D1-invitee-overview`: `.flowchad/walks/pr177b/invited-teammate-joins/05-D1-invitee-overview@375.png`
