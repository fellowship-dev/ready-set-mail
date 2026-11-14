// The DMARC policy in force for one name, and the next step from it. ONE place for both, so the dashboard's overview row,
// its domain page and the agent tools cannot disagree: each builds `PolicyInForce` from what it read and calls `dmarcSteps`.
//
// Pure and dependency-free (no resolver, no PSL), so the dashboard can import this file alone.
//
// The ladder is the same for a name with its own record and for one that inherits its organizational domain's:
// none -> quarantine -> reject, then pct=100, each step gated on the same report evidence (a reports address, reports that
// arrived, and their pass share). For an inherited name every change is named at the exact record and tag that sets its
// policy (`sp=` at _dmarc.<parent> when the parent has or needs one), says what else that change affects, mentions pct= while
// it is below 100, and offers the alternative of the name's own record, which affects only this name.

export type Policy = 'none' | 'quarantine' | 'reject';
export type StepStatus = 'attention' | 'approval' | 'improve' | 'unknown' | 'gathering' | 'verified' | 'note';
/** Who acts: your DNS manager, an owner or admin, your email providers, you, or nobody. */
export type StepWho = 'dns' | 'approver' | 'providers' | 'you' | 'nobody';
/**
 * Where the step happens: `self` this name's DNS, `parent` the governing record's domain, `dmarc-wizard` the policy change
 * wizard, `dmarc-setup` the DMARC setup step, `senders` the failing senders, `connect-reports` connecting reports,
 * `recheck` reading DNS again, `reload-reports` loading the report totals again, `none` nothing to open.
 */
export type StepWhere = 'self' | 'parent' | 'dmarc-wizard' | 'dmarc-setup' | 'senders' | 'connect-reports' | 'recheck' | 'reload-reports' | 'none';

export interface DmarcStep {
  key: string;
  status: StepStatus;
  /** The change, as a verb. */
  do: string;
  /** What it gets you, what else it affects, and the main uncertainty. */
  why: string;
  who: StepWho;
  where: StepWhere;
  /** The domain whose record changes (`where` self or parent). */
  at?: string;
  /** The exact record value this step offers to publish, at `recordAt`. Absent: no record is offered. */
  record?: string;
  recordAt?: string;
}

/** The stored DMARC facts of one domain (the domains row and the check summary carry them). */
export interface StoredDmarc {
  /** The effective policy for this name: own p=, else the governing record's sp= when it has one, else its p=. */
  dmarc_policy: string | null;
  dmarc_issue?: string | null;
  dmarc_inherited_from?: string | null;
  dmarc_pct?: number | null;
  /** The governing record's p=; null with a policy: not read since these tags are stored. */
  dmarc_p?: string | null;
  /** The governing record's sp= as written; null: no sp= tag. */
  dmarc_sp?: string | null;
  /** 1: the governing record's rua= names this domain's reports address; 0: it does not; null: not read. */
  dmarc_rua?: number | null;
}

export interface InForce {
  kind: 'own' | 'inherited';
  name: string;
  /** The domain whose _dmarc record governs this name. */
  at: string;
  /** The policy receivers apply to mail from this name. */
  policy: Policy;
  /** The tag that sets it: `p` (own record, or a parent without sp=) or `sp` (the parent's subdomain policy). */
  tag: 'p' | 'sp';
  /** The governing record's p= and sp= (null: no sp= tag). */
  p: Policy;
  sp: Policy | null;
  pct: number;
  /** Whether that record sends reports to this domain's reports address; null when not known. */
  reportsHere: boolean | null;
}

export type PolicyInForce =
  | { kind: 'unread' }
  | { kind: 'none' }
  | { kind: 'broken'; inherited: boolean; at: string; issue: 'multiple' | 'invalid' }
  /** A policy is known, but not the record's tags (pct=, sp=, rua=): read before any step is offered. */
  | { kind: 'partial-read'; inherited: boolean; at: string; policy: Policy }
  | InForce;

const asPolicy = (v: string | null | undefined): Policy | null => {
  const l = v?.trim().toLowerCase();
  return l === 'none' || l === 'quarantine' || l === 'reject' ? l : null;
};
const RANK: Record<Policy, number> = { none: 0, quarantine: 1, reject: 2 };
const STATUS_ORDER: StepStatus[] = ['attention', 'approval', 'improve', 'unknown', 'gathering', 'verified', 'note'];

/**
 * The policy in force for `name` from its stored facts. `read`: DMARC was read for this name at least once (else every
 * null means "not read", never "no record").
 */
export function policyInForce(name: string, s: StoredDmarc, read = true): PolicyInForce {
  const parent = s.dmarc_inherited_from || null;
  const policy = asPolicy(s.dmarc_policy);
  if (!policy) {
    if (s.dmarc_issue === 'multiple' || s.dmarc_issue === 'invalid') return { kind: 'broken', inherited: !!parent, at: parent ?? name, issue: s.dmarc_issue };
    return read ? { kind: 'none' } : { kind: 'unread' };
  }
  const p = asPolicy(s.dmarc_p);
  const pct = typeof s.dmarc_pct === 'number' ? s.dmarc_pct : null;
  if (!p || pct === null) return { kind: 'partial-read', inherited: !!parent, at: parent ?? name, policy };
  const sp = asPolicy(s.dmarc_sp);
  const reportsHere = s.dmarc_rua === 1 ? true : s.dmarc_rua === 0 ? false : null;
  if (!parent) return { kind: 'own', name, at: name, policy, tag: 'p', p, sp, pct, reportsHere };
  return { kind: 'inherited', name, at: parent, policy, tag: sp ? 'sp' : 'p', p, sp, pct, reportsHere };
}

/** A record we serve for the domain (hosted): its own, at full pct, sending reports here once intake is connected. */
export function hostedInForce(name: string, policy: Policy, reportsConnected: boolean): InForce {
  return { kind: 'own', name, at: name, policy, tag: 'p', p: policy, sp: null, pct: 100, reportsHere: reportsConnected };
}

export interface DmarcEvidence {
  /** The domain has a reports address (hosted: report intake connected). Without one no pass share is used, however old reports read. */
  reportsAddress: boolean;
  /** That address, for records this step offers (rua=). */
  ruaAddress?: string | null;
  /** Report totals for the window. null: failed to load; undefined: still loading. */
  reports: { total: number; passed: number; days: number } | null | undefined;
  /**
   * A listed parent that publishes a DMARC record which does not cover this name (the parent is a public suffix, so this
   * name is its own organizational domain). Said plainly when no record covers the name.
   */
  suffixParent?: string | null;
}

/**
 * True when `rua` is a usable reports address (one mailbox: no spaces, `;` or `,`). The dashboard, the agent tools and the
 * stored reports match all use this check, so an address one of them rejects is not counted by another.
 */
export function isReportAddress(rua: string | null | undefined): rua is string {
  return typeof rua === 'string' && /^[^\s@;,]+@[^\s@;,]+$/.test(rua.trim());
}

/**
 * A listed parent whose own DMARC record does not cover this name (the parent is a public suffix such as gov.uk, so the
 * name is its own organization): only when the name was read, has no record of its own and inherits none.
 */
export function publicSuffixParent(
  s: Pick<StoredDmarc, 'dmarc_policy' | 'dmarc_issue' | 'dmarc_inherited_from'> & { dns_checked_at?: number | null } | null | undefined,
  parent: { domain: string; summary: Pick<StoredDmarc, 'dmarc_policy' | 'dmarc_inherited_from'> | null | undefined } | null | undefined,
): string | null {
  if (!s || !parent?.summary || !s.dns_checked_at) return null;
  const covered = !!s.dmarc_policy || !!s.dmarc_issue || !!s.dmarc_inherited_from;
  const parentOwn = !!parent.summary.dmarc_policy && !parent.summary.dmarc_inherited_from;
  return !covered && parentOwn ? parent.domain : null;
}

/** Pass share at which a p=none name's senders look ready for quarantine, and pct= ready for 100. */
export const READY = 95;
/** From p=quarantine the policy wizard offers p=reject at this share. */
export const READY_FOR_REJECT = 90;
/** Under enforcement, below this share some of your own mail is probably rejected or quarantined. */
export const HARMFUL = 70;

const outcome = (p: Policy) => (p === 'reject' ? 'rejected' : p === 'quarantine' ? 'quarantined, usually to spam' : 'still delivered');

/** One sentence: which record and tag set this name's policy, and what it does to failing mail. */
export function inForceSentence(f: InForce): string {
  // pct= is named whenever it is below 100: a later step to quarantine or reject would apply only to that share.
  const pct = f.pct < 100 ? ` at pct=${f.pct}` : '';
  const source =
    f.kind === 'own'
      ? `${f.name}'s own DMARC record sets p=${f.p}${pct}`
      : f.tag === 'sp'
        ? `${f.name} has no DMARC record of its own; ${f.at}'s record sets sp=${f.sp}${pct} for its subdomains${f.p !== f.sp ? ` (its p=${f.p} applies only to ${f.at} itself)` : ''}`
        : `${f.name} has no DMARC record of its own and follows p=${f.p}${pct} from ${f.at}`;
  const what = f.policy !== 'none' && f.pct < 100
    ? `only ${f.pct}% of mail from ${f.name} that fails DMARC is ${outcome(f.policy)}; receivers handle the rest one step more leniently`
    : `mail from ${f.name} that fails DMARC is ${outcome(f.policy)}`;
  return `${source}, so ${what}.`;
}

const exact = (r: DmarcEvidence['reports']): number | null => (r && r.total > 0 ? (r.passed / r.total) * 100 : null);
const shownRate = (r: { total: number; passed: number; days: number }) =>
  `${Math.round((r.passed / r.total) * 100)}% of ${r.total.toLocaleString('en-US')} reported messages passed DMARC in the last ${r.days} days`;

/** An own record at `policy` for `name`, with the reports address when there is one. */
function ownRecord(policy: Policy, rua: string | null | undefined): string {
  const a = rua?.trim();
  return `v=DMARC1; p=${policy}${a ? `; rua=mailto:${a}` : ''}`;
}

/**
 * The DMARC steps for one name, most urgent first: [0] is THE next step (the overview row shows it; the domain page lists
 * it first). Empty only while the report totals are still loading and the step depends on them.
 */
export function dmarcSteps(name: string, f: PolicyInForce, ev: DmarcEvidence): DmarcStep[] {
  if (f.kind === 'unread' || f.kind === 'partial-read') {
    const what = f.kind === 'unread' ? 'DMARC has not been read from public DNS yet' : `public DNS showed p=${f.policy}${f.inherited ? ` from ${f.at}` : ''}, but how much of it is enforced (pct=, sp=) and whether it sends reports here have not been read yet`;
    return [{ key: 'dmarc-read', status: 'unknown', do: 'Check the DMARC record again', why: `For ${name}, ${what}, so it is not called enforced and nothing is suggested until it is.`, who: 'you', where: 'recheck' }];
  }
  if (f.kind === 'none') {
    const suffix = ev.suffixParent ? ` ${ev.suffixParent} is a public suffix, so its DMARC record does not apply to ${name}: ${name} counts as its own organization.` : '';
    return [{
      key: 'dmarc-missing', status: 'attention', do: 'Publish a DMARC record at p=none', who: 'dns', where: 'dmarc-setup', at: name,
      why: `No DMARC record covers ${name}, so receivers get no instruction for mail that fails, and nobody sends reports about who mails as ${name}.${suffix} p=none changes no delivery; it starts the reports.`,
      record: ownRecord('none', ev.reportsAddress ? ev.ruaAddress : null), recordAt: `_dmarc.${name}`,
    }];
  }
  if (f.kind === 'broken') {
    const at = `_dmarc.${f.at}`;
    const what = f.issue === 'multiple' ? `There are several DMARC records at ${at}, so receivers ignore all of them` : `The DMARC record at ${at} has no valid p= policy, so receivers ignore it`;
    const alt = f.inherited ? ` Fixing it there also affects ${f.at} itself and its other subdomains. Or publish a DMARC record at _dmarc.${name}, which affects only ${name}.` : '';
    return [{
      key: f.issue === 'multiple' ? 'dmarc-multiple' : 'dmarc-invalid', status: 'attention',
      do: f.issue === 'multiple' ? `Keep one DMARC record at ${at} and delete the others` : `Fix the DMARC record at ${at} so it has a valid p= policy`,
      why: `${what}.${alt}`, who: 'dns', where: f.inherited ? 'parent' : 'dmarc-setup', at: f.at,
    }];
  }

  const R = `_dmarc.${f.at}`;
  const inh = f.kind === 'inherited';
  const steps: DmarcStep[] = [];
  const reports = ev.reportsAddress ? ev.reports : null;
  const rate = ev.reportsAddress ? exact(ev.reports) : null;
  const shown = ev.reportsAddress && ev.reports && ev.reports.total > 0 ? shownRate(ev.reports) : '';
  const alsoAffects = `${f.at} itself and every other subdomain of it without its own record`;
  const ownAlt = (policy: Policy) => ({ record: ownRecord(policy, ev.reportsAddress ? ev.ruaAddress : null), recordAt: `_dmarc.${name}` });
  const alternative = (policy: Policy) => ` Or publish a DMARC record at _dmarc.${name} with p=${policy}: it affects only ${name}.`;

  // The change that moves this name one rung up: to `target`, or (target === current policy) pct to 100. `extra` follows the
  // evidence and the policy in force in the step's why: what else the change affects, and the own-record alternative.
  const tighten = (target: Policy): Pick<DmarcStep, 'do' | 'who' | 'where' | 'at' | 'record' | 'recordAt'> & { extra: string } => {
    if (!inh) {
      if (target === f.policy) return { do: `Raise pct from ${f.pct} to 100`, extra: '', who: 'dns', where: 'self', at: f.at };
      return { do: `Approve moving DMARC to p=${target}`, extra: '', who: 'approver', where: 'dmarc-wizard', at: f.at };
    }
    if (target === f.policy) {
      return { do: `Raise pct from ${f.pct} to 100 at ${R}`, extra: ` That also applies to ${alsoAffects}.${alternative(target)}`, who: 'dns', where: 'parent', at: f.at, ...ownAlt(target) };
    }
    // Inherited: name the tag. With sp= the parent's p= does not reach this name; without it, adding sp= changes only subdomains.
    const raisePct = f.pct < 100;
    const pctPart = raisePct ? ` and raise pct from ${f.pct} to 100` : '';
    const pctWhy = raisePct ? ` pct=${f.pct} applies to the whole record, so raising it also tightens ${f.at} itself.` : '';
    if (f.sp) {
      return {
        do: `Set sp=${target} at ${R}${pctPart}`,
        extra: ` sp= sets the policy for every subdomain of ${f.at} without its own record; changing ${f.at}'s p= would not change it.${pctWhy}${alternative(target)}`,
        who: 'dns', where: 'parent', at: f.at, ...ownAlt(target),
      };
    }
    return {
      do: `Add sp=${target} at ${R}${pctPart}`,
      extra: ` That applies to every subdomain of ${f.at} without its own record. Changing ${f.at}'s p= to ${target} would also work, but would also apply to ${f.at} itself.${pctWhy}${alternative(target)}`,
      who: 'dns', where: 'parent', at: f.at, ...ownAlt(target),
    };
  };

  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const sameRecord = `p=${f.policy}${f.pct < 100 && f.policy !== 'none' ? `; pct=${f.pct}` : ''}`;
  const ruaStep = (why: string, status: StepStatus): DmarcStep => ({
    key: 'dmarc-rua', status, do: inh ? `Add the reports address to the DMARC record at ${R}` : 'Add the reports address to your DMARC record', who: 'dns', where: inh ? 'parent' : 'dmarc-setup', at: f.at,
    why: `${why}${inh ? ` Adding it there also sends ${f.at}'s reports here. Or publish a DMARC record at _dmarc.${name} at the same ${sameRecord} with the reports address: it affects only ${name}.` : ''}`,
    ...(inh ? { record: `v=DMARC1; ${sameRecord}${ev.ruaAddress?.trim() ? `; rua=mailto:${ev.ruaAddress.trim()}` : ''}`, recordAt: `_dmarc.${name}` } : {}),
  });
  const connectStep = (why: string, status: StepStatus): DmarcStep => ({ key: 'connect-reports', status, do: 'Connect reports so senders can be confirmed', why, who: 'you', where: 'connect-reports' });
  const reloadStep = (why: string): DmarcStep => ({ key: 'reports-failed', status: 'unknown', do: 'Load the report totals again', why, who: 'you', where: 'reload-reports' });
  const sendersStep = (status: StepStatus, why: string): DmarcStep => ({ key: 'senders', status, do: 'Fix the senders that fail DMARC', why, who: 'providers', where: 'senders' });

  // The report evidence a rung waits on: the gating step, 'ready', or 'loading'.
  const gate = (next: string, threshold: number): DmarcStep | 'ready' | 'loading' => {
    if (!ev.reportsAddress) return connectStep(`Without reports, nobody can confirm that every service sending as ${name} passes, so ${next} would be a guess.`, 'improve');
    if (f.reportsHere === false) return ruaStep(`The record that governs ${name} does not send reports here, so nobody can confirm its senders before ${next}.`, 'improve');
    if (reports === undefined) return 'loading';
    if (reports === null) return reloadStep(`They could not be loaded, so whether every sender passes is unknown before ${next}.`);
    if (reports.total === 0) return { key: 'gathering', status: 'gathering', do: `Wait for DMARC reports before ${next}`, why: `No reports arrived in the last ${reports.days} days. Receivers send them about once a day; until they arrive, nobody can confirm that every sender passes.`, who: 'nobody', where: 'none' };
    if (rate !== null && rate < threshold) return sendersStep('improve', `${shown}. ${cap(next)} should wait until they pass.`);
    return 'ready';
  };

  const harmful = f.policy !== 'none' && rate !== null && rate < HARMFUL;
  if (harmful) steps.push(sendersStep('attention', `${shown}, so some of your own mail is likely ${f.policy === 'reject' ? 'rejected' : 'in spam'}.`));

  // The next rung: pct to 100 under an enforcing policy, else the next policy. p=reject at pct=100 is the top.
  const target: Policy | null = f.policy !== 'none' && f.pct < 100 ? f.policy : f.policy === 'none' ? 'quarantine' : f.policy === 'quarantine' ? 'reject' : null;
  if (target && !harmful) {
    const at = inh ? ` at ${R}` : '';
    const next = target === f.policy ? `raising pct to 100${at}` : !inh ? `moving to p=${target}` : f.sp ? `moving to sp=${target}${at}` : `adding sp=${target}${at}`;
    const g = gate(next, f.policy === 'quarantine' && target === 'reject' ? READY_FOR_REJECT : READY);
    if (g === 'ready') {
      const { extra, ...t } = tighten(target);
      steps.push({ key: target === f.policy ? 'pct' : 'tighten', status: 'approval', ...t, why: `${shown}, so your senders look ready. ${inForceSentence(f)}${extra}` });
    } else if (g !== 'loading') steps.push(g);
  } else if (!target && !harmful) {
    // p=reject at pct=100: protection is in place. Reports are evidence of it: missing ones are a note, a failing share is not.
    if (!ev.reportsAddress) steps.push(connectStep(`Protection is in place either way; reports would show which services send as ${name} and whether they pass.`, 'note'));
    else if (f.reportsHere === false) steps.push(ruaStep(`Protection is in place either way; without it, nobody sees which services send as ${name} and whether they pass.`, 'note'));
    else if (reports === null) steps.push(reloadStep('They could not be loaded, so whether every sender passes is unknown.'));
    else if (rate !== null && rate < READY) steps.push(sendersStep('improve', `${shown}. Their mail is rejected until they pass.`));
  }

  // An own record whose subdomain policy is weaker than its own: the subdomains climb the same ladder, one rung at a
  // time (sp=none -> quarantine -> reject, never past p=), on the same report evidence.
  if (!inh && f.policy !== 'none' && f.sp && RANK[f.sp] < RANK[f.policy] && !harmful) {
    const spTarget: Policy = f.sp === 'none' ? 'quarantine' : 'reject';
    const g = gate(`moving sp to ${spTarget}`, spTarget === 'reject' ? READY_FOR_REJECT : READY);
    const pctNote = f.pct < 100 ? ` The record's pct=${f.pct} applies to sp= too, so only ${f.pct}% of that mail would be affected until pct is 100.` : '';
    if (g === 'ready') {
      steps.push({
        key: 'sp', status: 'approval', do: `Set sp=${spTarget} to enforce subdomains too`, who: 'dns', where: 'self', at: f.at,
        why: `${shown}, so your senders look ready. Mail that fails DMARC from ${name} itself is ${f.policy === 'reject' ? 'rejected' : 'quarantined'}, but subdomains without their own record follow sp=${f.sp}, so failing mail from them is ${f.sp === 'none' ? 'still delivered' : 'quarantined, not rejected'}.${pctNote}`,
      });
    } else if (g !== 'loading' && !steps.some((s) => s.key === g.key)) steps.push(g);
  }

  const sorted = steps.map((s, i) => [s, i] as const).sort((a, b) => STATUS_ORDER.indexOf(a[0].status) - STATUS_ORDER.indexOf(b[0].status) || a[1] - b[1]).map(([s]) => s);
  const blocking = sorted.some((s) => s.status !== 'note');
  if (!blocking && f.policy === 'reject' && f.pct >= 100) {
    if (reports === undefined && ev.reportsAddress) return [];
    const scope = shown ? `public DNS and ${reports!.total.toLocaleString('en-US')} reported messages` : 'public DNS';
    return [{ key: 'done', status: 'verified', do: 'Nothing to do', why: `${inForceSentence(f)} Nothing in ${scope} needs a change.`, who: 'nobody', where: 'none' }, ...sorted];
  }
  return sorted;
}
