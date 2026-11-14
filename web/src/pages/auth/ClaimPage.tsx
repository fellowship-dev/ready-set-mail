import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useClaimLink } from '../../lib/claim-link';

/**
 * Where the setup link printed at deploy lands (`#/claim/<token>`). It keeps the token in memory and replaces the
 * URL straight away, so the token leaves the address bar and history; the sign-in screen then shows the owner form.
 */
export function ClaimPage() {
	const { token = '' } = useParams();
	const { hold } = useClaimLink();
	const navigate = useNavigate();
	useEffect(() => {
		if (token) hold(token);
		navigate('/', { replace: true });
	}, [token, hold, navigate]);
	return null;
}
