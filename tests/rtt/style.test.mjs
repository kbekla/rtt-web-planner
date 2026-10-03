// RT&T trail style fragment: valid on its own, separate source, stable promoteId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../../scripts/lib/common.mjs';
import { checkTrailStyle } from '../../scripts/rtt/build-trail-style.mjs';

const frag = () => JSON.parse(fs.readFileSync(path.join(REPO, 'styles/rtt/trails.json'), 'utf8'));

test('trail style fragment is valid and self-contained', () => {
  assert.deepEqual(checkTrailStyle(frag()), []);
});

test('rules: promoteId on rtt_id, own source only, no OSM credit, no absolute URLs', () => {
  const noPromote = frag(); delete noPromote.source.promoteId;
  assert.match(checkTrailStyle(noPromote).join(), /promote rtt_id/);
  const osmSource = frag(); osmSource.layers[1].source = 'openmaptiles';
  assert.match(checkTrailStyle(osmSource).join(), /uses source 'openmaptiles'/);
  const credit = frag(); credit.source.attribution += ' © OpenStreetMap contributors';
  assert.match(checkTrailStyle(credit).join(), /must not credit OSM/);
  const remote = frag(); remote.source.url = 'pmtiles://https://example.com/rtt-trails.pmtiles';
  assert.match(checkTrailStyle(remote).join(), /absolute URLs/);
});

test('the basemap style never contains the trail source', () => {
  const scaffold = fs.readFileSync(path.join(REPO, 'styles/vendor/osm-bright/style.json'), 'utf8');
  const overlay = fs.readFileSync(path.join(REPO, 'styles/rtt/overlay.json'), 'utf8');
  for (const text of [scaffold, overlay]) assert.doesNotMatch(text, /rtt-trails|rtt_trails/);
});
