// @ts-check
const { defineConfig } = require('@playwright/test')

const WEB = process.env.WEB_URL || 'http://localhost:3000'

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  globalSetup: './global-setup.js',
  timeout: 30_000,
  retries: 0,
  // Tests share real Docker/task state (create/delete containers, tasks) —
  // run serially to avoid cross-file races on the shared backend
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: WEB,
    viewport: { width: 1440, height: 900 },
    storageState: './.auth-state.json',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  expect: { timeout: 5_000 },
})
