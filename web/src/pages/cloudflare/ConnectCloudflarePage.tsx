import { Button, toast } from '@ready-set-mail/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { LoadError, PageSkeleton, ReadOnlyNotice } from '../../components/states';
import { WizardProgress } from '../../components/wizard/WizardProgress';
import { ApiError, api } from '../../lib/api';
import {
	activeConnection,
	cfKeys,
	consumeOAuthReturn,
	fetchZones,
	linkDomain,
	oauthErrorMessage,
	useCfConnections,
	type CfConnection,
} from '../../lib/cloudflare';
import { ConnectStep } from '../wizards/cloudflare/ConnectStep';
import { ZonesStep } from '../wizards/cloudflare/ZonesStep';

/** Only an in-app path: starts with one slash. Anything else (a URL, `//host`, a backslash trick) goes home. */
export function safeBack(raw: string | null): string {
	if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return '/';
	return raw;
}

const domainIdOf = (back: string): number | null => {
	const m = /^\/domains\/(\d+)(?:[/?#]|$)/.exec(back);
	return m ? Number.parseInt(m[1]!, 10) : null;
};

/** `#/cloudflare/connect?back=`: connect and choose zones, link the domain being worked on, return to where the person was. */
export function ConnectCloudflarePage() {
	const [params] = useSearchParams();
	const back = safeBack(params.get('back'));
	const navigate = useNavigate();
	const qc = useQueryClient();
	const conns = useCfConnections();
	const [step, setStep] = useState<'connect' | 'zones'>('connect');
	const [fresh, setFresh] = useState<CfConnection | null>(null);
	const [returnError, setReturnError] = useState<string | null>(null);
	const returned = useRef(false);
	const finishing = useRef(false);

	// Back from Cloudflare's consent screen: read the result once, then take it out of the address bar.
	useEffect(() => {
		if (returned.current) return;
		returned.current = true;
		const r = consumeOAuthReturn();
		if (r?.error) setReturnError(oauthErrorMessage(r.error));
		if (r?.connection) void conns.refetch();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const connection: CfConnection | null = fresh ?? (conns.data ? activeConnection(conns.data) : null);

	async function finish(c: CfConnection) {
		if (finishing.current) return;
		finishing.current = true;
		const id = domainIdOf(back);
		if (id !== null) {
			try {
				const [zones, domains] = await Promise.all([
					qc.fetchQuery({ queryKey: cfKeys.zones(c.id), queryFn: () => fetchZones(c), staleTime: 0 }),
					qc.fetchQuery({ queryKey: ['domains'], queryFn: () => api<{ domains: Array<{ id: number; domain: string }> }>('/api/domains'), staleTime: 0 }),
				]);
				const name = domains.domains.find((d) => d.id === id)?.domain.toLowerCase();
				const allowed = !!name && zones.some((z) => z.allowed && (name === z.name.toLowerCase() || name.endsWith(`.${z.name.toLowerCase()}`)));
				if (allowed) {
					await linkDomain(id, c.id);
					await qc.invalidateQueries({ queryKey: ['domains'] });
					await qc.invalidateQueries({ queryKey: ['domain', id] });
					void qc.invalidateQueries({ predicate: (q) => q.queryKey.includes('onboarding') || q.queryKey.includes('dns') });
				}
			} catch {
				toast({ variant: 'warning', title: 'Cloudflare is connected', description: 'This domain could not be linked to it yet. Try again from its settings.' });
			}
		}
		navigate(back, { replace: true });
	}

	// An existing usable connection makes step 1 unnecessary; the server token has no zone list to choose from.
	useEffect(() => {
		if (step !== 'connect' || !connection || returnError) return;
		if (connection.implicit) void finish(connection);
		else setStep('zones');
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [step, connection, returnError]);

	let body;
	if (conns.isPending) body = <PageSkeleton label="Checking Cloudflare" />;
	else if (conns.isError) {
		const denied = conns.error instanceof ApiError && conns.error.status === 403;
		body = denied ? (
			<div className="space-y-4">
				<p className="text-sm text-ink-2">Only owners and admins can connect Cloudflare. Ask one of them, or add your DNS records yourself.</p>
				<Button asChild variant="secondary">
					<Link to={back}>Go back</Link>
				</Button>
			</div>
		) : (
			<LoadError error={conns.error} onRetry={() => void conns.refetch()} title="Could not check Cloudflare" />
		);
	} else if (step === 'zones' && connection) {
		body = <ZonesStep connection={connection} onNext={() => void finish(connection)} />;
	} else {
		body = (
			<ConnectStep
				offer={conns.data}
				returnError={returnError}
				onConnected={(c) => {
					setFresh(c);
					setReturnError(null);
					if (c.implicit) void finish(c);
					else setStep('zones');
				}}
			/>
		);
	}

	return (
		<div className="space-y-6">
			<header className="space-y-3">
				<h1 className="text-2xl font-bold tracking-tight">Connect Cloudflare</h1>
				<WizardProgress
					label="Cloudflare connection progress"
					current={step === 'connect' ? 0 : 1}
					steps={[
						{ label: 'Connect', state: step === 'zones' ? 'complete' : 'pending' },
						{ label: 'Zones', state: 'pending' },
					]}
				/>
			</header>
			<ReadOnlyNotice />
			{body}
		</div>
	);
}
