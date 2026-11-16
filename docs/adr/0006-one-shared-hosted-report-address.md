---
status: accepted (implemented on main; owner sign-off not recorded)
date: 2026-11-15
decided-by: coordinator proposal, implemented; the owner asked whether per-customer addresses were needed and no objection followed
---
# Hosted customers publish one shared report address, routed by the domain inside the report

On the hosted service every customer that connects reports points its DMARC record at the same address, `rua@<INTAKE_DOMAIN>`. A report names its domain inside the XML; the intake reads that domain and files the report under the workspace that proved the domain. A per-customer token in the address adds no secrecy (the address is public in DNS). Owner question, 2026-11-15: "I thought we were gonna do a specific hash-based address per customer."

**Consequences**
- The shared address is built by `fixedReportAddress` in `src/hosted/fixed-address.ts`; attribution is `attributeReport` there. It is one of four report-address forms (`CONTEXT.md`, "Report address"), and the others are still built in other files (`docs/single-sources.md`, "Report address construction"): token addresses (`rua+<token>@`, `intakeAddress` in `src/hosted/tokens.ts`) for hosted records (`src/hosted/records.ts`, `src/hosted/service.ts`) and for domains connected before the shared address existed; self-host's own reports domain; and the agent report's `dmarc@<domain>`.
- Who may connect reports is `HOSTED_CONNECT_REPORTS`, default `owner`: only the operator's own workspaces. Every other hosted customer gets no shared address today: its DMARC record is written without one. Opening it to all customers is an open decision (`OPEN.md`).
