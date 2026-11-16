/**
 * Hosted sign-up, as the dashboard sees it: three screens (S1 email and password, S2 "Tell us about yourself", S3 the code)
 * whose position is kept by the server on the pending sign-up attempt (src/auth/routes.ts /api/auth/signup/*), not by the page.
 * The URL holds the step (`#/signup`, `#/signup/about`, `#/signup/code`) and the server says which one is right.
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './api';

export type WhoseEmail = 'company' | 'clients' | 'looking';

/** The answers of S2 (the free-text ones are profile text only). */
export interface SignupProfile {
	name: string;
	organization: string;
	whose_email: WhoseEmail;
	role?: string;
	heard_about?: string;
}

/** GET /api/auth/signup/pending. `step` is where this browser's attempt stands: S2 until its answers are saved, then the code. */
export type PendingSignup =
	| { pending: false }
	| { pending: true; email: string; step: 'about' | 'code'; expires_in: number; lifetime_seconds?: number; profile?: SignupProfile };

export const SIGNUP_PENDING_KEY = ['signup-pending'] as const;

export type SignupStep = 'form' | 'about' | 'code';
export const SIGNUP_PATH: Record<SignupStep, string> = { form: '/signup', about: '/signup/about', code: '/signup/code' };

/** Which screen the address bar names. */
export function stepOfPath(pathname: string): SignupStep {
	if (/\/signup\/about\/?$/.test(pathname)) return 'about';
	if (/\/signup\/code\/?$/.test(pathname)) return 'code';
	return 'form';
}

/** Where the server's state says this person should be, or null when no attempt is waiting (S1). */
export const screenFor = (p: PendingSignup | undefined): SignupStep => (p && p.pending ? p.step : 'form');

export function usePendingSignup(enabled = true) {
	return useQuery({
		enabled,
		queryKey: SIGNUP_PENDING_KEY,
		queryFn: () => api<PendingSignup>('/api/auth/signup/pending'),
		// The attempt lives a few minutes and changes with every screen: always ask, never reuse.
		staleTime: 0,
		gcTime: 0,
		retry: false,
	});
}

const EMAIL_KEY = 'rsm_signup_email';
/**
 * The address of the sign-up in progress, kept in this tab only (never the password): when the attempt ends while the page is open or
 * the tab comes back later, S1 can say so and keep the email. Cleared when the code is right or the person starts over.
 */
export function rememberSignupEmail(email: string): void {
	try {
		sessionStorage.setItem(EMAIL_KEY, email.trim());
	} catch {
		/* private mode: S1 just opens empty */
	}
}
export function readSignupEmail(): string | null {
	try {
		return sessionStorage.getItem(EMAIL_KEY) || null;
	} catch {
		return null;
	}
}
export function forgetSignupEmail(): void {
	try {
		sessionStorage.removeItem(EMAIL_KEY);
	} catch {
		/* ignore */
	}
}

const ABOUT_KEY = 'rsm_signup_about';
/**
 * The answers on S2 (name, organization, whose email, role, heard about), kept in this tab only so "Start over" after a mistyped
 * address does not make the person type them again. NEVER the password. Cleared once the account is created. The next attempt's S2
 * is prefilled from it; the server still holds only the attempt's own answers.
 */
export function rememberSignupAbout(about: Partial<SignupProfile>): void {
	try {
		sessionStorage.setItem(ABOUT_KEY, JSON.stringify({ name: about.name ?? '', organization: about.organization ?? '', whose_email: about.whose_email ?? '', role: about.role ?? '', heard_about: about.heard_about ?? '' }));
	} catch {
		/* private mode: S2 opens empty */
	}
}
export function readSignupAbout(): Partial<SignupProfile> | null {
	try {
		const v = JSON.parse(sessionStorage.getItem(ABOUT_KEY) ?? 'null') as Record<string, unknown> | null;
		if (!v || typeof v !== 'object') return null;
		const text = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '');
		const whose = v.whose_email === 'company' || v.whose_email === 'clients' || v.whose_email === 'looking' ? v.whose_email : undefined;
		return { name: text(v.name, PROFILE_LIMITS.name), organization: text(v.organization, PROFILE_LIMITS.organization), ...(whose ? { whose_email: whose } : {}), role: text(v.role, 40), heard_about: text(v.heard_about, PROFILE_LIMITS.heard_about) };
	} catch {
		return null;
	}
}
export function forgetSignupAbout(): void {
	try {
		sessionStorage.removeItem(ABOUT_KEY);
	} catch {
		/* ignore */
	}
}

export const WHOSE_EMAIL_OPTIONS: ReadonlyArray<{ value: WhoseEmail; title: string }> = [
	{ value: 'company', title: "My company's" },
	{ value: 'clients', title: "My clients' (I'm an agency or IT provider)" },
	{ value: 'looking', title: 'Just looking around' },
];

export const ROLE_OPTIONS: ReadonlyArray<{ value: string; title: string }> = [
	{ value: 'founder', title: 'Founder / owner' },
	{ value: 'developer', title: 'Developer / engineer' },
	{ value: 'it', title: 'IT / sysadmin' },
	{ value: 'marketing', title: 'Marketing / growth' },
	{ value: 'agency', title: 'Agency or consultant' },
	{ value: 'other', title: 'Other' },
];

/** Bounds the server enforces (src/auth/profile.ts); the form stops typing at the same numbers. */
export const PROFILE_LIMITS = { name: 100, organization: 80, heard_about: 200 } as const;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Put what the server just said (or what this browser just did to the attempt) in the cache without asking again. */
export function setPendingSignup(qc: QueryClient, value: PendingSignup): void {
	qc.setQueryData(SIGNUP_PENDING_KEY, value);
}
