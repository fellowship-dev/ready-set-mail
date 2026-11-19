import { cleanName } from './names';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@ready-set-mail/ui';
import { api, errorMessage } from './api';
import type { Role } from './types';
import { useSession } from './session';
import { hashFor, workspaceStore } from './workspace';

export interface WorkspaceSummary {
	id: string;
	name: string;
	role: Role;
	member_count: number;
	/** How many members are owners: with one, an owner cannot leave. */
	owner_count: number;
	created_at: number;
}

export const workspaceKeys = { all: ['workspaces'] as const };

/** Every workspace the signed-in user belongs to (independent of the one selected). */
export function useWorkspaces(enabled = true) {
	return useQuery({
		queryKey: workspaceKeys.all,
		// Names render in the switcher, Settings and dialogs: shown cleaned, whatever was stored.
		queryFn: () => api<{ workspaces: WorkspaceSummary[] }>('/api/workspaces').then((r) => r.workspaces.map((w) => ({ ...w, name: cleanName(w.name) || 'Unnamed workspace' }))),
		enabled,
		staleTime: 30_000,
	});
}

/** Hosted: anyone may start a workspace. Self-host: only the instance owner (owner of the default workspace). */
export const canCreateWorkspace = (mode: string | undefined, list: readonly Pick<WorkspaceSummary, 'id' | 'role'>[]): boolean =>
	mode === 'saas' || list.some((w) => w.id === 'ws_default' && w.role === 'owner');

/** Open a workspace: the URL changes, the router remounts, the previous workspace's data is dropped. */
export function switchToWorkspace(id: string, rest = '/') {
	workspaceStore.remember(id);
	window.location.hash = hashFor(id, rest);
}

export function useCreateWorkspace(onCreated?: (w: { id: string; name: string }) => void) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => api<{ id: string; name: string }>('/api/workspaces', { method: 'POST', body: { name } }),
		onSuccess: async (w) => {
			await qc.invalidateQueries({ queryKey: workspaceKeys.all });
			onCreated?.(w);
		},
	});
}

export function useRenameWorkspace(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => api(`/api/workspaces/${id}`, { method: 'PATCH', body: { name } }),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: workspaceKeys.all });
			toast({ variant: 'success', title: 'Workspace renamed' });
		},
	});
}

/** Leave or delete: afterwards the person is somewhere that still exists (another workspace, or "No workspace yet" when it was their only one). */
export function useLeaveWorkspace(id: string, then: () => void) {
	const qc = useQueryClient();
	const { signedIn } = useSession();
	return useMutation({
		mutationFn: () => api(`/api/workspaces/${id}/leave`, { method: 'POST', body: {} }),
		onSuccess: async () => {
			workspaceStore.forget();
			await signedIn();
			toast({ variant: 'success', title: 'You left the workspace' });
			then();
		},
		onError: (e) => toast({ variant: 'danger', title: 'Could not leave', description: errorMessage(e) }),
	});
}

export function useDeleteWorkspace(id: string, then: () => void) {
	const qc = useQueryClient();
	const { signedIn } = useSession();
	return useMutation({
		// `leaveSpf`: delete although a flattened SPF record could not be put back (it then stays in Cloudflare, unrefreshed): only after the person has the original.
		mutationFn: (arg?: string | { confirm?: string; leaveSpf?: boolean }) => {
			const { confirm, leaveSpf } = typeof arg === 'string' || arg === undefined ? { confirm: arg, leaveSpf: false } : arg;
			const q = [confirm ? `confirm=${encodeURIComponent(confirm)}` : '', leaveSpf ? 'leave_spf_record=1' : ''].filter(Boolean).join('&');
			return api(`/api/workspaces/${id}${q ? `?${q}` : ''}`, { method: 'DELETE' });
		},
		onSuccess: async () => {
			workspaceStore.forget();
			await qc.invalidateQueries({ queryKey: workspaceKeys.all });
			await signedIn(); // with no workspace left, "No workspace yet" is what the page now shows
			toast({ variant: 'success', title: 'Workspace deleted' });
			then();
		},
	});
}
