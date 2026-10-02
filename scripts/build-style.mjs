#!/usr/bin/env node
// Compose the RT&T basemap style for a region:
//   vendored scaffold (pristine) + styles/rtt/overlay.json  ->  $FACTORY_DIR/assets/styles/<region>/style.json
//
// All URLs are root-relative (/tiles, /assets) so the same style works from any
// host that serves those paths; the viewer resolves them against its origin.
// The output is validated with the MapLibre style spec and checked for any
// remaining third-party/Mapbox references.
//
// usage: scripts/build-style.mjs <region>
import fs from 'node:fs';
import path from 'node:path';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { FACTORY, REPO, loadRegion } from './lib/common.mjs';

const region = process.argv[2];
if (!region) {
  console.error('usage: build-style.mjs <region>');
  process.exit(2);
}
loadRegion(region);

const vendorDir = path.join(REPO, 'styles', 'vendor', 'osm-bright');
const style = JSON.parse(fs.readFileSync(path.join(vendorDir, 'style.json'), 'utf8'));
const upstream = JSON.parse(fs.readFileSync(path.join(vendorDir, 'UPSTREAM.json'), 'utf8'));
const overlay = JSON.parse(fs.readFileSync(path.join(REPO, 'styles', 'rtt', 'overlay.json'), 'utf8'));

// Strip editor metadata from the scaffold (Mapbox Studio / MapTiler keys).
delete style.metadata;
for (const layer of style.layers) delete layer.metadata;

style.name = overlay.name;
style.metadata = { ...overlay.metadata, 'rtt:scaffold-commit': upstream.commit };
style.glyphs = '/assets/glyphs/{fontstack}/{range}.pbf';
style.sprite = '/assets/sprites/rtt-basemap';
style.sources = {
  openmaptiles: {
    type: 'vector',
    url: `pmtiles:///tiles/${region}.pmtiles`,
    ...overlay.sources.openmaptiles,
  },
};

const removed = new Set(overlay.remove_layers);
style.layers = style.layers.filter((l) => !removed.has(l.id));
for (const [id, patch] of Object.entries(overlay.layer_overrides)) {
  const layer = style.layers.find((l) => l.id === id);
  if (!layer) throw new Error(`overlay overrides unknown layer '${id}'`);
  for (const key of ['paint', 'layout']) if (patch[key]) layer[key] = { ...layer[key], ...patch[key] };
  for (const key of ['filter', 'minzoom', 'maxzoom']) if (key in patch) layer[key] = patch[key];
}
style.layers.push(...overlay.add_layers);

// --- checks ---------------------------------------------------------------
const errors = validateStyleMin(style).map((e) => e.message);

const glyphDir = path.join(FACTORY, 'assets', 'glyphs');
const fonts = new Set();
JSON.stringify(style.layers, (k, v) => {
  if (k === 'text-font') (Array.isArray(v) ? v.flat(Infinity) : []).forEach((f) => typeof f === 'string' && fonts.add(f));
  return v;
});
for (const font of fonts) {
  if (!fs.existsSync(path.join(glyphDir, font, '0-255.pbf'))) errors.push(`font '${font}' has no glyphs in ${glyphDir}`);
}

const text = JSON.stringify(style);
for (const banned of [/mapbox:\/\//i, /api\.mapbox\.com/i, /api\.maptiler\.com/i, /access_token/i, /\{key\}/, /https?:\/\//]) {
  // Attribution links are the only absolute URLs allowed.
  const withoutAttribution = text.replace(JSON.stringify(style.sources.openmaptiles.attribution), '');
  if (banned.test(withoutAttribution)) errors.push(`style contains forbidden reference matching ${banned}`);
}

if (errors.length) {
  console.error(`style for ${region} is invalid:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}

const outDir = path.join(FACTORY, 'assets', 'styles', region);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'style.json'), JSON.stringify(style, null, 2) + '\n');
console.log(`style ${region}: ${style.layers.length} layers, fonts [${[...fonts].join(', ')}] -> ${outDir}/style.json`);
