// Publish guard for the RT&T trail layer.
//
// The published trail artefacts (rtt-trails.pmtiles, its public manifest, the
// trail style fragment) may contain only rider-facing data:
//   rtt_id, name (lane name), kind (legal classification), status (access status), geometry.
// Provenance, source names/URLs/IDs, council dataset references, GRM/TrailVidz
// references, verification methods, research notes, evidence, confidence
// methodology and licence/reuse notes stay in the private master data
// ($FACTORY_DIR/private/rtt...), never in anything that is published.
//
// build-trails.mjs runs this after every build and deletes the public output
// if it fails; tests/rtt/privacy.test.mjs exercises it.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles } from 'pmtiles';

export const PUBLIC_TILE_FIELDS = ['rtt_id', 'name', 'kind', 'status'];

// Words that must never appear in a published key or string value.
export const SENSITIVE = /provenance|licen[cs]e|\breuse\b|source|registry|method|captured|osm_derived|\bnotes?\b|evidence|research|confidence|verif|council|\bprow\b|\bboat-|\bgrm\b|grm-|trail\s*vidz|\btet\b|approved|https?:\/\/|www\./i;

/** Walk any JSON value; report sensitive keys and string values. */
export function scanJson(value, where, allowKeys = new Set()) {
  const errors = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (!allowKeys.has(k) && SENSITIVE.test(k)) errors.push(`${where}: sensitive key '${p}.${k}'`);
        walk(x, `${p}.${k}`);
      }
    } else if (typeof v === 'string' && SENSITIVE.test(v)) {
      errors.push(`${where}: sensitive value at ${p}: '${v.slice(0, 80)}'`);
    }
  };
  walk(value, '$');
  return errors;
}

/** One decoded feature's properties: only the public fields, no sensitive text. */
export function checkTileProperties(props, where) {
  const errors = [];
  for (const k of Object.keys(props)) {
    if (!PUBLIC_TILE_FIELDS.includes(k)) errors.push(`${where}: non-public tile field '${k}'`);
  }
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'string' && SENSITIVE.test(v)) errors.push(`${where}: sensitive text in '${k}': '${v.slice(0, 80)}'`);
  }
  return errors;
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

/**
 * Check every tile, the metadata of a trail PMTiles archive, and optional extra
 * public JSON files. Returns a list of errors ([] = publishable).
 */
export async function checkPublishable(pmtilesFile, extras = {}) {
  const archive = new PMTiles(new FileSource(pmtilesFile));
  const errors = [];
  const md = await archive.getMetadata();
  // Planetiler's own tool-version keys are allowed; everything else is scanned.
  errors.push(...scanJson(md, 'pmtiles metadata', new Set(['planetiler:buildtime', 'planetiler:githash', 'planetiler:version'])));
  for (const layer of md.vector_layers ?? []) {
    if (layer.id !== 'rtt_trails') errors.push(`pmtiles metadata: unexpected layer '${layer.id}'`);
    for (const f of Object.keys(layer.fields ?? {})) if (!PUBLIC_TILE_FIELDS.includes(f)) errors.push(`pmtiles metadata: non-public field '${f}'`);
  }
  // Every tile in the archive.
  const tiles = [];
  const visit = async (dirOffset, dirLength) => {
    const dir = await archive.cache.getDirectory(archive.source, dirOffset, dirLength, await archive.getHeader());
    for (const e of dir) {
      if (e.runLength === 0) await visit((await archive.getHeader()).leafDirectoryOffset + e.offset, e.length);
      else tiles.push(e);
    }
  };
  const h = await archive.getHeader();
  await visit(h.rootDirectoryOffset, h.rootDirectoryLength);
  for (const e of tiles) {
    const raw = await archive.source.getBytes(h.tileDataOffset + e.offset, e.length);
    let data = Buffer.from(raw.data);
    if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
    const t = new VectorTile(new PbfReader(data));
    for (const [name, layer] of Object.entries(t.layers)) {
      if (name !== 'rtt_trails') errors.push(`tile ${e.tileId}: unexpected layer '${name}'`);
      for (let i = 0; i < layer.length; i++) errors.push(...checkTileProperties(layer.feature(i).properties, `tile ${e.tileId}`));
    }
  }
  for (const [name, json] of Object.entries(extras)) errors.push(...scanJson(json, name));
  return { errors: [...new Set(errors)], tiles: tiles.length };
}
