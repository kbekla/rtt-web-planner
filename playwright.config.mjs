import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.RTT_TEST_PORT || 8099);

export default defineConfig({
  testDir: 'tests/render',
  outputDir: process.env.RTT_TEST_OUTPUT || 'test-results',
  timeout: 60_000,
  workers: 2,
  reporter: [['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  expect: {
    // Same machine + SwiftShader renders are near-identical; allow small AA noise.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 } },
    // Phone-sized, retina: exercises @2x sprites and attribution at narrow widths.
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: `http://127.0.0.1:${PORT}/viewer/`,
    env: { PORT: String(PORT), RTT_BUILD_ID: process.env.RTT_BUILD_ID || 'current',
      RTT_TRAILS_BUILD_ID: process.env.RTT_TRAILS_BUILD_ID || 'current' },
    reuseExistingServer: false,
  },
});
