---
status: accepted
date: 2026-11-16
decided-by: owner
---
# A person removed from, or leaving, their only workspace keeps their account

Removing a member, or a member leaving, ends their membership of that workspace and nothing else: the login, its sessions and its other workspaces stay. A person with no workspace left lands on "No workspace yet", whose Create workspace leads into the normal first-run setup. Owner decision, 2026-11-16, asked whether a person removed from their only workspace keeps their login: "A person removed from their only workspace: yes keep the login. Just empty with a create org and it takes you to the flow, right?"

Numbered 0019 because main has 0014, PR 186 adds 0018 and 0015 to 0017 are reserved for #180 (#184 and #181 also add 0015), so 0015 to 0018 are listed as reserved in the index until those pull requests land.

**Consequences**
- `teamQueries.removeMembership` replaces the earlier remove-and-delete: it no longer deletes the user row. `teamQueries.revokeAccessOf` ends their API keys and agent approvals (human access principals, with their grants and credentials) for that workspace, on removal and on leaving; no data of the workspace goes with them.
- Leaving your only workspace is allowed (`POST /api/workspaces/:id/leave`). Unchanged: the last owner cannot leave (hand ownership on first), and a workspace that is your only one cannot be deleted, so an owner's exit from it is handing ownership on or deleting the account.
- Hosted: anyone with no workspace may create one. Self-host: only the owner of the instance may (`canCreateWorkspace`, `POST /api/workspaces`), so on "No workspace yet" everyone else is told to ask that owner to invite them.
- `GET /api/team` no longer returns `other_workspaces`. A `403` for a person who belongs to no workspace carries `code: no_workspace`, and the dashboard then asks `/api/me` again and shows "No workspace yet".
