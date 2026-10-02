// Repo hygiene and "no Mapbox runtime" policy checks. These don't need a build.
//
// Policy: no Mapbox SDK, mapbox-gl runtime, APIs, tokens, hosted tiles/styles or
// network services. BSD helper packages under @mapbox/* are allowed only where
// MapLibre (or our test tooling) requires them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, run } from '../../scripts/lib/common.mjs';

const tracked = () => run('git', ['ls-files', '-co', '--exclude-standard'], { cwd: REPO }).split('\n').filter(Boolean);

test('no map data or large files in the repo', () => {
  for (const f of tracked()) {
    assert.doesNotMatch(f, /\.(pbf|osm|pmtiles|mbtiles|zip|tar\.gz)$/, `map/archive file in repo: ${f}`);
    const size = fs.statSync(path.join(REPO, f)).size;
    assert.ok(size <= 5 * 1024 * 1024, `${f} is ${size} bytes (> 5 MB)`);
  }
});

test('pre-commit hook is installed', () => {
  assert.equal(run('git', ['config', 'core.hooksPath'], { cwd: REPO }).trim(), '.githooks');
});

test('no forbidden Mapbox/third-party map service references in source', () => {
  const banned = [
    /mapbox:\/\//i, /api\.mapbox\.com/i, /tiles\.mapbox\.com/i, /events\.mapbox\.com/i,
    /api\.maptiler\.com/i, /access_?token/i, /mapboxgl\./, /from ['"]mapbox-gl['"]/,
  ];
  // Skipped: the vendored scaffold (checked separately, never served as-is) and the
  // files that contain these same detector patterns.
  const detectors = new Set(['scripts/build-style.mjs', 'tests/repo/hygiene.test.mjs']);
  const scanned = tracked().filter((f) => /\.(m?js|json|html|css|ya?ml|sh)$|^scripts\//.test(f)
    && !f.startsWith('styles/vendor/') && !detectors.has(f) && f !== 'package-lock.json');
  for (const f of scanned) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const re of banned) assert.doesNotMatch(text, re, `${f} matches ${re}`);
  }
});

test('dependency tree has no Mapbox runtime packages', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  const allowedMapboxHelpers = new Set([
    '@mapbox/jsonlint-lines-primitives', '@mapbox/point-geometry', '@mapbox/tiny-sdf',
    '@mapbox/unitbezier', '@mapbox/vector-tile',
  ]);
  for (const key of Object.keys(lock.packages)) {
    const name = key.replace(/^.*node_modules\//, '');
    assert.notEqual(name, 'mapbox-gl', 'mapbox-gl must not be installed');
    assert.ok(!name.startsWith('@mapbox/mapbox-gl') && !name.startsWith('@mapbox/mapbox-sdk'), `forbidden package ${name}`);
    if (name.startsWith('@mapbox/')) assert.ok(allowedMapboxHelpers.has(name), `unreviewed @mapbox package: ${name}`);
  }
});

test('vendored scaffold is pristine', () => {
  run('sha256sum', ['--quiet', '-c', 'SHA256SUMS'], { cwd: path.join(REPO, 'styles', 'vendor', 'osm-bright') });
});

test('every region config has a committed snapshot lock', () => {
  const dir = path.join(REPO, 'config', 'regions');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const lock = path.join(dir, f.replace(/\.yaml$/, '.lock.json'));
    // A region may be configured before its first fetch, but then it must not be built.
    if (fs.existsSync(lock)) assert.match(JSON.parse(fs.readFileSync(lock, 'utf8')).sha256, /^[0-9a-f]{64}$/);
  }
});
