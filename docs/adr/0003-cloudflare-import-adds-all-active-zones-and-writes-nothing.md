---
status: accepted
date: 2026-11-15
decided-by: owner
---
# Connecting Cloudflare imports every active zone and writes nothing to DNS

After a Cloudflare connection is made, every active zone it can see becomes a verified domain of the workspace without a selection screen, and nothing is written to DNS. The list to choose from appears only when the zones do not fit the plan's domain cap. Owner decision, 2026-11-15: "I would show the selection list only if the domain count exceeds the plan then, otherwise auto import."

**Consequences**
- `importZones` in `src/connections/import.ts` is the import; it calls the ownership rule of ADR 0002 and the domain cap (`domainCap` in `src/domains/service.ts`).
- Writing DNS during import would contradict ADR 0004.
