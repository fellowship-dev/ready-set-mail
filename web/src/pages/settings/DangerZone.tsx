import { Button, Card, CardContent, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FieldError, Input, toast } from '@ready-set-mail/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Section } from '../../components/states';
import { api, ApiError, errorMessage } from '../../lib/api';
import { downloadFile } from '../../lib/download';
import { useHosted, useSession } from '../../lib/session';
import { Field } from '../auth/AuthLayout';
import { canCreateWorkspace, useWorkspaces } from '../../lib/workspaces';
import { DeleteButton, LeaveButton, leaveNote, useCurrentWorkspace } from './WorkspaceSection';

interface Blocking {
	id: string;
	name: string;
	members: number;
}

/** One danger-zone action: what it does on the left, its button (which asks for confirmation) on the right. */
function DangerRow({ title, children, action }: { title: string; children: ReactNode; action: ReactNode }) {
	return (
		<Card>
			<CardContent className="flex flex-wrap items-center justify-between gap-4">
				<div className="min-w-0 max-w-xl space-y-1">
					<h3 className="font-semibold">{title}</h3>
					<p className="text-sm text-ink-2">{children}</p>
				</div>
				{action}
			</CardContent>
		</Card>
	);
}

/** Export the workspace's data (owners); leave or delete the open workspace; delete your own account (everyone signed in as a user). */
export function DangerZone() {
	const { me, role, status } = useSession();
	const hosted = useHosted();
	const { current, others, goElsewhere } = useCurrentWorkspace();
	const all = useWorkspaces(!!me?.user).data ?? [];
	if (!me?.user) return null;
	const canDelete = others.length > 0;
	const canCreate = canCreateWorkspace(status?.mode, all);
	return (
		<Section title="Danger zone" description="Take your data with you, leave or delete this workspace, or delete your account.">
			{role === 'owner' && me.workspace_id ? <ExportCard workspaceId={me.workspace_id} /> : null}
			{current ? (
				<DangerRow title="Leave this workspace" action={<LeaveButton id={current.id} name={current.name} only={!canDelete} canCreate={canCreate} then={goElsewhere} />}>
					{leaveNote(!canDelete, canCreate)}
				</DangerRow>
			) : null}
			{current && canDelete && role === 'owner' ? (
				<DangerRow title="Delete this workspace" action={<DeleteButton id={current.id} name={current.name} then={goElsewhere} />}>
					Removes its domains, reports, members&apos; access and Cloudflare connections for everyone. This cannot be undone.
				</DangerRow>
			) : null}
			<DangerRow title="Delete my account" action={<DeleteAccount email={me.user.email} />}>
				Removes your login, sessions, {hosted ? 'agent connections' : 'API keys'} and memberships, and any workspace only you belong to (with its domains, reports and Cloudflare access). If you are the only owner of a workspace that has
				other members, transfer ownership first.
			</DangerRow>
		</Section>
	);
}

function ExportCard({ workspaceId }: { workspaceId: string }) {
	const download = useMutation({
		mutationFn: () => downloadFile(`/api/workspaces/${encodeURIComponent(workspaceId)}/export`, `ready-set-mail-${workspaceId}-export.json`),
		onError: (e) => toast({ variant: 'danger', title: 'Could not export', description: errorMessage(e) }),
	});
	return (
		<DangerRow
			title="Export this workspace's data"
			action={
				<Button variant="secondary" loading={download.isPending} onClick={() => download.mutate()}>
					<Download aria-hidden />
					Download JSON
				</Button>
			}
		>
			Everything it holds, as one JSON file: members, domains, reports, settings and the audit log. Secrets and raw report payloads are left out.
		</DangerRow>
	);
}

interface Preview {
	deleted_workspaces: string[];
	connections_left_behind: Array<{ workspace: string; label: string; cf_account_name: string | null }>;
}

function DeleteAccount({ email }: { email: string }) {
	const [open, setOpen] = useState(false);
	const preview = useQuery({ queryKey: ['account-deletion-preview'], queryFn: () => api<Preview>('/api/account'), enabled: open, retry: false });
	const [typed, setTyped] = useState('');
	const del = useMutation({
		mutationFn: () => api('/api/account', { method: 'DELETE', body: { confirm: typed } }),
		onSuccess: () => {
			toast({ variant: 'success', title: 'Your account was deleted' });
			window.location.hash = '#/';
			window.location.reload();
		},
	});
	const blocking = del.error instanceof ApiError ? ((del.error.body as { code?: string; workspaces?: Blocking[] } | undefined)?.workspaces ?? null) : null;
	const matches = typed.trim().toLowerCase() === email.toLowerCase();
	return (
		<>
			<Button variant="danger" onClick={() => setOpen(true)}>
				Delete my account
			</Button>
			<Dialog
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (!o) {
						setTyped('');
						del.reset();
					}
				}}
			>
				<DialogContent>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							del.mutate();
						}}
						className="space-y-4"
					>
						<DialogHeader>
							<DialogTitle>Delete your account?</DialogTitle>
							<DialogDescription>This cannot be undone. Workspaces only you belong to are deleted with their data, and their Cloudflare access is revoked.</DialogDescription>
						</DialogHeader>
						{preview.data?.deleted_workspaces.length ? (
							<p className="text-sm">
								Deleted with you: {preview.data.deleted_workspaces.map((n) => `"${n}"`).join(', ')} (every domain, report and Cloudflare connection in {preview.data.deleted_workspaces.length === 1 ? 'it' : 'them'}).
							</p>
						) : null}
						{preview.data?.connections_left_behind.length ? (
							<div className="space-y-1 text-sm" data-testid="connections-left-behind">
								<p>These Cloudflare connections were made by you and stay active in workspaces that continue, so those workspaces keep access to the Cloudflare account:</p>
								<ul className="list-disc pl-5">
									{preview.data.connections_left_behind.map((c, i) => (
										<li key={i}>
											{c.label}
											{c.cf_account_name ? ` (${c.cf_account_name})` : ''} in {c.workspace}
										</li>
									))}
								</ul>
								<p className="text-ink-2">Disconnect them first if they should not outlive your account.</p>
							</div>
						) : null}
						<Field id="confirm-account-delete" label={`Type your email, ${email}, to confirm`}>
							<Input id="confirm-account-delete" type="email" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
						</Field>
						{blocking ? (
							<div role="alert" className="space-y-1 text-sm text-danger">
								<p>You are the only owner of {blocking.map((b) => `"${b.name}"`).join(', ')}, which still ha{blocking.length === 1 ? 's' : 've'} other members.</p>
								<p>Transfer ownership on the Members page (or delete the workspace), then try again.</p>
							</div>
						) : del.isError ? (
							<FieldError>{errorMessage(del.error)}</FieldError>
						) : null}
						<DialogFooter>
							<Button type="button" variant="secondary" onClick={() => setOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" variant="danger" loading={del.isPending} disabled={!matches}>
								Delete my account
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
