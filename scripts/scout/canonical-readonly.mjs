// Explicit-input, read-only bridge to the RT&T canonical master.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { matchMaster } from './core.mjs';

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

/**
 * Load an explicitly supplied master for matching only. No fallback/default
 * path exists, and the returned API has no write operation.
 */
export function openCanonicalMasterReadOnly(masterPath) {
  if (typeof masterPath !== 'string' || !masterPath.trim()) throw new Error('canonical master path must be supplied explicitly');
  const absolutePath = path.resolve(masterPath);
  let fd;
  try { fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch (error) { throw new Error(`cannot open explicit canonical master read-only: ${error.message}`); }
  let bytes;
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error('canonical master input must be a regular file');
    bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error('canonical master changed while it was being read');
  } finally { fs.closeSync(fd); }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`canonical master is not valid JSON: ${error.message}`); }
  if (document?.type !== 'FeatureCollection' || !Array.isArray(document.features)) throw new Error('canonical master must be a GeoJSON FeatureCollection');
  if (document.features.length !== 14315) throw new Error(`canonical master feature count ${document.features.length} != expected 14315`);
  const ids = new Set();
  for (const feature of document.features) {
    const id = feature?.properties?.rtt_id;
    if (typeof id !== 'string' || !id.trim()) throw new Error('canonical master feature is missing rtt_id');
    if (ids.has(id)) throw new Error(`canonical master contains duplicate rtt_id: ${id}`);
    ids.add(id);
  }
  const features = deepFreeze(document.features);
  return Object.freeze({
    source_path: absolutePath,
    feature_count: features.length,
    sha256,
    match(candidate, thresholds = {}) {
      return matchMaster(candidate, features, thresholds);
    },
  });
}
