import { Alert, Button } from '@ready-set-mail/ui';
import { Check, Copy } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../../lib/api';
import { appRoute, applyStep, fetchPlan, pendingWrites, type NotWritten, type PlanStepKey, type PlanWrite } from '../../../lib/dns-plan';

export interface PlanStepProps {
	stepKey: PlanStepKey;
	domainIds: number[];
	onNext: () => void;
	/** Called once, just before `onNext`, with the plan writes that succeeded (e.g. `dmarc:7`, `auth:7`, `mx:…`) and how many were checked in Cloudflare afterwards. */
	onWritten?: (written: { ids: string[]; verified: number; rules: number }) => void;
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

/** A record name with break opportunities only after dots, so a label is never split (a last resort aside). */
function DottedName({ name }: { name: string }) {
	const parts = name.split(/(?<=\.)/);
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

const typeOf = (w: PlanWrite) => (w.type === 'EMAIL_ROUTING' ? 'Rule' : w.type);

/** From md: name, type, value and change on one line under the domain heading; the name column has room, the change column is narrow. */
function WideRow({ w, ok, verified, error }: { w: PlanWrite; ok: boolean; verified: boolean; error?: string }) {
	return (
		<li className="grid grid-cols-[minmax(0,5fr)_3rem_minmax(0,4fr)_8rem] items-start gap-x-4 py-3 text-sm">
			<div className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{w.type === 'EMAIL_ROUTING' ? null : <DottedName name={w.name} />}</div>
			<div className="text-ink-2">{typeOf(w)}</div>
			<div className="min-w-0">
				<ValueCell w={w} />
			</div>
			<div className="min-w-0 text-sm">
				<Status w={w} ok={ok} verified={verified} error={error} />
			</div>
		</li>
	);
}

/** Below md: one compact block per record under the domain heading: name, "TXT · New record", value with Copy. */
function StackedRow({ w, ok, verified, error }: { w: PlanWrite; ok: boolean; verified: boolean; error?: string }) {
	return (
		<li className="min-w-0 space-y-1 py-3 text-sm">
			{w.type === 'EMAIL_ROUTING' ? null : <p className="font-mono text-xs [overflow-wrap:anywhere]"><DottedName name={w.name} /></p>}
			<div className="flex flex-wrap items-baseline gap-x-2 text-ink-2">
				<span>{typeOf(w)}</span>
				<span aria-hidden>·</span>
				<Status w={w} ok={ok} verified={verified} error={error} />
			</div>
			<ValueCell w={w} />
		</li>
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

	// Report what was written, then move on: the next step says what happened.
	const finish = () => {
		const ids = [...doneRef.current];
		if (ids.length > 0) onWritten?.({ ids, verified: ids.filter((i) => verifiedRef.current.has(i)).length, rules: writes.filter((w) => w.action === 'rule' && doneRef.current.has(w.id)).length });
		onNext();
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
	else if ((satisfied && !failedSome) || total === 0) primary = { label: 'Next', onClick: onNext };
	else if (failedSome) primary = { label: 'Try again', onClick: () => void retry() };
	else primary = { label: `Write ${remaining.length} ${hasRule ? (remaining.length === 1 ? 'change' : 'changes') : remaining.length === 1 ? 'record' : 'records'} and continue`, onClick: () => void write(planId, writes) };

	const noneToShow = !loading && !loadError && writes.length === 0;
	const groups = writes.reduce<{ domain: string; writes: PlanWrite[] }[]>((acc, w) => {
		const g = acc.find((x) => x.domain === w.domain);
		if (g) g.writes.push(w);
		else acc.push({ domain: w.domain, writes: [w] });
		return acc;
	}, []);
	const zones = [...new Set(writes.map((w) => w.zone))];
	const oneZone = zones.length === 1 ? zones[0] : null;
	const showIntro = !loading && !loadError && writes.length > 0 && !(satisfied && !failedSome);
	const intro = stepKey === 'reports_mailbox' ? 'Ready Set Mail will write these records and the routing rule to Cloudflare. Nothing changes until you press the button.' : 'Ready Set Mail will write these records to Cloudflare. Nothing changes until you press the button.';

	return (
		<div className="space-y-4">
			{loadError ? <Alert variant="danger">{loadError}</Alert> : null}
			{changed ? <Alert variant="warning">Cloudflare changed since you looked; review again.</Alert> : null}
			{errors._ ? <Alert variant="danger">{errors._}</Alert> : null}
			{!loading && !loadError && satisfied && !failedSome ? <p className="font-medium text-ink-1">Already in place</p> : null}
			{showIntro ? <p className="max-w-prose text-sm text-ink-2">{intro}</p> : null}
			{showIntro && oneZone ? <p className="text-sm text-ink-2">In your Cloudflare zone <span className="font-medium text-ink-1">{oneZone}</span>.</p> : null}
			{noneToShow || writes.length === 0 ? null : (
				<div className="space-y-5" role="group" aria-label="Records for this step">
					{groups.map((g) => (
						<section key={g.domain} aria-label={g.domain} className="space-y-1">
							<h3 className="text-base font-semibold max-md:[overflow-wrap:anywhere] md:whitespace-nowrap">{g.domain}</h3>
							<ul className="divide-y divide-line border-y border-line">
								{g.writes.map((w) => (wide ? <WideRow key={w.id} w={w} ok={done.has(w.id)} verified={verified.has(w.id)} error={errors[w.id]} /> : <StackedRow key={w.id} w={w} ok={done.has(w.id)} verified={verified.has(w.id)} error={errors[w.id]} />))}
							</ul>
						</section>
					))}
				</div>
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
			<div className="flex flex-wrap gap-2">
				<Button onClick={primary.onClick} disabled={primary.disabled} loading={primary.loading}>
					{primary.label}
				</Button>
				{failedSome && !busy && !loading ? (
					<Button variant="secondary" onClick={() => { finish(); }}>
						Continue without them
					</Button>
				) : null}
			</div>
		</div>
	);
}
