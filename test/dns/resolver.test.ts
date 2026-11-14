import { describe, expect, it } from 'vitest';
import { dohEndpoint } from '../../src/dns/resolver';

const PUBLIC = 'https://cloudflare-dns.com/dns-query';
describe('DOH_BASE_URL', () => {
  it('is honoured only for a local http URL with a port', () => {
    expect(dohEndpoint('http://127.0.0.1:8788')).toBe('http://127.0.0.1:8788/dns-query');
    expect(dohEndpoint('http://localhost:9')).toBe('http://localhost:9/dns-query');
  });
  it('anything else uses public DNS', () => {
    for (const v of [undefined, '', 'https://127.0.0.1:1', 'http://evil.example:80', 'http://127.0.0.1', 'http://127.0.0.1:1@evil.example:2', 'http://localhost.evil.com:1', 'http://127.0.0.1:1/x', 'http://127.0.0.1:0']) expect(dohEndpoint(v), String(v)).toBe(PUBLIC);
  });
});
