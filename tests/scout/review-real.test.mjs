import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import { createRealReviewServer, queryRouteHintSupports } from '../../scripts/scout/review-real-server.mjs';
import { registerOsmDiscoverySource } from '../../scripts/scout/osm-discovery.mjs';
import { spwRoadSourceDefinition } from '../../scripts/scout/spw-network.mjs';

const source=(source_id,{network=false}={})=>({source_id,name:source_id,type:'synthetic',organisation:'test',expected_formats:['gpx','pbf'],
  coverage:{countries:['BE'],regions:['BE']},jurisdiction_ids:['BE-country'],location:'synthetic fixture',adapter_version:'fixture-v1',licence:{name:'synthetic',version:'1'},
  reuse:{private_processing:true,redistribution:false,derived_public_use:false},roles:{discovery_only:!network,physical_existence:false,legal_access:false,routing_network:network,public_reuse:false,jurisdiction_boundaries:network},
  update:{mechanism:'fixed fixture'},attribution:'synthetic; no external data',rate_limits:{requests_per_minute:0}});

test('private corridor route-hint provenance joins to the registered source file and route observation',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(`CREATE TABLE discovery_candidate_matches(candidate_id TEXT,related_id TEXT,relationship TEXT,evidence_json TEXT);
      CREATE TABLE candidates(candidate_id TEXT,segment_id TEXT);CREATE TABLE route_segments(segment_id TEXT,observation_id TEXT);
      CREATE TABLE route_observations(observation_id TEXT,file_id INTEGER,source_part TEXT);CREATE TABLE source_files(file_id INTEGER,source_id TEXT,relative_name TEXT,sha256 TEXT,version INTEGER);
      CREATE TABLE source_registry(source_id TEXT,current_json TEXT);`);
    db.prepare('INSERT INTO discovery_candidate_matches VALUES(?,?,?,?)').run('osm-candidate','route-candidate','same_osm_network_part_support','{"distance_m":2}');
    db.prepare('INSERT INTO candidates VALUES(?,?)').run('route-candidate','route-segment');db.prepare('INSERT INTO route_segments VALUES(?,?)').run('route-segment','route-observation');
    db.prepare('INSERT INTO route_observations VALUES(?,?,?)').run('route-observation',1,'track-1-segment-1');
    db.prepare('INSERT INTO source_files VALUES(?,?,?,?,?)').run(1,'tet-private-discovery','private.gpx','a'.repeat(64),1);
    db.prepare('INSERT INTO source_registry VALUES(?,?)').run('tet-private-discovery','{"reuse":{"redistribution":false}}');
    const [support]=queryRouteHintSupports(db,'osm-candidate');
    assert.equal(support.source_id,'tet-private-discovery');assert.equal(support.source.reuse.redistribution,false);
    assert.equal(support.relative_name,'private.gpx');assert.equal(support.source_part,'track-1-segment-1');assert.deepEqual(support.evidence,{distance_m:2});
    assert.deepEqual(queryRouteHintSupports(db,'unrelated-candidate'),[]);
  }finally{db.close();}
});

test('run-configurable Scout reviewer is loopback-only, read-only, and serves an arbitrary private region run',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'scout-real-review-')),root=path.join(base,'be-20000101'),store=new ScoutGeoStore(path.join(root,'state'));
  let server,serverError;
  try{
    store.registerSource(source('synthetic-private-route'));
    store.registerSource(source('synthetic-regional-network',{network:true}));
    store.recordNetworkSnapshot({snapshot_id:'synthetic-region-v1',source_id:'synthetic-regional-network',version:'fixture',checksum:'a'.repeat(64),
      licence:{name:'ODbL 1.0',attribution:'© OpenStreetMap contributors'},coverage:{countries:['BE']}});
    const file=store.recordFile({source_id:'synthetic-private-route',relative_name:'selected.gpx',sha256:'b'.repeat(64),parser_version:'fixture',format:'gpx',raw_path:'/private/never-served/selected.gpx',byte_size:12});
    store.completeFileImport(file.file_id,[{observation_id:'be-review-obs',source_part:'track-1-segment-1',source_name:'private track name',
      geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]},geometry_sha256:'c'.repeat(64),metadata:{raw_source_ref:'/private/never-served/selected.gpx'}}]);
    store.saveNetworkEdge('synthetic-region-v1',{edge_id:'osm:way:5',geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]},tags:{highway:'track',surface:'ground'}});
    const prior={segment_id:'be-review-old-seg',observation_id:'be-review-obs',ordinal:0,component_index:0,classification:'ROAD',confidence:0.8,
      geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]},evidence:[],pipeline_version:'network-segmenter-1',jurisdiction_ids:['BE-country']};
    store.saveSegment(prior);store.saveCandidate(prior,{candidate_id:'be-review-old-candidate',network_snapshot_id:'synthetic-region-v1'});
    const prior2={...prior,segment_id:'be-review-old-seg-2',ordinal:1,geometry:{type:'LineString',coordinates:[[4.31,50.81],[4.32,50.82]]}};
    store.saveSegment(prior2);store.saveCandidate(prior2,{candidate_id:'be-review-old-candidate-2',network_snapshot_id:'synthetic-region-v1'});
    store.saveCorridorHypothesis({hypothesis_id:'be-review-old-hypothesis',observation_id:'be-review-obs',component_index:0,network_snapshot_id:'synthetic-region-v1',
      candidate_ids:['be-review-old-candidate','be-review-old-candidate-2'],connector_segment_ids:[],support_edge_ids:['osm:way:5#part:0'],connector_length_m:0,
      hypothesis:'SAME_OSM_WAY_WITH_AMBIGUOUS_CONNECTOR',geometry_gap_filled:false,evidence:{rule:'old-generation-fixture'}});
    const segment={segment_id:'be-review-seg',observation_id:'be-review-obs',ordinal:0,component_index:0,classification:'PROBABLE_OFFROAD',confidence:0.8,
      geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]},evidence:[{rule:'nearest-network-edge',edge_id:'osm:way:5'}],pipeline_version:'network-segmenter-2.2',jurisdiction_ids:['BE-country']};
    store.saveSegment(segment);store.saveCandidate(segment,{candidate_id:'be-review-candidate',master_match:'UNMATCHED',match_details:{reason:'canonical master not supplied'},network_snapshot_id:'synthetic-region-v1',
      physical_state:'unknown',motorcycle_access:'unknown',routability:'unknown',review_state:'AWAITING_EVIDENCE',jurisdiction_ids:['BE-country']});
    store.saveSegment({segment_id:'be-review-unknown',observation_id:'be-review-obs',ordinal:1,component_index:0,classification:'UNKNOWN',confidence:null,
      geometry:{type:'LineString',coordinates:[[4.31,50.81],[4.311,50.811]]},evidence:[{rule:'no-network-match-within-threshold',threshold_m:8}],
      pipeline_version:'network-segmenter-2.2',jurisdiction_ids:['BE-country']});
    store.approveSource({source_id:'synthetic-private-route',approved_by:'Fixture reviewer',scope:'Private synthetic review'});
    const runId='synthetic-anywhere-20000101';
    store.createRun({run_id:runId,source_id:'synthetic-private-route',snapshot_id:'synthetic-region-v1',country_code:'BE',region_id:'BE-test',title:'Synthetic arbitrary-region run',viewport:[4.2,50.7,4.4,50.9],approved_by:'Fixture reviewer',approval_scope:'Private synthetic review'});
    store.setRunObservation(runId,'be-review-obs','COMPLETE',{pipeline_version:'network-segmenter-2.2',checkpoint:{stage:'complete'}});
    store.setRunStatus(runId,'REVIEW_REQUIRED');
    store.recordReviewDecision({candidate_id:'be-review-candidate',decision:'ACCEPT_FOR_RESEARCH',reviewer:'Fixture reviewer',reason:'Retain for private synthetic research'});
    assert.equal(store.listRunReviewCandidates({runId,decision:'ACCEPT_FOR_RESEARCH'})[0].candidate_id,'be-review-candidate');
    assert.ok(store.db.prepare("PRAGMA index_list('route_segments')").all().some(index=>index.name==='segments_observation_pipeline_idx'));
    store.close();
    server=createRealReviewServer({runId,privateBase:base,databaseFile:path.join(root,'state','scout.sqlite'),port:0,onError:error=>{serverError=error;}});await new Promise(resolve=>server.once('listening',resolve));
    const address=`http://127.0.0.1:${server.address().port}`;
    const page=await fetch(address);assert.equal(page.status,200);const html=await page.text();assert.match(html,/No BE canonical master was supplied/);assert.doesNotMatch(html,/TET/);
    assert.match(html,/UNKNOWN reason/);assert.match(html,/Candidate length/);assert.match(html,/Match-margin score/);
    assert.match(html,/Ambiguous connector hypothesis \(not merged\)/);const client=await fetch(`${address}/review.js`);assert.equal(client.status,200);assert.match(await client.text(),/continuity-hypothesis-line/);
    const getJson=async(url)=>{serverError=null;const response=await fetch(url),text=await response.text();assert.equal(response.status,200,`${url}: ${text}\n${serverError?.stack??''}`);return JSON.parse(text);};
    const css=await fetch(`${address}/vendor/maplibre-gl/maplibre-gl.css`);assert.equal(css.status,200);assert.match(css.headers.get('content-type'),/text\/css/);
    assert.equal((await fetch(`${address}/vendor/maplibre-gl/maplibre-gl.mjs`)).status,200);
    assert.equal((await fetch(`${address}/vendor/maplibre-gl/maplibre-gl.mjs.map`)).status,404);
    const status=await getJson(`${address}/api/status`);assert.equal(status.private_data_loaded,true);assert.equal(status.read_only,true);assert.equal(status.run_id,runId);assert.equal(status.region_id,'BE-test');assert.equal(status.candidates,1);assert.equal(status.segments,2);assert.equal(status.corridor_hypotheses,0);assert.equal(status.matched_network_edge_ids,1);
    const routes=await getJson(`${address}/api/source-routes`);assert.equal(routes.features.length,1);assert.equal(routes.features[0].properties.source_id,'synthetic-private-route');
    assert.equal(JSON.stringify(status).includes('/private/never-served'),false);assert.equal(JSON.stringify(routes).includes('/private/never-served'),false);
    const segments=await getJson(`${address}/api/segments?bbox=4.2,50.7,4.4,50.9`);assert.equal(segments.features.length,2);
    assert.equal(segments.features[0].properties.motorcycle_access,'unknown');assert.equal(segments.features[0].properties.routability,'unknown');
    const trail=segments.features.find(f=>f.properties.candidate_id),unknown=segments.features.find(f=>f.properties.classification==='UNKNOWN');
    assert.equal(trail.properties.length_m>0,true);assert.equal(trail.properties.evidence_summary.network_edge_ids[0],'osm:way:5');assert.equal('evidence' in trail.properties,false);
    assert.equal(trail.properties.review_decision,'ACCEPT_FOR_RESEARCH');assert.equal(unknown.properties.unknown_reason,'no_network_match');
    const detail=await getJson(`${address}/api/segment/${encodeURIComponent(trail.properties.segment_id)}`);
    assert.equal(detail.properties.network_matches[0].tags.surface,'ground');assert.equal(detail.properties.evidence[0].rule,'nearest-network-edge');
    assert.equal((await fetch(`${address}/api/segment/../api/status`)).status,404);
    const network=await getJson(`${address}/api/network?bbox=4.2,50.7,4.4,50.9&zoom=10`);assert.equal(network.features[0].properties.highway,'track');
    assert.equal((await fetch(`${address}/api/network?bbox=4.2,50.7,4.4,50.9&limit=5001&zoom=10`)).status,400);
    assert.equal((await fetch(address,{method:'POST'})).status,405);assert.equal((await fetch(`${address}/api/unknown`)).status,404);
    assert.deepEqual(await getJson(`${address}/api/canonical`),{type:'FeatureCollection',features:[],coverage:'canonical reference not supplied; NOT_COMPARED'});
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    try{store.close();}catch{}
    fs.rmSync(base,{recursive:true,force:true});
  }
});

test('real reviewer refuses symlinked source-validation roots',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'scout-review-link-')),target=path.join(base,'be-20000101'),link=path.join(base,'be-20000102');
  try{fs.mkdirSync(path.join(target,'state'),{recursive:true});fs.symlinkSync(target,link);assert.throws(()=>createRealReviewServer({runId:'be-20000102',privateBase:base}),/symlink/);}
  finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('private reviewer can inspect an independent OSM discovery run without serving raw source bytes',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'scout-discovery-review-')),root=path.join(base,'be-discovery'),store=new ScoutGeoStore(path.join(root,'state'));
  let server;
  try{
    store.registerSource(source('osm-network',{network:true}));store.recordNetworkSnapshot({snapshot_id:'osm-discovery-v1',source_id:'osm-network',version:'synthetic Belgium',checksum:'d'.repeat(64),
      licence:{name:'ODbL 1.0',version:'1.0',attribution:'© OpenStreetMap contributors'},coverage:{countries:['BE']}});
    const registered=registerOsmDiscoverySource(store,'osm-discovery-v1');store.approveSource({source_id:registered.source.source_id,approved_by:'Fixture',scope:'private OSM discovery'});
    store.saveNetworkEdge('osm-discovery-v1',{edge_id:'w-555',geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]},tags:{highway:'track',tracktype:'grade3',motorcycle:'no'}});
    store.createDiscoveryRun({run_id:'be-osm-discovery',discovery_source_id:registered.source.source_id,snapshot_id:'osm-discovery-v1',country_code:'BE',region_id:'BE',
      title:'Belgium independent OSM discovery',viewport:[2,49,7,52],approved_by:'Fixture',approval_scope:'private OSM discovery'});
    store.saveDiscoveryCandidateBatch('be-osm-discovery',[{candidate_id:'odc-fixture',source_id:registered.source.source_id,snapshot_id:'osm-discovery-v1',edge_id:'w-555',part_index:0,
      classification:'PROBABLE_OFFROAD',physical_state:'probable',motorcycle_access:'unknown',routability:'unknown',canonical_status:'NOT_COMPARED',access_tag_state:'OSM_TAGS_PRESENT',length_m:100,
      geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]},tags:{highway:'track',tracktype:'grade3',motorcycle:'no'},
      provenance:{existence_basis:'OSM mapped geometry only; unverified'},sources:[{source_id:registered.source.source_id,relationship:'origin',source_reference:'w-555#part:0',evidence:{}}]}]);
    const external=spwRoadSourceDefinition();store.registerSource(external);
    const corridorId=`corr-${'a'.repeat(32)}`,corridorVersion='cv-spw-review-fixture';
    store.db.prepare("INSERT INTO physical_corridors(corridor_id,identity_scheme,created_at,last_seen_at) VALUES(?,'fixture','2026-10-05','2026-10-05')").run(corridorId);
    store.db.prepare(`INSERT INTO physical_corridor_versions(corridor_version_id,corridor_id,run_id,snapshot_id,algorithm_version,classification,physical_existence,motorcycle_access,routability,canonical_status,review_priority,length_m,node_sequence_hash,node_sequence_json,identity_state,geometry_json,evidence_json,created_at)
      VALUES(?,?, 'be-osm-discovery','osm-discovery-v1','fixture','PROBABLE_OFFROAD','probable','unknown','unknown','NOT_COMPARED','CATALOG_ONLY',700,?,'[]','TOPOLOGY_BACKED',?,'{}','2026-10-05')`).run(corridorVersion,corridorId,'c'.repeat(64),JSON.stringify({type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]}));
    store.db.prepare(`INSERT INTO physical_corridor_observations(corridor_version_id,candidate_id,relation) VALUES(?,'odc-fixture','OSM_WAY_PART_OBSERVATION')`).run(corridorVersion);
    store.db.prepare(`INSERT INTO external_corridor_evidence(evidence_id,corridor_version_id,corridor_id,source_id,source_version,source_sha256,source_feature_id,relationship,geometry_json,attributes_json,evidence_json,retrieved_at)
      VALUES('xev-review-fixture',?,?,?,'3.3.0',?,'spw:national_roads:55','PARALLEL',?,'{"route_number":"N90"}',?,'2026-10-05T12:00:00Z')`).run(corridorVersion,corridorId,external.source_id,'d'.repeat(64),
        JSON.stringify({type:'LineString',coordinates:[[4.3001,50.8],[4.3101,50.81]]}),JSON.stringify({evidence_role:['PHYSICAL_EXISTENCE','NETWORK_IDENTITY'],identity_basis:['reciprocal line support'],motorcycle_access_effect:'NONE',routability_effect:'NONE'}));
    store.close();server=createRealReviewServer({runId:'be-osm-discovery',privateBase:base,databaseFile:path.join(root,'state','scout.sqlite')});await new Promise(resolve=>server.once('listening',resolve));
    const address=`http://127.0.0.1:${server.address().port}`;const html=await (await fetch(address)).text();assert.match(html,/Independent OSM discoveries/);assert.match(html,/Mapped OSM geometry is unverified/);
    const status=await (await fetch(`${address}/api/status`)).json();assert.equal(status.discovery_run,true);assert.equal(status.discovery_candidates,1);assert.equal(status.discovery_corroborated,0);
    const features=await (await fetch(`${address}/api/discovery-candidates?bbox=4.2,50.7,4.4,50.9`)).json();assert.equal(features.features.length,1);
    const item=features.features[0];assert.equal(item.properties.origin,'OSM');assert.equal(item.properties.motorcycle_access,'unknown');assert.equal(item.properties.routability,'unknown');
    assert.equal(item.properties.canonical_status,'NOT_COMPARED');assert.equal(item.properties.tags.motorcycle,'no');assert.equal(item.properties.sources[0].source_id,registered.source.source_id);
    const corridor=await (await fetch(`${address}/api/corridor/${corridorId}`)).json();
    assert.equal(corridor.properties.external_network_evidence[0].source_id,external.source_id);
    assert.equal(corridor.properties.external_network_evidence[0].relationship,'PARALLEL');
    assert.equal(corridor.properties.external_network_evidence[0].source_sha256,'d'.repeat(64));
    assert.equal(corridor.properties.external_network_evidence[0].attributes.route_number,'N90');
    assert.equal(corridor.properties.motorcycle_access,'unknown');assert.equal(corridor.properties.routability,'unknown');
    assert.equal((await (await fetch(`${address}/api/source-routes`)).json()).features.length,0);assert.equal((await fetch(`${address}/api/discovery-candidates?bbox=4.2,50.9,4.4,50.7`)).status,400);
    const client=await (await fetch(`${address}/review.js`)).text();assert.match(client,/discovery-line/);assert.match(client,/refreshDiscoveries/);assert.match(client,/refreshSegments/);
    assert.match(client,/return map\.getSource\(id\)/);assert.match(client,/segments=source\('segments'/);assert.match(client,/discoveries=source\('discoveries'/);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));try{store.close();}catch{}fs.rmSync(base,{recursive:true,force:true});}
});
