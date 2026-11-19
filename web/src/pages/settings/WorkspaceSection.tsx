import { Badge, Button, Card, CardContent, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FieldError, Input } from '@ready-set-mail/ui';
import { useState, type FormEvent } from 'react';
import { Section } from '../../components/states';
import { ApiError, errorMessage } from '../../lib/api';
import { useDomains } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { canCreateWorkspace, switchToWorkspace, useDeleteWorkspace, useLeaveWorkspace, useRenameWorkspace, useWorkspaces } from '../../lib/workspaces';
import { Field } from '../auth/AuthLayout';

/** The open workspace, whether it can be left or deleted (only when there is another one to land in), and where to go after. */
export function useCurrentWorkspace() {
	const { me } = useSession();
	const workspaces = useWorkspaces(!!me?.user);
	const current = workspaces.data?.find((w) => w.id === me?.workspace_id);
	const others = (workspaces.data ?? []).filter((w) => w.id !== current?.id);
	const goElsewhere = () => (others[0] ? switchToWorkspace(others[0].id) : (window.location.hash = '#/'));
	return { current, others, goElsewhere };
}

/** What follows leaving your only workspace: you keep your account and land on "No workspace yet", whose next step depends on who may create workspaces. */
const afterLeavingOnly = (canCreate: boolean): string =>
	`You keep your account and land on a page ${canCreate ? 'where you can start a workspace of your own' : 'where you wait for an invitation, because only the owner of this instance can create workspaces'}.`;

/** The Settings sentence for your only workspace: leaving or deleting it both keep your account (an owner hands ownership on before leaving). */
export const onlyWorkspaceNote = (canCreate: boolean, owner: boolean): string =>
	owner
		? `This is your only workspace. Delete it, or make another member an owner and leave it: either way ${afterLeavingOnly(canCreate).replace(/^You/, 'you')}`
		: `This is your only workspace. If you leave it: ${afterLeavingOnly(canCreate).replace(/^You/, 'you')}`;

/** Why the only owner cannot leave, and what to do instead. */
export const lastOwnerNote = (alone: boolean): string =>
	alone ? 'You are the only owner and the only member. Delete the workspace instead, or invite someone and make them an owner first.' : 'You are the only owner. Make another member an owner first (Members), or delete the workspace.';

/** The leave dialog: what is lost, and, when it is the only workspace, where you end up. */
export const leaveNote = (only: boolean, canCreate: boolean): string =>
	`You lose access to its domains and reports. An owner can invite you back.${only ? ` ${afterLeavingOnly(canCreate)}` : ''}`;

/** Name and rename (owners) for the workspace that is open. Leaving and deleting it are in the danger zone. */
export function WorkspaceSection() {
	const { me, role, status } = useSession();
	const { current, others } = useCurrentWorkspace();
	const all = useWorkspaces(!!me?.user).data ?? [];
	if (!me?.user || !current) return null;
	const isOwner = role === 'owner';

	return (
		<Section title="Workspace" description="Its domains, reports, members and Cloudflare connections belong to it, not to you.">
			<Card>
				<CardContent className="space-y-4">
					{isOwner ? <RenameForm id={current.id} name={current.name} /> : <p className="text-sm">{current.name}</p>}
					<p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
						Your role here: {role ? <Badge variant="brand">{role}</Badge> : null} · {current.member_count} {current.member_count === 1 ? 'member' : 'members'}
					</p>
					{others.length === 0 ? <p className="text-sm text-ink-2">{onlyWorkspaceNote(canCreateWorkspace(status?.mode, all), isOwner)}</p> : null}
				</CardContent>
			</Card>
		</Section>
	);
}

function RenameForm({ id, name }: { id: string; name: string }) {
	const [value, setValue] = useState(name);
	const rename = useRenameWorkspace(id);
	function submit(e: FormEvent) {
		e.preventDefault();
		if (value.trim() && value.trim() !== name) rename.mutate(value.trim());
	}
	return (
		<form onSubmit={submit} className="grid max-w-xl gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
			<Field id="workspace-rename" label="Workspace name">
				<Input id="workspace-rename" maxLength={80} value={value} onChange={(e) => setValue(e.target.value)} />
			</Field>
			<div>
				<Button type="submit" variant="secondary" loading={rename.isPending} disabled={!value.trim() || value.trim() === name}>
					Rename
				</Button>
			</div>
			{rename.isError ? <FieldError className="sm:col-span-2">{errorMessage(rename.error)}</FieldError> : null}
		</form>
	);
}

export function LeaveButton({ id, name, only, canCreate, blocked, then }: { id: string; name: string; only: boolean; canCreate: boolean; /** Why leaving is refused (the only owner), shown beside the disabled button. */ blocked?: string; then: () => void }) {
	const [open, setOpen] = useState(false);
	const leave = useLeaveWorkspace(id, then);
	return (
		<>
			<Button variant="danger" disabled={!!blocked} aria-describedby={blocked ? `leave-blocked-${id}` : undefined} onClick={() => setOpen(true)}>
				Leave workspace
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Leave {name}?</DialogTitle>
						<DialogDescription>{leaveNote(only, canCreate)}</DialogDescription>
					</DialogHeader>
					{leave.isError ? <FieldError>{errorMessage(leave.error)}</FieldError> : null}
					<DialogFooter>
						<Button variant="secondary" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button variant="danger" loading={leave.isPending} onClick={() => leave.mutate()}>
							Leave workspace
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

export function DeleteButton({ id, name, only, canCreate, then }: { id: string; name: string; only: boolean; canCreate: boolean; then: () => void }) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState('');
	const domains = useDomains();
	const del = useDeleteWorkspace(id, then);
	const count = domains.data?.length ?? 0;
	const needsConfirm = count > 0 || (del.error instanceof ApiError && del.error.status === 409);
	return (
		<>
			<Button variant="danger" onClick={() => setOpen(true)}>
				Delete workspace
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							del.mutate(needsConfirm ? typed : undefined);
						}}
						className="space-y-4"
					>
						<DialogHeader>
							<DialogTitle>Delete {name}?</DialogTitle>
							<DialogDescription>
								{count > 0
									? `This removes its ${count} ${count === 1 ? 'domain' : 'domains'} (and the DNS records Ready Set Mail added for them), every report, its members' access and its Cloudflare connections. This cannot be undone.`
									: 'It has no domains. Its members lose access. This cannot be undone.'}{' '}
								Everyone in it keeps their account: whoever has no other workspace lands on a page where they can{canCreate ? ' start one of their own' : ' wait for an invitation'}.
								{only ? ` ${afterLeavingOnly(canCreate)}` : ''}
							</DialogDescription>
						</DialogHeader>
						{needsConfirm ? (
							<Field id="confirm-delete" label={`Type "${name}" to confirm`}>
								<Input id="confirm-delete" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
							</Field>
						) : null}
						{del.isError ? <FieldError>{errorMessage(del.error)}</FieldError> : null}
						<DialogFooter>
							<Button type="button" variant="secondary" onClick={() => setOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" variant="danger" loading={del.isPending} disabled={needsConfirm && typed !== name}>
								Delete workspace
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
