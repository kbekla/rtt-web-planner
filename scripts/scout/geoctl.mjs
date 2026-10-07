#!/usr/bin/env node
// Explicit, private Scout operator. No directory scanning, arbitrary crawling,
// canonical writes or public publication are available through this interface.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ScoutGeoStore } from './geostore.mjs';
import { ingestRouteFile } from './route-import.mjs';
import { processRouteObservation } from './process-route.mjs';
import { readHostSnapshot } from './resources.mjs';
import { SharedResourceAdmission, resourceAdmissionStateFile } from '../lib/resource-admission.mjs';
import { SCOUT_CONFIG, NotificationCenter } from './core.mjs';
import { createZohoSmtpProvider } from './zoho-smtp.mjs';
import { acquireNetworkSnapshot, importNetworkArtifact, resolveNetworkExtract } from './network-provider.mjs';
import { SEGMENTATION_VERSION, lengthMeters } from './route-segmenter.mjs';
import { createRealReviewServer } from './review-real-server.mjs';
import { prepareRegionPlan, approveRegionPlan, validateRegionPlanForProcess } from './region-operator.mjs';
import { discoverOsmRun, discoveryStats, registerOsmDiscoverySource } from './osm-discovery.mjs';
import { buildCorridorRun, corridorRunStats, listCorridorReview, recordCorridorReview } from './osm-topology.mjs';
import { spwRoadSourceDefinition } from './spw-network.mjs';
import { pollSpwServiceMetadata } from './spw-watchkeeper.mjs';
import { listEuropeSourceCandidates, renderEuropeCoverageMatrix } from './europe-source-catalog.mjs';
import { benchmarkTetAgainstIndependentDiscovery, writePrivateTetBenchmark } from './tet-benchmark.mjs';
import { acquireNvdbSnapshot, importNvdbSnapshot, nvdbNorwaySourceDefinition, registerNvdbDiscoverySource, discoverNvdbRun } from './nvdb-network.mjs';

const HELP=`scout-geoctl source register --manifest FILE
scout-geoctl source register-spw|register-nvdb-no
scout-geoctl source approve --source-id ID --by NAME --scope TEXT
scout-geoctl import --source-id ID --file FILE [--name RELATIVE_NAME] [--language BCP47]
scout-geoctl network acquire --source-id ID --snapshot-id ID
scout-geoctl network import --snapshot-id ID
scout-geoctl network status [--snapshot-id ID]
scout-geoctl run create --run-id ID --source-id ID --snapshot-id ID --country-code CC --region-id ID --viewport W,S,E,N --approved-by NAME --approval-scope TEXT [--title TEXT]
scout-geoctl run list|status --run-id ID
scout-geoctl region prepare --route FILE --country-code CC --region NAME --source-name NAME --source-type TYPE --private-research --no-redistribution --no-derived-public-use --no-legal-evidence
scout-geoctl region approve --run-id ID --by NAME --scope TEXT
scout-geoctl region process|status --run-id ID
scout-geoctl region list
scout-geoctl discover create --run-id ID --snapshot-id ID --country-code CC --region-id ID --approved-by NAME --approval-scope TEXT
scout-geoctl discover process|status --run-id ID
scout-geoctl discover list
scout-geoctl corridor process|status --run-id ID
scout-geoctl corridor review list --run-id ID [--state UNREVIEWED|AMBIGUOUS|NEEDS_MORE_EVIDENCE|LOW_VALUE|CATALOGUED|ALL]
scout-geoctl corridor review decide --corridor-id ID --decision INTERESTING|NEEDS_MORE_EVIDENCE|LOW_VALUE|FALSE_POSITIVE|AMBIGUOUS|HOLD|UNREVIEWED --reviewer NAME --reason TEXT
scout-geoctl process --run-id ID
scout-geoctl review list [--run-id ID] [--decision UNREVIEWED|ACCEPT_FOR_RESEARCH|NEEDS_MORE_EVIDENCE|REJECT_FALSE_POSITIVE|AMBIGUOUS|HOLD|ALL]
scout-geoctl review decide --candidate-id ID --decision UNREVIEWED|ACCEPT_FOR_RESEARCH|NEEDS_MORE_EVIDENCE|REJECT_FALSE_POSITIVE|AMBIGUOUS|HOLD --reviewer NAME --reason TEXT
scout-geoctl review serve --run-id ID [--port PORT]
scout-geoctl notify retry
scout-geoctl watchkeeper spw-poll
scout-geoctl europe sources [--country-code CC]
scout-geoctl europe matrix [--country-code CC]
scout-geoctl europe benchmark --independent-run-id ID --reference-run-id ID
scout-geoctl status`;
export function parseGeoCtlArgs(args){const out={};for(let i=0;i<args.length;i++){if(!args[i].startsWith('--'))throw new Error(`unexpected argument '${args[i]}'`);const token=args[i].slice(2),equals=token.indexOf('='),key=(equals<0?token:token.slice(0,equals)).replaceAll('-','_');if(!key||out[key]!==undefined)throw new Error(`duplicate or invalid option '${args[i]}'`);if(equals>=0){out[key]=token.slice(equals+1);continue;}if(args[i+1]?.startsWith('--'))out[key]=true;else if(args[i+1]===undefined)out[key]=true;else out[key]=args[++i];}return out;}
function required(opts,key){if(typeof opts[key]!=='string'||!opts[key])throw new Error(`--${key.replaceAll('_','-')} is required`);return opts[key];}
function configuredPath(variable){const value=process.env[variable];if(!value)throw new Error(`${variable} must point to the private Scout data area`);const resolved=path.resolve(value);if(fs.existsSync(resolved)&&fs.lstatSync(resolved).isSymbolicLink())throw new Error(`${variable} cannot be a symlink`);return resolved;}
function storeFor(env=process.env){if(env.SCOUT_GEO_ROOT)process.env.SCOUT_GEO_ROOT=env.SCOUT_GEO_ROOT;if(env.SCOUT_RAW_ROOT)process.env.SCOUT_RAW_ROOT=env.SCOUT_RAW_ROOT;const root=configuredPath('SCOUT_GEO_ROOT');return {root,store:new ScoutGeoStore(root)};}
export function sharedFactoryYieldRequested(file,owner,nonce){try{const state=JSON.parse(fs.readFileSync(file,'utf8')),lease=state.lease,intent=state.factory_intent;if(state.schema!==1||!('lease'in state)||!('factory_intent'in state))return true;return Boolean(intent&&!(lease?.owner===owner&&lease?.nonce===nonce&&lease?.priority==='factory'));}catch{return true;}}
export function releaseGeoAdmission(admission,owner,grant,reason){const nonce=grant?.lease?.nonce;if(!nonce)return {ok:false,reason:'shared admission grant nonce is missing'};return admission.release(owner,nonce,reason);}
export function createGeoYieldCheck({factoryDir,owner,nonce,readHost=readHostSnapshot,now=Date.now,pollMs=5000}={}){
  const admissionFile=resourceAdmissionStateFile(factoryDir);let lastPoll=-Infinity,lastReason=null;
  const shouldYield=()=>{if(sharedFactoryYieldRequested(admissionFile,owner,nonce)){lastReason='factory priority requested a shared-admission yield';return true;}const time=now();if(time-lastPoll<pollMs)return false;lastPoll=time;try{assertGeoHostAdmission(readHost({factoryDir}));lastReason=null;return false;}catch(error){lastReason=error.message??'host resource/thermal state unavailable';return true;}};
  shouldYield.reason=()=>lastReason;return shouldYield;
}
export function assertGeoHostAdmission(host){
  if(!host.factory_coordination?.verified)throw new Error('BLOCKED_FACTORY_COORDINATION_UNVERIFIED');
  if(host.factory_job_active||host.planetiler_active||host.factory_coordination.factory_pending)throw new Error('BLOCKED_FACTORY_OR_PLANETILER_ACTIVE');
  if(host.local_ai_active||host.other_heavy_workload_active)throw new Error('BLOCKED_OTHER_HEAVY_WORKLOAD_ACTIVE');
  const p=SCOUT_CONFIG.resource_governor;if(host.mem_available_mb==null||host.mem_available_mb<p.minimum_available_ram_mb)throw new Error('BLOCKED_AVAILABLE_MEMORY');
  if(!host.disk?.free_bytes||host.disk.free_bytes<p.minimum_free_disk_gb*1e9)throw new Error('BLOCKED_FREE_DISK');if(host.load1!=null&&host.load1>p.maximum_load1)throw new Error('BLOCKED_HOST_LOAD');
  const t=p.thermal,temps=[[host.cpu_temp_c,t.warm_cpu_c],[host.nvme_temp_c,t.warm_nvme_c],[host.igpu?.temp_c,t.gpu_hot_c],[host.dgpu?.temp_c,t.gpu_hot_c]];
  if(temps.some(([v,limit])=>Number.isFinite(v)&&v>=limit))throw new Error('BLOCKED_THERMAL_HOLD');
}
function hostFactoryDir(env){return env.FACTORY_DIR??path.join(os.homedir(),'rtt-map-factory');}
export function jurisdictionViewport(store,source,countryCode){
  for(const jurisdictionId of source.jurisdiction_ids??[]){const row=store.db.prepare('SELECT * FROM jurisdictions WHERE jurisdiction_id=? AND country_code=?').get(jurisdictionId,countryCode);if(!row)continue;
    const boundary=JSON.parse(row.boundary_json),coords=boundary.coordinates;let west=180,south=90,east=-180,north=-90;
    const walk=value=>{if(Array.isArray(value)&&typeof value[0]==='number'){west=Math.min(west,value[0]);east=Math.max(east,value[0]);south=Math.min(south,value[1]);north=Math.max(north,value[1]);}else if(Array.isArray(value))value.forEach(walk);};walk(coords);
    if(!(west<east&&south<north))continue;const dx=Math.max((east-west)*0.015,0.02),dy=Math.max((north-south)*0.015,0.02);
    return {viewport:[Math.max(-180,west-dx),Math.max(-90,south-dy),Math.min(180,east+dx),Math.min(90,north+dy)],jurisdiction_id:jurisdictionId,jurisdiction_version:row.version,boundary_source:JSON.parse(row.metadata_json).boundary_source??null};
  }
  throw new Error(`REVIEW_REQUIRED: registered ${countryCode} coverage boundary is unavailable; TET route bounds are never used for regional discovery`);
}
function assertRunSources(store,run){const source=store.getSource(run.source_id),snapshot=store.getNetworkSnapshot(run.snapshot_id),approval=store.sourceApproval(run.source_id);if(!source||!snapshot)throw new Error('run source or pinned network snapshot is missing');if(source.reuse.private_processing!==true||source.roles.discovery_only!==true)throw new Error('run source is not approved for private discovery use');if(!approval||approval.approved_by!==run.approved_by||approval.scope!==run.approval_scope)throw new Error('run source approval is missing, revoked or differs from this run scope');if(!snapshot.checksum||store.networkEdgeCount(run.snapshot_id)<1)throw new Error('BLOCKED_NETWORK_NOT_IMPORTED: pinned snapshot has no imported network edges');return {source,snapshot};}
function reviewFile(root){return path.join(root,'notifications','scout-notifications.json');}
async function queueReviewNotice(root,runId,count,env){
  if(count<1)return {queued:false,reason:'no candidates'};
  const recipient=env.SCOUT_NOTIFICATION_EMAIL;let provider=null;
  if(recipient){try{provider=createZohoSmtpProvider({recipient,subject:'RT&T Scout needs an owner decision'});}catch{/* persist event with provider unavailable; never block deterministic work */}}
  const center=new NotificationCenter(reviewFile(root),{providers:provider?{EMAIL:provider}:{}});
  const key=`scout-escalation:${runId}`,message=`RT&T Scout needs an owner decision. Run ${runId} has ${count} unresolved authoritative or corridor-identity conflicts. Ordinary unverified lanes remain visible as ORANGE and do not require Karl to determine local law. Open the private Scout reviewer for this run.`;
  const replaced=center.replacePending({key,severity:'AMBER',message});
  const result=replaced.updated?{sent:true,event:(await center.retryPending({key}))[0]}:await center.emit({key,severity:'AMBER',channels:['EMAIL'],message});
  return {queued:true,delivery:result.event?.delivery??{},dedupe_reason:result.reason??null};
}
async function processRun(store,root,run,env){
  assertRunSources(store,run);const factoryDir=hostFactoryDir(env);assertGeoHostAdmission(readHostSnapshot({factoryDir}));
  const admission=new SharedResourceAdmission(resourceAdmissionStateFile(factoryDir)),owner=`scout-run:${run.run_id}`,grant=admission.acquireScout(owner);
  if(!grant.ok)throw new Error(`BLOCKED_SHARED_ADMISSION: ${grant.reason??'lease unavailable'}`);
  let interrupted=false;const signal=()=>{interrupted=true;};process.once('SIGTERM',signal);process.once('SIGINT',signal);
  const resourceYield=createGeoYieldCheck({factoryDir,owner,nonce:grant.lease.nonce}),yieldNow=()=>interrupted||resourceYield();
  try{
    store.setRunStatus(run.run_id,'RUNNING');
    let observationRows=store.runObservations(run.run_id);
    for(const row of observationRows){
      if(row.status==='COMPLETE'&&row.pipeline_version===SEGMENTATION_VERSION)continue;
      store.setRunObservation(run.run_id,row.observation_id,'RUNNING',{checkpoint:{stage:'segment-and-match',network_snapshot_id:run.snapshot_id},pipeline_version:SEGMENTATION_VERSION});
      try{
        const result=processRouteObservation(store,row.observation_id,{networkSnapshotId:run.snapshot_id,shouldYield:yieldNow});
        store.setRunObservation(run.run_id,row.observation_id,'COMPLETE',{checkpoint:{stage:'complete',segment_count:result.segment_count,candidate_count:result.candidate_count},pipeline_version:SEGMENTATION_VERSION});
      }catch(error){
        if(error.code==='SCOUT_YIELD_REQUESTED'||yieldNow()){
          const yieldReason=interrupted?'Scout received a graceful shutdown signal':resourceYield.reason()??'host requested a safe yield';
          store.setRunObservation(run.run_id,row.observation_id,'PENDING',{checkpoint:{stage:'segment-and-match',reason:yieldReason,resume_observation_id:row.observation_id},error:yieldReason,pipeline_version:SEGMENTATION_VERSION});
          store.setRunStatus(run.run_id,'BLOCKED',{last_error:`${yieldReason}; completed observations are preserved`});
          return {status:'BLOCKED',reason:yieldReason,resumable:true,completed:store.getRun(run.run_id).observation_counts.COMPLETE??0};
        }
        store.setRunObservation(run.run_id,row.observation_id,'FAILED',{checkpoint:{stage:'segment-and-match'},error:error.message,pipeline_version:SEGMENTATION_VERSION});
        store.setRunStatus(run.run_id,'FAILED',{last_error:error.message});throw error;
      }
    }
    observationRows=store.runObservations(run.run_id);
    const incomplete=observationRows.filter(r=>r.status!=='COMPLETE'||r.pipeline_version!==SEGMENTATION_VERSION);
    if(incomplete.length){store.setRunStatus(run.run_id,'BLOCKED',{last_error:'run has observations not completed by current classifier'});return {status:'BLOCKED',reason:'OBSERVATIONS_INCOMPLETE'};}
    const candidateCount=Number(store.db.prepare(`SELECT count(*) n FROM candidates c JOIN route_segments s USING(segment_id)
      JOIN scout_run_observations ro USING(observation_id) WHERE ro.run_id=? AND ro.status='COMPLETE' AND s.pipeline_version=ro.pipeline_version`).get(run.run_id).n);
    const humanEscalations=Number(store.db.prepare(`SELECT count(*) n FROM candidates c JOIN route_segments s USING(segment_id)
      JOIN scout_run_observations ro USING(observation_id) WHERE ro.run_id=? AND ro.status='COMPLETE' AND s.pipeline_version=ro.pipeline_version
      AND (c.physical_state='contradictory' OR c.motorcycle_access='contradictory' OR c.routability='contradictory' OR c.master_match='AMBIGUOUS')`).get(run.run_id).n);
    const status=humanEscalations?'REVIEW_REQUIRED':'COMPLETE';store.setRunStatus(run.run_id,status);
    const notice=await queueReviewNotice(root,run.run_id,humanEscalations,env);
    return {status,run_id:run.run_id,observation_count:observationRows.length,candidate_count:candidateCount,scout_research_required_count:candidateCount-humanEscalations,human_escalation_count:humanEscalations,notification:notice};
  }finally{process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);const released=releaseGeoAdmission(admission,owner,grant,'Scout run stage completed, failed or yielded');if(!released.ok)throw new Error(`BLOCKED_SHARED_ADMISSION_RELEASE: ${released.reason??'lease not released'}`);}
}
async function networkStage(store,root,{sub,sourceId,snapshotId,env,calculateChecksum=false}){
  const owner=`scout-network:${snapshotId}`,factoryDir=hostFactoryDir(env);assertGeoHostAdmission(readHostSnapshot({factoryDir}));
  const admission=new SharedResourceAdmission(resourceAdmissionStateFile(factoryDir)),grant=admission.acquireScout(owner);
  if(!grant.ok)throw new Error(`BLOCKED_SHARED_ADMISSION: ${grant.reason??'lease unavailable'}`);
  try{const shouldYield=createGeoYieldCheck({factoryDir,owner,nonce:grant.lease.nonce});
    const source=sub==='acquire'?store.getSource(sourceId):store.getSource(store.getNetworkSnapshot(snapshotId)?.source_id);
    let result;
    if(source?.network_api?.provider==='statens-vegvesen-nvdb-api-les-v4')
      result=sub==='acquire'?await acquireNvdbSnapshot(store,{sourceId,snapshotId,dataRoot:path.join(root,'network'),shouldYield,
        onPage:progress=>{if(progress.pages_written%100===0)console.log(JSON.stringify({stage:'nvdb-acquire',snapshot_id:snapshotId,...progress}));}}):
        await importNvdbSnapshot(store,{snapshotId,shouldYield,onBatch:progress=>{if(progress.pages_seen%100===0)console.log(JSON.stringify({stage:'nvdb-import',snapshot_id:snapshotId,...progress}));}});
    else result=sub==='acquire'?await acquireNetworkSnapshot(store,{sourceId,snapshotId,dataRoot:path.join(root,'network'),shouldYield,calculateChecksum}):await importNetworkArtifact(store,{snapshotId,shouldYield});
    if(result.status==='YIELDED')result.yield_reason=shouldYield.reason()??'safe resource yield';return result;
  }finally{const released=releaseGeoAdmission(admission,owner,grant,'regional network acquire/import completed or yielded');if(!released.ok)throw new Error(`BLOCKED_SHARED_ADMISSION_RELEASE: ${released.reason}`);}
}
async function processRegionPlan(store,root,runId,env){
  let plan=validateRegionPlanForProcess(store,runId),currentStage='route_import';const spec=plan.plan;
  store.updateRegionPlan(runId,{state:'RUNNING',status_error:null});
  try{
    const mark=(stage,status='COMPLETE')=>store.updateRegionPlan(runId,{stage:{name:stage,status}});
    mark('route_import','RUNNING');
    const imported=ingestRouteFile(store,{inputFile:spec.route_file.path,sourceId:spec.route_source.source_id,relativeName:spec.route_file.original_filename,rawRoot:configuredPath('SCOUT_RAW_ROOT')});
    if(imported.checksum!==spec.route_file.sha256)throw new Error('selected route file changed since preparation; prepare a new region plan');
    mark('route_import');
    currentStage='network_acquire';mark(currentStage,'RUNNING');
    let result=await networkStage(store,root,{sub:'acquire',sourceId:spec.network_source.source_id,snapshotId:spec.provider.snapshot_id,env,calculateChecksum:true});
    if(result.status==='YIELDED'){store.updateRegionPlan(runId,{state:'BLOCKED',stage:{name:currentStage,status:'BLOCKED'},status_error:result.yield_reason});return {status:'BLOCKED',run_id:runId,stage:currentStage,reason:result.yield_reason,resumable:true};}
    mark(currentStage);
    currentStage='network_import';mark(currentStage,'RUNNING');result=await networkStage(store,root,{sub:'import',snapshotId:spec.provider.snapshot_id,env});
    if(result.status==='YIELDED'){store.updateRegionPlan(runId,{state:'BLOCKED',stage:{name:currentStage,status:'BLOCKED'},status_error:result.yield_reason});return {status:'BLOCKED',run_id:runId,stage:currentStage,reason:result.yield_reason,resumable:true};}
    mark(currentStage);
    currentStage='run_create';mark(currentStage,'RUNNING');
    const snapshot=store.getNetworkSnapshot(spec.provider.snapshot_id);if(!snapshot?.checksum)throw new Error('network checksum was not pinned after download');
    const approvalScope=plan.approval_scope;
    const run=store.createRun({run_id:runId,source_id:spec.route_source.source_id,snapshot_id:spec.provider.snapshot_id,country_code:spec.country_code,
      region_id:spec.region_id,title:`${spec.region_name} private Scout review`,viewport:spec.route_file.viewport,approved_by:plan.approved_by,approval_scope:approvalScope});
    mark(currentStage);currentStage='processing';mark(currentStage,'RUNNING');
    const processed=await processRun(store,root,run,env);
    const planState=processed.status==='REVIEW_REQUIRED'?'REVIEW_REQUIRED':processed.status==='COMPLETE'?'COMPLETE':'BLOCKED';
    mark(currentStage,planState==='BLOCKED'?'BLOCKED':'COMPLETE');store.updateRegionPlan(runId,{state:planState,status_error:processed.reason??null});
    return {...processed,region_plan:runId,network_version:snapshot.version,network_sha256:snapshot.checksum};
  }catch(error){
    const state=error.code==='SCOUT_REVIEW_REQUIRED'?'REVIEW_REQUIRED':/^(BLOCKED_|YIELD_REQUESTED)/.test(error.message)?'BLOCKED':'FAILED';
    store.updateRegionPlan(runId,{state,stage:{name:currentStage,status:state==='REVIEW_REQUIRED'?'REVIEW_REQUIRED':state==='BLOCKED'?'BLOCKED':'FAILED'},status_error:error.message});throw error;
  }
}
async function processDiscoveryRun(store,root,runId,env){
  const run=store.getDiscoveryRun(runId);if(!run)throw new Error(`unknown discovery run '${runId}'`);
  const factoryDir=hostFactoryDir(env);assertGeoHostAdmission(readHostSnapshot({factoryDir}));
  const admission=new SharedResourceAdmission(resourceAdmissionStateFile(factoryDir)),owner=`scout-discovery:${runId}`,grant=admission.acquireScout(owner);
  if(!grant.ok)throw new Error(`BLOCKED_SHARED_ADMISSION: ${grant.reason??'lease unavailable'}`);
  let interrupted=false;const signal=()=>{interrupted=true;};process.once('SIGTERM',signal);process.once('SIGINT',signal);
  const yieldCheck=createGeoYieldCheck({factoryDir,owner,nonce:grant.lease.nonce}),shouldYield=()=>interrupted||yieldCheck();
  try{
    const snapshot=store.getNetworkSnapshot(run.snapshot_id),networkSource=snapshot&&store.getSource(snapshot.source_id);
    let result;
    if(networkSource?.network_api?.provider==='statens-vegvesen-nvdb-api-les-v4')
      result=discoverNvdbRun(store,runId,{shouldYield,onProgress:progress=>{if(progress.edges_examined%50000===0)console.log(JSON.stringify({stage:'nvdb-discovery',...progress}));}});
    else if(String(networkSource?.type??'').toLowerCase().includes('osm'))
      result=discoverOsmRun(store,runId,{shouldYield,yieldReason:()=>yieldCheck.reason()});
    else throw new Error('discovery refuses unsupported network provider; OSM is never used as an implicit fallback');
    if(result.status==='BLOCKED')return result;
    if(networkSource?.network_api?.provider==='statens-vegvesen-nvdb-api-les-v4')
      return {...result,notification:{queued:false,reason:'NVDB-only uncertainty is an ORANGE research outcome, not a human legal decision'}};
    const notice=await queueReviewNotice(root,runId,result.candidate_count,env);
    return {...result,notification:notice};
  }catch(error){store.updateDiscoveryRun(runId,{status:'FAILED',last_error:error.message});throw error;}
  finally{process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);const released=releaseGeoAdmission(admission,owner,grant,'regional discovery completed, failed or safely yielded');if(!released.ok)throw new Error(`BLOCKED_SHARED_ADMISSION_RELEASE: ${released.reason??'lease not released'}`);}
}
function lineLength(geometry){const lines=geometry.type==='LineString'?[geometry.coordinates]:geometry.coordinates;return lines.reduce((sum,line)=>sum+line.slice(1).reduce((n,point,i)=>n+lengthMeters(line[i],point),0),0);}
function unknownReason(evidence){const rs=[...new Set(evidence.flatMap(e=>e.rule==='interval-network-ambiguity'&&e.reason?[e.reason]:e.rule==='no-network-match-within-threshold'?['no_network_match']:[]))];return rs.length===1?rs[0]:rs.length?'multiple_unknown_reasons':'NONE';}
function runStats(store,runId){const run=store.getRun(runId);if(!run)throw new Error(`unknown Scout run '${runId}'`);const rows=store.runObservations(runId);let classes={},unknown={},matchStates={},distanceKm={},unknownReasonKm={},lengthBins={lt25:0,lt50:0,lt100:0,lt250:0,lt500:0,lt1000:0};
  const segments=store.db.prepare(`SELECT s.classification,s.confidence,s.geometry_json,s.evidence_json FROM route_segments s JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version WHERE ro.run_id=? AND ro.status='COMPLETE'`).all(runId);
  for(const s of segments){const km=lineLength(JSON.parse(s.geometry_json))/1000;classes[s.classification]=(classes[s.classification]??0)+1;distanceKm[s.classification]=(distanceKm[s.classification]??0)+km;if(s.classification==='UNKNOWN'){const key=unknownReason(JSON.parse(s.evidence_json));unknown[key]=(unknown[key]??0)+1;unknownReasonKm[key]=(unknownReasonKm[key]??0)+km;}}
  const matches=store.db.prepare(`SELECT c.master_match,c.match_details_json,count(*) count FROM candidates c JOIN route_segments s USING(segment_id) JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version WHERE ro.run_id=? AND ro.status='COMPLETE' GROUP BY c.master_match,c.match_details_json`).all(runId);for(const x of matches){const details=JSON.parse(x.match_details_json??'{}'),key=x.master_match==='UNMATCHED'&&details.reason==='canonical master not supplied'?'NOT_COMPARED':x.master_match;matchStates[key]=(matchStates[key]??0)+x.count;}
  const candidates=store.db.prepare(`SELECT s.geometry_json FROM candidates c JOIN route_segments s USING(segment_id) JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version WHERE ro.run_id=? AND ro.status='COMPLETE'`).all(runId);for(const x of candidates){const m=lineLength(JSON.parse(x.geometry_json));for(const [k,n]of [['lt25',25],['lt50',50],['lt100',100],['lt250',250],['lt500',500],['lt1000',1000]])if(m<n)lengthBins[k]++;}
  const totalKm=Object.values(distanceKm).reduce((a,b)=>a+b,0);return {run,...run.observation_counts,observations:rows,candidate_count:candidates.length,canonical_status:run.config.canonical_status??'NOT_COMPARED',canonical_match_states:matchStates,total_km:Number(totalKm.toFixed(3)),distance_km_by_class:Object.fromEntries(Object.entries(distanceKm).map(([k,v])=>[k,Number(v.toFixed(3))])),classes,unknown_reasons:unknown,unknown_reason_km:Object.fromEntries(Object.entries(unknownReasonKm).map(([k,v])=>[k,Number(v.toFixed(3))])),candidate_length_below:lengthBins};
}
export async function runGeoCtl(argv=process.argv.slice(2),env=process.env){
  const [command,...rest]=argv;if(!command||command==='help'||command==='--help'){console.log(HELP);return 0;}
  const sub=rest[0],operation=command==='corridor'&&sub==='review'?rest[1]:null;
  const opts=parseGeoCtlArgs(rest.slice(operation?2:['source','network','run','review','notify','watchkeeper','region','discover','corridor','europe'].includes(command)?1:0));
  if(command==='europe'&&['sources','matrix'].includes(sub)){
    const countryCode=opts.country_code===undefined?null:required(opts,'country_code');
    if(sub==='matrix'){console.log(renderEuropeCoverageMatrix({countryCode}));return 0;}
    console.log(JSON.stringify({catalog:'europe-authoritative-transport-leads',state:'REVIEW_REQUIRED',automatic_retrieval:false,
      sources:listEuropeSourceCandidates({countryCode})},null,2));return 0;
  }
  if(command==='europe'&&sub==='benchmark'){
    const {root,store}=storeFor(env);try{
      const report=benchmarkTetAgainstIndependentDiscovery(store,{independentRunId:required(opts,'independent_run_id'),referenceRunId:required(opts,'reference_run_id')});
      const reportFile=writePrivateTetBenchmark(root,report);console.log(JSON.stringify({...report,private_report_file:reportFile},null,2));return 0;
    }finally{store.close();}
  }
  if(command==='region'&&sub==='prepare'){
    const choice=(yes,no,label)=>{if(opts[yes]===true&&opts[no]===true)throw new Error(`${label} cannot be both YES and NO`);if(opts[yes]===true)return true;if(opts[no]===true)return false;throw new Error(`region prepare requires an explicit YES/NO choice for ${label}`);};
    const {store}=storeFor(env);try{const plan=await prepareRegionPlan(store,{routeFile:required(opts,'route'),countryCode:required(opts,'country_code'),regionName:required(opts,'region'),sourceName:required(opts,'source_name'),sourceType:required(opts,'source_type'),
      permissions:{private_processing:choice('private_research','no_private_research','private research'),redistribution:choice('redistribution','no_redistribution','redistribution'),
        derived_public_use:choice('derived_public_use','no_derived_public_use','derived public use'),legal_evidence:choice('legal_evidence','no_legal_evidence','legal-evidence role')},
      sourceLicence:opts.source_licence,attribution:opts.attribution});console.log(JSON.stringify({run_id:plan.run_id,state:plan.state,country_code:plan.plan.country_code,region:plan.plan.region_name,
      source_id:plan.plan.route_source.source_id,source_checksum:plan.plan.route_file.sha256,route_bounds:plan.plan.route_file.bounds,viewport:plan.plan.route_file.viewport,
      network_provider:plan.plan.provider.provider,network_version:plan.plan.provider.version,network_url:plan.plan.provider.url,snapshot_id:plan.plan.provider.snapshot_id,
      permissions:plan.plan.permissions,approval_required:true},null,2));}finally{store.close();}return 0;
  }
  if(command==='region'&&sub==='approve'){const {store}=storeFor(env);try{const plan=approveRegionPlan(store,{runId:required(opts,'run_id'),approvedBy:required(opts,'by'),approvalScope:required(opts,'scope')});console.log(JSON.stringify({run_id:plan.run_id,state:plan.state,approved_by:plan.approved_by,approved_at:plan.approved_at},null,2));}finally{store.close();}return 0;}
  if(command==='region'&&sub==='process'){const {root,store}=storeFor(env);try{const result=await processRegionPlan(store,root,required(opts,'run_id'),env);console.log(JSON.stringify(result,null,2));return result.status==='BLOCKED'?75:0;}finally{store.close();} }
  if(command==='region'&&sub==='status'){const {store}=storeFor(env);try{const plan=store.getRegionPlan(required(opts,'run_id'));if(!plan)throw new Error(`unknown Scout region plan '${opts.run_id}'`);const run=store.getRun(plan.run_id);console.log(JSON.stringify({ ...plan,run:run?runStats(store,run.run_id):null },null,2));}finally{store.close();}return 0;}
  if(command==='region'&&sub==='list'){const {store}=storeFor(env);try{console.log(JSON.stringify(store.listRegionPlans().map(p=>({run_id:p.run_id,state:p.state,country_code:p.plan.country_code,region:p.plan.region_name,source_name:p.plan.source_name,network_version:p.plan.provider.version,updated_at:p.updated_at})),null,2));}finally{store.close();}return 0;}
  if(command==='region'&&sub==='review'){const {store}=storeFor(env);try{const runId=required(opts,'run_id');if(!store.getRegionPlan(runId))throw new Error(`unknown Scout region plan '${runId}'`);console.log(JSON.stringify(store.listRunReviewCandidates({runId,decision:opts.decision??'UNREVIEWED'}),null,2));}finally{store.close();}return 0;}
  if(command==='discover'&&sub==='create'){
    if(opts.reference_run_id!==undefined)throw new Error('discovery cannot accept a comparison/reference run; run the independent pass first, then use the post-run benchmark');
    const {store}=storeFor(env);try{const snapshotId=required(opts,'snapshot_id'),snapshot=store.getNetworkSnapshot(snapshotId);if(!snapshot)throw new Error('discovery requires a registered pinned network snapshot');
      const countryCode=required(opts,'country_code').toUpperCase(),networkSource=store.getSource(snapshot.source_id),isNvdb=networkSource?.network_api?.provider==='statens-vegvesen-nvdb-api-les-v4';
      const sourceInfo=isNvdb?registerNvdbDiscoverySource(store,snapshotId):registerOsmDiscoverySource(store,snapshotId),source=sourceInfo.source,regionId=required(opts,'region_id');
      const approvedBy=required(opts,'approved_by'),approvalScope=required(opts,'approval_scope');let approval=store.sourceApproval(source.source_id);
      if(approval&&(approval.approved_by!==approvedBy||approval.scope!==approvalScope))throw new Error('discovery source already has a different active approval; revoke/review it explicitly');
      if(!approval)approval=store.approveSource({source_id:source.source_id,approved_by:approvedBy,scope:approvalScope});
      let area;
      if(isNvdb){
        if(countryCode!=='NO')throw new Error('the NVDB adapter is approved for Norway only');
        const extent=store.networkExtent(snapshotId);if(!extent)throw new Error('BLOCKED_NETWORK_NOT_IMPORTED: NVDB snapshot has no geometry extent');
        const [west,south,east,north]=extent,dx=Math.max((east-west)*0.025,0.05),dy=Math.max((north-south)*0.025,0.05);
        area={viewport:[Math.max(-180,west-dx),Math.max(-90,south-dy),Math.min(180,east+dx),Math.min(90,north+dy)],jurisdiction_id:'NO',jurisdiction_version:snapshot.version,boundary_source:'official full-country NVDB network extent; display viewport only'};
      }else area=jurisdictionViewport(store,source,countryCode);
      const discoveryVersion=isNvdb?'nvdb-road-link-discovery-1':'osm-way-discovery-1';
      const config={title:opts.title??`${regionId} independent ${isNvdb?'NVDB':'OSM'} discovery`,viewport:area.viewport,
        discovery_version:discoveryVersion,jurisdiction:{id:area.jurisdiction_id,version:area.jurisdiction_version,boundary_source:area.boundary_source},
        source_filter:isNvdb?'all NVDB road links scanned countrywide; observed Traktorveg links may create private research leads (not rider-facing GREEN/ORANGE); pedestrian/cycle and ordinary road links remain network context':
          'registered OSM way parts selected by highway/surface/tracktype/smoothness/service context; excludes ordinary ROAD classifications',canonical_status:'NOT_COMPARED'};
      const run=store.createDiscoveryRun({run_id:required(opts,'run_id'),discovery_source_id:source.source_id,snapshot_id:snapshotId,country_code:countryCode,region_id:regionId,
        reference_run_id:null,title:config.title,viewport:area.viewport,approved_by:approvedBy,approval_scope:approvalScope,config});
      console.log(JSON.stringify({run_id:run.run_id,status:run.status,source_id:source.source_id,source_revision:source.revision,snapshot_id:snapshotId,snapshot_version:snapshot.version,
        snapshot_sha256:snapshot.checksum,country_code:countryCode,region_id:regionId,viewport:area.viewport,viewport_source:{jurisdiction_id:area.jurisdiction_id,version:area.jurisdiction_version},
        reference_run_id:run.reference_run_id,approved_by:approvedBy,approval_scope:approvalScope,redistribution_allowed:source.reuse.redistribution,derived_public_use_allowed:source.reuse.derived_public_use,
        legal_access_evidence_role:source.roles.legal_access,canonical_status:'NOT_COMPARED'},null,2));
    }finally{store.close();}return 0;
  }
  if(command==='discover'&&sub==='process'){const {root,store}=storeFor(env);try{const result=await processDiscoveryRun(store,root,required(opts,'run_id'),env);console.log(JSON.stringify(result,null,2));return result.status==='BLOCKED'?75:0;}finally{store.close();}}
  if(command==='discover'&&sub==='status'){const {store}=storeFor(env);try{const runId=required(opts,'run_id');console.log(JSON.stringify({...store.getDiscoveryRun(runId),stats:discoveryStats(store,runId)},null,2));}finally{store.close();}return 0;}
  if(command==='discover'&&sub==='list'){const {store}=storeFor(env);try{console.log(JSON.stringify(store.listDiscoveryRuns().map(run=>({...run,stats:discoveryStats(store,run.run_id)})),null,2));}finally{store.close();}return 0;}
  if(command==='corridor'&&sub==='process'){
    const {root,store}=storeFor(env),runId=required(opts,'run_id'),factoryDir=hostFactoryDir(env);let admission,grant,owner;
    try{
      assertGeoHostAdmission(readHostSnapshot({factoryDir}));admission=new SharedResourceAdmission(resourceAdmissionStateFile(factoryDir));owner=`scout-corridor:${runId}`;
      grant=admission.acquireScout(owner);if(!grant.ok)throw new Error(`BLOCKED_SHARED_ADMISSION: ${grant.reason??'lease unavailable'}`);
      let interrupted=false;const signal=()=>{interrupted=true;};process.once('SIGTERM',signal);process.once('SIGINT',signal);
      const yieldCheck=createGeoYieldCheck({factoryDir,owner,nonce:grant.lease.nonce}),shouldYield=()=>interrupted||yieldCheck();
      try{
        const result=await buildCorridorRun(store,{runId,shouldYield});if(result.status==='BLOCKED'){console.log(JSON.stringify(result,null,2));return 75;}
        const reviewCount=Number(result.review_queue?.AMBIGUOUS??0);
        const notification=await queueReviewNotice(root,`corridors:${runId}`,reviewCount,env);
        console.log(JSON.stringify({...result,notification},null,2));return 0;
      }finally{process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);}
    }finally{
      try{store.close();}finally{if(admission&&grant){const released=releaseGeoAdmission(admission,owner,grant,'Scout topology corridor run completed, failed or yielded');if(!released.ok)throw new Error(`BLOCKED_SHARED_ADMISSION_RELEASE: ${released.reason}`);}}
    }
  }
  if(command==='corridor'&&sub==='status'){const {store}=storeFor(env);try{const runId=required(opts,'run_id');if(!store.getDiscoveryRun(runId))throw new Error('unknown discovery run');console.log(JSON.stringify(corridorRunStats(store,runId),null,2));}finally{store.close();}return 0;}
  if(command==='corridor'&&sub==='review'&&operation==='list'){const {store}=storeFor(env);try{const runId=required(opts,'run_id');console.log(JSON.stringify(listCorridorReview(store,{runId,state:opts.state??'UNREVIEWED',limit:Number(opts.limit??200)}),null,2));}finally{store.close();}return 0;}
  if(command==='corridor'&&sub==='review'&&operation==='decide'){const {store}=storeFor(env);try{console.log(JSON.stringify(recordCorridorReview(store,{corridorId:required(opts,'corridor_id'),decision:required(opts,'decision'),reviewer:required(opts,'reviewer'),reason:required(opts,'reason')}),null,2));}finally{store.close();}return 0;}
  if(command==='source'&&sub==='register'){const definition=JSON.parse(fs.readFileSync(required(opts,'manifest'),'utf8'));const {store}=storeFor(env);try{console.log(JSON.stringify(store.registerSource(definition),null,2));}finally{store.close();}return 0;}
  if(command==='source'&&sub==='register-spw'){const {store}=storeFor(env);try{console.log(JSON.stringify(store.registerSource(spwRoadSourceDefinition()),null,2));}finally{store.close();}return 0;}
  if(command==='source'&&sub==='register-nvdb-no'){const {store}=storeFor(env);try{console.log(JSON.stringify(store.registerSource(nvdbNorwaySourceDefinition()),null,2));}finally{store.close();}return 0;}
  if(command==='source'&&sub==='approve'){const {store}=storeFor(env);try{console.log(JSON.stringify(store.approveSource({source_id:required(opts,'source_id'),approved_by:required(opts,'by'),scope:required(opts,'scope')}),null,2));}finally{store.close();}return 0;}
  if(command==='watchkeeper'&&sub==='spw-poll'){const {store}=storeFor(env);try{const result=await pollSpwServiceMetadata(store);console.log(JSON.stringify(result,null,2));return ['AMBER','RED'].includes(result.state)?75:0;}finally{store.close();}}
  if(command==='import'){const sourceId=required(opts,'source_id'),inputFile=required(opts,'file'),rawRoot=configuredPath('SCOUT_RAW_ROOT'),{store}=storeFor(env);try{if(!store.sourceApproval(sourceId))throw new Error('route import requires an explicit active source approval');const result=ingestRouteFile(store,{inputFile,sourceId,relativeName:opts.name??path.basename(inputFile),rawRoot,sourceLanguage:opts.language??null});console.log(JSON.stringify({file_id:result.file_id,version:result.version,checksum:result.checksum,format:result.format,duplicate:result.duplicate,observation_count:result.observations.length,observation_ids:result.observations.map(x=>x.observation_id)},null,2));}finally{store.close();}return 0;}
  if(command==='network'&&sub==='status'){const {store}=storeFor(env);try{const describe=snapshot=>{const edge_count=store.networkEdgeCount(snapshot.snapshot_id),artifact=store.getNetworkArtifact(snapshot.snapshot_id),import_checkpoint=store.networkImportCheckpoint(snapshot.snapshot_id);return {...snapshot,edge_count,artifact,import_checkpoint,operator_state:import_checkpoint?.status??(edge_count?'EDGES_PRESENT_LEGACY_CHECKPOINT':'PINNED_NOT_IMPORTED')};};const rows=opts.snapshot_id?[store.getNetworkSnapshot(opts.snapshot_id)].filter(Boolean).map(describe):store.listSources().filter(s=>s.roles.routing_network).flatMap(source=>{
    const registered=store.db.prepare('SELECT snapshot_id FROM network_snapshots WHERE source_id=? ORDER BY imported_at DESC').all(source.source_id).map(r=>store.getNetworkSnapshot(r.snapshot_id));
    return registered.length?registered.map(snapshot=>({source_id:source.source_id,network_extract:source.network_extract,...describe(snapshot)})):[{source_id:source.source_id,network_extract:source.network_extract,operator_state:'NOT_ACQUIRED'}];});
    console.log(JSON.stringify(rows,null,2));}finally{store.close();}return 0;}
  if(command==='network'&&(sub==='acquire'||sub==='import')){const {root,store}=storeFor(env);const snapshotId=required(opts,'snapshot_id'),sourceId=opts.source_id;try{
    if(sub==='acquire'){if(!sourceId)throw new Error('--source-id is required for network acquire');const source=store.getSource(sourceId);if(!source)throw new Error(`unknown network source '${sourceId}'`);if(source.network_api?.provider!=='statens-vegvesen-nvdb-api-les-v4')resolveNetworkExtract(source);}
    else{const snapshot=store.getNetworkSnapshot(snapshotId);if(!snapshot||!store.sourceApproval(snapshot.source_id))throw new Error('network import requires a registered snapshot with explicit active source approval');}
    const result=await networkStage(store,root,{sub,sourceId,snapshotId,env});
    console.log(JSON.stringify(result,null,2));return result.status==='YIELDED'?75:0;
  }finally{store.close();}}
  if(command==='run'&&sub==='create'){const {store}=storeFor(env);try{const viewport=required(opts,'viewport').split(',').map(Number);if(viewport.length!==4)throw new Error('--viewport needs west,south,east,north');const run=store.createRun({run_id:required(opts,'run_id'),source_id:required(opts,'source_id'),snapshot_id:required(opts,'snapshot_id'),country_code:required(opts,'country_code').toUpperCase(),region_id:required(opts,'region_id'),title:opts.title,viewport,approved_by:required(opts,'approved_by'),approval_scope:required(opts,'approval_scope')});console.log(JSON.stringify(run,null,2));}finally{store.close();}return 0;}
  if(command==='run'&&sub==='list'){const {store}=storeFor(env);try{console.log(JSON.stringify(store.listRuns(),null,2));}finally{store.close();}return 0;}
  if(command==='run'&&sub==='status'){const {store}=storeFor(env);try{console.log(JSON.stringify(runStats(store,required(opts,'run_id')),null,2));}finally{store.close();}return 0;}
  if(command==='process'&&opts.run_id){const {root,store}=storeFor(env);try{const run=store.getRun(opts.run_id);if(!run)throw new Error(`unknown Scout run '${opts.run_id}'`);const result=await processRun(store,root,run,env);console.log(JSON.stringify(result,null,2));return result.status==='BLOCKED'?75:0;}finally{store.close();}}
  if(command==='process'){const observationId=required(opts,'observation_id'),snapshotId=required(opts,'snapshot_id'),factoryDir=hostFactoryDir(env),{store}=storeFor(env);const host=readHostSnapshot({factoryDir});assertGeoHostAdmission(host);const admission=new SharedResourceAdmission(resourceAdmissionStateFile(factoryDir)),owner=`scout-geo:${observationId}`,grant=admission.acquireScout(owner);if(!grant.ok){store.close();throw new Error(`BLOCKED_SHARED_ADMISSION: ${grant.reason??'lease unavailable'}`);}try{const shouldYield=()=>sharedFactoryYieldRequested(resourceAdmissionStateFile(factoryDir),owner,grant.nonce),result=processRouteObservation(store,observationId,{networkSnapshotId:snapshotId,shouldYield});console.log(JSON.stringify({observation_id:result.observation_id,network_snapshot:result.network_snapshot,segment_count:result.segment_count,candidate_count:result.candidate_count,continuity_hypotheses:result.continuity_hypotheses.length,source_geometry_preserved:true,motorcycle_access:'unknown',routability:'unknown',canonical_status:'NOT_COMPARED'},null,2));return 0;}finally{try{store.close();}finally{const released=releaseGeoAdmission(admission,owner,grant,'one-off observation processing complete or yielded');if(!released.ok)throw new Error(`BLOCKED_SHARED_ADMISSION_RELEASE: ${released.reason}`);}}}
  if(command==='review'&&sub==='list'){const {store}=storeFor(env);try{console.log(JSON.stringify(store.listRunReviewCandidates({runId:opts.run_id??null,decision:opts.decision??'UNREVIEWED'}),null,2));}finally{store.close();}return 0;}
  if(command==='review'&&sub==='decide'){const {store}=storeFor(env);try{console.log(JSON.stringify(store.recordReviewDecision({candidate_id:required(opts,'candidate_id'),decision:required(opts,'decision'),reviewer:required(opts,'reviewer'),reason:required(opts,'reason')}),null,2));}finally{store.close();}return 0;}
  if(command==='review'&&sub==='serve'){const port=opts.port===undefined?8766:Number(opts.port);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('--port must be an unprivileged port');const root=configuredPath('SCOUT_GEO_ROOT');const server=createRealReviewServer({runId:required(opts,'run_id'),databaseFile:path.join(root,'scout.sqlite'),privateBase:root,port});server.on('listening',()=>console.log(`private Scout review at http://127.0.0.1:${server.address().port}/`));return 0;}
  if(command==='notify'&&sub==='retry'){const root=configuredPath('SCOUT_GEO_ROOT'),recipient=env.SCOUT_NOTIFICATION_EMAIL;let providers={};if(recipient){try{providers={EMAIL:createZohoSmtpProvider({recipient,subject:'RT&T Scout pending notification'})};}catch{/* provider is reported unavailable; pending state is preserved */}}const center=new NotificationCenter(reviewFile(root),{providers});console.log(JSON.stringify(await center.retryPending(),null,2));return 0;}
  if(command==='status'){const {root,store}=storeFor(env);try{const notifications=new NotificationCenter(reviewFile(root)).state(),allCandidates=store.listRunReviewCandidates({decision:'ALL'}),pendingCandidates=new Set(allCandidates.filter(c=>c.decision==='UNREVIEWED').map(c=>c.candidate_id));console.log(JSON.stringify({private:true,source_count:store.listSources().length,network_snapshots:store.db.prepare('SELECT count(*) count FROM network_snapshots').get().count,runs:store.listRuns().map(({run_id,status,country_code,region_id,observation_counts})=>({run_id,status,country_code,region_id,observation_counts})),review_queue:{unreviewed_candidates:pendingCandidates.size,legacy_open_review_items:store.db.prepare("SELECT count(*) count FROM review_items WHERE state IN ('OPEN','IN_PROGRESS')").get().count},notification_pending:notifications.pending.length,notification_active:Object.values(notifications.active).filter(x=>!x.resolved).length},null,2));}finally{store.close();}return 0;}
  throw new Error(`unknown command '${command}${sub?` ${sub}`:''}'\n${HELP}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){runGeoCtl().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.code==='SCOUT_YIELD_REQUESTED'?'YIELD_REQUESTED: job checkpointed; retry after factory work.':error.message);process.exitCode=error.code==='SCOUT_YIELD_REQUESTED'?75:2;});}
