import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * The one-time setup link token (`#/claim/<token>`). Held in memory only: never in storage, and the route replaces
 * the URL at once so it does not stay in the address bar or history.
 */
type ClaimLink = { token: string | null; hold: (token: string) => void; clear: () => void };

const ClaimLinkContext = createContext<ClaimLink>({ token: null, hold: () => {}, clear: () => {} });

export function ClaimLinkProvider({ children }: { children: ReactNode }) {
	const [token, setToken] = useState<string | null>(null);
	const hold = useCallback((t: string) => setToken(t), []);
	const clear = useCallback(() => setToken(null), []);
	const value = useMemo(() => ({ token, hold, clear }), [token, hold, clear]);
	return <ClaimLinkContext.Provider value={value}>{children}</ClaimLinkContext.Provider>;
}

export const useClaimLink = () => useContext(ClaimLinkContext);
