# Not affected: signup-to-records-live-manual

- **Flow:** signup-to-records-live-manual
- **Changed:** `web/src/app.tsx`
- **Reason:** `Gate` (the sign-in and workspace gate around the dashboard) gains two effects for a person who arrived from an app's approval page: it keeps a `?continue=<an /oauth/authorize request>` from the address (`captureResume`, `web/src/lib/resume.ts`) and, once the person is signed in with a workspace, sends them back to that request (`takeResume`). Without that parameter nothing is read, stored or redirected: the sign-up screens, the code step, the first-run redirect, the domain, Connect Cloudflare or the record steps of this flow are untouched, and a person on this flow never has the parameter (it is only written by the agent approval page's "Sign in and continue" link). Checked by `web/test/resume.test.ts` (only that endpoint's path is accepted; everything else is dropped) and by the full e2e suite (`e2e/signup.spec.ts`, `e2e/cloudflare-first.spec.ts`, `e2e/cloudflare-first-run.spec.ts`, `e2e/first-run.spec.ts`) on this commit; the flow that does change, agent-connects-and-reads-report, is walked.
- **By:** Claude (Fable 5.2) for Max F. Findel, PR "agents-connect"; reviewer to accept
- **Date:** 2026-11-16
