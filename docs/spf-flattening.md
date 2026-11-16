# SPF flattening

What it does, what it will not do, the daily job, who may use it, and what must be true before it is sold. Decisions: [ADR 0018](adr/0018-one-spf-flattening-refresh-engine.md) (one engine) and [ADR 0019](adr/0019-spf-flattening-is-an-add-on-per-domain-price-open.md) (an add-on, per domain, price open). The words (original record, flattened record, refresh) are in [CONTEXT.md](../CONTEXT.md).

## What it does

An SPF record may cost receivers at most 10 DNS lookups (RFC 7208, section 4.6.4); past that they treat SPF as a permanent error and it stops vouching for your mail. Every `include:` costs a lookup, plus the lookups inside it. Flattening replaces `include:` terms with the addresses behind them (`ip4:` and `ip6:`), which cost none.

Providers change their addresses, so a flattened record has to be re-read. Turning flattening on stores **the original record** (the one in Cloudflare at that moment, with its includes) and writes **the flattened record**. Every day the refresh resolves the stored original again, never the published record (which no longer has includes to follow), and rewrites the record only when the answer changed.

## The rule for what is inlined (selective flattening)

A full flatten of three or more providers is nearly always too big. Measured from real DNS (`dig`, the flattened `ip4:`/`ip6:` terms only, 2026-11-16): `_spf.google.com` 233 bytes; `spf.protection.outlook.com` 249; `sendgrid.net` 347; `mailgun.org` 483; `amazonses.com` 268; Google and Outlook together 458. A record should stay under 450 bytes (RFC 7208, section 3.4: the answer must fit one UDP packet), so refusing everything above 450 would make the feature useless for the people who need it.

So the engine inlines only as many top-level includes as it takes and keeps the others as includes:

1. The result must need at most 10 lookups (counting the full nested cost of every include it keeps, and every `a`, `mx`, `exists` or `ptr` term) **and** be at most 450 bytes.
2. Among the choices that fit, the **fewest includes inlined** wins; among those, the **fewest bytes**.
3. It tries every subset of the top-level includes that may safely be inlined (at most 12; more is refused in one sentence).
4. Nothing fits: refused with one sentence that says what the best choice would need ("your record would need 12 lookups and 800 bytes"). Nothing is written.
5. The choice is made again on every refresh, from the original. If a kept include grows, or a provider's addresses change enough, the choice can change; that is a change like any other (written, audited).
6. "Flatten anyway", for a record that is already within both limits, uses the opposite order (as many as fit). The mode is stored with the row so every refresh makes the same kind of choice (`inline_mode`).

Chained records (`include:` of a second record we create) are not used: they need a second managed DNS name per domain, which the write policy (`src/dns/write-policy.ts`) forbids for `_`-prefixed names and [ADR 0004](adr/0004-dns-writes-need-an-explicit-apply.md) does not allow.

## What it never does

- **Widens who may send.** Only `+` ip terms of an included record are inlined. An included record that has any other qualified term (`-ip4:`, `~a`, `?mx`, `~include:`), a `+all`, or a macro in a term that would be copied is **kept as an include**, because copying it as a pass would let more senders through. The original's `all` is kept as written; **a record with no `all` stays without one** (it is neutral, and `~all` would change that). No mechanism is added.
- **Writes a smaller record because something failed.** An include that does not resolve, answers twice, loops, answers with the TC bit (a cut-short answer), lists something that is not an address, or needs more than 40 DNS reads is a problem: the last good record stays, the problem is recorded, one sentence tells the owner. A macro in an `include:` or `redirect=` target is refused plainly ("the addresses depend on who is sending").
- **Overwrites an edit made outside the app.** Before a write it reads the record in Cloudflare; if it is not the value written last, someone changed it there: nothing is written, the problem is recorded, and the owner can Review (in Cloudflare now / flattened from your original; Replace or Stop flattening). Turning off does not write over an outside edit either.
- **Writes when nothing changed.** The new record is compared with the published one regardless of the order of its terms, case, quotes and spacing. No write, no audit row, no log line when equal.
- **Takes a flat record as the original.** The original is set when flattening is turned on and never rewritten while a row exists. If turning off could not put the original back, the row stays (`restore_failed`) with the original, and turning on again is refused until that is done. A failed turn-on leaves no row.

## The job

Daily at **11:00 UTC** (`0 11 * * *`, `wrangler.jsonc`), both modes. It was `0 10`; an installation whose `wrangler.local.jsonc` still lists `0 10 * * *` keeps working: `src/cron.ts` answers it with the same function, and a row looked at in the last 20 hours is not due, so an install with both triggers refreshes once a day. Remove the older trigger at your leisure.

Why `0 11`: the hosted service already runs `0 4` and `0 11` (the others are held), so no trigger change on the live instance. Wiki L-080 turned `0 11` on because it "writes no DNS" on hosted. That stays true while `HOSTED_SPF_FLATTENING` is off (the default): the job finds no workspace it may refresh. **The owner turning it on for a workspace is what makes `0 11` write DNS on hosted.**

Per run (`src/spf/refresh.ts`): rows not looked at in the last 20 hours, never-looked-at first, then the longest ago; at most 20 per workspace and 100 per invocation, five at a time (`mapLimit`). A domain costs its DNS reads (at most 40; typically 8 to 16) plus about four Cloudflare calls (zone, list, write, read-back): **about 44 subrequests at worst, 16 typical**. Workers allow 50 external subrequests per invocation on the free plan (so about one flattened domain a run) and 10,000 on paid; the job stops at 4,000 subrequests in one invocation, which leaves room for the analytics, lifecycle and hosted jobs that share it. Self-hosters with more than a couple of flattened domains need the paid plan. A failure of one domain or workspace never stops the others.

Two runs at once, or a run while flattening is turned off, never write twice and never bring a turned-off row back: a run claims the row (compare-and-set on `revision`, a lease of 120 seconds), writes, reads back, and finishes only if the claim still holds; if it does not (flattening was turned off meanwhile), it puts the owner's original back.

Hosted records (`include:<id>._spf.h.<zone>`, [hosted.md](hosted.md)) use the same engine: `src/hosted/cron.ts` calls `flattenFromSource` with the stored `hosted_domains.spf_source`. They need `HOSTED_RECORDS_*`, which the live instance does not set.

## What the owner sees

On the domain page, under DNS tools, one card (`web/src/components/domain/SpfCard.tsx`); the words are in `web/src/lib/spf-flatten.ts`:

- **off**: "Your record needs 14 lookups; receivers stop at 10. Flattening replaces the includes with the addresses behind them." Within the limit: "Your record uses 3 of the 10 lookups receivers allow, so it does not need flattening."
- **on**: "On: 23 addresses in your record, using 7 of the 10 lookups. Checked 2 hours ago; not changed since you turned it on. Checked again every day around 11:00 UTC." After a change, "What changed on 12 Nov" shows the previous and the current record.
- **needs attention**: the sentence below, and the one action: *Try again* (a provider could not be read), *Reconnect Cloudflare*, *Turn off* (too large, macro), *Review* (edited or deleted in Cloudflare).
- **the daily check has not run** (last check older than two days): "Last checked 12 Nov. The daily check has not run since."

The problem sentences are written by the server (`src/spf/refresh.ts` `problemSentence`) and stored in `last_error`. Every change writes an audit entry `spf_flatten.update` (before and after); a problem writes `spf_flatten.problem` once when it starts. Turning on and off write `spf_flatten.enable` and `spf_flatten.disable`.

## Who may use it

`addOnAccess` in `src/hosted/plan-limits.ts` is the one answer, asked by every route, `/api/me` (`add_ons.spf_flattening`), the job and the next-step link:

- **Self-host**: always available.
- **Hosted**: only for a workspace the operator admitted with **`HOSTED_SPF_FLATTENING`**: unset, empty or not understood = off (the default); `owner` = the workspaces owned by the `OWNER_EMAIL` account; `all`; or workspace ids (`ws_...`, comma separated, with or without `owner`: `owner,ws_0123...`). Everyone else on hosted sees nothing: no card, no next-step link, the routes answer 404. The parser is `src/hosted/allow.ts`, the same one `HOSTED_CONNECT_REPORTS` uses.
- **Turning off is never refused.** If the setting is removed from a workspace that has a domain flattened, the card stays and says refreshing stopped; the record keeps the addresses of the last check; Turn off restores the original.

To enable it for one customer's workspace: find the id (`SELECT id FROM workspaces WHERE name = ...`), set `HOSTED_SPF_FLATTENING` to `owner,<id>` (a Worker variable; no deploy of code), and check the owner's setup check for an unknown value. To switch it off for everyone: unset it.

## Rolling back

The refresh keeps `previous_record` (the flattened record before the last change); the domain page shows it after a change. There is no rollback button (a rollback would be undone by the next refresh, which makes its own choice from the original). To put the previous record back by hand: copy it from "What changed" (or from the audit entry's `before` value), paste it into the SPF TXT record in Cloudflare, and **turn flattening off** so the daily check does not write the current choice again. `rollbackSpf` (`src/spf/refresh.ts`) does the same write for an operator or support script: it puts `previous_record` back when the record in Cloudflare is still the current one, and refuses when someone edited it.

## What must be true before it is sold

- The price (O-13, [OPEN.md](adr/OPEN.md)) and its basis; then #180's plan engine attaches a subscription item per domain to `addOnAccess` (a reason `subscription`), and decides what a lapse does: keep the last good record and stop refreshing (what this change does when the setting goes away), restore the original, or keep refreshing for a grace period. Left open on purpose.
- A walk on the live target as a new customer, with real Cloudflare: that a TXT record over 255 characters is stored as several strings (Cloudflare does this; the fake does not), and that the first `0 11` run on a workspace the operator admitted writes what the screen promised.
- Self-host operators have read the subrequest numbers above.
