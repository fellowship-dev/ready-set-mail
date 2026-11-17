# Workspaces

A **workspace** holds domains, reports, members, Cloudflare connections and (later) billing. A **user** is one person with one login; a user belongs to workspaces through **memberships** with a role: `owner`, `admin`, or `member` (read-only). The role is per workspace: you can own one and be a read-only member of another.

## Using them

* The **switcher** at the top of the sidebar shows the workspace you are in, lists every workspace you belong to with your role, and has *Create workspace*. Whoever creates a workspace is its owner.
* The workspace is in the URL: `#/w/<workspaceId>/domains/1`. Links are shareable and a reload keeps your place. After signing in you land in the last one you used (remembered in the browser); a link to a workspace you cannot use shows a notice and opens one you can.
* **Members** (sidebar, owners and admins only: the server refuses the list to a member, so a member is not offered it) is the member list of the open workspace. Owners and admins invite people there; an invite is a one-time link (7 days). Nothing is emailed from that form on either mode (it says "This invite is not emailed"); on the hosted service, handing a domain's setup to a teammate is a separate invite, with its own screen, that is emailed when `mayEmailHandoff` allows it. The owner changes a member's role there (member or admin) from the row's role menu.
* **Settings → Workspace**: rename (owner), leave, delete (owner).

### Invites

* Email with **no login yet**: the link asks for a name and password, creates the login and the membership.
* Email that **already has a login**: no second user is created. Signed in as that email, the link is one click ("Accept invite"); not signed in, the page asks for that login's password first; signed in as a *different* email, it says so and offers to sign out. A password is never accepted to take over an existing login.
* Inviting someone who is already a member of the workspace is refused (`409`). An invite link works once: of simultaneous accepts, exactly one wins.
* A workspace has at most one open invite per address: a new invite to the same address revokes the earlier open one (audit `auth.invite_revoked`, reason "replaced by a new invite"), and the answer says how many it replaced (`replaced`). A hand-off counts too.

### Roles and removal

* Only the **owner** changes a role: `POST /api/workspaces/:id/members/:userId/role {role: "admin" | "member"}`. Never the owner's own row, never yourself, never to `owner` (that is `transfer-ownership`). Audited as `team.role_changed`.
* Removing a member ends only their membership (`teamQueries.removeMembership`): they keep their login, their sessions and any other workspace. Their API keys and agent approvals for this workspace end at once (`teamQueries.revokeAccessOf`: keys revoked; human access principals disabled with their grants and credentials); nothing of the workspace's data goes with them. If it was their only workspace they land on "No workspace yet" (see below). ADR 0024.

### Leaving and deleting

* Any member or admin may leave, including their **only** workspace (`POST /api/workspaces/:id/leave`): they keep their login and sessions, and their keys and agent approvals for it end, as with removal. The **last owner** cannot leave (`409 last_owner`): make someone else an owner first. So the only owner of a workspace leaves by making someone else an owner first, or by deleting the workspace (the dashboard disables Leave and says so).
* **No workspace yet.** A signed-in person with no membership gets `GET /api/me` with `workspace_id: null` and any pending invitations, and every other call `403 no_workspace`; the dashboard (`NoWorkspacePage`) shows the invitations and, where they may, **Create workspace**, which leads into the first-run setup. Hosted: anyone may create one. Self-host: only the owner of the instance (owner of `ws_default`) may, so everyone else is told to ask that owner to invite them.
* Only an owner can delete a workspace; the default workspace (`ws_default`) cannot be deleted. Deleting your only workspace is allowed: you keep your login and land on "No workspace yet" (ADR 0024).
* A workspace **with domains** is deleted only when the request repeats its name (`?confirm=<name>`). Before anything is deleted, Cloudflare (and the hosted-records zone, for hosted domains) is checked for **every** domain; if any cannot be reached, nothing is deleted (`502 cloudflare_preflight_failed`, naming the domain). Domains are then deleted one at a time through the normal domain delete (DNS records and hosted records first). Each of those is final, so if one fails part-way the answer says how many were already deleted (`502 domain_cleanup_failed`); the workspace and its remaining data are kept and the delete can be retried. Its members keep their accounts (ADR 0024): their memberships, API keys and agent approvals for it go with it, and anyone with no other workspace lands on "No workspace yet".

## Self-host and hosted

**Who can create workspaces**

* Hosted (`MODE=saas`): any signed-in user; every sign-up also gets a workspace of its own, named with the organization name given on sign-up (an agency's first workspace carries the placeholder name "New client", flagged by the `name_is_placeholder` workspace setting, until its first client domain is entered, then it is named after that domain; a workspace you name yourself is never renamed; the agency's name heads the workspace switcher).
* Self-host: **only the instance owner**, the owner of the default workspace (`ws_default`). Anyone else gets `403 instance_owner_required`. (Letting every invited member create a workspace would hand each of them an owner role somewhere, and, below, a way to the server's Cloudflare token.) It is aimed at agencies and consultants who manage several organisations' domains from one install.

**Cloudflare in a self-hosted workspace**

* The server's `CLOUDFLARE_API_TOKEN` can reach every zone of the operator's account, so **only the default workspace uses it**. Every other workspace has no Cloudflare access until it links its own connection (a pasted token or OAuth, with the zone allow-list; see [cloudflare-oauth.md](cloudflare-oauth.md)). Until then anything that needs Cloudflare answers `400` with `code: "cloudflare_not_connected"` ("connect Cloudflare first"), `GET /api/zones` included; with a connection, `/api/zones` lists only the zones its owner allowed. Domains can still be added by hand (without DNS changes).
* Machine credentials belong to named principals with finite product/domain/action grants. A selected workspace header cannot broaden them. Human portfolio consent enumerates allowed resources across current memberships; later invitations do not expand it. Product/credential administration requires a browser owner. See [agent operations](agent-operations.md).

**Reports and jobs**

* Inbound reports are routed to the workspace that owns the **reports domain** the message was sent to. A reports domain (`reports.<base domain>`) and a monitored hostname each belong to **one** workspace: the setup wizard refuses one another workspace holds (`409`), the domain and its settings are written in one batch, and the database enforces uniqueness of the reports domain (`idx_settings_reports_domain`). Mail for an unknown reports domain goes to the default workspace. Give each workspace's reports domain Email Routing to this Worker.
* Cron jobs (digests, SPF flattening, checks) run for every workspace.
* First-run setup requires installer-held single-use proof and creates the owner of the default workspace; further people join by invite, and sign-up stays closed.

## API

All routes need a signed-in **user** (a session, not an API key or the instance key: `403` otherwise). Browser session operations select the workspace using `X-Workspace-Id` (membership required; without it, the oldest membership). Delegated HTTP/MCP operations additionally require their current finite resource/action grants; guessing a workspace or domain ID does not expand authority. The `/api/workspaces` routes ignore that header: they act on you and the id in the path, and answer `404` for a workspace you are not in.

| Route | Who | |
|---|---|---|
| `GET /api/workspaces` | any user | `{workspaces: [{id, name, role, member_count, created_at}]}` |
| `POST /api/workspaces` `{name}` | any user (self-host: the instance owner only, else `403 instance_owner_required`) | create; caller becomes owner. `201 {id, name, role, member_count}` |
| `PATCH /api/workspaces/:id` `{name}` | owner | rename |
| `POST /api/workspaces/:id/leave` | any member | `409 last_owner` |
| `POST /api/workspaces/:id/members/:userId/role` `{role}` | owner | `200 {ok, role, changed}`; `400` yourself, owner as the new role, bad role; `403` not owner, or the owner's row; `404` not a member |
| `DELETE /api/workspaces/:id[?confirm=<name>]` | owner | `409 confirm_required` when it has domains; `502 cloudflare_preflight_failed` / `domain_cleanup_failed`; `400 default_workspace` |
| `GET /api/invites/:token` | token | adds `workspace_id`, `workspace_name`, `user_exists`, `signed_in_as` |
| `POST /api/invites/:token` | token | new email: `{name, password}` → `201` + session. Existing login: `{}` while signed in as that email → `200 {ok, workspace_id}`; `401` not signed in; `403 wrong_user` signed in as someone else |
