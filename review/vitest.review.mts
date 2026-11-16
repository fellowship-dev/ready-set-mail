// Reviewer-only config: the repo's node config with its include replaced by review/** only.
import { defineConfig } from 'vitest/config';
import base from '../vitest.node.config.mts';

export default defineConfig({
  test: { ...(base as { test: object }).test, include: ['review/**/*.test.ts'], exclude: [], root: new URL('..', import.meta.url).pathname, testTimeout: 120000 },
});
