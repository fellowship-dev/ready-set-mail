# Invited teammate joins the workspace

- **Value moment:** The teammate sees the workspace's domains with each one's verdict.
- **Visitor:** a teammate invited by an owner or admin; a read-only member by default (only an owner can invite an admin).
- **As built on `main` 6a7d775 (2026-11-15).** The product sends no invite email: the owner passes the link on.

```mermaid
flowchart TD
  entry([Owner opens Members]) --> form[Invite: email and role]
  form --> link[One-time link shown in an alert]
  link --> pass((Wait: owner sends the link by their own email or chat))
  pass --> join[Invite page: name and password, or Accept for an existing login]
  join --> code[Enter the 6-digit code]
  code --> overview[Overview: domains and their verdicts]:::value
```
