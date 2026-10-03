#!/usr/bin/env node
// Build the proprietary RT&T trail layer into its own PMTiles archive.
//
//   $FACTORY_DIR/output/rtt-trails/<build-id>/rtt-trails.pmtiles
//                                            /manifest.json
//                                            /quarantine.json   (features held for licensing review)
//                                            /build.log
//
// 1. Validate the input against the RT&T contract (scripts/rtt/validate.mjs).
//    Any hard error aborts the build. Quarantined features are reported and
//    never built.
// 2. Write the accepted features in canonical form (sorted by rtt_id, sorted
//    keys, provenance stripped), so the same accepted set always gives the same
//    bytes regardless of input order.
// 3. Build ID = hash of: canonical accepted features, schema, source registry,
//    Planetiler profile, pinned planetiler.jar, Java version, output arguments.
// 4. Planetiler generate-custom -> PMTiles -> pmtiles verify -> manifest.
//
// usage: scripts/rtt/build-trails.mjs <features.geojson> [--out <dir>] [--threads N] [--force]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FACTORY, PLANETILER_JAR, PMTILES_BIN, REPO, canonicalJson, readTable, run, sha256, sha256File } from '../lib/common.mjs';
import { loadContract, validate } from './validate.mjs';

export const RTT_BUILD_SCHEME = 1;
// z0-16: z16 is Planetiler's maximum; viewers overzoom for z17+. Trail visibility by
// zoom belongs to the style, not the tiles.
export const OUTPUT_ARGS = { minzoom: 0, maxzoom: 16, tile_compression: 'gzip', tile_format: 'mvt' };
const PROFILE = path.join(REPO, 'config', 'rtt', 'rtt-trails.planetiler.yml');

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const input = argv[0];
if (!input || input.startsWith('-')) { console.error('usage: build-trails.mjs <features.geojson> [--out dir] [--threads N] [--force]'); process.exit(2); }
const threads = Number(opt('--threads') || os.cpus().length);
const log = (m) => console.log(`[build-trails] ${m}`);

// --- 1. validate ----------------------------------------------------------
const fc = JSON.parse(fs.readFileSync(input, 'utf8'));
const contract = loadContract();
const v = validate(fc, contract);
for (const q of v.quarantined) log(`QUARANTINED ${q.rtt_id}: ${q.reasons.join('; ')}`);
if (v.errors.length) {
  for (const e of v.errors) console.error(`[build-trails] ERROR ${e}`);
  console.error(`[build-trails] ${v.errors.length} error(s); nothing built`);
  process.exit(1);
}
if (!v.accepted.length) { console.error('[build-trails] no accepted features; nothing built'); process.exit(1); }

// --- 2. canonical accepted features ---------------------------------------
const TILE_KEYS = ['rtt_id', 'kind', 'status', 'surface', 'name', 'version'];
const canonical = {
  type: 'FeatureCollection',
  features: v.accepted
    .map((f) => ({
      type: 'Feature',
      properties: Object.fromEntries(TILE_KEYS.filter((k) => f.properties[k] !== undefined).map((k) => [k, f.properties[k]])),
      geometry: { type: f.geometry.type, coordinates: f.geometry.coordinates },
    }))
    .sort((a, b) => a.properties.rtt_id.localeCompare(b.properties.rtt_id)),
};
const canonicalText = canonicalJson(canonical);

// --- 3. build identity -----------------------------------------------------
const [, planetilerVersion, planetilerSha] = readTable(path.join(REPO, 'tools.lock')).find(([n]) => n === 'planetiler');
if (sha256File(PLANETILER_JAR) !== planetilerSha) throw new Error('planetiler.jar does not match tools.lock');
const java = spawnSync('java', ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0];
const inputs = {
  scheme: RTT_BUILD_SCHEME,
  accepted_features_sha256: sha256(canonicalText),
  schema_sha256: sha256File(path.join(REPO, 'schema', 'rtt-trails.schema.json')),
  sources_sha256: sha256File(path.join(REPO, 'config', 'rtt', 'sources.yaml')),
  profile_sha256: sha256File(PROFILE),
  planetiler: { version: planetilerVersion, sha256: planetilerSha },
  java,
  output_args: OUTPUT_ARGS,
};
const buildId = sha256(canonicalJson(inputs)).slice(0, 16);
const outDir = path.resolve(opt('--out') || path.join(FACTORY, 'output', 'rtt-trails', buildId));
const pmtiles = path.join(outDir, 'rtt-trails.pmtiles');
if (fs.existsSync(path.join(outDir, 'manifest.json')) && !argv.includes('--force')) {
  log(`build ${buildId} already exists`);
  console.log(outDir);
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'quarantine.json'), JSON.stringify(
  v.quarantined.map(({ rtt_id, reasons, feature }) => ({ rtt_id, reasons, provenance: feature.properties.provenance })), null, 2) + '\n');

// --- 4. Planetiler -----------------------------------------------------------
const work = path.join(FACTORY, 'scratch', `rtt-trails-${buildId}-${process.pid}`);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
try {
  const accepted = path.join(work, 'accepted.geojson');
  fs.writeFileSync(accepted, canonicalText);
  const profile = path.join(work, 'profile.yml');
  fs.writeFileSync(profile, fs.readFileSync(PROFILE, 'utf8').replaceAll('@INPUT@', accepted));
  log(`build ${buildId}: ${v.accepted.length} accepted, ${v.quarantined.length} quarantined -> ${pmtiles}`);
  const started = Date.now();
  const res = spawnSync('java', ['-Xmx1g', '-jar', PLANETILER_JAR, 'generate-custom', `--schema=${profile}`,
    `--output=${pmtiles}`, '--force', `--threads=${threads}`, `--tmpdir=${path.join(work, 'tmp')}`,
    ...Object.entries(OUTPUT_ARGS).map(([k, val]) => `--${k}=${val}`)], { cwd: work, encoding: 'utf8', maxBuffer: 64 << 20 });
  fs.writeFileSync(path.join(outDir, 'build.log'), (res.stdout ?? '') + (res.stderr ?? ''));
  if (res.status !== 0) throw new Error(`planetiler failed (exit ${res.status}); see ${path.join(outDir, 'build.log')}`);
  run(PMTILES_BIN, ['verify', pmtiles]);
  const header = JSON.parse(run(PMTILES_BIN, ['show', pmtiles, '--header-json']));
  const metadata = JSON.parse(run(PMTILES_BIN, ['show', pmtiles, '--metadata']));
  const git = (a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const sources = [...new Set(v.accepted.map((f) => f.properties.provenance.source))].sort();
  const manifest = {
    build_id: buildId,
    layer: 'rtt-trails',
    created_at: new Date().toISOString(),
    repo: { commit: git(['rev-parse', 'HEAD']) || null, dirty: git(['status', '--porcelain']) !== '' },
    build_id_inputs: inputs,
    input: { file: path.resolve(input), sha256: sha256File(input) },
    features: {
      accepted: v.accepted.length,
      quarantined: v.quarantined.length,
      accepted_ids: canonical.features.map((f) => f.properties.rtt_id),
      sources: sources.map((id) => ({ id, licence: contract.sources[id].licence, attribution: contract.sources[id].attribution })),
      contains_synthetic: v.accepted.some((f) => f.properties.provenance.method === 'synthetic'),
    },
    planetiler: { threads, output_args: OUTPUT_ARGS },
    output: {
      file: path.basename(pmtiles),
      bytes: fs.statSync(pmtiles).size,
      sha256: sha256File(pmtiles),
      header,
      metadata: { name: metadata.name, attribution: metadata.attribution, layers: (metadata.vector_layers ?? []).map((l) => l.id) },
      pmtiles_verify: 'ok',
    },
    stats: { seconds: (Date.now() - started) / 1000 },
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`done: ${manifest.output.bytes} bytes, sha256 ${manifest.output.sha256}`);
  console.log(outDir);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
