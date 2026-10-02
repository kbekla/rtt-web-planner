#!/usr/bin/env node
// Download an OSM extract for a region, verify it, and store it as an immutable
// snapshot: $FACTORY_DIR/sources/osm/<region>/<replication-date>-<sha12>.osm.pbf
// The snapshot is pinned in config/regions/<region>.lock.json (committed).
//
// usage: scripts/fetch-region.mjs <region> [--refresh]
//   Without --refresh, an existing lock is only verified (never re-downloaded),
//   because "-latest" upstream URLs move and cannot reproduce an old snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { FACTORY, loadRegion, regionLockPath, run, sha256File } from './lib/common.mjs';

const [region, flag] = process.argv.slice(2);
if (!region) {
  console.error('usage: fetch-region.mjs <region> [--refresh]');
  process.exit(2);
}
const cfg = loadRegion(region);
const lockFile = regionLockPath(region);
const dir = path.join(FACTORY, 'sources', 'osm', region);
fs.mkdirSync(dir, { recursive: true });

if (fs.existsSync(lockFile) && flag !== '--refresh') {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const file = path.join(dir, lock.file);
  if (!fs.existsSync(file)) {
    console.error(`snapshot ${file} is missing. Restore it from backup, or run with --refresh to pin a new one.`);
    process.exit(1);
  }
  const got = sha256File(file);
  if (got !== lock.sha256) {
    console.error(`snapshot ${file} sha256 ${got} != lock ${lock.sha256}`);
    process.exit(1);
  }
  console.log(`ok   ${region} snapshot ${lock.file} (pinned, verified)`);
  process.exit(0);
}

const part = path.join(dir, 'download.part');
console.log(`download ${cfg.source.url}`);
run('curl', ['-fL', '--retry', '3', '--progress-bar', '-o', part, cfg.source.url], { stdio: ['ignore', 'inherit', 'inherit'] });

const md5Expected = run('curl', ['-fsSL', cfg.source.md5_url]).trim().split(/\s+/)[0];
const md5 = run('md5sum', [part]).split(' ')[0];
if (md5 !== md5Expected) {
  fs.rmSync(part);
  throw new Error(`md5 mismatch: got ${md5}, upstream says ${md5Expected}`);
}

const info = JSON.parse(run('osmium', ['fileinfo', '-j', '-F', 'pbf', part]));
const opts = info.header?.option ?? {};
const replicationTime = opts.osmosis_replication_timestamp;
if (!replicationTime) throw new Error('extract has no osmosis_replication_timestamp header');
const sha = sha256File(part);
const file = `${replicationTime.slice(0, 10)}-${sha.slice(0, 12)}.osm.pbf`;
fs.renameSync(part, path.join(dir, file));

const lock = {
  region,
  file,
  sha256: sha,
  md5,
  bytes: fs.statSync(path.join(dir, file)).size,
  source_url: cfg.source.url,
  replication_timestamp: replicationTime,
  replication_sequence: opts.osmosis_replication_sequence_number ?? null,
  replication_url: opts.osmosis_replication_base_url ?? null,
  fetched_at: new Date().toISOString(),
};
fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
console.log(`ok   ${region} snapshot ${file} (${lock.bytes} bytes, data as of ${replicationTime})`);
console.log(`     pinned in ${path.relative(process.cwd(), lockFile)} — commit it.`);
