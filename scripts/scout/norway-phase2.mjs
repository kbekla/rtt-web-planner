// Norway Phase 2 freeze/benchmark boundary. TET is not opened by any Phase 2
// preparation, acquisition, import, discovery, or corridor-processing code.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseRouteFile } from './route-parsers.mjs';
import { buildNvdbSequenceCorridors, classifyPhysicalRoad } from './physical-road-model.mjs';
import { lengthMeters } from './route-segmenter.mjs';
import { compareSpwCorridor } from './spw-network.mjs';

export const NORWAY_PHASE1_BASELINE=Object.freeze({run_id:'no-phase1-nvdb-20261006',nvdb_checksum:'2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1',edges_examined:3104901,candidate_pieces:514859,reference_features:17,exact:0,partial:0,all_features_ambiguous:true,ambiguous_candidate_edge_support:17,independent_candidate_pieces_outside_ambiguous_comparisons:505228,route_processing:Object.freeze({road_km:7137.013,unknown_km:1695.940,unknown_reasons_km:Object.freeze({no_network_match:988.746,competing_network_classes:469.111,insufficient_tags:126.684,interval_support_uncertainty:111.398})})});
const shaFile=async file=>{const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const safeId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(value);

/** Phase 2 database contains only independent network records, never route-corpus data. */
export function validateNorwayPhase2State(db,{runIds,snapshotIds,nvdbChecksum,osmChecksum}={}){
  if(!Array.isArray(runIds)||runIds.length<2||!Array.isArray(snapshotIds)||snapshotIds.length<2)throw new Error('Phase 2 freeze requires both independent NVDB and OSM discovery runs/snapshots');
  const providers=new Set();for(const id of runIds){if(!safeId(id))throw new Error('Phase 2 run ID is unsafe');
    const run=db.prepare('SELECT run_id,status,reference_run_id,snapshot_id,edges_examined,discovery_source_id FROM discovery_runs WHERE run_id=?').get(id);
    if(!run||run.status!=='COMPLETE'||run.reference_run_id!==null)throw new Error('Phase 2 freeze requires every independent discovery run COMPLETE and reference-free');
    const snapshot=db.prepare('SELECT checksum FROM network_snapshots WHERE snapshot_id=?').get(run.snapshot_id);
    if(!snapshot||!snapshotIds.includes(run.snapshot_id))throw new Error('Phase 2 discovery run uses an unlisted network snapshot');
    const discovery=db.prepare('SELECT current_json FROM source_registry WHERE source_id=?').get(run.discovery_source_id);
    if(!discovery)throw new Error('Phase 2 discovery adapter is missing');const definition=JSON.parse(discovery.current_json);
    if(definition.parent_network_source_id==null||definition.bound_snapshot_id!==run.snapshot_id||definition.roles?.legal_access===true)throw new Error('Phase 2 discovery source binding or evidence role is invalid');
    const network=db.prepare('SELECT r.current_json FROM source_registry r JOIN network_snapshots s USING(source_id) WHERE s.snapshot_id=?').get(run.snapshot_id);const networkDefinition=JSON.parse(network.current_json);
    providers.add(networkDefinition.network_api?.provider==='statens-vegvesen-nvdb-api-les-v4'?'NVDB':networkDefinition.network_extract?.provider==='geofabrik'&&networkDefinition.network_extract?.country_code==='NO'?'OSM':'OTHER');
    const edges=Number(db.prepare('SELECT count(*) n FROM network_edges WHERE snapshot_id=?').get(run.snapshot_id).n);
    if(run.edges_examined!==edges)throw new Error('Phase 2 discovery did not examine the full registered snapshot');
  }
  if(providers.size!==2||providers.has('OTHER'))throw new Error('Phase 2 must have exactly one completed NVDB and one completed OSM independent discovery run');
  const n=db.prepare('SELECT count(*) n FROM network_snapshots WHERE snapshot_id IN ('+snapshotIds.map(()=>'?').join(',')+')').get(...snapshotIds).n;
  if(n!==snapshotIds.length)throw new Error('Phase 2 snapshot list is incomplete or duplicated');
  const nvdb=db.prepare("SELECT s.snapshot_id,s.checksum FROM network_snapshots s JOIN source_registry r USING(source_id) WHERE s.snapshot_id IN ("+snapshotIds.map(()=>'?').join(',')+") AND json_extract(r.current_json,'$.network_api.provider')='statens-vegvesen-nvdb-api-les-v4'").all(...snapshotIds);
  if(nvdb.length!==1||nvdb[0].checksum!==nvdbChecksum||nvdbChecksum!==NORWAY_PHASE1_BASELINE.nvdb_checksum)throw new Error('Phase 2 NVDB snapshot differs from the immutable approved Phase 1 baseline');
  const osm=db.prepare("SELECT s.snapshot_id,s.checksum FROM network_snapshots s JOIN source_registry r USING(source_id) WHERE s.snapshot_id IN ("+snapshotIds.map(()=>'?').join(',')+") AND json_extract(r.current_json,'$.network_extract.provider')='geofabrik' AND json_extract(r.current_json,'$.network_extract.country_code')='NO'").all(...snapshotIds);
  if(osm.length!==1||osm[0].checksum!==osmChecksum)throw new Error('Phase 2 OSM snapshot is not the one checksum-pinned Norway Geofabrik extract');
  if(db.prepare('SELECT status FROM phase2_stage_state WHERE stage=?').get('NVDB_SEQUENCE_CORRIDORS')?.status!=='COMPLETE'||db.prepare('SELECT status FROM phase2_stage_state WHERE stage=?').get('NVDB_OSM_CORRIDOR_RECONCILIATION')?.status!=='COMPLETE')throw new Error('Phase 2 freeze requires completed NVDB corridor construction and NVDB/OSM reconciliation');
  const osmRun=runIds.map(id=>db.prepare('SELECT run_id,snapshot_id FROM discovery_runs WHERE run_id=?').get(id)).find(row=>row&&osm.some(x=>x.snapshot_id===row.snapshot_id));
  if(!osmRun||db.prepare('SELECT status FROM osm_topology_stage_state WHERE snapshot_id=? AND run_id=? AND stage=?').get(osmRun.snapshot_id,osmRun.run_id,'CORRIDOR_REVIEW_TRIAGE')?.status!=='COMPLETE')throw new Error('Phase 2 freeze requires completed OSM corridor topology construction');
  const sourceFiles=db.prepare('SELECT count(*) n FROM source_files').get().n;
  const routeObservations=db.prepare('SELECT count(*) n FROM route_observations').get().n;
  if(sourceFiles!==0||routeObservations!==0)throw new Error('Phase 2 state must contain no route benchmark/source files before freeze');
  const forbiddenSource=db.prepare(`SELECT count(*) n FROM source_registry WHERE lower(current_json) LIKE '%tet%' OR json_extract(current_json,'$.type')='route-file'`).get().n;
  if(forbiddenSource!==0)throw new Error('Phase 2 independent database contains a TET or route-file source registration');
  return {run_ids:[...runIds],snapshot_ids:[...snapshotIds],network_edge_counts:Object.fromEntries(snapshotIds.map(id=>[id,Number(db.prepare('SELECT count(*) n FROM network_edges WHERE snapshot_id=?').get(id).n)])),snapshot_checksums:{nvdb:nvdb[0].checksum,osm:osm[0].checksum}};
}

/** Freeze only after callers have closed all writers and completed all network/corridor stages. */
export async function freezeNorwayPhase2({root,databaseFile=path.join(root,'scout.sqlite'),runIds,snapshotIds,nvdbChecksum,osmChecksum,codeCommit,productProjection,completedStages,shouldYield=()=>false}={}){
  const base=path.resolve(root),dbPath=path.resolve(databaseFile);if(!dbPath.startsWith(base+path.sep)||!safeId(path.basename(base)))throw new Error('Phase 2 freeze paths must stay inside the private run root');
  if(fs.existsSync(path.join(base,'phase2-frozen.json')))throw new Error('Phase 2 freeze manifest already exists; frozen results cannot be overwritten');
  if(!/^[a-f0-9]{40}$/i.test(codeCommit??'')||!Array.isArray(completedStages)||!completedStages.includes('NVDB_IMPORT')||!completedStages.includes('OSM_IMPORT')||!completedStages.includes('NVDB_DISCOVERY')||!completedStages.includes('OSM_DISCOVERY')||!completedStages.includes('CROSS_SOURCE_RECONCILIATION'))throw new Error('Phase 2 cannot freeze until all required independent stages are completed and the code commit is pinned');
  if(!/^[a-f0-9]{64}$/i.test(osmChecksum??''))throw new Error('Phase 2 freeze needs the verified OSM snapshot checksum');
  const db=new DatabaseSync(dbPath);let validated;
  try{validated=validateNorwayPhase2State(db,{runIds,snapshotIds,nvdbChecksum,osmChecksum});db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');}
  finally{db.close();}
  const databaseChecksum=await shaFile(dbPath,shouldYield),manifest={schema:1,phase:'NORWAY_PHASE2_FROZEN',frozen_at:new Date().toISOString(),code_commit:codeCommit.toLowerCase(),database:{path:path.basename(dbPath),sha256:databaseChecksum,bytes:fs.statSync(dbPath).size},snapshots:{nvdb:{snapshot_id:snapshotIds.find(id=>id.startsWith('no-nvdb')),sha256:nvdbChecksum},osm:{snapshot_id:snapshotIds.find(id=>id.startsWith('geofabrik-no')),sha256:osmChecksum}},...validated,completed_stages:[...completedStages],product_projection:productProjection??null,tet_accessed_before_freeze:false,canonical_modified:false,public_artifacts_modified:false};
  const target=path.join(base,'phase2-frozen.json'),temp=`${target}.${process.pid}.tmp`,fd=fs.openSync(temp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,`${JSON.stringify(manifest,null,2)}\n`);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,target);fs.chmodSync(target,0o600);return manifest;
}

export async function verifyNorwayPhase2Freeze({root,databaseFile=path.join(root,'scout.sqlite'),shouldYield=()=>false}={}){
  const base=path.resolve(root),marker=path.join(base,'phase2-frozen.json');if(!fs.existsSync(marker)||fs.lstatSync(marker).isSymbolicLink())throw new Error('TET benchmark is blocked until the independent Norway Phase 2 freeze exists');
  const manifest=JSON.parse(fs.readFileSync(marker,'utf8')),dbPath=path.resolve(databaseFile);
  if(manifest.phase!=='NORWAY_PHASE2_FROZEN'||manifest.tet_accessed_before_freeze!==false||path.resolve(base,manifest.database.path)!==dbPath)throw new Error('Norway Phase 2 freeze manifest is invalid');
  if(await shaFile(dbPath,shouldYield)!==manifest.database.sha256)throw new Error('frozen Phase 2 database changed after freeze');
  return manifest;
}

/** Out-of-core, resumable grouping of the raw NVDB observations by explicit source sequence. */
export async function buildNorwayNvdbCorridors(store,{snapshotId='no-nvdb-phase1-20261006',batchSequences=20,shouldYield=()=>false,onProgress=()=>{},expectedChecksum=NORWAY_PHASE1_BASELINE.nvdb_checksum}={}){
  const snapshot=store.getNetworkSnapshot(snapshotId);if(snapshot?.checksum!==expectedChecksum||store.getSource(snapshot.source_id)?.network_api?.provider!=='statens-vegvesen-nvdb-api-les-v4')throw new Error('Norway topology grouping requires the pinned NVDB source snapshot');
  if(!Number.isInteger(batchSequences)||batchSequences<1||batchSequences>500)throw new Error('NVDB corridor grouping batch must be 1-500 sequences');
  store.db.exec(`CREATE TABLE IF NOT EXISTS phase2_stage_state(stage TEXT PRIMARY KEY,status TEXT NOT NULL,cursor TEXT,records_seen INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS phase2_network_corridors(corridor_id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL,source_id TEXT NOT NULL,source_identity TEXT NOT NULL,member_count INTEGER NOT NULL,identity_state TEXT NOT NULL,physical_character TEXT NOT NULL,network_role TEXT NOT NULL,geometry_json TEXT NOT NULL,attributes_json TEXT NOT NULL,edge_ids_json TEXT NOT NULL,evidence_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS phase2_network_corridor_snapshot_idx ON phase2_network_corridors(snapshot_id,identity_state,network_role);
    CREATE TABLE IF NOT EXISTS phase2_network_corridor_members(corridor_id TEXT NOT NULL,edge_id TEXT NOT NULL,PRIMARY KEY(corridor_id,edge_id));
    CREATE INDEX IF NOT EXISTS phase2_network_corridor_member_edge_idx ON phase2_network_corridor_members(edge_id,corridor_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS phase2_network_corridors_rtree USING rtree(corridor_rowid,min_lon,max_lon,min_lat,max_lat);
    CREATE TABLE IF NOT EXISTS phase2_cross_source_support(osm_corridor_version_id TEXT NOT NULL,nvdb_corridor_id TEXT NOT NULL,relationship TEXT NOT NULL,evidence_json TEXT NOT NULL,PRIMARY KEY(osm_corridor_version_id,nvdb_corridor_id));
    CREATE INDEX IF NOT EXISTS phase2_cross_source_relationship_idx ON phase2_cross_source_support(relationship);
    CREATE INDEX IF NOT EXISTS phase2_nvdb_sequence_order_idx ON network_edges(snapshot_id,json_extract(evidence_json,'$[0].topology.sequence_id'),json_extract(evidence_json,'$[0].topology.start_position'),edge_id);`);
  const stage='NVDB_SEQUENCE_CORRIDORS',prior=store.db.prepare('SELECT * FROM phase2_stage_state WHERE stage=?').get(stage);
  if(prior?.status==='COMPLETE')return phase2NvdbCorridorStats(store,snapshotId,'REUSED');
  let cursor=prior?.cursor??null,records=Number(prior?.records_seen??0);
  const putStage=store.db.prepare(`INSERT INTO phase2_stage_state(stage,status,cursor,records_seen,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(stage) DO UPDATE SET status=excluded.status,cursor=excluded.cursor,records_seen=excluded.records_seen,updated_at=excluded.updated_at`);
  const firstSeqs=store.db.prepare(`SELECT DISTINCT json_extract(evidence_json,'$[0].topology.sequence_id') sequence_id FROM network_edges WHERE snapshot_id=? AND json_extract(evidence_json,'$[0].topology.sequence_id') IS NOT NULL ORDER BY sequence_id LIMIT ?`),
    nextSeqs=store.db.prepare(`SELECT DISTINCT json_extract(evidence_json,'$[0].topology.sequence_id') sequence_id FROM network_edges WHERE snapshot_id=? AND json_extract(evidence_json,'$[0].topology.sequence_id') IS NOT NULL AND json_extract(evidence_json,'$[0].topology.sequence_id')>? ORDER BY sequence_id LIMIT ?`);
  const links=store.db.prepare(`SELECT edge_id,geometry_json,tags_json,evidence_json FROM network_edges WHERE snapshot_id=? AND json_extract(evidence_json,'$[0].topology.sequence_id')=? ORDER BY json_extract(evidence_json,'$[0].topology.start_position'),edge_id`);
  const save=store.db.prepare(`INSERT OR IGNORE INTO phase2_network_corridors(corridor_id,snapshot_id,source_id,source_identity,member_count,identity_state,physical_character,network_role,geometry_json,attributes_json,edge_ids_json,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`),
    saveMember=store.db.prepare('INSERT OR IGNORE INTO phase2_network_corridor_members(corridor_id,edge_id) VALUES(?,?)'),
    rowId=store.db.prepare('SELECT rowid FROM phase2_network_corridors WHERE corridor_id=?'),
    saveBox=store.db.prepare('INSERT OR IGNORE INTO phase2_network_corridors_rtree(corridor_rowid,min_lon,max_lon,min_lat,max_lat) VALUES(?,?,?,?,?)');
  for(;;){
    if(shouldYield()){putStage.run(stage,'BLOCKED',cursor,records,new Date().toISOString());return {...phase2NvdbCorridorStats(store,snapshotId,'BLOCKED'),cursor,resumable:true};}
    const batchStarted=process.hrtime.bigint();let sequencePageMs=0,sourceRowsMs=0,parseMs=0,deriveAndWriteMs=0,commitMs=0;
    const pageStarted=process.hrtime.bigint(),batch=cursor===null?firstSeqs.all(snapshotId,batchSequences):nextSeqs.all(snapshotId,cursor,batchSequences);sequencePageMs=Number(process.hrtime.bigint()-pageStarted)/1e6;if(!batch.length)break;
    let batchCursor=cursor,batchRecords=records;store.db.exec('BEGIN IMMEDIATE');try{
      for(const sequence of batch){const readStarted=process.hrtime.bigint(),sourceRows=links.all(snapshotId,sequence.sequence_id),readDone=process.hrtime.bigint();
        const parseStarted=process.hrtime.bigint(),rows=sourceRows.map(row=>({edge_id:row.edge_id,geometry:JSON.parse(row.geometry_json),tags:JSON.parse(row.tags_json),evidence:JSON.parse(row.evidence_json)}));sourceRowsMs+=Number(readDone-readStarted)/1e6;parseMs+=Number(process.hrtime.bigint()-parseStarted)/1e6;
        const deriveStarted=process.hrtime.bigint();
        const groups=buildNvdbSequenceCorridors(rows),rowsById=new Map(rows.map(row=>[row.edge_id,row]));for(const group of groups){const members=group.member_edge_ids.map(id=>rowsById.get(id));if(members.some(row=>!row))throw new Error('NVDB corridor references a missing source link');const physical=new Set(members.map(row=>classifyPhysicalRoad(row.tags,'NVDB').physical_character));
          const physicalCharacter=physical.size===1?[...physical][0]:'MIXED_PHYSICAL_CHARACTER',networkRole=members.every(row=>classifyPhysicalRoad(row.tags,'NVDB').ordinary_navigation)?'ORDINARY_ROAD':'POTENTIAL_SPECIAL_ROUTE';
          const attributes={name:[...new Set(members.map(row=>row.tags['nvdb:road_name']).filter(Boolean))],ref:[...new Set(members.map(row=>row.tags['nvdb:road_reference']??row.tags['nvdb:vegnummer']).filter(Boolean))],type_veg:[...new Set(members.map(row=>row.tags['nvdb:type_veg']).filter(Boolean))]};
          save.run(group.corridor_id,snapshotId,'no-nvdb-vegkart',group.source_sequence_id,group.member_edge_ids.length,group.identity_state,physicalCharacter,networkRole,JSON.stringify(group.geometry),JSON.stringify(attributes),JSON.stringify(group.member_edge_ids),JSON.stringify(group.support));
          for(const edgeId of group.member_edge_ids)saveMember.run(group.corridor_id,edgeId);
          const rid=rowId.get(group.corridor_id).rowid;let west=180,east=-180,south=90,north=-90;for(const line of group.geometry.coordinates)for(const [lon,lat] of line){west=Math.min(west,lon);east=Math.max(east,lon);south=Math.min(south,lat);north=Math.max(north,lat);}if(west<=east&&south<=north)saveBox.run(rid,west,east,south,north);}
        deriveAndWriteMs+=Number(process.hrtime.bigint()-deriveStarted)/1e6;
        batchRecords+=rows.length;batchCursor=sequence.sequence_id;
        if(shouldYield())throw Object.assign(new Error('Norway NVDB corridor batch yielded safely'),{code:'SCOUT_YIELD_REQUESTED'});
      }
      putStage.run(stage,'RUNNING',batchCursor,batchRecords,new Date().toISOString());const commitStarted=process.hrtime.bigint();store.db.exec('COMMIT');commitMs=Number(process.hrtime.bigint()-commitStarted)/1e6;
    }catch(error){store.db.exec('ROLLBACK');if(error.code==='SCOUT_YIELD_REQUESTED'){putStage.run(stage,'BLOCKED',cursor,records,new Date().toISOString());return {...phase2NvdbCorridorStats(store,snapshotId,'BLOCKED'),cursor,resumable:true};}throw error;}
    const batchLinks=batchRecords-records;cursor=batchCursor;records=batchRecords;onProgress({sequence_id:cursor,links_processed:records,sequence_count:batch.length,batch_links:batchLinks,sequence_page_ms:sequencePageMs,source_rows_ms:sourceRowsMs,parse_ms:parseMs,derive_and_write_ms:deriveAndWriteMs,commit_ms:commitMs,batch_ms:Number(process.hrtime.bigint()-batchStarted)/1e6});
    // Node signal callbacks and resource monitors run on the event loop. Yield
    // after the atomic sequence batch so SIGINT/factory intent can be observed
    // without ever checkpointing a partial NVDB sequence.
    await new Promise(resolve=>setImmediate(resolve));
    if(shouldYield()){putStage.run(stage,'BLOCKED',cursor,records,new Date().toISOString());return {...phase2NvdbCorridorStats(store,snapshotId,'BLOCKED'),cursor,resumable:true};}
  }
  putStage.run(stage,'COMPLETE',cursor,records,new Date().toISOString());return phase2NvdbCorridorStats(store,snapshotId,'COMPLETE');
}
export function phase2NvdbCorridorStats(store,snapshotId='no-nvdb-phase1-20261006',status=null){
  const rows=store.db.prepare('SELECT identity_state,physical_character,network_role,count(*) corridors,sum(member_count) links FROM phase2_network_corridors WHERE snapshot_id=? GROUP BY identity_state,physical_character,network_role').all(snapshotId);
  return {snapshot_id:snapshotId,status:status??store.db.prepare('SELECT status FROM phase2_stage_state WHERE stage=?').get('NVDB_SEQUENCE_CORRIDORS')?.status??'NOT_STARTED',corridor_count:rows.reduce((n,x)=>n+x.corridors,0),link_count:rows.reduce((n,x)=>n+x.links,0),by_identity:Object.fromEntries(rows.reduce((m,x)=>(m.set(x.identity_state,(m.get(x.identity_state)??0)+x.corridors),m),new Map())),by_physical_and_role:rows.map(x=>({identity_state:x.identity_state,physical_character:x.physical_character,network_role:x.network_role,corridors:x.corridors,links:x.links}))};
}

/** Reconcile OSM lane-corridor hypotheses against topology-built NVDB corridors. */
export function reconcileNorwayCorridors(store,{osmRunId,nvdbSnapshotId='no-nvdb-phase1-20261006',shouldYield=()=>false,batchSize=100,onProgress=()=>{}}={}){
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>1000)throw new Error('Norway cross-source batch size must be 1-1000 corridors');
  const osmRun=store.getDiscoveryRun(osmRunId);if(!osmRun||osmRun.status!=='COMPLETE'||osmRun.reference_run_id!==null)throw new Error('Norway reconciliation requires a complete independent OSM discovery pass');
  if(store.db.prepare('SELECT status FROM osm_topology_stage_state WHERE snapshot_id=? AND run_id=? AND stage=?').get(osmRun.snapshot_id,osmRunId,'CORRIDOR_REVIEW_TRIAGE')?.status!=='COMPLETE')throw new Error('Norway reconciliation requires OSM candidate corridor topology to be complete');
  if(store.db.prepare('SELECT status FROM phase2_stage_state WHERE stage=?').get('NVDB_SEQUENCE_CORRIDORS')?.status!=='COMPLETE')throw new Error('Norway reconciliation requires topology-built NVDB sequence corridors');
  const nvdb=store.getNetworkSnapshot(nvdbSnapshotId),osm=store.getNetworkSnapshot(osmRun.snapshot_id);if(nvdb?.checksum!==NORWAY_PHASE1_BASELINE.nvdb_checksum||!osm?.checksum)throw new Error('Norway reconciliation source snapshots are not checksum-pinned');
  const stage='NVDB_OSM_CORRIDOR_RECONCILIATION',prior=store.db.prepare('SELECT * FROM phase2_stage_state WHERE stage=?').get(stage);if(prior?.status==='COMPLETE')return norwayReconciliationStats(store,osmRunId,'REUSED');
  let cursor=prior?.cursor??'';const checkpoint=store.db.prepare(`INSERT INTO phase2_stage_state(stage,status,cursor,records_seen,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(stage) DO UPDATE SET status=excluded.status,cursor=excluded.cursor,records_seen=excluded.records_seen,updated_at=excluded.updated_at`);
  const corridors=store.db.prepare(`SELECT corridor_version_id,corridor_id,geometry_json FROM physical_corridor_versions WHERE run_id=? AND corridor_version_id>? ORDER BY corridor_version_id LIMIT ?`),
    observations=store.db.prepare(`SELECT d.tags_json FROM physical_corridor_observations o JOIN discovery_candidates d USING(candidate_id) WHERE o.corridor_version_id=?`),
    candidates=store.db.prepare(`SELECT c.corridor_id,c.source_identity,c.geometry_json,c.attributes_json,c.evidence_json FROM phase2_network_corridors_rtree r JOIN phase2_network_corridors c ON c.rowid=r.corridor_rowid WHERE c.snapshot_id=? AND r.min_lon<=? AND r.max_lon>=? AND r.min_lat<=? AND r.max_lat>=?`),
    upsert=store.db.prepare(`INSERT OR IGNORE INTO phase2_cross_source_support(osm_corridor_version_id,nvdb_corridor_id,relationship,evidence_json) VALUES(?,?,?,?)`);
  const osmFeatureCount=Number(store.db.prepare('SELECT count(*) n FROM physical_corridor_versions WHERE run_id=?').get(osmRunId).n),nvdbSource=store.getSource(nvdb.source_id),osmSource=store.getSource(osm.source_id);let processed=Number(prior?.records_seen??0);
  while(true){if(shouldYield()){checkpoint.run(stage,'BLOCKED',cursor,processed,new Date().toISOString());return {...norwayReconciliationStats(store,osmRunId,'BLOCKED'),resumable:true};}
    const batch=corridors.all(osmRunId,cursor,batchSize);if(!batch.length)break;
    store.db.exec('BEGIN IMMEDIATE');try{for(const corridor of batch){
      const geometry=JSON.parse(corridor.geometry_json),box=lineParts(geometry).flat().reduce((b,p)=>({west:Math.min(b.west,p[0]),east:Math.max(b.east,p[0]),south:Math.min(b.south,p[1]),north:Math.max(b.north,p[1])}),{west:180,east:-180,south:90,north:-90});
      const latPad=30/110574,lonPad=30/(111320*Math.max(.1,Math.cos((box.south+box.north)*Math.PI/360))),near=candidates.all(nvdbSnapshotId,box.east+lonPad,box.west-lonPad,box.north+latPad,box.south-latPad);
      const osmTags=observations.all(corridor.corridor_version_id).map(row=>JSON.parse(row.tags_json)),attributes={ref:[...new Set(osmTags.map(t=>t.ref).filter(Boolean))].join('|'),name:[...new Set(osmTags.map(t=>t.name).filter(Boolean))].join('|')};
      const featureList=near.map(row=>({source_feature_id:row.corridor_id,geometry:JSON.parse(row.geometry_json),attributes:{...JSON.parse(row.attributes_json),source_sequence_id:row.source_identity}}));
      const mapped=featureList.map(feature=>{const match=compareSpwCorridor({geometry,attributes},{...feature},{competitors:featureList});const relationship=({EXACT:'EXACT_CORRIDOR_SUPPORT',LIKELY:'STRONG_CORRIDOR_SUPPORT',PARTIAL:'PARTIAL_CORRIDOR_SUPPORT',PARALLEL:'POSSIBLE_PARALLEL',AMBIGUOUS:'AMBIGUOUS_IDENTITY',NO_MATCH:'NO_RELATION'})[match.relationship];return {feature,relationship,match};});
      for(const item of mapped)upsert.run(corridor.corridor_version_id,item.feature.source_feature_id,item.relationship,JSON.stringify({matcher:'spw-shared-cross-network-geometry-v1',relationship:item.relationship,geometry_match:item.match,
        osm:{source_id:osmSource.source_id,snapshot_id:osm.snapshot_id,sha256:osm.checksum,source_corridor_version_id:corridor.corridor_version_id},
        nvdb:{source_id:nvdbSource.source_id,snapshot_id:nvdb.snapshot_id,sha256:nvdb.checksum,sequence_id:item.feature.attributes.source_sequence_id??null},
        motorcycle_access_effect:'NONE',routability_effect:'NONE',proximity_only_identity:false}));
      cursor=corridor.corridor_version_id;processed++;
    }checkpoint.run(stage,'RUNNING',cursor,processed,new Date().toISOString());store.db.exec('COMMIT');}catch(error){store.db.exec('ROLLBACK');throw error;}
    onProgress({processed,total:osmFeatureCount,cursor,cross_source_match_count:store.db.prepare('SELECT count(*) n FROM phase2_cross_source_support').get().n});
  }
  checkpoint.run(stage,'COMPLETE',cursor,processed,new Date().toISOString());return norwayReconciliationStats(store,osmRunId,'COMPLETE');
}
export function norwayReconciliationStats(store,osmRunId,status=null){
  const total=Number(store.db.prepare('SELECT count(*) n FROM physical_corridor_versions WHERE run_id=?').get(osmRunId).n),rows=store.db.prepare(`SELECT relationship,count(DISTINCT osm_corridor_version_id) corridors,count(*) relations FROM phase2_cross_source_support WHERE osm_corridor_version_id IN (SELECT corridor_version_id FROM physical_corridor_versions WHERE run_id=?) GROUP BY relationship`).all(osmRunId),
    related=Number(store.db.prepare(`SELECT count(DISTINCT osm_corridor_version_id) n FROM phase2_cross_source_support WHERE relationship NOT IN ('NO_RELATION') AND osm_corridor_version_id IN (SELECT corridor_version_id FROM physical_corridor_versions WHERE run_id=?)`).get(osmRunId).n);
  return {osm_run_id:osmRunId,status:status??store.db.prepare('SELECT status FROM phase2_stage_state WHERE stage=?').get('NVDB_OSM_CORRIDOR_RECONCILIATION')?.status??'NOT_STARTED',osm_candidate_corridors:total,osm_corridors_with_nvdb_support:related,osm_corridors_without_nvdb_support:total-related,by_relationship:Object.fromEntries(rows.map(r=>[r.relationship,{corridors:Number(r.corridors),relations:Number(r.relations)}]))};
}

const lineParts=geometry=>geometry.type==='LineString'?[geometry.coordinates]:geometry.type==='MultiLineString'?geometry.coordinates:[];
function sampleLine(line,step=20){const lengths=line.slice(1).map((p,i)=>lengthMeters(line[i],p)),total=lengths.reduce((a,b)=>a+b,0),count=Math.max(1,Math.ceil(total/step)),out=[];let seg=0,offset=0;
  for(let i=0;i<count;i++){const d=Math.min(total,(i+.5)*total/count);while(seg<lengths.length-1&&offset+lengths[seg]<d)offset+=lengths[seg++];const f=lengths[seg]?Math.max(0,Math.min(1,(d-offset)/lengths[seg])):0,a=line[seg],b=line[seg+1];out.push({point:[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f],bearing:Math.atan2((b[0]-a[0])*Math.cos(a[1]*Math.PI/180),b[1]-a[1]),weight_m:total/count});}
  return {length_m:total,samples:out};}
function distancePointSegment(point,a,b){const lat=point[1]*Math.PI/180,scaleX=111320*Math.cos(lat),scaleY=110574,ax=(a[0]-point[0])*scaleX,ay=(a[1]-point[1])*scaleY,bx=(b[0]-point[0])*scaleX,by=(b[1]-point[1])*scaleY,dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));return Math.hypot(ax+t*dx,ay+t*dy);}
function edgeProjection(point,geometry){const lat=point[1]*Math.PI/180,sx=111320*Math.cos(lat),sy=110574;let best={distance:Infinity,foot:null};
  for(const line of lineParts(geometry))for(let i=1;i<line.length;i++){const a=line[i-1],b=line[i],ax=(a[0]-point[0])*sx,ay=(a[1]-point[1])*sy,bx=(b[0]-point[0])*sx,by=(b[1]-point[1])*sy,dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1))),x=ax+t*dx,y=ay+t*dy,distance=Math.hypot(x,y);if(distance<best.distance)best={distance,foot:[x,y]};}
  return best;}
const angleDifference=(a,b)=>{let n=Math.abs(a-b)*180/Math.PI;n%=180;return Math.min(n,180-n);};
export function scoreNorwayRouteFeature(featureGeometry,networkEdges,{maxDistanceM=12,shouldYield=()=>false}={}){
  const samples=lineParts(featureGeometry).flatMap(line=>sampleLine(line).samples),unambiguousCharacterKm={},ambiguousCharacterKm={},distances={supported_m:0,ambiguous_m:0,unresolved_m:0};let ambiguous=0,totalLength=samples.reduce((n,s)=>n+s.weight_m,0);
  for(const sample of samples){if(shouldYield()){const error=new Error('factory/resource governor requested a safe Norway benchmark yield');error.code='SCOUT_YIELD_REQUESTED';throw error;}const hits=[],edges=typeof networkEdges==='function'?networkEdges(sample.point,maxDistanceM):networkEdges;for(const edge of edges){const projection=edgeProjection(sample.point,edge.geometry);if(projection.distance<=maxDistanceM)hits.push({edge,d:projection.distance,foot:projection.foot,physical:classifyPhysicalRoad(edge.tags??{},edge.source??'OSM')});}
    hits.sort((a,b)=>a.d-b.d);if(!hits.length){distances.unresolved_m+=sample.weight_m;continue;}
    // Every direction-compatible edge inside the measurement search envelope
    // competes for identity. Choosing only the nearest one could alias a
    // parallel road/track by a few metres and falsely resolve the benchmark.
    const aligned=hits.filter(hit=>{
      for(const line of lineParts(hit.edge.geometry))for(let i=1;i<line.length;i++){const a=line[i-1],b=line[i],bearing=Math.atan2((b[0]-a[0])*Math.cos(sample.point[1]*Math.PI/180),b[1]-a[1]);if(angleDifference(sample.bearing,bearing)<=25&&distancePointSegment(sample.point,a,b)<=maxDistanceM)return true;}return false;});
    if(!aligned.length){distances.unresolved_m+=sample.weight_m;continue;}
    const selected=aligned,isGeometricallyCompeting=selected.some((hit,i)=>selected.slice(i+1).some(other=>Math.hypot(hit.foot[0]-other.foot[0],hit.foot[1]-other.foot[1])>1.5));
    if(isGeometricallyCompeting){ambiguous++;distances.ambiguous_m+=sample.weight_m;}else distances.supported_m+=sample.weight_m;
    const known=[...new Set(selected.map(x=>x.physical.physical_character).filter(x=>x!=='ENGINEERED_ROAD_UNKNOWN_SURFACE'))];
    const contribution=known.length>1?'PHYSICAL_CLASS_CONFLICT':known[0]??selected[0].physical.physical_character,characters=isGeometricallyCompeting?ambiguousCharacterKm:unambiguousCharacterKm;characters[contribution]=(characters[contribution]??0)+sample.weight_m/1000;
  }
  const total=samples.length,coverage=totalLength?distances.supported_m/totalLength:0;
  return {sample_count:total,total_length_km:Number((totalLength/1000).toFixed(3)),reconstructed_km:Number((distances.supported_m/1000).toFixed(3)),ambiguous_km:Number((distances.ambiguous_m/1000).toFixed(3)),unresolved_km:Number((distances.unresolved_m/1000).toFixed(3)),
    unambiguous_km:Number((distances.supported_m/1000).toFixed(3)),ambiguous_sample_count:ambiguous,coverage,
    identity:coverage>=.98&&!ambiguous?'EXACT_IDENTITY':coverage>=.2?'PARTIAL_IDENTITY':distances.ambiguous_m>0?'AMBIGUOUS_IDENTITY':'NO_CORRIDOR_SUPPORT',
    physical_character_km:Object.fromEntries(Object.entries(unambiguousCharacterKm).map(([key,value])=>[key,Number(value.toFixed(3))])),
    ambiguous_physical_character_km:Object.fromEntries(Object.entries(ambiguousCharacterKm).map(([key,value])=>[key,Number(value.toFixed(3))])),
    legal_access:'UNKNOWN',routability:'UNKNOWN',source_geometry_modified:false};
}
export function summarizeNorwayBenchmarkFeatures(features){
  const total=features.reduce((n,f)=>n+f.result.total_length_km,0),reconstructed=features.reduce((n,f)=>n+f.result.reconstructed_km,0),ambiguous=features.reduce((n,f)=>n+f.result.ambiguous_km,0);
  const sum=field=>Object.fromEntries(Object.entries(features.flatMap(f=>Object.entries(f.result[field]??{})).reduce((o,[k,v])=>(o[k]=(o[k]??0)+v,o),{})).map(([k,v])=>[k,Number(v.toFixed(3))]));
  return {total_tet_km:Number(total.toFixed(3)),reconstructed_km:Number(reconstructed.toFixed(3)),ambiguous_km:Number(ambiguous.toFixed(3)),
    unresolved_km:Number(Math.max(0,total-reconstructed-ambiguous).toFixed(3)),independent_network_reconstruction_percent:total?Number((reconstructed/total*100).toFixed(2)):null,
    physical_character_km:sum('physical_character_km'),ambiguous_physical_character_km:sum('ambiguous_physical_character_km')};
}

/** TET bytes are first touched here, after independent store freeze verifies. */
export async function benchmarkFrozenNorwayAgainstTet({root,databaseFile=path.join(root,'scout.sqlite'),tetFile,maxDistanceM=12,shouldYield=()=>false,priorFeatures=[],onStart=()=>{},onFeature=()=>{}}={}){
  const manifest=await verifyNorwayPhase2Freeze({root,databaseFile,shouldYield});
  if(!tetFile||fs.lstatSync(tetFile).isSymbolicLink()||!fs.statSync(tetFile).isFile())throw new Error('post-freeze benchmark requires the one explicitly approved regular TET benchmark file');
  const tetBytes=fs.readFileSync(tetFile),tetSha256=crypto.createHash('sha256').update(tetBytes).digest('hex'),parsed=parseRouteFile('gpx',tetBytes.toString('utf8'));onStart({tet_sha256:tetSha256,feature_count:parsed.parts.length,phase2_database_sha256:manifest.database.sha256});
  const db=new DatabaseSync(databaseFile,{readOnly:true}),cache=new Map(),query=db.prepare(`SELECT e.edge_id,e.geometry_json,e.tags_json,e.snapshot_id
    FROM network_edges_rtree r JOIN network_edges e USING(edge_rowid)
    WHERE e.snapshot_id IN (?,?) AND r.min_lon<=? AND r.max_lon>=? AND r.min_lat<=? AND r.max_lat>=?`);
  const lookup=(point,radius)=>{const latPad=radius/110574,lonPad=radius/(111320*Math.max(.1,Math.cos(point[1]*Math.PI/180))),rows=query.all(manifest.snapshots.nvdb.snapshot_id,manifest.snapshots.osm.snapshot_id,
      point[0]+lonPad,point[0]-lonPad,point[1]+latPad,point[1]-latPad),out=[];
    for(const row of rows){let edge=cache.get(row.edge_id);if(!edge){edge={edge_id:row.edge_id,source:row.snapshot_id===manifest.snapshots.nvdb.snapshot_id?'NVDB':'OSM',geometry:JSON.parse(row.geometry_json),tags:JSON.parse(row.tags_json)};
        cache.set(row.edge_id,edge);if(cache.size>25000)cache.delete(cache.keys().next().value);}out.push(edge);}return out;};
  let features=priorFeatures.slice(),completed=new Set(features.map(row=>row.index));
  try{for(let index=0;index<parsed.parts.length;index++){
      if(completed.has(index+1))continue;if(shouldYield())return {status:'BLOCKED',phase:'NORWAY_PHASE2_POST_FREEZE_BENCHMARK',features_completed:features.length,feature_count:parsed.parts.length,resumable:true,tet_sha256:tetSha256};
      try{const result=scoreNorwayRouteFeature(parsed.parts[index].geometry,lookup,{maxDistanceM,shouldYield});const row={index:index+1,result};features.push(row);completed.add(index+1);onFeature(row,{tet_sha256:tetSha256,feature_count:parsed.parts.length,phase2_database_sha256:manifest.database.sha256});}
      catch(error){if(error.code==='SCOUT_YIELD_REQUESTED')return {status:'BLOCKED',phase:'NORWAY_PHASE2_POST_FREEZE_BENCHMARK',features_completed:features.length,feature_count:parsed.parts.length,resumable:true,tet_sha256:tetSha256};throw error;}
    }}finally{db.close();}
  const lengthWeighted=summarizeNorwayBenchmarkFeatures(features);
  return {status:'COMPLETE',report_version:1,phase:'NORWAY_PHASE2_POST_FREEZE_BENCHMARK',created_at:new Date().toISOString(),phase2_freeze:{frozen_at:manifest.frozen_at,code_commit:manifest.code_commit,database_sha256:manifest.database.sha256,nvdb_sha256:manifest.snapshots.nvdb.sha256,osm_sha256:manifest.snapshots.osm.sha256},comparison_corpus:{role:'PRIVATE_BENCHMARK_ONLY',sha256:tetSha256,feature_count:features.length,source_filename:path.basename(tetFile)},feature_count:features.length,features,
    identity_counts:{exact:features.filter(x=>x.result.identity==='EXACT_IDENTITY').length,partial:features.filter(x=>x.result.identity==='PARTIAL_IDENTITY').length,ambiguous:features.filter(x=>x.result.identity==='AMBIGUOUS_IDENTITY'||x.result.identity==='AMBIGUOUS_SUPPORT').length,none:features.filter(x=>x.result.identity==='NO_CORRIDOR_SUPPORT').length},
    length_weighted:lengthWeighted,
    legal_state:{green:0,orange:'NOT DERIVED FROM TET; requires independent suitable jurisdiction evidence',red:0,temporarily_closed:0},tet_used_for_discovery:false,tet_used_for_classification:false,canonical_modified:false,public_artifacts_modified:false};
}
