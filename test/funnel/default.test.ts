// The onboarding sequence's switch: off unless ONBOARDING_SEQUENCE_ENABLED=1, hosted and self-host (hosted used to be on unless =0).
import { describe, expect, it } from 'vitest';
import { sequenceEnabled } from '../../src/funnel/config';
import { readiness } from '../../src/funnel/sequence';
import { enrollLead } from '../../src/funnel/enroll';
import { funnelWorld, summary, T0 } from './world';
import { HOSTED_ENV } from '../hosted/world';

const hosted = (extra: Record<string, string | undefined> = {}) => ({ ...HOSTED_ENV, ...extra }) as never;
const selfHost = (extra: Record<string, string | undefined> = {}) => ({ MODE: 'selfhost', ...extra }) as never;

describe('sequenceEnabled', () => {
  it('hosted: off unless =1 (unset, 0, empty, anything else are off)', () => {
    expect(sequenceEnabled(hosted())).toBe(false);
    for (const v of ['0', '', 'true', 'yes', ' 1']) expect(sequenceEnabled(hosted({ ONBOARDING_SEQUENCE_ENABLED: v }))).toBe(false);
    expect(sequenceEnabled(hosted({ ONBOARDING_SEQUENCE_ENABLED: '1' }))).toBe(true);
  });

  it('self-host: unchanged, off unless =1', () => {
    expect(sequenceEnabled(selfHost())).toBe(false);
    expect(sequenceEnabled(selfHost({ ONBOARDING_SEQUENCE_ENABLED: '0' }))).toBe(false);
    expect(sequenceEnabled(selfHost({ ONBOARDING_SEQUENCE_ENABLED: '1' }))).toBe(true);
  });
});

describe('the sequence itself is kept, only its default changed', () => {
  it('a hosted instance without the setting enrols nobody and says why; with =1 it enrols as before', async () => {
    const off = funnelWorld({ ONBOARDING_SEQUENCE_ENABLED: undefined });
    expect(readiness(off.env)).toMatchObject({ enabled: false, blockers: [expect.stringMatching(/ONBOARDING_SEQUENCE_ENABLED=1/)] });
    expect(await enrollLead(off.env, { email: 'a@example.com', domain: 'acme.com', summary: summary() }, T0)).toBe('disabled');
    const on = funnelWorld();
    expect(readiness(on.env).enabled).toBe(true);
    expect(await enrollLead(on.env, { email: 'a@example.com', domain: 'acme.com', summary: summary() }, T0)).toBe('enrolled');
  });
});
