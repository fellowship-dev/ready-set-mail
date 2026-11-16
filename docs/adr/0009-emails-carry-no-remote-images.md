---
status: accepted
date: 2026-11-15
decided-by: recorded in DESIGN.md with the rebrand (PR #172); owner quote not on record
---
# Emails carry no remote images of ours

Product emails show the wordmark as text (navy Arial on a light cell with the brand-blue rule), not a logo image, so they read the same with images blocked and in forced dark mode. The one remote image is a workspace's own logo, when the workspace sets one (`brand_logo_url`).

**Consequences**
- Email HTML lives in `src/email/html-templates.ts`; `DESIGN.md` (Brand) states the rule. Adding any other `<img>` to an email needs a new ADR.
