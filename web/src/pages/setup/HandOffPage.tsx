import { Alert, Button, FieldError, FieldHint, Input, Label } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { EMAIL_PATTERN } from '../../lib/signup';
import { handoffKeys } from '../../lib/handoff';
import { focusDomainOf } from '../../lib/first-run';
import { useDomainClaims, useDomains } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { cleanName } from '../../lib/names';
import { useWorkspaces } from '../../lib/workspaces';

/**
 * H1, "Hand setup to a teammate": name the teammate; they get a fixed invitation, join this workspace as an admin and land on this
 * domain's first screen. It is the ordinary admin invite (only an owner can make one) with the domain it is about. Hosted only.
 */
export function HandOffPage() {
	const { me, role, status } = useSession();
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const domains = useDomains();
	const claims = useDomainClaims();
	const workspaces = useWorkspaces();
	const [email, setEmail] = useState('');
	const [invalid, setInvalid] = useState('');
	const [sentTo, setSentTo] = useState<string | null>(null);
	/** The invitation link, when we did not email it (the answer is `emailed: false`): the owner sends it themselves. */
	const [link, setLink] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	const asked = params.get('domain');
	const names = [...(domains.data ?? []).map((d) => d.domain), ...(claims.data ?? []).filter((c) => c.status === 'pending').map((c) => c.domain)];
	const domain = (asked && names.includes(asked) ? asked : null) ?? focusDomainOf(domains.data ?? [], me?.workspace_id ?? null)?.domain ?? names[0] ?? null;
	const workspace = cleanName(workspaces.data?.find((w) => w.id === me?.workspace_id)?.name) || 'this workspace';

	const send = useMutation({
		mutationFn: () => api<{ url?: string; emailed?: boolean }>('/api/team/invite', { method: 'POST', body: { email: email.trim(), role: 'admin', handoff_domain: domain } }),
		onSuccess: (r) => {
			setSentTo(email.trim());
			setLink(r.emailed === false && r.url ? r.url : null);
			void qc.invalidateQueries({ queryKey: handoffKeys.list });
		},
	});

	if (status && status.mode !== 'saas') return <Navigate to="/" replace />;
	if (role && role !== 'owner') return <Navigate to="/" replace />;
	if (domains.isPending || claims.isPending) return null;
	if (!domain) return <Navigate to="/setup" replace />;

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!EMAIL_PATTERN.test(email.trim())) return setInvalid('Enter an email address like name@company.com');
		setInvalid('');
		send.mutate();
	}
	const error = invalid || (send.isError ? errorMessage(send.error) : '');
	const already = send.error instanceof ApiError && send.error.status === 409 ? `${email.trim()} is already a member of this workspace.` : '';

	if (sentTo && link) {
		const copy = async () => {
			try {
				await navigator.clipboard.writeText(link);
				setCopied(true);
			} catch {
				setCopied(false); // the field is selectable: copy by hand
			}
		};
		return (
			<div className="mx-auto max-w-xl space-y-5" data-testid="handoff-link">
				<h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">Send {sentTo} this link</h1>
				<p className="max-w-prose text-sm text-ink-1">
					Send it to them yourself. It works once, for 7 days, and lets them join <span className="font-medium">{workspace}</span> as an admin to finish{' '}
					<span className="font-mono [overflow-wrap:anywhere]">{domain}</span>.
				</p>
				<Input readOnly aria-label="Invitation link" value={link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
				<Button className="w-full sm:w-auto" onClick={copy}>
					{copied ? 'Copied' : 'Copy link'}
				</Button>
				<p className="text-sm">
					<Link to="/" replace className="text-ink-2 underline underline-offset-4 hover:text-ink-1">
						Go to the dashboard
					</Link>
				</p>
			</div>
		);
	}

	if (sentTo) {
		return (
			<div className="mx-auto max-w-xl space-y-5" data-testid="handoff-sent">
				<h1 className="text-2xl font-semibold tracking-tight">Invitation sent</h1>
				<p className="max-w-prose text-sm text-ink-1">
					We emailed <span className="font-medium [overflow-wrap:anywhere]">{sentTo}</span>. The link works for 7 days. The dashboard shows where it stands, and you can send it again from there.
				</p>
				<Button className="w-full sm:w-auto" onClick={() => navigate('/', { replace: true })}>
					Go to the dashboard
				</Button>
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-xl space-y-5" data-testid="handoff">
			<h1 className="text-2xl font-semibold tracking-tight">Hand setup to a teammate</h1>
			<p className="max-w-prose text-sm text-ink-1">
				They join <span className="font-medium">{workspace}</span> as an admin and pick up where you are: <span className="font-mono [overflow-wrap:anywhere]">{domain}</span>. You keep full access as the owner.
			</p>
			<form onSubmit={submit} className="space-y-4" noValidate>
				<div className="space-y-1.5">
					<Label htmlFor="handoff-email">Their work email</Label>
					<Input
						id="handoff-email"
						type="email"
						autoFocus
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						placeholder="name@company.com"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? 'handoff-email-error' : undefined}
					/>
					{error ? <FieldError id="handoff-email-error">{already || error}</FieldError> : null}
				</div>
				{send.isError && (send.error instanceof ApiError ? send.error.status >= 500 : true) ? <Alert variant="warning">{errorMessage(send.error)}</Alert> : null}
				<Button type="submit" className="w-full sm:w-auto" loading={send.isPending}>
					Send invitation
				</Button>
			</form>
			<FieldHint className="max-w-prose">
				We email them a fixed invitation when they're at your company's domain; otherwise you get a link to send. The link works for 7 days. An admin can add domains, connect Cloudflare and apply changes; only you, the owner, can add other admins, manage API keys and agents, or hand over ownership.
			</FieldHint>
			<p className="text-sm">
				<Link to="/" className="text-ink-2 underline underline-offset-4 hover:text-ink-1">
					Back
				</Link>
			</p>
		</div>
	);
}
