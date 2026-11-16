---
status: accepted
date: 2026-11-15
decided-by: owner
---
# Reviews of the hosted service judge what can happen with today's customers

For the hosted service, a review finding must name a way it can happen with the customers it has today. Hypothetical legacy states with no real holder on the hosted service are not fixed or reviewed further. Owner decision, 2026-11-15, on a review finding about a legacy verification state that no installation holds.

**Consequences**
- A hosted-service finding with no path through a real customer is closed with that reason, not patched.
- Self-hosted installs are not covered: they upgrade from any earlier release (`packages/db/UPGRADING.md`), so every schema change still ships as a migration and old states a self-host can hold are still handled.
