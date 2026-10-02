// Browser rendering of a region build in the local MapLibre viewer.
//   RTT_REGION=monaco RTT_BUILD_ID=<id|current> npx playwright test
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { buildDir, loadRegion } from '../../scripts/lib/common.mjs';

const region = process.env.RTT_REGION || 'monaco';
const config = loadRegion(region);
const manifest = JSON.parse(fs.readFileSync(path.join(buildDir(region), 'manifest.json'), 'utf8'));
const archiveLayers = new Set(manifest.output.metadata.layers);

/** Fail on anything leaving the local origin, any HTTP error, any console error. */
function audit(page, baseURL) {
  const problems = [];
  const origin = new URL(baseURL).origin;
  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) problems.push(`external request: ${url}`);
  });
  page.on('response', (res) => { if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`); });
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`); });
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  return problems;
}

async function waitForMap(page) {
  await page.waitForFunction(() => window.__rtt?.ready && window.__map.loaded() && window.__map.areTilesLoaded(),
    null, { timeout: 45_000 });
}

/** Map errors, except style layers whose source-layer this region has no data for. */
async function mapProblems(page) {
  const state = await page.evaluate(() => window.__rtt);
  const errors = state.errors.filter((msg) => {
    const m = /Source layer "([^"]+)" does not exist on source "openmaptiles"/.exec(msg);
    return !(m && !archiveLayers.has(m[1]));
  });
  return [...errors, ...[...new Set(state.missingImages)].map((id) => `missing sprite image: ${id}`)];
}

for (const view of config.views) {
  test(`${region} ${view.name}`, async ({ page, baseURL }) => {
    const problems = audit(page, baseURL);
    const [lon, lat] = view.center;
    await page.goto(`/viewer/?region=${region}#${view.zoom}/${lat}/${lon}`);
    await waitForMap(page);

    expect([...problems, ...(await mapProblems(page))]).toEqual([]);

    // Attribution: visible, expanded, linking to OSM copyright and OpenMapTiles.
    const attrib = page.locator('.maplibregl-ctrl-attrib');
    await expect(attrib).toBeVisible();
    await expect(attrib).not.toHaveClass(/maplibregl-compact/);
    await expect(attrib.locator('a[href="https://www.openstreetmap.org/copyright"]')).toBeVisible();
    await expect(attrib.locator('a[href="https://www.openstreetmap.org/copyright"]')).toContainText('OpenStreetMap contributors');
    await expect(attrib.locator('a[href="https://www.openmaptiles.org/"]')).toBeVisible();

    await expect(page).toHaveScreenshot(`${region}-${view.name}.png`);
  });
}

test(`${region} pan/zoom stays on local origin`, async ({ page, baseURL }) => {
  const problems = audit(page, baseURL);
  const [lon, lat] = config.views[0].center;
  await page.goto(`/viewer/?region=${region}#${config.views[0].zoom}/${lat}/${lon}`);
  await waitForMap(page);
  for (const step of [
    (m) => m.zoomTo(m.getZoom() + 2, { animate: false }),
    (m) => m.panBy([300, 200], { animate: false }),
    (m) => m.zoomTo(m.getZoom() + 3, { animate: false }), // overzoom past z14 tiles
    (m) => m.zoomTo(3, { animate: false }),
  ]) {
    await page.evaluate(`(${step.toString()})(window.__map)`);
    await waitForMap(page);
  }
  expect([...problems, ...(await mapProblems(page))]).toEqual([]);
});
