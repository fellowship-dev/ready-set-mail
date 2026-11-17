import { Alert, Button, Skeleton, toast } from '@ready-set-mail/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { Change } from '../../components/domain/RecordChange';
import { LoadError } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { clearProgress, fetchZones, useCfConnections } from '../../lib/cloudflare';
import { applyStep, fetchPlan, firstCheck, markWizardState, pendingWrites, type DnsPlan, type PlanWrite } from '../../lib/dns-plan';
import { HAND_OFF_ENABLED, focusDomainOf, isAgency, markReviewDone, zonesNotAdded } from '../../lib/first-run';
import { invalidateDomain } from '../../lib/domain-queries';
import { useDomainClaims, useDomains, useFirstRunDomain } from '../../lib/queries';
import { handoffPath } from '../../lib/handoff';
import { useSession } from '../../lib/session';
import type { Domain } from '../../lib/types';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The sentence under the records. Said once, the same everywhere SPF and DKIM come up. */
export const NOT_CHANGED = 'Not changed: SPF and DKIM, until reports show who sends.';

/**
 * C2, review and Apply: after Cloudflare returns (or "Continue with <account>"), what is there now, what will be written, one
 * Apply, then the dashboard. The plan is the server's (the same one the Cloudflare wizard writes from), so the hosted report
 * address, and the refusal when HOSTED_CONNECT_REPORTS keeps this workspace from connecting reports, are exactly main's.
 * Nothing is written until Apply. A visit with nothing to change says so and leaves.
 */
export function ReviewPage() {
	const { me, canWrite, role } = useSession();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const workspace = me?.workspace_id ?? null;
	const domains = useDomains();
	const claims = useDomainClaims();
	const setUp = useFirstRunDomain();
	const conns = useCfConnections(canWrite);
	const list = domains.data ?? [];
	const domain: Domain | undefined = focusDomainOf(list, workspace, setUp.data);

	const plan = useQuery({ queryKey: ['review-plan', domain?.id], queryFn: () => fetchPlan([domain!.id]), enabled: !!domain && canWrite, retry: false, staleTime: 0, refetchOnWindowFocus: false });
	const [replaced, setReplaced] = useState<DnsPlan | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [changed, setChanged] = useState(false);
	const current = replaced ?? plan.data;
	const connection = (conns.data?.connections ?? []).find((c) => c.cf_account_id && c.cf_account_id === domain?.cf_account_id) ?? (conns.data?.connections ?? []).find((c) => c.status === 'active');
	// "My clients'": only this client's zone was added; the rest of the account is listed, not imported (ImportStep).
	const agency = isAgency(me?.whose_email);
	const accountZones = useQuery({ queryKey: ['cf-zones-not-added', connection?.id], queryFn: () => fetchZones(connection!), enabled: agency && !!connection && !connection.implicit && canWrite, retry: false, staleTime: 60_000 });

	const leave = (how: 'applied' | 'skipped' = 'skipped') => {
		markReviewDone(workspace, how);
		navigate('/', { replace: true });
	};

	if (domains.isPending || claims.isPending) return <Skeleton className="mx-auto h-48 max-w-xl" role="status" aria-label="Loading" />;
	if (domains.isError) return <LoadError error={domains.error} onRetry={() => void domains.refetch()} title="Could not load your domains" />;
	if (!canWrite) return <Navigate to="/" replace />;

	// Cloudflare returned but this domain is not in it: said plainly, with the way on.
	if (!domain) {
		const waiting = (claims.data ?? []).find((c) => c.status === 'pending');
		return (
			<div className="mx-auto max-w-xl space-y-5" data-testid="review-missing">
				<h1 className="text-2xl font-semibold tracking-tight">Nothing to review yet</h1>
				<p className="max-w-prose text-sm text-ink-1">
					{waiting ? `${waiting.domain} isn't in the Cloudflare account you connected. Connect the account that has it, or add the records yourself.` : 'No domain is added yet.'}
				</p>
				<div className="flex flex-col gap-2 sm:flex-row">
					<Button asChild className="w-full sm:w-auto">
						<Link to="/setup" onClick={() => clearProgress(workspace)}>
							{waiting ? 'Back to your domain' : 'Add a domain'}
						</Link>
					</Button>
				</div>
			</div>
		);
	}

	const writes = (current?.steps.find((s) => s.key === 'dmarc')?.writes ?? []);
	const pending = pendingWrites(writes);
	const n = pending.length;
	const notes = (current?.not_written ?? []).filter((x) => x.step === 'dmarc');
	// The report-address refusal is its own sentence (the server's own words); the rest are per-domain notes.
	const reportsNote = notes.find((x) => x.what === 'Report address');
	const others = notes.filter((x) => x !== reportsNote);
	const accountName = connection?.cf_account_name ?? conns.data?.accounts?.find((a) => a.id === domain.cf_account_id)?.name ?? null;
	const notAdded = agency ? zonesNotAdded(accountZones.data ?? [], list.map((d) => d.domain)) : [];
	const more = agency ? 0 : list.filter((d) => d.id !== domain.id && (!domain.cf_account_id || d.cf_account_id === domain.cf_account_id)).length;

	async function apply() {
		if (!current || !domain) return;
		setBusy(true);
		setError('');
		setChanged(false);
		try {
			const r = await applyStep([domain.id], 'dmarc', current.plan_id);
			if (r.kind === 'plan_changed') {
				setReplaced(r.plan);
				setChanged(true);
				return;
			}
			const failed = r.results.filter((x) => !x.ok);
			if (failed.length > 0) {
				setError(`Cloudflare refused the change: ${failed[0]!.error ?? 'it could not be written'}. ${failed.length === r.results.length ? 'Nothing was written.' : `${r.results.length - failed.length} of ${r.results.length} written.`}`);
				void plan.refetch().then((x) => x.data && setReplaced(x.data));
				return;
			}
			await markWizardState(domain.id, { domain: 'complete', dmarc: 'complete' });
			// Read public DNS once now and store it, so the dashboard's first-day card is about what DNS shows, not what it showed yesterday. Best effort.
			await firstCheck([domain.id]).catch(() => undefined);
			await invalidateDomain(qc, domain.id);
			// The first-day card says "Written to Cloudflare: waiting for public DNS" itself; a toast only adds the one thing it does not know.
			if (!r.results.every((x) => x.verified)) toast({ variant: 'success', title: 'Written to Cloudflare', description: "We couldn't read it back from Cloudflare yet. Public DNS can take a few minutes." });
			leave('applied');
		} catch (e) {
			setError(`${errorMessage(e)} Nothing was confirmed as written.`);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mx-auto max-w-xl space-y-5" data-testid="review">
			{plan.isPending || (!current && !plan.isError) ? (
				<>
					<h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">Checking {domain.domain} in Cloudflare</h1>
					<Skeleton className="h-32 w-full" role="status" aria-label="Reading the records in Cloudflare" />
				</>
			) : plan.isError && !current ? (
				<>
					<h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{domain.domain}</h1>
					<LoadError error={plan.error} onRetry={() => void plan.refetch()} title="Could not read the records in Cloudflare" />
					<Button variant="secondary" onClick={() => leave()}>
						Go to the dashboard
					</Button>
				</>
			) : (
				<>
					<div className="space-y-1">
						<h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">
							{n === 0 ? `${domain.domain} needs no change` : `${n} ${plural(n, 'change', 'changes')} to ${domain.domain}`}
						</h1>
						<p className="text-sm text-ink-2">{accountName ? `Connected to Cloudflare account ${accountName}.` : 'Connected to Cloudflare.'} Nothing is written until you press Apply.</p>
					</div>

					{changed ? <Alert variant="warning">Cloudflare changed since you looked. Review again.</Alert> : null}
					{reportsNote ? (
						<Alert variant="info" data-testid="reports-note">
							{reportsNote.reason}
						</Alert>
					) : null}

					{n > 0 ? (
						<ul className="space-y-3" aria-label="Changes">
							{pending.map((w) => (
								<Change key={w.id} w={w} />
							))}
						</ul>
					) : (
						<p className="max-w-prose text-sm text-ink-1">{writes.length > 0 ? 'The records are already as Ready Set Mail would write them.' : "There is nothing to write for this domain."}</p>
					)}

					{others.length > 0 ? (
						<ul className="space-y-1 text-sm text-ink-2">
							{others.map((x, i) => (
								<li key={i}>
									Not written{x.domain ? ` for ${x.domain}` : ''}: {x.what}. {x.reason}
								</li>
							))}
						</ul>
					) : null}

					<p className="max-w-prose text-sm text-ink-2">{NOT_CHANGED}</p>

					{error ? (
						<Alert variant="danger" role="alert">
							{error}
						</Alert>
					) : null}

					<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
						{n > 0 ? (
							<Button className="w-full sm:w-auto" loading={busy} onClick={() => void apply()}>
								{busy ? `Writing ${n} ${plural(n, 'record', 'records')} to Cloudflare…` : error ? 'Try again' : `Apply ${n} ${plural(n, 'change', 'changes')}`}
							</Button>
						) : (
							<Button className="w-full sm:w-auto" onClick={() => leave()}>
								Go to the dashboard
							</Button>
						)}
						{n > 0 ? (
							<button type="button" className="text-sm text-ink-2 underline underline-offset-4 hover:text-ink-1" onClick={() => leave()} disabled={busy}>
								Skip for now
							</button>
						) : null}
					</div>

					<div className="space-y-2 text-sm text-ink-2">
						{notAdded.length > 0 ? (
							<p data-testid="also-in-account">
								Also in {accountName ?? 'this Cloudflare account'}: {notAdded.map((z) => z.name).join(', ')}. Not added: this workspace is for {domain.domain}. Add each client from Add domain, in its own workspace.
							</p>
						) : null}
						{more > 0 ? (
							<p>
								Also in {accountName ?? 'your Cloudflare account'}: {more} more {plural(more, 'domain', 'domains')}, added and watched. Nothing was written to {plural(more, 'it', 'them')}.
							</p>
						) : null}
						{HAND_OFF_ENABLED && role === 'owner' ? (
							<p>
								Not the one setting this up?{' '}
								<Link to={handoffPath(domain.domain)} className="text-brand-ink underline underline-offset-4">
									Hand setup to a teammate →
								</Link>
							</p>
						) : null}
					</div>
				</>
			)}
		</div>
	);
}
