// Shared helpers for pipeline scripts and tests.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Keep in sync with config/pipeline.env (used by the shell scripts).
export const FACTORY = process.env.FACTORY_DIR || path.join(os.homedir(), 'rtt-map-factory');
export const TOOLS = path.join(FACTORY, 'tools');
export const PMTILES_BIN = path.join(TOOLS, 'bin', 'pmtiles');
export const PLANETILER_JAR = path.join(TOOLS, 'planetiler.jar');
export const ANCILLARY_DIR = path.join(FACTORY, 'sources', 'ancillary');

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(8 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** JSON with sorted keys, so hashes don't depend on key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function regionConfigPath(region) {
  return path.join(REPO, 'config', 'regions', `${region}.yaml`);
}

export function regionLockPath(region) {
  return path.join(REPO, 'config', 'regions', `${region}.lock.json`);
}

export function loadRegion(region) {
  if (!/^[a-z0-9-]+$/.test(region)) throw new Error(`invalid region name: ${region}`);
  const file = regionConfigPath(region);
  if (!fs.existsSync(file)) throw new Error(`no region config: ${file}`);
  const cfg = yaml.load(fs.readFileSync(file, 'utf8'));
  for (const key of ['name', 'source', 'bbox', 'maxzoom', 'probes', 'views']) {
    if (cfg[key] === undefined) throw new Error(`${file}: missing '${key}'`);
  }
  if (cfg.name !== region) throw new Error(`${file}: name '${cfg.name}' != '${region}'`);
  return cfg;
}

export function loadRegionLock(region) {
  const file = regionLockPath(region);
  if (!fs.existsSync(file)) {
    throw new Error(`no snapshot lock for '${region}'; run: scripts/fetch-region ${region}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Parse a whitespace-separated lock file, skipping comments. */
export function readTable(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/));
}

export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status}):\n${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

/** Directory of the build under test/serve: output/<region>/<RTT_BUILD_ID or 'current'>. */
export function buildDir(region) {
  const id = process.env.RTT_BUILD_ID || 'current';
  if (!/^(current|[0-9a-f]{16})$/.test(id)) throw new Error(`invalid RTT_BUILD_ID: ${id}`);
  return path.join(FACTORY, 'output', region, id);
}

export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { z, x, y };
}
