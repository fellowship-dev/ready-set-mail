import { cleanName } from '../../lib/names';
import {
	Badge,
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	EmptyState,
	FieldError,
	Input,
	PageHeader,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from '@ready-set-mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ListSkeleton, LoadError, ReadOnlyNotice, Section, WriteButton } from '../../components/states';
import { api, ApiError, errorMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useHosted, useSession } from '../../lib/session';
import { useWorkspaces } from '../../lib/workspaces';
import type { Role } from '../../lib/types';
import { Field } from '../auth/AuthLayout';

interface TeamMember {
	id: string;
	email: string;
	name: string;
	role: Role;
	last_login_at: number | null;
	created_at: number;
}
interface TeamResponse {
	users: TeamMember[];
	current_user_id: string | null;
}

const teamKey = ['team'] as const;
const invitesKey = ['team-invites'] as const;

interface PendingInvite {
	id: string;
	email: string;
	role: Role;
	invited_by: string | null;
	created_at: number;
	expires_at: number;
}

export function inviteLink(token: string): string {
	return `${window.location.origin}/#/invite/${token}`;
}

export function MembersPage() {
	const { role: myRole, canWrite, me } = useSession();
	const workspace = useWorkspaces(!!me?.user).data?.find((w) => w.id === me?.workspace_id);
	const team = useQuery({
		queryKey: teamKey,
		queryFn: () => api<TeamResponse>('/api/team'),
		// Members get 403 by design: that is an explanation, not a failure to retry.
		retry: false,
		enabled: canWrite,
	});

	return (
		<div className="space-y-8">
			<PageHeader
				title="Members"
				description={`${workspace ? `${workspace.name}: everyone` : 'Everyone'} here can see all of its domains and reports. Owners and admins can change things; members are read-only.`}
			/>
			<ReadOnlyNotice />
			{!canWrite ? (
				<EmptyState title="Only owners and admins can see the members" description="Ask an owner if you need to know who has access, or want someone invited." />
			) : team.isPending ? (
				<ListSkeleton rows={3} label="Loading members" />
			) : team.isError ? (
				<LoadError error={team.error} onRetry={() => team.refetch()} title="Could not load the members" />
			) : (
				<>
					{/* The invite form comes first: it is what most visits are for, and it stays in reach however many people are listed. */}
					<InviteSection isOwner={myRole === 'owner'} />
					<Section title="Members">
						<ul className="divide-y divide-line rounded-lg border border-line bg-surface-1" aria-label="Members">
							{team.data.users.map((m) => (
								<MemberRow key={m.id} member={m} isSelf={m.id === team.data.current_user_id} myRole={myRole} />
							))}
						</ul>
					</Section>
					<PendingInvites />
				</>
			)}
		</div>
	);
}

function MemberRow({ member, isSelf, myRole }: { member: TeamMember; isSelf: boolean; myRole: Role | null }) {
	const qc = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const remove = useMutation({
		mutationFn: () => api(`/api/team/${member.id}`, { method: 'DELETE' }),
		onSuccess: async () => {
			setConfirming(false);
			toast({ variant: 'success', title: `${member.email} removed` });
			await qc.invalidateQueries({ queryKey: teamKey });
		},
	});

	const workspaceId = useSession().me?.workspace_id;
	const hosted = useHosted();
	const [handing, setHanding] = useState(false);
	const transfer = useMutation({
		mutationFn: () => api(`/api/workspaces/${workspaceId}/transfer-ownership`, { method: 'POST', body: { user_id: member.id } }),
		onSuccess: async () => {
			setHanding(false);
			toast({ variant: 'success', title: `${member.email} is now the owner`, description: 'You are an admin of this workspace now.' });
			await Promise.all([qc.invalidateQueries({ queryKey: teamKey }), qc.invalidateQueries({ queryKey: ['me'] }), qc.invalidateQueries({ queryKey: ['workspaces'] })]);
		},
	});

	// The owner changes everyone else's role, except the owner row and their own (hand ownership on instead).
	const changeRole = useMutation({
		mutationFn: (role: 'admin' | 'member') => api(`/api/workspaces/${workspaceId}/members/${member.id}/role`, { method: 'POST', body: { role } }),
		onSuccess: async (_r, role) => {
			toast({ variant: 'success', title: role === 'admin' ? `${member.email} is now an admin` : `${member.email} is now a member`, description: role === 'admin' ? 'They can change things in this workspace.' : 'They are read-only now.' });
			await qc.invalidateQueries({ queryKey: teamKey });
		},
		onError: (e) => toast({ variant: 'danger', title: 'Could not change the role', description: errorMessage(e) }),
	});
	const roleEditable = myRole === 'owner' && !isSelf && member.role !== 'owner';

	// The API refuses these; say so up front instead of offering a button that fails.
	let blocked: string | null = null;
	if (isSelf) blocked = 'You cannot remove yourself.';
	else if (member.role === 'owner') blocked = 'The owner cannot be removed.';
	else if (member.role === 'admin' && myRole !== 'owner') blocked = 'Only the owner can remove an admin.';

	// Two lines at 375 (name and role, then last sign-in and the actions), one from sm: a row that is not tall keeps the people, and the invite form, in reach.
	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 sm:p-4">
			<span aria-hidden className="hidden size-9 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-sm font-semibold text-brand-ink sm:flex">
				{(cleanName(member.name) || member.email).charAt(0).toUpperCase()}
			</span>
			<div className="min-w-0 flex-1 basis-40">
				<p className="truncate font-medium">
					{cleanName(member.name) || member.email}
					{isSelf ? <span className="ml-2 text-sm font-normal text-ink-2">(you)</span> : null}
				</p>
				<p className="truncate text-sm text-ink-2">{member.email}</p>
			</div>
			{roleEditable ? (
				<Select value={member.role} onValueChange={(v) => changeRole.mutate(v as 'admin' | 'member')} disabled={changeRole.isPending}>
					<SelectTrigger aria-label={`Role of ${member.email}`} className="h-8 w-32 shrink-0">
						<SelectValue>{member.role === 'admin' ? 'Admin' : 'Member'}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="member">Member (read-only)</SelectItem>
						<SelectItem value="admin">Admin</SelectItem>
					</SelectContent>
				</Select>
			) : (
				<Badge variant={member.role === 'member' ? 'neutral' : 'brand'}>{member.role}</Badge>
			)}
			<p className="min-w-0 flex-1 basis-32 text-xs text-ink-2 sm:flex-none sm:text-sm">{member.last_login_at ? `Signed in ${formatDate(member.last_login_at)}` : 'Never signed in'}</p>
			<div className="ml-auto flex items-center gap-2">
				{myRole === 'owner' && !isSelf && member.role !== 'owner' ? (
					<Button variant="secondary" size="sm" onClick={() => setHanding(true)} aria-label={`Make ${member.email} the owner`}>
						Make owner
					</Button>
				) : null}
				<WriteButton variant="secondary" size="sm" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setConfirming(true)} aria-label={`Remove ${member.email}`}>
					Remove
				</WriteButton>
			</div>
			<Dialog open={handing} onOpenChange={setHanding}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Make {member.email} the owner?</DialogTitle>
						<DialogDescription>They become the workspace's owner, and you become an admin. Only an owner can delete the workspace, export its data or hand ownership on.</DialogDescription>
					</DialogHeader>
					{transfer.isError ? <FieldError>{errorMessage(transfer.error)}</FieldError> : null}
					<DialogFooter>
						<Button variant="secondary" onClick={() => setHanding(false)}>
							Cancel
						</Button>
						<Button loading={transfer.isPending} onClick={() => transfer.mutate()}>
							Transfer ownership
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog open={confirming} onOpenChange={setConfirming}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Remove {member.email}?</DialogTitle>
						<DialogDescription>
							{removalEndsNote(hosted)}
						</DialogDescription>
					</DialogHeader>
					{remove.isError ? <FieldError>{errorMessage(remove.error)}</FieldError> : null}
					<DialogFooter>
						<Button variant="secondary" onClick={() => setConfirming(false)}>
							Cancel
						</Button>
						<Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
							Remove member
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</li>
	);
}

/** What removing someone ends, per mode: hosted has agents they connected and no key screen; self-host has API keys. */
export const removalEndsNote = (hosted: boolean): string =>
	hosted
		? 'They lose access to this workspace immediately, and any agents they connected to it stop working. They keep their account. You can invite them again later.'
		: 'They lose access to this workspace immediately, and their API keys for it stop working. They keep their account. You can invite them again later.';

/** What this form does about email, true on both modes: it sends nothing. (Handing a domain's setup to a teammate, hosted, is another invite with its own screen, and is emailed.) */
export const INVITE_NOT_EMAILED = 'This invite is not emailed: you get a one-time link to pass on. It expires in 7 days.';

function InviteSection({ isOwner }: { isOwner: boolean }) {
	const [email, setEmail] = useState('');
	const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
	const role = isOwner ? inviteRole : 'member';
	const [link, setLink] = useState<string | null>(null);
	/** The address a new link was made for, when it replaced an earlier open one. */
	const [replacedFor, setReplacedFor] = useState<string | null>(null);
	const qc = useQueryClient();
	const invite = useMutation({
		mutationFn: () => api<{ token: string; replaced?: number }>('/api/team/invite', { method: 'POST', body: { email: email.trim(), role } }),
		onSuccess: ({ token, replaced }) => {
			setLink(inviteLink(token));
			setReplacedFor(replaced ? email.trim() : null);
			void qc.invalidateQueries({ queryKey: invitesKey });
			setEmail('');
		},
	});

	function submit(e: FormEvent) {
		e.preventDefault();
		setLink(null);
		setReplacedFor(null);
		invite.mutate();
	}

	return (
		<Section title="Invite a member" description={INVITE_NOT_EMAILED}>
			<form onSubmit={submit} className="grid gap-4 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
				<Field id="invite-email" label="Email">
					<Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@yourcompany.com" />
				</Field>
				<Field id="invite-role" label="Role">
					<Select value={role} onValueChange={(v) => setInviteRole(v as 'member' | 'admin')}>
						<SelectTrigger id="invite-role" aria-label="Role">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="member">Member (read-only)</SelectItem>
							{isOwner ? <SelectItem value="admin">Admin</SelectItem> : null}
						</SelectContent>
					</Select>
				</Field>
				<WriteButton type="submit" loading={invite.isPending}>
					Create invite link
				</WriteButton>
			</form>
			{invite.isError ? <FieldError>{invite.error instanceof ApiError && invite.error.status === 409 ? 'This person is already a member of this workspace.' : errorMessage(invite.error)}</FieldError> : null}
			{link ? (
				<div className="space-y-2 rounded-lg border border-line bg-surface-2 p-4" role="status">
					<p className="text-sm font-medium">Send this link to the person you are inviting. It works once.</p>
					{replacedFor ? <p className="text-sm text-ink-2">{replacedFor} already had an open invite: its earlier link no longer works.</p> : null}
					<div className="flex items-center gap-2">
						<code className="min-w-0 flex-1 break-all rounded-md border border-line bg-surface-1 px-3 py-2 font-mono text-sm" data-testid="invite-link">
							{link}
						</code>
						<Button
							variant="secondary"
							size="sm"
							onClick={async () => {
								await navigator.clipboard?.writeText(link).catch(() => {});
								toast({ variant: 'success', title: 'Invite link copied' });
							}}
						>
							<Copy aria-hidden />
							Copy
						</Button>
					</div>
				</div>
			) : null}
		</Section>
	);
}

function PendingInvites() {
	const qc = useQueryClient();
	const q = useQuery({ queryKey: invitesKey, queryFn: () => api<{ invites: PendingInvite[] }>('/api/team/invites').then((r) => r.invites), retry: false });
	const revoke = useMutation({
		mutationFn: (inv: PendingInvite) => api(`/api/team/invites/${inv.id}`, { method: 'DELETE' }),
		onSuccess: async (_r, inv) => {
			toast({ variant: 'success', title: `Invite for ${inv.email} revoked` });
			await qc.invalidateQueries({ queryKey: invitesKey });
		},
		onError: (e) => toast({ variant: 'danger', title: 'Could not revoke the invite', description: errorMessage(e) }),
	});
	if (!q.data || q.data.length === 0) return null;
	return (
		<Section title="Pending invites" description="Invite links that have not been used yet. Revoking one stops its link from working.">
			<ul className="divide-y divide-line rounded-lg border border-line bg-surface-1" aria-label="Pending invites">
				{q.data.map((inv) => (
					<li key={inv.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
						<div className="min-w-0 flex-1 basis-56">
							<p className="truncate font-medium">{inv.email}</p>
							<p className="text-sm text-ink-2">
								{inv.invited_by ? `Invited by ${inv.invited_by}. ` : ''}Expires {formatDate(inv.expires_at)}
							</p>
						</div>
						<Badge variant={inv.role === 'member' ? 'neutral' : 'brand'}>{inv.role}</Badge>
						<WriteButton variant="secondary" size="sm" aria-label={`Revoke invite for ${inv.email}`} loading={revoke.isPending && revoke.variables?.id === inv.id} onClick={() => revoke.mutate(inv)}>
							Revoke
						</WriteButton>
					</li>
				))}
			</ul>
		</Section>
	);
}
