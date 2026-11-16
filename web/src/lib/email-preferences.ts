import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useHosted } from './session';

export type EmailKind = 'summary' | 'tips';
interface Choice { offered: boolean; enabled: boolean }
/** GET /api/email-preferences: the signed-in person's own choices in the open workspace (src/lifecycle/email/routes.ts). */
export interface EmailPreferences { role: 'owner' | 'admin' | 'member'; summary: Choice; tips: Choice }

export const emailPreferenceKeys = { all: ['email-preferences'] as const };

/** Asked on the hosted service only: the lifecycle emails exist nowhere else. */
export function useEmailPreferences() {
	const hosted = useHosted();
	return useQuery({
		queryKey: emailPreferenceKeys.all,
		enabled: hosted,
		retry: false,
		staleTime: 15_000,
		queryFn: () => api<EmailPreferences>('/api/email-preferences'),
	});
}

export function useSetEmailPreference() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (p: { kind: EmailKind; enabled: boolean }) => api<EmailPreferences>('/api/email-preferences', { method: 'PUT', body: p }),
		onSuccess: (view) => qc.setQueryData(emailPreferenceKeys.all, view),
	});
}
