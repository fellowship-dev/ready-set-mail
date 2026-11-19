// A policy host (`mta-sts.<domain>`) answers GET/HEAD of /.well-known/mta-sts.txt. Whatever else reaches the Worker on that host is a 404 (withPolicyHostFirst).
// wrangler.jsonc keeps the path list `run_worker_first` of origin/main: it contains `/.well-known/*`, so the policy path always reaches the Worker, and every
// other path is answered by the static assets (billing and routing: developers.cloudflare.com/workers/static-assets/billing-and-limitations/ and .../routing/worker-script/).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import worker from '../../src/index';
import { mtaWorld, quietLogs } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('wrangler.jsonc keeps the assets routing of main, and the policy path is in it', () => {
  // Main's list, verbatim: changing it (`true` bills every static file as a Worker request; 429 on Free past the limit) is a decision, not a side effect of MTA-STS.
  const MAIN_RUN_WORKER_FIRST = ['/api/*', '/mcp', '/mcp/*', '/oauth/*', '/.well-known/*', '/health', '/llms.txt', '/relay/*'];
  const assets = () => ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync('wrangler.jsonc', 'utf8')).config.assets;

  it('run_worker_first is the list on main, not true', () => {
    expect(assets().run_worker_first).toEqual(MAIN_RUN_WORKER_FIRST);
    expect(assets().binding).toBe('ASSETS');
    expect(assets().not_found_handling).toBe('single-page-application');
  });

  it('/.well-known/* is in it, so the policy path reaches the Worker and not an asset', () => {
    expect(assets().run_worker_first).toContain('/.well-known/*');
  });
});

describe('a policy host serves the policy path and 404s every other path that reaches the Worker', () => {
  async function setup() {
    const w = await mtaWorld();
    w.db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, workspace_id, mode, mx_hosts, policy_id, state) VALUES (1, ?, 'testing', 'mx.a-corp.com', 'p1', 'active')").run(w.A.ws);
    const assets = vi.fn(async () => new Response('<html>the dashboard</html>', { headers: { 'Content-Type': 'text/html' } }));
    const env = { ...w.env, ASSETS: { fetch: assets } } as any;
    const get = (host: string, path: string, method = 'GET') => worker.fetch(new Request(`https://${host}${path}`, { method }), env, ctx);
    return { w, assets, get };
  }

  it('the policy answers 200 text/plain, never cached, and HEAD has no body', async () => {
    const { get, assets } = await setup();
    const res = await get('mta-sts.a-corp.com', '/.well-known/mta-sts.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('version: STSv1\nmode: testing\nmx: mx.a-corp.com\nmax_age: 86400\n');
    const head = await get('mta-sts.a-corp.com', '/.well-known/mta-sts.txt', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(assets).not.toHaveBeenCalled();
  });

  it.each(['/', '/nope', '/assets/index-abc123.js', '/index.html', '/api/domains', '/health', '/.well-known/other', '/.well-known/mta-sts.txt/', '/.well-known/mta-sts.txt.bak', '/llms.txt', '/oauth/token'])('%s is a 404 and the assets binding is never asked', async (path) => {
    const { get, assets } = await setup();
    const res = await get('mta-sts.a-corp.com', path);
    expect(res.status, path).toBe(404);
    expect(await res.text()).not.toContain('dashboard');
    expect(assets).not.toHaveBeenCalled();
  });

  it('only GET and HEAD answer, and an unknown or unproven domain is a 404 too', async () => {
    const { get, assets } = await setup();
    expect((await get('mta-sts.a-corp.com', '/.well-known/mta-sts.txt', 'POST')).status).toBe(404);
    expect((await get('mta-sts.a-corp.com', '/.well-known/mta-sts.txt', 'PUT')).status).toBe(404);
    expect((await get('mta-sts.nobody.example', '/.well-known/mta-sts.txt')).status).toBe(404);
    expect(assets).not.toHaveBeenCalled();
  });

  it('the dashboard on its own host is unchanged: its assets are still served', async () => {
    const { get, assets } = await setup();
    const res = await get('app.example.com', '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('dashboard');
    expect(assets).toHaveBeenCalledTimes(1);
  });
});
