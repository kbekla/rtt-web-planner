// mapwatch and failure preservation against a throwaway fixture factory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from '../../scripts/lib/common.mjs';
import { createSampler } from '../../scripts/lib/telemetry.mjs';

const factory = fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-mapwatch-'));
const write = (rel, body) => {
  const p = path.join(factory, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
};
// A pid that certainly isn't running any more.
const deadPid = spawnSync('true').pid;
const t0 = '2026-10-02T12:00:00.000Z';

write('output/r1/aaaaaaaaaaaaaaaa/manifest.json', {
  build_id: 'aaaaaaaaaaaaaaaa', build_id_scheme: 2, created_at: t0,
  inputs: { osm: { file: 'snap.osm.pbf' } }, output: { bytes: 1234, sha256: 'f'.repeat(64) },
  stats: { seconds: 10, peak_rss_kb: 2048, peak_scratch_bytes: 99, telemetry: { peak: { cpu_temp_c: 70 }, sampler_cost_ms: 5 } },
});
write('output/r1/aaaaaaaaaaaaaaaa/status.json', { region: 'r1', state: 'succeeded', stage: 'done', pid: deadPid, started_at: t0 });
fs.symlinkSync('aaaaaaaaaaaaaaaa', path.join(factory, 'output/r1/current'));
write('output/r1/bbbbbbbbbbbbbbbb/status.json', { region: 'r1', state: 'running', stage: 'planetiler', pid: process.pid, started_at: t0 });
write('output/r1/bbbbbbbbbbbbbbbb/build.log', '0:01:00 INF [osm_pass1] - Finished in 1s\n0:02:00 INF [osm_pass2:process] - nodes: [ 45% ]\n');
write('output/r1/bbbbbbbbbbbbbbbb/telemetry.jsonl', `${JSON.stringify({ t: 1, cpu_temp_c: 80, mem_used_mb: 5 })}\n`);
write('output/r1/cccccccccccccccc/status.json', { region: 'r1', state: 'running', stage: 'planetiler', pid: deadPid, started_at: t0 });
write('output/r1/cccccccccccccccc/build.log', 'line one\nlast words\n');
write('output/r1/dddddddddddddddd/status.json', { region: 'r1', state: 'failed', stage: 'verify-output', pid: deadPid,
  started_at: t0, error: 'pmtiles verify failed', log_tail: 'x\ny' });
write('state/pipeline-r1.json', { region: 'r1', state: 'running', step: 'tests-render', pid: deadPid, started_at: t0 });
write('logs/failures/2026-10-01T00-00-00-000Z-r1-eeeeeeeeeeeeeeee/status.json',
  { region: 'r1', build_id: 'eeeeeeeeeeeeeeee', state: 'failed', stage: 'planetiler', error: 'OOM', log_tail: 'OutOfMemoryError' });

/** Hash of every file outside reports/: mapwatch must not change any of them. */
function treeHash() {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (path.relative(factory, p) === 'reports') continue;
      h.update(p);
      if (e.isSymbolicLink()) h.update(fs.readlinkSync(p));
      else if (e.isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
    }
  };
  walk(factory);
  return h.digest('hex');
}

const mapwatch = (...args) => spawnSync('node', [path.join(REPO, 'scripts', 'mapwatch.mjs'), ...args],
  { encoding: 'utf8', env: { ...process.env, FACTORY_DIR: factory } });

test('status --json reports build, pipeline and failure states', () => {
  const res = mapwatch('status', '--json');
  assert.equal(res.status, 0, res.stderr);
  const s = JSON.parse(res.stdout);
  const r1 = s.regions.find((r) => r.region === 'r1');
  const by = Object.fromEntries(r1.builds.map((b) => [b.id, b]));
  assert.equal(r1.current, 'aaaaaaaaaaaaaaaa');
  assert.equal(by.aaaaaaaaaaaaaaaa.state, 'succeeded');
  assert.equal(by.aaaaaaaaaaaaaaaa.promoted, true);
  assert.equal(by.aaaaaaaaaaaaaaaa.stats.peaks.cpu_temp_c, 70);
  assert.equal(by.bbbbbbbbbbbbbbbb.state, 'running');
  assert.equal(by.bbbbbbbbbbbbbbbb.planetiler.stage, 'osm_pass2');
  assert.equal(by.bbbbbbbbbbbbbbbb.telemetry.cpu_temp_c, 80);
  assert.equal(by.cccccccccccccccc.state, 'aborted', 'running status with a dead pid is aborted');
  assert.deepEqual(by.cccccccccccccccc.log_tail, ['line one', 'last words']);
  assert.equal(by.dddddddddddddddd.state, 'failed');
  assert.equal(by.dddddddddddddddd.error, 'pmtiles verify failed');
  assert.equal(r1.pipeline.state, 'aborted');
  assert.equal(s.failures.length, 1);
  assert.equal(s.failures[0].error, 'OOM');
});

test('output is deterministic apart from the timestamp and live host readings', () => {
  const strip = (out) => { const s = JSON.parse(out); delete s.generated_at; delete s.host; for (const r of s.regions) for (const b of r.builds) delete b.elapsed_s; return s; };
  assert.deepEqual(strip(mapwatch('status', '--json').stdout), strip(mapwatch('status', '--json').stdout));
});

test('report writes JSON + Markdown and changes nothing else', () => {
  const before = treeHash();
  const res = mapwatch('report');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(treeHash(), before, 'mapwatch modified the factory outside reports/');
  const md = fs.readFileSync(path.join(factory, 'reports', 'latest.md'), 'utf8');
  assert.match(md, /aborted/);
  assert.match(md, /pmtiles verify failed/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(factory, 'reports', 'latest.json'), 'utf8')).regions);
});

test('watch --until-idle exits once nothing is running', () => {
  fs.rmSync(path.join(factory, 'output/r1/bbbbbbbbbbbbbbbb'), { recursive: true });
  const res = spawnSync('node', [path.join(REPO, 'scripts', 'mapwatch.mjs'), 'watch', '--until-idle', '--interval', '1'],
    { encoding: 'utf8', env: { ...process.env, FACTORY_DIR: factory }, timeout: 20_000 });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /cccccccccccccccc aborted/);
});

test('build-region preserves a failed attempt', () => {
  const res = spawnSync('node', [path.join(REPO, 'scripts', 'build-region.mjs'), 'no-such-region'],
    { encoding: 'utf8', env: { ...process.env, FACTORY_DIR: factory } });
  assert.notEqual(res.status, 0);
  const dirs = fs.readdirSync(path.join(factory, 'logs', 'failures')).filter((d) => d.endsWith('-no-such-region-preflight'));
  assert.equal(dirs.length, 1);
  const st = JSON.parse(fs.readFileSync(path.join(factory, 'logs', 'failures', dirs[0], 'status.json'), 'utf8'));
  assert.equal(st.state, 'failed');
  assert.match(st.error, /no region config/);
});

test('telemetry sampler returns numbers or nulls and never throws', () => {
  const { sample } = createSampler();
  const s = sample(null);
  for (const key of ['cpu_temp_c', 'nvme_temp_c', 'mem_used_mb', 'swap_used_mb', 'load1']) {
    assert.ok(s[key] === null || typeof s[key] === 'number', `${key}: ${s[key]}`);
  }
});

test.after(() => fs.rmSync(factory, { recursive: true, force: true }));
