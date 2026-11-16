# New hosted user signs up and gets DMARC live through Cloudflare

- **Value moment:** Records live: ownership proven and DMARC seen in public DNS. The report address is in the record only for a workspace `HOSTED_CONNECT_REPORTS` admits (by default the operator's own); any other new customer gets DMARC without it.
- **Visitor:** a new hosted user who arrives at the sign-up link, with a domain on Cloudflare.
- **As built by PR #177 (2026-11-16).** S1 to S4, Cloudflare's own consent, C2 review and the first-day dashboard. An agency ("My clients'") has only the client domain's zone imported; a company has every active zone.

```mermaid
flowchart TD
  entry([Sign-up link]) --> s1[S1 Create your account: email and password]
  s1 --> s2[S2 Tell us about yourself]
  s2 --> s3[S3 Check your inbox: the 6-digit code, emailed when S1 was submitted]
  s3 --> s4[S4 Which domain? One line of public DNS and the choice]
  s4 -->|Connect Cloudflare| consent{Cloudflare consent: allow?}
  s4 -->|add the records myself| manual([Manual path: separate flow])
  consent -->|cancelled| s4
  consent -->|allow| c2[C2 Review: what exists, what will be written]
  c2 -->|Apply| d1[First-day dashboard: written, waiting for public DNS]
  d1 --> dns((Wait: public DNS shows the record))
  dns --> live[Records live: first reports on their way]:::value
```
