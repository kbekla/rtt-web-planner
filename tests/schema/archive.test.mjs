// PMTiles integrity + OpenMapTiles schema conformance for a region build.
//   RTT_REGION=monaco RTT_BUILD_ID=<id|current> node --test tests/schema
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PMTILES_BIN, REPO, lonLatToTile, run, sha256File } from '../../scripts/lib/common.mjs';
import { openArchive, readTile, target } from '../lib/archive.mjs';

const t = target();
const archive = openArchive(t.pmtilesFile);
const omt = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', `openmaptiles-${t.manifest.output.metadata.version}.json`), 'utf8'));
const overrides = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', `openmaptiles-${omt.version}.overrides.json`), 'utf8'));
for (const [key, { values }] of Object.entries(overrides.extra_values)) {
  const [layer, field] = key.split('.');
  omt.layers[layer].fields[field].values.push(...values);
}
for (const key of Object.keys(overrides.open_fields)) {
  const [layer, field] = key.split('.');
  delete omt.layers[layer].fields[field].values;
}
const languages = new Set(omt.languages);

test('output matches manifest checksum', () => {
  assert.equal(sha256File(t.pmtilesFile), t.manifest.output.sha256);
});

test('pmtiles verify passes', () => {
  run(PMTILES_BIN, ['verify', t.pmtilesFile]);
});

test('header: MVT, gzip, z0..maxzoom, bounds inside region bbox', async () => {
  const h = await archive.getHeader();
  assert.equal(h.tileType, 1, 'tile type must be MVT');
  assert.equal(h.tileCompression, 2, 'tile compression must be gzip');
  assert.equal(h.minZoom, 0);
  assert.equal(h.maxZoom, t.config.maxzoom);
  const [w, s, e, n] = t.config.bbox;
  assert.ok(h.minLon >= w && h.minLat >= s && h.maxLon <= e && h.maxLat <= n,
    `header bounds ${[h.minLon, h.minLat, h.maxLon, h.maxLat]} outside region bbox ${t.config.bbox}`);
  assert.ok(h.numAddressedTiles > 0);
});

test('metadata: OMT schema version and layer set', async () => {
  const md = await archive.getMetadata();
  assert.equal(md.version, omt.version, 'archive OMT version must match the pinned schema');
  const layers = md.vector_layers.map((l) => l.id);
  for (const id of layers) assert.ok(id in omt.layers, `unexpected layer '${id}' not in OMT ${omt.version}`);
  for (const id of t.config.required_layers ?? []) assert.ok(layers.includes(id), `required layer '${id}' missing`);
});

function checkFeature(layerName, props, where) {
  const spec = omt.layers[layerName];
  assert.ok(spec, `${where}: unknown layer '${layerName}'`);
  for (const [key, value] of Object.entries(props)) {
    if (spec.localized_names && (key === 'name:latin' || key === 'name:nonlatin' || key === 'name_int')) continue;
    if (spec.localized_names && key.startsWith('name:') && languages.has(key.slice(5))) continue;
    const field = spec.fields[key];
    assert.ok(field, `${where}: layer '${layerName}' has field '${key}' not in OMT ${omt.version}`);
    if (field.values) {
      assert.ok(field.values.includes(String(value)),
        `${where}: ${layerName}.${key}='${value}' not in allowed values`);
    }
  }
}

test('probe tiles contain expected layers and classes, all fields conform', async () => {
  for (const probe of t.config.probes) {
    const { z, x, y } = lonLatToTile(probe.lon, probe.lat, probe.z);
    const where = `probe ${probe.name} ${z}/${x}/${y}`;
    const tile = await readTile(archive, z, x, y);
    assert.ok(tile, `${where}: tile is empty`);
    for (const layer of probe.layers ?? []) {
      assert.ok(tile[layer]?.length > 0, `${where}: expected layer '${layer}' (has: ${Object.keys(tile).join(', ')})`);
    }
    for (const want of probe.contains ?? []) {
      const classes = [want.class].flat();
      const hit = (tile[want.layer] ?? []).some((f) => classes.includes(f.properties.class)
        && (!want.name || f.properties.name === want.name));
      assert.ok(hit, `${where}: no ${want.layer} feature with class ${classes}${want.name ? ` named '${want.name}'` : ''}`);
    }
    for (const [layer, features] of Object.entries(tile)) {
      for (const f of features) checkFeature(layer, f.properties, where);
    }
  }
});

test('sampled tiles across all zooms conform to the schema', async () => {
  const h = await archive.getHeader();
  const perZoom = Number(process.env.RTT_SAMPLES_PER_ZOOM || 64);
  let decoded = 0;
  for (let z = h.minZoom; z <= h.maxZoom; z++) {
    const a = lonLatToTile(h.minLon, h.maxLat, z);
    const b = lonLatToTile(h.maxLon, h.minLat, z);
    const cols = b.x - a.x + 1;
    const total = cols * (b.y - a.y + 1);
    const stride = Math.max(1, Math.floor(total / perZoom));
    for (let i = 0; i < total; i += stride) {
      const x = a.x + (i % cols);
      const y = a.y + Math.floor(i / cols);
      const tile = await readTile(archive, z, x, y);
      if (!tile) continue;
      decoded++;
      for (const [layer, features] of Object.entries(tile)) {
        for (const f of features) checkFeature(layer, f.properties, `sample ${z}/${x}/${y}`);
      }
    }
  }
  assert.ok(decoded > 0, 'no tiles decoded');
});
