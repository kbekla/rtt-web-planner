#!/usr/bin/env node
// Reproducibility check: rebuild a region from the same pinned inputs with a
// different thread count into scratch, and require a byte-identical PMTiles file.
// usage: scripts/check-repro.mjs <region>   (checks RTT_BUILD_ID or current)
import fs from 'node:fs';
import path from 'node:path';
import { FACTORY, REPO, buildDir, run, sha256File } from './lib/common.mjs';

const region = process.argv[2];
if (!region) { console.error('usage: check-repro.mjs <region>'); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(path.join(buildDir(region), 'manifest.json'), 'utf8'));
const threads = Math.max(1, Math.floor(manifest.planetiler.threads / 2));
const out = path.join(FACTORY, 'scratch', `repro-${region}-${manifest.build_id}`);
fs.rmSync(out, { recursive: true, force: true });
try {
  const dir = run('node', [path.join(REPO, 'scripts', 'build-region.mjs'), region, '--out', out, '--threads', String(threads)],
    { stdio: ['ignore', 'pipe', 'inherit'] }).trim().split('\n').pop();
  const rebuilt = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const same = rebuilt.build_id === manifest.build_id && sha256File(path.join(dir, `${region}.pmtiles`)) === manifest.output.sha256;
  console.log(`build ${manifest.build_id} (${manifest.planetiler.threads} threads) vs rebuild (${threads} threads): ${same ? 'IDENTICAL' : 'DIFFERENT'}`);
  console.log(`  original ${manifest.output.sha256}\n  rebuild  ${rebuilt.output.sha256}`);
  process.exitCode = same ? 0 : 1;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
