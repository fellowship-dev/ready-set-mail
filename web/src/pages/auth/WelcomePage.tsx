import { Button } from '@ready-set-mail/ui';
import { Link } from 'react-router';
import { AuthLayout } from './AuthLayout';

/**
 * Where a confirmation link sent before codes lands (`#/welcome/<token>`). Opening it changes nothing and the token is not
 * used: email addresses are confirmed with a 6-digit code now. If a password was already chosen with the link, the account is
 * ready (sign in); if not, a password reset sends a code and sets one (it works for an account confirmed by the link and for
 * one still waiting, where signing up again would only send a notice to a confirmed address).
 */
export function WelcomePage() {
	return (
		<AuthLayout title="This link is no longer used">
			<p className="text-sm text-ink-2">Ready Set Mail now confirms email addresses with a 6-digit code instead of a link.</p>
			<p className="text-sm text-ink-2">If you already chose a password, sign in. If you didn't, reset your password: we'll email you a code and you'll choose one.</p>
			<Button asChild className="w-full">
				<Link to="/">Sign in</Link>
			</Button>
			<Button asChild variant="secondary" className="w-full">
				<Link to="/forgot">Reset your password</Link>
			</Button>
		</AuthLayout>
	);
}
