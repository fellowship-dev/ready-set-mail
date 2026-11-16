---
status: accepted
date: 2026-11-15
decided-by: recorded in DESIGN.md with the rebrand (PR #172); owner quote not on record
---
# Emails carry no remote images

Product emails show the wordmark as text (navy Arial on a light cell with the brand-blue rule), not a logo image, so they read the same with images blocked and in forced dark mode.

**Consequences**
- Email HTML lives in `src/email/html-templates.ts`; `DESIGN.md` (Brand) states the rule. Adding an `<img>` to an email needs a new ADR.
