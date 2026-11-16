import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: '*.spec.ts', timeout: 900_000, workers: 1, outputDir: process.env.HOME + '/walk/pw-results', reporter: 'list', use: { ignoreHTTPSErrors: true } });
