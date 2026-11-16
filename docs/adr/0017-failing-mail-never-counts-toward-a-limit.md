---
status: Proposed by the coordinator, pending owner confirmation
date: 2026-11-16
decided-by: coordinator (basis: the customer does not control it; industry practice)
---
# Mail that fails authentication never counts toward a customer's limits

A customer does not control who fakes their domain. The free plan's daily volume therefore counts only report rows that PASS DMARC for the customer's own domain (aligned SPF or aligned DKIM, the parser's own judgement); failing rows are stored and shown within a separate storage bound, and when the room for them is used up they are summarised by source network with exact message totals, never refused. A report with more rows than a report is stored with is accepted: every passing row kept, the failing rows with the most messages kept, the rest summarised. Basis: dmarcian ("we don't want to charge our users for forwarded or fraudulent traffic"), PowerDMARC, GlockApps and DMARC Report state the same.

**Consequences**
- The free-plan limit is 20,000 passing rows a day per workspace. Failing rows may use up to half of each stored-records cap; the other half is kept for passing mail.
- The operator is emailed (once per workspace per day each) when a free workspace's passing volume passes 5,000 rows, and when a workspace sees an extreme number of failing rows (100,000 a day): separate alerts, neither shown to the customer.
- The global safety caps (messages per address and workspace, records held) stay for everyone, because they protect the instance; they are far above the free numbers.
- Public sentence (not on the site yet): "Mail that fails authentication never counts toward your limit, so someone faking your domain cannot use up your plan."
