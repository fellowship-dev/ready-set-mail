// The few Cloudflare API calls the installer makes, over plain fetch. The base URL can be pointed
// at a fake (tests) with RSM_SETUP_CF_API_BASE; nothing else changes between a real and a fake run.

export const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(message, { status, codes } = {}) {
    super(message);
    this.status = status;
    this.codes = codes ?? [];
  }
}

/** An API path with its ids named by kind, for messages: /accounts/<account>/d1/database/<database>. */
export function labelPath(path) {
  return path
    .replace(/^\/accounts\/[^/]+/, '/accounts/<account>')
    .replace(/\/d1\/database\/[^/]+/, '/d1/database/<database>')
    .replace(/\/storage\/kv\/namespaces\/[^/]+/, '/storage/kv/namespaces/<namespace>')
    .replace(/\/workers\/scripts\/[^/]+/, '/workers/scripts/<worker>');
}

/** Cloudflare's answers for a credential that is invalid, expired or revoked. */
export const INVALID_CREDENTIAL_CODES = [9109, 10000, 9106, 6003, 6111, 1000];
export function isInvalidCredential(e) {
  return e instanceof CloudflareError && (e.status === 401 || e.codes.some(c => INVALID_CREDENTIAL_CODES.includes(c)));
}

export function createCloudflare({ token, fetch, apiBase = DEFAULT_API_BASE }) {
  if (!token) throw new Error('createCloudflare: no token');

  async function call(method, path, { body, query } = {}) {
    const url = new URL(apiBase.replace(/\/$/, '') + path);
    for (const [k, val] of Object.entries(query ?? {})) url.searchParams.set(k, String(val));
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new CloudflareError(`Cannot reach the Cloudflare API (${e.cause?.code ?? e.message})`);
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON answer */ }
    if (!res.ok || !data || data.success === false) {
      const errs = data?.errors ?? [];
      const detail = errs.map(e => `${e.code ? `${e.code}: ` : ''}${e.message}`).join('; ') || `HTTP ${res.status}`;
      throw new CloudflareError(`${method} ${labelPath(path)} failed: ${detail}`, { status: res.status, codes: errs.map(e => e.code) });
    }
    return data;
  }

  /** All pages of a list endpoint (page/per_page style). */
  async function all(path, perPage = 100, query = {}) {
    const out = [];
    for (let page = 1; page < 100; page++) {
      const data = await call('GET', path, { query: { ...query, page, per_page: perPage } });
      const items = data.result ?? [];
      out.push(...items);
      const info = data.result_info;
      if (!info || items.length < perPage || (info.total_pages && page >= info.total_pages)) break;
    }
    return out;
  }

  return {
    listAccounts: () => all('/accounts', 50).then(r => r.map(a => ({ id: a.id, name: a.name }))),
    /** Workers in the account: name and creation time (the creation time is the Worker's identity across redeploys). */
    listWorkers: async (accountId) => ((await call('GET', `/accounts/${accountId}/workers/scripts`)).result ?? []).map(s => ({ name: s.id, created_on: s.created_on ?? null })),
    /** The ids a Worker's DB (D1) and OAUTH_KV (KV) bindings point at, read from its current settings. */
    async workerBindings(accountId, name) {
      const bindings = (await call('GET', `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/settings`)).result?.bindings ?? [];
      const d1 = bindings.find(b => b.name === 'DB' && b.type === 'd1');
      const kv = bindings.find(b => b.name === 'OAUTH_KV' && b.type === 'kv_namespace');
      const ratelimitIds = bindings.filter(b => b.type === 'ratelimit' && b.namespace_id !== undefined).map(b => String(b.namespace_id));
      return { d1Id: d1?.id ?? d1?.database_id ?? null, kvId: kv?.namespace_id ?? null, ratelimitIds };
    },
    listD1: (accountId) => all(`/accounts/${accountId}/d1/database`, 100).then(r => r.map(d => ({ id: d.uuid, name: d.name }))),
    listKv: (accountId) => all(`/accounts/${accountId}/storage/kv/namespaces`, 100).then(r => r.map(n => ({ id: n.id, title: n.title }))),
    /** The account's workers.dev subdomain, or null when it has none yet. */
    async workersSubdomain(accountId) {
      try {
        return (await call('GET', `/accounts/${accountId}/workers/subdomain`)).result?.subdomain || null;
      } catch (e) {
        if (e.status === 404 || e.codes.includes(10007)) return null;
        throw e;
      }
    },
    createD1: async (accountId, name) => {
      const r = (await call('POST', `/accounts/${accountId}/d1/database`, { body: { name } })).result;
      return { id: r.uuid, name: r.name };
    },
    createKv: async (accountId, title) => {
      const r = (await call('POST', `/accounts/${accountId}/storage/kv/namespaces`, { body: { title } })).result;
      return { id: r.id, title: r.title };
    },
    /** Rows of one read-only SQL statement against D1. */
    queryD1: async (accountId, databaseId, sql) => {
      const r = (await call('POST', `/accounts/${accountId}/d1/database/${databaseId}/query`, { body: { sql } })).result;
      return r?.[0]?.results ?? [];
    },
    deleteWorker: (accountId, name) => call('DELETE', `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`, { query: { force: 'true' } }),
    deleteD1: (accountId, id) => call('DELETE', `/accounts/${accountId}/d1/database/${id}`),
    deleteKv: (accountId, id) => call('DELETE', `/accounts/${accountId}/storage/kv/namespaces/${id}`),
  };
}
