# Invited teammate joins the workspace

- **Value moment:** The teammate sees the workspace's domains with each one's verdict.
- **Visitor:** a teammate invited by an owner or admin; a read-only member by default (only an owner can invite an admin).
- **As built on `main` 6a7d775 (2026-11-15), then PR #177.** An ordinary invite sends no email: the owner passes the link on. A hand-off ("Hand setup to a teammate") emails a fixed invitation and lands the teammate on that domain's S4.

```mermaid
flowchart TD
  entry([Owner opens Members]) --> form[Invite: email and role]
  form --> link[One-time link shown in an alert]
  link --> pass((Wait: owner sends the link by their own email or chat))
  pass --> join[Invite page: name and password, or Accept for an existing login]
  join --> code[Check your inbox: the same code screen as sign-up]
  code --> overview[Overview: domains and their verdicts]:::value
```
