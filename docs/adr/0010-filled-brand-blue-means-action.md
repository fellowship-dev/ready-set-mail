---
status: accepted
date: 2026-11-15
decided-by: recorded in DESIGN.md (the Action-Fill Rule)
---
# A filled brand-blue surface means "press this" or "you are here"

Only primary actions, the selected navigation marker, checked controls and wizard progress are filled with the brand blue. Levels, badges, counts, step markers and other states never are; notes use the info colour.

**Consequences**
- `packages/ui/test/brand.test.ts` checks the `bg-brand` uses. The palette and rule are in `DESIGN.md`.
