import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import { createScoutOperatorServer, deriveOperatorHealth, operatorBlockedReason, scoutJobEnvironment } from '../../scripts/scout/operator-ui.mjs';

const route={source_id:'synthetic-ui-route',name:'Synthetic route',type:'route-file',organisation:'fixture',expected_formats:['gpx'],coverage:{countries:['ZZ'],regions:['ZZ-region']},jurisdiction_ids:['zz-country'],location:'explicit test route',adapter_version:'fixture-v1',licence:{name:'synthetic',version:'1'},reuse:{private_processing:true,redistribution:false,derived_public_use:false},roles:{discovery_only:true,physical_existence:false,legal_access:false,routing_network:false,public_reuse:false,jurisdiction_boundaries:false},update:{mechanism:'fixture'},attribution:'synthetic',rate_limits:{requests_per_minute:0}};
const network={...route,source_id:'synthetic-ui-network',name:'Synthetic network',type:'regional-network',expected_formats:['pbf'],reuse:{private_processing:true,redistribution:true,derived_public_use:false},roles:{discovery_only:false,physical_existence:false,legal_access:false,routing_network:true,public_reuse:true,jurisdiction_boundaries:false}};

test('operator health distinguishes ready, review, safety RED and fail-closed BLOCKED states',()=>{
  const clear={factory_coordination:{verified:true,status:'VERIFIED'},factory_job_active:false,planetiler_active:false,local_ai_active:false,other_heavy_workload_active:false};
  assert.equal(deriveOperatorHealth(clear,{active:0},[]),'GREEN');
  assert.equal(deriveOperatorHealth(clear,{active:0},[{status:'REVIEW_REQUIRED'}]),'AMBER');
  assert.equal(deriveOperatorHealth(clear,{active:1},[]),'AMBER');
  assert.equal(deriveOperatorHealth({...clear,factory_coordination:{verified:false,status:'UNVERIFIED',reason:'heartbeat unavailable'}},{active:0},[]),'BLOCKED');
  assert.match(operatorBlockedReason({...clear,planetiler_active:true}),/Planetiler is active/);
  assert.equal(deriveOperatorHealth({...clear,factory_coordination:{verified:false,status:'RED',reason:'corrupt admission state'}},{active:0},[]),'RED');
});

test('detached Scout jobs inherit the operator notification recipient without passing credential values',()=>{
  const child=scoutJobEnvironment({PATH:'/usr/bin',SCOUT_NOTIFICATION_EMAIL:'info@roadtrailandtide.com'},{root:'/private/scout',raw:'/private/scout/raw',factoryDir:'/factory'});
  assert.equal(child.SCOUT_NOTIFICATION_EMAIL,'info@roadtrailandtide.com');assert.equal(child.SCOUT_GEO_ROOT,'/private/scout');
  assert.equal('SMTP_PASSWORD' in child,false);assert.equal('ZOHO_PASSWORD' in child,false);
  assert.equal(scoutJobEnvironment({PATH:'/usr/bin'},{root:'/private/scout',raw:'/private/scout/raw',factoryDir:'/factory'}).SCOUT_NOTIFICATION_EMAIL,undefined);
});

test('desktop operator opens read-only status, lists existing runs and starts no processing on launch',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scout-desktop-ui-')),geoRoot=path.join(dir,'state'),rawRoot=path.join(dir,'raw'),store=new ScoutGeoStore(geoRoot);let starts=0,server;
  try{
    store.registerSource(route);store.registerSource(network);store.approveSource({source_id:route.source_id,approved_by:'Karl',scope:'fixture'});
    const input=path.join(dir,'selected.gpx');fs.writeFileSync(input,'<gpx><trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="1.1" lon="1.1"/></trkseg></trk></gpx>');
    const {ingestRouteFile}=await import('../../scripts/scout/route-import.mjs');const imported=ingestRouteFile(store,{inputFile:input,sourceId:route.source_id,rawRoot});
    store.recordNetworkSnapshot({snapshot_id:'zz-ui-snapshot',source_id:network.source_id,version:'fixture-1',checksum:'a'.repeat(64),licence:{name:'synthetic',version:'1'},coverage:{countries:['ZZ'],regions:['ZZ-region']}});
    store.createRun({run_id:'zz-ui-existing-run',source_id:route.source_id,snapshot_id:'zz-ui-snapshot',country_code:'ZZ',region_id:'ZZ-region',title:'Synthetic existing run',viewport:[0,0,2,2],approved_by:'Karl',approval_scope:'fixture'});
    assert.equal(imported.observations.length,1);
    store.close();
    server=createScoutOperatorServer({geoRoot,rawRoot,factoryDir:dir,port:0,spawnImpl:()=>{starts++;throw new Error('launch must not process');},readHost:()=>({factory_coordination:{verified:true,status:'VERIFIED'},factory_service_state:'active',planetiler_active:false,local_ai_active:false,resource_lease_owner:null,mem_available_mb:4096,cpu_temp_c:55,nvme_c:35})});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
    const home=await fetch(base+'/'),html=await home.text();assert.equal(home.status,200);assert.match(html,/Prepare a new region/);assert.match(html,/Open Review/);assert.doesNotMatch(html,/npm run scout:geo|scout-geoctl/);
    const status=await fetch(base+'/api/status').then(r=>r.json());assert.equal(status.health,'GREEN',JSON.stringify(status));assert.equal(status.runs[0].run_id,'zz-ui-existing-run');assert.equal(status.runs[0].status,'PENDING');assert.equal(starts,0);
    const token=html.match(/<meta name="scout-token" content="([^"]+)"/)[1];
    const opened=await fetch(base+'/api/review/open',{method:'POST',headers:{'content-type':'application/json',origin:base,'x-scout-token':token},body:JSON.stringify({run_id:'zz-ui-existing-run'})}).then(r=>r.json());
    assert.match(opened.url,/^http:\/\/127\.0\.0\.1:\d+\/$/);const reviewResponse=await fetch(opened.url);assert.equal(reviewResponse.status,200);assert.match(await reviewResponse.text(),/Synthetic existing run/);
    assert.equal(starts,0,'opening Review must not start Scout processing');
    const forbidden=await fetch(base+'/api/region/process',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:8770','x-scout-token':'invalid'},body:JSON.stringify({run_id:'zz-ui-existing-run'})});
    assert.equal(forbidden.status,403);assert.equal(starts,0);
    await new Promise(resolve=>server.close(resolve));server=null;
    const reopened=createScoutOperatorServer({geoRoot,rawRoot,factoryDir:dir,port:0,spawnImpl:()=>{starts++;throw new Error('reopening must not process');},readHost:()=>({factory_coordination:{verified:true,status:'VERIFIED'},factory_service_state:'active',planetiler_active:false,local_ai_active:false,mem_available_mb:4096})});
    await new Promise(resolve=>reopened.listen(0,'127.0.0.1',resolve));const reopenedStatus=await fetch(`http://127.0.0.1:${reopened.address().port}/api/status`).then(r=>r.json());
    assert.equal(reopenedStatus.runs[0].run_id,'zz-ui-existing-run','the existing run remains visible after closing and reopening the operator');assert.equal(starts,0);
    await new Promise(resolve=>reopened.close(resolve));
  }finally{if(store.db)try{store.close();}catch{}if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});

test('operator chooses the newest matching run store and opens review on that database',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'scout-state-registry-')),defaultRoot=path.join(base,'operator-state','state'),oldRoot=path.join(base,'be-20261004','state'),latestRoot=path.join(base,'be-20261005-r02-corridor-evidence','state');
  const createRunDb=root=>{fs.mkdirSync(root,{recursive:true,mode:0o700});const db=new DatabaseSync(path.join(root,'scout.sqlite'));db.exec(`CREATE TABLE scout_runs(run_id TEXT,country_code TEXT,region_id TEXT,config_json TEXT,status TEXT,created_at TEXT,updated_at TEXT,last_error TEXT);
    INSERT INTO scout_runs VALUES('be-osm-discovery-20261005','BE','BE','{"canonical_status":"NOT_COMPARED"}','REVIEW_REQUIRED','2026-10-05T02:00:00Z','2026-10-05T02:30:17.640Z',NULL);`);db.close();fs.chmodSync(path.join(root,'scout.sqlite'),0o600);};
  let server,reviewDb;
  try{
    createRunDb(oldRoot);createRunDb(latestRoot);
    server=createScoutOperatorServer({stateBase:base,geoRoot:defaultRoot,rawRoot:path.join(defaultRoot,'raw'),factoryDir:base,port:0,
      openReviewer:options=>{reviewDb=options.databaseFile;return http.createServer((_req,res)=>{res.writeHead(200);res.end('review selected');});},
      readHost:()=>({factory_coordination:{verified:true,status:'VERIFIED'},factory_service_state:'active',planetiler_active:false,local_ai_active:false,mem_available_mb:4096})});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address=`http://127.0.0.1:${server.address().port}`;
    const status=await (await fetch(`${address}/api/status`)).json(),latest=status.runs.find(run=>run.store_key==='be-20261005-r02-corridor-evidence');
    assert.equal(status.runs[0].store_key,'be-20261005-r02-corridor-evidence');assert.equal(latest.run_id,'be-osm-discovery-20261005');
    const html=await (await fetch(address)).text();assert.match(html,/data-store=/);
    const token=html.match(/<meta name="scout-token" content="([^"]+)"/)[1];
    const opened=await fetch(`${address}/api/review/open`,{method:'POST',headers:{'content-type':'application/json',origin:address,'x-scout-token':token},body:JSON.stringify({run_id:latest.run_id,store_key:latest.store_key})}).then(r=>r.json());
    assert.equal(reviewDb,path.join(latestRoot,'scout.sqlite'));assert.match(opened.url,/^http:\/\/127\.0\.0\.1:/);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(base,{recursive:true,force:true});}
});
