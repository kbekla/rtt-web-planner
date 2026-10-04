import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import { createRealReviewServer } from '../../scripts/scout/review-real-server.mjs';

const source=(source_id,{network=false}={})=>({source_id,name:source_id,type:'synthetic',organisation:'test',expected_formats:['gpx','pbf'],
  coverage:{countries:['BE'],regions:['BE']},jurisdiction_ids:['BE-country'],location:'synthetic fixture',adapter_version:'fixture-v1',licence:{name:'synthetic',version:'1'},
  reuse:{private_processing:true,redistribution:false,derived_public_use:false},roles:{discovery_only:!network,physical_existence:false,legal_access:false,routing_network:network,public_reuse:false,jurisdiction_boundaries:network},
  update:{mechanism:'fixed fixture'},attribution:'synthetic; no external data',rate_limits:{requests_per_minute:0}});

test('real Scout reviewer is loopback-only, read-only, private-root constrained, and serves bounded BE records',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'scout-real-review-')),root=path.join(base,'be-20000101'),store=new ScoutGeoStore(path.join(root,'state'));
  let server,serverError;
  try{
    store.registerSource(source('tet-belgium-private-discovery'));
    store.registerSource(source('geofabrik-osm-belgium',{network:true}));
    store.recordNetworkSnapshot({snapshot_id:'geofabrik-be-261003',source_id:'geofabrik-osm-belgium',version:'fixture',checksum:'a'.repeat(64),
      licence:{name:'ODbL 1.0',attribution:'© OpenStreetMap contributors'},coverage:{countries:['BE']}});
    const file=store.recordFile({source_id:'tet-belgium-private-discovery',relative_name:'B.gpx',sha256:'b'.repeat(64),parser_version:'fixture',format:'gpx',raw_path:'/private/never-served/B.gpx',byte_size:12});
    store.completeFileImport(file.file_id,[{observation_id:'be-review-obs',source_part:'track-1-segment-1',source_name:'private track name',
      geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]},geometry_sha256:'c'.repeat(64),metadata:{raw_source_ref:'/private/never-served/B.gpx'}}]);
    store.saveNetworkEdge('geofabrik-be-261003',{edge_id:'osm:way:5',geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]},tags:{highway:'track',surface:'ground'}});
    const prior={segment_id:'be-review-old-seg',observation_id:'be-review-obs',ordinal:0,component_index:0,classification:'ROAD',confidence:0.8,
      geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]},evidence:[],pipeline_version:'network-segmenter-1',jurisdiction_ids:['BE-country']};
    store.saveSegment(prior);store.saveCandidate(prior,{candidate_id:'be-review-old-candidate',network_snapshot_id:'geofabrik-be-261003'});
    const prior2={...prior,segment_id:'be-review-old-seg-2',ordinal:1,geometry:{type:'LineString',coordinates:[[4.31,50.81],[4.32,50.82]]}};
    store.saveSegment(prior2);store.saveCandidate(prior2,{candidate_id:'be-review-old-candidate-2',network_snapshot_id:'geofabrik-be-261003'});
    store.saveCorridorHypothesis({hypothesis_id:'be-review-old-hypothesis',observation_id:'be-review-obs',component_index:0,network_snapshot_id:'geofabrik-be-261003',
      candidate_ids:['be-review-old-candidate','be-review-old-candidate-2'],connector_segment_ids:[],support_edge_ids:['osm:way:5#part:0'],connector_length_m:0,
      hypothesis:'SAME_OSM_WAY_WITH_AMBIGUOUS_CONNECTOR',geometry_gap_filled:false,evidence:{rule:'old-generation-fixture'}});
    const segment={segment_id:'be-review-seg',observation_id:'be-review-obs',ordinal:0,component_index:0,classification:'PROBABLE_OFFROAD',confidence:0.8,
      geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]},evidence:[{rule:'nearest-network-edge',edge_id:'osm:way:5'}],pipeline_version:'network-segmenter-2.2',jurisdiction_ids:['BE-country']};
    store.saveSegment(segment);store.saveCandidate(segment,{candidate_id:'be-review-candidate',master_match:'UNMATCHED',network_snapshot_id:'geofabrik-be-261003',
      physical_state:'unknown',motorcycle_access:'unknown',routability:'unknown',review_state:'AWAITING_EVIDENCE',jurisdiction_ids:['BE-country']});
    store.saveSegment({segment_id:'be-review-unknown',observation_id:'be-review-obs',ordinal:1,component_index:0,classification:'UNKNOWN',confidence:null,
      geometry:{type:'LineString',coordinates:[[4.31,50.81],[4.311,50.811]]},evidence:[{rule:'no-network-match-within-threshold',threshold_m:8}],
      pipeline_version:'network-segmenter-2.2',jurisdiction_ids:['BE-country']});
    assert.ok(store.db.prepare("PRAGMA index_list('route_segments')").all().some(index=>index.name==='segments_observation_pipeline_idx'));
    store.close();
    server=createRealReviewServer({runId:'be-20000101',privateBase:base,port:0,onError:error=>{serverError=error;}});await new Promise(resolve=>server.once('listening',resolve));
    const address=`http://127.0.0.1:${server.address().port}`;
    const page=await fetch(address);assert.equal(page.status,200);const html=await page.text();assert.match(html,/Canonical comparison was not performed/);
    assert.match(html,/UNKNOWN reason/);assert.match(html,/Candidate length/);assert.match(html,/Match-margin score/);
    assert.match(html,/Ambiguous connector hypothesis \(not merged\)/);const client=await fetch(`${address}/review.js`);assert.equal(client.status,200);assert.match(await client.text(),/continuity-hypothesis-line/);
    const getJson=async(url)=>{serverError=null;const response=await fetch(url),text=await response.text();assert.equal(response.status,200,`${url}: ${text}\n${serverError?.stack??''}`);return JSON.parse(text);};
    const css=await fetch(`${address}/vendor/maplibre-gl/maplibre-gl.css`);assert.equal(css.status,200);assert.match(css.headers.get('content-type'),/text\/css/);
    assert.equal((await fetch(`${address}/vendor/maplibre-gl/maplibre-gl.mjs`)).status,200);
    assert.equal((await fetch(`${address}/vendor/maplibre-gl/maplibre-gl.mjs.map`)).status,404);
    const status=await getJson(`${address}/api/status`);assert.equal(status.private_data_loaded,true);assert.equal(status.read_only,true);assert.equal(status.candidates,1);assert.equal(status.segments,2);assert.equal(status.corridor_hypotheses,0);assert.equal(status.matched_network_edge_ids,1);
    const routes=await getJson(`${address}/api/source-routes`);assert.equal(routes.features.length,1);assert.equal(routes.features[0].properties.source_id,'tet-belgium-private-discovery');
    assert.equal(JSON.stringify(status).includes('/private/never-served'),false);assert.equal(JSON.stringify(routes).includes('/private/never-served'),false);
    const segments=await getJson(`${address}/api/segments?bbox=4.2,50.7,4.4,50.9`);assert.equal(segments.features.length,2);
    assert.equal(segments.features[0].properties.motorcycle_access,'unknown');assert.equal(segments.features[0].properties.routability,'unknown');
    const trail=segments.features.find(f=>f.properties.candidate_id),unknown=segments.features.find(f=>f.properties.classification==='UNKNOWN');
    assert.equal(trail.properties.length_m>0,true);assert.equal(trail.properties.network_matches[0].tags.surface,'ground');assert.equal(unknown.properties.unknown_reason,'no_network_match');
    const network=await getJson(`${address}/api/network?bbox=4.2,50.7,4.4,50.9&zoom=10`);assert.equal(network.features[0].properties.highway,'track');
    assert.equal((await fetch(`${address}/api/network?bbox=4.2,50.7,4.4,50.9&limit=5001&zoom=10`)).status,400);
    assert.equal((await fetch(address,{method:'POST'})).status,405);assert.equal((await fetch(`${address}/api/unknown`)).status,404);
    assert.deepEqual(await getJson(`${address}/api/canonical`),{type:'FeatureCollection',features:[],coverage:'no Belgian RT&T canonical master supplied'});
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
