---
status: accepted
date: 2026-11-16
decided-by: the coordinator, 2026-11-16 (round 2 of PR 189, from the independent review of the Replace dialog)
---
# After an edit made outside the app, the owner chooses: use it as the new original, or discard it

When the SPF record in Cloudflare is not the one Ready Set Mail published, someone changed it there. The round 1 screen offered one way on, "Replace with the flattened record", and its dialog never said that the edit (a new `include:`, say) would be lost; it was kept only as `previous_record`. That is the wrong default for a person who edited their record on purpose.

**What this changes**
- Review offers two choices. **"Use my edit as the new original"** is selected: the record in Cloudflare becomes the original (`spf_flatten_config.canonical_record`) and the flattened record is made from it, so what the edit added stays (`adoptSpf` in `src/spf/refresh.ts`, `POST /api/domains/:id/spf-flatten/adopt`, audit `spf_flatten.adopt` with the old and the new original and record). Nothing is written unless the edit can be flattened; addresses the edit already lists stay as written and no longer follow a provider. **"Discard my edit"** is the old Replace (`POST .../refresh` with `replace: true`): the flattened record from the original is written, the dialog first lists the terms it drops ("These will be dropped: include:newprovider.example."), and the audit entry keeps the dropped record.
- This **supersedes one sentence of ADR 0026**: "the original is set when flattening is turned on and never rewritten while it is on". It is now rewritten in one case only, by the owner's choice here. A refresh never rewrites it.
- Basis: the safe default is the one that loses nothing (the owner's rule that the product does not remove what a person put there without saying so, and ADR 0028's rule for providers); the destructive choice is named and listed before it is made.

**Consequences**
- Adopting follows the removal rule of [ADR 0028](0028-a-refresh-never-removes-an-address-on-first-sighting.md) (`decideSpfWrite`, the one rule): the new original is flattened against what the published record authorises, so addresses that would leave (a provider that now lists fewer, or an include the edit dropped, unless the edit lists the addresses itself) are held and the removal waits, a removal already waiting is carried with its clock, and additions are written at once. If the held record does not fit the limits nothing is written and the person is told so. A waiting removal that is confirmed (four hours on) is written. The daily check goes on from the new original.
- `docs/spf-flattening.md` and `CONTEXT.md` ("original record", "adopt") say it; the card and the page use the words above.
