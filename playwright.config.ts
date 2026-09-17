import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/browser',
  timeout: 20_000,
  use: { baseURL: 'http://127.0.0.1:3000', headless: true, launchOptions: { executablePath: '/usr/bin/chromium-browser' } },
  webServer: { command: 'tsx tests/browser/start-demo.ts', url: 'http://127.0.0.1:3000/auth/config', reuseExistingServer: false, timeout: 30_000 },
});
