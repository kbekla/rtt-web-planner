import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import { ingestRouteFile } from '../../scripts/scout/route-import.mjs';
import { acquireNetworkSnapshot, importNetworkArtifact, resolveNetworkExtract } from '../../scripts/scout/network-provider.mjs';
import { runGeoCtl } from '../../scripts/scout/geoctl.mjs';
import { NotificationCenter } from '../../scripts/scout/core.mjs';

const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'scout-operator-'));
const routeSource=(source_id='synthetic-routes')=>({source_id,name:'Synthetic approved route source',type:'route-file',organisation:'fixture',expected_formats:['gpx'],coverage:{countries:['ZZ'],regions:['ZZ-test']},jurisdiction_ids:['ZZ-country'],location:'synthetic fixture',adapter_version:'route-import-v1',licence:{name:'synthetic',version:'1'},reuse:{private_processing:true,redistribution:false,derived_public_use:false},roles:{discovery_only:true,physical_existence:false,legal_access:false,routing_network:false,public_reuse:false,jurisdiction_boundaries:false},update:{mechanism:'explicit operator import'},attribution:'synthetic fixture',rate_limits:{requests_per_minute:0}});
const networkSource=(sha='a'.repeat(64))=>({...routeSource('synthetic-network'),name:'Synthetic pinned network extract',type:'regional-network',expected_formats:['pbf'],adapter_version:'osmium-v1',licence:{name:'ODbL',version:'1'},reuse:{private_processing:true,redistribution:true,derived_public_use:false},roles:{discovery_only:false,physical_existence:false,legal_access:false,routing_network:true,public_reuse:true,jurisdiction_boundaries:false},attribution:'© OpenStreetMap contributors',network_extract:{provider:'geofabrik',url:'https://download.geofabrik.de/europe/zz-test-261003.osm.pbf',version:'2026-10-03',snapshot_id:'zz-261003',sha256:sha,country_code:'ZZ'}});
function setup({networkSha='a'.repeat(64)}={}){const dir=root(),store=new ScoutGeoStore(path.join(dir,'private'));store.registerSource(routeSource());store.registerSource(networkSource(networkSha));store.recordNetworkSnapshot({snapshot_id:'zz-261003',source_id:'synthetic-network',version:'2026-10-03',checksum:networkSha,licence:{name:'ODbL',version:'1',attribution:'© OpenStreetMap contributors'},coverage:{countries:['ZZ']}});return {dir,privateRoot:path.join(dir,'private'),store};}
function approve(store){return store.approveSource({source_id:'synthetic-routes',approved_by:'Synthetic operator',scope:'Private fixture processing',approved_at:'2026-10-04T00:00:00.000Z'});}
function fakeResponse(bytes,{status=200,headers={}}={}){return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=4)controller.enqueue(bytes.subarray(i,i+4));controller.close();}}),{status,headers});}

test('run creation requires explicit source approval and persists immutable, resumable state',()=>{
  const {dir,store}=setup();try{
    const input=path.join(dir,'selected.gpx');fs.writeFileSync(input,'<gpx><trk><trkseg><trkpt lat="0" lon="0"/><trkpt lat="0.01" lon="0.01"/></trkseg></trk></gpx>');
    const imported=ingestRouteFile(store,{inputFile:input,sourceId:'synthetic-routes',rawRoot:path.join(dir,'raw')});
    const args={run_id:'zz-operator-fixture',source_id:'synthetic-routes',snapshot_id:'zz-261003',country_code:'ZZ',region_id:'ZZ-test',viewport:[0,0,1,1],approved_by:'Synthetic operator',approval_scope:'Private fixture processing'};
    assert.throws(()=>store.createRun(args),/explicit active operator approval/);approve(store);
    const created=store.createRun(args);assert.equal(created.status,'PENDING');assert.equal(created.observation_counts.PENDING,1);assert.equal(created.config.canonical_status,'NOT_COMPARED');
    assert.equal(store.createRun(args).run_id,created.run_id);assert.throws(()=>store.createRun({...args,region_id:'ZZ-other'}),/different immutable inputs/);
    store.setRunObservation(created.run_id,imported.observations[0].observation_id,'RUNNING',{checkpoint:{stage:'segment-and-match'},pipeline_version:'route-segmenter-2.2'});
    store.setRunStatus(created.run_id,'RUNNING');store.close();
    const resumed=new ScoutGeoStore(path.join(dir,'private'));assert.equal(resumed.getRun(created.run_id).observation_counts.RUNNING,1);
    assert.deepEqual(resumed.runObservations(created.run_id)[0].checkpoint,{stage:'segment-and-match'});
    resumed.close();
  }finally{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});}
});

test('operator import enforces prior approval and remains idempotent',async()=>{
  const {dir,privateRoot,store}=setup(),input=path.join(dir,'one.gpx');fs.writeFileSync(input,'<gpx><trk><trkseg><trkpt lat="0" lon="0"/><trkpt lat="0.01" lon="0.01"/></trkseg></trk></gpx>');
  const priorGeo=process.env.SCOUT_GEO_ROOT,priorRaw=process.env.SCOUT_RAW_ROOT,oldLog=console.log;console.log=()=>{};
  try{
    const env={...process.env,SCOUT_GEO_ROOT:privateRoot,SCOUT_RAW_ROOT:path.join(dir,'raw')};process.env.SCOUT_GEO_ROOT=privateRoot;process.env.SCOUT_RAW_ROOT=env.SCOUT_RAW_ROOT;
    await assert.rejects(runGeoCtl(['import','--source-id','synthetic-routes','--file',input],env),/explicit active source approval/);
    approve(store);
    assert.equal(await runGeoCtl(['import','--source-id','synthetic-routes','--file',input],env),0);
    assert.equal(await runGeoCtl(['import','--source-id','synthetic-routes','--file',input],env),0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM route_observations').get().n,1);
  }finally{console.log=oldLog;if(priorGeo===undefined)delete process.env.SCOUT_GEO_ROOT;else process.env.SCOUT_GEO_ROOT=priorGeo;if(priorRaw===undefined)delete process.env.SCOUT_RAW_ROOT;else process.env.SCOUT_RAW_ROOT=priorRaw;store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('pending notifications can be retried through the operator CLI without credentials',async()=>{
  const {dir,privateRoot,store}=setup(),file=path.join(privateRoot,'notifications','scout-notifications.json'),oldGeo=process.env.SCOUT_GEO_ROOT,oldLog=console.log;console.log=()=>{};process.env.SCOUT_GEO_ROOT=privateRoot;
  try{
    const center=new NotificationCenter(file);await center.emit({key:'fixture-review',severity:'AMBER',message:'Synthetic review needed',channels:['EMAIL']});
    assert.equal(await runGeoCtl(['notify','retry'],{SCOUT_GEO_ROOT:privateRoot}),0);
    assert.equal(new NotificationCenter(file).state().pending.length,1,'unconfigured delivery stays pending');
  }finally{console.log=oldLog;if(oldGeo===undefined)delete process.env.SCOUT_GEO_ROOT;else process.env.SCOUT_GEO_ROOT=oldGeo;store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('network provider requires explicit pinned regional metadata and rejects unsupported provider/region',()=>{
  const src=networkSource();assert.equal(resolveNetworkExtract(src).snapshot_id,'zz-261003');
  assert.throws(()=>resolveNetworkExtract({...src,network_extract:{...src.network_extract,url:'https://download.geofabrik.de/europe/zz-latest.osm.pbf'}}),/version-pinned/);
  assert.throws(()=>resolveNetworkExtract({...src,network_extract:{...src.network_extract,provider:'arbitrary-site'}}),/pinned provider/);
  assert.throws(()=>resolveNetworkExtract({...src,network_extract:{...src.network_extract,country_code:'YY'}}),/outside registered source coverage/);
});

test('pinned network acquisition resumes by HTTP Range, verifies checksum, records provenance and reuses valid artifact',async()=>{
  const bytes=Buffer.from('synthetic-pinned-pbf-bytes'),sha=crypto.createHash('sha256').update(bytes).digest('hex'),{dir,privateRoot,store}=setup({networkSha:sha});
  try{
    store.registerSource(networkSource(sha)); // immutable snapshot remains pinned to the same hash
    store.approveSource({source_id:'synthetic-network',approved_by:'Synthetic operator',scope:'Private network analysis'});
    const dataRoot=path.join(privateRoot,'network');let calls=0;
    const fetchImpl=async(_url,options)=>{calls++;if(calls===1){assert.equal(options.headers.Range,undefined);return fakeResponse(bytes);}
      const start=Number(options.headers.Range.match(/bytes=(\d+)-/)[1]);assert.ok(start>0);return fakeResponse(bytes.subarray(start),{status:206,headers:{'content-range':`bytes ${start}-${bytes.length-1}/${bytes.length}`,'etag':'fixture-etag'}});};
    const first=await acquireNetworkSnapshot(store,{sourceId:'synthetic-network',snapshotId:'zz-261003',dataRoot,fetchImpl,progress:async({bytes:n})=>n>=4});
    assert.equal(first.status,'YIELDED');
    const second=await acquireNetworkSnapshot(store,{sourceId:'synthetic-network',snapshotId:'zz-261003',dataRoot,fetchImpl});
    assert.equal(second.status,'COMPLETE');assert.equal(second.sha256,sha);assert.equal(fs.readFileSync(second.path).compare(bytes),0);
    assert.equal(store.getNetworkSnapshot('zz-261003').licence.attribution,'© OpenStreetMap contributors');assert.equal(store.getNetworkArtifact('zz-261003').byte_size,bytes.length);
    const reused=await acquireNetworkSnapshot(store,{sourceId:'synthetic-network',snapshotId:'zz-261003',dataRoot,fetchImpl:async()=>{throw new Error('must not redownload');}});
    assert.equal(reused.status,'REUSED');assert.equal(calls,2);
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('network acquisition checksum mismatch fails without registering a pinned artifact',async()=>{
  const {dir,privateRoot,store}=setup();try{
    store.approveSource({source_id:'synthetic-network',approved_by:'Synthetic operator',scope:'Private network analysis'});
    await assert.rejects(acquireNetworkSnapshot(store,{sourceId:'synthetic-network',snapshotId:'zz-261003',dataRoot:path.join(privateRoot,'network'),fetchImpl:async()=>fakeResponse(Buffer.from('wrong'))}),/SHA-256 mismatch/);
    assert.equal(store.getNetworkArtifact('zz-261003'),null);
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('network import resumes from complete GeoJSON-sequence record checkpoints after yield',async()=>{
  const {dir,privateRoot,store}=setup();try{
    const pbf=path.join(privateRoot,'network','zz-261003.osm.pbf');fs.mkdirSync(path.dirname(pbf),{recursive:true});fs.writeFileSync(pbf,'synthetic pbf placeholder');
    const sha=crypto.createHash('sha256').update(fs.readFileSync(pbf)).digest('hex');
    store.db.prepare('UPDATE network_snapshots SET checksum=? WHERE snapshot_id=?').run(sha,'zz-261003');
    store.recordNetworkArtifact({snapshot_id:'zz-261003',provider:'geofabrik',source_url:'https://download.geofabrik.de/europe/zz-test-261003.osm.pbf',local_path:pbf,byte_size:fs.statSync(pbf).size,sha256:sha});
    const records=[1,2].map(id=>`\u001e${JSON.stringify({type:'Feature',id:`w${id}`,properties:{'@type':'way','@id':id,highway:'track'},geometry:{type:'LineString',coordinates:[[id,0],[id+0.1,0.1]]}})}\n`).join('');
    const fakeSpawn=()=>{const child=new EventEmitter();child.stdout=Readable.from([records]);child.stderr=new PassThrough();child.exitCode=null;let done=false;
      const close=(code,signal)=>{if(done)return;done=true;child.exitCode=code;setImmediate(()=>child.emit('close',code,signal));};
      child.stdout.on('end',()=>close(0,null));child.kill=(signal)=>{close(null,signal);return true;};return child;};
    const first=await importNetworkArtifact(store,{snapshotId:'zz-261003',batchSize:1,shouldYield:()=>true,spawnImpl:fakeSpawn});
    assert.equal(first.status,'YIELDED');assert.equal(first.seen,1);assert.equal(store.networkEdgeCount('zz-261003'),1);
    const second=await importNetworkArtifact(store,{snapshotId:'zz-261003',batchSize:1,spawnImpl:fakeSpawn});
    assert.equal(second.status,'COMPLETE');assert.equal(second.resumed_from,1);assert.equal(second.seen,2);assert.equal(store.networkEdgeCount('zz-261003'),2);
    assert.equal(store.networkImportCheckpoint('zz-261003').status,'COMPLETE');
    const reused=await importNetworkArtifact(store,{snapshotId:'zz-261003',spawnImpl:()=>{throw new Error('completed conversion must be reused');}});assert.equal(reused.status,'REUSED');
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
