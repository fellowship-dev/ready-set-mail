# SPF flattening

What it does, what it will not do, the daily job, who may use it, and what must be true before it is sold. Decisions: [ADR 0022](adr/0022-one-spf-flattening-refresh-engine.md) (one engine) and [ADR 0023](adr/0023-spf-flattening-is-an-add-on-per-domain-price-open.md) (an add-on, per domain, price open) and [ADR 0024](adr/0024-a-refresh-never-removes-an-address-on-first-sighting.md) (a removal waits four hours). The words (original record, flattened record, refresh) are in [CONTEXT.md](../CONTEXT.md).

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

- **Changes what a receiver decides.** The table below lists, case by case, what moves into the customer's record and what the code does so the answer is the same; the property test (`packages/dns-checks/test/spf-flatten.property.test.ts`) checks it against an independent RFC 7208 evaluator for random records and senders.
- **Widens who may send.** Only `+` ip terms of an included record are inlined. An included record that has any other qualified term (`-ip4:`, `~a`, `?mx`, `~include:`), a `+all`, or a macro in a term that would be copied is **kept as an include**, because copying it as a pass would let more senders through. The original's `all` is kept as written; **a record with no `all` stays without one** (it is neutral, and `~all` would change that). No mechanism is added.
- **Removes an address the first time it sees it go.** A provider's glitch (`v=spf1 -all` from an outage page) would otherwise be written at once and fail mail for up to a day. A removal waits for a second look at least four hours later (below, [ADR 0024](adr/0024-a-refresh-never-removes-an-address-on-first-sighting.md)).
- **Writes a smaller record because something failed.** An include that does not resolve, answers twice, loops, answers with the TC bit (a cut-short answer), lists something that is not an address, or needs more than 40 DNS reads is a problem: the last good record stays, the problem is recorded, one sentence tells the owner. A macro in an `include:` or `redirect=` target is refused plainly ("the addresses depend on who is sending"), and so is a macro in any term the customer's record hands over to with `redirect=` ("The record of ..., which your record hands over to with redirect=, uses a macro that depends on that name, so it cannot be copied into your record."): after a redirect, `%{d}` is the target, and copied into the customer's record it would be the customer's domain.
- **Overwrites an edit made outside the app.** Before a write it reads the record in Cloudflare; if it is not the value written last, someone changed it there: nothing is written, the problem is recorded, and the owner can Review (in Cloudflare now / flattened from your original; Replace or Stop flattening). Turning off does not write over an outside edit either.
- **Writes when nothing changed.** The new record is compared with the published one regardless of the order of its terms, case, quotes and spacing. No write, no audit row, no log line when equal.
- **Takes a flat record as the original.** The original is set when flattening is turned on and rewritten only when the owner chooses "Use my edit as the new original" after an outside edit ([ADR 0025](adr/0025-the-owner-may-adopt-an-outside-edit-as-the-new-original.md)); a refresh never rewrites it. If turning off could not put the original back, the row stays (`restore_failed`) with the original, and turning on again is refused until that is done. A failed turn-on leaves no row.

## What flattening never changes

Flattening moves terms out of the records they were read from and into the customer's record. A term can mean something different there. Every case that was audited, what the code does (`packages/dns-checks/src/spf-flatten.ts`), and the test that holds it (`packages/dns-checks/test/spf-flatten.test.ts`, "audit: what a term means once it moves", unless another is named). RFC 7208 sections in brackets.

| Case | What the code does | RFC |
|---|---|---|
| A term with a macro in the record of a `redirect=` target (`exists:%{i}._spf.%{d}`, `a:%{d}`, `include:%{d}` ...) | **Refused** (kind `macro`, one sentence). After the redirect the target is the current domain and `%{d}` is the target; copied, it would be the customer's domain. Any macro is refused, not only `%{d}`, at any depth of the chain | 6.1, 7.3 |
| A macro in the customer's own record | Kept as written: `%{d}` is the customer's domain there and still is | 7.3 |
| A macro in an included record | The include stays an include (its `%{d}` is the include's domain); nothing of it is copied | 5.2, 7.3 |
| Bare `a`, `mx`, `ptr` (no domain) in a redirect target or in an include that is inlined | Written with the domain of the record they were read from (`a:target`, `mx:target/24`, `ptr:target`; the CIDR is kept): bare means "the current domain" | 5.3 to 5.5, 6.1 |
| `exists:` | Always has a domain-spec. Without a macro it moves unchanged; without a domain the record is refused | 5.7 |
| `redirect=` of an included record that stands before its mechanisms | Followed after every mechanism of that record, wherever the modifier stands, so the lookups we keep keep their order (they used to come first and could add void lookups the original never made) | 6.1 |
| `redirect=` when the record also has an `all` (anywhere in it, also after the redirect) | The redirect is ignored, as receivers do; the target is not read | 6.1 |
| Terms after `all` | Never evaluated, dropped. A modifier after `all` (`exp=`) still counts | 4.7, 6 |
| A syntax error anywhere in a record, also after `all` (unknown mechanism, a bad address, `include:` or `exists:` without a domain) | **Refused**: receivers give a permanent error for the whole record, so we do not turn it into a valid one | 4.6 |
| A second `redirect=` or `exp=` in one record | **Refused**, same reason | 6 |
| `exp=` | Changes only the explanation a receiver shows, never the result. The customer's own is kept; a redirect target's is carried when the customer has none and it has no macro; otherwise dropped | 6.2 |
| `+all`, `-ip4:`, `~a`, `?mx` and other qualified terms in a redirect target | Moved to the customer's record with their qualifier and in their order (the first term that matches decides, so order is kept) | 4.6.2 |
| The same terms in an included record | The include stays an include: only `+` address terms are copied as a pass | 5.2 |
| Order of the terms | Kept. `sameSpfRecord` sorts only addresses that stand next to each other, because the first term that matches decides | 4.6.2 |
| Void lookups (a lookup that returns nothing; more than 2 is a permanent error) | A pinned `a:` or `mx:` names the same name the original looked up, in the same order, and addresses (which cost no lookup) come first, so the flattened record never makes a void lookup the original would not. The property test checks it per sender: the flattened record's void lookups are at most 2 or at most the original's | 4.6.4 |
| Lookups (10) and size (450 bytes) | Counted statically through includes; no choice that exceeds either is written; refused with the best choice named. The property test checks every `ok` result in the bounded modes | 4.6.4, 3.4 |
| A lattice of includes (a diamond of depth 20 is 2^20 paths) | Read once per name, entries kept once each; bounded by 40 DNS reads (`packages/dns-checks/test/spf-flatten.dag.test.ts`) | n/a |
| A record published as an include target (the hosted record) | Bare `a`/`mx`/`ptr` pinned to the customer's domain; a macro or a non-`+` qualifier at the root refused (`not_hostable`); the root `all` and `exp=` not carried, except `+all` (see below) | 4.6.2, 5.2, 7.3 |
| An include or redirect target with no SPF record, two SPF records, a truncated answer, a loop | A problem, never a smaller record | 4.5, 4.6.4 |

**Hosted records (a record published as an include target).** The hosted record (`<id>._spf.h.<zone>`) is evaluated by receivers as the target of `include:` in the customer's own record, `v=spf1 include:<id>._spf.h.<zone> <the original's all>`. An include answers only `pass` or "no match", and its own name is the current domain. So the engine's `publishedAs: 'include'` mode (`HOSTED_SPF_OPTS`, used by `src/hosted/service.ts` and `src/hosted/cron.ts`): a bare `a`, `mx` or `ptr` at the root is pinned to the customer's domain; a **macro** at the root, and any root term with a **qualifier other than `+`** before the `all` (`-ip4:`, `~a`, `?include:`), is refused in one sentence (kind `not_hostable`, HTTP 422 on enabling), because an include would turn that fail, softfail or neutral into "no match" and a macro would expand with the include's name; the root `all` and `exp=` are not carried (the customer's record keeps the original's `all`; an include never matches on its own `all`), except `+all`, which an include passes everyone with. So the include gives `pass` only where the original gives `pass`, and the customer's `all` decides the rest. The property test checks this mode: it evaluates the pointer record against the original for random records and senders ("include" mode, same assertions as the others).

## A removal waits

[ADR 0024](adr/0024-a-refresh-never-removes-an-address-on-first-sighting.md). Each inlined provider is compared with what the published record authorises for it (`spf_flatten_config.provider_state`):

- **Nothing removed**: the new record is written at once (additions are safe).
- **Something removed** (an old address or range that no new entry covers; a provider that now lists nothing is the same rule): the record is written with the new addresses **and** the ones that left, when that fits 10 lookups and 450 bytes; if it does not fit, nothing is written, not even the additions. The row is marked pending (`pending_removed`, `pending_since`, `pending_additions`) and the domain page says what is waiting and since when.
- **The same removal seen again at least four hours later** (`SPF_PENDING_CONFIRM_SECONDS`): the record is written in full. A different removal replaces the pending one and the clock restarts. No removal clears it (the provider came back), without a write.
- "Check again now" is the same check: before the four hours it answers that it will confirm after HH:MM UTC; after, it confirms.
- Audit: `spf_flatten.pending`, `spf_flatten.update` (with `confirmed_after_seconds`), `spf_flatten.pending_cleared`.

## When a domain, a workspace or a connection goes

A flattened record is never left in Cloudflare with the original lost (`restoreSpfBeforeRemoval`, `stopSpf` in `src/spf/refresh.ts`):

- **Deleting a domain** turns flattening off first (the original goes back). If that fails, the delete stops: HTTP 409 `spf_restore_failed` with the sentence, the original, and what Cloudflare holds. `DELETE /api/domains/:id?leave_spf_record=1` deletes anyway (audited as `spf_flatten.left_in_dns`, with both records).
- **Deleting a workspace or an account** restores every flattened record before anything is deleted; one that cannot be restored stops all of it (409, every original in the answer, nothing deleted). `leave_spf_record=1` on the same request deletes anyway.
- **Removing a Cloudflare connection** restores the records while the connection still works; where that fails, flattening stops, the row keeps the original, and the answer lists it (`spf_flattened`).
- **A connection that was revoked**, or **an ownership proof that is lost** (`withdrawProof`, an eviction): flattening stops (no refresh, no retry every day). The row stays in the state a failed turn-off leaves (`restore_failed`) with the original; the sentence says what Cloudflare holds and how to put the original back by hand.

## Long records

A TXT record over 255 bytes is several quoted strings in Cloudflare. What Cloudflare returns is read with `decodeTxtData` and what we write is `encodeTxtData` (both in `packages/dns-checks/src/txt.ts`: one place for TXT encoding and decoding): quoted strings of at most 255 bytes, split at a space, never inside a multi-byte character. Basis: Cloudflare's API documentation, DNS Records, Create DNS Record, TXT `content`: "The content must consist of quoted "character strings" (RFC 1035), each with a length of up to 255 bytes. Strings exceeding this allowed maximum length are automatically split." (<https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/>), and the DNS record types page: "As the content of TXT records consist of one or more text strings delimited by double quotes" and "if you save your TXT content without any quotes, Cloudflare will automatically add double quotes." (<https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/>). The Cloudflare stand-ins used by the tests and the e2e run (`test/helpers/cf-fake.ts`, `e2e/support/fake-cloudflare.mjs`, through `e2e/support/cloudflare-txt.mjs`) store TXT the same way when asked (`realisticTxt`), and `test/spf/long-records.test.ts` turns on, refreshes, checks for outside edits and turns off a 300-byte and a 449-byte record through them.

## The job

Daily at **11:00 UTC** (`0 11 * * *`, `wrangler.jsonc`), both modes. It was `0 10`; an installation whose `wrangler.local.jsonc` still lists `0 10 * * *` keeps working: `src/cron.ts` answers it with the same function, and a row looked at in the last 20 hours is not due, so an install with both triggers refreshes once a day. Remove the older trigger at your leisure.

Why `0 11`: the hosted service already runs `0 4` and `0 11` (the others are held), so no trigger change on the live instance. Wiki L-080 turned `0 11` on because it "writes no DNS" on hosted. That stays true while `HOSTED_SPF_FLATTENING` is off (the default): the job finds no workspace it may refresh. **The owner turning it on for a workspace is what makes `0 11` write DNS on hosted.**

**What `0 11` writes, and under which opt-in.** On self-host: the SPF TXT record at the apex of each domain whose owner turned flattening on (the opt-in is that button; every other domain is read, never written), through the Cloudflare connection that domain uses. On hosted: the same, only for workspaces `HOSTED_SPF_FLATTENING` admits (the operator's opt-in) and only for domains that have it on; and, where `HOSTED_RECORDS_*` is set, the hosted SPF record of each domain that has hosted records. Nothing else: no DMARC, MTA-STS or other record is touched by this job.

Per run (`src/spf/refresh.ts`): rows not looked at in the last 20 hours, never-looked-at first, then the longest ago; at most 20 per workspace and 100 per invocation, five at a time (`mapLimit`). A domain costs its DNS reads (at most 40; typically 8 to 16) plus about four Cloudflare calls (zone, list, write, read-back): **about 44 subrequests at worst, 16 typical**. Workers allow 50 external subrequests per invocation on the free plan (so about one flattened domain a run) and 10,000 on paid; the job stops at 4,000 subrequests in one invocation, which leaves room for the analytics, lifecycle and hosted jobs that share it. Self-hosters with more than a couple of flattened domains need the paid plan. A failure of one domain or workspace never stops the others.

Two runs at once, or a run while flattening is turned off, never write twice and never bring a turned-off row back: a run claims the row (compare-and-set on `revision`, a lease of 120 seconds), writes, reads back, and finishes only if the claim still holds; if it does not (flattening was turned off meanwhile), it puts the owner's original back.

Hosted records (`include:<id>._spf.h.<zone>`, [hosted.md](hosted.md)) use the same engine and the same removal rule: `src/hosted/cron.ts` calls `flattenFromSource` with the stored `hosted_domains.spf_source` and the state the last run stored (`hosted_domains.spf_state`), and `decideSpfWrite` (`src/spf/refresh.ts`, the function `refreshSpf` uses too) decides what may be written. They need `HOSTED_RECORDS_*`, which the live instance does not set.

## What the owner sees

The domain page leads with **Do this next**. When the record needs more than 10 lookups, the first step is "Bring SPF down to 10 DNS lookups or fewer", and its link stands directly under the step (before the reason), so it is on the first screen of a phone. With the add-on the link is "Open SPF flattening"; **without it (hosted, not admitted) it is "See where the lookups go"**: a read-only page (`web/src/pages/domains/SpfLookupsPage.tsx`, `GET /api/domains/:id/spf-lookups`, `src/spf/breakdown.ts`) that counts the lookups term by term (the same walk as the engine, `lookupBreakdown`), names the costliest includes, includes of one provider, and `a`/`mx` terms that can be listed as addresses, and links to the SPF step of the setup to edit by hand. The step reads the lookups of the flattened record when flattening is on, never a count stored before. The count itself is stored by the daily check, when a domain is added, and by the domain page's own live read, all through the instance's resolver (`resolverFor`), so a self-hosted instance has it as hosted does.

While flattening is on (or was), **one line under the page header** says where it stands and links to the page ("SPF flattening: on · 3 of 10 lookups · checked 2 hours ago", "SPF flattening: waiting to confirm a change, after 15:20 UTC.", "SPF flattening has stopped: ...", "SPF flattening needs attention."). The page (`web/src/pages/wizards/SpfFlattenPage.tsx`) is the status home; the card (`web/src/components/domain/SpfCard.tsx`, under DNS tools) says the same things. The words are in `web/src/lib/spf-flatten.ts`:

- **off**: "Your record needs 14 lookups; receivers stop at 10. Flattening replaces the includes with the addresses behind them." Within the limit: "Your record uses 3 of the 10 lookups receivers allow, so it does not need flattening." and, on the page, "Flattening is for records that need more than 10 lookups. Within the limit, a record with includes follows its providers as they change; a flattened one follows them once a day." ("Flatten anyway" stays the quiet way on.)
- **before turning on**: "When a provider starts sending from new addresses, mail from them can fail SPF until the next daily check, up to about a day."
- **on**: "On: 23 addresses in your record, using 7 of the 10 lookups. Checked 2 hours ago; not changed since you turned it on. Checked again every day around 11:00 UTC." After a change, "What changed on 12 Nov" shows the previous and the current record.
- **waiting to confirm a change** ([ADR 0024](adr/0024-a-refresh-never-removes-an-address-on-first-sighting.md)): "Waiting to confirm a change: _spf.foxtrot-help.net no longer lists 2 addresses. We kept them in your record and will take them out only if the next check, after 15:20 UTC, sees the same. Anything new from your providers is already in your record." (or "New addresses are not in your record yet: with the held ones they would not fit in one record, so nothing was written."), then "We wait at least 4 hours so the second look is a fresh answer from the provider, not a copy of the first." and **Check again now**: before the time it answers when it can confirm; after it, it confirms or clears.
- **needs attention**: the sentence below, and the one action: *Try again* (a provider could not be read), *Reconnect Cloudflare*, *Turn off* (too large, macro), *Review* (edited or deleted in Cloudflare).
- **review after an edit made in Cloudflare**: both records, and a choice, "Use my edit as the new original" (selected: the edit becomes the original and the flattened record is made from it, so what the edit added stays; addresses it already lists stay as written and no longer follow a provider) or "Discard my edit" (the flattened record is written; the terms of the edit it drops are listed first, "These will be dropped: include:newprovider.example.", and the audit entry keeps the dropped record).
- **stopped** (connection gone, proof lost): the card and the page say the app can no longer change the record, that the daily check has stopped, what is in Cloudflare (read now when it can be, else as of the last check) and the original, with a copy button, and the way on: reconnect Cloudflare, or prove ownership again, or "Try to put it back".
- **the add-on went away while it was on**: "Flattening is not switched on for this workspace any more, so the record is no longer refreshed. It still lists the addresses from the last check." Only what still works is offered: Turn off and Back; no check, no preview.
- **the daily check has not run** (last check older than two days): "Last checked 12 Nov. The daily check has not run since."

**Deleting** a domain or a workspace says which original is put back first and that nothing is deleted if it cannot be; when the restore fails the dialog shows the reason and the original to copy, and **Delete anyway** (the only way to `?leave_spf_record=1`) says that the flattened record then stays in Cloudflare and nothing will refresh it.

The problem sentences are written by the server (`src/spf/refresh.ts` `problemSentence`) and stored in `last_error`. Every change writes an audit entry `spf_flatten.update` (before and after); a problem writes `spf_flatten.problem` once when it starts. Turning on and off write `spf_flatten.enable` and `spf_flatten.disable`; using an edit as the new original writes `spf_flatten.adopt` (the old original and flattened record before, the new original and record after; [ADR 0025](adr/0025-the-owner-may-adopt-an-outside-edit-as-the-new-original.md)).

## Who may use it

`capability(env, 'spf_flattening', scope)` in `src/hosted/plan-limits.ts` is the one answer, asked by every route, `/api/me` (`add_ons.spf_flattening`), the job and the next-step link:

- **Self-host**: always available.
- **Hosted**: only for a workspace the operator admitted with **`HOSTED_SPF_FLATTENING`**: unset, empty or not understood = off (the default); `owner` = the workspaces owned by the `OWNER_EMAIL` account; `all`; or workspace ids (`ws_...`, comma separated, with or without `owner`: `owner,ws_0123...`). Everyone else on hosted sees nothing: no card, no next-step link, the routes answer 404. The parser is `src/hosted/allow.ts`, the same one `HOSTED_CONNECT_REPORTS` uses.
- **Turning off is never refused.** If the setting is removed from a workspace that has a domain flattened, the card stays and says refreshing stopped; the record keeps the addresses of the last check; Turn off restores the original.

To enable it for one customer's workspace: find the id (`SELECT id FROM workspaces WHERE name = ...`), set `HOSTED_SPF_FLATTENING` to `owner,<id>` (a Worker variable; no deploy of code), and check the owner's setup check for an unknown value. To switch it off for everyone: unset it.

## Rolling back

The refresh keeps `previous_record` (the flattened record before the last change); the domain page shows it after a change. There is no rollback button (a rollback would be undone by the next refresh, which makes its own choice from the original). To put the previous record back by hand: copy it from "What changed" (or from the audit entry's `before` value), paste it into the SPF TXT record in Cloudflare, and **turn flattening off** so the daily check does not write the current choice again. `rollbackSpf` (`src/spf/refresh.ts`) does the same write for an operator or support script: it puts `previous_record` back when the record in Cloudflare is still the current one, and refuses when someone edited it.

## What must be true before it is sold

- The price (O-13, [OPEN.md](adr/OPEN.md)) and its basis; then #180's plan engine attaches a subscription item per domain to `capability` (a reason `subscription`), and decides what a lapse does: keep the last good record and stop refreshing (what this change does when the setting goes away), restore the original, or keep refreshing for a grace period. Left open on purpose.
- A walk on the live target as a new customer, with real Cloudflare: that a record over 255 bytes round-trips as the documentation says (the stand-ins model it; only Cloudflare proves it), and that the first `0 11` run on a workspace the operator admitted writes what the screen promised.
- Self-host operators have read the subrequest numbers above.
