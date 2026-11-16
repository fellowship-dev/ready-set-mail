---
status: accepted (implemented on main; owner sign-off not recorded)
date: 2026-11-15
decided-by: coordinator proposal, implemented; the owner asked whether per-customer addresses were needed and no objection followed
---
# Hosted customers publish one shared report address, routed by the domain inside the report

On the hosted service every customer's DMARC record points to the same address, `rua@<INTAKE_DOMAIN>`. A report names its domain inside the XML; the intake reads that domain and files the report under the workspace that proved the domain. A per-customer token in the address adds no secrecy (the address is public in DNS). Owner question, 2026-11-15: "I thought we were gonna do a specific hash-based address per customer."

**Consequences**
- The address is built in exactly one place: `fixedReportAddress` in `src/hosted/fixed-address.ts`; attribution is `attributeReport` there. Token addresses (`rua+<token>@`, `intakeAddress` in `src/hosted/tokens.ts`) remain only for hosted records. Self-host uses its own reports domain (`rua@reports.<base domain>`).
- Who may connect reports is `HOSTED_CONNECT_REPORTS` (default `owner`); opening it to all customers is open (see `OPEN.md`).
