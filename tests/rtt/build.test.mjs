// RT&T trail layer build: content, reproducibility, stable diffs, and separation
// from the OpenStreetMap basemap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { FACTORY, REPO, lonLatToTile } from '../../scripts/lib/common.mjs';
import { openArchive } from '../lib/archive.mjs';

const FIXTURE = path.join(REPO, 'tests/fixtures/rtt/trails-synthetic.geojson');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-trails-'));
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

function build(fc, name, ...args) {
  const input = path.join(tmp, `${name}.geojson`);
  fs.writeFileSync(input, JSON.stringify(fc));
  const out = path.join(tmp, name);
  const priv = `${out}-private`;
  const r = spawnSync('node', [path.join(REPO, 'scripts/rtt/build-trails.mjs'), input, '--out', out, ...args], { encoding: 'utf8' });
  const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
  return { ...r, out, priv, manifest: read(path.join(out, 'manifest.json')), record: read(path.join(priv, 'build-record.json')) };
}

/** Decode every tile covering `bbox` at z0..16: { 'z/x/y': { rtt_id: canonical feature string } }. */
async function decodeAll(file, bbox = [7.40, 43.72, 7.44, 43.75]) {
  const archive = openArchive(file);
  const out = {};
  for (let z = 0; z <= 16; z++) {
    const a = lonLatToTile(bbox[0], bbox[3], z);
    const b = lonLatToTile(bbox[2], bbox[1], z);
    for (let x = a.x; x <= b.x; x++) {
      for (let y = a.y; y <= b.y; y++) {
        const res = await archive.getZxy(z, x, y);
        if (!res) continue;
        let data = Buffer.from(res.data);
        if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
        const tile = new VectorTile(new PbfReader(data));
        const feats = {};
        for (const [layer, l] of Object.entries(tile.layers)) {
          for (let i = 0; i < l.length; i++) {
            const f = l.feature(i);
            const key = f.properties.rtt_id ?? `${layer}#${i}`;
            feats[key] = JSON.stringify({ layer, props: f.properties, geom: f.loadGeometry().map((r) => r.map((p) => [p.x, p.y])) });
          }
        }
        out[`${z}/${x}/${y}`] = feats;
      }
    }
  }
  return out;
}

const base = build(fixture(), 'base');

test('build: accepted features only, quarantine reported privately, one RT&T layer', async () => {
  assert.equal(base.status, 0, base.stderr);
  const m = base.manifest;
  const r = base.record;
  assert.equal(m.features.count, 4);
  assert.equal(r.quarantined, 2);
  assert.equal(r.contains_synthetic, true);
  assert.deepEqual(r.publish_check.errors, []);
  assert.deepEqual([m.output.header.minzoom, m.output.header.maxzoom], [0, 16]);
  assert.deepEqual(fs.readdirSync(base.out), ['manifest.json', 'rtt-trails.pmtiles'], 'public output holds only the archive and its public manifest');
  const q = JSON.parse(fs.readFileSync(path.join(base.priv, 'quarantine.json'), 'utf8'));
  assert.deepEqual(q.map((x) => x.rtt_id).sort(), ['rtt-trail-0000000000a1', 'rtt-trail-0000000000a2']);
  assert.ok(q.every((x) => x.reasons.length && x.provenance));
  const tiles = await decodeAll(path.join(base.out, 'rtt-trails.pmtiles'));
  const ids = new Set(Object.values(tiles).flatMap((t) => Object.keys(t)));
  assert.deepEqual([...ids].sort(), m.features.rtt_ids);
  assert.ok(!ids.has('rtt-trail-0000000000a1') && !ids.has('rtt-trail-0000000000a2'), 'quarantined feature reached the tiles');
  for (const t of Object.values(tiles)) {
    for (const s of Object.values(t)) {
      const f = JSON.parse(s);
      assert.equal(f.layer, 'rtt_trails');
      assert.deepEqual(Object.keys(f.props).filter((k) => !['rtt_id', 'name', 'kind', 'status'].includes(k)), [],
        'tiles may carry only rtt_id, name, kind and status');
    }
  }
});

test('reproducible: same bytes with fewer threads and with shuffled input order', () => {
  const threads = build(fixture(), 'threads', '--threads', '2');
  const fc = fixture(); fc.features.reverse();
  const shuffled = build(fc, 'shuffled');
  assert.equal(threads.manifest.output.sha256, base.manifest.output.sha256);
  assert.equal(shuffled.manifest.build_id, base.manifest.build_id, 'input order must not change the build ID');
  assert.equal(shuffled.manifest.output.sha256, base.manifest.output.sha256);
});

test('stable diff: editing one feature changes only that feature', async () => {
  const fc = fixture();
  const edited = fc.features.find((f) => f.properties.rtt_id === 'rtt-trail-000000000002');
  edited.geometry.coordinates[1] = [7.4324, 43.7393];
  edited.properties.version += 1;
  edited.properties.name = 'Synthetic Cycle Lane';
  const b = build(fc, 'edited');
  assert.equal(b.status, 0, b.stderr);
  assert.notEqual(b.manifest.build_id, base.manifest.build_id);
  const before = await decodeAll(path.join(base.out, 'rtt-trails.pmtiles'));
  const after = await decodeAll(path.join(b.out, 'rtt-trails.pmtiles'));
  const changed = new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const x = before[key] ?? {};
    const y = after[key] ?? {};
    for (const id of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[id] !== y[id]) changed.add(id);
  }
  assert.deepEqual([...changed], ['rtt-trail-000000000002']);
});

test('invalid input builds nothing', () => {
  const fc = fixture();
  fc.features[1].properties.rtt_id = fc.features[0].properties.rtt_id;
  const r = build(fc, 'dup');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /duplicate rtt_id/);
  assert.equal(r.manifest, null);
  assert.ok(!fs.existsSync(path.join(r.out, 'rtt-trails.pmtiles')));
});

test('separation: RT&T data never in the OSM archives, OSM credit never in RT&T', async (t) => {
  const md = await openArchive(path.join(base.out, 'rtt-trails.pmtiles')).getMetadata();
  assert.doesNotMatch(md.attribution, /OpenStreetMap|OpenMapTiles/i);
  assert.match(md.attribution, /RT&amp;T|RT&T/);
  for (const region of ['monaco', 'uk']) {
    const file = path.join(FACTORY, 'output', region, 'current', `${region}.pmtiles`);
    if (!fs.existsSync(file)) { t.diagnostic(`no promoted ${region} build`); continue; }
    const osm = await openArchive(file).getMetadata();
    assert.ok(!osm.vector_layers.some((l) => l.id === 'rtt_trails'), `${region}: rtt_trails layer in the OSM archive`);
    // Every tile around the fixture area: no rtt_id property anywhere.
    const tiles = await decodeAll(file);
    const leaked = Object.entries(tiles).filter(([, f]) => Object.values(f).some((s) => JSON.parse(s).props.rtt_id !== undefined));
    assert.deepEqual(leaked.map(([k]) => k), [], `${region}: RT&T features in OSM tiles`);
  }
});

test('ATTRIBUTION.md documents the separate RT&T layer and its licence', () => {
  const doc = fs.readFileSync(path.join(REPO, 'ATTRIBUTION.md'), 'utf8');
  for (const needle of ['RT&T trail layer', 'rtt-trails.pmtiles', 'not derived from OpenStreetMap', 'config/rtt/sources.yaml']) {
    assert.ok(doc.includes(needle), `ATTRIBUTION.md must mention '${needle}'`);
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
