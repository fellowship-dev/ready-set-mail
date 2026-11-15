import { Alert, Button } from '@ready-set-mail/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { CodeForm, needsCode, type CodeRequired } from '../auth/CodeStep';

/** GET /api/auth/codes: can sign-in codes be used here, and are they on for the signed-in person. */
export interface MyCodes {
	available: boolean;
	reason: 'hosted' | 'mail' | 'no_mail' | 'turned_off';
	on_for_me: boolean;
}

export const CODES_ON_FOR_ME = 'On for you: every sign-in ends with a code emailed to you.';
export const CODES_TURNED_ON = 'Sign-in codes are on for you. From now on, every sign-in ends with a code emailed to you.';
export const CODES_OFF_FOR_ME = 'Off for you so far: you sign in with your password alone. Send yourself a test code; once you enter it, every sign-in asks for one.';

/**
 * Self-hosted instance that can send mail: whether this person's sign-in asks for a code. Codes are asked for only from someone
 * a code has reached, so a configured sender cannot lock anyone out; the test code is how a person turns them on.
 */
export function SigninCodesForMe() {
	const qc = useQueryClient();
	const mine = useQuery({ queryKey: ['my-signin-codes'], queryFn: () => api<MyCodes>('/api/auth/codes'), retry: false });
	const [pending, setPending] = useState<CodeRequired | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [turnedOn, setTurnedOn] = useState(false);

	if (!mine.data?.available) return null;
	if (mine.data.on_for_me) return <p className="mt-2 text-sm text-ink-1" role={turnedOn ? 'status' : undefined}>{turnedOn ? CODES_TURNED_ON : CODES_ON_FOR_ME}</p>;

	const sendTest = () => api<CodeRequired>('/api/auth/codes/test', { method: 'POST', body: {} });

	async function start() {
		setError('');
		setBusy(true);
		try {
			const res = await sendTest();
			if (needsCode(res)) setPending(res);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	if (pending) {
		return (
			<div className="mt-3">
				<CodeForm
					email={pending.email}
					purpose="confirm"
					submitLabel="Turn on sign-in codes"
					onSubmit={async (code) => {
						await api('/api/auth/codes/confirm', { method: 'POST', body: { code } });
						setPending(null);
						setTurnedOn(true);
						await qc.invalidateQueries({ queryKey: ['my-signin-codes'] });
					}}
					onResend={async () => {
						const res = await sendTest();
						if (needsCode(res)) setPending(res);
					}}
					onChangeEmail={() => setPending(null)}
				/>
			</div>
		);
	}

	return (
		<div className="mt-2 space-y-3">
			<p className="text-sm text-ink-1">{CODES_OFF_FOR_ME}</p>
			<Button variant="secondary" loading={busy} onClick={() => void start()}>
				Send me a test code
			</Button>
			{error ? <Alert variant="danger">{error}</Alert> : null}
		</div>
	);
}
