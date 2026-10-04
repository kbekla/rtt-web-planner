import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO } from '../../scripts/lib/common.mjs';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import { ingestRouteFile } from '../../scripts/scout/route-import.mjs';
import { parseGpx, parseKml, parseGeoJson } from '../../scripts/scout/route-parsers.mjs';

const fixture = path.resolve('tests/fixtures/scout/mixed-route.gpx');
const definition = (overrides = {}) => ({
  source_id: 'synthetic-routes', name: 'Synthetic routes', type: 'fixture', organisation: 'RTT test suite',
  expected_formats: ['gpx','kml','geojson'], coverage: { countries: ['ZZ'], regions: ['ZZ-TEST'] }, jurisdiction_ids: ['ZZ-test'],
  location: 'repository synthetic fixture', adapter_version: 'fixture-v1', licence: { name: 'synthetic', version: '1' },
  reuse: { private_processing: true, redistribution: false, derived_public_use: false },
  roles: { discovery_only: true, physical_existence: false, legal_access: false, routing_network: false, public_reuse: false, jurisdiction_boundaries:false },
  update: { mechanism: 'fixed fixture' }, attribution: 'synthetic; not real source material', rate_limits: { requests_per_minute: 0 }, ...overrides,
});
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'scout-route-')); }

test('GPX preserves independent track segments, source name, elevations, and times', () => {
  const parsed = parseGpx(fs.readFileSync(fixture, 'utf8'));
  assert.equal(parsed.parts.length, 2);
  assert.deepEqual(parsed.parts.map((part) => part.part_key), ['track-1-segment-1','track-1-segment-2']);
  assert.equal(parsed.parts[0].name, 'Synthetic mixed route');
  assert.deepEqual(parsed.parts[0].geometry.coordinates[0], [-1,51,100]);
  assert.equal(parsed.parts[0].metadata.times[0], '2026-01-01T10:00:00Z');
});

test('KML and GeoJSON retain separate line components and language metadata', () => {
  const kml = parseKml('<kml><Placemark><name>Route &amp; loop</name><LineString><coordinates>1,2,3 4,5,6</coordinates></LineString></Placemark></kml>', { sourceLanguage: 'fr' });
  assert.equal(kml.parts[0].name, 'Route & loop'); assert.equal(kml.parts[0].metadata.source_language, 'fr');
  assert.deepEqual(kml.parts[0].geometry.coordinates, [[1,2,3],[4,5,6]]);
  const geo = parseGeoJson(JSON.stringify({ type:'FeatureCollection', features:[{type:'Feature',id:'synthetic-1',properties:{name:'x'},geometry:{type:'MultiLineString',coordinates:[[[0,0],[1,1]],[[2,2],[3,3]]]}}] }));
  assert.equal(geo.parts.length,2); assert.deepEqual(geo.parts[1].geometry.coordinates, [[2,2],[3,3]]);
});

test('XML parser rejects external entity and unknown entity expansion', () => {
  assert.throws(() => parseGpx('<!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx/>'), /DTD\/entity/);
  assert.throws(() => parseGpx('<gpx><trk><name>&secret;</name><trkseg><trkpt lat="0" lon="0"/><trkpt lat="1" lon="1"/></trkseg></trk></gpx>'), /unsupported XML entity/);
});

test('explicit private GPX import is checksum-aware, idempotent, versioned, and byte-preserving', () => {
  const root=temp(), input=path.join(root,'mixed.gpx'), raw=path.join(root,'private-raw');
  const bytes=fs.readFileSync(fixture); fs.writeFileSync(input,bytes);
  const store=new ScoutGeoStore(path.join(root,'db')); store.registerSource(definition());
  const first=ingestRouteFile(store,{inputFile:input,sourceId:'synthetic-routes',rawRoot:raw});
  assert.equal(first.version,1); assert.equal(first.duplicate,false); assert.equal(first.observations.length,2);
  const storedRaw=first.observations[0].metadata.raw_source_ref;
  assert.equal(fs.readFileSync(storedRaw).compare(bytes),0);
  const second=ingestRouteFile(store,{inputFile:input,sourceId:'synthetic-routes',rawRoot:raw});
  assert.equal(second.duplicate,true); assert.equal(second.file_id,first.file_id); assert.equal(second.observations.length,2);
  fs.appendFileSync(input,'\n'); const changed=ingestRouteFile(store,{inputFile:input,sourceId:'synthetic-routes',rawRoot:raw});
  assert.equal(changed.version,2); assert.notEqual(changed.checksum,first.checksum);
  store.close();
  const reopened=new ScoutGeoStore(path.join(root,'db'));
  assert.equal(reopened.observationsForFile(first.file_id).length,2);
  assert.equal(reopened.observationsForFile(changed.file_id).length,2);
  reopened.close(); fs.rmSync(root,{recursive:true,force:true});
});

test('route import rejects unregistered, non-private, unsupported, symlink and escaping inputs', () => {
  const root=temp(), input=path.join(root,'route.gpx'); fs.copyFileSync(fixture,input);
  const store=new ScoutGeoStore(path.join(root,'db')); store.registerSource(definition());
  assert.throws(()=>ingestRouteFile(store,{inputFile:input,sourceId:'missing',rawRoot:path.join(root,'raw')}),/not registered/);
  assert.throws(()=>ingestRouteFile(store,{inputFile:input,sourceId:'synthetic-routes',relativeName:'../route.gpx',rawRoot:path.join(root,'raw')}),/unsafe/);
  const link=path.join(root,'link.gpx'); fs.symlinkSync(input,link);
  assert.throws(()=>ingestRouteFile(store,{inputFile:link,sourceId:'synthetic-routes',rawRoot:path.join(root,'raw')}),/safely open/);
  store.registerSource(definition({reuse:{private_processing:false,redistribution:false,derived_public_use:false}}));
  assert.throws(()=>ingestRouteFile(store,{inputFile:input,sourceId:'synthetic-routes',rawRoot:path.join(root,'raw')}),/does not authorize/);
  store.close(); fs.rmSync(root,{recursive:true,force:true});
});

test('private geostore and raw source bytes cannot be rooted inside the repository tree', () => {
  const root=temp(),unsafeDb=path.join(REPO,`.scout-private-test-${process.pid}`),unsafeRaw=path.join(REPO,`.scout-raw-test-${process.pid}`);
  try {
    assert.throws(()=>new ScoutGeoStore(unsafeDb),/outside the repository\/public tree/);
    const store=new ScoutGeoStore(root),source=definition();store.registerSource(source);
    const input=path.join(root,'route.gpx');fs.writeFileSync(input,fs.readFileSync(fixture));
    assert.throws(()=>ingestRouteFile(store,{inputFile:input,sourceId:source.source_id,rawRoot:unsafeRaw}),/outside the repository\/public tree/);
    store.close();
  } finally {fs.rmSync(unsafeDb,{recursive:true,force:true});fs.rmSync(unsafeRaw,{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});}
});

test('region viewport queries handle antimeridian bounds without leaking non-matching segments', () => {
  const root=temp(), store=new ScoutGeoStore(path.join(root,'db')); store.registerSource(definition());
  const inserted=store.db.prepare(`INSERT INTO source_files(source_id,relative_name,sha256,version,format,raw_path,byte_size,parser_version,status,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run('synthetic-routes','synthetic.gpx',crypto.randomBytes(32).toString('hex'),1,'gpx','private',1,'test','processed',new Date().toISOString());
  const observation='synthetic-observation'; store.db.prepare(`INSERT INTO route_observations(observation_id,file_id,source_part,geometry_json,geometry_sha256,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(observation,Number(inserted.lastInsertRowid),'part','{}','synthetic','{}',new Date().toISOString());
  const line=(id,coords)=>store.saveSegment({segment_id:id,observation_id:observation,ordinal:1,component_index:0,classification:'UNKNOWN',geometry:{type:'LineString',coordinates:coords},pipeline_version:'test'});
  line('east-date-line',[[179.5,0],[-179.5,0]]); line('greenwich',[[0,0],[1,0]]);
  const hits=store.querySegments([179,-1,-179,1]); assert.deepEqual(hits.map((x)=>x.segment_id),['east-date-line']);
  assert.throws(()=>store.querySegments([-181,-1,0,1]),/invalid/);
  store.close(); fs.rmSync(root,{recursive:true,force:true});
});

test('source history and versioned network snapshots remain private and read-only for matching',()=>{
  const root=temp(),store=new ScoutGeoStore(path.join(root,'db'));
  const networkSource=definition({source_id:'synthetic-network',roles:{discovery_only:false,physical_existence:false,legal_access:false,routing_network:true,public_reuse:false,jurisdiction_boundaries:false}});
  store.registerSource(networkSource);store.recordSourceActivity(networkSource.source_id,{health:'GREEN',retrievedAt:'2026-01-01T00:00:00Z',processedAt:'2026-01-01T00:01:00Z'});
  store.recordNetworkSnapshot({snapshot_id:'synthetic-network-v1',source_id:networkSource.source_id,version:'fixture-1',checksum:'a'.repeat(64),licence:{name:'synthetic',reuse:'private'},coverage:{countries:['ZZ']}});
  store.saveNetworkEdge('synthetic-network-v1',{edge_id:'road-1',geometry:{type:'LineString',coordinates:[[0,0],[1,1]]},tags:{highway:'residential',surface:'asphalt'}});
  assert.equal(store.queryNetworkEdges([-.1,-.1,1.1,1.1]).length,1);
  assert.equal(store.queryNetworkEdges([10,10,11,11]).length,0);
  assert.equal(store.getSource(networkSource.source_id).health,'GREEN');
  store.close();assert.throws(()=>new ScoutGeoStore(path.join(root,'db'),{databaseFile:path.join(root,'outside.sqlite')}),/inside its private/);
  fs.rmSync(root,{recursive:true,force:true});
});

test('candidate persistence defaults legal access and routability to unknown and is deterministic on rerun',()=>{
  const root=temp(),store=new ScoutGeoStore(path.join(root,'db'));store.registerSource(definition());
  const file=store.recordFile({source_id:'synthetic-routes',relative_name:'candidate.gpx',sha256:'b'.repeat(64),parser_version:'test',format:'gpx',raw_path:'private',byte_size:1});
  const observation='candidate-observation';store.completeFileImport(file.file_id,[{observation_id:observation,source_part:'part',geometry:{type:'LineString',coordinates:[[0,0],[1,1]]},geometry_sha256:'synthetic',metadata:{}}]);
  const segment={segment_id:'segment-candidate',observation_id:observation,ordinal:0,component_index:0,classification:'PROBABLE_OFFROAD',geometry:{type:'LineString',coordinates:[[0,0],[1,1]]},pipeline_version:'synthetic-v1'};store.saveSegment(segment);
  const first=store.saveCandidate(segment),second=store.saveCandidate(segment);
  assert.equal(first.motorcycle_access,'unknown');assert.equal(first.routability,'unknown');assert.equal(second.candidate_version,1);assert.equal(second.updated_at,first.updated_at);
  assert.throws(()=>store.saveCandidate(segment,{motorcycle_access:'yes'}),/motorcycle_access/);
  store.close();fs.rmSync(root,{recursive:true,force:true});
});

test('evidence records stay source-role and jurisdiction scoped with original language and validity dates',()=>{
  const root=temp(),store=new ScoutGeoStore(path.join(root,'db'));
  store.registerSource(definition({source_id:'synthetic-legal-source',roles:{discovery_only:false,physical_existence:false,legal_access:true,routing_network:false,public_reuse:false,jurisdiction_boundaries:false}}));
  store.registerSource(definition({source_id:'synthetic-boundary-source',roles:{discovery_only:false,physical_existence:false,legal_access:false,routing_network:false,public_reuse:false,jurisdiction_boundaries:true}}));
  const boundary=(east)=>({type:'Polygon',coordinates:[[[0,0],[east,0],[east,1],[0,1],[0,0]]]});
  const firstBoundary={jurisdiction_id:'ZZ-test',country_code:'ZZ',version:'boundary-v1',boundary:boundary(1),language:'xx',boundary_source:{source_id:'synthetic-boundary-source',version:'boundary-v1',checksum:'f'.repeat(64),licence:{name:'synthetic-boundary'}}};
  store.addJurisdiction(firstBoundary);
  const file=store.recordFile({source_id:'synthetic-legal-source',relative_name:'evidence.json',sha256:'e'.repeat(64),parser_version:'test',format:'geojson',raw_path:'private',byte_size:1});
  store.completeFileImport(file.file_id,[{observation_id:'legal-observation',source_part:'part',geometry:{type:'LineString',coordinates:[[0,0],[1,1]]},geometry_sha256:'synthetic'}]);
  const segment={segment_id:'legal-segment',observation_id:'legal-observation',ordinal:0,component_index:0,classification:'PROBABLE_OFFROAD',geometry:{type:'LineString',coordinates:[[0,0],[1,1]]},pipeline_version:'test'};
  store.saveSegment(segment);store.saveCandidate(segment,{candidate_id:'legal-candidate'});
  const id=store.saveEvidence({candidate_id:'legal-candidate',observation_id:'legal-observation',source_id:'synthetic-legal-source',source_version:'gazette-v4',question:'motorcycle_access',outcome:'prohibited',jurisdiction_id:'ZZ-test',evidence_time:'2026-01-01T00:00:00Z',valid_from:'2026-01-01',valid_to:'2026-06-01',original_language:'xx',reference:'synthetic-document-17',qualified:true});
  const evidence=store.listEvidence({candidateId:'legal-candidate'})[0];assert.equal(evidence.evidence_id,id);assert.equal(evidence.jurisdiction_id,'ZZ-test');assert.equal(evidence.evidence.valid_to,'2026-06-01');
  store.addJurisdiction({...firstBoundary,version:'boundary-v2',boundary:boundary(1.1),boundary_source:{...firstBoundary.boundary_source,version:'boundary-v2',checksum:'a'.repeat(64)}});
  assert.equal(store.listJurisdictionVersions('ZZ-test').length,2);assert.equal(store.listJurisdictions()[0].version,'boundary-v2');
  assert.throws(()=>store.addJurisdiction({...firstBoundary,boundary:boundary(0.9)}),/immutable/);
  assert.throws(()=>store.saveEvidence({candidate_id:'legal-candidate',source_id:'synthetic-legal-source',question:'physical_existence',outcome:'confirmed',qualified:true,reference:'wrong-role'}),/not registered for physical_existence/);
  store.close();fs.rmSync(root,{recursive:true,force:true});
});
