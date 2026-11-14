import { Alert, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ready-set-mail/ui';
import { Check, Copy } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../../lib/api';
import { appRoute, applyStep, fetchPlan, pendingWrites, type NotWritten, type PlanStepKey, type PlanWrite } from '../../../lib/dns-plan';

export interface PlanStepProps {
	stepKey: PlanStepKey;
	domainIds: number[];
	onNext: () => void;
	/** Called once with the ids of the plan writes that succeeded (e.g. `dmarc:7`, `auth:7`, `mx:…`) after a full success. */
	onWritten?: (writtenIds: string[]) => void;
}

/** Whether the viewport is at least `md` (768px): the table from there, stacked blocks below. */
function useWide() {
	const q = '(min-width: 768px)';
	const [wide, setWide] = useState(() => (typeof window !== 'undefined' ? !!window.matchMedia?.(q).matches : false));
	useEffect(() => {
		const m = window.matchMedia?.(q);
		if (!m) return;
		const on = () => setWide(m.matches);
		on();
		m.addEventListener?.('change', on);
		return () => m.removeEventListener?.('change', on);
	}, []);
	return wide;
}

/** Value with a break opportunity after every `;`, so long DMARC/DKIM values wrap at tag boundaries. */
function Breakable({ text }: { text: string }) {
	const parts = text.split(/(?<=;)/);
	return (
		<>
			{parts.map((p, i) => (
				<Fragment key={i}>
					{p}
					{i < parts.length - 1 ? <wbr /> : null}
				</Fragment>
			))}
		</>
	);
}

function CopyValue({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="secondary"
			size="sm"
			aria-label={label}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				} catch {
					/* the value stays selectable */
				}
			}}
		>
			{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
			{copied ? 'Copied' : 'Copy'}
		</Button>
	);
}

const value = (w: PlanWrite) => (w.priority !== undefined && w.type === 'MX' ? `${w.priority} ${w.content}` : w.content);

function Change({ w }: { w: PlanWrite }) {
	switch (w.action) {
		case 'create':
			return <span>New record</span>;
		case 'update':
			return <span>Update</span>;
		case 'delete':
			return <span className="text-danger">Remove this record</span>;
		case 'rule':
			return <span>Routing rule</span>;
		default:
			return <span className="text-ink-2">Already in place</span>;
	}
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="min-w-0">
			<p className="text-xs text-ink-3">{label}</p>
			<div className="min-w-0">{children}</div>
		</div>
	);
}

function ValueCell({ w }: { w: PlanWrite }) {
	if (w.type === 'EMAIL_ROUTING') return <p className="[overflow-wrap:anywhere]">{w.content}</p>;
	return (
		<div className="min-w-0 space-y-1">
			{w.action === 'update' && w.before ? (
				<p className="font-mono text-xs text-ink-2 [overflow-wrap:anywhere]">
					<span className="font-sans">Before: </span>
					<Breakable text={w.before} />
				</p>
			) : null}
			{w.action === 'update' ? <p className="text-xs text-ink-3">After:</p> : null}
			<div className="flex flex-wrap items-start gap-2">
				<p className="min-w-0 flex-1 basis-40 font-mono text-xs [overflow-wrap:anywhere]">
					<Breakable text={value(w)} />
				</p>
				<CopyValue text={w.content} label={`Copy value of ${w.name}`} />
			</div>
		</div>
	);
}

function Status({ w, ok, verified, error }: { w: PlanWrite; ok: boolean; verified: boolean; error?: string }) {
	return (
		<>
			<Change w={w} />
			{ok ? (
				<p className="mt-1 flex items-center gap-1 text-success">
					<Check aria-hidden className="size-4 shrink-0" />
					{verified ? 'Written and checked in Cloudflare' : 'Written'}
				</p>
			) : error ? (
				<p role="alert" className="mt-1 text-danger [overflow-wrap:anywhere]">
					{error}
				</p>
			) : null}
		</>
	);
}

export function PlanStep({ stepKey, domainIds, onNext, onWritten }: PlanStepProps) {
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [planId, setPlanId] = useState('');
	const [writes, setWrites] = useState<PlanWrite[]>([]);
	const [satisfied, setSatisfied] = useState(false);
	const [notWritten, setNotWritten] = useState<NotWritten[]>([]);
	const [done, setDone] = useState<Set<string>>(new Set());
	const [verified, setVerified] = useState<Set<string>>(new Set());
	const wide = useWide();
	const verifiedRef = useRef<Set<string>>(new Set());
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [changed, setChanged] = useState(false);
	const [finished, setFinished] = useState(false);
	const [failedSome, setFailedSome] = useState(false);
	const doneRef = useRef<Set<string>>(new Set());
	const ids = domainIds.join(',');

	const take = useCallback(
		(plan: Awaited<ReturnType<typeof fetchPlan>>) => {
			const step = plan.steps.find((s) => s.key === stepKey);
			setPlanId(plan.plan_id);
			setWrites(step?.writes ?? []);
			setSatisfied(step ? step.satisfied : true);
			setNotWritten(plan.not_written.filter((n) => n.step === stepKey));
			return step?.writes ?? [];
		},
		[stepKey],
	);

	const load = useCallback(async () => {
		setLoading(true);
		setLoadError(null);
		try {
			take(await fetchPlan(domainIds));
		} catch (e) {
			setLoadError(errorMessage(e));
		} finally {
			setLoading(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ids, take]);

	useEffect(() => {
		void load();
	}, [load]);

	const finish = () => {
		setFinished(true);
		setFailedSome(false);
		onWritten?.([...doneRef.current]);
	};

	const write = async (currentPlanId: string, currentWrites: PlanWrite[]) => {
		setBusy(true);
		setChanged(false);
		setErrors({});
		try {
			const r = await applyStep(domainIds, stepKey, currentPlanId);
			if (r.kind === 'plan_changed') {
				take(r.plan);
				setChanged(true);
				return;
			}
			const errs: Record<string, string> = {};
			for (const x of r.results) {
				if (x.ok) {
					doneRef.current.add(x.id);
					if (x.verified) verifiedRef.current.add(x.id);
					else verifiedRef.current.delete(x.id);
				}
				else errs[x.id] = x.error ?? 'This record could not be written.';
			}
			setDone(new Set(doneRef.current));
			setVerified(new Set(verifiedRef.current));
			setErrors(errs);
			if (Object.keys(errs).length) setFailedSome(true);
			else {
				// Anything the plan listed as pending that the server did not report is not done: only complete when all are.
				const missing = pendingWrites(currentWrites).some((w) => !doneRef.current.has(w.id));
				if (missing) setFailedSome(true);
				else finish();
			}
		} catch (e) {
			setErrors({ _: errorMessage(e) });
			setFailedSome(true);
		} finally {
			setBusy(false);
		}
	};

	const retry = async () => {
		setBusy(true);
		try {
			const plan = await fetchPlan(domainIds);
			const w = take(plan);
			const step = plan.steps.find((s) => s.key === stepKey);
			const remaining = pendingWrites(w).filter((x) => !doneRef.current.has(x.id));
			if (!step || remaining.length === 0) {
				setErrors({});
				finish();
				setBusy(false);
				return;
			}
			setBusy(false);
			await write(plan.plan_id, w);
		} catch (e) {
			setErrors({ _: errorMessage(e) });
			setBusy(false);
		}
	};

	const remaining = pendingWrites(writes).filter((w) => !done.has(w.id));
	const hasRule = remaining.some((w) => w.action === 'rule');
	const total = pendingWrites(writes).length;

	let primary: { label: string; onClick: () => void; disabled?: boolean; loading?: boolean };
	if (loading) primary = { label: 'Checking Cloudflare…', onClick: () => {}, disabled: true, loading: true };
	else if (loadError) primary = { label: 'Try again', onClick: () => void load() };
	else if (busy) primary = { label: 'Writing…', onClick: () => {}, disabled: true, loading: true };
	else if (finished || (satisfied && !failedSome) || total === 0) primary = { label: 'Next', onClick: onNext };
	else if (failedSome) primary = { label: 'Try again', onClick: () => void retry() };
	else primary = { label: `Write ${remaining.length} ${hasRule ? (remaining.length === 1 ? 'change' : 'changes') : remaining.length === 1 ? 'record' : 'records'}`, onClick: () => void write(planId, writes) };

	const noneToShow = !loading && !loadError && writes.length === 0;

	return (
		<div className="space-y-4">
			{loadError ? <Alert variant="danger">{loadError}</Alert> : null}
			{changed ? <Alert variant="warning">Cloudflare changed since you looked; review again.</Alert> : null}
			{errors._ ? <Alert variant="danger">{errors._}</Alert> : null}
			{!loading && !loadError && satisfied && !finished && !failedSome ? <p className="font-medium text-ink-1">Already in place</p> : null}
			{finished ? <Alert variant="success">Done. Every record below is written.</Alert> : null}
			{noneToShow || writes.length === 0 ? null : wide ? (
				<Table label="Records for this step" className="table-fixed">
					<TableHeader>
						<TableRow>
							<TableHead className="w-[14%]">Domain</TableHead>
							<TableHead className="w-[20%]">Record</TableHead>
							<TableHead className="w-[8%]">Type</TableHead>
							<TableHead className="w-[40%]">Value</TableHead>
							<TableHead>Change</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{writes.map((w) => (
							<TableRow key={w.id}>
								<TableCell className="align-top [overflow-wrap:anywhere]">{w.domain}</TableCell>
								<TableCell className="align-top font-mono text-xs [overflow-wrap:anywhere]">{w.type === 'EMAIL_ROUTING' ? '' : w.name}</TableCell>
								<TableCell className="align-top">{w.type === 'EMAIL_ROUTING' ? 'Rule' : w.type}</TableCell>
								<TableCell className="align-top">
									<ValueCell w={w} />
								</TableCell>
								<TableCell className="align-top">
									<Status w={w} ok={done.has(w.id)} verified={verified.has(w.id)} error={errors[w.id]} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<ul aria-label="Records for this step" className="space-y-3">
					{writes.map((w) => (
						<li key={w.id} className="min-w-0 space-y-2 rounded-lg border border-line p-3 text-sm">
							<Field label="Domain">
								<span className="font-medium [overflow-wrap:anywhere]">{w.domain}</span>
							</Field>
							{w.type === 'EMAIL_ROUTING' ? null : (
								<Field label="Record">
									<span className="font-mono text-xs [overflow-wrap:anywhere]">{w.name}</span>
								</Field>
							)}
							<Field label="Type">{w.type === 'EMAIL_ROUTING' ? 'Rule' : w.type}</Field>
							<Field label="Value">
								<ValueCell w={w} />
							</Field>
							<Field label="Change">
								<Status w={w} ok={done.has(w.id)} verified={verified.has(w.id)} error={errors[w.id]} />
							</Field>
						</li>
					))}
				</ul>
			)}
			{notWritten.length > 0 ? (
				<ul className="space-y-1 text-sm text-ink-2">
					{notWritten.map((n, i) => (
						<li key={i}>
							Not written{n.domain ? ` for ${n.domain}` : ''}: {n.what}. {n.reason}
							{n.link ? (
								<>
									{' '}
									<Link className="text-brand-ink underline" to={appRoute(n.link)}>
										Set it up by hand
									</Link>
								</>
							) : null}
						</li>
					))}
				</ul>
			) : null}
			<div>
				<Button onClick={primary.onClick} disabled={primary.disabled} loading={primary.loading}>
					{primary.label}
				</Button>
			</div>
		</div>
	);
}
