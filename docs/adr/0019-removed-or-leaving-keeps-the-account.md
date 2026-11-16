---
status: accepted
date: 2026-11-16
decided-by: owner
---
# A person removed from, leaving, or left by a deleted workspace keeps their account

Removing a member, a member leaving, or the workspace being deleted ends their membership of that workspace and nothing else: the login, its sessions and its other workspaces stay. A person with no workspace left lands on "No workspace yet", whose Create workspace leads into the normal first-run setup. Owner decision, 2026-11-16, asked whether a person removed from their only workspace keeps their login: "A person removed from their only workspace: yes keep the login. Just empty with a create org and it takes you to the flow, right?"

Numbered 0019 because main has 0014, PR 186 adds 0018 and 0015 to 0017 are reserved for #180 (#184 and #181 also add 0015), so 0015 to 0018 are listed as reserved in the index until those pull requests land.

**Consequences**
- `teamQueries.removeMembership` replaces the earlier remove-and-delete: it no longer deletes the user row. `teamQueries.revokeAccessOf` ends their API keys and agent approvals (human access principals, with their grants and credentials) for that workspace, on removal and on leaving; no data of the workspace goes with them.
- Leaving your only workspace is allowed (`POST /api/workspaces/:id/leave`). Unchanged: the last owner cannot leave (hand ownership on first); the dashboard shows that state before the click (Leave is disabled, with the reason).
- Deleting a workspace follows the same rule: its members keep their accounts (`eraseWorkspace` no longer deletes the logins of people whose only workspace it was; `users.deleteIfOrphan` is gone), their keys and agent approvals for it end with it, and they land on "No workspace yet". An owner may therefore delete their own only workspace (the former `409 only_workspace` is gone: it protected a login that no longer depends on a workspace). The default workspace of a self-hosted instance still cannot be deleted. The delete dialog says what happens to the people in it.
- Hosted: anyone with no workspace may create one. Self-host: only the owner of the instance may (`canCreateWorkspace`, `POST /api/workspaces`), so on "No workspace yet" everyone else is told to ask that owner to invite them.
- `GET /api/team` no longer returns `other_workspaces`. A `403` for a person who belongs to no workspace carries `code: no_workspace`, and the dashboard then asks `/api/me` again and shows "No workspace yet".
