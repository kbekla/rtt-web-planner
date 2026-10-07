import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNvdbSequenceCorridors, classifyPhysicalRoad, comparePhysicalNetworkEdges } from '../../scripts/scout/physical-road-model.mjs';
import { buildNorwayNvdbCorridors } from '../../scripts/scout/norway-phase2.mjs';
import { nvdbNorwaySourceDefinition } from '../../scripts/scout/nvdb-network.mjs';

const line = (coordinates, edge_id, tags = {}, start_node = null, end_node = null) => ({
  edge_id, geometry: { type: 'LineString', coordinates }, tags, start_node, end_node,
});
const base = [[10, 60], [10.001, 60], [10.002, 60]];

test('physical road/surface classification keeps ordinary gravel roads as roads and access independent', () => {
  const paved = classifyPhysicalRoad({ highway: 'tertiary', surface: 'asphalt' });
  const gravel = classifyPhysicalRoad({ highway: 'tertiary', surface: 'gravel' });
  const track = classifyPhysicalRoad({ highway: 'track', surface: 'gravel' });
  assert.equal(paved.physical_character, 'PAVED_ROAD');
  assert.equal(gravel.physical_character, 'GRAVEL_ROAD');
  assert.equal(gravel.network_role, 'ORDINARY_ROAD');
  assert.equal(track.network_role, 'POTENTIAL_SPECIAL_ROUTE');
  for (const result of [paved, gravel, track]) {
    assert.equal(result.access, 'UNKNOWN');
    assert.equal(result.routability, 'UNKNOWN');
  }
  assert.equal(classifyPhysicalRoad({ highway: 'track' }).physical_character, 'OTHER_ENGINEERED_ROAD');
});

test('NVDB physical road class does not infer surface or motorcycle permission', () => {
  const result = classifyPhysicalRoad({ 'nvdb:type_veg': 'Skogsbilveg' }, 'NVDB');
  assert.equal(result.physical_character, 'FOREST_ROAD');
  assert.equal(result.access, 'UNKNOWN');
  assert.equal(result.routability, 'UNKNOWN');
});

test('cross-source exact support needs identity or explicit topology as well as ordered geometry', () => {
  const a = line(base, 'nvdb:1', { ref: 'Fv 12' }, 'n1', 'n2');
  const b = line([...base].reverse(), 'osm:1', { ref: 'Fv 12' }, 'n2', 'n1');
  const result = comparePhysicalNetworkEdges(a, b);
  assert.equal(result.relationship, 'EXACT_CORRIDOR_SUPPORT');
  assert.equal(result.proximity_is_sufficient, false);
});

test('same geometry without independent identity remains ambiguous rather than merged', () => {
  const a = line(base, 'nvdb:1');
  const b = line(base, 'osm:1');
  assert.equal(comparePhysicalNetworkEdges(a, b).relationship, 'AMBIGUOUS_IDENTITY');
});

test('nearby parallel roads remain distinct and a competing edge makes identity ambiguous', () => {
  const shifted = base.map(([x, y]) => [x, y + 0.00004]);
  const a = line(base, 'nvdb:1', { ref: 'Fv 12' }, 'n1', 'n2');
  const b = line(shifted, 'osm:1', { ref: 'Fv 12' }, 'n1', 'n2');
  const competitor = line(base, 'osm:2', { ref: 'Fv 12' }, 'n1', 'n2');
  const result = comparePhysicalNetworkEdges(a, b, { competitors: [competitor] });
  assert.equal(result.relationship, 'AMBIGUOUS_IDENTITY');
  assert.match(result.reason, /competing/);
});

test('crossing geometry and proximity without shared topology do not establish identity', () => {
  const a = line([[10, 60], [10.002, 60]], 'nvdb:1');
  const crossing = line([[10.001, 59.999], [10.001, 60.001]], 'osm:1');
  assert.equal(comparePhysicalNetworkEdges(a, crossing).relationship, 'NO_RELATION');
});

test('only an independently shared node supports partial corridor correspondence', () => {
  const a = line([[10, 60], [10.001, 60], [10.002, 60]], 'nvdb:1', {}, 'n0', 'n2');
  const b = line([[10.001, 60], [10.002, 60], [10.003, 60]], 'osm:1', {}, 'n2', 'n3');
  const result = comparePhysicalNetworkEdges(a, b, { maxDistanceM: 3 });
  assert.equal(result.relationship, 'PARTIAL_CORRIDOR_SUPPORT');
});

test('NVDB sequence corridor hypotheses require exact ordered position and shared node, preserve every edge', () => {
  const make=(number,start,end,startNode,endNode,coords)=>({edge_id:`nvdb:${number}`,geometry:{type:'LineString',coordinates:coords},evidence:[{topology:{sequence_id:'s1',link_number:number,segment_number:'1',start_position:start,end_position:end,start_node:startNode,end_node:endNode}}]});
  const a=make(1,0,.5,'n1','n2',[[10,60],[10.001,60]]),b=make(2,.5,1,'n2','n3',[[10.001,60],[10.002,60]]),
    gap=make(3,1,1.5,'n3','n4',[[10.01,60],[10.011,60]]);
  const corridors=buildNvdbSequenceCorridors([a,b,gap]);
  assert.equal(corridors.length,2);
  const joined=corridors.find(x=>x.member_edge_ids.length===2);
  assert.deepEqual(joined.member_edge_ids,['nvdb:1','nvdb:2']);
  assert.equal(joined.identity_state,'TOPOLOGY_BACKED');
  assert.equal(joined.support.geometry_was_merged,false);
  assert.equal(joined.support.legal_access,'UNKNOWN');
  assert.equal(corridors.find(x=>x.member_edge_ids[0]==='nvdb:3').identity_state,'AMBIGUOUS_IDENTITY');
});

test('NVDB sequence branch or duplicated position remains ambiguous rather than merged', () => {
  const make=(id,start,end,startNode,endNode,coordinates)=>({edge_id:id,geometry:{type:'LineString',coordinates},evidence:[{topology:{sequence_id:'s2',link_number:id,segment_number:'1',start_position:start,end_position:end,start_node:startNode,end_node:endNode}}]});
  const from=make('a',0,.5,'n1','n2',[[10,60],[10.001,60]]),b=make('b',.5,1,'n2','n3',[[10.001,60],[10.002,60]]),c=make('c',.5,1,'n2','n4',[[10.001,60],[10.002,60.00001]]);
  const corridors=buildNvdbSequenceCorridors([from,b,c]);
  assert.ok(corridors.every(x=>x.identity_state==='AMBIGUOUS_IDENTITY'));
  assert.equal(corridors.reduce((n,x)=>n+x.member_edge_ids.length,0),3);
});

test('private NVDB sequence grouping checkpoints by sequence and resumes without changing source links',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scout-no-phase2-corridors-')),store=new ScoutGeoStore(root);
  try{
    const source=nvdbNorwaySourceDefinition();
    store.registerSource(source);store.recordNetworkSnapshot({snapshot_id:'no-nvdb-phase1-20261006',source_id:source.source_id,version:'fixture',checksum:'2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1',licence:source.licence,coverage:{countries:['NO'],regions:['NO']}});
    const coords=[[10,60],[10.001,60],[10.002,60]],edge=(id,start,end,startNode,endNode,line)=>({edge_id:id,geometry:{type:'LineString',coordinates:line},tags:{'nvdb:type_veg':'Skogsbilveg'},evidence:[{topology:{sequence_id:'1',link_number:id.endsWith('1')?1:2,segment_number:'1',start_position:start,end_position:end,start_node:startNode,end_node:endNode}}]});
    store.saveNetworkEdges('no-nvdb-phase1-20261006',[edge('nvdb:1',0,.5,'n1','n2',coords.slice(0,2)),edge('nvdb:2',.5,1,'n2','n3',coords.slice(1))]);
    assert.equal((await buildNorwayNvdbCorridors(store,{snapshotId:'no-nvdb-phase1-20261006',expectedChecksum:'2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1',shouldYield:()=>true})).status,'BLOCKED');
    const complete=await buildNorwayNvdbCorridors(store,{snapshotId:'no-nvdb-phase1-20261006',expectedChecksum:'2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1'});
    assert.equal(complete.status,'COMPLETE');assert.equal(complete.corridor_count,1);assert.equal(complete.link_count,2);
    assert.equal((await buildNorwayNvdbCorridors(store,{snapshotId:'no-nvdb-phase1-20261006',expectedChecksum:'2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1'})).status,'REUSED');
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('NVDB corridor transaction batches roll back completely on a mid-batch factory yield',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scout-no-phase2-batch-yield-')),store=new ScoutGeoStore(root);
  try{
    const source=nvdbNorwaySourceDefinition();store.registerSource(source);store.recordNetworkSnapshot({snapshot_id:'no-nvdb-phase1-20261006',source_id:source.source_id,version:'fixture',checksum:'2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1',licence:source.licence,coverage:{countries:['NO'],regions:['NO']}});
    const edge=(sequenceId,id,offset)=>({edge_id:`nvdb:${sequenceId}:${id}`,geometry:{type:'LineString',coordinates:[[10+offset,60],[10.001+offset,60]]},tags:{'nvdb:type_veg':'Skogsbilveg'},evidence:[{topology:{sequence_id:sequenceId,link_number:1,segment_number:'1',start_position:0,end_position:1,start_node:`${sequenceId}-a`,end_node:`${sequenceId}-b`}}]});
    store.saveNetworkEdges('no-nvdb-phase1-20261006',[edge('seq-a','1',0),edge('seq-b','1',.01)]);
    let checks=0;const yielded=await buildNorwayNvdbCorridors(store,{snapshotId:'no-nvdb-phase1-20261006',expectedChecksum:'2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1',batchSequences:2,shouldYield:()=>++checks===2});
    assert.equal(yielded.status,'BLOCKED');assert.equal(yielded.link_count,0);
    assert.equal(store.db.prepare("SELECT records_seen FROM phase2_stage_state WHERE stage='NVDB_SEQUENCE_CORRIDORS'").get().records_seen,0);
    const resumed=await buildNorwayNvdbCorridors(store,{snapshotId:'no-nvdb-phase1-20261006',expectedChecksum:'2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1',batchSequences:2});
    assert.equal(resumed.status,'COMPLETE');assert.equal(resumed.link_count,2);assert.equal(resumed.corridor_count,2);
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('NVDB corridor builder yields to queued process signals between atomic sequence batches',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scout-no-phase2-event-loop-yield-')),store=new ScoutGeoStore(root);
  try{
    const source=nvdbNorwaySourceDefinition();store.registerSource(source);store.recordNetworkSnapshot({snapshot_id:'no-nvdb-phase1-20261006',source_id:source.source_id,version:'fixture',checksum:'2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1',licence:source.licence,coverage:{countries:['NO'],regions:['NO']}});
    const edge=(sequenceId,offset)=>({edge_id:`nvdb:${sequenceId}`,geometry:{type:'LineString',coordinates:[[10+offset,60],[10.001+offset,60]]},tags:{'nvdb:type_veg':'Skogsbilveg'},evidence:[{topology:{sequence_id:sequenceId,link_number:1,segment_number:'1',start_position:0,end_position:1,start_node:`${sequenceId}-a`,end_node:`${sequenceId}-b`}}]});
    store.saveNetworkEdges('no-nvdb-phase1-20261006',[edge('seq-a',0),edge('seq-b',.01),edge('seq-c',.02)]);
    let signalRequested=false;setImmediate(()=>{signalRequested=true;});
    const stopped=await buildNorwayNvdbCorridors(store,{snapshotId:'no-nvdb-phase1-20261006',expectedChecksum:'2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1',batchSequences:1,shouldYield:()=>signalRequested});
    assert.equal(stopped.status,'BLOCKED');assert.equal(stopped.link_count,1);
    const checkpoint=store.db.prepare("SELECT status,cursor,records_seen FROM phase2_stage_state WHERE stage='NVDB_SEQUENCE_CORRIDORS'").get();
    assert.equal(checkpoint.status,'BLOCKED');assert.equal(checkpoint.cursor,'seq-a');assert.equal(checkpoint.records_seen,1);
    const seekPlan=store.db.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT json_extract(evidence_json,'$[0].topology.sequence_id') AS sequence_id FROM network_edges WHERE snapshot_id=? AND json_extract(evidence_json,'$[0].topology.sequence_id') IS NOT NULL AND json_extract(evidence_json,'$[0].topology.sequence_id')>? ORDER BY sequence_id LIMIT ?`).all('no-nvdb-phase1-20261006','seq-a',1).map(row=>row.detail).join(' ');
    assert.match(seekPlan,/phase2_nvdb_sequence_order_idx/);assert.match(seekPlan,/<expr>>\?/);
    const resumed=await buildNorwayNvdbCorridors(store,{snapshotId:'no-nvdb-phase1-20261006',expectedChecksum:'2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1',batchSequences:1});
    assert.equal(resumed.status,'COMPLETE');assert.equal(resumed.link_count,3);assert.equal(resumed.corridor_count,3);
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
