# Walk record: invited-teammate-joins

- **Flow:** Invited teammate joins the workspace and sees its domains
- **Value moment:** The teammate (a read-only member unless invited as admin) sees the workspace's domains with each one's verdict
- **Walked:** 2026-11-16T17:06:51.150Z
- **Target:** http://127.0.0.1:8831 (local-copy)
- **Commit:** 760a2d643c
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (1)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 1: decisions = 2, needs decisions <= 1

### Measures (previous walk 2026-11-16T15:59:44.216Z)

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | 4 | 4 | same |
| `decisions_to_value` | 5 | 5 | same |
| `fields_to_value` | 3 | 3 | same |
| `clicks_to_value` | 2 | 2 | same |
| `words_to_value` | 386 | 386 | same |
| `reading_time_to_value_s` | 97 | 97 | same |
| `max_scroll_before_primary_vh` | 375: 0 · 1440: 0 | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | 8 | 8 | same |
| `waits` | 2 | 2 | same |
| `longest_wait_ms` | 1711 | 1714 | +3 |
| `dead_ends` | 0 | 0 | same |
| `loops` | 0 | 0 | same |
| `time_to_value_ms` | 7969 | 7938 | -31 |

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record name: `<walked date>-invited-teammate-joins.truth.md` (PR "truth-and-dead-ends"); the `truth` tag keeps it from colliding with another pull request's record of this flow on the same day. It was walked at commit 760a2d643c on `truth-and-dead-ends`; the only files committed after it are walk records and their screenshots (scripts/check-flows.mjs).
- This walk (hosted local copy, owner creates the link at Members, the teammate opens it in another browser, sets a password, types the emailed code and lands on the workspace's domains) is measured against the same walk of `main` at 61e6b8feae (the "previous" column): screens, decisions, fields, clicks, words to value, scroll before the primary input and time to value are the same.
- What the owner sees on Members that changed, measured on the first input of the step (the Email field): words above it 48 on both (the invite sentence is as long as before: 17 words, now "This invite is not emailed: you get a one-time link to pass on. It expires in 7 days."); at 375 the field sits 571-611 px down a 812 px screen (main: 537-577) because the name column now keeps a readable width (it wraps the role badge and "Last sign-in" below the name instead of shrinking to a sliver); at 1440 it sits 488-528 of 900 on both. The Create invite link button is the next thing on the screen at both widths.
- Dead-end pass (the same link a second time; a link that a newer invite to the same address replaced): a used link says "Invite not found. This invite link is invalid or has expired. Ask the person who invited you for a new one."; on `main` the replaced link still opened "You are invited" (two live links for one person), now it says the same "Invite not found" sentence, and the Members page says "<address> already had an open invite: its earlier link no longer works." when it happens.
- Truth checks recorded on step 2: the page says this invite is not emailed (the Worker's mail log shows no message to the invited address) and that the link expires in 7 days (invites.expires_at - created_at = 604800 s). Step 5 checks that the invited person is a read-only member of the owner's workspace (GET /api/me).
- Also changed on the same screen but off the value path, walked as screens (before and after, owner, admin and member, 375 and 1440, self-host and hosted; listed in the pull request): the owner's role menu on each other member's row, the remove dialog and the delete-account sentence naming agents (hosted) or API keys (self-host) as the mode has them, the removal dialog saying so when the person has no other workspace, and read-only members no longer being offered Members and Audit log.
- Known rough edge, unchanged: step 1 has two decisions (email and role), DEC-01.
- Not walkable on a local copy: the invitation link in a real inbox, real mail delivery, Turnstile with production keys (the test keys always pass).

### Screenshots (375 px, light, one per step)

- step 1 `members`: `.flowchad/walks/truth-and-dead-ends/invited-teammate-joins/01-members@375.png`
- step 2 `members-link`: `.flowchad/walks/truth-and-dead-ends/invited-teammate-joins/02-members-link@375.png`
- step 3 `I1-invite`: `.flowchad/walks/truth-and-dead-ends/invited-teammate-joins/03-I1-invite@375.png`
- step 4 `S3-invitee-code`: `.flowchad/walks/truth-and-dead-ends/invited-teammate-joins/04-S3-invitee-code@375.png`
- step 5 `D1-invitee-overview`: `.flowchad/walks/truth-and-dead-ends/invited-teammate-joins/05-D1-invitee-overview@375.png`
