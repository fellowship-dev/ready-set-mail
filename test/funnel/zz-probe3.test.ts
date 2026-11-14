import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import { handleHostedEmail } from '../../src/hosted/intake';
import { call, makeEnv } from '../auth/helpers';
import { fakeMessage } from '../helpers/mail';
import { nxdomain } from '../hosted/world';
import { readAuthHeaders, spfPassesFor } from '../../src/email/sender-proof';
import { FUNNEL_ENV, quietLogs } from './world';

beforeEach(() => { quietLogs(); nxdomain(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const out: Record<string, unknown> = {};

async function enrol(envelope: string, auth: string, headerLines: string[], dkimSignatures?: number) {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...FUNNEL_ENV }) as any;
  const s = await (await call(env, 'POST', '/api/check-sessions')).json() as { email: string };
  const raw = `Authentication-Results: ${auth}\r\n${headerLines.join('\r\n')}\r\nSubject: hi\r\nMessage-ID: <m1@x.test>\r\n\r\nhi`;
  const m = fakeMessage(s.email, raw, { from: envelope, dkimSignatures }) as any;
  await handleHostedEmail(m, env);
  const leads = db.sqlite.prepare('SELECT email FROM leads').all() as { email: string }[];
  return { leads: leads.map((l) => l.email), replied: m.reply.mock.calls.length };
}

describe('PROBE enrolment', () => {
  const dkim = (d: string, from: string) => `mx.cloudflare.net; dkim=pass header.d=${d} header.s=s1; spf=softfail smtp.mailfrom=${from}; dmarc=pass header.from=${from.split('@')[1]}`;
  const cases: [string, string, string, string[], number?][] = [
    ['gmail replay (From attacker, envelope victim)', 'victim@gmail.com', dkim('gmail.com', 'attacker@gmail.com'), ['From: Attacker <attacker@gmail.com>']],
    ['control: own address', 'attacker@gmail.com', dkim('gmail.com', 'attacker@gmail.com'), ['From: attacker@gmail.com']],
    ['insider: corp signs any From', 'ceo@corp.example', dkim('corp.example', 'ceo@corp.example'), ['From: CEO <ceo@corp.example>']],
    ['ESP-delegated subdomain d=em.corp', 'ceo@corp.example', dkim('em.corp.example', 'ceo@corp.example'), ['From: ceo@corp.example']],
    ['SPF-only DMARC pass (shared SPF), no DKIM', 'ceo@corp.example', 'mx.cloudflare.net; dkim=none; spf=pass smtp.mailfrom=ceo@corp.example; dmarc=pass header.from=corp.example', ['From: ceo@corp.example'], 0],
    ['display name holds victim', 'victim@gmail.com', dkim('gmail.com', 'attacker@gmail.com'), ['From: "victim@gmail.com" <attacker@gmail.com>']],
    ['unquoted display name holds victim', 'victim@gmail.com', dkim('gmail.com', 'attacker@gmail.com'), ['From: victim@gmail.com <attacker@gmail.com>']],
    ['encoded word', 'victim@gmail.com', dkim('gmail.com', 'attacker@gmail.com'), ['From: =?utf-8?q?victim=40gmail.com?= <attacker@gmail.com>']],
    ['group syntax', 'victim@gmail.com', dkim('gmail.com', 'victim@gmail.com'), ['From: G: victim@gmail.com;']],
    ['two From headers (victim first)', 'victim@gmail.com', dkim('gmail.com', 'victim@gmail.com'), ['From: victim@gmail.com', 'From: attacker@gmail.com']],
    ['address list', 'victim@gmail.com', dkim('gmail.com', 'victim@gmail.com'), ['From: victim@gmail.com, attacker@gmail.com']],
    ['comment holding address', 'victim@gmail.com', dkim('gmail.com', 'attacker@gmail.com'), ['From: attacker@gmail.com (victim@gmail.com)']],
    ['case differs', 'Owner@Example.COM', dkim('example.com', 'owner@example.com'), ['From: owner@example.com']],
    ['plus address on From only', 'owner@example.com', dkim('example.com', 'owner+x@example.com'), ['From: owner+x@example.com']],
    ['plus address both', 'owner+x@example.com', dkim('example.com', 'owner+x@example.com'), ['From: owner+x@example.com']],
    ['null envelope', '', dkim('example.com', 'owner@example.com'), ['From: owner@example.com']],
    ['folded From', 'owner@example.com', dkim('example.com', 'owner@example.com'), ['From: Owner\r\n <owner@example.com>']],
    ['source route', 'owner@example.com', dkim('example.com', 'owner@example.com'), ['From: <@relay.test:owner@example.com>']],
  ];
  for (const [name, env, auth, lines, sigs] of cases) {
    it(name, async () => { out[name] = await enrol(env, auth, lines, sigs); });
  }
  it('header parsing', async () => {
    const p = async (l: string) => (await readAuthHeaders(new Response(`${l}\r\n\r\nx`).body)).from;
    out.parse = {
      quotedEscape: await p('From: "a\\"b@x.test" <ceo@corp.example>'),
      angleInQuoted: await p('From: "<victim@gmail.com>" <attacker@gmail.com>'),
      noAngleSpaces: await p('From: victim@gmail.com attacker@gmail.com'),
    };
    out.spfFallback = {
      plain: spfPassesFor('mx.cloudflare.net; spf=pass smtp.mailfrom=u@victim.test', 'victim.test'),
      nullEnvelopeDomain: spfPassesFor('mx.cloudflare.net; spf=pass smtp.mailfrom=<>', ''),
    };
  });
  it('zz dump', () => { process.stdout.write('PROBE3 ' + JSON.stringify(out, null, 1) + '\n'); });
});
