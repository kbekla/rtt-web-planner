#!/usr/bin/env node
// Build the OpenMapTiles basemap for a region from its pinned snapshot.
//
//   $FACTORY_DIR/output/<region>/<build-id>/<region>.pmtiles
//                                          /manifest.json
//                                          /build.log
//
// The build ID is a hash of everything that determines the output (region config,
// snapshot, ancillary inputs, pinned tools, Planetiler arguments), so identical
// inputs always map to the same directory. Promotion to `current` is a separate
// step (scripts/promote-region) that only happens after the tests pass.
//
// usage: scripts/build-region.mjs <region> [--force] [--out <dir>] [--threads N]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  ANCILLARY_DIR, FACTORY, PLANETILER_JAR, PMTILES_BIN, REPO,
  canonicalJson, loadRegion, loadRegionLock, readTable, regionConfigPath, run, sha256, sha256File,
} from './lib/common.mjs';

const argv = process.argv.slice(2);
const region = argv[0];
const opt = (name) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
if (!region || region.startsWith('-')) {
  console.error('usage: build-region.mjs <region> [--force] [--out <dir>] [--threads N]');
  process.exit(2);
}
const force = argv.includes('--force');
const threads = Number(opt('--threads') || process.env.PLANETILER_THREADS || os.cpus().length);

const cfg = loadRegion(region);
const lock = loadRegionLock(region);
const log = (msg) => console.log(`[build-region ${region}] ${msg}`);

// --- verify pinned inputs -------------------------------------------------
const snapshot = path.join(FACTORY, 'sources', 'osm', region, lock.file);
if (!fs.existsSync(snapshot)) throw new Error(`snapshot missing: ${snapshot} (run scripts/fetch-region.mjs ${region})`);
log(`verifying snapshot ${lock.file}`);
if (sha256File(snapshot) !== lock.sha256) throw new Error(`snapshot ${snapshot} does not match lock sha256`);

const ancillaryLock = readTable(path.join(REPO, 'config', 'ancillary.lock'));
const ancillary = {};
for (const [file, sha] of ancillaryLock) {
  const p = path.join(ANCILLARY_DIR, file);
  if (!fs.existsSync(p)) throw new Error(`ancillary input missing: ${p}`);
  log(`verifying ${file}`);
  if (sha256File(p) !== sha) throw new Error(`ancillary ${p} does not match config/ancillary.lock`);
  ancillary[file] = sha;
}

const toolsLock = fs.readFileSync(path.join(REPO, 'tools.lock'), 'utf8');
const planetilerSha = readTable(path.join(REPO, 'tools.lock')).find(([n]) => n === 'planetiler')[2];
if (sha256File(PLANETILER_JAR) !== planetilerSha) throw new Error('planetiler.jar does not match tools.lock (run scripts/fetch-tools)');
const javaVersion = spawnSync('java', ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0];

// --- build identity -------------------------------------------------------
// Arguments that affect output. Paths are expressed relative to logical roots so
// the ID doesn't depend on where the factory lives.
const outputArgs = {
  maxzoom: cfg.maxzoom,
  minzoom: 0,
  tile_compression: 'gzip',
  tile_format: 'mvt',
  ...(cfg.planetiler?.args ?? {}),
};
const buildId = sha256(canonicalJson({
  region_config: fs.readFileSync(regionConfigPath(region), 'utf8'),
  snapshot_sha256: lock.sha256,
  ancillary,
  tools_lock: toolsLock,
  java: javaVersion,
  output_args: outputArgs,
})).slice(0, 16);

const outDir = path.resolve(opt('--out') || path.join(FACTORY, 'output', region, buildId));
const pmtiles = path.join(outDir, `${region}.pmtiles`);
if (fs.existsSync(path.join(outDir, 'manifest.json')) && !force) {
  log(`build ${buildId} already exists (use --force to rebuild)`);
  console.log(outDir);
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
const tmpDir = path.join(FACTORY, 'scratch', `${region}-${buildId}-${process.pid}`);
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

// --- run Planetiler -------------------------------------------------------
const heap = cfg.planetiler?.heap || process.env.PLANETILER_HEAP || '8g';
const args = [
  `-Xmx${heap}`,
  '-jar', PLANETILER_JAR,
  'openmaptiles',
  `--osm_path=${snapshot}`,
  `--natural_earth_path=${path.join(ANCILLARY_DIR, 'natural_earth_vector.sqlite.zip')}`,
  `--water_polygons_path=${path.join(ANCILLARY_DIR, 'water-polygons-split-3857.zip')}`,
  `--lake_centerlines_path=${path.join(ANCILLARY_DIR, 'lake_centerline.shp.zip')}`,
  `--tile_weights=${path.join(ANCILLARY_DIR, 'tile_weights.tsv.gz')}`,
  '--download=false',
  '--fetch_wikidata=false',
  `--tmpdir=${tmpDir}`,
  `--output=${pmtiles}`,
  `--threads=${threads}`,
  '--force',
  ...Object.entries(outputArgs).map(([k, v]) => `--${k}=${v}`),
];
log(`build ${buildId}: planetiler (heap ${heap}, ${threads} threads) -> ${pmtiles}`);
const logFile = path.join(outDir, 'build.log');
const logFd = fs.openSync(logFile, 'w');
const started = Date.now();
// /usr/bin/time reports peak RSS on its last stderr line. Scratch disk usage is
// sampled while Planetiler runs (it doesn't report its own peak).
const dirBytes = (dir) => Number(spawnSync('du', ['-sb', dir], { encoding: 'utf8' }).stdout.split('\t')[0]) || 0;
let peakScratchBytes = 0;
const sampler = setInterval(() => { peakScratchBytes = Math.max(peakScratchBytes, dirBytes(tmpDir)); }, 5000);
const res = await new Promise((resolve) => {
  const child = spawn('/usr/bin/time', ['-f', 'PEAK_RSS_KB=%M', 'java', ...args], {
    cwd: tmpDir,
    stdio: ['ignore', logFd, logFd],
  });
  child.on('close', (status) => resolve({ status }));
});
clearInterval(sampler);
fs.closeSync(logFd);
const seconds = (Date.now() - started) / 1000;
fs.rmSync(tmpDir, { recursive: true, force: true });
const logText = fs.readFileSync(logFile, 'utf8');
if (res.status !== 0) {
  console.error(logText.split('\n').slice(-40).join('\n'));
  throw new Error(`planetiler failed (exit ${res.status}); full log: ${logFile}`);
}
const peakRssKb = Number(/PEAK_RSS_KB=(\d+)/.exec(logText)?.[1]);
// Planetiler's "data errors" summary (e.g. boundary relations clipped by the extract edge).
const dataErrors = {};
const errorBlock = logText.split('data errors:')[1]?.split('-----')[0] ?? '';
for (const m of errorBlock.matchAll(/\t(\w+)\t([\d,]+)/g)) dataErrors[m[1]] = Number(m[2].replaceAll(',', ''));

// --- integrity + manifest -------------------------------------------------
log('pmtiles verify');
run(PMTILES_BIN, ['verify', pmtiles]);
const header = JSON.parse(run(PMTILES_BIN, ['show', pmtiles, '--header-json']));
const metadata = JSON.parse(run(PMTILES_BIN, ['show', pmtiles, '--metadata']));

const git = (a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }).stdout.trim();
const manifest = {
  build_id: buildId,
  region,
  created_at: new Date().toISOString(),
  repo: { commit: git(['rev-parse', 'HEAD']) || null, dirty: git(['status', '--porcelain']) !== '' },
  inputs: {
    osm: lock,
    ancillary,
  },
  tools: {
    lock: readTable(path.join(REPO, 'tools.lock')).map(([name, version, sha]) => ({ name, version, sha256: sha })),
    java: javaVersion,
  },
  planetiler: { heap, threads, output_args: outputArgs },
  output: {
    file: path.basename(pmtiles),
    bytes: fs.statSync(pmtiles).size,
    sha256: sha256File(pmtiles),
    header,
    metadata: {
      name: metadata.name,
      version: metadata.version,
      attribution: metadata.attribution,
      layers: (metadata.vector_layers ?? []).map((l) => l.id).sort(),
    },
    pmtiles_verify: 'ok',
  },
  stats: { seconds, peak_rss_kb: peakRssKb, peak_scratch_bytes: peakScratchBytes, data_errors: dataErrors },
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
log(`done in ${seconds.toFixed(1)}s, ${manifest.output.bytes} bytes, peak RSS ${(peakRssKb / 1024).toFixed(0)} MB, peak scratch ${(peakScratchBytes / 2 ** 20).toFixed(0)} MB`);
log(`sha256 ${manifest.output.sha256}`);
console.log(outDir);
