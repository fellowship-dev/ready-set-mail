# Walk record: signup-to-records-live-cloudflare

- **Flow:** New hosted user signs up and gets DMARC with the report address live through Cloudflare
- **Value moment:** Records live - ownership proven and DMARC seen in public DNS, carrying the shared report address when the server admits the workspace to reports (HOSTED_CONNECT_REPORTS; by default only the operator's own workspaces)
- **Walked:** 2026-11-16T21:26:07.695Z
- **Target:** http://127.0.0.1:8872 (local-copy)
- **Commit:** 33b0f64e96
- **Kind:** screens
- **Gate:** PASS
- **Rules:** 0.5.0

_Redacted best-effort (emails, numbers, tokens, URL query strings). Review before committing._

Ready to hand to a human tester. Known rough edges are listed below; tell the tester about them first.

### Known rough edges (5)

- **DEC-01** (should-fix) One decision per screen in setup and transactions — step 2: decisions = 2, needs decisions <= 1
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
| `longest_wait_ms` | — | 1850 |  |
| `dead_ends` | — | 0 |  |
| `loops` | — | 0 |  |
| `time_to_value_ms` | — | 13335 |  |

### Not covered by a rule

Candidates for a new rule (see flow-walk/rules/README.md § Admission test):

- Checker-link variants at 375 (fresh browser each, nothing signed in): no domain: Check and fix your domain's SPF, DKIM and DMARC. (overflow 0px); not a domain: Check and fix your domain's SPF, DKIM and DMARC. (overflow 0px); long: You're setting up mail-security-reporting-for-the-harbor-lane-association.co.uk. (overflow 0px); capitals: You're setting up harbor-lane.org. (overflow 0px); 63-char label: You're setting up [a x63].example.org. (overflow 0px).
- After the value step: card flipped to "first reports are on their way": true after 60s.
- The Cloudflare consent screen is not walkable locally: the fake has no OAuth screen, so the token form stands in for it (counted as the consent screen, 0 typed fields, 1 click); in production the person approves on Cloudflare's page.
- Turnstile: the browser's request to challenges.cloudflare.com for the always-pass test widget may end net::ERR_ABORTED (guarded browser); sign-up still goes through with the test keys.

### Notes

- staleness not checked: no deploy time given and no deploy check configured for the target

### Record notes (this pull request)

- Record names: this record is <walked date>-<id>.checker-s1-r2.md. It replaces the checker-s1 record of the same flow (walked at ea024c9b13), which CI rejected because files this flow covers changed in main after that commit (PR 183, "Connect reports in one step"). Walked at commit 33b0f64e96, the head of fix/signup-names-checker-domain after merging main db9527e (PR 183); no file the flow covers changes between that commit and the records commit (scripts/check-flows.mjs).
- The change under walk: the sign-up from the website checker's link, `#/signup?domain=harbor-lane.org&src=report`. S1 says "You're setting up harbor-lane.org." and asks for no domain; S4 opened on "Domain: harbor-lane.org · Not this domain?" with the domain prefilled and never typed (the domain field, its Check click and the empty S4 screen of pr177b are gone).
- This walk: a new hosted account on a local copy built from that commit (fake DoH and fake Cloudflare, test keys, captured mail), "My company's", Cloudflare path (fake Cloudflare); 7 steps, value step 7. Walked twice at both widths (once with the window starting at 1440x900 and once at 375x812; each step captured at both widths in the same session): both runs gave the same measures apart from timings, gate PASS with no overrides on both. The gate record above is the 1440-first run. The fake has no Cloudflare consent page: a token form stands in for it (counted as the consent screen, 0 typed fields, 1 click); in production the person approves on Cloudflare's page.
- S1 at 375, exactly as the person reads it: "Create your account" / "You're setting up harbor-lane.org." / "Work email" / "Password" / "Show" / "At least 8 characters." / "Continue" / "By creating an account you agree to the Terms and the Privacy Policy." / "Already have an account? Sign in" / "Terms" / "Privacy". S4 showed "Domain: harbor-lane.org · Not this domain?" with the domain untyped.
- Against the checker-s1 record of this flow (walked at ea024c9b13; same counting rules):

| Measure | checker-s1 | Now (r2) | Change |
|---|---|---|---|
| `screens_to_value` | 7 | 7 | +0 |
| `decisions_to_value` | 7 | 7 | +0 |
| `fields_to_value` | 5 | 5 | +0 |
| `clicks_to_value` | 6 | 6 | +0 |
| `words_to_value` at 1440 | 482 | 482 | +0 |
| `words_to_value` at 375 | 482 | 482 | +0 |
| `reading_time_to_value_s` | 122 | 122 | +0 |
| `max_scroll_before_primary_vh` | 375: 0 · 1440: 0 | 375: 0 · 1440: 0 | none |
| `non_task_elements_to_value` | 6 | 6 | +0 |
| `waits` | 1 | 1 | +0 |
| `longest_wait_ms` | 1840 | 1850 | +10 |
| `dead_ends` / `loops` | 0 / 0 | 0 / 0 | none |
| `time_to_value_ms` (scripted) | 8975 | 13335 | +4360 (a timing of the script, not of the product: this walk pauses 0.4 s per step before it captures, and the polls land at different moments) |

  fields_to_value does not grow. The longest wait is the sign-up (Continue on S1 to S2, 1.9 s). The clicks include the tap on "My company's" on S2 (a radio card, not preselected), counted on the screen that follows.
- Per step, at 375 / 1440: words above the action (counted here as the words of the main content that precede the action's own label, the options of the optional select left out, so a difference of one or two from the checker-s1 record's counts is the counting), where the action's bottom sits (in screens, 1 = the bottom of the first screen) and the scroll before the first input (FOLD-01); the action is the one named in its column:

| Step | Screen | Action | Words | Words above the action | Action bottom (screens) | Scroll before first input |
|---|---|---|---|---|---|---|
| 1 | S1 | Continue | 37 | 15 / 15 | 0.53 / 0.63 | 0 / 0 |
| 2 | S2 | Continue | 67 | 47 / 47 | 0.94 / 0.86 | 0 / 0 |
| 3 | S3 | Continue | 28 | 17 / 17 | 0.42 / 0.6 | 0 / 0 |
| 4 | S4 | Connect Cloudflare | 53 | 21 / 21 | 0.44 / 0.24 | 0 / 0 |
| 5 | CF consent (stand-in) | Connect | 82 | 4 / 4 | 0.87 / 0.7 | 0 / 0 |
| 6 | C2 | Apply 1 change | 77 | 42 / 42 | 0.54 / 0.42 | 0 / 0 |
| 7 | first-day | Open harbor-lane.org | 138 | 28 / 28 | 0.53 / 0.35 | 0 / 0 |

- Checker-link variants at 375, fresh browser each: no domain -> Check and fix your domain's SPF, DKIM and DMARC. (overflow 0 px); not a domain -> Check and fix your domain's SPF, DKIM and DMARC. (overflow 0 px); long -> You're setting up mail-security-reporting-for-the-harbor-lane-association.co.uk. (overflow 0 px); capitals -> You're setting up harbor-lane.org. (overflow 0 px); 63-char label -> You're setting up [a x63].example.org. (overflow 0 px). A link with no or a non-domain value falls back to the generic line; nothing from the link is injected as markup.
- The first-day card flipped to "Your first reports are on their way" by itself, about 50 s after Apply (the first read of public DNS is reused for up to a minute; the 375-first run checked for 60 s and saw it still waiting, so the flip is at the edge of that window). The older DMARC step is not on this flow's path.
- Tooling note: `/flow-gate` as written picks `.claude/skills/flow-gate/scripts/gate.mjs` first, a symlink that prints and writes nothing; the gate was run from `.agents/skills/flow-gate/scripts/gate.mjs`, recording to a scratch folder and copying the record into place (`--record .flowchad/walks` would have overwritten the older `2026-11-16-signup-to-records-live-cloudflare.md`).
- Screenshots: 375 px PNGs of every step are committed under .flowchad/walks/checker-s1-r2/signup-to-records-live-cloudflare/; the 1440 px captures (measured the same way) stay in the walk's out-of-repo evidence folder.

### Screenshots (375 px, light, one per step)

- step 1 `S1-signup`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-cloudflare/01-S1-signup@375.png`
- step 2 `S2-about`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-cloudflare/02-S2-about@375.png`
- step 3 `S3-code`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-cloudflare/03-S3-code@375.png`
- step 4 `S4-prefilled-cloudflare`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-cloudflare/04-S4-prefilled-cloudflare@375.png`
- step 5 `CF-consent-standin`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-cloudflare/05-CF-consent-standin@375.png`
- step 6 `C2-review`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-cloudflare/06-C2-review@375.png`
- step 7 `D1-after-apply`: `.flowchad/walks/checker-s1-r2/signup-to-records-live-cloudflare/07-D1-after-apply@375.png`
