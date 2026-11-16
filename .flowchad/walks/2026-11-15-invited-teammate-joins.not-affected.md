# Not affected: invited-teammate-joins

- **Flow:** invited-teammate-joins
- **Changed:** `src/api/router.ts`
- **Reason:** I read `git diff 61e6b8f -- src/api/router.ts`: the SPF flattening routes now call `src/spf/refresh.ts` behind one add-on gate, `GET /api/me` gains an `add_ons` field, the hand-edit refusal of `apply-spf` has a truer sentence, and two DNS reads (the DMARC read and the status route) use `resolverFor(env)` instead of the public resolver. No invite, hand-off, sign-up, code, join or member route is in the diff, no response of those routes changes, and `/api/me` only adds a key (the join page does not read it). Proof: `npx vitest run --config vitest.node.config.mts test/auth test/trust test/api` and `npm run test:web` pass, including `test/trust/roles-and-gating.test.ts` and the invite specs.
- **By:** Claude (Fable 5.2) for Max F. Findel, the SPF flattening pull request; reviewer to accept
- **Date:** 2026-11-16
