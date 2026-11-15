import { Button } from '@ready-set-mail/ui';
import { Link } from 'react-router';
import { AuthLayout } from './AuthLayout';

/** Where a reset link sent before codes lands (`#/reset/<token>`): resets use a 6-digit code now. */
export function ResetPage() {
	return (
		<AuthLayout title="This reset link no longer works">
			<p className="text-sm text-ink-2">Password resets use a 6-digit code now. Ask for one, then choose a new password; you'll be signed in.</p>
			<Button asChild className="w-full">
				<Link to="/forgot">Reset your password</Link>
			</Button>
			<p className="text-center text-sm">
				<Link to="/" className="text-brand-ink underline underline-offset-4">
					Sign in
				</Link>
			</p>
		</AuthLayout>
	);
}
