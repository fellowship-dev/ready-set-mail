---
status: accepted (code not yet aligned)
date: 2026-11-15
decided-by: owner
---
# Fix one domain ($149) ends at DMARC monitoring with reports, not at reject

The $149 offer is "C1": a dated report, up to five senders verified with real messages, DMARC at monitoring with reports to Ready Set Mail, and a written done note. Moving the domain to reject is a separate, later offer. Owner decision, 2026-11-15: "C1."

**Consequences**
- `OFFER_SCOPE` in `src/billing/offer.ts` still promises "DMARC moved to reject": a known contradiction, listed in `docs/single-sources.md` and `OPEN.md` until its wording is approved and changed.
