// Build identity covers exactly the tile-producing inputs (no build needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, loadRegion } from '../../scripts/lib/common.mjs';
import { buildIdOf, checkConfigKeys, tileInputs } from '../../scripts/lib/build-id.mjs';

const clone = (v) => structuredClone(v);
const base = {
  cfg: loadRegion('monaco'),
  snapshot: 'a'.repeat(64),
  ancillary: { 'water-polygons-split-3857.zip': 'b'.repeat(64) },
  planetiler: { version: 'v0.10.2', sha256: 'c'.repeat(64) },
  java: 'openjdk version "21.0.12.1" 2026-08-18',
};
const idWith = (mutate) => { const b = clone(base); mutate(b); return buildIdOf(tileInputs(b)); };
const baseId = buildIdOf(tileInputs(base));

test('test-only and resource settings do not change the build ID', () => {
  for (const [what, mutate] of [
    ['probes', (b) => { b.cfg.probes.push({ name: 'x', lon: 0, lat: 0, z: 1 }); }],
    ['views', (b) => { b.cfg.views[0].zoom += 1; }],
    ['bbox', (b) => { b.cfg.bbox[0] -= 1; }],
    ['required_layers', (b) => { b.cfg.required_layers.pop(); }],
    ['title', (b) => { b.cfg.title = 'Renamed'; }],
    ['source url', (b) => { b.cfg.source.url = 'https://example.invalid/x.pbf'; }],
    ['planetiler.heap', (b) => { b.cfg.planetiler.heap = '16g'; }],
  ]) {
    assert.equal(idWith(mutate), baseId, `${what} must not affect the build ID`);
  }
});

test('every tile-producing input changes the build ID', () => {
  for (const [what, mutate] of [
    ['region name', (b) => { b.cfg.name = 'other'; }],
    ['maxzoom', (b) => { b.cfg.maxzoom = 15; }],
    ['planetiler.args', (b) => { b.cfg.planetiler.args = { simplify_tolerance_at_max_zoom: 0.1 }; }],
    ['snapshot', (b) => { b.snapshot = 'd'.repeat(64); }],
    ['ancillary', (b) => { b.ancillary['water-polygons-split-3857.zip'] = 'e'.repeat(64); }],
    ['planetiler jar', (b) => { b.planetiler.sha256 = 'f'.repeat(64); }],
    ['planetiler version', (b) => { b.planetiler.version = 'v0.10.3'; }],
    ['java', (b) => { b.java = 'openjdk version "22"'; }],
  ]) {
    assert.notEqual(idWith(mutate), baseId, `${what} must change the build ID`);
  }
});

test('unclassified region config keys are rejected', () => {
  assert.throws(() => checkConfigKeys({ ...base.cfg, simplify: 1 }), /unclassified key 'simplify'/);
  assert.throws(() => checkConfigKeys({ ...base.cfg, planetiler: { heap: '1g', storage: 'mmap' } }),
    /unclassified key 'planetiler.storage'/);
});

test('every committed region config is fully classified', () => {
  const dir = path.join(REPO, 'config', 'regions');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
    checkConfigKeys(loadRegion(f.replace(/\.yaml$/, '')), f);
  }
});
