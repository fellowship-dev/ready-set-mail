# Not affected: agent-connects-and-reads-report

- **Flow:** agent-connects-and-reads-report
- **Changed:** `web/src/pages/auth/NoWorkspacePage.tsx`
- **Reason:** `web/src/pages/auth/NoWorkspacePage.tsx` (the "No workspace yet" page, ADR 0019): reached only by a signed-in person who belongs to no workspace (an invitee whose invite is gone, someone removed from or who left their only workspace); a person on this flow either has just made their workspace at sign-up or is joining one, so they never see it. The page now says on self-host that only the instance owner creates workspaces (and offers no form), and hosted is unchanged. The agent flow's sign-in (`web/src/pages/auth/AuthPage.tsx`), the consent page and the tokens are untouched, and an agent's person who has a workspace never reaches this page.
- **By:** Claude (Fable 5.2) for Max F. Findel, PR "truth-and-dead-ends"; reviewer to accept
- **Date:** 2026-11-16
- **File name:** dated 2026-11-15 so that it cannot collide with the same-day record of this flow that is already in main.
