// Privacy rule: published RT&T trail artefacts follow a strict PUBLIC FIELD
// WHITELIST: features carry rtt_id, name, kind, access + geometry; the manifest
// carries only minimal technical fields. Anything else fails the build. Values
// are not censored. Provenance stays private and local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import * as yaml from 'js-yaml';
import { FACTORY, PLANETILER_JAR, REPO, lonLatToTile } from '../../scripts/lib/common.mjs';
import { openArchive } from '../lib/archive.mjs';
import { PUBLIC_MANIFEST, PUBLIC_TILE_FIELDS, checkPublishable, checkTileProperties, checkWhitelist } from '../../scripts/rtt/publish-check.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-privacy-'));
const fixture = () => JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/rtt/trails-synthetic.geojson'), 'utf8'));
function build(fc, name) {
  const input = path.join(tmp, `${name}.geojson`);
  fs.writeFileSync(input, JSON.stringify(fc));
  const out = path.join(tmp, name);
  const r = spawnSync('node', [path.join(REPO, 'scripts/rtt/build-trails.mjs'), input, '--out', out], { encoding: 'utf8' });
  return { ...r, out, priv: `${out}-private` };
}

test('whitelist: only rtt_id, name, kind, access; rider-facing text is never censored', () => {
  assert.deepEqual(PUBLIC_TILE_FIELDS, ['rtt_id', 'name', 'kind', 'access']);
  assert.deepEqual(checkTileProperties({ rtt_id: 'rtt-trail-000000000001', name: 'Council Verified TET Source Lane', kind: 'byway', access: 'open' }, 't'), []);
  for (const k of ['status', 'surface', 'version', 'provenance', 'source', 'notes', 'evidence', 'confidence'])
    assert.match(checkTileProperties({ rtt_id: 'x', [k]: 'v' }, 't').join(), new RegExp(`non-public tile field '${k}'`));
});

test('manifest whitelist: minimal technical fields only', () => {
  const ok = { build_id: 'a', layer: 'rtt-trails', created_at: 'now', tile_fields: PUBLIC_TILE_FIELDS,
    features: { count: 1, rtt_ids: ['rtt-trail-000000000001'] }, output: { file: 'f', bytes: 1, sha256: 'h', header: {} } };
  assert.deepEqual(checkWhitelist(ok, PUBLIC_MANIFEST, 'm'), []);
  assert.match(checkWhitelist({ ...ok, sources: [] }, PUBLIC_MANIFEST, 'm').join(), /non-public field '\$\.sources'/);
  assert.match(checkWhitelist({ ...ok, features: { ...ok.features, quarantined: 2 } }, PUBLIC_MANIFEST, 'm').join(), /\$\.features\.quarantined/);
});

test('the guard catches an extra field in a real Planetiler archive', async () => {
  // Build directly with a profile that leaks `surface`, bypassing the build script's projection.
  const fc = fixture();
  fc.features = fc.features.slice(0, 2).map((f) => ({ ...f, properties: { rtt_id: f.properties.rtt_id, kind: f.properties.kind, surface: 'gravel' } }));
  const input = path.join(tmp, 'leak.geojson');
  fs.writeFileSync(input, JSON.stringify(fc));
  const profile = path.join(tmp, 'leak.yml');
  fs.writeFileSync(profile, fs.readFileSync(path.join(REPO, 'config/rtt/rtt-trails.planetiler.yml'), 'utf8')
    .replaceAll('@INPUT@', input).replace('          - key: access', '          - key: access\n          - key: surface'));
  const pm = path.join(tmp, 'leak.pmtiles');
  const r = spawnSync('java', ['-Xmx512m', '-jar', PLANETILER_JAR, 'generate-custom', `--schema=${profile}`, `--output=${pm}`, '--force',
    `--tmpdir=${path.join(tmp, 'pt')}`, '--maxzoom=14'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const check = await checkPublishable(pm);
  assert.match(check.errors.join('\n'), /non-public field 'surface'/);
  assert.match(check.errors.join('\n'), /non-public tile field 'surface'/);
});

test('the trail build under test passes the whitelist (tiles, metadata, manifest)', async (t) => {
  const dir = path.join(FACTORY, 'output', 'rtt-trails', process.env.RTT_TRAILS_BUILD_ID || 'current');
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) return t.skip(`no trail build at ${dir}`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['manifest.json', 'rtt-trails.pmtiles'], 'public output: archive + public manifest only');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const r = await checkPublishable(path.join(dir, 'rtt-trails.pmtiles'), { manifest });
  assert.deepEqual(r.errors, []);
  assert.ok(r.tiles > 0);
});

test('a legitimate name with words like verified/council/TET publishes unchanged', async () => {
  const fc = fixture();
  fc.features[0].properties.name = 'Council Verified TET Source Lane';
  const r = build(fc, 'words');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(r.out).sort(), ['manifest.json', 'rtt-trails.pmtiles']);
  for (const f of ['build-record.json', 'quarantine.json', 'build.log']) assert.ok(fs.existsSync(path.join(r.priv, f)), `private ${f}`);
  const { x, y } = lonLatToTile(7.4205, 43.7322, 14);
  const res = await openArchive(path.join(r.out, 'rtt-trails.pmtiles')).getZxy(14, x, y);
  let data = Buffer.from(res.data);
  if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
  const tile = new VectorTile(new PbfReader(data));
  const names = Array.from({ length: tile.layers.rtt_trails.length }, (_, i) => tile.layers.rtt_trails.feature(i).properties.name);
  assert.ok(names.includes('Council Verified TET Source Lane'));
});

test('real sources never live in the repo; nothing private or staged is tracked', () => {
  const repoSources = yaml.load(fs.readFileSync(path.join(REPO, 'config/rtt/sources.yaml'), 'utf8')).sources;
  for (const [id, s] of Object.entries(repoSources)) assert.deepEqual(s.methods, ['synthetic'], `repo source '${id}' must be synthetic`);
  const tracked = spawnSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).stdout;
  assert.doesNotMatch(tracked, /(^|\/)(private|staging)\//m);
});

test('the server cannot reach private or staging data', async () => {
  const port = 8300 + Math.floor(Math.random() * 500);
  const srv = spawn('node', [path.join(REPO, 'scripts/serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/viewer/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    for (const p of ['/private/rtt/sources.yaml', '/assets/../private/rtt/sources.yaml', '/tiles/../private/x',
      '/tiles/rtt-trails-private.pmtiles', '/staging/rtt-trails/', '/assets/%2e%2e/private/rtt/sources.yaml',
      '/scout/candidates/synthetic-private.json', '/assets/../scout/candidates/synthetic-private.json',
      '/tiles/%2e%2e/scout/candidates/synthetic-private.json']) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 404, p);
    }
  } finally {
    srv.kill();
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
