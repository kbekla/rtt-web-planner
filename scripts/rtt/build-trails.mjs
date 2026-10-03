#!/usr/bin/env node
// Build the proprietary RT&T trail layer into its own PMTiles archive.
//
// PUBLIC (rider-facing only; checked by scripts/rtt/publish-check.mjs):
//   $FACTORY_DIR/output/rtt-trails/<build-id>/rtt-trails.pmtiles
//                                            /manifest.json       (build id, hash, rtt_id list)
// PRIVATE (local to RT&T; never served, published or committed):
//   $FACTORY_DIR/private/rtt-trails/<build-id>/build-record.json  (inputs, sources, counts)
//                                             /quarantine.json    (features held for licensing review)
//                                             /build.log
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
// usage: scripts/rtt/build-trails.mjs <features.geojson> [--out <dir>] [--private <dir>] [--threads N] [--force]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FACTORY, PLANETILER_JAR, PMTILES_BIN, REPO, canonicalJson, readTable, run, sha256, sha256File } from '../lib/common.mjs';
import { loadContract, validate } from './validate.mjs';
import { PUBLIC_TILE_FIELDS, checkPublishable } from './publish-check.mjs';

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
// Only the public, rider-facing fields go into the tiles.
const canonical = {
  type: 'FeatureCollection',
  features: v.accepted
    .map((f) => ({
      type: 'Feature',
      properties: Object.fromEntries(PUBLIC_TILE_FIELDS.filter((k) => f.properties[k] !== undefined).map((k) => [k, f.properties[k]])),
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
  // Hash of the whole registry in use (repo + private); names stay private.
  sources_sha256: sha256(canonicalJson(contract.sources)),
  profile_sha256: sha256File(PROFILE),
  planetiler: { version: planetilerVersion, sha256: planetilerSha },
  java,
  output_args: OUTPUT_ARGS,
};
const buildId = sha256(canonicalJson(inputs)).slice(0, 16);
const outDir = path.resolve(opt('--out') || path.join(FACTORY, 'output', 'rtt-trails', buildId));
const privDir = path.resolve(opt('--private') || (opt('--out') ? `${outDir}-private` : path.join(FACTORY, 'private', 'rtt-trails', buildId)));
const pmtiles = path.join(outDir, 'rtt-trails.pmtiles');
if (fs.existsSync(path.join(outDir, 'manifest.json')) && !argv.includes('--force')) {
  log(`build ${buildId} already exists`);
  console.log(outDir);
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(privDir, { recursive: true });
fs.writeFileSync(path.join(privDir, 'quarantine.json'), JSON.stringify(
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
  fs.writeFileSync(path.join(privDir, 'build.log'), (res.stdout ?? '') + (res.stderr ?? ''));
  if (res.status !== 0) throw new Error(`planetiler failed (exit ${res.status}); see ${path.join(privDir, 'build.log')}`);
  run(PMTILES_BIN, ['verify', pmtiles]);
  const header = JSON.parse(run(PMTILES_BIN, ['show', pmtiles, '--header-json']));
  const metadata = JSON.parse(run(PMTILES_BIN, ['show', pmtiles, '--metadata']));
  const output = { file: path.basename(pmtiles), bytes: fs.statSync(pmtiles).size, sha256: sha256File(pmtiles), header };

  // Public manifest: rider-facing facts only.
  const publicManifest = {
    build_id: buildId,
    layer: 'rtt-trails',
    created_at: new Date().toISOString(),
    tile_fields: PUBLIC_TILE_FIELDS,
    features: { count: v.accepted.length, rtt_ids: canonical.features.map((f) => f.properties.rtt_id) },
    output,
  };

  // Publish guard: every tile, the archive metadata and the public manifest.
  const check = await checkPublishable(pmtiles, { 'public manifest': publicManifest });
  const git = (a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const sources = [...new Set(v.accepted.map((f) => f.properties.provenance.source))].sort();
  const record = {
    ...publicManifest,
    repo: { commit: git(['rev-parse', 'HEAD']) || null, dirty: git(['status', '--porcelain']) !== '' },
    build_id_inputs: inputs,
    input: { file: path.resolve(input), sha256: sha256File(input) },
    quarantined: v.quarantined.length,
    sources: sources.map((id) => ({ id, licence: contract.sources[id].licence, attribution: contract.sources[id].attribution })),
    contains_synthetic: v.accepted.some((f) => f.properties.provenance.method === 'synthetic'),
    planetiler: { threads, output_args: OUTPUT_ARGS, metadata: { name: metadata.name, attribution: metadata.attribution } },
    publish_check: { tiles_checked: check.tiles, errors: check.errors },
    stats: { seconds: (Date.now() - started) / 1000 },
  };
  fs.writeFileSync(path.join(privDir, 'build-record.json'), JSON.stringify(record, null, 2) + '\n');
  if (check.errors.length) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    for (const e of check.errors.slice(0, 20)) console.error(`[build-trails] PUBLISH CHECK ${e}`);
    console.error(`[build-trails] publish check failed (${check.errors.length} problem(s)); public output deleted, details in ${privDir}`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(publicManifest, null, 2) + '\n');
  log(`done: ${output.bytes} bytes, sha256 ${output.sha256}; publish check passed (${check.tiles} tiles); private record ${privDir}`);
  console.log(outDir);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
