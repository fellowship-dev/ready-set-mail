---
status: accepted, owner to confirm
date: 2026-11-16
decided-by: the independent review of PR 177 (review item 4); owner sign-off not recorded
---
# An agency's Cloudflare connection imports only the zone of the client being set up

Supersedes [ADR 0003](0003-cloudflare-import-adds-all-active-zones-and-writes-nothing.md) for one case. When a person signed up as "My clients'" (an agency or IT provider), connecting Cloudflare imports only the zone that covers the client domain being set up into that client's workspace; the other zones of the account are listed ("Also in this Cloudflare account", not added) and nothing is imported for them. For "My company's" and "Just looking around", ADR 0003 stands: every proven zone, the list only when the plan's domain cap would be exceeded.

An agency's own Cloudflare account usually holds many clients' zones; putting all of them into one client's workspace shows one client's domains to that client's people and writes into the wrong place. The server already accepts an explicit zone list (`importZones` with `zone_ids`), so this is the dashboard asking for one zone and adds no new write path. Nothing is written to anyone's DNS (ADR 0004 is untouched), and the ownership rule (ADR 0002) is applied to that zone exactly as before.

**Consequences**
- `ImportStep` (`web/src/pages/wizards/cloudflare/ImportStep.tsx`) passes the zone ids covering the workspace's pending claims when `whose_email` is `clients` (`zoneCovering` in `web/src/lib/first-run.ts`); with no client domain waiting it imports nothing and Add domain offers the account's zones.
- Not built: "Create a workspace for each zone". Connections are workspace-scoped and hold an encrypted token, so a workspace per zone means copying the credential into N workspaces (or N consents) and running the ownership proof in each, which changes ADR 0002's surface; and a person may own `MAX_WORKSPACES_PER_USER` workspaces (`src/hosted/plan-limits.ts`). A later change needs a safe per-workspace connection grant and its own decision.
