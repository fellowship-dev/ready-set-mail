// A refresh token is used once, with a 30-second grace window (ADR 0022, src/mcp/refresh-replay.ts). The OAuth library is replaced by a small copy of how it
// rotates (the previous token stays valid for one more use; the grant record keeps the hash of the current and the previous token), so each case can be
// timed and made to fail. The same rule against the real library, in workerd, is in identity-and-replay.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { handleRefreshToken, purgeOldRotations, REFRESH_GRACE_MS, REFRESH_TOKEN_TTL_SECONDS } from '../../src/mcp/refresh-replay';
import { makeEnv, type TestDb } from '../auth/helpers';
import { addConnection } from './fixtures';

const sha = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(b => b.toString(16).padStart(2, '0')).join('');
const GRANT = 'grant:u1:g1';
const T0 = Date.UTC(2026, 10, 16, 12);

async function world() {
 const store = new Map<string, string>();
 const kv = { get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null), delete: async (k: string) => { store.delete(k); } };
 const env = makeEnv(undefined, { OAUTH_KV: kv }) as never as Parameters<typeof handleRefreshToken>[1];
 const sqlite = (env.DB as unknown as TestDb).sqlite;
 addConnection(sqlite, { principalId: 'p1', clientId: 'app1', userId: 'u1' });
 const tokens = [`u1:g1:secret0`];
 store.set(GRANT, JSON.stringify({ refreshTokenId: await sha(tokens[0]!), metadata: { principalId: 'p1' } }));
 const pending: Promise<unknown>[] = [];
 const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
 const api = { revokeGrant: vi.fn(async () => { store.delete(GRANT); }) };
 const library = { rotations: 0, delayMs: 0, fail: null as null | 'status' | 'throw' };
 // How the library rotates: the presented token must be the current or the previous one; the previous one becomes the one before, the new one the current.
 const forward = async (request: Request) => {
  const presented = (await request.clone().formData()).get('refresh_token') as string;
  library.rotations++;
  if (library.delayMs) await new Promise(r => setTimeout(r, library.delayMs));
  if (library.fail === 'throw') throw new Error('storage unavailable');
  if (library.fail === 'status') return Response.json({ error: 'server_error' }, { status: 500 });
  const grant = JSON.parse(store.get(GRANT) ?? 'null');
  const hash = await sha(presented);
  if (!grant || (grant.refreshTokenId !== hash && grant.previousRefreshTokenId !== hash)) return Response.json({ error: 'invalid_grant' }, { status: 400 });
  const next = `u1:g1:secret${tokens.length}`;
  tokens.push(next);
  store.set(GRANT, JSON.stringify({ ...grant, previousRefreshTokenId: hash, refreshTokenId: await sha(next) }));
  return Response.json({ access_token: `access${tokens.length - 1}`, token_type: 'bearer', expires_in: 900, refresh_token: next }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
 };
 const request = (token: string) => new Request('https://ia.example.com/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'app1', refresh_token: token }).toString() });
 let now = T0;
 const refresh = async (token: string) => (await handleRefreshToken(request(token), env, ctx, api, forward, { now: () => now }))!;
 const advance = (ms: number) => { now += ms; };
 const settle = () => Promise.allSettled(pending);
 const disabled = () => (sqlite.prepare("SELECT disabled_at AS d FROM access_principals WHERE id = 'p1'").get() as { d: number | null }).d !== null;
 const replayed = async () => { await settle(); return (sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'agent.refresh_token_replayed'").get() as { n: number }).n; };
 return { env, sqlite, store, tokens, api, library, refresh, request, advance, disabled, replayed, now: () => now };
}
type Body = { access_token: string; refresh_token: string; expires_in: number };

describe('parallel refreshes with the same token (two tool calls that both find the access token expired)', () => {
 it.each([2, 5, 20])('%i at the same moment all get the same new tokens, the library rotates once, and the connection stays', async (count) => {
  const w = await world();
  w.library.delayMs = 40;
  const answers = await Promise.all(Array.from({ length: count }, () => w.refresh(w.tokens[0]!)));
  expect(answers.map(a => a.status)).toEqual(Array(count).fill(200));
  const bodies = await Promise.all(answers.map(a => a.json() as Promise<Body>));
  expect(new Set(bodies.map(b => b.refresh_token)).size).toBe(1);
  expect(new Set(bodies.map(b => b.access_token)).size).toBe(1);
  expect(w.library.rotations).toBe(1);
  expect(w.disabled()).toBe(false);
  expect(w.api.revokeGrant).not.toHaveBeenCalled();
  // the connection lives on: the new token refreshes, and nothing was recorded as a leak
  w.library.delayMs = 0;
  expect((await w.refresh(bodies[0]!.refresh_token)).status).toBe(200);
  expect(await w.replayed()).toBe(0);
 });
});

describe('the same token again after the first use', () => {
 it('inside 30 seconds gets the same answer, not a second rotation; the access token is told how long it has left', async () => {
  const w = await world();
  const first = await (await w.refresh(w.tokens[0]!)).json() as Body;
  w.advance(12_000);
  const again = await w.refresh(w.tokens[0]!);
  expect(again.status).toBe(200);
  expect(again.headers.get('cache-control')).toBe('no-store');
  const body = await again.json() as Body;
  expect(body).toMatchObject({ access_token: first.access_token, refresh_token: first.refresh_token });
  expect(body.expires_in).toBe(900 - 12);
  expect(w.library.rotations).toBe(1);
  expect(w.disabled()).toBe(false);
 });

 it('at the end of the window still, one millisecond past it ends the connection: the grant, its tokens and the approval, audited', async () => {
  const w = await world();
  await w.refresh(w.tokens[0]!);
  w.advance(REFRESH_GRACE_MS);
  expect((await w.refresh(w.tokens[0]!)).status).toBe(200);
  w.advance(1);
  const late = await w.refresh(w.tokens[0]!);
  expect(late.status).toBe(400);
  expect(await late.json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') });
  expect(w.api.revokeGrant).toHaveBeenCalledWith('g1', 'u1');
  expect(w.disabled()).toBe(true);
  expect(await w.replayed()).toBe(1);
 });

 it('a token two rotations back ends the connection even inside the window (a stolen old copy)', async () => {
  const w = await world();
  const second = await (await w.refresh(w.tokens[0]!)).json() as Body;
  w.advance(1000);
  const third = await (await w.refresh(second.refresh_token)).json() as Body;
  expect(third.refresh_token).not.toBe(second.refresh_token);
  w.advance(1000);
  const stolen = await w.refresh(w.tokens[0]!);
  expect(stolen.status).toBe(400);
  expect(w.disabled()).toBe(true);
  expect(await w.replayed()).toBe(1);
  // and nothing newer works any more
  expect(w.store.has(GRANT)).toBe(false);
 });

 it('the previous token, once the current one has been used in turn, is two back and ends it', async () => {
  const w = await world();
  const b1 = await (await w.refresh(w.tokens[0]!)).json() as Body;
  const b2 = await (await w.refresh(b1.refresh_token)).json() as Body;
  expect(b2.refresh_token).not.toBe(b1.refresh_token);
  expect((await w.refresh(b1.refresh_token)).status).toBe(200); // the previous one, inside its window: the answer it got
  expect((await w.refresh(w.tokens[0]!)).status).toBe(400); // two back
  expect(w.disabled()).toBe(true);
 });
});

describe('a refresh that fails is never taken for a leak', () => {
 it.each(['status', 'throw'] as const)('when the request that holds the rotation fails (%s), the others get a retryable answer, nothing ends, and a retry rotates', async (how) => {
  const w = await world();
  w.library.delayMs = 40;
  w.library.fail = how;
  const results = await Promise.allSettled([w.refresh(w.tokens[0]!), w.refresh(w.tokens[0]!), w.refresh(w.tokens[0]!)]);
  const statuses = results.map(r => (r.status === 'fulfilled' ? r.value.status : 'threw'));
  expect(statuses.filter(s => s === 503)).toHaveLength(2);
  expect(statuses.filter(s => s === 500 || s === 'threw')).toHaveLength(1);
  const waited = results.find(r => r.status === 'fulfilled' && r.value.status === 503) as PromiseFulfilledResult<Response>;
  expect(waited.value.headers.get('retry-after')).toBe('1');
  expect(await waited.value.json()).toMatchObject({ error: 'temporarily_unavailable' });
  expect(w.disabled()).toBe(false);
  expect(w.api.revokeGrant).not.toHaveBeenCalled();
  w.library.fail = null; w.library.delayMs = 0;
  expect((await w.refresh(w.tokens[0]!)).status).toBe(200);
  expect(await w.replayed()).toBe(0);
 });

 it('a claim whose request died is taken over after 10 seconds, but not before', async () => {
  const w = await world();
  w.sqlite.prepare("INSERT INTO refresh_rotations(token_hash, grant_key, first_used_at, state) VALUES (?, ?, ?, 'pending')").run(await sha(w.tokens[0]!), GRANT, w.now());
  // a live claim: the request waits for its answer, then says to try again (nothing is rotated twice, nothing ends)
  const sleeps: number[] = [];
  const waiting = await handleRefreshToken(w.request(w.tokens[0]!), w.env, { waitUntil() {} } as never, w.api, async () => { throw new Error('must not rotate'); }, { now: () => w.now(), sleep: async ms => { sleeps.push(ms); } });
  expect(waiting!.status).toBe(503);
  expect(sleeps.length).toBeGreaterThan(10);
  expect(w.disabled()).toBe(false);
  w.advance(10_001);
  expect((await w.refresh(w.tokens[0]!)).status).toBe(200);
  expect(w.library.rotations).toBe(1);
 });
});

describe('what is stored', () => {
 it('is a row per used token keyed by its hash, with the answer sealed under the token: the tokens appear nowhere in it, and another token cannot open it', async () => {
  const w = await world();
  const body = await (await w.refresh(w.tokens[0]!)).json() as Body;
  const rows = w.sqlite.prepare('SELECT * FROM refresh_rotations').all() as Array<{ token_hash: string; grant_key: string; state: string; response: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ token_hash: await sha(w.tokens[0]!), grant_key: GRANT, state: 'done' });
  const dump = JSON.stringify(rows);
  for (const secret of [w.tokens[0]!, body.refresh_token, body.access_token, 'access_token']) expect(dump).not.toContain(secret);
  // a row copied under another token's hash does not open with that token
  w.sqlite.prepare('UPDATE refresh_rotations SET token_hash = ? WHERE token_hash = ?').run(await sha(body.refresh_token), await sha(w.tokens[0]!));
  const grant = JSON.parse(w.store.get(GRANT)!);
  w.store.set(GRANT, JSON.stringify({ ...grant, previousRefreshTokenId: await sha(body.refresh_token), refreshTokenId: 'other' }));
  const opened = await w.refresh(body.refresh_token);
  expect(opened.status).toBe(400);
 });

 it('a request that is not a refresh of a known grant is left to the library', async () => {
  const w = await world();
  const plain = new Request('https://ia.example.com/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&code=x' });
  expect(await handleRefreshToken(plain, w.env, { waitUntil() {} } as never, w.api, async () => new Response('x'))).toBeNull();
  expect(await handleRefreshToken(w.request('u1:gX:nonsense'), w.env, { waitUntil() {} } as never, w.api, async () => new Response('x'))).toBeNull();
  expect(await handleRefreshToken(w.request('u1:g1:never-issued'), w.env, { waitUntil() {} } as never, w.api, async () => new Response('x'))).toBeNull();
  expect(w.sqlite.prepare('SELECT COUNT(*) AS n FROM refresh_rotations').get()).toEqual({ n: 0 });
 });

 it('the daily clean-up deletes rows older than a refresh token lives and keeps the rest, in bounded batches', async () => {
  const w = await world();
  const insert = w.sqlite.prepare("INSERT INTO refresh_rotations(token_hash, grant_key, first_used_at, state, response) VALUES (?, ?, ?, 'done', 'x')");
  const old = T0 - REFRESH_TOKEN_TTL_SECONDS * 1000 - 1000, fresh = T0 - REFRESH_TOKEN_TTL_SECONDS * 1000 + 60_000;
  for (let i = 0; i < 1200; i++) insert.run(`old${i}`, GRANT, old);
  for (let i = 0; i < 5; i++) insert.run(`fresh${i}`, GRANT, fresh);
  expect(await purgeOldRotations(w.env, T0)).toBe(1200);
  expect(w.sqlite.prepare('SELECT COUNT(*) AS n FROM refresh_rotations').get()).toEqual({ n: 5 });
 });
});
