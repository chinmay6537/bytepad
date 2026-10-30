import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4173/',
    // Real Chrome, not Playwright's headless shell, which crashes when a WebAssembly program traps.
    channel: 'chrome',
    viewport: { width: 1360, height: 860 },
  },
  // Set BASE_URL to test a deployed site instead of the local build.
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: 'npx vite preview --port 4173 --strictPort',
        url: 'http://localhost:4173/',
        reuseExistingServer: true,
      },
});
