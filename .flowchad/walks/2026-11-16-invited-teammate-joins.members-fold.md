# Walk record: invited-teammate-joins

- **Flow:** Invited teammate joins the workspace and sees its domains
- **Value moment:** The teammate (a read-only member unless invited as admin) sees the workspace's domains with each one's verdict
- **Walked:** 2026-11-16T19:26:56.984Z
- **Target:** http://127.0.0.1:8861 (local-copy)
- **Commit:** 3206c2ae97
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: decisions = 2, needs decisions <= 1

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 4 |  |
| `decisions_to_value` | — | 3 |  |
| `fields_to_value` | — | 3 |  |
| `clicks_to_value` | — | 2 |  |
| `words_to_value` | — | 655 |  |
| `reading_time_to_value_s` | — | 165 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 3 |  |
| `waits` | — | 2 |  |
| `longest_wait_ms` | — | 1954 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 4325 |  |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request, review round 2)

- Record name: `<walked date>-invited-teammate-joins.members-fold.md` (PR "truth-and-dead-ends"). It replaces the `not-affected` record this pull request carried for this flow (deleted in the same commit); the earlier walk record `2026-11-16-invited-teammate-joins.truth.md` is older than the last change to this flow's files and no longer counts. Walked at commit 3206c2ae97 on `truth-and-dead-ends`; the only files committed after it are walk records and their screenshots.
- Walk: hosted local copy (`MODE=saas`, test Turnstile keys, mail captured in the Worker log, fake Cloudflare, self-signed https), owner on Members at 1440 and 375, then the invitee in a second browser (link, password, emailed code, overview). Every step is measured at both widths; screenshots of both are in `.flowchad/walks/members-fold/invited-teammate-joins/` (`walk-01…05`, `@375` and `@1440`).
- **Why this walk was needed (review finding FOLD-01).** The reviewer measured, at 375, the Email field below the fold from the fourth person. Fix: the invite form now comes before the list of people, and each person takes two short lines at 375 (109 px, was 207 px). Measured with **6 people** on Members: Email field at **345–385 px of an 812 px screen at 375** (337–377 of 900 at 1440), `scroll_before_primary_vh` 0 at both widths on every step; the six rows are 109, 109, 109, 109, 109, 108 px high at 375 and 79 px at 1440. The field no longer moves with the number of people, because it is above them.
- The "previous" column is empty: the earlier walk's `results.json` is not kept (snapshots are not committed), and this walk is not comparable to it anyway: it seeds 6 people and two domains (one with a lapsed proof) where the earlier walk had 3 people and no lapsed domain, so words to value rise (step 5 lists the lapsed domain's block, "Next, an owner or admin: Prove it is still yours"). Screens (4), fields (3) and clicks (2) to value are the same as the previous record's; decisions to value are 3 here against 5 there (I counted the email and the role at step 1 and the password at step 3; I did not reconstruct how the earlier walk counted).
- Truth checks recorded: step 2 says the invite is not emailed (no mail line for the address after creating it) and expires in 7 days (`invites.expires_at - created_at` = 604800 s); step 5 says the invitee is a read-only member (`memberships.role` = member).
- Dead-end pass: the same link a second time, and a link that a newer invite to the same address replaced, both say "Invite not found. This invite link is invalid or has expired. Ask the person who invited you for a new one."; the owner's Members page says "<address> already had an open invite: its earlier link no longer works." Not walked here, covered by tests: invites made at the same moment leave exactly one live link (`test/team/members.test.ts`), and an admin's member invite to an address with an open admin invite from an owner is refused with a sentence.
- **Proof-lost screens (off the value path, walked as screens at 375 and 1440, owner and member):** `proof-lost-overview-owner|member@375|1440.png` and `proof-lost-domain-owner|member@375|1440.png`. For the member, the Overview row says "Next, an owner or admin: Prove it is still yours" (it said "Next, you:"), and the domain page's block shows "Prove again" disabled, with "Your role is member, which is read-only. Ask an owner or admin to make this change." (spoken to screen readers where the page's own read-only notice already says it in words, written beside the button where it does not). The owner still reads "Next, you:" and gets an enabled "Prove again". No horizontal overflow at either width.
- Known rough edge, unchanged: step 1 has two decisions (email and role), DEC-01.
- Not walkable on a local copy: the invitation link in a real inbox, real mail delivery, Turnstile with production keys.

### Screenshots (375 and 1440 px, light)

- step 1 `members` (6 people): `.flowchad/walks/members-fold/invited-teammate-joins/walk-01-members@375.png`, `…@1440.png`
- step 2 `members-link`: `walk-02-members-link@375.png`, `@1440.png`
- step 3 `invite`: `walk-03-invite@375.png`, `@1440.png`
- step 4 `code`: `walk-04-code@375.png`, `@1440.png`
- step 5 `overview` (the invitee, a member): `walk-05-overview@375.png`, `@1440.png`
- the proof-lost screens: `proof-lost-*`; Members as the owner sees it with 6 people: `members-6-people-owner@375.png`, `@1440.png`
