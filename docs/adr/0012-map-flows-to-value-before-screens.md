---
status: accepted
date: 2026-11-15
decided-by: owner
---
# Map the flow to its value moment before designing or changing screens

Before a screen is designed or changed, the flow it sits on is drawn from entry to value moment (`.flowchad/flows/<id>.map.md`) and shortened from the value moment backwards. Flows that reach value are protected: a change to a page on one needs a fresh walk record. Owner, 2026-11-14: "It's time to bring in the flowchad. What are our flows? Which ones matter the most?"

**Consequences**
- Saved flows, maps and walk records live in `.flowchad/`; `scripts/check-flows.sh` (CI) fails a change to a protected flow's pages without a walk record.
