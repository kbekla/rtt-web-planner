// Read tiles from a local PMTiles archive and decode them as MVT.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { buildDir, loadRegion } from '../../scripts/lib/common.mjs';

class FileSource {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
  }
  getKey() {
    return this.file;
  }
  async getBytes(offset, length) {
    const buf = Buffer.alloc(length);
    fs.readSync(this.fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) };
  }
}

/** The region and build under test, from RTT_REGION / RTT_BUILD_ID. */
export function target() {
  const region = process.env.RTT_REGION || 'monaco';
  const dir = buildDir(region);
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`no build manifest at ${manifestFile}`);
  return {
    region,
    dir,
    config: loadRegion(region),
    manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')),
    pmtilesFile: path.join(dir, `${region}.pmtiles`),
  };
}

export function openArchive(file) {
  return new PMTiles(new FileSource(file));
}

/** Returns { layerName: [{ properties, type }] } or null for an empty tile. */
export async function readTile(archive, z, x, y) {
  const res = await archive.getZxy(z, x, y);
  if (!res) return null;
  let data = Buffer.from(res.data);
  if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
  const tile = new VectorTile(new PbfReader(data));
  const out = {};
  for (const [name, layer] of Object.entries(tile.layers)) {
    out[name] = [];
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      out[name].push({ properties: f.properties, type: f.type, id: f.id });
    }
  }
  return out;
}
