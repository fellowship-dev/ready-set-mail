// Follow-ups to B4 and B5 (writes ~/rev/probes2.out).
import { afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleApi } from '../src/api/router';
import { sendFirstReportNow } from '../src/lifecycle/email/run';
import { signToken } from '../src/mail/tokens';
import { MON_16_NOV, WS, lifecycleWorld, recordNamingUs } from '../test/lifecycle/email/world';
import { REV, kindOf, logTo } from './lib';
import { COUNTED, setClock, store, utc, type Rec } from './probes-lib';
const log = logTo('probes2.out');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(MON_16_NOV * 1000); });
beforeAll(() => { writeFileSync(join(REV, 'probes2.out'), ''); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe('follow-ups', () => {
  it('B4 tamper in the middle of the signature / of the ciphertext, and which characters are malleable', async () => {
    const w = await lifecycleWorld();
    const t = await signToken(w.env as never, { p: 'pref', u: 'u_dana', w: WS, k: 'summary' });
    const [body, sig] = t.split('.');
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const flip = (s: string, i: number) => s.slice(0, i) + A[(A.indexOf(s[i]) + 1) % 64] + s.slice(i + 1);
    const post = async (tok: string) => (await handleApi(new Request(`https://app.readysetmail.com/api/email-preferences/off?t=${encodeURIComponent(tok)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }), w.env as never, ctx)).status;
    log('sig length', sig.length, 'body length', body.length);
    log('flip sig char 0:', await post(`${body}.${flip(sig, 0)}`), '| flip sig char 20:', await post(`${body}.${flip(sig, 20)}`), '| flip sig LAST char (low bits are base64 padding bits; decodes to the same MAC):', await post(`${body}.${flip(sig, sig.length - 1)}`));
    // how many of the 64 values of the last char verify
    let n = 0; for (const c of A) if ((await post(`${body}.${sig.slice(0, -1)}${c}`)) === 200) n++;
    log('values of the last signature char that verify:', n, 'of 64 (the same 32-byte MAC; not a forgery)');
    log('flip body char 5:', await post(`${flip(body, 5)}.${sig}`), '| flip body LAST char:', await post(`${flip(body, body.length - 1)}.${sig}`));
  });

  it('B5 case-insensitive injected-line check and header scan over every field', async () => {
    const w = await lifecycleWorld();
    setClock(w, utc(2026, 11, 16, 9));
    const id = w.addDomain({ domain: 'brightwave-mail.com', createdAt: utc(2026, 10, 1), connectedAt: utc(2026, 10, 1) });
    w.dns.set('brightwave-mail.com', recordNamingUs());
    const XD = 'x.example\r\nSubject: hi';
    const bad: Rec = { ip: '198.51.100.77', count: 50, dkim: [['pass', XD]], spf: [['pass', XD]], pe: { dkim: 'fail', spf: 'fail' }, from: 'brightwave-mail.com', rdns: 'a.example\r\nBcc: v@example.com', org: null };
    const good: Rec = { ip: '192.0.2.10', count: 100, dkim: [['pass', 'brightwave-mail.com']], spf: [['pass', 'brightwave-mail.com']], pe: { dkim: 'pass', spf: 'pass' }, from: 'brightwave-mail.com', org: 'Google Workspace' };
    await store(w, id, { id: 'e1', begin: '2026-11-10', records: [good, bad], reporter: COUNTED });
    await sendFirstReportNow(w.tenant(), w.ctx, id, 1, w.deps);
    await w.run({ schedule: 'weekly' });
    for (const m of w.mailer.sent) {
      const all = JSON.stringify({ from: m.from, to: m.to, replyTo: m.replyTo, subject: m.subject, headers: m.headers, idempotencyKey: m.idempotencyKey });
      log(`[${kindOf(m.subject)}] CR/LF in any header field/subject/idempotencyKey: ${/\\r|\\n/.test(all)} | injected lines in text body:`, m.text.split(/\r?\n/).filter((l) => /^(subject|bcc):/i.test(l)));
    }
    const t = w.mailer.sent.find((m) => kindOf(m.subject) === 'tip_fix');
    log('tip_fix text excerpt:', JSON.stringify(t?.text.split('\n').slice(2, 5)));
    log('tip_fix html excerpt:', JSON.stringify((t?.html ?? '').match(/Last week[^<]*/)?.[0]));
  });
});

describe('B7 extra: the read budget is per invocation, not per workspace', () => {
  it('30 waiting domains, one shared budget', async () => {
    const { newBudget } = await import('../src/lifecycle/email/run');
    const w = await lifecycleWorld();
    for (let i = 0; i < 30; i++) { w.addDomain({ domain: `d${i}.example` }); w.dns.set(`d${i}.example`, null); }
    const shared = newBudget();
    await w.run({ schedule: 'daily', budget: shared }); const r1 = w.reads.length;
    await w.run({ schedule: 'daily', budget: shared }); const r2 = w.reads.length - r1;
    log(`shared budget (what src/cron.ts does: one newBudget() per invocation over all workspaces): reads in 1st workspace-run ${r1}, in 2nd ${r2} (liveReads left ${shared.liveReads}); a never-live domain is re-read every day for 30 days`);
  });
});
