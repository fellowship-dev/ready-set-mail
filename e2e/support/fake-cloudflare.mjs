// A tiny in-memory Cloudflare API for local runs and e2e. It answers only what Ready Set Mail's Cloudflare flow
// calls, in Cloudflare's envelope ({ success, errors, messages, result }). Nothing here talks to the network.
//
//   standalone:  PORT=8788 node e2e/support/fake-cloudflare.mjs
//   from a test: const fake = await startFakeCloudflare({ port: 0 }); fake.url; await fake.close();
//
// Point the Worker at it with CLOUDFLARE_API_BASE_URL=http://127.0.0.1:<port> (the Worker honours only localhost
// URLs). Any bearer token is accepted except one that starts with "bad" (answered 401, like a revoked token).
//
// It also answers DNS-over-HTTPS JSON queries (GET /dns-query?name=&type=, application/dns-json: TXT, MX, NS, A, AAAA, CNAME)
// from the same records, so a run can set DOH_BASE_URL=http://127.0.0.1:<port> and never read public DNS for these made-up
// names. Names inside a seeded zone are never NXDOMAIN (no record is NODATA); names outside every zone are NXDOMAIN.
//
// Seeded so a walk shows each outcome: brightwave-mail.com has a DMARC record without our rua (an update),
// harbor-lane.org has none (a create), quietfield.net has an MX at its apex (left untouched).
//
// Test helpers (not part of Cloudflare's API): GET /__state, POST /__reset.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ACCOUNT = { id: hex('account:example-co'), name: 'Example Co' };
export const ZONE_NAMES = ['brightwave-mail.com', 'harbor-lane.org', 'quietfield.net'];

function hex(seed) { return createHash('sha256').update(seed).digest('hex').slice(0, 32); }

function freshState() {
  let seq = 0;
  const zones = ZONE_NAMES.map(name => ({ id: hex(`zone:${name}`), name, status: 'active', account: { id: ACCOUNT.id, name: ACCOUNT.name } }));
  const seeded = [
    ['brightwave-mail.com', { type: 'TXT', name: '_dmarc.brightwave-mail.com', content: 'v=DMARC1; p=quarantine; pct=50' }],
    ['quietfield.net', { type: 'MX', name: 'quietfield.net', content: 'mail.quietfield.net', priority: 10 }],
  ];
  const records = new Map(zones.map(z => [z.id, []])); // zone id -> records
  const now = new Date().toISOString();
  for (const [zoneName, r] of seeded) {
    const z = zones.find(x => x.name === zoneName);
    records.get(z.id).push({ id: hex(`seed:${r.type}:${r.name}`), zone_id: z.id, zone_name: z.name, ttl: 1, proxied: false, comment: null, created_on: now, modified_on: now, ...r });
  }
  return {
    zones,
    records,
    routing: new Map(zones.map(z => [z.id, { enabled: false, catchAll: null }])),
    addresses: [], // account-level destination addresses
    nextId: () => hex(`record:${++seq}:${Date.now()}`),
  };
}

const envelope = (result, extra = {}) => ({ success: true, errors: [], messages: [], result, ...extra });
const failure = (message, code = 1000) => ({ success: false, errors: [{ code, message }], messages: [], result: null });

export function createFakeCloudflare() {
  let st = freshState();

  const zoneById = id => st.zones.find(z => z.id === id);
  const fqdn = (zone, name) => {
    const n = String(name ?? '').toLowerCase().replace(/\.$/, '');
    return n === '@' || n === '' ? zone.name : n === zone.name || n.endsWith(`.${zone.name}`) ? n : `${n}.${zone.name}`;
  };
  const stripQuotes = s => String(s ?? '').replace(/^"|"$/g, '');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake.local');
    const method = req.method ?? 'GET';
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const ok = (result, extra) => send(200, envelope(result, extra));
    const notFound = (what = 'Not found') => send(404, failure(what, 7003));

    let body;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(400, failure('Invalid JSON body', 1004)); }
    }

    // Test helpers.
    if (url.pathname === '/__state') return send(200, { zones: st.zones, records: Object.fromEntries(st.records), routing: Object.fromEntries(st.routing), addresses: st.addresses });
    if (url.pathname === '/__reset' && method === 'POST') { st = freshState(); return send(200, { ok: true }); }

    // DNS-over-HTTPS (application/dns-json) from the in-memory records.
    if (method === 'GET' && url.pathname === '/dns-query') {
      const name = (url.searchParams.get('name') ?? '').toLowerCase().replace(/\.$/, '');
      const type = (url.searchParams.get('type') ?? 'A').toUpperCase();
      const CODES = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
      const zone = [...st.zones].filter(z => name === z.name || name.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      const reply = body => { res.writeHead(200, { 'Content-Type': 'application/dns-json' }); res.end(JSON.stringify(body)); };
      if (!zone || !CODES[type]) return reply({ Status: zone ? 0 : 3, Question: [{ name, type: CODES[type] ?? 1 }] });
      const rows = type === 'NS' && name === zone.name
        ? [{ data: 'ns1.fake-dns.invalid.' }, { data: 'ns2.fake-dns.invalid.' }]
        : st.records.get(zone.id).filter(r => r.name === name && r.type === type).map(r => ({
            data: type === 'TXT' ? JSON.stringify(stripQuotes(r.content)) : type === 'MX' ? `${r.priority ?? 0} ${r.content}.` : r.type === 'CNAME' || type === 'NS' ? `${r.content}.` : r.content,
          }));
      return reply({ Status: 0, Question: [{ name, type: CODES[type] }], ...(rows.length ? { Answer: rows.map(r => ({ name, type: CODES[type], TTL: 60, data: r.data })) } : {}) });
    }

    const prefix = '/client/v4';
    if (!url.pathname.startsWith(prefix)) return notFound();
    const path = url.pathname.slice(prefix.length);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!bearer || bearer.startsWith('bad')) return send(401, failure('Invalid API Token', 1000));

    if (method === 'GET' && path === '/user/tokens/verify') return ok({ id: hex(`token:${bearer}`), status: 'active' });

    if (method === 'GET' && path === '/accounts') return ok([{ id: ACCOUNT.id, name: ACCOUNT.name }]);

    if (method === 'GET' && path === '/zones') {
      let list = st.zones;
      const name = url.searchParams.get('name');
      if (name) list = list.filter(z => z.name === name.toLowerCase());
      const status = url.searchParams.get('status');
      if (status) list = list.filter(z => z.status === status);
      const perPage = Math.max(1, Math.min(50, Number(url.searchParams.get('per_page')) || 20));
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const slice = list.slice((page - 1) * perPage, page * perPage);
      return ok(slice, { result_info: { page, per_page: perPage, count: slice.length, total_count: list.length, total_pages: Math.max(1, Math.ceil(list.length / perPage)) } });
    }

    let m = path.match(/^\/zones\/([^/]+)$/);
    if (m && method === 'GET') { const z = zoneById(m[1]); return z ? ok(z) : notFound('Zone not found'); }

    // Account level: email routing destination addresses, Workers subdomain.
    m = path.match(/^\/accounts\/([^/]+)(\/.*)?$/);
    if (m) {
      if (m[1] !== ACCOUNT.id) return notFound('Account not found');
      const rest = m[2] ?? '';
      if (rest === '/email/routing/addresses') {
        if (method === 'GET') return ok(st.addresses);
        if (method === 'POST') {
          const email = String(body?.email ?? '').toLowerCase();
          if (!email) return send(400, failure('Invalid email address', 1004));
          if (st.addresses.some(a => a.email === email)) return send(400, failure('This destination address already exists', 2007));
          const addr = { id: hex(`addr:${email}`), email, verified: null, created: new Date().toISOString() };
          st.addresses.push(addr);
          return ok(addr);
        }
      }
      if (rest === '/workers/subdomain' && method === 'GET') return ok({ subdomain: 'example-co' });
      if (rest === '/workers/domains' && method === 'PUT') return ok(body ?? {});
      return notFound();
    }

    // Zone level.
    m = path.match(/^\/zones\/([^/]+)(\/.*)$/);
    if (!m) return notFound();
    const zone = zoneById(m[1]);
    if (!zone) return notFound('Zone not found');
    const rest = m[2];
    const records = st.records.get(zone.id);

    if (rest === '/dns_records') {
      if (method === 'GET') {
        let list = records;
        const type = url.searchParams.get('type');
        const name = url.searchParams.get('name');
        if (type) list = list.filter(r => r.type === type.toUpperCase());
        if (name) list = list.filter(r => r.name === name.toLowerCase());
        const perPage = Math.max(1, Math.min(5000, Number(url.searchParams.get('per_page')) || 100));
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        return ok(list.slice((page - 1) * perPage, page * perPage));
      }
      if (method === 'POST') {
        if (!body?.type || !body?.content) return send(400, failure('Invalid DNS record: type and content are required', 9005));
        const name = fqdn(zone, body.name);
        const type = String(body.type).toUpperCase();
        const dup = records.find(r => r.type === type && r.name === name && r.content === body.content && (r.priority ?? null) === (body.priority ?? null));
        if (dup) return send(400, failure('An identical record already exists.', 81058));
        const now = new Date().toISOString();
        const rec = { id: st.nextId(), zone_id: zone.id, zone_name: zone.name, type, name, content: body.content, ttl: body.ttl ?? 1, proxied: body.proxied ?? false, comment: body.comment ?? null, created_on: now, modified_on: now };
        if (body.priority !== undefined) rec.priority = body.priority;
        records.push(rec);
        return ok(rec);
      }
    }

    m = rest.match(/^\/dns_records\/([^/]+)$/);
    if (m) {
      const rec = records.find(r => r.id === m[1]);
      if (!rec) return notFound('Record does not exist.');
      if (method === 'GET') return ok(rec);
      if (method === 'PATCH' || method === 'PUT') {
        for (const k of ['content', 'ttl', 'priority', 'proxied', 'comment']) if (body?.[k] !== undefined) rec[k] = body[k];
        if (body?.name !== undefined) rec.name = fqdn(zone, body.name);
        if (body?.type !== undefined) rec.type = String(body.type).toUpperCase();
        rec.modified_on = new Date().toISOString();
        return ok(rec);
      }
      if (method === 'DELETE') { records.splice(records.indexOf(rec), 1); return ok({ id: rec.id }); }
    }

    // Email Routing.
    const routing = st.routing.get(zone.id);
    if (rest === '/email/routing' && method === 'GET') return ok({ id: zone.id, name: zone.name, enabled: routing.enabled, status: routing.enabled ? 'ready' : 'unconfigured' });
    if ((rest === '/email/routing/enable' || rest === '/email/routing/dns') && (method === 'PUT' || method === 'POST')) {
      routing.enabled = true;
      return ok({ id: zone.id, name: zone.name, enabled: true, status: 'ready' });
    }
    if (rest === '/email/routing/rules/catch_all') {
      if (method === 'GET') return routing.catchAll ? ok(routing.catchAll) : ok({ id: hex(`catchall:${zone.id}`), enabled: false, actions: [{ type: 'drop' }], matchers: [{ type: 'all' }], name: 'Catch-all' });
      if (method === 'PUT') {
        routing.catchAll = { id: hex(`catchall:${zone.id}`), tag: hex(`catchall:${zone.id}`), name: body?.name ?? 'Catch-all', enabled: body?.enabled ?? true, actions: body?.actions ?? [], matchers: body?.matchers ?? [{ type: 'all' }] };
        return ok(routing.catchAll);
      }
    }
    if (rest === '/email/routing/rules' && method === 'GET') return ok([]);

    return notFound(`Fake Cloudflare does not implement ${method} ${path}`);
  }

  const server = http.createServer((req, res) => { handle(req, res).catch(e => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(failure(String(e?.message ?? e), 1))); }); });
  return { server, reset() { st = freshState(); } };
}

/** Start the fake on 127.0.0.1. `port: 0` picks a free one. Resolves to `{ url, port, close, reset }`. */
export async function startFakeCloudflare({ port = 0 } = {}) {
  const { server, reset } = createFakeCloudflare();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actual = server.address().port;
  return { url: `http://127.0.0.1:${actual}`, port: actual, reset, close: () => new Promise(r => server.close(() => r())) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fake = await startFakeCloudflare({ port: Number(process.env.PORT) || 8788 });
  console.log(`fake Cloudflare listening on ${fake.url} (zones: ${ZONE_NAMES.join(', ')}; account: ${ACCOUNT.name})`);
}
