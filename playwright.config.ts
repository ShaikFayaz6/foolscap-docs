import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 12_000 },
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4179',
    // Set PW_CHANNEL=msedge or chrome to use an installed browser instead of Playwright's Chromium.
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
});
