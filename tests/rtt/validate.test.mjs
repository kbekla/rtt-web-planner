// RT&T trail contract: schema, uniqueness, geometry and provenance rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../../scripts/lib/common.mjs';
import { loadContract, validate } from '../../scripts/rtt/validate.mjs';

const fixture = () => JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/rtt/trails-synthetic.geojson'), 'utf8'));
const contract = loadContract();
const one = (mutate) => { const fc = fixture(); fc.features = [fc.features[0]]; mutate(fc.features[0], fc); return validate(fc, contract); };

test('fixture: 4 accepted, the OSM-derived and unapproved features quarantined, no errors', () => {
  const r = validate(fixture(), contract);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.accepted.map((f) => f.properties.rtt_id).sort(),
    ['rtt-trail-000000000001', 'rtt-trail-000000000002', 'rtt-trail-000000000003', 'rtt-trail-000000000004']);
  const q = Object.fromEntries(r.quarantined.map((x) => [x.rtt_id, x.reasons.join(' ')]));
  assert.match(q['rtt-trail-0000000000a1'], /osm-derived/);
  assert.match(q['rtt-trail-0000000000a2'], /not approved/);
});

test('duplicate rtt_id fails the whole input', () => {
  const fc = fixture();
  fc.features[1].properties.rtt_id = fc.features[0].properties.rtt_id;
  assert.match(validate(fc, contract).errors.join('\n'), /duplicate rtt_id/);
});

test('rtt_id must be present and well-formed', () => {
  assert.match(one((f) => { delete f.properties.rtt_id; }).errors.join(), /missing 'rtt_id'/);
  assert.match(one((f) => { f.properties.rtt_id = 'way/123456'; }).errors.join(), /does not match/);
});

test('schema: enums, unknown properties and provenance fields are enforced', () => {
  assert.match(one((f) => { f.properties.kind = 'motorway'; }).errors.join(), /kind='motorway' not in/);
  assert.match(one((f) => { f.properties.highway = 'path'; }).errors.join(), /unknown property 'highway'/);
  assert.match(one((f) => { f.properties.version = 0; }).errors.join(), /version must be an integer >= 1/);
  assert.match(one((f) => { delete f.properties.provenance.osm_derived; }).errors.join(), /missing 'provenance.osm_derived'/);
  assert.match(one((f) => { f.properties.provenance.osm_derived = 'no'; }).errors.join(), /must be true or false/);
  assert.match(one((f) => { f.properties.provenance.osm_id = 42; }).errors.join(), /unknown property 'provenance.osm_id'/);
});

test('geometry: lines only, >= 2 points, finite, in range, non-zero length', () => {
  assert.match(one((f) => { f.geometry = { type: 'Point', coordinates: [7.42, 43.73] }; }).errors.join(), /LineString or MultiLineString/);
  assert.match(one((f) => { f.geometry.coordinates = [[7.42, 43.73]]; }).errors.join(), /fewer than 2 points/);
  assert.match(one((f) => { f.geometry.coordinates = [[7.42, 43.73], [7.42, 43.73]]; }).errors.join(), /shorter than 1 m/);
  assert.match(one((f) => { f.geometry.coordinates = [[7.42, 43.73], [7.42, 89]]; }).errors.join(), /outside/);
  assert.match(one((f) => { f.geometry.coordinates = [[7.42, 43.73], [7.43, null]]; }).errors.join(), /non-numeric/);
});

test('provenance gates: unknown source, wrong method, OSM-derived source', () => {
  const unknown = one((f) => { f.properties.provenance.source = 'some-website'; });
  assert.match(unknown.quarantined[0].reasons.join(), /unknown source/);
  const method = one((f) => { f.properties.provenance.method = 'gps_trace'; });
  assert.match(method.quarantined[0].reasons.join(), /method 'gps_trace' not allowed/);
  const c = loadContract();
  c.sources['rtt-synthetic-fixture'] = { ...c.sources['rtt-synthetic-fixture'], osm_derived: true };
  const fc = fixture(); fc.features = [fc.features[0]];
  assert.match(validate(fc, c).quarantined[0].reasons.join(), /source 'rtt-synthetic-fixture' is OSM-derived/);
});

test('every source entry declares licence, attribution, methods, osm_derived and approval', () => {
  for (const [id, s] of Object.entries(contract.sources)) {
    for (const k of ['name', 'licence', 'attribution', 'methods', 'osm_derived', 'approved']) assert.ok(s[k] !== undefined, `${id}.${k}`);
    if (s.approved) assert.ok(s.approved_by, `${id}: approved sources must record approved_by`);
    assert.ok(!(s.approved && s.osm_derived), `${id}: an OSM-derived source cannot be approved for the proprietary layer`);
  }
});

test('the validator reads enums from the schema file (single source of truth)', () => {
  const c = loadContract();
  c.schema.properties.properties.properties.kind.enum.push('motorway');
  const fc = fixture(); fc.features = [fc.features[0]]; fc.features[0].properties.kind = 'motorway';
  assert.deepEqual(validate(fc, c).errors, []);
});
