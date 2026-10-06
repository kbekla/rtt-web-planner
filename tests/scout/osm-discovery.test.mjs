import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ScoutGeoStore} from '../../scripts/scout/geostore.mjs';
import {discoverOsmRun,discoveryStats,osmDiscoverySelection,registerOsmDiscoverySource} from '../../scripts/scout/osm-discovery.mjs';
import {jurisdictionViewport} from '../../scripts/scout/geoctl.mjs';
import {benchmarkTetAgainstIndependentDiscovery,writePrivateTetBenchmark} from '../../scripts/scout/tet-benchmark.mjs';

const source=(source_id,{network=false,discovery=false}={})=>({source_id,name:source_id,type:network?'synthetic-osm-network':'synthetic',organisation:'test',expected_formats:['gpx','pbf','registered-osm-network-snapshot'],
  coverage:{countries:['BE'],regions:['BE']},jurisdiction_ids:['BE-country'],location:{kind:'synthetic'},adapter_version:'fixture-v1',licence:{name:'ODbL',version:'1',attribution:'© OSM'},
  reuse:{private_processing:true,redistribution:false,derived_public_use:false},roles:{discovery_only:discovery,physical_existence:discovery,legal_access:false,routing_network:network,public_reuse:false,jurisdiction_boundaries:network},
  update:{mechanism:'fixed fixture'},attribution:'synthetic OSM fixture',rate_limits:{requests_per_minute:0},...(network?{}:{})});

test('independent OSM discovery completes without TET links; the separate final benchmark may then compare exact network parts',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scout-osm-discovery-')),store=new ScoutGeoStore(root);
  try{
    store.registerSource(source('osm-parent',{network:true}));
    store.recordNetworkSnapshot({snapshot_id:'be-fixture-v1',source_id:'osm-parent',version:'BE fixture',checksum:'a'.repeat(64),licence:{name:'ODbL',version:'1',attribution:'© OSM'},coverage:{countries:['BE']}});
    store.addJurisdiction({jurisdiction_id:'BE-country',country_code:'BE',version:'independent-boundary-v1',boundary:{type:'Polygon',coordinates:[[[2,49],[7,49],[7,52],[2,52],[2,49]]]},
      boundary_source:{source_id:'osm-parent',version:'fixture',checksum:'e'.repeat(64),licence:{name:'ODbL',version:'1'}},metadata:{}});
    const discoverySource=registerOsmDiscoverySource(store,'be-fixture-v1').source,area=jurisdictionViewport(store,discoverySource,'BE');
    assert.ok(area.viewport[0]<2.01&&area.viewport[2]>6.99,'discovery bounds come from registered country coverage, not the narrow route fixture');
    for(const [edge_id,tags,coordinates] of [
      ['w-101',{highway:'track',surface:'ground',tracktype:'grade3'},[[4.3,50.8],[4.301,50.801]]],
      ['w-102',{highway:'service',surface:'asphalt',service:'driveway'},[[4.4,50.8],[4.401,50.801]]],
      ['w-103',{highway:'path',surface:'gravel',motorcycle:'no'},[[4.5,50.8],[4.501,50.801]]],
      ['w-104',{highway:'track',surface:'asphalt'},[[4.6,50.8],[4.601,50.801]]],
      ['w-105',{highway:'unclassified',surface:'dirt'},[[4.7,50.8],[4.701,50.801]]],
      ['w-106',{highway:'footway'},[[4.8,50.8],[4.801,50.801]]],
      ['w-107',{highway:'track'},[[4.9,50.8],[4.901,50.801]]],
    ])store.saveNetworkEdge('be-fixture-v1',{edge_id,geometry:{type:'LineString',coordinates},tags});
    const d=registerOsmDiscoverySource(store,'be-fixture-v1');assert.equal(d.source.roles.legal_access,false);assert.equal(d.source.reuse.derived_public_use,false);
    store.approveSource({source_id:d.source.source_id,approved_by:'Karl',scope:'Belgium private discovery fixture',approved_at:'2026-10-05T00:00:00.000Z'});
    store.registerSource(source('tet-as-network',{network:true,discovery:true}));
    store.recordNetworkSnapshot({snapshot_id:'tet-is-not-a-network',source_id:'tet-as-network',version:'fixture',checksum:'f'.repeat(64),licence:{name:'private',version:'1'},coverage:{countries:['BE']}});
    assert.throws(()=>registerOsmDiscoverySource(store,'tet-is-not-a-network'),/public OSM routing-network source/);
    store.registerSource(source('tet-hint',{discovery:true}));
    const file=store.recordFile({source_id:'tet-hint',relative_name:'hint.gpx',sha256:'b'.repeat(64),parser_version:'fixture',format:'gpx',raw_path:path.join(root,'private.gpx'),byte_size:1});
    store.completeFileImport(file.file_id,[{observation_id:'tet-observation',source_part:'part-1',geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.301,50.801]]},geometry_sha256:'c'.repeat(64)}]);
    store.approveSource({source_id:'tet-hint',approved_by:'Karl',scope:'Belgium private discovery fixture'});
    store.saveSegment({segment_id:'tet-probable',observation_id:'tet-observation',ordinal:0,component_index:0,classification:'PROBABLE_OFFROAD',confidence:0.5,
      geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.301,50.801]]},evidence:[{rule:'interval-network-support',edge_id:'w-101',edge_part_id:'w-101#part:0'}],pipeline_version:'network-segmenter-2.2',jurisdiction_ids:[]});
    store.saveCandidate({segment_id:'tet-probable',observation_id:'tet-observation',classification:'PROBABLE_OFFROAD',geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.301,50.801]]},evidence:[],pipeline_version:'network-segmenter-2.2'},
      {candidate_id:'tet-candidate-1',network_snapshot_id:'be-fixture-v1'});
    const reference=store.createRun({run_id:'tet-reference',source_id:'tet-hint',snapshot_id:'be-fixture-v1',country_code:'BE',region_id:'BE',viewport:[2,49,7,52],approved_by:'Karl',approval_scope:'Belgium private discovery fixture'});
    store.setRunObservation(reference.run_id,'tet-observation','COMPLETE',{pipeline_version:'network-segmenter-2.2'});
    assert.throws(()=>store.createDiscoveryRun({run_id:'be-discovery-invalid',discovery_source_id:d.source.source_id,snapshot_id:'be-fixture-v1',country_code:'BE',region_id:'BE',reference_run_id:'tet-reference',
      viewport:[2,49,7,52],approved_by:'Karl',approval_scope:'Belgium private discovery fixture',config:{discovery_version:'osm-way-discovery-1'}}),/post-completion benchmark/);
    const run=store.createDiscoveryRun({run_id:'be-discovery',discovery_source_id:d.source.source_id,snapshot_id:'be-fixture-v1',country_code:'BE',region_id:'BE',
      viewport:[2,49,7,52],approved_by:'Karl',approval_scope:'Belgium private discovery fixture',config:{discovery_version:'osm-way-discovery-1'}});
    assert.equal(store.createDiscoveryRun({run_id:'be-discovery',discovery_source_id:d.source.source_id,snapshot_id:'be-fixture-v1',country_code:'BE',region_id:'BE',
      viewport:[2,49,7,52],approved_by:'Karl',approval_scope:'Belgium private discovery fixture',config:{discovery_version:'osm-way-discovery-1'}}).run_id,run.run_id);
    const yielded=discoverOsmRun(store,run.run_id,{batchSize:2,shouldYield:()=>true,yieldReason:()=> 'factory priority requested a shared-admission yield'});assert.equal(yielded.status,'BLOCKED');assert.equal(yielded.resumable,true);assert.equal(yielded.edges_examined,0);
    assert.equal(yielded.reason,'factory priority requested a shared-admission yield');assert.equal(store.getDiscoveryRun(run.run_id).last_error,yielded.reason);
    const result=discoverOsmRun(store,run.run_id,{batchSize:2});assert.equal(result.status,'COMPLETE');assert.equal(result.research_state,'SCOUT_RESEARCH_REQUIRED');assert.equal(result.candidate_count,4);
    assert.equal(result.independent_of_tet_count,4);assert.equal(result.matched_tet_candidate_count,null);assert.equal(result.benchmark_state,'NOT_RUN');assert.equal(result.explicit_restriction_tag_count,1);
    assert.equal(store.db.prepare('SELECT count(*) n FROM discovery_candidate_matches m JOIN discovery_candidates c USING(candidate_id) WHERE c.run_id=?').get(run.run_id).n,0);
    assert.equal(result.motorcycle_access_unknown,4);assert.equal(result.routability_unknown,4);assert.equal(result.canonical_status,'NOT_COMPARED');
    assert.equal(result.geometry_parallel_or_ambiguous_match_count,null,'unrun geometric ambiguity checks are not reported as zero');
    assert.equal(result.ambiguous_physical_character_count,1);
    const view=store.queryDiscoveryCandidates(run.run_id,[2,49,7,52],{limit:10});assert.equal(view.features.length,4);
    const supported=view.features.find(x=>x.edge_id==='w-101');assert.deepEqual(supported.matches,[]);assert.equal(supported.physical_state,'probable');
    assert.equal(supported.motorcycle_access,'unknown');assert.equal(supported.routability,'unknown');assert.equal(supported.canonical_status,'NOT_COMPARED');
    const restricted=view.features.find(x=>x.edge_id==='w-103');assert.equal(restricted.tags.motorcycle,'no');assert.equal(restricted.motorcycle_access,'unknown');
    assert.equal(discoveryStats(store,run.run_id).candidate_count,4);
    assert.equal(discoverOsmRun(store,run.run_id).candidate_count,4,'resume/replay does not duplicate candidate way-parts');
    const repeatRun=store.createDiscoveryRun({run_id:'be-discovery-repeat',discovery_source_id:d.source.source_id,snapshot_id:'be-fixture-v1',country_code:'BE',region_id:'BE',
      viewport:[2,49,7,52],approved_by:'Karl',approval_scope:'Belgium private discovery fixture',config:{discovery_version:'osm-way-discovery-1'}});
    const repeat=discoverOsmRun(store,repeatRun.run_id);assert.equal(repeat.candidate_count,4,'separate approved runs retain their own candidate records');
    assert.notEqual(store.queryDiscoveryCandidates(run.run_id,[2,49,7,52],{limit:10}).features[0].candidate_id,
      store.queryDiscoveryCandidates(repeatRun.run_id,[2,49,7,52],{limit:10}).features[0].candidate_id);
    const pendingRun=store.createDiscoveryRun({run_id:'be-discovery-pending',discovery_source_id:d.source.source_id,snapshot_id:'be-fixture-v1',country_code:'BE',region_id:'BE',
      viewport:[2,49,7,52],approved_by:'Karl',approval_scope:'Belgium private discovery fixture',config:{discovery_version:'osm-way-discovery-1'}});
    assert.throws(()=>benchmarkTetAgainstIndependentDiscovery(store,{independentRunId:pendingRun.run_id,referenceRunId:'tet-reference'}),/gated until independent discovery is COMPLETE/);
    const report=benchmarkTetAgainstIndependentDiscovery(store,{independentRunId:run.run_id,referenceRunId:'tet-reference'});
    assert.equal(report.phase,'PHASE_1_BENCHMARK_ONLY');assert.equal(report.phase2_release,'NOT_APPROVED');
    assert.equal(report.total_reference_corridors_or_features,1);assert.equal(report.independently_rediscovered,1);assert.equal(report.rediscovery_percent,100);
    assert.deepEqual(report.matches,{exact:1,partial:0,parallel:null,ambiguous:null,unmatched:0});
    assert.equal(report.physical_classification_agreement.agreed,1);assert.equal(report.product_state_counts.ORANGE,4);
    assert.equal(report.authoritative_state_comparison.green,null);assert.equal(report.authoritative_upgrades_or_downgrades,null);
    const reportPath=writePrivateTetBenchmark(root,report);assert.equal(fs.statSync(reportPath).mode&0o777,0o600);assert.throws(()=>writePrivateTetBenchmark(root,report),/already exists/);
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('OSM discovery selection uses physical and network context but not access tags to classify or grant access',()=>{
  const pathOnly=osmDiscoverySelection({highway:'path',motorcycle:'yes'});
  assert.equal(pathOnly,null,'a motor access tag alone does not signal off-road physical character');
  const rough=osmDiscoverySelection({highway:'path',smoothness:'bad',motorcycle:'no'});
  assert.equal(rough.classification,'UNKNOWN');assert.equal(rough.motorcycle_access,'unknown');assert.equal(rough.restrictive_tags.motorcycle,'no');
  assert.equal(osmDiscoverySelection({highway:'construction',surface:'ground'}),null);
});
