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

/** Your only workspace cannot be left or deleted: the one sentence says what to do instead, for whoever can start another workspace and whoever cannot. */
export const onlyWorkspaceNote = (canCreate: boolean): string =>
	canCreate
		? 'This is your only workspace, so it cannot be left or deleted: start another one from the workspace menu first, or delete your account below to leave altogether.'
		: 'This is your only workspace, so it cannot be left or deleted: ask the owner of this instance to add you to another one first, or delete your account below to leave altogether.';

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
					{others.length === 0 ? <p className="text-sm text-ink-2">{onlyWorkspaceNote(canCreateWorkspace(status?.mode, all))}</p> : null}
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

export function LeaveButton({ id, name, then }: { id: string; name: string; then: () => void }) {
	const [open, setOpen] = useState(false);
	const leave = useLeaveWorkspace(id, then);
	return (
		<>
			<Button variant="danger" onClick={() => setOpen(true)}>
				Leave workspace
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Leave {name}?</DialogTitle>
						<DialogDescription>You lose access to its domains and reports. An owner can invite you back.</DialogDescription>
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

export function DeleteButton({ id, name, then }: { id: string; name: string; then: () => void }) {
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
									: 'It has no domains. Its members lose access. This cannot be undone.'}
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
