import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGeoHostAdmission, parseGeoCtlArgs, sharedFactoryYieldRequested } from '../../scripts/scout/geoctl.mjs';

test('geoctl parses explicit kebab-case identifiers and rejects positional ambiguity',()=>{
  assert.deepEqual(parseGeoCtlArgs(['--observation-id','obs-1','--snapshot-id','osm-v1','--state=OPEN']),{'observation_id':'obs-1','snapshot_id':'osm-v1','state':'OPEN'});
  assert.throws(()=>parseGeoCtlArgs(['observation-1']),/unexpected argument/);
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
