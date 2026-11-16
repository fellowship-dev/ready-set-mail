---
status: accepted; superseded in part by 0014 (an agency's first connection)
date: 2026-11-15
decided-by: owner
---
# Connecting Cloudflare imports every proven zone and writes nothing to the importer's DNS

After a Cloudflare connection is made, every zone it can see that passes the ownership rule of ADR 0002 becomes a verified domain of the workspace without a selection screen; a zone that fails is skipped. Nothing is written to the importing workspace's DNS. The list to choose from appears only when the zones do not fit the plan's domain cap. Owner decision, 2026-11-15: "I would show the selection list only if the domain count exceeds the plan then, otherwise auto import."

**Consequences**
- `importZones` in `src/connections/import.ts` is the import; it calls the ownership rule of ADR 0002 and the domain cap (`domainCap` in `src/domains/service.ts`).
- The one DNS change an import can cause is not the importer's: when its proof takes a name from another workspace's unproven holder, that workspace's hosted and report-authorization records for the name are deleted (ADR 0004). Any other DNS write during import would contradict ADR 0004.
