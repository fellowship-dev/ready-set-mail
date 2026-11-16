# Owner turns on SPF flattening and it stays correct

- **Value moment:** Flattening is on: the SPF record in Cloudflare lists the sender addresses directly, within 10 lookups and 450 bytes, and the daily check keeps it current, or says on the domain page why it could not and what to do. The owner can turn it off and get the original record back.
- **Visitor:** the owner or an admin of a domain whose SPF record needs more than 10 DNS lookups (RFC 7208 section 4.6.4), with Cloudflare connected, on a self-hosted instance or on a hosted workspace the operator enabled it for (`HOSTED_SPF_FLATTENING`). Everyone else on hosted sees nothing.
- **As built in this change (2026-11-16).** Basis: owner, Nov 16: "Spf is a continuous work. Its an add on and it needs its own price, per domain" (price open); ADR 0022 (one refresh engine), ADR 0023 (the add-on). Shortened from the value backwards (ADR 0012): the old Analyze and Compare screens are one, so the path is the card, one screen with both records, one screen with the write, and the state view.

```mermaid
flowchart TD
  entry([Domain page: SPF over the limit]) --> why[Your SPF record: why it matters, the record and the flattened one]
  why -->|within the limit| fine[Within the limit: not needed, Flatten anyway is the quiet way on]
  why -->|cannot be flattened| refuse[One plain sentence: unreadable include, no choice fits both limits, macro; DNS untouched]
  refuse -->|Back to domain| done
  fine -->|Back to domain| done
  why -->|Continue| turn[Turn on: what is written, when it is checked]
  fine -->|Flatten anyway| turn
  turn -->|Turn on flattening| write{Cloudflare accepts the write?}
  write -->|connection lost| lost[We could not reach Cloudflare: Reconnect Cloudflare]
  lost -->|Reconnect Cloudflare, then try again| turn
  write -->|written| live[SPF flattening is on: record, last checked, checked every day]:::value
  live --> wait((Wait: daily check around 11:00 UTC))
  wait -->|providers unchanged: nothing written| live
  wait -->|provider addresses changed: record updated, audit entry, previous record kept| upd[Changed on date: before and now one click away]
  upd --> live
  wait -->|include stops resolving, too large, macro, connection lost: record left as it was| prob[Needs attention: one action]
  prob -->|Try again, Reconnect Cloudflare| live
  wait -->|edited in Cloudflare: never overwritten| edited[Review: in Cloudflare now and flattened from your original]
  edited -->|Replace with the flattened record| live
  edited -->|Stop flattening| off
  live -->|Turn off| off[Original record back in Cloudflare]
  prob -->|Turn off| off
  off --> done([Domain page: flattening off])
```

## Failure paths: what the person sees, and the one action

| Path | Where it is found | What the person sees | The one action |
|---|---|---|---|
| Cloudflare connection lost | turning on, every daily check, turning off | "We could not reach Cloudflare. Your record in Cloudflare is unchanged." | Reconnect Cloudflare |
| A provider include stops resolving (no record, two records, SERVFAIL, truncated answer, loop) | the screen before turning on, turning on, the daily check | "We could not read the SPF record of X (why). Your record in Cloudflare is unchanged." | Try again |
| Nothing fits within 10 lookups and 450 bytes | the screen before turning on, turning on, the daily check | One sentence naming what the best choice would need; the record is left as it is | Back (before turning on); Turn off (when on) |
| A macro in an include or redirect target | same | "X uses a macro, so the addresses depend on who is sending and cannot be flattened." | Back; Turn off |
| Someone edits the record in the app by hand | `apply-spf` | "SPF flattening is on for this domain. Turn it off before editing the SPF record here." | Turn flattening off on the domain page |
| Someone edits the record in Cloudflare | every daily check, before any write | "...not the one Ready Set Mail published, so someone changed it there. We have left it as it is." | Review |
| The record is deleted in Cloudflare | same | "There is no SPF record at X in Cloudflare now. We have not added one." | Review |
| Turning off and Cloudflare refuses the original back | turning off | The original record is shown to copy; the row is kept | Try again |
| Turning off over an outside edit | turning off | "We left it as it is": flattening stops, nothing is written over the edit | none |
| The add-on is switched off for a hosted workspace that has it on | every screen | "Flattening is not switched on for this workspace any more, so the record is no longer refreshed." | Turn off |
| The daily check does not run | the last check is older than two days | "Last checked X. The daily check has not run since." | none (the operator's job) |
