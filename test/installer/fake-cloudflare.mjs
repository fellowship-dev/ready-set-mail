// A fake Cloudflare for the installer tests: the REST endpoints scripts/setup/cloudflare.mjs calls,
// a fake Wrangler (deploy / migrations / auth token) and the deployed Worker's /health and
// /api/auth/status. Every call is recorded so tests can assert the exact sequence.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { parseJsonc } from '../../scripts/setup/config.mjs';

export const API = 'https://cf.fake/client/v4';
export const TOKEN = 'fake-token-0123456789abcdef0123456789abcdef';
export const ACCOUNT = { id: 'a'.repeat(32), name: 'Example Co' };
export const OTHER_ACCOUNT = { id: 'b'.repeat(32), name: 'Side Project' };

export function createFakeCloudflare({ accounts = [ACCOUNT], subdomain = 'example', workers = [], d1 = [], kv = [], repoRoot } = {}) {
  const calls = [];
  const world = {
    // name -> { created_on, d1Id, kvId }: what the scripts list and settings endpoints report
    workers: new Map(workers.map(w => typeof w === 'string' ? [w, { created_on: '2020-01-01T00:00:00Z', d1Id: null, kvId: null }] : [w.name, w])),
    d1: d1.map(d => ({ ...d, migrations: [] })),
    kv: [...kv],
    secrets: {},      // worker -> { name: value }
    owner: false,
    failNext: {},     // command key -> number of failures to inject
    failDelete: null, // 'worker' | 'd1' | 'kv': that DELETE fails once
    deployCreatesThenFails: false, // the deploy creates the Worker, then exits non-zero
    clock: 0,
  };
  let seq = 0;
  const id = () => (++seq).toString(16).padStart(32, '0');
  const uuid = () => { const h = (++seq).toString(16).padStart(32, '0'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  const ok = (result, extra = {}) => new Response(JSON.stringify({ success: true, errors: [], result, ...extra }), { status: 200, headers: { 'content-type': 'application/json' } });
  const notFound = (code, message) => new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status: 404 });

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    if (url.hostname.endsWith('.workers.dev')) {
      const worker = url.hostname.split('.')[0];
      calls.push(`${method} https://${worker}.<sub>.workers.dev${url.pathname}`);
      if (!world.workers.has(worker)) return new Response('not found', { status: 404 });
      const db = world.d1.find(d => d.boundTo === worker);
      if (!db || !db.migrations.length) return new Response('Database schema is out of date', { status: 503 });
      if (url.pathname === '/health') return Response.json({ ok: true, version: '1.2.0', ts: 0 });
      if (url.pathname === '/api/auth/status') return Response.json({ configured: world.owner, mode: 'self-host' });
      return new Response('nope', { status: 404 });
    }
    if (!String(input).startsWith(API)) throw new Error(`unexpected fetch ${input}`);
    if (init.headers?.Authorization === 'Bearer expired-token') return new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: 'Invalid access token' }] }), { status: 401 });
    if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
    const path = url.pathname.slice(new URL(API).pathname.length).replace(/^\/accounts\/[0-9a-f]{32}/, '/accounts/<acct>');
    calls.push(`${method} ${path}`);
    const body = init.body ? JSON.parse(init.body) : null;
    const m = (re) => path.match(re);
    if (method === 'GET' && path === '/accounts') return ok(accounts, { result_info: { page: 1, per_page: 50, total_pages: 1 } });
    if (method === 'GET' && path === '/accounts/<acct>/workers/scripts') return ok([...world.workers].map(([name, w]) => ({ id: name, created_on: w.created_on, etag: 'e' })));
    if (method === 'GET' && path === '/accounts/<acct>/workers/subdomain') return subdomain ? ok({ subdomain }) : notFound(10007, 'This account does not have a workers.dev subdomain');
    if (method === 'GET' && path === '/accounts/<acct>/d1/database') return ok(world.d1.map(d => ({ uuid: d.id, name: d.name })), { result_info: { page: 1, total_pages: 1 } });
    if (method === 'GET' && path === '/accounts/<acct>/storage/kv/namespaces') return ok(world.kv.map(k => ({ id: k.id, title: k.title })), { result_info: { page: 1, total_pages: 1 } });
    if (method === 'POST' && path === '/accounts/<acct>/d1/database') { const d = { id: uuid(), name: body.name, migrations: [] }; world.d1.push(d); return ok({ uuid: d.id, name: d.name }); }
    if (method === 'POST' && path === '/accounts/<acct>/storage/kv/namespaces') { const k = { id: id(), title: body.title }; world.kv.push(k); return ok(k); }
    let mm;
    if (method === 'GET' && (mm = m(/^\/accounts\/<acct>\/workers\/scripts\/([^/]+)\/settings$/))) {
      const w = world.workers.get(decodeURIComponent(mm[1]));
      if (!w) return notFound(10007, 'script not found');
      return ok({ bindings: [...(w.d1Id ? [{ type: 'd1', name: 'DB', id: w.d1Id }] : []), ...(w.kvId ? [{ type: 'kv_namespace', name: 'OAUTH_KV', namespace_id: w.kvId }] : []), ...(w.ratelimitIds ?? []).map((id, i) => ({ type: 'ratelimit', name: `L${i}`, namespace_id: id, simple: { limit: 1, period: 60 } }))] });
    }
    if (method === 'DELETE' && world.failDelete && path.includes(world.failDelete === 'kv' ? '/storage/kv/' : world.failDelete === 'd1' ? '/d1/' : '/workers/')) { world.failDelete = null; return new Response(JSON.stringify({ success: false, errors: [{ code: 7000, message: 'simulated outage' }] }), { status: 500 }); }
    if (method === 'POST' && (mm = m(/^\/accounts\/<acct>\/d1\/database\/([0-9a-f-]+)\/query$/))) {
      const d = world.d1.find(x => x.id === mm[1]);
      return ok([{ results: d.migrations.length ? [{ name: [...d.migrations].sort().at(-1) }] : [] }]);
    }
    if (method === 'DELETE' && (mm = m(/^\/accounts\/<acct>\/workers\/scripts\/(.+)$/))) { world.workers.delete(decodeURIComponent(mm[1])); return ok(null); }
    if (method === 'DELETE' && (mm = m(/^\/accounts\/<acct>\/d1\/database\/([0-9a-f-]+)$/))) { world.d1 = world.d1.filter(d => d.id !== mm[1]); return ok(null); }
    if (method === 'DELETE' && (mm = m(/^\/accounts\/<acct>\/storage\/kv\/namespaces\/([0-9a-f]+)$/))) { world.kv = world.kv.filter(k => k.id !== mm[1]); return ok(null); }
    throw new Error(`fake Cloudflare: no route for ${method} ${path}`);
  }

  /**
   * The config Wrangler reads, the way the real one picks it: the --config/-c file when given (relative to the
   * checkout), otherwise the tracked wrangler.jsonc. Wrangler never picks up wrangler.local.jsonc by itself.
   */
  function wranglerConfig(args) {
    const root = world.repoRoot ?? repoRoot;
    const i = args.findIndex(a => a === '--config' || a === '-c');
    const file = i >= 0 ? args[i + 1] : 'wrangler.jsonc';
    return parseJsonc(readFileSync(file.startsWith('/') ? file : join(root, file), 'utf8'));
  }

  /** Like Wrangler: a D1 argument matching a config entry's binding or database_name uses THAT entry's id. */
  function resolveD1(cfg, arg) {
    const entry = (cfg.d1_databases ?? []).find(d => d.binding === arg || d.database_name === arg);
    const id = entry ? entry.database_id : world.d1.find(d => d.name === arg)?.id;
    return { id, db: world.d1.find(d => d.id === id) };
  }

  /** The fake child processes: npm (build) and Wrangler. */
  async function run(cmd, args, opts = {}) {
    const key = `${cmd} ${args.filter(a => !a.includes('/')).join(' ')}`.replace(/--secrets-file$/, '--secrets-file <file>');
    calls.push(`$ ${key}`);
    if (world.failNext[args[0]] > 0) { world.failNext[args[0]]--; return { code: 1, output: `simulated ${args[0]} failure\n` }; }
    if (cmd === 'npm') return { code: 0, output: 'built\n' };
    const cfg = wranglerConfig(args);
    if ((cfg.account_id ?? opts.accountId) !== opts.accountId) return { code: 1, output: 'wrong account\n' };
    if (args[0] === 'd1' && args[1] === 'export') {
      const { id, db } = resolveD1(cfg, args[2]);
      if (!db) return { code: 1, output: `Executing on remote database ${args[2]} (${id})\nCouldn't find DB with id ${id}\n` };
      const out = args[args.indexOf('--output') + 1];
      writeFileSync(out, world.emptyExport ? '' : `-- export of ${db.name} (${db.id})\n`);
      world.lastExport = db.id;
      return { code: 0, output: `Executing on remote database ${db.name} (${db.id})\nexported to ${out}\n` };
    }
    if (args[0] === 'd1' && args[1] === 'migrations') {
      const { id, db } = resolveD1(cfg, args[3]);
      if (!db) return { code: 1, output: `Couldn't find DB with id ${id}\n` };
      db.migrations = readdirSync(join(repoRoot, 'migrations')).filter(f => f.endsWith('.sql'));
      return { code: 0, output: 'Migrations applied\n' };
    }
    if (args[0] === 'deploy') {
      const file = args[args.indexOf('--secrets-file') + 1];
      const mode = statSync(file).mode & 0o777;
      if (mode !== 0o600) return { code: 1, output: `secrets file mode ${mode.toString(8)}\n` };
      world.secrets[cfg.name] = JSON.parse(readFileSync(file, 'utf8'));
      const prev = world.workers.get(cfg.name);
      world.workers.set(cfg.name, { created_on: prev?.created_on ?? `2026-11-14T12:00:${String(++world.clock).padStart(2, '0')}Z`, d1Id: cfg.d1_databases[0].database_id, kvId: cfg.kv_namespaces[0].id, ratelimitIds: cfg.unsafe.bindings.filter(b => b.type === 'ratelimit').map(b => b.namespace_id) });
      const bound = world.d1.find(d => d.id === cfg.d1_databases[0].database_id);
      if (!bound) return { code: 1, output: `binding DB: database ${cfg.d1_databases[0].database_id} not found\n` };
      bound.boundTo = cfg.name;
      world.lastDeployConfig = cfg;
      if (world.deployCreatesThenFails) { world.deployCreatesThenFails = false; return { code: 1, output: 'connection reset after upload\n' }; }
      return { code: 0, output: `Uploaded ${cfg.name}\nDeployed ${cfg.name} triggers\n` };
    }
    return { code: 1, output: `fake wrangler: unknown command ${args.join(' ')}\n` };
  }

  return { fetch, run, calls, world };
}

/** Capturing streams and the deps object main() takes. */
export function fakeDeps({ fake, repoRoot, home, env = {}, tty = false, answers = [], authToken = null }) {
  const out = [];
  const err = [];
  const sink = (arr) => new Writable({ write(chunk, _enc, cb) { arr.push(String(chunk)); cb(); } });
  const stdin = new PassThrough();
  for (const a of answers) stdin.write(`${a}\n`);
  let n = 0;
  return {
    out, err,
    deps: {
      repoRoot, home,
      env: { RSM_SETUP_CF_API_BASE: API, ...env },
      stdin, stdout: sink(out), stderr: sink(err),
      isTTY: tty,
      nodeVersion: 'v22.22.2',
      wranglerVersion: () => '4.160.0',
      fetch: fake.fetch,
      randomBytes: (size) => Buffer.alloc(size, ++n),
      sleep: async () => {},
      verifyAttempts: 2,
      now: () => new Date('2026-11-14T12:00:00Z'),
      run: fake.run,
      wranglerAuthToken: async () => authToken,
      wranglerLogin: async () => 1,
    },
  };
}
