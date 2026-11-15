// The MCP server's serverInfo reports the product version (root package.json), not a hard-coded number.
import { describe, it, expect } from 'vitest';
import pkg from '../../package.json';
import { toolWorld } from './tool-fixture';

describe('MCP serverInfo', () => {
  it('names ready-set-mail and reports the product version', async () => {
    const world = await toolWorld();
    const client = await world.connect();
    expect(client.getServerVersion()).toMatchObject({ name: 'ready-set-mail', version: pkg.version });
    expect(pkg.version).not.toBe('1.0.0');
    await client.close();
  });
});
