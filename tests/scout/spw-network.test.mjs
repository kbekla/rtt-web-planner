import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSpwCorridor, compareSpwCorridors, normalizeSpwFeature, spwRoadSourceDefinition, spwServiceMetadataVersion } from '../../scripts/scout/spw-network.mjs';
import { assessCatalogueSource, BELGIUM_NAP_CANDIDATES } from '../../scripts/scout/belgium-source-catalogue.mjs';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import { registerOsmDiscoverySource } from '../../scripts/scout/osm-discovery.mjs';
import { saveExternalNetworkEvidence, listExternalCorridorEvidence } from '../../scripts/scout/external-network-evidence.mjs';
import { pollSpwServiceMetadata } from '../../scripts/scout/spw-watchkeeper.mjs';
import { runGeoCtl } from '../../scripts/scout/geoctl.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const line = (x, y, dx = .01, dy = 0) => ({ type: 'LineString', coordinates: [[x, y], [x + dx, y + dy]] });
const corridor = (geometry, attributes = {}) => ({ geometry, attributes });
const spw = (geometry, attributes = {}) => ({ source_feature_id: 'spw:national_roads:1', geometry, attributes });

test('SPW source is registered as one lineage with physical/network roles only', () => {
  const source = spwRoadSourceDefinition();
  assert.equal(source.licence.version, 'CC BY 4.0');
  assert.deepEqual(source.evidence_roles, ['PHYSICAL_EXISTENCE', 'NETWORK_IDENTITY', 'NETWORK_CONTEXT']);
  assert.deepEqual(source.lineage.upstream_source_ids, ['spw-picc', 'spw-bdr']);
  assert.equal(source.roles.legal_access, false);
});

test('normal geoctl command registers SPW definition through the existing source registry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-spw-register-')); fs.chmodSync(root, 0o700);
  const old = console.log; console.log = () => {};
  try {
    assert.equal(await runGeoCtl(['source', 'register-spw'], { SCOUT_GEO_ROOT: root }), 0);
    const store = new ScoutGeoStore(root);
    try { assert.equal(store.getSource('spw-wallonia-regional-road-network').licence.version, 'CC BY 4.0'); }
    finally { store.close(); }
  } finally { console.log = old; fs.rmSync(root, { recursive: true, force: true }); }
});

test('SPW service descriptor requires expected layers and yields stable descriptor checksum', () => {
  const metadata = { capabilities: 'Map,Query,Data', currentVersion: 11.5, documentInfo: { Version: '3.3.0' }, layers: [4, 5, 6].map(id => ({ id, type: 'Feature Layer', geometryType: 'esriGeometryPolyline' })) };
  assert.deepEqual(spwServiceMetadataVersion(metadata), spwServiceMetadataVersion(structuredClone(metadata)));
  assert.throws(() => spwServiceMetadataVersion({ ...metadata, layers: metadata.layers.slice(1) }), /layer identity/);
});

test('SPW normalisation preserves multipart component boundaries and unknown access/routability', () => {
  const feature = normalizeSpwFeature({ attributes: { OBJECTID: 7, NUMERO_ROUTE: 'N90', NOM_ROUTE: 'Namur' }, geometry: { paths: [[[4, 50], [4.01, 50]], [[4.02, 50], [4.03, 50]]] } }, { layerId: 6, sourceVersion: '3.3.0' });
  assert.equal(feature.geometry.type, 'MultiLineString');
  assert.equal(feature.geometry.coordinates.length, 2);
  assert.equal(feature.source_feature_id, 'spw:national_roads:7');
  assert.equal(feature.motorcycle_access, 'UNKNOWN');
  assert.equal(feature.routability, 'UNKNOWN');
  assert.throws(() => normalizeSpwFeature({ attributes: { OBJECTID: 1 }, geometry: { paths: [[[300000, 150000], [300001, 150001]]] } }, { layerId: 6 }), /WGS84/);
});

test('coincident matching with route identity corroborates SPW without asserting access', () => {
  const a = corridor(line(4, 50), { route_number: 'N90' }), b = spw(line(4, 50), { route_number: 'N90' });
  const result = compareSpwCorridor(a, b);
  assert.equal(result.relationship, 'EXACT');
  assert.equal(result.motorcycle_access_effect, 'NONE');
  assert.equal(result.routability_effect, 'NONE');
});

test('nearby parallel geometry is labelled parallel and never inherits identity', () => {
  const result = compareSpwCorridor(corridor(line(4, 50)), spw(line(4, 50.0001)));
  assert.equal(result.relationship, 'PARALLEL');
  assert.equal(result.identity_match, false);
  assert.equal(result.motorcycle_access_effect, 'NONE');
});

test('batched corridor comparison preserves competing-alignment ambiguity without repeated scoring',()=>{
  const a=corridor(line(4,50),{route_number:'N90'}),first={...spw(line(4,50),{route_number:'N90'}),source_feature_id:'spw:1'},
    second={...spw(line(4,50),{route_number:'N91'}),source_feature_id:'spw:2'};
  const batched=compareSpwCorridors(a,[first,second]);
  assert.equal(batched.length,2);assert.ok(batched.every(row=>row.match.relationship==='AMBIGUOUS'));
  assert.deepEqual(batched.map(row=>row.match),[
    compareSpwCorridor(a,first,{competitors:[first,second]}),
    compareSpwCorridor(a,second,{competitors:[first,second]}),
  ]);
});

test('local edge pruning keeps a disconnected remote segment in reciprocal coverage denominator',()=>{
  const a=corridor(line(4,50),{route_number:'N90'}),candidate={...spw({type:'MultiLineString',coordinates:[line(4,50).coordinates,line(5,51).coordinates]},{route_number:'N90'}),source_feature_id:'spw:multipart'};
  const result=compareSpwCorridors(a,[candidate])[0].match;
  assert.equal(result.support_ratio_corridor,1);
  assert.ok(result.support_ratio_spw<1);
  assert.notEqual(result.relationship,'EXACT');
});

test('partial overlap is distinguished from whole-corridor identity', () => {
  const result = compareSpwCorridor(corridor(line(4, 50, .02)), spw(line(4, 50, .01)));
  assert.equal(result.relationship, 'PARTIAL');
  assert.equal(result.identity_match, false);
});

test('crossing lines do not become matches merely because they intersect', () => {
  const result = compareSpwCorridor(corridor(line(4, 50, .01, 0)), spw(line(4.005, 49.995, 0, .01)));
  assert.equal(result.relationship, 'NO_MATCH');
});

test('competing SPW alignments with equal support require geometry review', () => {
  const main = spw(line(4, 50), { route_number: 'N90' });
  const result = compareSpwCorridor(corridor(line(4, 50), { route_number: 'N90' }), main, { competitors: [{ ...spw(line(4, 50), { route_number: 'N91' }), source_feature_id: 'spw:national_roads:2' }] });
  assert.equal(result.relationship, 'AMBIGUOUS');
});

test('NAP catalogue discovery is never equivalent to approval or permission to ingest', () => {
  for (const candidate of BELGIUM_NAP_CANDIDATES) {
    const result = assessCatalogueSource(candidate);
    assert.equal(result.state, 'REVIEW_REQUIRED');
    assert.equal(result.ingest_allowed, false);
  }
  assert.equal(BELGIUM_NAP_CANDIDATES.length, 4);
});

test('SPW matches persist as private, source-versioned evidence without changing candidate safety axes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-spw-store-')); fs.chmodSync(root, 0o700);
  const store = new ScoutGeoStore(root);
  try {
    const network = { source_id: 'spw-test-osm', name: 'Synthetic OSM', type: 'regional-osm-network', organisation: 'Synthetic', expected_formats: ['pbf'],
      coverage: { countries: ['BE'], regions: ['BE-WAL'] }, jurisdiction_ids: [], location: 'fixture://osm', adapter_version: 'fixture-v1',
      licence: { name: 'ODbL', version: '1.0' }, attribution: '© OpenStreetMap contributors', reuse: { private_processing: true, redistribution: true, derived_public_use: false },
      roles: { discovery_only: false, physical_existence: false, legal_access: false, routing_network: true, public_reuse: true, jurisdiction_boundaries: false }, update: { mechanism: 'fixture' }, rate_limits: {} };
    store.registerSource(network); store.recordNetworkSnapshot({ snapshot_id: 'spw-test-snap', source_id: network.source_id, version: 'fixture', checksum: 'a'.repeat(64), licence: network.licence, coverage: network.coverage });
    store.saveNetworkEdge('spw-test-snap', { edge_id: 'way-1', geometry: line(4, 50), tags: { highway: 'track' }, evidence: {}, jurisdiction_ids: [] });
    const discovery = registerOsmDiscoverySource(store, 'spw-test-snap'); store.approveSource({ source_id: discovery.source.source_id, approved_by: 'test', scope: 'fixture' });
    store.createDiscoveryRun({ run_id: 'spw-test-run', discovery_source_id: discovery.source.source_id, snapshot_id: 'spw-test-snap', country_code: 'BE', region_id: 'BE-WAL', title: 'fixture', viewport: [3, 49, 5, 51], approved_by: 'test', approval_scope: 'fixture' });
    const candidate = { candidate_id: 'spw-test-candidate', source_id: discovery.source.source_id, snapshot_id: 'spw-test-snap', edge_id: 'way-1', part_index: 0,
      classification: 'PROBABLE_OFFROAD', physical_state: 'probable', motorcycle_access: 'unknown', routability: 'unknown', canonical_status: 'NOT_COMPARED',
      access_tag_state: 'NO_EXPLICIT_ACCESS_TAG', length_m: 700, geometry: line(4, 50), tags: { highway: 'track' }, provenance: {}, matches: [] };
    store.saveDiscoveryCandidateBatch('spw-test-run', [candidate]);
    store.db.prepare("INSERT INTO physical_corridors(corridor_id,identity_scheme,created_at,last_seen_at) VALUES('corr-spw-test','fixture','2026-10-05','2026-10-05')").run();
    store.db.prepare(`INSERT INTO physical_corridor_versions(corridor_version_id,corridor_id,run_id,snapshot_id,algorithm_version,classification,physical_existence,motorcycle_access,routability,canonical_status,review_priority,length_m,node_sequence_hash,node_sequence_json,identity_state,geometry_json,evidence_json,created_at)
      VALUES('cv-spw-test','corr-spw-test','spw-test-run','spw-test-snap','fixture','PROBABLE_OFFROAD','probable','unknown','unknown','NOT_COMPARED','CATALOG_ONLY',700,?,'[]','TOPOLOGY_BACKED',?,'{}','2026-10-05')`).run('b'.repeat(64), JSON.stringify(line(4, 50)));
    const source = spwRoadSourceDefinition(); store.registerSource(source); store.approveSource({ source_id: source.source_id, approved_by: 'test', scope: 'SPW public CC BY network evidence fixture' });
    const feature = { ...spw(line(4, 50), { route_number: 'N90' }), source_id: source.source_id, source_version: '3.3.0' };
    const match = compareSpwCorridor(corridor(line(4, 50), { route_number: 'N90' }), feature);
    const record = { corridor_id: 'corr-spw-test', corridor_version_id: 'cv-spw-test', feature, match };
    assert.deepEqual(saveExternalNetworkEvidence(store, { sourceId: source.source_id, sourceVersion: '3.3.0', sourceSha256:'d'.repeat(64), retrievedAt: '2026-10-05T12:00:00Z', matches: [record] }), { inserted: 1, supplied: 1 });
    assert.equal(saveExternalNetworkEvidence(store, { sourceId: source.source_id, sourceVersion: '3.3.0', sourceSha256:'d'.repeat(64), retrievedAt: '2026-10-05T12:00:00Z', matches: [record] }).inserted, 0);
    const changedUnderSamePin={...record,feature:{...feature,geometry:line(4.0001,50)}};
    assert.throws(()=>saveExternalNetworkEvidence(store,{sourceId:source.source_id,sourceVersion:'3.3.0',sourceSha256:'d'.repeat(64),retrievedAt:'2026-10-05T12:00:00Z',matches:[changedUnderSamePin]}),/same pinned source version/);
    const evidence = listExternalCorridorEvidence(store.db, 'corr-spw-test');
    assert.equal(evidence[0].relationship, 'EXACT'); assert.equal(evidence[0].evidence.authority.authority_id, 'spw-wallonia');
    assert.equal(evidence[0].source_sha256,'d'.repeat(64));
    assert.equal(store.db.prepare("SELECT motorcycle_access FROM physical_corridor_versions WHERE corridor_version_id='cv-spw-test'").get().motorcycle_access, 'unknown');
    assert.equal(store.db.prepare("SELECT routability FROM physical_corridor_versions WHERE corridor_version_id='cv-spw-test'").get().routability, 'unknown');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Watchkeeper polls official SPW descriptor, persists cursor across restart and detects change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-spw-watch-')); fs.chmodSync(root, 0o700);
  const metadata = version => JSON.stringify({ capabilities: 'Map,Query,Data', currentVersion: 11.5, documentInfo: { Version: version }, layers: [4, 5, 6].map(id => ({ id, type: 'Feature Layer', geometryType: 'esriGeometryPolyline' })) });
  const makeFetch = body => async url => { assert.match(String(url), /RES_ROUTIER_REGIONAL\/MapServer\?f=pjson$/); return { ok: true, status: 200, text: async () => body }; };
  let store = new ScoutGeoStore(root);
  try {
    const source = spwRoadSourceDefinition(); store.registerSource(source);
    assert.equal((await pollSpwServiceMetadata(store, { fetchImpl: makeFetch(metadata('3.3.0')), now: new Date('2026-10-05T12:00:00Z') })).state, 'REVIEW_REQUIRED');
    store.approveSource({ source_id: source.source_id, approved_by: 'Fixture owner', scope: 'SPW service descriptor monitoring, not feature acquisition' });
    const first = await pollSpwServiceMetadata(store, { fetchImpl: makeFetch(metadata('3.3.0')), now: new Date('2026-10-05T12:00:00Z') });
    assert.equal(first.event_type, 'INITIAL_SNAPSHOT'); assert.equal(first.scope, 'SERVICE_DESCRIPTOR_ONLY');
    store.close(); store = new ScoutGeoStore(root);
    const same = await pollSpwServiceMetadata(store, { fetchImpl: makeFetch(metadata('3.3.0')), now: new Date('2026-11-05T12:00:00Z') });
    assert.equal(same.event_type, 'NO_CHANGE');
    const changed = await pollSpwServiceMetadata(store, { fetchImpl: makeFetch(metadata('3.4.0')), now: new Date('2026-12-06T12:00:00Z') });
    assert.equal(changed.event_type, 'SOURCE_CHANGED');
    assert.equal(store.db.prepare('SELECT failure_count FROM source_watch_state WHERE source_id=?').get(source.source_id).failure_count, 0);
    const failed = await pollSpwServiceMetadata(store, { fetchImpl: async () => { throw Object.assign(new Error('private endpoint details'), { code: 'ECONNRESET' }); }, now: new Date('2027-01-07T12:00:00Z') });
    assert.equal(failed.state, 'AMBER'); assert.equal(failed.error_code, 'ECONNRESET');
    assert.equal(JSON.stringify(failed).includes('private endpoint details'), false);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
