import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import { processRouteObservation } from '../../scripts/scout/process-route.mjs';

const source=(source_id,role)=>({source_id,name:source_id,type:'synthetic',organisation:'test',expected_formats:['gpx'],coverage:{countries:['ZZ'],regions:['ZZ-test']},jurisdiction_ids:[],location:'synthetic fixture',adapter_version:'v1',licence:{name:'synthetic',version:'1'},reuse:{private_processing:true,redistribution:false,derived_public_use:false},roles:{discovery_only:role==='discovery',physical_existence:false,legal_access:false,routing_network:role==='network',public_reuse:false,jurisdiction_boundaries:false},update:{mechanism:'static'},attribution:'synthetic',rate_limits:{requests_per_minute:0}});
const edge=(id,coords,highway,surface)=>({edge_id:id,geometry:{type:'LineString',coordinates:coords},tags:{highway,surface}});
test('pinned regional processing saves road/trail segments and matching hypotheses without touching canonical data',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scout-process-')),store=new ScoutGeoStore(root);
  try {
    store.registerSource(source('synthetic-gpx','discovery'));store.registerSource(source('synthetic-network','network'));
    const f=store.recordFile({source_id:'synthetic-gpx',relative_name:'route.gpx',sha256:'c'.repeat(64),parser_version:'parser-v1',format:'gpx',raw_path:'private/raw',byte_size:1});
    const coords=[[-1,51],[-0.9995,51],[-0.999,51],[-0.9985,51],[-0.998,51]];
    store.completeFileImport(f.file_id,[{observation_id:'synthetic-observation-01',source_part:'track-1-segment-1',geometry:{type:'LineString',coordinates:coords},geometry_sha256:'synthetic-geometry',metadata:{}}]);
    store.recordNetworkSnapshot({snapshot_id:'network-snapshot-v1',source_id:'synthetic-network',version:'fixture-v1',checksum:'d'.repeat(64),licence:{name:'synthetic'},coverage:{countries:['ZZ']}});
    store.saveNetworkEdge('network-snapshot-v1',edge('road-a',[coords[0],coords[1]],'residential','asphalt'));
    store.saveNetworkEdge('network-snapshot-v1',edge('path-a',[coords[1],coords[3]],'path','ground'));
    store.saveNetworkEdge('network-snapshot-v1',edge('road-b',[coords[3],coords[4]],'tertiary','asphalt'));
    const master={feature_count:14315,sha256:'synthetic-canonical-checksum',match(candidate){assert.ok(candidate.geometry.coordinates.length>=2);return {type:'PARTIAL_OVERLAP',rtt_ids:['rtt-synthetic-0001'],scores:[{mean_m:1}],reason:null};}};
    const first=processRouteObservation(store,'synthetic-observation-01',{networkSnapshotId:'network-snapshot-v1',canonicalMaster:master});
    const second=processRouteObservation(store,'synthetic-observation-01',{networkSnapshotId:'network-snapshot-v1',canonicalMaster:master});
    assert.deepEqual(first.source_geometry,{type:'LineString',coordinates:coords});
    assert.equal(first.candidate_count,1);assert.equal(first.candidates[0].master_match,'PARTIAL_OVERLAP');
    assert.equal(first.candidates[0].motorcycle_access,'unknown');assert.equal(first.candidates[0].routability,'unknown');
    assert.deepEqual(JSON.parse(first.candidates[0].matched_rtt_ids_json),['rtt-synthetic-0001']);
    assert.equal(store.queryCandidateSegments([-1.01,50.99,-0.99,51.01]).length,1);
    assert.equal(second.candidates[0].candidate_version,1);assert.equal(second.candidates[0].updated_at,first.candidates[0].updated_at);
    assert.equal(store.getObservation('synthetic-observation-01').geometry.coordinates.length,coords.length);
    assert.ok(store.listReviewItems({state:'ALL'}).length>=2);
    assert.throws(()=>processRouteObservation(store,'synthetic-observation-01'),/explicit pinned/);
  } finally {store.close();fs.rmSync(root,{recursive:true,force:true});}
});
