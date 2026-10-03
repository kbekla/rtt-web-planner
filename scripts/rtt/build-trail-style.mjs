#!/usr/bin/env node
// Validate the RT&T trail style fragment (styles/rtt/trails.json) and install it at
// $FACTORY_DIR/assets/styles/rtt-trails.json for the viewer. The fragment is checked
// on its own (as a style with just its source and layers) with the MapLibre style
// spec, plus font, source and URL rules. It never touches the basemap style.
import fs from 'node:fs';
import path from 'node:path';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { FACTORY, REPO } from '../lib/common.mjs';

export function checkTrailStyle(frag) {
  const style = {
    version: 8,
    glyphs: '/assets/glyphs/{fontstack}/{range}.pbf',
    sources: { [frag.source_id]: frag.source },
    layers: frag.layers,
  };
  const errors = validateStyleMin(style).map((e) => e.message);
  for (const l of frag.layers) {
    if (l.source !== frag.source_id) errors.push(`layer ${l.id} uses source '${l.source}', not '${frag.source_id}'`);
    if (l['source-layer'] !== 'rtt_trails') errors.push(`layer ${l.id} uses source-layer '${l['source-layer']}'`);
    if (!l.id.startsWith('rtt-trails-')) errors.push(`layer ${l.id} must be prefixed rtt-trails-`);
  }
  if (frag.source.promoteId?.rtt_trails !== 'rtt_id') errors.push('source must promote rtt_id to the feature id');
  if (/OpenStreetMap|OpenMapTiles/i.test(frag.source.attribution ?? '')) errors.push('RT&T source attribution must not credit OSM');
  if (/https?:\/\//.test(JSON.stringify(frag.layers) + frag.source.url)) errors.push('absolute URLs are not allowed');
  const fonts = new Set();
  JSON.stringify(frag.layers, (k, v) => { if (k === 'text-font') v.flat(Infinity).forEach((f) => typeof f === 'string' && fonts.add(f)); return v; });
  for (const f of fonts) if (!fs.existsSync(path.join(FACTORY, 'assets', 'glyphs', f, '0-255.pbf'))) errors.push(`font '${f}' has no glyphs`);
  return errors;
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const frag = JSON.parse(fs.readFileSync(path.join(REPO, 'styles', 'rtt', 'trails.json'), 'utf8'));
  const errors = checkTrailStyle(frag);
  if (errors.length) { console.error(`trail style invalid:\n  ${errors.join('\n  ')}`); process.exit(1); }
  const { $comment, ...out } = frag;
  const dest = path.join(FACTORY, 'assets', 'styles', 'rtt-trails.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
  console.log(`trail style: ${frag.layers.length} layers -> ${dest}`);
}
