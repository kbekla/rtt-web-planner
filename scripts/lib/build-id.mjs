// Tile build identity. The build ID is a hash of exactly the inputs that can change
// the PMTiles bytes, and nothing else, so editing tests, probes or views never
// forces Planetiler to rebuild unchanged tiles.
//
// Every region-config key must be classified below. An unclassified key is an
// error rather than silently ignored, so a new tile-affecting setting can't slip
// past the build ID.
import { canonicalJson, sha256 } from './common.mjs';

export const BUILD_ID_SCHEME = 2;

// Region config keys that change the tiles.
const TILE_KEYS = new Set(['name', 'maxzoom']);
// Region config keys that never reach Planetiler: fetch provenance (the snapshot
// sha256 covers the data itself), test expectations and resource settings.
const NON_TILE_KEYS = new Set(['title', 'source', 'bbox', 'required_layers', 'probes', 'views']);
// planetiler.* sub-keys. `args` are passed through as output arguments; `heap`
// (like the thread count) affects speed and memory only, and is recorded in the
// manifest instead.
const PLANETILER_TILE_KEYS = new Set(['args']);
const PLANETILER_NON_TILE_KEYS = new Set(['heap']);

export function checkConfigKeys(cfg, where = 'region config') {
  for (const key of Object.keys(cfg)) {
    if (key === 'planetiler') {
      for (const sub of Object.keys(cfg.planetiler ?? {})) {
        if (!PLANETILER_TILE_KEYS.has(sub) && !PLANETILER_NON_TILE_KEYS.has(sub)) {
          throw new Error(`${where}: unclassified key 'planetiler.${sub}' (add it to scripts/lib/build-id.mjs)`);
        }
      }
    } else if (!TILE_KEYS.has(key) && !NON_TILE_KEYS.has(key)) {
      throw new Error(`${where}: unclassified key '${key}' (add it to scripts/lib/build-id.mjs)`);
    }
  }
}

/** Planetiler output arguments derived from the region config. */
export function outputArgs(cfg) {
  return {
    maxzoom: cfg.maxzoom,
    minzoom: 0,
    tile_compression: 'gzip',
    tile_format: 'mvt',
    ...(cfg.planetiler?.args ?? {}),
  };
}

/**
 * The tile-producing inputs, as recorded in the manifest.
 * @param cfg        parsed region config
 * @param snapshot   sha256 of the pinned OSM snapshot
 * @param ancillary  { file: sha256 } of the pinned ancillary inputs
 * @param planetiler { version, sha256 } of the pinned planetiler.jar
 * @param java       `java -version` first line
 */
export function tileInputs({ cfg, snapshot, ancillary, planetiler, java }) {
  checkConfigKeys(cfg, `config/regions/${cfg.name}.yaml`);
  return {
    scheme: BUILD_ID_SCHEME,
    region: cfg.name,
    snapshot_sha256: snapshot,
    ancillary,
    planetiler,
    java,
    output_args: outputArgs(cfg),
  };
}

export function buildIdOf(inputs) {
  return sha256(canonicalJson(inputs)).slice(0, 16);
}
