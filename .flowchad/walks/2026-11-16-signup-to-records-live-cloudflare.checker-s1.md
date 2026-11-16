# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T20:23:29.028Z
- **Target:** http://127.0.0.1:8872 (local-copy)
- **Commit:** ea024c9b13
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (5)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: S2 asks name, organization, whose email and two optional answers (decisions = 2); step 2: decisions = 2, needs decisions <= 1
- **DEC-03** (should-fix) Derive instead of asking — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision
- **NAV-02** (later) Every screen says where you are — step 2: S2 and S3 have no way back except "Start over" (which drops the attempt); the browser Back button works
- **NOISE-01** (should-fix) Everything visible serves the step — step 7: step 2: the two optional fields (owner decision); step 7: Export PDF and Add domain in the page header; S4 and C2: the hand-off link
- **PATH-03** (should-fix) Every step earns its place — step 2: optional "What is your role?" and "Where did you hear about us?" stay on S2 by the owner's explicit decision

### Measures

| Measure | Previous | Now | Change |
|---|---|---|---|
| `screens_to_value` | — | 7 |  |
| `decisions_to_value` | — | 7 |  |
| `fields_to_value` | — | 5 |  |
| `clicks_to_value` | — | 6 |  |
| `words_to_value` | — | 482 |  |
| `reading_time_to_value_s` | — | 122 |  |
| `max_scroll_before_primary_vh` | — | 375: 0 · 1440: 0 |  |
| `non_task_elements_to_value` | — | 6 |  |
| `waits` | — | 1 |  |
| `longest_wait_ms` | — | 1840 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 8975 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Checker-link variants at 375 (fresh browser each, nothing signed in): no domain in the link: Check and fix your domain's SPF, DKIM and DMARC., overflow 0px, injected elements 0; not a domain: Check and fix your domain's SPF, DKIM and DMARC., overflow 0px, injected elements 0; a long real-looking domain: You're setting up mail-security-reporting-for-the-harbor-lane-association.co.uk., overflow 0px, injected elements 0; a domain with capitals: You're setting up harbor-lane.org., overflow 0px, injected elements 0; a 63-character label: You're setting up [hex].example.org., overflow 0px, injected elements 0.
- After the value step: card flipped to "first reports are on their way": true after 60s.
- The Cloudflare consent screen is not walkable locally: the fake has no OAuth screen, so the token form stands in for it (counted as the consent screen, 0 typed fields, 1 click); in production the person approves on Cloudflare's page.
- Turnstile: the browser's request to challenges.cloudflare.com for the always-pass test widget ended net::ERR_ABORTED (guarded browser; sign-up still went through with the test keys).

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record names: this record is <walked date>-<id>.checker-s1.md (the sign-up from the website checker's link, S1 names the domain), next to the pr177b record of the same flow. It was walked at commit ea024c9b13, the head of fix/signup-names-checker-domain (it adds nothing but these records); no file the flow covers changes between that commit and the records commit (scripts/check-flows.mjs).
- Entry: the checker's link, `#/signup?domain=harbor-lane.org&src=report`, not `#/signup` as in pr177b. S1 says "You're setting up harbor-lane.org." and asks for no domain; S4 opened on "Domain: harbor-lane.org · Not this domain?" with the domain prefilled, never typed: the domain field, its Check click and the empty S4 screen of pr177b are gone.
- This walk: a new hosted account on a local copy, "My company's", Cloudflare path (fake Cloudflare); 7 steps, value step 7. Walked twice at both widths (once with the window starting at 1440x900 and once at 375x812; each step captured at both widths in the same session): both runs gave the same measures apart from timings, gate PASS with no overrides. The gate record above is the 1440-first run.
- S1 at 375, exactly as the person reads it: "Create your account" / "You're setting up harbor-lane.org." / "Work email" / "Password" / "Show" / "At least 8 characters." / "Continue" / "By creating an account you agree to the Terms and the Privacy Policy." / "Already have an account? Sign in" / "Terms" / "Privacy".
- Against pr177b (the same flow, 5a5caed85b; its figures are taken from its record, and this walk counted decisions, clicks and non-task elements per screen by the rules in references/measures.md, so a difference of one or two in those can be counting, not the change; screens and typed fields are unambiguous. Its walk also had the empty S4 screen and the Check click, and the real Cloudflare consent page that is not ours):

| Measure | pr177b | Now | Change |
|---|---|---|---|
| `screens_to_value` | 7 | 7 | +0 |
| `decisions_to_value` | 8 | 7 | -1 |
| `fields_to_value` | 6 | 5 | -1 (the domain is no longer typed) |
| `clicks_to_value` | 7 | 6 | -1 (the Check click is gone) |
| `words_to_value` at 1440 | 486 | 482 | -4 |
| `words_to_value` at 375 | 458 | 482 | +24 |
| `reading_time_to_value_s` | 123 | 122 | -1 |
| `max_scroll_before_primary_vh` | 375: 0 · 1440: 0 | 375: 0 · 1440: 0 | none |
| `non_task_elements_to_value` | 8 | 6 | -2 |
| `waits` | 3 | 1 | -2 |
| `longest_wait_ms` | 1834 | 1840 | +6 |
| `dead_ends` / `loops` | 0 / 0 | 0 / 0 | none |
| `time_to_value_ms` (scripted) | 20727 | 8975 | -11752 |

  fields_to_value does not grow. The words at 375 are higher than pr177b's because this walk counts the stand-in consent screen (82 words: a token form, since the fake has no consent page); without it the total is 400. S1 alone, with the link's domain against the same screen without a domain (measured on the same build): words 37 against 42 (the one line replaces the generic "Check and fix your domain's SPF, DKIM and DMARC."), the Continue button's bottom at 0.53 against 0.55 of the screen at 375 and 0.63 against 0.63 at 1440.
- Per step, at 375 / 1440: words above the action, where the action's bottom sits (in screens, 1 = the bottom of the first screen) and the scroll before the first input (FOLD-01):

| Step | Screen | Action | Words | Words above the action | Action bottom (screens) | Scroll before first input |
|---|---|---|---|---|---|---|
| 1 | S1 | Continue | 37 | 15 / 15 | 0.53 / 0.63 | 0 / 0 |
| 2 | S2 | Continue | 67 | 48 / 48 | 0.96 / 0.86 | 0 / 0 |
| 3 | S3 | Continue | 28 | 18 / 18 | 0.42 / 0.6 | 0 / 0 |
| 4 | S4 | Connect Cloudflare | 53 | 35 / 25 | 0.44 / 0.24 | 0 / 0 |
| 5 | cloudflare-consent | Connect | 82 | 114 / 114 | 0.87 / 0.7 | 0 / 0 |
| 6 | C2 | Apply 1 change | 77 | 45 / 45 | 0.54 / 0.42 | 0 / 0 |
| 7 | first-day | Open harbor-lane.org | 138 | 28 / 28 | 0.53 / 0.35 | 0 / 0 |

- Checker-link variants at 375, fresh browser each: no domain in the link -> Check and fix your domain's SPF, DKIM and DMARC. (overflow 0 px); not a domain -> Check and fix your domain's SPF, DKIM and DMARC. (overflow 0 px); a long real-looking domain -> You're setting up mail-security-reporting-for-the-harbor-lane-association.co.uk. (overflow 0 px); a domain with capitals -> You're setting up harbor-lane.org. (overflow 0 px); a 63-character label -> You're setting up aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example.org. (overflow 0 px). A link with no or a non-domain value falls back to the generic line; nothing from the link is injected as markup.
- The first-day card flipped to "first reports are on their way" about 60 s after Apply, by itself (the first read of public DNS is reused for up to a minute). The older DMARC step, opened by its address, still says "1 of 4 steps complete" and "Step 2 of 4: SPF" (not on this flow's path).
- Tooling note: `/flow-gate` as written picks `.claude/skills/flow-gate/scripts/gate.mjs` first, a symlink to `.agents/skills/...`, and the script then exits 0 without printing or writing anything (its entry check compares the symlink path with the real one); the gate was run from `.agents/skills/flow-gate/scripts/gate.mjs`. It also wrote into a scratch folder first: `--record .flowchad/walks` would have overwritten the older `2026-11-16-signup-to-records-live-cloudflare.md`, so the record was written to a scratch folder and renamed to the .checker-s1 name.
- Screenshots: 375 px PNGs of every step are committed under .flowchad/walks/checker-s1/signup-to-records-live-cloudflare/; the 1440 px captures (measured the same way) stay in the walk's out-of-repo evidence folder.

### Screenshots (375 px, light, one per step)

- step 1 `S1-signup`: `.flowchad/walks/checker-s1/signup-to-records-live-cloudflare/01-S1-signup@375.png`
- step 2 `S2-about`: `.flowchad/walks/checker-s1/signup-to-records-live-cloudflare/02-S2-about@375.png`
- step 3 `S3-code`: `.flowchad/walks/checker-s1/signup-to-records-live-cloudflare/03-S3-code@375.png`
- step 4 `S4-prefilled-cloudflare`: `.flowchad/walks/checker-s1/signup-to-records-live-cloudflare/04-S4-prefilled-cloudflare@375.png`
- step 5 `CF-consent-standin`: `.flowchad/walks/checker-s1/signup-to-records-live-cloudflare/05-CF-consent-standin@375.png`
- step 6 `C2-review`: `.flowchad/walks/checker-s1/signup-to-records-live-cloudflare/06-C2-review@375.png`
- step 7 `D1-after-apply`: `.flowchad/walks/checker-s1/signup-to-records-live-cloudflare/07-D1-after-apply@375.png`
