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
      throw new CloudflareError(`${method} ${path.replace(/[0-9a-f]{32}/g, '<account>')} failed: ${detail}`, { status: res.status, codes: errs.map(e => e.code) });
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
    listWorkers: async (accountId) => ((await call('GET', `/accounts/${accountId}/workers/scripts`)).result ?? []).map(s => s.id),
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
