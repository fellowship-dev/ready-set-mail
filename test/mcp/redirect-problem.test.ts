// The redirect address rule of open registration (ADR 0015): https, or http only on this computer. An authorization code is sent to a registered address,
// so an http address that is not loopback would send it across the network in clear text, and a look-alike of a loopback name would send it to someone else.
import { describe, expect, it } from 'vitest';
import { redirectProblem } from '../../src/mcp/registration';

describe('redirectProblem: http is for this computer only', () => {
 it.each([
  'http://localhost/cb', 'http://localhost:8080/cb', 'http://127.0.0.1/cb', 'http://127.0.0.1:33418', 'http://[::1]:8080/callback', 'http://127.1/cb', 'http://LOCALHOST:3000/x',
 ])('accepts %s', uri => expect(redirectProblem(uri)).toBeNull());

 it.each([
  'http://example.com/cb', 'http://client.example/cb', 'http://localhost.evil.com/cb', 'http://127.0.0.1.evil.com/cb', 'http://evil.com/127.0.0.1', 'http://evil.com#@127.0.0.1',
  'http://0.0.0.0/cb', 'http://0/cb', 'http://10.0.0.1/cb', 'http://192.168.1.10/cb', 'http://169.254.169.254/latest', 'http://172.16.0.1/cb', 'http://[::2]/cb', 'http://[::]/cb',
  'http://[::ffff:8.8.8.8]/cb', 'http://localhost.localdomain/cb', 'http://foo.localhost/cb', 'http://127.0.0.2.nip.io/cb', 'http://2130706433.evil.com/cb', 'http://localhostx/cb',
  'http://user@localhost/cb', 'http://:@localhost/cb', 'HTTP://example.com/cb',
 ])('refuses %s', uri => expect(redirectProblem(uri), uri).not.toBeNull());

 it.each([
  'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://client.example/cb', 'ws://localhost/cb', 'custom-app://callback', 'cursor://other.app/oauth/callback', '//client.example/cb', '/cb', 'not a url', '', 'https://', 'https://*.example.com/cb', 'https://client.example/cb#frag', 'https://client.example/cb#', 'https://user:pw@client.example/cb',
 ])('refuses %j', uri => expect(redirectProblem(uri), String(uri)).not.toBeNull());

 it('accepts https addresses and the one listed-only private-use address, refuses the rest of that scheme', () => {
  expect(redirectProblem('https://claude.ai/api/mcp/auth_callback')).toBeNull();
  expect(redirectProblem('https://chatgpt.com/connector_platform_oauth_redirect')).toBeNull();
  expect(redirectProblem('cursor://anysphere.cursor-mcp/oauth/callback')).toBeNull();
 });

 it('refuses what is not text, is empty or is too long', () => {
  for (const bad of [undefined, null, 42, {}, [], 'https://client.example/' + 'a'.repeat(2048)]) expect(redirectProblem(bad)).not.toBeNull();
 });
});
