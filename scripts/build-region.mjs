#!/usr/bin/env node
// Build the OpenMapTiles basemap for a region from its pinned snapshot.
//
//   $FACTORY_DIR/output/<region>/<build-id>/<region>.pmtiles
//                                          /manifest.json    (written last, only on success)
//                                          /build.log        (Planetiler output)
//                                          /status.json      (live state, read by mapwatch)
//                                          /telemetry.jsonl  (host samples during Planetiler)
//
// The build ID is a hash of the tile-producing inputs only (scripts/lib/build-id.mjs):
// snapshot, ancillary inputs, the pinned Planetiler jar, Java and output arguments.
// Test probes, views and resource settings are excluded, so editing them doesn't
// force a rebuild. Promotion to `current` is a separate step (scripts/promote-region)
// that only happens after the tests pass.
//
// A failed or interrupted attempt is copied to $FACTORY_DIR/logs/failures/ before
// anything can overwrite it.
//
// usage: scripts/build-region.mjs <region> [--force] [--out <dir>] [--threads N]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  ANCILLARY_DIR, FACTORY, PLANETILER_JAR, PMTILES_BIN, REPO,
  loadRegion, loadRegionLock, readTable, run, sha256File,
} from './lib/common.mjs';
import { buildIdOf, tileInputs } from './lib/build-id.mjs';
import { startTelemetry } from './lib/telemetry.mjs';

const argv = process.argv.slice(2);
const region = argv[0];
const opt = (name) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
if (!region || region.startsWith('-')) {
  console.error('usage: build-region.mjs <region> [--force] [--out <dir>] [--threads N]');
  process.exit(2);
}
const force = argv.includes('--force');
const threads = Number(opt('--threads') || process.env.PLANETILER_THREADS || os.cpus().length);
const log = (msg) => console.log(`[build-region ${region}] ${msg}`);

// --- status + failure preservation ----------------------------------------
let outDir = null;
let buildId = null;
let status = { region, build_id: null, state: 'running', stage: 'verify-inputs', pid: process.pid,
  started_at: new Date().toISOString() };

function writeStatus(patch) {
  status = { ...status, ...patch, updated_at: new Date().toISOString() };
  if (outDir) fs.writeFileSync(path.join(outDir, 'status.json'), JSON.stringify(status, null, 2) + '\n');
}

const tail = (file, lines = 60) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').slice(-lines - 1).join('\n') : '');

/** Copy an attempt's status and logs to logs/failures/<ts>-<region>-<id>/. */
function preserveAttempt(dir, st) {
  const stamp = (st.updated_at || st.started_at || new Date().toISOString()).replace(/[:.]/g, '-');
  const dest = path.join(FACTORY, 'logs', 'failures', `${stamp}-${st.region}-${st.build_id ?? 'preflight'}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'status.json'), JSON.stringify(st, null, 2) + '\n');
  for (const f of ['build.log', 'telemetry.jsonl']) {
    if (dir && fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(dest, f));
  }
  return dest;
}

function fail(error, exitCode = 1) {
  const logFile = outDir && path.join(outDir, 'build.log');
  writeStatus({ state: 'failed', error: String(error?.message ?? error), exit_code: exitCode,
    log_tail: logFile ? tail(logFile) : '' });
  const dest = preserveAttempt(outDir, status);
  console.error(`[build-region ${region}] FAILED at stage '${status.stage}': ${status.error}`);
  console.error(`[build-region ${region}] preserved in ${dest}`);
  process.exit(exitCode);
}
let child = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child?.kill(sig);
    fail(`interrupted by ${sig}`, 130);
  });
}

try {
  // --- verify pinned inputs -----------------------------------------------
  const cfg = loadRegion(region);
  const lock = loadRegionLock(region);
  const snapshot = path.join(FACTORY, 'sources', 'osm', region, lock.file);
  if (!fs.existsSync(snapshot)) throw new Error(`snapshot missing: ${snapshot} (run scripts/fetch-region.mjs ${region})`);
  log(`verifying snapshot ${lock.file}`);
  if (sha256File(snapshot) !== lock.sha256) throw new Error(`snapshot ${snapshot} does not match lock sha256`);

  const ancillary = {};
  for (const [file, sha] of readTable(path.join(REPO, 'config', 'ancillary.lock'))) {
    const p = path.join(ANCILLARY_DIR, file);
    if (!fs.existsSync(p)) throw new Error(`ancillary input missing: ${p}`);
    log(`verifying ${file}`);
    if (sha256File(p) !== sha) throw new Error(`ancillary ${p} does not match config/ancillary.lock`);
    ancillary[file] = sha;
  }

  const toolsLock = readTable(path.join(REPO, 'tools.lock'));
  const [, planetilerVersion, planetilerSha] = toolsLock.find(([n]) => n === 'planetiler');
  if (sha256File(PLANETILER_JAR) !== planetilerSha) throw new Error('planetiler.jar does not match tools.lock (run scripts/fetch-tools)');
  const javaVersion = spawnSync('java', ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0];

  // --- build identity -----------------------------------------------------
  const inputs = tileInputs({
    cfg,
    snapshot: lock.sha256,
    ancillary,
    planetiler: { version: planetilerVersion, sha256: planetilerSha },
    java: javaVersion,
  });
  buildId = buildIdOf(inputs);
  status.build_id = buildId;

  outDir = path.resolve(opt('--out') || path.join(FACTORY, 'output', region, buildId));
  const pmtiles = path.join(outDir, `${region}.pmtiles`);
  if (fs.existsSync(path.join(outDir, 'manifest.json')) && !force) {
    log(`build ${buildId} already exists (use --force to rebuild)`);
    console.log(outDir);
    process.exit(0);
  }
  fs.mkdirSync(outDir, { recursive: true });
  // An earlier attempt left no manifest: it failed or was killed. Keep its evidence.
  const prevStatus = path.join(outDir, 'status.json');
  if (fs.existsSync(prevStatus) && !fs.existsSync(path.join(outDir, 'manifest.json'))) {
    const prev = JSON.parse(fs.readFileSync(prevStatus, 'utf8'));
    if (prev.state === 'running') prev.state = 'aborted';
    log(`previous attempt (${prev.state}) preserved in ${preserveAttempt(outDir, prev)}`);
  }
  writeStatus({ stage: 'planetiler' });

  const tmpDir = path.join(FACTORY, 'scratch', `${region}-${buildId}-${process.pid}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // --- run Planetiler -----------------------------------------------------
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
    ...Object.entries(inputs.output_args).map(([k, v]) => `--${k}=${v}`),
  ];
  log(`build ${buildId}: planetiler (heap ${heap}, ${threads} threads) -> ${pmtiles}`);
  const logFile = path.join(outDir, 'build.log');
  const logFd = fs.openSync(logFile, 'w');
  // /usr/bin/time reports peak RSS on its last stderr line; host telemetry
  // (temperatures, GPU, RAM/swap, scratch disk) is sampled alongside.
  const telemetry = startTelemetry({ file: path.join(outDir, 'telemetry.jsonl'), scratchDir: tmpDir });
  const res = await new Promise((resolve) => {
    child = spawn('/usr/bin/time', ['-f', 'PEAK_RSS_KB=%M', 'java', ...args], {
      cwd: tmpDir,
      stdio: ['ignore', logFd, logFd],
    });
    writeStatus({ child_pid: child.pid });
    child.on('close', (code) => resolve({ status: code }));
  });
  child = null;
  const tel = telemetry.stop();
  fs.closeSync(logFd);
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

  // --- integrity + manifest -----------------------------------------------
  writeStatus({ stage: 'verify-output' });
  log('pmtiles verify');
  run(PMTILES_BIN, ['verify', pmtiles]);
  const header = JSON.parse(run(PMTILES_BIN, ['show', pmtiles, '--header-json']));
  const metadata = JSON.parse(run(PMTILES_BIN, ['show', pmtiles, '--metadata']));

  writeStatus({ stage: 'manifest' });
  const git = (a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const manifest = {
    build_id: buildId,
    build_id_scheme: inputs.scheme,
    region,
    created_at: new Date().toISOString(),
    repo: { commit: git(['rev-parse', 'HEAD']) || null, dirty: git(['status', '--porcelain']) !== '' },
    // Everything the build ID hashes. Nothing else can change the tiles.
    build_id_inputs: inputs,
    inputs: {
      osm: lock,
      ancillary,
    },
    tools: {
      lock: toolsLock.map(([name, version, sha]) => ({ name, version, sha256: sha })),
      java: javaVersion,
    },
    planetiler: { heap, threads, output_args: inputs.output_args },
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
    stats: {
      seconds: tel.elapsed_s,
      peak_rss_kb: peakRssKb,
      peak_scratch_bytes: tel.peak.scratch_bytes ?? null,
      data_errors: dataErrors,
      telemetry: tel,
    },
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeStatus({ state: 'succeeded', stage: 'done', exit_code: 0, finished_at: new Date().toISOString() });
  const p = tel.peak;
  log(`done in ${tel.elapsed_s}s, ${manifest.output.bytes} bytes, peak RSS ${(peakRssKb / 1024).toFixed(0)} MB, `
    + `peak scratch ${((p.scratch_bytes ?? 0) / 2 ** 20).toFixed(0)} MB`);
  log(`peaks: CPU ${p.cpu_temp_c ?? '-'}°C, NVMe ${p.nvme_temp_c ?? '-'}°C, iGPU ${p.igpu_temp_c ?? '-'}°C, `
    + `dGPU ${p.dgpu_temp_c ?? '-'}°C, RAM ${p.mem_used_mb ?? '-'} MB, swap ${p.swap_used_mb ?? '-'} MB `
    + `(${tel.samples} samples, sampler ${tel.sampler_cost_ms} ms)`);
  log(`sha256 ${manifest.output.sha256}`);
  console.log(outDir);
} catch (err) {
  fail(err);
}
