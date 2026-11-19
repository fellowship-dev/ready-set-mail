// SPF flattening, the Worker half of the one engine (the pure half is packages/dns-checks/src/spf-flatten.ts).
// Every path that turns flattening on or off, refreshes a record or puts one back goes through here: the routes, the daily job and "Try again".
//
// The rules, in the order they matter:
//  - The ORIGINAL record (`canonical_record`, as the owner had it before the first write) is the one source. Every run resolves from it, never from
//    the record published now (which, once flattened, has no includes left to follow). It is set when flattening is turned on and never rewritten.
//  - A write follows a read: if the record in Cloudflare is not the value written last, someone changed it outside the app; nothing is written, the problem is
//    recorded with its one action. Nothing is ever overwritten blindly, and turning off does not write over an outside edit either.
//  - Nothing is written when the resolved record equals the published one (order, case and spacing aside), so a quiet day changes nothing and logs nothing.
//  - A resolution that fails keeps the last good record, records the problem and says it in one sentence; it never writes a smaller record.
//  - Two runs at once, or a run during turning off, never write twice or bring a turned-off row back: a run claims the row (compare-and-set on `revision`),
//    writes, then finishes only if the claim still holds; if it does not, it puts back the value it replaced.

import { flattenFromSource, sameSpfRecord, type SpfFlat, type SpfProblem, type SpfProviderEntries, type Resolver } from '@ready-set-mail/dns-checks';
import type { SpfConfigRow, SpfPatch } from '@ready-set-mail/db';
import { logAudit } from '../audit/log';
import { resolverFor } from '../dns/resolver';
import { capability } from '../hosted/plan-limits';
import { spfRefreshed } from '../product-analytics/steps';
import type { TenantContext } from '../tenancy/context';
import { mapLimit } from '../util/map-limit';
import { cloudflareTarget, connectionText, isConnectionFailure, isConnectionRevoked, type SpfLive, type SpfTarget } from './target';
import type { SpfProblemKind, SpfRefreshEvent } from './events';

/** A run holds a row for this long; a crashed run does not block the row longer. */
export const SPF_LEASE_SECONDS = 120;
/** A row is due when it was last looked at this long ago: a second trigger on the same day (an older install keeps `0 10`) finds nothing due. */
export const SPF_DUE_AFTER_SECONDS = 20 * 3600;
/** Domains one workspace refreshes in one run, and all workspaces together (docs/spf-flattening.md: the subrequest numbers). */
export const SPF_REFRESH_MAX_PER_WORKSPACE = 20;
export const SPF_REFRESH_MAX_PER_RUN = 100;
/** Subrequests the refresh may spend in one invocation. A domain costs its DNS reads plus about four Cloudflare calls (zone, list, write, read-back). */
export const SPF_REFRESH_MAX_SUBREQUESTS = 4000;
export const SPF_CLOUDFLARE_CALLS_PER_DOMAIN = 4;
export const SPF_REFRESH_CONCURRENCY = 5;
/** The dashboard says "the daily check has not run" when the last successful check is older than this. */
export const SPF_STALE_SECONDS = 2 * 86400;
/**
 * A removal is confirmed by a later check at least this long after the first sighting (docs/adr/0028). Basis: provider TTLs measured from their
 * authoritative servers on 2026-11-16 (dig TXT): _spf.google.com 300 s, spf.brevo.com 300 s, _spf.mlsend.com 300 s, spf.protection.outlook.com 600 s,
 * servers.mcsv.net 600 s, mailgun.org 900 s, amazonses.com 900 s, sendgrid.net 1,800 s, _spf.salesforce.com 3,600 s, mail.zendesk.com 3,600 s,
 * spf.mandrillapp.com 14,400 s (the longest). Four hours is at least the longest, so the second look is a fresh answer from the provider, not a cached copy of the first.
 */
export const SPF_PENDING_CONFIRM_SECONDS = 4 * 3600;

export interface SpfBudget { domains: number; subrequests: number }
export const newSpfBudget = (): SpfBudget => ({ domains: SPF_REFRESH_MAX_PER_RUN, subrequests: SPF_REFRESH_MAX_SUBREQUESTS });

type Ctx = Pick<ExecutionContext, 'waitUntil'> | undefined;
export interface SpfActor { id?: string | null; email?: string | null }
export interface SpfDeps {
  resolver?: Resolver;
  /** Milliseconds. */
  now?: () => number;
  /** Tests, and the hosted-records path: where the record lives. Default: the domain's apex in the customer's Cloudflare zone. */
  target?: SpfTarget;
  ctx?: Ctx;
  onEvent?: (e: SpfRefreshEvent) => void | Promise<void>;
  actor?: SpfActor;
}

const nowS = (d: SpfDeps) => Math.floor((d.now?.() ?? Date.now()) / 1000);

// ── Problems, in the sentences the owner reads ──────────────

const UNCHANGED = ' Your record in Cloudflare is unchanged.';
/** One sentence per problem. The engine's own sentences are kept; ours say what was left alone. */
export function problemSentence(p: { kind: SpfProblemKind; domain?: string | null; message?: string }): string {
  switch (p.kind) {
    case 'connection_lost': return `We could not reach Cloudflare.${UNCHANGED}`;
    case 'edited_outside': return 'The SPF record in Cloudflare is not the one Ready Set Mail published, so someone changed it there. We have left it as it is.';
    case 'record_missing': return `There is no SPF record at ${p.domain ?? 'your domain'} in Cloudflare now. We have not added one.`;
    case 'restore_failed': return 'We could not put your original record back in Cloudflare.';
    case 'too_large': return p.message ?? `The addresses behind your includes do not fit in one SPF record.${UNCHANGED}`;
    default: return `${p.message ?? 'We could not read your includes.'}${UNCHANGED}`;
  }
}

export interface SpfProblemOut { kind: SpfProblemKind; message: string }
const refusal = (p: SpfProblem): SpfProblemOut => ({ kind: p.kind, message: problemSentence({ kind: p.kind, domain: p.domain, message: p.message }) });

// ── The view the API returns (never the raw row) ────────────

export interface SpfView {
  enabled: boolean;
  /** The original record, as the owner had it. */
  original_record: string;
  flattened_record: string | null;
  /** The flattened record before the last change. */
  previous_record: string | null;
  ip_count: number | null;
  /** Lookups the original needs, and the flattened record needs. */
  lookups_before: number | null;
  lookups_after: number | null;
  last_changed_at: number | null;
  last_refreshed_at: number | null;
  problem: { kind: SpfProblemKind; message: string | null; since: number | null } | null;
  /** A removal that is waiting for a second look (ADR 0028); null when none is. */
  pending: SpfPendingView | null;
}

export interface SpfPendingView {
  /** The addresses (and lookup terms) that left a provider and are still in the record, by provider (the include). */
  removed: SpfProviderEntries;
  /** The providers, for a sentence. */
  providers: string[];
  since: number;
  /** The earliest time a check confirms the removal (unix seconds). */
  confirm_after: number;
  /** The record was written with the additions (and the held addresses); false: both together do not fit, so nothing was written. */
  additions_written: boolean;
}

export const parseEntries = (json: string | null | undefined): SpfProviderEntries => {
  if (!json) return {};
  try { const v = JSON.parse(json) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? (v as SpfProviderEntries) : {}; } catch { return {}; }
};
const entriesJson = (e: SpfProviderEntries): string => JSON.stringify(Object.fromEntries(Object.entries(e).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, [...v].sort()])));
const sameRemoval = (a: SpfProviderEntries, b: SpfProviderEntries): boolean => entriesJson(a) === entriesJson(b);

/** "14:32 UTC", with the day when it is not today. */
export function utcTime(at: number, now: number): string {
  const d = new Date(at * 1000).toISOString();
  const day = new Date(now * 1000).toISOString().slice(0, 10) === d.slice(0, 10) ? '' : ` on ${Number(d.slice(8, 10))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.slice(5, 7)) - 1]}`;
  return `${d.slice(11, 16)} UTC${day}`;
}

/** The one sentence about a removal that is waiting: what we kept and when it can be confirmed. */
export function pendingSentence(p: SpfPendingView, now: number): string {
  const n = Object.values(p.removed).reduce((a, v) => a + v.length, 0);
  const names = p.providers.join(', ');
  return `${names} no longer lists ${n === 1 ? '1 address' : `${n} addresses`}. We are keeping ${n === 1 ? 'it' : 'them'} in your record until a second check agrees, which can happen after ${utcTime(p.confirm_after, now)}.${p.additions_written ? '' : ' New addresses wait too: both together would not fit in one record.'}`;
}

/** Flattening is on: the record was written. (A row whose first write never happened is a turn-on that failed; it is not on.) */
export const spfIsOn = (row: Pick<SpfConfigRow, 'enabled' | 'flattened_record'> | null): boolean => !!row && row.enabled === 1 && row.flattened_record !== null;

export function spfPending(row: Pick<SpfConfigRow, 'pending_removed' | 'pending_since' | 'pending_additions'>): SpfPendingView | null {
  if (!row.pending_removed || row.pending_since === null) return null;
  const removed = parseEntries(row.pending_removed);
  return { removed, providers: Object.keys(removed).sort(), since: row.pending_since, confirm_after: row.pending_since + SPF_PENDING_CONFIRM_SECONDS, additions_written: row.pending_additions === 1 };
}

export function spfView(row: SpfConfigRow): SpfView {
  return {
    enabled: spfIsOn(row),
    original_record: row.canonical_record,
    flattened_record: row.flattened_record,
    previous_record: row.previous_record,
    ip_count: row.ip_count,
    lookups_before: row.lookup_count,
    lookups_after: row.lookups_after,
    last_changed_at: row.last_flattened_at,
    last_refreshed_at: row.last_refreshed_at,
    problem: row.problem_kind ? { kind: row.problem_kind as SpfProblemKind, message: row.last_error, since: row.problem_since } : null,
    pending: spfPending(row),
  };
}

// ── Preview ─────────────────────────────────────────────────

export interface SpfPreview {
  /** The record being flattened: the stored original if flattening is on, otherwise what the domain publishes now. */
  original: string | null;
  /** Null when it could not be flattened; then `problem` says why. */
  flat: SpfFlat | null;
  problem: SpfProblemOut | null;
  /** The original needs at most 10 lookups and fits 450 bytes: flattening is not needed. */
  within_limits: boolean;
  /** Flattening is on: the record in Cloudflare right now (for the review after an outside edit); null when it could not be read. */
  live: string | null;
}

export async function previewSpf(tenant: TenantContext, domain: { id: number; domain: string }, deps: SpfDeps = {}): Promise<SpfPreview> {
  const resolver = deps.resolver ?? resolverFor(tenant.env);
  const row = await tenant.scope.spf.get(domain.id);
  let original = row?.canonical_record ?? null;
  if (!original) {
    const txt = await resolver.txt(domain.domain);
    if (txt.status === 'error' || txt.truncated) return { original: null, flat: null, problem: { kind: 'include_unresolved', message: `We could not read the SPF record of ${domain.domain} (${txt.error ?? 'the answer was cut short'}).` }, within_limits: false, live: null };
    const spf = txt.records.filter(r => /^v=spf1(\s|$)/i.test(r.trim()));
    original = spf.length === 1 ? spf[0]!.trim() : null;
    if (spf.length > 1) return { original: null, flat: null, problem: { kind: 'include_unresolved', message: `${domain.domain} publishes more than one SPF record, so there is nothing to flatten yet.` }, within_limits: false, live: null };
  }
  if (!original) return { original: null, flat: null, problem: null, within_limits: false, live: null };
  const asWritten = await flattenFromSource(domain.domain, original, resolver, { inline: 'most', maxBytes: Number.MAX_SAFE_INTEGER, maxLookups: Number.MAX_SAFE_INTEGER });
  const within = asWritten.ok && asWritten.flat.lookupsBefore <= 10 && new TextEncoder().encode(original).length <= 450;
  const res = await flattenFromSource(domain.domain, original, resolver, { inline: within ? 'most' : 'fewest' });
  let live: string | null = null;
  if (row && row.flattened_record !== null) { // also a stopped row: what Cloudflare holds now, when it can be read
    try { const r = await (deps.target ?? cloudflareTarget(tenant, domain.domain)).read(); live = 'found' in r && r.found ? r.content : null; } catch { live = null; }
  }
  return { original, flat: res.ok ? res.flat : null, problem: res.ok ? null : refusal(res.problems[0]!), within_limits: within, live };
}

// ── Turning on ──────────────────────────────────────────────

export type EnableResult =
  | { ok: true; config: SpfConfigRow }
  | { ok: false; refused: SpfProblemOut }
  | { ok: false; conflict: 'already_on' | 'finish_turning_off' };

export async function enableSpf(tenant: TenantContext, domain: { id: number; domain: string }, opts: { anyway?: boolean } = {}, deps: SpfDeps = {}): Promise<EnableResult> {
  const q = tenant.scope.spf;
  const target = deps.target ?? cloudflareTarget(tenant, domain.domain);
  const at = nowS(deps);
  let live: SpfLive;
  try { live = await target.read(); } catch (e) { return connectionRefused(e); }
  if ('multiple' in live) return { ok: false, refused: { kind: 'edited_outside', message: `${domain.domain} has more than one SPF record in Cloudflare. Remove the extra one first.` } };
  if (!live.found) return { ok: false, refused: { kind: 'record_missing', message: `There is no SPF record at ${domain.domain} in Cloudflare. Add one in the SPF step first.` } };

  // A row that is already there is either on (nothing to do) or a turn-off that could not put the original back.
  const existing = await q.get(domain.id);
  if (existing && spfIsOn(existing)) return { ok: false, conflict: 'already_on' };
  if (existing) {
    // enabled=0 with a record written: a turn-off that could not put the original back. A row that never wrote anything is a failed turn-on: no trace of it matters.
    if (existing.flattened_record !== null && sameSpfRecord(live.content, existing.flattened_record)) return { ok: false, conflict: 'finish_turning_off' };
    await q.delete(domain.id); // the owner put the original back by hand: that record is the original now
  }

  // The original is what is in Cloudflare now: never a record this product wrote (the case above refuses that).
  const original = live.content;
  const resolver = deps.resolver ?? resolverFor(tenant.env);
  const res = await flattenFromSource(domain.domain, original, resolver, { inline: opts.anyway ? 'most' : 'fewest' });
  if (!res.ok) return { ok: false, refused: refusal(res.problems[0]!) };
  const flat = res.flat;

  if (!(await q.begin({ domain_id: domain.id, canonical_record: original, lookup_count: flat.lookupsBefore, cf_record_id: live.id, inline_mode: opts.anyway ? 'most' : 'fewest' }))) return { ok: false, conflict: 'already_on' };
  try {
    await target.write(live.id, flat.record);
    const back = await target.read();
    if (!('found' in back && back.found) || !sameSpfRecord(back.content, flat.record)) throw new NotKept();
  } catch (e) {
    await putBack(target, live.id, original);
    await q.abandon(domain.id);
    if (e instanceof NotKept) return { ok: false, refused: { kind: 'connection_lost', message: `Cloudflare did not keep the record we wrote.${UNCHANGED}` } };
    return connectionRefused(e);
  }
  if (!(await q.activate(domain.id, flat.record, flat.ipCount, flat.lookupsAfter, at, entriesJson(flat.providers)))) {
    await putBack(target, live.id, original); // someone else got to the row between our two steps
    return { ok: false, conflict: 'already_on' };
  }
  const row = (await q.get(domain.id))!;
  audit(tenant, deps, 'spf_flatten.enable', domain, { spf_record: original }, { spf_record: flat.record, ip_count: flat.ipCount, lookups: flat.lookupsAfter }, deps.actor ? { by: 'user' } : undefined);
  audit(tenant, deps, 'dns.update', domain, { content: original }, { content: flat.record }, undefined, { type: 'dns_record', id: live.id, name: `TXT ${domain.domain}` });
  return { ok: true, config: row };
}

class NotKept extends Error {}
function connectionRefused(e: unknown): { ok: false; refused: SpfProblemOut } {
  if (!isConnectionFailure(e)) throw e;
  return { ok: false, refused: { kind: 'connection_lost', message: `${problemSentence({ kind: 'connection_lost' })} (${connectionText(e)})` } };
}
/**
 * Our write landed but the claim was lost meanwhile. If flattening was turned off (the row is gone or not on) the owner's original is what belongs in Cloudflare;
 * otherwise something else changed the row and the value we replaced goes back.
 */
async function undoLostClaim(tenant: TenantContext, row: SpfConfigRow, target: SpfTarget, live: { id: string; content: string }): Promise<void> {
  const now = await tenant.scope.spf.get(row.domain_id);
  await putBack(target, live.id, !now || now.enabled !== 1 ? row.canonical_record : live.content);
}

/** Best effort: write `content` back and say whether Cloudflare holds it. */
async function putBack(target: SpfTarget, id: string, content: string): Promise<boolean> {
  try {
    await target.write(id, content);
    const r = await target.read();
    return 'found' in r && r.found && sameSpfRecord(r.content, content);
  } catch { return false; }
}

// ── The rule: what may be published (ADR 0028) ──────────────

export interface SpfPlan { record: string; ipCount: number; lookups: number; providers: SpfProviderEntries }
export type SpfWriteHow = 'none' | 'first' | 'replaced' | 'waiting' | 'confirmed' | 'cleared';
export interface SpfWriteDecision {
  /** What to have published, or null: nothing may be written (a removal waits and the held record does not fit). */
  plan: SpfPlan | null;
  /** The removal that is waiting after this run, or null. */
  pending: { removed: SpfProviderEntries; since: number; additions: boolean } | null;
  how: SpfWriteHow;
}

/**
 * A refresh never removes an authorised address on its first sighting (docs/adr/0028). Additions are always safe. A removal waits: the record gets the new
 * addresses AND the ones that left, and the removal is written only when a later check, at least SPF_PENDING_CONFIRM_SECONDS after the first, sees the same removal.
 * `state` is what the last run stored (the customer's refresh in spf_flatten_config, a hosted record's in hosted_domains.spf_state); `flat` was made with `previous`.
 */
export function decideSpfWrite(state: { pending_removed: string | null; pending_since: number | null }, flat: SpfFlat, at: number): SpfWriteDecision {
  const removed = flat.removed;
  const waiting = parseEntries(state.pending_removed);
  const hadPending = state.pending_since !== null && Object.keys(waiting).length > 0;
  const full: SpfPlan = { record: flat.record, ipCount: flat.ipCount, lookups: flat.lookupsAfter, providers: flat.providers };
  if (Object.keys(removed).length === 0) return { plan: full, pending: null, how: hadPending ? 'cleared' : 'none' }; // nothing leaves (or the provider came back)
  if (hadPending && sameRemoval(waiting, removed) && at >= state.pending_since! + SPF_PENDING_CONFIRM_SECONDS) return { plan: full, pending: null, how: 'confirmed' };
  const held = flat.held!;
  const same = hadPending && sameRemoval(waiting, removed);
  return {
    plan: held.fits ? { record: held.record, ipCount: held.ipCount, lookups: held.lookups, providers: held.providers } : null,
    pending: { removed, since: same ? state.pending_since! : at, additions: held.fits },
    how: same ? 'waiting' : hadPending ? 'replaced' : 'first',
  };
}

/** A hosted record keeps the same state in one JSON column (hosted_domains.spf_state), read and written with the same rule. */
export function loadSpfState(json: string | null | undefined): { provider_state: string | null; pending_removed: string | null; pending_since: number | null } {
  try {
    const v = json ? (JSON.parse(json) as { provider_state?: SpfProviderEntries; pending_removed?: SpfProviderEntries | null; pending_since?: number | null }) : {};
    return { provider_state: v.provider_state ? entriesJson(v.provider_state) : null, pending_removed: v.pending_removed ? entriesJson(v.pending_removed) : null, pending_since: typeof v.pending_since === 'number' ? v.pending_since : null };
  } catch { return { provider_state: null, pending_removed: null, pending_since: null }; }
}
export function spfStateJson(providers: SpfProviderEntries, pending: SpfWriteDecision['pending']): string {
  return JSON.stringify({ provider_state: providers, pending_removed: pending?.removed ?? null, pending_since: pending?.since ?? null, pending_additions: pending ? (pending.additions ? 1 : 0) : null });
}

/** The audit entries of a removal that starts, is replaced or clears (ADR 0028): the one place they are written, for the daily refresh and for adopting an edit. */
function auditPending(
  tenant: TenantContext, deps: SpfDeps, domain: { id: number; domain: string }, how: SpfWriteHow, pending: SpfWriteDecision['pending'], waiting: SpfProviderEntries,
  row: Pick<SpfConfigRow, 'pending_since'>, at: number, by: Record<string, unknown>,
): void {
  if (how === 'first' || how === 'replaced') {
    audit(tenant, deps, 'spf_flatten.pending', domain, how === 'replaced' ? { removed: waiting, since: row.pending_since } : undefined,
      { removed: pending!.removed, additions_written: pending!.additions, confirm_after: at + SPF_PENDING_CONFIRM_SECONDS }, { ...by, ...(how === 'replaced' ? { replaced: true } : {}) });
  } else if (how === 'cleared') {
    audit(tenant, deps, 'spf_flatten.pending_cleared', domain, { removed: waiting, since: row.pending_since }, undefined, { ...by, waited_seconds: at - row.pending_since! });
  }
}

// ── The refresh ─────────────────────────────────────────────

/** `pending`: nothing was written and a removal is waiting for its second look (ADR 0028). A write that kept a removal waiting is `changed`. */
export type RefreshOutcome = 'unchanged' | 'changed' | 'pending' | 'problem' | 'skipped';

/**
 * One domain, once. `manual`: a person pressed "Try again" (the audit entry says so). Never throws for a Cloudflare or DNS failure: that is a problem
 * state. Returns how many DNS reads it made (for the invocation's budget).
 */
export async function refreshSpf(tenant: TenantContext, row: SpfConfigRow, deps: SpfDeps & { manual?: boolean; /** The owner chose to replace a record that was changed outside (Review → Replace). */ takeOver?: boolean } = {}): Promise<{ outcome: RefreshOutcome; fetches: number }> {
  const q = tenant.scope.spf;
  const at = nowS(deps);
  const claimed = await q.claim(row.domain_id, row.revision, at, SPF_LEASE_SECONDS);
  if (claimed === null) return { outcome: 'skipped', fetches: 0 };
  const domain = await tenant.scope.domains.getById(row.domain_id);
  if (!domain) { await q.finish(row.domain_id, claimed, {}); return { outcome: 'skipped', fetches: 0 }; }
  const target = deps.target ?? cloudflareTarget(tenant, domain.domain);
  let fetches = 0;

  const sameKind = row.problem_kind;
  const fail = async (kind: SpfProblemKind, message: string): Promise<{ outcome: RefreshOutcome; fetches: number }> => {
    const first = sameKind !== kind;
    const since = first ? at : (row.problem_since ?? at);
    const ok = await q.finish(row.domain_id, claimed, { problem_kind: kind, problem_since: since, last_error: message, last_error_at: at });
    if (!ok) return { outcome: 'skipped', fetches };
    if (first) audit(tenant, deps, 'spf_flatten.problem', domain, undefined, { problem: kind, message }, { by: deps.manual ? 'try_again' : 'job' });
    await emit(deps, tenant, { type: 'spf.problem', workspaceId: tenant.workspaceId, domainId: domain.id, domain: domain.domain, at, problem: kind, since, first });
    return { outcome: 'problem', fetches };
  };

  // The connection was revoked: nothing can be written any more. Flattening stops (no refresh, no retry every day); the original stays with the row.
  const stopAfterRevocation = async (): Promise<{ outcome: RefreshOutcome; fetches: number }> => {
    await q.finish(row.domain_id, claimed, {});
    await stopSpf(tenant, domain, 'connection_revoked', deps);
    return { outcome: 'problem', fetches };
  };

  // 1. What is in Cloudflare now?
  let live: SpfLive;
  try { live = await target.read(); } catch (e) {
    if (!isConnectionFailure(e)) { await q.finish(row.domain_id, claimed, {}); throw e; }
    if (isConnectionRevoked(e)) return stopAfterRevocation();
    return fail('connection_lost', `${problemSentence({ kind: 'connection_lost' })} (${connectionText(e)})`);
  }
  if ('multiple' in live) return fail('edited_outside', problemSentence({ kind: 'edited_outside' }));
  if (!live.found) return fail('record_missing', problemSentence({ kind: 'record_missing', domain: domain.domain }));
  const edited = !sameSpfRecord(live.content, row.flattened_record);
  if (edited && !deps.takeOver) return fail('edited_outside', problemSentence({ kind: 'edited_outside' }));

  // 2. Resolve from the stored original, knowing what the published record authorises per provider.
  const res = await flattenFromSource(domain.domain, row.canonical_record, deps.resolver ?? resolverFor(tenant.env), { inline: row.inline_mode === 'most' ? 'most' : 'fewest', previous: parseEntries(row.provider_state) });
  fetches = res.ok ? res.flat.fetches : res.fetches;
  if (!res.ok) return { ...(await fail(res.problems[0]!.kind, problemSentence({ kind: res.problems[0]!.kind, domain: res.problems[0]!.domain, message: res.problems[0]!.message }))), fetches };
  const flat = res.flat;

  // 3. What may be published (ADR 0028): the one rule, decideSpfWrite.
  const { plan, pending, how } = decideSpfWrite(row, flat, at);
  const waiting = parseEntries(row.pending_removed);
  if (edited && !plan) return { ...(await fail('edited_outside', problemSentence({ kind: 'edited_outside' }))), fetches }; // Replace needs a record that fits

  const recovered = row.problem_kind !== null;
  const settle = {
    last_refreshed_at: at, problem_kind: null, problem_since: null, last_error: null, last_error_at: null,
    pending_removed: pending ? entriesJson(pending.removed) : null, pending_since: pending ? pending.since : null, pending_additions: pending ? (pending.additions ? 1 : 0) : null,
    ...(plan ? { ip_count: plan.ipCount, lookups_after: plan.lookups, provider_state: entriesJson(plan.providers) } : {}),
  } satisfies SpfPatch;
  const by = { by: deps.manual ? 'try_again' : 'job' };
  const pendingAudits = () => auditPending(tenant, deps, domain, how, pending, waiting, row, at, by);

  // 4. Nothing new to publish (or nothing that may be published): touch nothing in DNS, log nothing but the pending state.
  if (!plan || (!edited && sameSpfRecord(plan.record, row.flattened_record))) {
    if (!(await q.finish(row.domain_id, claimed, settle))) return { outcome: 'skipped', fetches };
    pendingAudits();
    if (recovered) await emit(deps, tenant, { type: 'spf.recovered', workspaceId: tenant.workspaceId, domainId: domain.id, domain: domain.domain, at });
    return { outcome: pending ? 'pending' : 'unchanged', fetches };
  }

  // 5. Changed: still ours? write, read back, then finish; if the claim was lost meanwhile, put the old value back.
  if (!(await q.holds(row.domain_id, claimed))) return { outcome: 'skipped', fetches };
  try {
    await target.write(live.id, plan.record);
    const back = await target.read();
    if (!('found' in back && back.found) || !sameSpfRecord(back.content, plan.record)) throw new NotKept();
  } catch (e) {
    await putBack(target, live.id, live.content);
    if (e instanceof NotKept) return { ...(await fail('connection_lost', `Cloudflare did not keep the new record.${UNCHANGED}`)), fetches };
    if (!isConnectionFailure(e)) { await q.finish(row.domain_id, claimed, {}); throw e; }
    if (isConnectionRevoked(e)) return { ...(await stopAfterRevocation()), fetches };
    return { ...(await fail('connection_lost', `${problemSentence({ kind: 'connection_lost' })} (${connectionText(e)})`)), fetches };
  }
  const done = await q.finish(row.domain_id, claimed, { ...settle, flattened_record: plan.record, previous_record: edited ? live.content : row.flattened_record, last_flattened_at: at });
  if (!done) { await undoLostClaim(tenant, row, target, live); return { outcome: 'skipped', fetches }; }
  audit(tenant, deps, 'spf_flatten.update', domain, { spf_record: edited ? live.content : row.flattened_record }, { spf_record: plan.record, ip_count: plan.ipCount, lookups: plan.lookups },
    { by: deps.takeOver ? 'replace' : deps.manual ? 'try_again' : 'job', cron: deps.manual ? undefined : '0 11 * * *', ...(how === 'confirmed' ? { confirmed_after_seconds: at - row.pending_since! } : {}), ...(pending ? { removal_pending: true } : {}) });
  audit(tenant, deps, 'dns.update', domain, { content: edited ? live.content : row.flattened_record }, { content: plan.record }, undefined, { type: 'dns_record', id: live.id, name: `TXT ${domain.domain}` });
  pendingAudits();
  if (recovered) await emit(deps, tenant, { type: 'spf.recovered', workspaceId: tenant.workspaceId, domainId: domain.id, domain: domain.domain, at });
  await emit(deps, tenant, { type: 'spf.changed', workspaceId: tenant.workspaceId, domainId: domain.id, domain: domain.domain, at, ipCount: plan.ipCount });
  return { outcome: 'changed', fetches };
}

// ── Turning off ─────────────────────────────────────────────

export type DisableResult =
  | { ok: true; restored: boolean; why?: 'edited_outside' | 'record_missing' }
  | { ok: false; restoreFailed: string; original: string; flattened: string | null }
  | { ok: false; notConfigured: true };

/**
 * Stops every refresh at once, then puts the original record back: only when the record in Cloudflare is still the one we wrote. A record that was changed outside is
 * not written over (flattening just stops). If Cloudflare refuses the restore, the row stays (the original is not lost) with the problem `restore_failed`.
 */
export async function disableSpf(tenant: TenantContext, domain: { id: number; domain: string }, deps: SpfDeps = {}): Promise<DisableResult> {
  const q = tenant.scope.spf;
  if (!(await q.get(domain.id))) return { ok: false, notConfigured: true };
  await q.deactivate(domain.id); // from here no refresh can finish: it undoes its own write
  const row = (await q.get(domain.id))!; // read after, so a refresh that finished just before is seen
  const target = deps.target ?? cloudflareTarget(tenant, domain.domain);
  const at = nowS(deps);
  const done = async (restored: boolean, why?: 'edited_outside' | 'record_missing'): Promise<DisableResult> => {
    await q.delete(domain.id);
    audit(tenant, deps, 'spf_flatten.disable', domain, { spf_record: row.flattened_record ?? row.canonical_record }, { spf_record: restored ? row.canonical_record : null, ...(why ? { left_as_is: why } : {}) });
    return { ok: true, restored, ...(why ? { why } : {}) };
  };
  const failed = async (message: string): Promise<DisableResult> => {
    await q.setProblem(domain.id, { kind: 'restore_failed', since: row.problem_kind === 'restore_failed' ? row.problem_since : at, error: message, at });
    return { ok: false, restoreFailed: message, original: row.canonical_record, flattened: row.flattened_record };
  };

  let live: SpfLive;
  try { live = await target.read(); } catch (e) {
    if (!isConnectionFailure(e)) throw e;
    return failed(`${problemSentence({ kind: 'restore_failed' })} (${connectionText(e)})`);
  }
  if ('multiple' in live) return done(false, 'edited_outside');
  if (!live.found) return done(false, 'record_missing');
  if (sameSpfRecord(live.content, row.canonical_record)) return done(true); // already the original
  if (row.flattened_record === null) return done(true); // nothing was ever written
  if (!sameSpfRecord(live.content, row.flattened_record)) return done(false, 'edited_outside'); // changed outside: never written over

  try {
    await target.write(live.id, row.canonical_record);
    let back = await target.read();
    // A refresh that was already writing may land after ours: look once more, put the original back once more.
    if (!('found' in back && back.found && sameSpfRecord(back.content, row.canonical_record))) {
      await target.write(live.id, row.canonical_record);
      back = await target.read();
    }
    if (!('found' in back && back.found && sameSpfRecord(back.content, row.canonical_record))) return failed(`${problemSentence({ kind: 'restore_failed' })} Cloudflare did not keep it.`);
  } catch (e) {
    if (!isConnectionFailure(e)) throw e;
    return failed(`${problemSentence({ kind: 'restore_failed' })} (${connectionText(e)})`);
  }
  return done(true);
}

// ── When the domain, the workspace or the connection goes ────

/** The body of the 409 that stops a delete: the sentence, the record to copy, and what Cloudflare holds now. */
export interface SpfRestoreRefusal { error: string; /** Why, in one sentence, without the records. */ reason: string; code: 'spf_restore_failed'; domain: string; original: string; flattened_record: string | null; leave_param: 'leave_spf_record=1' }

/**
 * Before a domain (or the workspace that holds it) is deleted: put the owner's original record back. Deleting the row without this would leave the flattened
 * record in Cloudflare with nothing refreshing it and the original lost. Nothing to restore (no row, or the record was edited or deleted outside, which
 * disableSpf leaves alone): `ok`. The restore failed: the refusal says why and carries the original, so the owner can copy it first.
 */
export async function restoreSpfBeforeRemoval(tenant: TenantContext, domain: { id: number; domain: string }, deps: SpfDeps = {}): Promise<{ ok: true } | { ok: false; refusal: SpfRestoreRefusal }> {
  const r = await disableSpf(tenant, domain, deps);
  if (r.ok || 'notConfigured' in r) return { ok: true };
  return { ok: false, refusal: {
    error: `${r.restoreFailed} Your SPF record in Cloudflare is still the flattened one, and deleting ${domain.domain} would leave it there with nothing keeping it up to date. Your original record is: ${r.original}`,
    reason: r.restoreFailed, code: 'spf_restore_failed', domain: domain.domain, original: r.original, flattened_record: r.flattened, leave_param: 'leave_spf_record=1',
  } };
}

/** What a disconnect did to one flattened domain: its original is back in Cloudflare, or flattening stopped and the owner has the original to copy. */
export interface SpfDisconnectOutcome { domain: string; restored: boolean; original: string; flattened_record: string | null; message: string | null }

/**
 * The Cloudflare connection is being removed: for each domain linked to it that has flattening, put the original back while the connection still works.
 * Where that is not possible, flattening stops (stopSpf) and the answer says so, with the original.
 */
export async function settleSpfBeforeDisconnect(tenant: TenantContext, domains: Array<{ id: number; domain: string }>, deps: SpfDeps = {}): Promise<SpfDisconnectOutcome[]> {
  const out: SpfDisconnectOutcome[] = [];
  for (const d of domains) {
    const row = await tenant.scope.spf.get(d.id);
    if (!row) continue;
    const r = await restoreSpfBeforeRemoval(tenant, d, deps);
    if (r.ok) { out.push({ domain: d.domain, restored: true, original: row.canonical_record, flattened_record: null, message: null }); continue; }
    await stopSpf(tenant, d, 'connection_removed', deps);
    out.push({ domain: d.domain, restored: false, original: r.refusal.original, flattened_record: r.refusal.flattened_record, message: (await tenant.scope.spf.get(d.id))?.last_error ?? null });
  }
  return out;
}

export type SpfStopReason = 'connection_removed' | 'connection_revoked' | 'proof_lost';
const STOP_SENTENCE: Readonly<Record<SpfStopReason, (domain: string) => string>> = Object.freeze({
  connection_removed: d => `The Cloudflare connection for ${d} was removed, so we can no longer change its DNS. We have stopped keeping your SPF record up to date.`,
  connection_revoked: d => `The Cloudflare connection for ${d} was disconnected, so we can no longer change its DNS. We have stopped keeping your SPF record up to date.`,
  proof_lost: d => `We can no longer show that you control ${d}, so we have stopped keeping your SPF record up to date.`,
});

/**
 * Flattening stops where we cannot write any more (the connection is gone, or the proof of ownership is): no refresh, no write. The row stays, in the state
 * a failed turn-off leaves (`restore_failed`), with the original and what Cloudflare holds, and the sentence says how to put the original back by hand.
 * Returns false when the domain has no row.
 */
export async function stopSpf(tenant: TenantContext, domain: { id: number; domain: string }, why: SpfStopReason, deps: SpfDeps = {}): Promise<boolean> {
  const q = tenant.scope.spf;
  const before = await q.get(domain.id);
  if (!before) return false;
  await q.deactivate(domain.id); // from here no refresh can finish
  const row = (await q.get(domain.id))!;
  const at = nowS(deps);
  const message = `${STOP_SENTENCE[why](domain.domain)} The SPF record in Cloudflare is the flattened one. To go back to your original, set the SPF TXT record of ${domain.domain} to: ${row.canonical_record}`;
  const kind = why === 'proof_lost' ? 'proof_lost' : 'connection_gone';
  await q.setProblem(domain.id, { kind, since: row.problem_kind === kind ? row.problem_since : at, error: message, at });
  audit(tenant, deps, 'spf_flatten.stopped', domain, { spf_record: row.flattened_record }, { spf_record: row.flattened_record, original_record: row.canonical_record }, { reason: why });
  return true;
}

// ── Use the edit as the new original ───────────────────────

export type AdoptResult =
  | { ok: true; config: SpfConfigRow; outcome: 'written' | 'unchanged' }
  | { ok: false; refused: SpfProblemOut }
  | { ok: false; conflict: 'not_on' | 'running' };

/**
 * The record in Cloudflare was edited outside the app and the owner chose "Use my edit as the new original": that record becomes the original (`canonical_record`,
 * the only time it is rewritten while flattening is on), and the flattened record is made from it, so what the edit added (an include, say) is kept. Nothing is
 * written unless the new original flattens; the old original and the flattened record it replaces are in the audit entry. Addresses the edit already lists stay as
 * written: they no longer follow a provider.
 */
export async function adoptSpf(tenant: TenantContext, domain: { id: number; domain: string }, deps: SpfDeps = {}): Promise<AdoptResult> {
  const q = tenant.scope.spf;
  const row = await q.get(domain.id);
  if (!row || row.enabled !== 1 || row.flattened_record === null) return { ok: false, conflict: 'not_on' };
  const at = nowS(deps);
  const claimed = await q.claim(domain.id, row.revision, at, SPF_LEASE_SECONDS);
  if (claimed === null) return { ok: false, conflict: 'running' };
  const target = deps.target ?? cloudflareTarget(tenant, domain.domain);
  const release = async () => { await q.finish(domain.id, claimed, {}); };
  let live: SpfLive;
  try { live = await target.read(); } catch (e) {
    await release();
    return connectionRefused(e);
  }
  if ('multiple' in live) { await release(); return { ok: false, refused: { kind: 'edited_outside', message: `${domain.domain} has more than one SPF record in Cloudflare. Remove the extra one first.` } }; }
  if (!live.found) { await release(); return { ok: false, refused: { kind: 'record_missing', message: problemSentence({ kind: 'record_missing', domain: domain.domain }) } }; }
  const original = live.content;
  // What the published record authorises is what an adopted edit may not take away at once either (ADR 0028): the same rule, decideSpfWrite.
  const res = await flattenFromSource(domain.domain, original, deps.resolver ?? resolverFor(tenant.env), { inline: row.inline_mode === 'most' ? 'most' : 'fewest', previous: parseEntries(row.provider_state) });
  if (!res.ok) { await release(); return { ok: false, refused: refusal(res.problems[0]!) }; }
  const flat = res.flat;
  const { plan, pending, how } = decideSpfWrite(row, flat, at);
  if (!plan) { await release(); return { ok: false, refused: { kind: 'too_large', message: `The addresses this edit would take away are kept for four hours before they are removed, and with them the record is over the limits.${UNCHANGED}` } }; }
  const same = sameSpfRecord(live.content, plan.record);
  try {
    if (!same) {
      if (!(await q.holds(domain.id, claimed))) return { ok: false, conflict: 'running' };
      await target.write(live.id, plan.record);
      const back = await target.read();
      if (!('found' in back && back.found) || !sameSpfRecord(back.content, plan.record)) throw new NotKept();
    }
  } catch (e) {
    await putBack(target, live.id, live.content);
    await release();
    if (e instanceof NotKept) return { ok: false, refused: { kind: 'connection_lost', message: `Cloudflare did not keep the record we wrote.${UNCHANGED}` } };
    return connectionRefused(e);
  }
  const done = await q.finish(domain.id, claimed, {
    canonical_record: original, lookup_count: flat.lookupsBefore, flattened_record: plan.record, previous_record: live.content, ip_count: plan.ipCount, lookups_after: plan.lookups,
    provider_state: entriesJson(plan.providers), pending_removed: pending ? entriesJson(pending.removed) : null, pending_since: pending ? pending.since : null, pending_additions: pending ? (pending.additions ? 1 : 0) : null,
    problem_kind: null, problem_since: null, last_error: null, last_error_at: null, last_refreshed_at: at, last_flattened_at: at,
  });
  if (!done) { await undoLostClaim(tenant, row, target, live); return { ok: false, conflict: 'running' }; }
  audit(tenant, deps, 'spf_flatten.adopt', domain, { original_record: row.canonical_record, flattened_record: row.flattened_record }, { original_record: original, flattened_record: plan.record, ip_count: plan.ipCount, lookups: plan.lookups }, { by: 'user', ...(how === 'confirmed' ? { confirmed_after_seconds: at - row.pending_since! } : {}), ...(pending ? { removal_pending: true } : {}) });
  auditPending(tenant, deps, domain, how, pending, parseEntries(row.pending_removed), row, at, { by: 'user' });
  if (!same) audit(tenant, deps, 'dns.update', domain, { content: live.content }, { content: plan.record }, undefined, { type: 'dns_record', id: live.id, name: `TXT ${domain.domain}` });
  return { ok: true, config: (await q.get(domain.id))!, outcome: same ? 'unchanged' : 'written' };
}

// ── One step back ───────────────────────────────────────────

export type RollbackResult = 'rolled_back' | 'nothing_to_roll_back' | 'edited_outside' | 'skipped' | 'failed';

/**
 * Put the previous flattened record back (one step), when the record in Cloudflare is still the current one. The next refresh makes its own choice again, so
 * this is for undoing a bad change, not for pausing: to stay on the older record, turn flattening off. There is no button for it (docs/spf-flattening.md).
 */
export async function rollbackSpf(tenant: TenantContext, domain: { id: number; domain: string }, deps: SpfDeps = {}): Promise<RollbackResult> {
  const q = tenant.scope.spf;
  const row = await q.get(domain.id);
  if (!row || row.enabled !== 1 || !row.previous_record || !row.flattened_record) return 'nothing_to_roll_back';
  const claimed = await q.claim(domain.id, row.revision, nowS(deps), SPF_LEASE_SECONDS);
  if (claimed === null) return 'skipped';
  const target = deps.target ?? cloudflareTarget(tenant, domain.domain);
  const at = nowS(deps);
  try {
    const live = await target.read();
    if (!('found' in live && live.found) || !sameSpfRecord(live.content, row.flattened_record)) { await q.finish(domain.id, claimed, {}); return 'edited_outside'; }
    await target.write(live.id, row.previous_record);
    const back = await target.read();
    if (!('found' in back && back.found) || !sameSpfRecord(back.content, row.previous_record)) throw new NotKept();
    // The record before this one came from an earlier resolution: what the published record authorises per provider is not known any more, and a removal that
    // waited is moot. The next refresh makes its own choice from the original, as before.
    const done = await q.finish(domain.id, claimed, { flattened_record: row.previous_record, previous_record: row.flattened_record, last_flattened_at: at, provider_state: null, pending_removed: null, pending_since: null, pending_additions: null });
    if (!done) { await undoLostClaim(tenant, row, target, live); return 'skipped'; }
    audit(tenant, deps, 'spf_flatten.rollback', domain, { spf_record: row.flattened_record }, { spf_record: row.previous_record }, { by: deps.actor ? 'user' : 'operator' });
    return 'rolled_back';
  } catch (e) {
    await q.finish(domain.id, claimed, {});
    if (!isConnectionFailure(e) && !(e instanceof NotKept)) throw e;
    return 'failed';
  }
}

// ── The daily job ───────────────────────────────────────────

/**
 * One workspace's share of the daily refresh (`0 11 * * *`; `0 10` on an install that kept the older trigger runs the same function): the rows not looked
 * at in the last 20 hours, longest ago first, at most 20 here and what is left of the invocation's budget, five at a time. A workspace the add-on is not
 * available to is skipped: its records stay as they are (turning flattening off stays possible, src/api/router.ts).
 */
export async function runSpfRefresh(tenant: TenantContext, ctx: Ctx, budget: SpfBudget, deps: SpfDeps = {}): Promise<void> {
  if (!tenant.hasCloudflare()) return;
  const nowSec = nowS(deps);
  const rows = await tenant.scope.spf.due(nowSec - SPF_DUE_AFTER_SECONDS, Math.min(SPF_REFRESH_MAX_PER_WORKSPACE, budget.domains));
  if (rows.length === 0) return;
  const access = await capability(tenant.env, 'spf_flattening', { workspaceId: tenant.workspaceId });
  if (!access.allowed) { console.log(`[spf-flatten] ${rows.length} flattened domains left as they are: SPF flattening is not available to this workspace`); return; }
  console.log(`[spf-flatten] refreshing ${rows.length} flattened domains`);
  await mapLimit(rows, SPF_REFRESH_CONCURRENCY, async row => {
    if (budget.domains <= 0 || budget.subrequests <= 0) return;
    budget.domains--;
    try {
      const { fetches } = await refreshSpf(tenant, row, { ...deps, ctx });
      budget.subrequests -= fetches + SPF_CLOUDFLARE_CALLS_PER_DOMAIN;
    } catch (e) {
      console.error(`[spf-flatten] domain ${row.domain_id}: ${e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error'}`);
    }
  });
}

// ── Small helpers ───────────────────────────────────────────

function audit(tenant: TenantContext, deps: SpfDeps, action: string, domain: { id: number; domain: string }, before: unknown, after: unknown, meta?: Record<string, unknown>, resource?: { type: string; id: string; name: string }): void {
  logAudit(tenant, {
    actor_type: deps.actor ? 'user' : 'system', actor_id: deps.actor?.id, actor_email: deps.actor?.email,
    action, resource_type: resource?.type ?? 'domain', resource_id: resource?.id ?? String(domain.id), resource_name: resource?.name ?? domain.domain,
    before_value: before, after_value: after, meta: meta ? Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) : null,
  }, deps.ctx as ExecutionContext | undefined);
}

async function emit(deps: SpfDeps, tenant: TenantContext, e: SpfRefreshEvent): Promise<void> {
  try {
    if (deps.onEvent) { await deps.onEvent(e); return; }
    spfRefreshed(tenant, deps.ctx, e.type === 'spf.problem' ? { type: e.type, problem: e.problem, first: e.first } : { type: e.type });
  } catch (err) {
    console.error('[spf-flatten] event handler failed:', err instanceof Error ? err.message : err);
  }
}
