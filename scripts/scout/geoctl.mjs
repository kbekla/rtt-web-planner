#!/usr/bin/env node
// Explicit private route operations. This CLI never scans directories, fetches
// sources, accesses a canonical master, or writes public trail output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ScoutGeoStore } from './geostore.mjs';
import { ingestRouteFile } from './route-import.mjs';
import { processRouteObservation } from './process-route.mjs';
import { readHostSnapshot } from './resources.mjs';
import { SharedResourceAdmission, resourceAdmissionStateFile } from '../lib/resource-admission.mjs';
import { SCOUT_CONFIG } from './core.mjs';

const HELP=`scout-geoctl source register --manifest FILE
scout-geoctl import --source-id ID --file FILE [--name RELATIVE_NAME] [--language BCP47]
scout-geoctl process --observation-id ID --snapshot-id ID
scout-geoctl status
scout-geoctl review [--state OPEN|IN_PROGRESS|DEFERRED|RESOLVED|ALL]

Set SCOUT_GEO_ROOT to the private Scout database directory and SCOUT_RAW_ROOT
to its private content-addressed raw-source directory. Processing requires a
fresh verified factory admission heartbeat and shared heavy-work lease.`;
export function parseGeoCtlArgs(args){const out={};for(let i=0;i<args.length;i++){if(!args[i].startsWith('--'))throw new Error(`unexpected argument '${args[i]}'`);const token=args[i].slice(2),equals=token.indexOf('='),key=(equals<0?token:token.slice(0,equals)).replaceAll('-','_');if(!key||out[key]!==undefined)throw new Error(`duplicate or invalid option '${args[i]}'`);if(equals>=0){out[key]=token.slice(equals+1);continue;}if(args[i+1]?.startsWith('--'))out[key]=true;else if(args[i+1]===undefined)out[key]=true;else out[key]=args[++i];}return out;}
function required(opts,key){if(typeof opts[key]!=='string'||!opts[key])throw new Error(`--${key.replaceAll('_','-')} is required`);return opts[key];}
function configuredPath(variable){const value=process.env[variable];if(!value)throw new Error(`${variable} must point to the private Scout data area`);const resolved=path.resolve(value);if(fs.existsSync(resolved)&&fs.lstatSync(resolved).isSymbolicLink())throw new Error(`${variable} cannot be a symlink`);return resolved;}
function storeFor(){const root=configuredPath('SCOUT_GEO_ROOT');return {root,store:new ScoutGeoStore(root)};}
export function sharedFactoryYieldRequested(file,owner,nonce){
  try{const state=JSON.parse(fs.readFileSync(file,'utf8')),lease=state.lease,intent=state.factory_intent;
    if(state.schema!==1||!('lease'in state)||!('factory_intent'in state))return true;
    return Boolean(intent&&!(lease?.owner===owner&&lease?.nonce===nonce&&lease?.priority==='factory'));
  }catch{return true;}
}
export function assertGeoHostAdmission(host){
  if(!host.factory_coordination?.verified)throw new Error('BLOCKED_FACTORY_COORDINATION_UNVERIFIED');
  if(host.factory_job_active||host.planetiler_active||host.factory_coordination.factory_pending)throw new Error('BLOCKED_FACTORY_OR_PLANETILER_ACTIVE');
  if(host.local_ai_active||host.other_heavy_workload_active)throw new Error('BLOCKED_OTHER_HEAVY_WORKLOAD_ACTIVE');
  const policy=SCOUT_CONFIG.resource_governor;
  if(host.mem_available_mb==null||host.mem_available_mb<policy.minimum_available_ram_mb)throw new Error('BLOCKED_AVAILABLE_MEMORY');
  if(!host.disk?.free_bytes||host.disk.free_bytes<policy.minimum_free_disk_gb*1e9)throw new Error('BLOCKED_FREE_DISK');
  if(host.load1!=null&&host.load1>policy.maximum_load1)throw new Error('BLOCKED_HOST_LOAD');
  const thermal=policy.thermal,temps=[[host.cpu_temp_c,thermal.warm_cpu_c],[host.nvme_temp_c,thermal.warm_nvme_c],
    [host.igpu?.temp_c,thermal.gpu_hot_c],[host.dgpu?.temp_c,thermal.gpu_hot_c]];
  if(temps.some(([value,limit])=>Number.isFinite(value)&&value>=limit))throw new Error('BLOCKED_THERMAL_HOLD');
}
function latestStats(db){return db.prepare(`SELECT
  (SELECT count(*) FROM source_registry) sources,
  (SELECT count(*) FROM source_files) files,
  (SELECT count(*) FROM route_observations) observations,
  (SELECT count(*) FROM route_segments s WHERE s.pipeline_version=(SELECT max(s2.pipeline_version) FROM route_segments s2 WHERE s2.observation_id=s.observation_id)) latest_segments,
  (SELECT count(*) FROM candidates c JOIN route_segments s USING(segment_id) WHERE s.pipeline_version=(SELECT max(s2.pipeline_version) FROM route_segments s2 WHERE s2.observation_id=s.observation_id)) latest_candidates,
  (SELECT count(*) FROM review_items WHERE state IN ('OPEN','IN_PROGRESS')) open_reviews,
  (SELECT count(DISTINCT hypothesis_id) FROM corridor_hypotheses) continuity_hypotheses`).get();}
export async function runGeoCtl(argv=process.argv.slice(2),env=process.env){
  const [command,...rest]=argv;
  if(!command||command==='help'||command==='--help'){console.log(HELP);return 0;}
  if(env.SCOUT_GEO_ROOT)process.env.SCOUT_GEO_ROOT=env.SCOUT_GEO_ROOT;
  if(env.SCOUT_RAW_ROOT)process.env.SCOUT_RAW_ROOT=env.SCOUT_RAW_ROOT;
  if(command==='source'&&rest[0]==='register'){
    const manifest=required(parseGeoCtlArgs(rest.slice(1)),'manifest'),definition=JSON.parse(fs.readFileSync(manifest,'utf8'));
    const {store}=storeFor();try{console.log(JSON.stringify(store.registerSource(definition),null,2));}finally{store.close();}return 0;
  }
  const opts=parseGeoCtlArgs(rest);
  if(command==='import'){
    const sourceId=required(opts,'source_id'),inputFile=required(opts,'file'),rawRoot=configuredPath('SCOUT_RAW_ROOT'),{store}=storeFor();
    try{const result=ingestRouteFile(store,{inputFile,sourceId,relativeName:opts.name??path.basename(inputFile),rawRoot,sourceLanguage:opts.language??null});
      console.log(JSON.stringify({file_id:result.file_id,version:result.version,checksum:result.checksum,format:result.format,duplicate:result.duplicate,observation_count:result.observations.length,observation_ids:result.observations.map(x=>x.observation_id)},null,2));}
    finally{store.close();}return 0;
  }
  if(command==='status'||command==='review'){
    const {store}=storeFor();try{if(command==='status')console.log(JSON.stringify({private:true,...latestStats(store.db),sources:store.listSources().map(({source_id,name,type,coverage,health,last_successful_processing,next_due})=>({source_id,name,type,coverage,health,last_successful_processing,next_due}))},null,2));
      else console.log(JSON.stringify(store.listReviewItems({state:opts.state??'OPEN',limit:500}),null,2));}finally{store.close();}return 0;
  }
  if(command==='process'){
    const observationId=required(opts,'observation_id'),snapshotId=required(opts,'snapshot_id'),factoryDir=env.FACTORY_DIR??path.join(os.homedir(),'rtt-map-factory');
    const first=readHostSnapshot({factoryDir});assertGeoHostAdmission(first);
    const admission=new SharedResourceAdmission(resourceAdmissionStateFile(factoryDir)),owner=`scout-geo:${observationId}`;
    const grant=admission.acquireScout(owner);if(!grant.ok)throw new Error(`BLOCKED_SHARED_ADMISSION: ${grant.reason??'lease unavailable'}`);
    let store;
    try{
      ({store}=storeFor());
      const after=readHostSnapshot({factoryDir});assertGeoHostAdmission(after);
      const shouldYield=()=>sharedFactoryYieldRequested(resourceAdmissionStateFile(factoryDir),owner,grant.nonce);
      const result=processRouteObservation(store,observationId,{networkSnapshotId:snapshotId,shouldYield});
      console.log(JSON.stringify({observation_id:result.observation_id,network_snapshot:result.network_snapshot,segment_count:result.segment_count,
        candidate_count:result.candidate_count,continuity_hypotheses:result.continuity_hypotheses.length,source_geometry_preserved:true,
        motorcycle_access:'unknown',routability:'unknown'},null,2));return 0;
    }finally{try{store?.close();}finally{const released=admission.release(owner,grant.nonce,'observation processing complete or safely yielded');if(!released.ok)throw new Error(`BLOCKED_SHARED_ADMISSION_RELEASE: ${released.reason??'lease not released'}`);}}
  }
  throw new Error(`unknown command '${command}'\n${HELP}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){runGeoCtl().then((code)=>{process.exitCode=code;}).catch((error)=>{console.error(error.code==='SCOUT_YIELD_REQUESTED'?'YIELD_REQUESTED: observation left unmodified; retry after factory work.':error.message);process.exitCode=error.code==='SCOUT_YIELD_REQUESTED'?75:2;});}
