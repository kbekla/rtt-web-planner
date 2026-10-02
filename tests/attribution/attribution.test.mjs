// Attribution must be correct in the archive, the built style, and the docs.
// (Visible on-map attribution is checked by the render tests.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FACTORY, REPO } from '../../scripts/lib/common.mjs';
import { openArchive, target } from '../lib/archive.mjs';

const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';
const t = target();

function assertOsmAttribution(html, where) {
  assert.match(html, /&copy; OpenStreetMap contributors|© OpenStreetMap contributors/, `${where}: OSM credit`);
  assert.ok(html.includes(`href="${OSM_COPYRIGHT}"`), `${where}: link to ${OSM_COPYRIGHT}`);
  assert.match(html, /OpenMapTiles/, `${where}: OpenMapTiles credit (schema licence)`);
  assert.ok(html.includes('href="https://www.openmaptiles.org/"'), `${where}: link to openmaptiles.org`);
}

test('PMTiles metadata carries OSM + OpenMapTiles attribution', async () => {
  const md = await openArchive(t.pmtilesFile).getMetadata();
  assertOsmAttribution(md.attribution, 'pmtiles metadata');
});

test('built style source attribution matches', () => {
  const style = JSON.parse(fs.readFileSync(path.join(FACTORY, 'assets', 'styles', t.region, 'style.json'), 'utf8'));
  for (const [id, source] of Object.entries(style.sources)) {
    assert.ok(source.attribution, `style source '${id}' has no attribution`);
  }
  assertOsmAttribution(style.sources.openmaptiles.attribution, 'style');
});

test('manifest records data provenance (snapshot + replication time)', () => {
  const osm = t.manifest.inputs.osm;
  assert.match(osm.sha256, /^[0-9a-f]{64}$/);
  assert.ok(osm.source_url.startsWith('https://'));
  assert.ok(!Number.isNaN(Date.parse(osm.replication_timestamp)));
});

test('ATTRIBUTION.md credits every bundled source', () => {
  const doc = fs.readFileSync(path.join(REPO, 'ATTRIBUTION.md'), 'utf8');
  for (const needle of [
    'OpenStreetMap contributors', 'ODbL', OSM_COPYRIGHT,
    'OpenMapTiles', 'CC-BY 4.0',
    'Natural Earth', 'osmdata.openstreetmap.de',
    'OSM Bright', 'Noto', 'SIL Open Font License',
  ]) {
    assert.ok(doc.includes(needle), `ATTRIBUTION.md must mention '${needle}'`);
  }
});
