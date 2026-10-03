// RT&T trail layer over the Monaco basemap in the local viewer (?trails=1).
// Opt-in: RTT_TRAILS=1 (run by scripts/rtt/pipeline-trails / `make test-rtt-render`).
// Uses the trail build RTT_TRAILS_BUILD_ID (default: output/rtt-trails/current).
import { test, expect } from '@playwright/test';

const ACCEPTED = ['rtt-trail-000000000001', 'rtt-trail-000000000002', 'rtt-trail-000000000003', 'rtt-trail-000000000004'];
const QUARANTINED = ['rtt-trail-0000000000a1', 'rtt-trail-0000000000a2'];

test.skip(process.env.RTT_TRAILS !== '1', 'trail render tests run with RTT_TRAILS=1');
test.skip((process.env.RTT_REGION || 'monaco') !== 'monaco', 'the synthetic trail fixture lies in Monaco');

function audit(page, baseURL) {
  const problems = [];
  const origin = new URL(baseURL).origin;
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push(`external request: ${u}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  return problems;
}
const ready = (page) => page.waitForFunction(() => window.__rtt?.ready && window.__map.loaded() && window.__map.areTilesLoaded(), null, { timeout: 45_000 });
async function open(page, zoom, lat, lon) {
  await page.goto(`/viewer/?region=monaco&trails=1#${zoom}/${lat}/${lon}`);
  await ready(page);
}
const mapErrors = async (page) => (await page.evaluate(() => window.__rtt)).errors
  .filter((m) => !/Source layer "[^"]+" does not exist on source "openmaptiles"/.test(m));

test('accepted trails render with rtt_id as feature id; quarantined never do', async ({ page, baseURL }) => {
  const problems = audit(page, baseURL);
  await open(page, 13.5, 43.737, 7.4248);
  const rendered = await page.evaluate(() => window.__rtt.renderedTrails());
  const ids = [...new Set(rendered.map((f) => f.rtt_id))].sort();
  expect(ids).toEqual(ACCEPTED);
  for (const f of rendered) expect(f.id).toBe(f.rtt_id);
  for (const q of QUARANTINED) expect(ids).not.toContain(q);
  const attrib = page.locator('.maplibregl-ctrl-attrib');
  await expect(attrib).toContainText('RT&T trail data');
  await expect(attrib.locator('a[href="https://www.openstreetmap.org/copyright"]')).toBeVisible();
  expect([...problems, ...(await mapErrors(page))]).toEqual([]);
});

test('selection is feature-state keyed by rtt_id and clears on reselect', async ({ page }) => {
  await open(page, 15, 43.7325, 7.4215);
  await page.evaluate(() => window.__rtt.selectTrail('rtt-trail-000000000001'));
  expect(await page.evaluate(() => window.__rtt.trailState('rtt-trail-000000000001'))).toEqual({ selected: true });
  await page.evaluate(() => window.__rtt.selectTrail('rtt-trail-000000000003'));
  expect(await page.evaluate(() => window.__rtt.trailState('rtt-trail-000000000001'))).toEqual({ selected: false });
  expect(await page.evaluate(() => window.__rtt.trailState('rtt-trail-000000000003'))).toEqual({ selected: true });
  await page.evaluate(() => window.__rtt.selectTrail(null));
  expect(await page.evaluate(() => window.__rtt.trailState('rtt-trail-000000000003'))).toEqual({ selected: false });
});

// Representative states: all kinds/statuses at overview, labelled detail, a selected trail.
for (const v of [
  { name: 'overview', zoom: 14.5, lat: 43.737, lon: 7.4248 },
  { name: 'detail-labels', zoom: 16.5, lat: 43.7326, lon: 7.4222 },
  { name: 'selected', zoom: 15.5, lat: 43.7436, lon: 7.4161, select: 'rtt-trail-000000000004' },
]) {
  test(`trails ${v.name}`, async ({ page, baseURL }) => {
    const problems = audit(page, baseURL);
    await open(page, v.zoom, v.lat, v.lon);
    if (v.select) {
      await page.evaluate((id) => window.__rtt.selectTrail(id), v.select);
      await ready(page);
    }
    expect([...problems, ...(await mapErrors(page))]).toEqual([]);
    await expect(page).toHaveScreenshot(`rtt-trails-${v.name}.png`);
  });
}
