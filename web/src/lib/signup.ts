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

export function usePendingSignup() {
	return useQuery({
		queryKey: SIGNUP_PENDING_KEY,
		queryFn: () => api<PendingSignup>('/api/auth/signup/pending'),
		// The attempt lives a few minutes and changes with every screen: always ask, never reuse.
		staleTime: 0,
		gcTime: 0,
		retry: false,
	});
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
