// Privacy rule: published RT&T trail artefacts carry rider-facing data only
// (rtt_id, name, kind = legal classification, status = access status, geometry).
// Provenance, sources, research and licence notes stay private and local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { FACTORY, REPO } from '../../scripts/lib/common.mjs';
import { PUBLIC_TILE_FIELDS, checkPublishable, checkTileProperties, scanJson } from '../../scripts/rtt/publish-check.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-privacy-'));
const fixture = () => JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/rtt/trails-synthetic.geojson'), 'utf8'));
const STYLE_KEYS = new Set(['source', 'source-layer', 'source_id']);

function build(fc, name) {
  const input = path.join(tmp, `${name}.geojson`);
  fs.writeFileSync(input, JSON.stringify(fc));
  const out = path.join(tmp, name);
  const r = spawnSync('node', [path.join(REPO, 'scripts/rtt/build-trails.mjs'), input, '--out', out], { encoding: 'utf8' });
  return { ...r, out, priv: `${out}-private` };
}

test('the guard rejects every class of sensitive field or text', () => {
  assert.deepEqual(PUBLIC_TILE_FIELDS, ['rtt_id', 'name', 'kind', 'status']);
  assert.deepEqual(checkTileProperties({ rtt_id: 'rtt-trail-000000000001', name: 'Ridge Lane', kind: 'byway', status: 'open' }, 't'), []);
  for (const [props, re] of [
    [{ surface: 'gravel' }, /non-public tile field 'surface'/],
    [{ provenance: 'x' }, /non-public tile field 'provenance'/],
    [{ name: 'Verified lane' }, /sensitive text/],
    [{ name: 'grm-87' }, /sensitive text/],
    [{ name: 'TrailVidz route 12' }, /sensitive text/],
    [{ name: 'Wiltshire Council PRoW' }, /sensitive text/],
    [{ name: 'see https://example.org' }, /sensitive text/],
  ]) assert.match(checkTileProperties(props, 't').join(), re, JSON.stringify(props));
  for (const [obj, re] of [
    [{ source: 'x' }, /sensitive key/],
    [{ licence: 'OGL' }, /sensitive key/],
    [{ a: { research_notes: 'x' } }, /sensitive key/],
    [{ a: ['evidence photo 3'] }, /sensitive value/],
    [{ confidence_method: 'x' }, /sensitive key/],
  ]) assert.match(scanJson(obj, 'j').join(), re, JSON.stringify(obj));
});

test('the trail build under test passes the guard (tiles, metadata, manifest, style)', async (t) => {
  // The build being tested (pipeline-trails sets it) or, by default, the promoted one.
  const dir = path.join(FACTORY, 'output', 'rtt-trails', process.env.RTT_TRAILS_BUILD_ID || 'current');
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) return t.skip(`no trail build at ${dir}`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['manifest.json', 'rtt-trails.pmtiles'], 'public output must hold only the archive and its public manifest');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const r = await checkPublishable(path.join(dir, 'rtt-trails.pmtiles'), { 'public manifest': manifest });
  assert.deepEqual(r.errors, []);
  assert.ok(r.tiles > 0);
  const style = path.join(FACTORY, 'assets', 'styles', 'rtt-trails.json');
  if (fs.existsSync(style)) assert.deepEqual(scanJson(JSON.parse(fs.readFileSync(style, 'utf8')), 'trail style', STYLE_KEYS), []);
});

test('a build whose output would leak research text fails and publishes nothing', () => {
  const fc = fixture();
  fc.features[0].properties.name = 'Verified lane';
  const r = build(fc, 'leak');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /publish check failed/);
  assert.ok(!fs.existsSync(r.out), 'public output must be deleted');
  const rec = JSON.parse(fs.readFileSync(path.join(r.priv, 'build-record.json'), 'utf8'));
  assert.match(rec.publish_check.errors.join(), /sensitive text in 'name'/);
});

test('a clean build publishes only the archive and a rider-facing manifest', () => {
  const r = build(fixture(), 'clean');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(r.out).sort(), ['manifest.json', 'rtt-trails.pmtiles']);
  const m = JSON.parse(fs.readFileSync(path.join(r.out, 'manifest.json'), 'utf8'));
  assert.deepEqual(scanJson(m, 'manifest'), []);
  assert.deepEqual(m.tile_fields, PUBLIC_TILE_FIELDS);
  for (const f of ['build-record.json', 'quarantine.json', 'build.log']) assert.ok(fs.existsSync(path.join(r.priv, f)), `private ${f}`);
});

test('real sources never live in the repo; the repo registry is synthetic only', () => {
  const repoSources = yaml.load(fs.readFileSync(path.join(REPO, 'config/rtt/sources.yaml'), 'utf8')).sources;
  for (const [id, s] of Object.entries(repoSources)) {
    assert.deepEqual(s.methods, ['synthetic'], `repo source '${id}' must be synthetic; real sources belong in the private registry`);
    assert.match(id, /synthetic/, id);
  }
  const tracked = spawnSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).stdout;
  assert.doesNotMatch(tracked, /private\/|staging\//, 'private or staging data is tracked by git');
});

test('the server cannot reach private or staging data', async () => {
  const port = 8300 + Math.floor(Math.random() * 500);
  const srv = spawn('node', [path.join(REPO, 'scripts/serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/viewer/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    for (const p of ['/private/rtt/sources.yaml', '/assets/../private/rtt/sources.yaml', '/tiles/../private/x',
      '/tiles/rtt-trails-private.pmtiles', '/staging/rtt-trails/', '/assets/%2e%2e/private/rtt/sources.yaml']) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(res.status, 404, p);
    }
  } finally {
    srv.kill();
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
