// @ts-check
const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 30_000,
  retries: 0,
  // Tests share real Docker/task state (create/delete containers, tasks) —
  // run serially to avoid cross-file races on the shared backend
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.WEB_URL || 'http://localhost:3000',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  expect: { timeout: 5_000 },
})
