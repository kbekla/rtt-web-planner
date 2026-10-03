// Publish guard for the RT&T trail layer: a strict PUBLIC FIELD WHITELIST.
//
// Published trail artefacts may contain only:
//   features: rtt_id, name, kind (legal classification), access (access status) + geometry
//   manifest: the minimal technical fields in PUBLIC_MANIFEST (build id, hash, id inventory)
//   PMTiles metadata: the keys in PUBLIC_METADATA_KEYS
// Anything else is a build failure. Values are NOT censored: a lane legitimately
// named "Council Verified Byway" is fine. Provenance is excluded by never being
// copied into published artefacts, and this guard proves nothing else got in.
//
// Provenance, sources, evidence and research stay on the private master-data side
// ($FACTORY_DIR/private/...). Hosting receives only the public output.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles } from 'pmtiles';

export const PUBLIC_TILE_FIELDS = ['rtt_id', 'name', 'kind', 'access'];

// Minimal public manifest: key -> nested whitelist (true = any value of a technical field).
export const PUBLIC_MANIFEST = {
  build_id: true,
  layer: true,
  created_at: true,
  tile_fields: true,
  features: { count: true, rtt_ids: true },
  output: { file: true, bytes: true, sha256: true, header: true },
};

export const PUBLIC_METADATA_KEYS = ['name', 'description', 'attribution', 'type', 'vector_layers',
  'planetiler:buildtime', 'planetiler:githash', 'planetiler:version'];

/** Keys not in the whitelist (recursively). */
export function checkWhitelist(obj, allowed, where, p = '$') {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [`${where}: ${p} must be an object`];
  for (const [k, v] of Object.entries(obj)) {
    const rule = allowed[k];
    if (rule === undefined) errors.push(`${where}: non-public field '${p}.${k}'`);
    else if (rule !== true) errors.push(...checkWhitelist(v, rule, where, `${p}.${k}`));
  }
  return errors;
}

/** One decoded feature's properties: only whitelisted fields. */
export function checkTileProperties(props, where) {
  return Object.keys(props).filter((k) => !PUBLIC_TILE_FIELDS.includes(k))
    .map((k) => `${where}: non-public tile field '${k}'`);
}

class FileSource {
  constructor(file) { this.file = file; this.fd = fs.openSync(file, 'r'); }
  getKey() { return this.file; }
  async getBytes(offset, length) {
    const buf = Buffer.alloc(length);
    fs.readSync(this.fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) };
  }
}

/** Check every tile and the metadata of a trail PMTiles archive, plus the public manifest. */
export async function checkPublishable(pmtilesFile, { manifest = null } = {}) {
  const archive = new PMTiles(new FileSource(pmtilesFile));
  const errors = [];
  const md = await archive.getMetadata();
  for (const k of Object.keys(md)) if (!PUBLIC_METADATA_KEYS.includes(k)) errors.push(`pmtiles metadata: non-public key '${k}'`);
  for (const layer of md.vector_layers ?? []) {
    if (layer.id !== 'rtt_trails') errors.push(`pmtiles metadata: unexpected layer '${layer.id}'`);
    for (const f of Object.keys(layer.fields ?? {})) if (!PUBLIC_TILE_FIELDS.includes(f)) errors.push(`pmtiles metadata: non-public field '${f}'`);
  }
  const h = await archive.getHeader();
  const tiles = [];
  const visit = async (offset, length) => {
    for (const e of await archive.cache.getDirectory(archive.source, offset, length, h)) {
      if (e.runLength === 0) await visit(h.leafDirectoryOffset + e.offset, e.length);
      else tiles.push(e);
    }
  };
  await visit(h.rootDirectoryOffset, h.rootDirectoryLength);
  for (const e of tiles) {
    let data = Buffer.from((await archive.source.getBytes(h.tileDataOffset + e.offset, e.length)).data);
    if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
    const t = new VectorTile(new PbfReader(data));
    for (const [name, layer] of Object.entries(t.layers)) {
      if (name !== 'rtt_trails') errors.push(`tile ${e.tileId}: unexpected layer '${name}'`);
      for (let i = 0; i < layer.length; i++) errors.push(...checkTileProperties(layer.feature(i).properties, `tile ${e.tileId}`));
    }
  }
  if (manifest) errors.push(...checkWhitelist(manifest, PUBLIC_MANIFEST, 'public manifest'));
  return { errors: [...new Set(errors)], tiles: tiles.length };
}
