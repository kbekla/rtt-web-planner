import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import { importOsmGeoJsonSeq } from '../../scripts/scout/osm-network-import.mjs';

function feature(id, highway, surface, coordinates) {
  return `\u001e${JSON.stringify({type:'Feature',id:`w${id}`,properties:{'@type':'way','@id':id,highway,surface},geometry:{type:'LineString',coordinates}})}\n`;
}
function setup() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scout-osm-import-')),store=new ScoutGeoStore(root);
  store.registerSource({source_id:'geofabrik-belgium',name:'Synthetic OSM snapshot',type:'regional-extract',organisation:'test',
    expected_formats:['pbf','geojsonseq'],coverage:{countries:['BE'],regions:['BE']},jurisdiction_ids:['BE'],location:'synthetic fixture',adapter_version:'osmium-test',
    licence:{name:'ODbL 1.0',version:'1.0'},reuse:{private_processing:true,redistribution:true,derived_public_use:false},
    roles:{discovery_only:false,physical_existence:false,legal_access:false,routing_network:true,public_reuse:true,jurisdiction_boundaries:false},
    update:{mechanism:'fixed fixture'},attribution:'© OpenStreetMap contributors',rate_limits:{requests_per_minute:0}});
  store.recordNetworkSnapshot({snapshot_id:'belgium-test-v1',source_id:'geofabrik-belgium',version:'fixture-date',checksum:'a'.repeat(64),
    licence:{name:'ODbL 1.0',version:'1.0'},coverage:{countries:['BE']}});
  return {root,store};
}

test('GeoJSON text sequence OSM roads import in idempotent resumable batches',async()=>{
  const {root,store}=setup();
  try {
    const input=feature(101,'residential','asphalt',[[4.3,50.8],[4.301,50.801]])+
      feature(102,'track','ground',[[4.31,50.81],[4.311,50.811]])+
      `\u001e${JSON.stringify({type:'Feature',id:'n99',properties:{'@type':'node','@id':99,highway:'crossing'},geometry:{type:'Point',coordinates:[4.3,50.8]}})}\n`;
    const first=await importOsmGeoJsonSeq(store,{stream:Readable.from([input]),snapshotId:'belgium-test-v1',batchSize:1,onBatch:({written})=>written===1});
    assert.deepEqual(first,{seen:1,written:1,yielded:true});
    const second=await importOsmGeoJsonSeq(store,{stream:Readable.from([input]),snapshotId:'belgium-test-v1',batchSize:1});
    assert.deepEqual(second,{seen:3,written:2,yielded:false});
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM network_edges').get().n,2);
    const rows=store.queryNetworkEdges([4.29,50.79,4.32,50.82],{snapshotId:'belgium-test-v1'});
    assert.deepEqual(rows.map(x=>x.edge_id),['osm:way:101','osm:way:102']);
    assert.equal(rows[0].tags.highway,'residential');assert.equal(rows[1].tags.surface,'ground');
  } finally {store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('osmium type_id feature IDs infer OSM object type and stable way identity',async()=>{
  const {root,store}=setup();
  try{
    const input=`\u001e${JSON.stringify({type:'Feature',id:'n99',properties:{highway:'crossing'},geometry:{type:'Point',coordinates:[4.3,50.8]}})}\n`+
      `\u001e${JSON.stringify({type:'Feature',id:'a77',properties:{amenity:'parking'},geometry:{type:'MultiPolygon',coordinates:[]}})}\n`+
      `\u001e${JSON.stringify({type:'Feature',id:'w123',properties:{highway:'track',surface:'ground'},geometry:{type:'LineString',coordinates:[[4.3,50.8],[4.31,50.81]]}})}\n`;
    const result=await importOsmGeoJsonSeq(store,{stream:Readable.from([input]),snapshotId:'belgium-test-v1'});
    assert.deepEqual(result,{seen:3,written:1,yielded:false});
    assert.equal(store.db.prepare('SELECT edge_id FROM network_edges').get().edge_id,'osm:way:123');
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('OSM network importer fails closed for missing identity, bad geometry and unregistered provenance',async()=>{
  const {root,store}=setup();
  try {
    assert.equal((await importOsmGeoJsonSeq(store,{stream:Readable.from([]),snapshotId:'belgium-test-v1'})).written,0);
    const noId=`\u001e${JSON.stringify({type:'Feature',properties:{highway:'track'},geometry:{type:'LineString',coordinates:[[1,1],[2,2]]}})}\n`;
    await assert.rejects(importOsmGeoJsonSeq(store,{stream:Readable.from([noId]),snapshotId:'belgium-test-v1'}),/stable OSM object ID/);
    const badGeometry=feature(103,'path','dirt',[[181,1],[182,2]]);
    await assert.rejects(importOsmGeoJsonSeq(store,{stream:Readable.from([badGeometry]),snapshotId:'belgium-test-v1'}),/valid WGS84/);
    await assert.rejects(importOsmGeoJsonSeq(store,{stream:Readable.from([]),snapshotId:'missing'}),/registered network snapshot/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM network_edges').get().n,0,'failed batches roll back atomically');
  } finally {store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('OSM GeoJSON-sequence resume skips only complete records and reports yield at EOF',async()=>{
  const {root,store}=setup();
  try{
    const input=feature(201,'track','ground',[[4.3,50.8],[4.301,50.801]])+
      feature(202,'path','dirt',[[4.31,50.81],[4.311,50.811]]);
    const first=await importOsmGeoJsonSeq(store,{stream:Readable.from([input]),snapshotId:'belgium-test-v1',batchSize:1,onBatch:({seen})=>seen===1});
    assert.deepEqual(first,{seen:1,written:1,yielded:true});
    const resumed=await importOsmGeoJsonSeq(store,{stream:Readable.from([input]),snapshotId:'belgium-test-v1',batchSize:10,skipRecords:1,onBatch:({seen})=>seen===2});
    assert.deepEqual(resumed,{seen:2,written:1,yielded:true});
    assert.equal(store.networkEdgeCount('belgium-test-v1'),2);
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
