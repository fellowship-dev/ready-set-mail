import { describe, it, expect } from 'vitest';
import { parseAllow } from '../../src/hosted/allow';
import { connectReportsSetting } from '../../src/hosted/fixed-address';

describe('the one allow-setting parser', () => {
  const owner = { fallback: 'owner', ids: false } as const;
  it('HOSTED_CONNECT_REPORTS keeps its meaning: unset and unknown are owner, `all` is all, a list is not understood', () => {
    expect(connectReportsSetting({})).toEqual({ mode: 'owner', valid: true });
    expect(connectReportsSetting({ HOSTED_CONNECT_REPORTS: ' ALL ' })).toEqual({ mode: 'all', valid: true });
    expect(connectReportsSetting({ HOSTED_CONNECT_REPORTS: 'owner' })).toEqual({ mode: 'owner', valid: true });
    expect(connectReportsSetting({ HOSTED_CONNECT_REPORTS: 'everyone' })).toEqual({ mode: 'owner', valid: false });
    expect(connectReportsSetting({ HOSTED_CONNECT_REPORTS: 'all,owner' })).toEqual({ mode: 'owner', valid: false });
    expect(parseAllow('ws_abc', owner)).toMatchObject({ owner: true, valid: false });
  });
  it('a typo never opens a closed setting', () => {
    expect(parseAllow('alll', { fallback: 'off', ids: true })).toMatchObject({ all: false, owner: false, valid: false });
  });
});
