# Not affected: agent-connects-and-reads-report

- **Flow:** agent-connects-and-reads-report
- **Changed:** `src/access/http-policy.ts`, `src/mcp/tools/index.ts`
- **Reason:** Connecting, consent, token exchange and the tool list are unchanged. `src/access/http-policy.ts` lists the new read operation `names` beside the other report reads a delegated key may call (`reports:read`); `src/mcp/tools/index.ts` passes one more fact (the name does not exist in DNS) into the DMARC next-step evidence, which changes the step only for a domain whose DNS says NXDOMAIN and nothing else. REVIEWER: the words of the report the agent reads (the SPF line, the policy line for a subdomain) did change, but in `packages/dns-checks/src/report.ts`, which this flow's `covers:` list does not map; reject this record if that report text counts as part of the flow.
- **By:** Claude (agent), for review by Max F. Findel
- **Date:** 2026-11-16
