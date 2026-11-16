import { Alert, AuthLayout, Button, Field, FieldError, Input } from "@ready-set-mail/ui";
import { useState, type FormEvent } from "react";
import { SAMPLE_EMAIL } from "../sample";

/** Mirrors web AuthPage: same layout, fields, copy and primitives; no network. */
export function AuthScreen({ mode }: { mode: "signin" | "setup" }) {
	const registering = mode === "setup";
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const submit = (e: FormEvent) => {
		e.preventDefault();
		setError("");
		setBusy(true);
		setTimeout(() => {
			setBusy(false);
			setError(registering ? "Passwords do not match." : "Email or password is incorrect.");
		}, 600);
	};
	return (
		<AuthLayout
			title={registering ? "Create your account" : "Sign in"}
			description={registering ? "Set up your Ready Set Mail instance. You will use these credentials to sign in." : undefined}
		>
			<form onSubmit={submit} className="space-y-4">
				{registering ? (
					<Field id="name" label="Your name (optional)">
						<Input id="name" autoComplete="name" placeholder="Jane Smith" />
					</Field>
				) : null}
				<Field id="email" label="Email" hint={registering ? "Used to sign in and to receive monitoring alerts." : undefined}>
					<Input id="email" type="email" required autoComplete="email" defaultValue={SAMPLE_EMAIL} aria-describedby={registering ? "email-hint" : undefined} />
				</Field>
				<Field id="password" label="Password" hint={registering ? "At least 8 characters." : undefined}>
					<Input id="password" type="password" required autoComplete={registering ? "new-password" : "current-password"} aria-describedby={registering ? "password-hint" : undefined} />
				</Field>
				{registering ? (
					<Field id="confirm" label="Confirm password">
						<Input id="confirm" type="password" required autoComplete="new-password" />
					</Field>
				) : null}
				{error ? <FieldError>{error}</FieldError> : null}
				<Button type="submit" className="w-full" loading={busy}>
					{registering ? "Create account" : "Sign in"}
				</Button>
			</form>
			{registering ? null : (
				<p className="text-center text-sm">
					<a href="#/signin" className="text-brand-ink underline underline-offset-4">Forgot your password?</a>
				</p>
			)}
			{registering ? null : (
				<Alert variant="info" className="text-left">Sign-up is closed on this instance. Ask an owner for an invite link.</Alert>
			)}
		</AuthLayout>
	);
}
