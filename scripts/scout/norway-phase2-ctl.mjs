#!/usr/bin/env node
// Owner-authorized Norway Phase 2 operator. Every independent input is a
// checksum-pinned official network source; the TET file is referenced only by
// the post-freeze benchmark command.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ScoutGeoStore } from './geostore.mjs';
import { nvdbNorwaySourceDefinition, registerNvdbDiscoverySource, importNvdbSnapshot, discoverNvdbRun } from './nvdb-network.mjs';
import { discoverOsmRun, registerOsmDiscoverySource } from './osm-discovery.mjs';
import { buildCorridorRun } from './osm-topology.mjs';
import { acquireNetworkSnapshot, importNetworkArtifact } from './network-provider.mjs';
import { resolveGeofabrikCountry } from './geofabrik-index.mjs';
import { geofabrikNetworkSourceDefinition } from './region-operator.mjs';
import { SharedResourceAdmission, resourceAdmissionStateFile } from '../lib/resource-admission.mjs';
import { readHostSnapshot } from './resources.mjs';
import { assertGeoHostAdmission, createGeoYieldCheck, releaseGeoAdmission } from './geoctl.mjs';
import { buildNorwayNvdbCorridors, benchmarkFrozenNorwayAgainstTet, freezeNorwayPhase2, norwayReconciliationStats, reconcileNorwayCorridors, verifyNorwayPhase2Freeze, NORWAY_PHASE1_BASELINE } from './norway-phase2.mjs';

const PHASE2_RUN='norway-phase2-20261006',NVDB_SNAPSHOT='no-nvdb-phase1-20261006',NVDB_FILE='/home/karl/rtt-map-factory/scout/private/real-source-validation/norway-phase1/state/network/no-nvdb-phase1-20261006.nvdb.jsonl',DEFAULT_ROOT='/home/karl/rtt-map-factory/scout/private/real-source-validation/norway-phase2/state';
const NVDB_RUN=`${PHASE2_RUN}-nvdb`,OSM_RUN=`${PHASE2_RUN}-osm`,SCOPE='Owner-authorized Norway Phase 2 blind independent network processing; private SSD only; TET excluded until Phase 2 freeze.';
const HELP=`norway-phase2-ctl prepare
norway-phase2-ctl import-nvdb
norway-phase2-ctl acquire-osm
norway-phase2-ctl import-osm
norway-phase2-ctl create-runs
norway-phase2-ctl discover --run-id ID
norway-phase2-ctl osm-corridors
norway-phase2-ctl nvdb-corridors
norway-phase2-ctl reconcile
norway-phase2-ctl freeze --commit SHA
norway-phase2-ctl benchmark --tet-file /home/karl/Downloads/N.gpx
norway-phase2-ctl status`;
const shaFile=async(file,shouldYield=()=>false)=>{const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file)){if(shouldYield()){const error=new Error('Norway Phase 2 yielded while checksumming a pinned artifact');error.code='SCOUT_YIELD_REQUESTED';throw error;}h.update(chunk);}return h.digest('hex');};
const assertUnfrozen=root=>{if(fs.existsSync(path.join(root,'phase2-frozen.json')))throw new Error('Norway Phase 2 is frozen; independent inputs/results are immutable');};
function openStore(env=process.env){const root=env.SCOUT_GEO_ROOT??DEFAULT_ROOT;return {root:path.resolve(root),store:new ScoutGeoStore(root)};}
function privateJson(file,value){const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});if(fs.lstatSync(dir).isSymbolicLink())throw new Error('Norway Phase 2 output directory may not be a symlink');const tmp=`${file}.${process.pid}.tmp`,fd=fs.openSync(tmp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);fs.chmodSync(file,0o600);}
async function withLease(owner,env,work){const factoryDir=env.FACTORY_DIR??path.join(os.homedir(),'rtt-map-factory');assertGeoHostAdmission(readHostSnapshot({factoryDir}));const admission=new SharedResourceAdmission(resourceAdmissionStateFile(factoryDir)),grant=admission.acquireScout(owner);if(!grant.ok)throw new Error(`BLOCKED_SHARED_ADMISSION: ${grant.reason??'lease unavailable'}`);let interrupted=false;const onSignal=()=>{interrupted=true;};process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);const resourceYield=createGeoYieldCheck({factoryDir,owner,nonce:grant.lease.nonce}),shouldYield=()=>interrupted||resourceYield();shouldYield.reason=()=>interrupted?'Norway Phase 2 received a graceful shutdown signal':resourceYield.reason();
  try{return await work(shouldYield);}finally{process.removeListener('SIGTERM',onSignal);process.removeListener('SIGINT',onSignal);const result=releaseGeoAdmission(admission,owner,grant,interrupted?'Norway Phase 2 safely yielded after shutdown signal':'Norway Phase 2 stage completed, failed or safely yielded');if(!result.ok)throw new Error(`BLOCKED_SHARED_ADMISSION_RELEASE: ${result.reason}`);}}
function approved(store,sourceId,by='Karl',scope=SCOPE){const prior=store.sourceApproval(sourceId);if(prior&&(prior.approved_by!==by||prior.scope!==scope))throw new Error(`Norway source '${sourceId}' has a conflicting approval`);if(!prior)store.approveSource({source_id:sourceId,approved_by:by,scope});}
function planFile(root){return path.join(root,'norway-phase2-plan.json');}
function createRuns(store){
  const snapshots=[NVDB_SNAPSHOT,store.getSource('network-geofabrik-no')?.network_extract?.snapshot_id];if(!snapshots[1])throw new Error('Norway OSM extract has not been registered');
  const ids=[NVDB_RUN,OSM_RUN],defs=[registerNvdbDiscoverySource(store,snapshots[0]).source,registerOsmDiscoverySource(store,snapshots[1]).source];
  return ids.map((runId,index)=>{const source=defs[index],snapshot=store.getNetworkSnapshot(snapshots[index]),approvalScope=`${SCOPE} source adapter ${source.source_id}`,by='Karl';approved(store,source.source_id,by,approvalScope);const extent=store.networkExtent(snapshot.snapshot_id);if(!extent)throw new Error(`Norway snapshot '${snapshot.snapshot_id}' has no imported spatial extent`);
    const run=store.createDiscoveryRun({run_id:runId,discovery_source_id:source.source_id,snapshot_id:snapshot.snapshot_id,country_code:'NO',region_id:'NO',title:`Norway independent ${index===0?'NVDB':'OSM'} road network discovery`,viewport:extent,approved_by:by,approval_scope:approvalScope,config:{canonical_status:'NOT_COMPARED',tet_use:'PROHIBITED_UNTIL_PHASE2_FREEZE',product_projection:'ordinary roads remain ordinary; credible special corridors ORANGE absent independent legal verification'}});return {run_id:run.run_id,snapshot_id:snapshot.snapshot_id,status:run.status};});
}
export async function runNorwayPhase2Ctl(argv=process.argv.slice(2),env=process.env){const [command,...args]=argv;
  if(!command||command==='--help'||command==='help'){console.log(HELP);return 0;}
  if(command==='benchmark'){
    const root=path.resolve(env.SCOUT_GEO_ROOT??DEFAULT_ROOT),file=args[0]==='--tet-file'?args[1]:null;if(file!=='/home/karl/Downloads/N.gpx')throw new Error('post-freeze comparison is authorized only for the explicitly approved /home/karl/Downloads/N.gpx');
    const start=path.join(root,'phase2-tet-benchmark-started.json'),progressFile=path.join(root,'phase2-tet-benchmark-progress.json'),output=path.join(root,'phase2-tet-benchmark-report.json');
    if(fs.existsSync(output))throw new Error('Norway TET benchmark already has a completed report');
    const report=await withLease(`scout-norway-tet-benchmark:${PHASE2_RUN}`,env,async shouldYield=>{
      let prior=null;if(fs.existsSync(progressFile)){if(fs.lstatSync(progressFile).isSymbolicLink()||!fs.statSync(progressFile).isFile())throw new Error('benchmark progress file must be a regular private file');prior=JSON.parse(fs.readFileSync(progressFile,'utf8'));if(prior.phase!=='NORWAY_PHASE2_POST_FREEZE_BENCHMARK'||!Array.isArray(prior.features)||!/^([a-f0-9]{64})$/i.test(prior.tet_sha256??'')||!/^([a-f0-9]{64})$/i.test(prior.phase2_database_sha256??''))throw new Error('benchmark progress checkpoint is malformed; manual integrity review is required');}
      if(fs.existsSync(start)&&(fs.lstatSync(start).isSymbolicLink()||!fs.statSync(start).isFile()))throw new Error('benchmark start marker must be a regular private file');
      if(fs.existsSync(start)&&!prior)throw new Error('benchmark was started without a recovery checkpoint; refusing to reopen TET again');
      const features=[...(prior?.features??[])];
      const result=await benchmarkFrozenNorwayAgainstTet({root,databaseFile:path.join(root,'scout.sqlite'),tetFile:file,shouldYield,priorFeatures:features,
        onStart:info=>{if(prior&&(prior.phase2_database_sha256!==info.phase2_database_sha256||prior.tet_sha256!==info.tet_sha256))throw new Error('the frozen database or explicitly approved TET comparison file changed during benchmark recovery');const startedAt=fs.existsSync(start)?JSON.parse(fs.readFileSync(start,'utf8')).started_at:new Date().toISOString();privateJson(progressFile,{phase:'NORWAY_PHASE2_POST_FREEZE_BENCHMARK',status:'RUNNING',phase2_database_sha256:info.phase2_database_sha256,tet_sha256:info.tet_sha256,feature_count:info.feature_count,features});privateJson(start,{phase:'NORWAY_PHASE2_POST_FREEZE_BENCHMARK',status:'RUNNING',started_at:startedAt,phase2_database_sha256:info.phase2_database_sha256,tet_file_basename:'N.gpx',tet_sha256:info.tet_sha256,tet_access_before_freeze:false});},
        onFeature:(feature,info)=>{features.push(feature);privateJson(progressFile,{phase:'NORWAY_PHASE2_POST_FREEZE_BENCHMARK',status:'RUNNING',phase2_database_sha256:info.phase2_database_sha256,tet_sha256:info.tet_sha256,feature_count:info.feature_count,features});}});
      if(result.status==='BLOCKED')privateJson(progressFile,{phase:'NORWAY_PHASE2_POST_FREEZE_BENCHMARK',status:'BLOCKED',phase2_database_sha256:JSON.parse(fs.readFileSync(start,'utf8')).phase2_database_sha256,tet_sha256:result.tet_sha256,feature_count:result.feature_count,features});
      if(result.status==='COMPLETE'){privateJson(output,result);privateJson(progressFile,{phase:'NORWAY_PHASE2_POST_FREEZE_BENCHMARK',status:'COMPLETE',phase2_database_sha256:result.phase2_freeze.database_sha256,tet_sha256:result.comparison_corpus.sha256,feature_count:result.feature_count,features});privateJson(start,{phase:'NORWAY_PHASE2_POST_FREEZE_BENCHMARK',status:'COMPLETE',started_at:JSON.parse(fs.readFileSync(start,'utf8')).started_at,completed_at:new Date().toISOString(),phase2_database_sha256:result.phase2_freeze.database_sha256,tet_file_basename:'N.gpx',tet_sha256:result.comparison_corpus.sha256,tet_access_before_freeze:false});}
      return result;
    });
    if(report.status==='BLOCKED'){console.log(JSON.stringify({status:'BLOCKED_RESUMABLE',features_completed:report.features_completed,feature_count:report.feature_count,progress_file:progressFile},null,2));return 75;}
    console.log(JSON.stringify({status:'BENCHMARK_COMPLETE',report_file:output,feature_count:report.feature_count,identity_counts:report.identity_counts,length_weighted:report.length_weighted,canonical_modified:false,public_artifacts_modified:false},null,2));return 0;
  }
  if(command==='status'&&fs.existsSync(path.join(path.resolve(env.SCOUT_GEO_ROOT??DEFAULT_ROOT),'phase2-frozen.json'))){const root=path.resolve(env.SCOUT_GEO_ROOT??DEFAULT_ROOT);console.log(JSON.stringify({phase2_run:PHASE2_RUN,frozen:JSON.parse(fs.readFileSync(path.join(root,'phase2-frozen.json'),'utf8')),benchmark_report:fs.existsSync(path.join(root,'phase2-tet-benchmark-report.json'))?JSON.parse(fs.readFileSync(path.join(root,'phase2-tet-benchmark-report.json'),'utf8')):null},null,2));return 0;}
  if(command==='prepare'){
    const {root,store}=openStore(env);try{assertUnfrozen(root);const priorFile=planFile(root);let plan;
      if(fs.existsSync(priorFile)){if(fs.lstatSync(priorFile).isSymbolicLink())throw new Error('Norway Phase 2 plan may not be a symlink');plan=JSON.parse(fs.readFileSync(priorFile,'utf8'));}
      else{
        const source=nvdbNorwaySourceDefinition();store.registerSource(source);approved(store,source.source_id);
        const provider=await resolveGeofabrikCountry({countryCode:'NO',regionName:'Norway'}),osmSource=geofabrikNetworkSourceDefinition(provider);store.registerSource(osmSource);approved(store,osmSource.source_id);
        plan={phase2_run:PHASE2_RUN,nvdb:{snapshot_id:NVDB_SNAPSHOT,source_id:source.source_id,raw_file:NVDB_FILE,sha256:NORWAY_PHASE1_BASELINE.nvdb_checksum,version:`${source.network_api.api_version??'nvdb-api-les-v4'}; Phase 1 pinned artifact; 2026-10-06`,adapter_version:source.adapter_version},osm:{source_id:osmSource.source_id,provider,licence:provider.licence,attribution:provider.attribution},route_corpus_present:false,tet_access:'PROHIBITED_UNTIL_FREEZE'};
        privateJson(priorFile,plan);
      }
      const source=store.getSource(plan.nvdb.source_id),approval=store.sourceApproval(source.source_id);if(!approval||approval.approved_by!=='Karl')throw new Error('Phase 2 NVDB source approval is unavailable');
      const sourceFile=path.resolve(plan.nvdb.raw_file);if(fs.lstatSync(sourceFile).isSymbolicLink()||!fs.statSync(sourceFile).isFile())throw new Error('pinned Phase 1 NVDB artifact is not a regular file');
      const privateNetwork=path.join(root,'network');fs.mkdirSync(privateNetwork,{recursive:true,mode:0o700});if(fs.lstatSync(privateNetwork).isSymbolicLink()||!fs.realpathSync(privateNetwork).startsWith(fs.realpathSync(root)+path.sep))throw new Error('Phase 2 network artifact directory escaped private Scout storage');
      const target=path.join(privateNetwork,`${NVDB_SNAPSHOT}.nvdb.jsonl`);if(!fs.existsSync(target))fs.linkSync(sourceFile,target);if(fs.lstatSync(target).isSymbolicLink()||fs.statSync(target).size!==4_096_689_232)throw new Error('reused NVDB artifact size differs from the pinned Phase 1 snapshot');
      const checksum=await withLease('scout-norway-phase1-nvdb-verify',env,async shouldYield=>{if(shouldYield())throw new Error('BLOCKED_SHARED_ADMISSION: factory/resource governor requested a yield');return shaFile(target,shouldYield);});if(checksum!==NORWAY_PHASE1_BASELINE.nvdb_checksum)throw new Error('reused NVDB artifact failed the immutable Phase 1 SHA-256');
      store.recordNetworkSnapshot({snapshot_id:NVDB_SNAPSHOT,source_id:source.source_id,version:'nvdb-api-les-v4; pinned Phase 1 2026-10-06 artifact',checksum,licence:{...source.licence,attribution:source.attribution},coverage:{countries:['NO'],regions:['NO'],retrieved_at:'2026-10-06',point_in_time_consistent:false,source_snapshot:'Phase 1 checksum-pinned NVDB response bundle'}});
      const registered=store.getNetworkSnapshot(NVDB_SNAPSHOT);if(registered.checksum!==checksum||registered.source_id!==source.source_id)throw new Error('existing Norway Phase 2 NVDB snapshot pin conflicts');
      store.recordNetworkArtifact({snapshot_id:NVDB_SNAPSHOT,provider:source.network_api.provider,source_url:`${source.network_api.base_url}${source.network_api.endpoint}`,local_path:target,byte_size:fs.statSync(target).size,sha256:checksum,last_modified:'2026-10-06'});
      console.log(JSON.stringify({status:'PREPARED',phase2:PHASE2_RUN,nvdb:{snapshot_id:NVDB_SNAPSHOT,sha256:checksum,reused_phase1_raw_artifact:true,normalizer_version:source.adapter_version},osm:{source_id:plan.osm.source_id,region:plan.osm.provider.region_name,version:plan.osm.provider.version,snapshot_id:plan.osm.provider.snapshot_id,url:plan.osm.provider.url,sha256:'calculated only after download',licence:plan.osm.licence,attribution:plan.osm.attribution},private_root:root,tet_read:false},null,2));
    }finally{store.close();}return 0;
  }
  if(command==='status'){const {root,store}=openStore(env);try{const plan=fs.existsSync(planFile(root))?JSON.parse(fs.readFileSync(planFile(root),'utf8')):null;const result={phase2_run:PHASE2_RUN,frozen:fs.existsSync(path.join(root,'phase2-frozen.json')),phase2_plan:plan?{nvdb:store.getNetworkSnapshot(NVDB_SNAPSHOT),osm_snapshot_id:plan.osm.provider.snapshot_id,osm:store.getNetworkSnapshot(plan.osm.provider.snapshot_id)}:null,discovery_runs:store.listDiscoveryRuns?store.listDiscoveryRuns():[NVDB_RUN,OSM_RUN].map(id=>store.getDiscoveryRun(id)).filter(Boolean).map(run=>({run_id:run.run_id,status:run.status,snapshot_id:run.snapshot_id,edges_examined:run.edges_examined,candidates_created:run.candidates_created})),nvdb_corridors:store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='phase2_network_corridors'").get().n?store.db.prepare("SELECT count(*) n FROM phase2_network_corridors WHERE snapshot_id=?").get(NVDB_SNAPSHOT).n:0,cross_source:store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='phase2_cross_source_support'").get().n?norwayReconciliationStats(store,OSM_RUN):null};console.log(JSON.stringify(result,null,2));}finally{store.close();}return 0;}
  if(command==='prepare'||command==='status')return 0;
  const {root,store}=openStore(env);let storeOpen=true;try{assertUnfrozen(root);const planPath=planFile(root);if(!fs.existsSync(planPath))throw new Error('run norway-phase2-ctl prepare first');const plan=JSON.parse(fs.readFileSync(planPath,'utf8'));
    if(command==='import-nvdb'){const result=await withLease('scout-norway-nvdb-import',env,shouldYield=>importNvdbSnapshot(store,{snapshotId:NVDB_SNAPSHOT,shouldYield,onBatch:p=>{if(p.pages_seen%100===0)console.log(JSON.stringify({stage:'nvdb-import',...p}));}}));console.log(JSON.stringify(result,null,2));return result.status==='YIELDED'?75:0;}
    if(command==='acquire-osm'){const result=await withLease('scout-norway-osm-acquire',env,shouldYield=>acquireNetworkSnapshot(store,{sourceId:plan.osm.source_id,snapshotId:plan.osm.provider.snapshot_id,dataRoot:path.join(root,'network'),calculateChecksum:true,shouldYield}));console.log(JSON.stringify(result,null,2));return result.status==='YIELDED'?75:0;}
    if(command==='import-osm'){const result=await withLease('scout-norway-osm-import',env,shouldYield=>importNetworkArtifact(store,{snapshotId:plan.osm.provider.snapshot_id,shouldYield}));console.log(JSON.stringify(result,null,2));return result.status==='YIELDED'?75:0;}
    if(command==='create-runs'){console.log(JSON.stringify(createRuns(store),null,2));return 0;}
    if(command==='discover'){
      const runId=args[0]==='--run-id'?args[1]:null;if(![NVDB_RUN,OSM_RUN].includes(runId))throw new Error(`discover requires --run-id ${NVDB_RUN} or ${OSM_RUN}`);
      const run=store.getDiscoveryRun(runId);if(!run)throw new Error('run missing; invoke create-runs after both snapshot imports');
      const result=await withLease(`scout-norway-discovery:${runId}`,env,shouldYield=>run.snapshot_id===NVDB_SNAPSHOT?discoverNvdbRun(store,runId,{shouldYield,onProgress:p=>{if(p.edges_examined%50000===0)console.log(JSON.stringify({stage:'nvdb-discovery',...p}));}}):discoverOsmRun(store,runId,{shouldYield}));console.log(JSON.stringify(result,null,2));return result.status==='BLOCKED'?75:0;
    }
    if(command==='osm-corridors'){const run=store.getDiscoveryRun(OSM_RUN),artifact=run&&store.getNetworkArtifact(run.snapshot_id);if(!run||!artifact)throw new Error('OSM discovery and its registered PBF artifact must be available');const result=await withLease(`scout-norway-osm-corridors:${OSM_RUN}`,env,shouldYield=>buildCorridorRun(store,{runId:OSM_RUN,shouldYield,includeDiscoveryHintSupport:false}));console.log(JSON.stringify(result,null,2));return result.status==='BLOCKED'?75:0;}
    if(command==='nvdb-corridors'){let batches=0,profile={sequence_page_ms:0,source_rows_ms:0,parse_ms:0,derive_and_write_ms:0,commit_ms:0,batch_ms:0,batch_links:0};const result=await withLease(`scout-norway-nvdb-corridors:${NVDB_RUN}`,env,shouldYield=>buildNorwayNvdbCorridors(store,{snapshotId:NVDB_SNAPSHOT,shouldYield,onProgress:p=>{batches++;for(const key of Object.keys(profile))profile[key]+=Number(p[key]??0);if(batches%1000===0){console.log(JSON.stringify({stage:'nvdb-corridors',sequence_id:p.sequence_id,links_processed:p.links_processed,batches,profile_1000_batches:Object.fromEntries(Object.entries(profile).map(([key,value])=>[key,Math.round(value*100)/100]))}));profile={sequence_page_ms:0,source_rows_ms:0,parse_ms:0,derive_and_write_ms:0,commit_ms:0,batch_ms:0,batch_links:0};}}}));console.log(JSON.stringify(result,null,2));return result.status==='BLOCKED'?75:0;}
    if(command==='reconcile'){const result=await withLease(`scout-norway-cross-source:${PHASE2_RUN}`,env,shouldYield=>reconcileNorwayCorridors(store,{osmRunId:OSM_RUN,shouldYield,onProgress:p=>{if(p.processed%5000===0)console.log(JSON.stringify({stage:'nvdb-osm-reconciliation',...p}));}}));console.log(JSON.stringify(result,null,2));return result.status==='BLOCKED'?75:0;}
    if(command==='freeze'){
      const commit=args[0]==='--commit'?args[1]:null;if(!commit)throw new Error('freeze requires --commit with the current committed code SHA');const nvdb=store.getNetworkSnapshot(NVDB_SNAPSHOT),osm=store.getNetworkSnapshot(plan.osm.provider.snapshot_id);
      const projection={ordinary_roads:'normal navigation network',green:0,orange:'credible special route corridors without independent authoritative Norway access evidence',red:0,temporarily_closed:0,motorcycle_access:'UNKNOWN unless independently sourced',routability:'UNKNOWN unless independently tested',canonical_status:'NOT_COMPARED'};
      store.close();storeOpen=false;
      const result=await withLease(`scout-norway-freeze:${PHASE2_RUN}`,env,shouldYield=>freezeNorwayPhase2({root,databaseFile:path.join(root,'scout.sqlite'),runIds:[NVDB_RUN,OSM_RUN],snapshotIds:[NVDB_SNAPSHOT,plan.osm.provider.snapshot_id],nvdbChecksum:nvdb?.checksum,osmChecksum:osm?.checksum,codeCommit:commit,productProjection:projection,shouldYield,completedStages:['NVDB_IMPORT','OSM_IMPORT','NVDB_DISCOVERY','OSM_DISCOVERY','NVDB_SEQUENCE_CORRIDORS','OSM_CORRIDOR_BUILD','NVDB_OSM_CORRIDOR_RECONCILIATION']}));console.log(JSON.stringify(result,null,2));return 0;
    }
    throw new Error(`unknown Phase 2 command '${command}'\n${HELP}`);
  }finally{if(storeOpen)store.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)runNorwayPhase2Ctl().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=2;});
