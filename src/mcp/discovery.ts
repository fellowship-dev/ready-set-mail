import type { Env } from '../index';
/** One installation, one issuer/resource. Never derive a trusted audience from an arbitrary Host header. */
export function mcpInstallation(env: Pick<Env, 'BETTER_AUTH_URL' | 'PUBLIC_BASE_URL'>, requestOrigin?: string) {
 const configured = env.BETTER_AUTH_URL || env.PUBLIC_BASE_URL;
 if (!configured) throw new Error('Configure BETTER_AUTH_URL for agent authorization');
 const url = new URL(configured);
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Agent issuer must be an HTTPS origin');
 const issuer = url.origin;
 if (requestOrigin && new URL(requestOrigin).origin !== issuer) throw new Error('Wrong installation origin');
 return { issuer, resource: `${issuer}/mcp` };
}

/** RFC 9728: where the protected resource's metadata is published. The path-inserted form is the one the library serves; the root form is answered by the same document (src/auth/mcp-issuer.ts). */
export const PROTECTED_RESOURCE_ROOT_PATH = '/.well-known/oauth-protected-resource';
export function mcpResourceMetadataUrl(env: Pick<Env, 'BETTER_AUTH_URL' | 'PUBLIC_BASE_URL'>): string {
 return `${mcpInstallation(env).issuer}${PROTECTED_RESOURCE_ROOT_PATH}/mcp`;
}

/** Every 401 from /mcp: the Bearer challenge names where the client finds the authorization server (RFC 9728 section 5.1), so it can start sign-in or refresh. */
export function invalidTokenResponse(env: Pick<Env, 'BETTER_AUTH_URL' | 'PUBLIC_BASE_URL'>): Response {
 return Response.json({ error: 'invalid_token' }, { status: 401, headers: { 'WWW-Authenticate': `Bearer realm="OAuth", error="invalid_token", resource_metadata="${mcpResourceMetadataUrl(env)}"`, 'Cache-Control': 'no-store' } });
}
