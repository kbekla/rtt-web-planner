import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGeoHostAdmission, createGeoYieldCheck, parseGeoCtlArgs, releaseGeoAdmission, runGeoCtl, sharedFactoryYieldRequested } from '../../scripts/scout/geoctl.mjs';

test('geoctl parses explicit kebab-case identifiers and rejects positional ambiguity',()=>{
  assert.deepEqual(parseGeoCtlArgs(['--observation-id','obs-1','--snapshot-id','osm-v1','--state=OPEN']),{'observation_id':'obs-1','snapshot_id':'osm-v1','state':'OPEN'});
  assert.throws(()=>parseGeoCtlArgs(['observation-1']),/unexpected argument/);
});

test('Europe matrix command prints the country coverage matrix without network or private store access',async()=>{
  const prior=console.log,lines=[];console.log=(...args)=>lines.push(args.join(' '));
  try{
    assert.equal(await runGeoCtl(['europe','matrix','--country-code','BE'],{}),0);
    const matrix=lines.join('\n');assert.match(matrix,/Country\/Jurisdiction \| Source \| Authority \| Role \| Licence state/);
    assert.match(matrix,/BE-VLG/);assert.match(matrix,/BE-WAL/);assert.match(matrix,/DISABLED_REVIEW_REQUIRED/);
    assert.doesNotMatch(matrix,/GB-ENG|GB-WLS|\| IM \|/);
  }finally{console.log=prior;}
});

test('Europe source listing is read-only, jurisdiction-filterable, and never activates public-data leads',async()=>{
  const prior=console.log,lines=[];console.log=(...args)=>lines.push(args.join(' '));
  try{
    assert.equal(await runGeoCtl(['europe','sources','--country-code','BE'],{}),0);
    const result=JSON.parse(lines.join('\n'));
    assert.equal(result.state,'REVIEW_REQUIRED');assert.equal(result.automatic_retrieval,false);assert.equal(result.sources.length,2);
    assert.ok(result.sources.every(source=>source.assessment_state==='REVIEW_REQUIRED'&&source.permissions.private_processing===false));
  }finally{console.log=prior;}
});

test('geoctl refuses unverified factory, heavy workload, memory, disk, load and thermal states',()=>{
  const healthy={factory_coordination:{verified:true,factory_pending:false},factory_job_active:false,planetiler_active:false,
    local_ai_active:false,other_heavy_workload_active:false,mem_available_mb:8000,disk:{free_bytes:100e9},load1:1,
    cpu_temp_c:55,nvme_temp_c:35,igpu:{temp_c:50},dgpu:null};
  assert.doesNotThrow(()=>assertGeoHostAdmission(healthy));
  for(const [change,pattern] of [
    [{factory_coordination:{verified:false}},/COORDINATION_UNVERIFIED/],
    [{planetiler_active:true},/FACTORY_OR_PLANETILER_ACTIVE/],
    [{local_ai_active:true},/OTHER_HEAVY_WORKLOAD_ACTIVE/],
    [{mem_available_mb:100},/AVAILABLE_MEMORY/],
    [{disk:{free_bytes:1}},/FREE_DISK/],
    [{cpu_temp_c:95},/THERMAL_HOLD/],
  ])assert.throws(()=>assertGeoHostAdmission({...healthy,...change}),pattern);
});

test('geoctl yields on factory intent or unreadable admission state, but not an empty or valid state',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scout-geoyield-')),file=path.join(root,'state.json');
  try{
    fs.writeFileSync(file,JSON.stringify({schema:1,lease:{owner:'scout',nonce:'n',priority:'background'},factory_intent:null}));
    assert.equal(sharedFactoryYieldRequested(file,'scout','n'),false);
    fs.writeFileSync(file,JSON.stringify({schema:1,lease:{owner:'scout',nonce:'n',priority:'background'},factory_intent:{owner:'factory',nonce:'f'}}));
    assert.equal(sharedFactoryYieldRequested(file,'scout','n'),true);
    fs.writeFileSync(file,'not-json');assert.equal(sharedFactoryYieldRequested(file,'scout','n'),true);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('geoctl periodically yields for changing host resource or thermal holds during a long stage',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scout-geoyield-host-')),file=path.join(root,'state','resource-admission.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({schema:1,lease:{owner:'scout-job',nonce:'lease-n',priority:'background'},factory_intent:null}));
  let clock=0,calls=0,host={factory_coordination:{verified:true,factory_pending:false},factory_job_active:false,planetiler_active:false,local_ai_active:false,other_heavy_workload_active:false,mem_available_mb:8000,disk:{free_bytes:100e9},load1:1,cpu_temp_c:55,nvme_temp_c:35,igpu:null,dgpu:null};
  try{const shouldYield=createGeoYieldCheck({factoryDir:root,owner:'scout-job',nonce:'lease-n',now:()=>clock,readHost:()=>{calls++;return host;}});
    assert.equal(shouldYield(),false);assert.equal(calls,1);host={...host,mem_available_mb:100};clock+=1000;assert.equal(shouldYield(),false,'host reads are rate limited between samples');
    clock+=5000;assert.equal(shouldYield(),true,'new memory pressure safely yields the active stage');assert.equal(shouldYield.reason(),'BLOCKED_AVAILABLE_MEMORY');assert.equal(calls,2);
    fs.writeFileSync(file,JSON.stringify({schema:1,lease:{owner:'scout-job',nonce:'lease-n',priority:'background'},factory_intent:{owner:'factory',nonce:'factory-n'}}));
    assert.equal(shouldYield(),true,'factory intent remains immediate regardless of resource poll interval');assert.match(shouldYield.reason(),/factory priority/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('geoctl releases using the nonce nested in the shared admission grant',()=>{
  const calls=[];const admission={release:(...args)=>{calls.push(args);return {ok:true};}};
  const grant={ok:true,lease:{nonce:'lease-token'}};
  assert.deepEqual(releaseGeoAdmission(admission,'scout-job',grant,'done'),{ok:true});
  assert.deepEqual(calls,[['scout-job','lease-token','done']]);
  assert.deepEqual(releaseGeoAdmission(admission,'scout-job',{ok:true},'done'),{ok:false,reason:'shared admission grant nonce is missing'});
});
