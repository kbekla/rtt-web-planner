import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { buildTopologyCorridors, inferCorridorLineage } from './corridor-evidence.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function parseOsmiumOplWay(line) {
  if (typeof line !== 'string' || !line.startsWith('w')) return null;
  const head = /^w([1-9]\d*)\s+v(\d+)/.exec(line), nodeMarker = line.lastIndexOf(' N');
  if (!head || nodeMarker < 0) return null;
  const raw = line.slice(nodeMarker + 2).trim();
  if (!raw) return { way_id: `osm:way:${head[1]}`, osm_version: Number(head[2]), node_refs: [], complete: false };
  const refs = raw.split(',').map(ref => /^n([1-9]\d*)$/.exec(ref)?.[1] ?? null);
  return { way_id: `osm:way:${head[1]}`, osm_version: Number(head[2]), node_refs: refs.filter(Boolean), complete: refs.every(Boolean) && refs.length >= 2 };
}

function stageRow(db, snapshotId, runId, stage) {
  return db.prepare('SELECT status,records_seen FROM osm_topology_stage_state WHERE snapshot_id=? AND run_id=? AND stage=?').get(snapshotId, runId, stage);
}
function setStage(db, snapshotId, runId, stage, status, recordsSeen) {
  db.prepare(`INSERT INTO osm_topology_stage_state(snapshot_id,run_id,stage,status,records_seen,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(snapshot_id,run_id,stage) DO UPDATE SET status=excluded.status,records_seen=excluded.records_seen,updated_at=excluded.updated_at`)
    .run(snapshotId, runId, stage, status, recordsSeen, new Date().toISOString());
}
/** Keep blind first-run lineage bounded: without a prior run there is nothing
 * to match, so avoid materializing all current node sequences in memory. */
export function inferRunCorridorLineage({ readPriorLineage, loadPrevious, loadCurrent }) {
  if (!readPriorLineage) return [];
  const previous = loadPrevious();
  if (!previous.length) return [];
  return inferCorridorLineage(previous, loadCurrent());
}
async function scanWays({ db, file, snapshotId, runId, stage, selectedWayIds = null, endpointIds = null, osmium, spawnImpl, shouldYield, batchSize }) {
  const prior = stageRow(db, snapshotId, runId, stage); if (prior?.status === 'COMPLETE') return { status: 'REUSED', records_seen: prior.records_seen };
  let cursor = prior?.records_seen ?? 0, scanned = 0, stopped = false, stderr = '';
  setStage(db, snapshotId, runId, stage, 'RUNNING', cursor);
  const child = spawnImpl(osmium, ['cat', '-f', 'opl', '-t', 'way', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const topologyInsert = db.prepare(`INSERT INTO osm_way_topology(snapshot_id,edge_id,osm_version,node_refs_json,topology_hash,status,updated_at)
    VALUES(?,?,?,?,?,'MATCHED',?) ON CONFLICT(snapshot_id,edge_id) DO UPDATE SET osm_version=excluded.osm_version,
    node_refs_json=excluded.node_refs_json,topology_hash=excluded.topology_hash,status=excluded.status,updated_at=excluded.updated_at`);
  const incidenceInsert = db.prepare(`INSERT INTO osm_topology_node_incidence(snapshot_id,run_id,way_id,node_id,degree) VALUES(?,?,?,?,?)
    ON CONFLICT(snapshot_id,run_id,way_id,node_id) DO UPDATE SET degree=excluded.degree`);
  let pending = [], checkpoint = db.prepare(`UPDATE osm_topology_stage_state SET records_seen=?,status=?,updated_at=? WHERE snapshot_id=? AND run_id=? AND stage=?`);
  for await (const line of reader) {
    if (!line.startsWith('w')) continue;
    scanned++;
    if (scanned <= cursor) continue;
    const way = parseOsmiumOplWay(line); if (!way) continue;
    if (selectedWayIds?.has(way.way_id) && way.complete) pending.push({ kind: 'topology', way });
    if (endpointIds && way.complete) {
      const contributions = new Map();
      for (let i = 0; i < way.node_refs.length; i++) {
        const nodeId = way.node_refs[i]; if (!endpointIds.has(nodeId)) continue;
        contributions.set(nodeId, (contributions.get(nodeId) ?? 0) + (i === 0 || i === way.node_refs.length - 1 ? 1 : 2));
      }
      for (const [nodeId, degree] of contributions) pending.push({ kind: 'incidence', way, nodeId, degree });
    }
    if (scanned % batchSize === 0) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of pending) if (row.kind === 'topology') topologyInsert.run(snapshotId, row.way.way_id, row.way.osm_version,
          JSON.stringify(row.way.node_refs), hash(row.way.node_refs.join(',')), new Date().toISOString());
        else incidenceInsert.run(snapshotId, runId, row.way.way_id, row.nodeId, row.degree);
        pending = []; cursor = scanned;
        checkpoint.run(cursor, 'RUNNING', new Date().toISOString(), snapshotId, runId, stage);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (shouldYield()) { stopped = true; child.kill('SIGTERM'); break; }
    }
  }
  if (!stopped && pending.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of pending) if (row.kind === 'topology') topologyInsert.run(snapshotId, row.way.way_id, row.way.osm_version,
        JSON.stringify(row.way.node_refs), hash(row.way.node_refs.join(',')), new Date().toISOString());
      else incidenceInsert.run(snapshotId, runId, row.way.way_id, row.nodeId, row.degree);
      cursor = scanned; checkpoint.run(cursor, 'RUNNING', new Date().toISOString(), snapshotId, runId, stage); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  if (stopped) { setStage(db, snapshotId, runId, stage, 'BLOCKED', cursor); return { status: 'BLOCKED', records_seen: cursor }; }
  if (exit.code !== 0) throw new Error(`osmium topology scan failed (${exit.code ?? exit.signal})${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`);
  setStage(db, snapshotId, runId, stage, 'COMPLETE', scanned);
  return { status: 'COMPLETE', records_seen: scanned };
}

function persistCorridors(db, corridors, batchSize = 500) {
  const insertCorridor = db.prepare(`INSERT INTO physical_corridors(corridor_id,identity_scheme,created_at,last_seen_at,current_status)
    VALUES(?,'OSM_NODE_PATH_V1',?,?,?) ON CONFLICT(corridor_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`);
  const insertVersion = db.prepare(`INSERT OR IGNORE INTO physical_corridor_versions(corridor_version_id,corridor_id,run_id,snapshot_id,algorithm_version,
    classification,physical_existence,motorcycle_access,routability,canonical_status,review_priority,length_m,node_sequence_hash,node_sequence_json,identity_state,geometry_json,evidence_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertObservation = db.prepare('INSERT OR IGNORE INTO physical_corridor_observations(corridor_version_id,candidate_id,relation) VALUES(?,?,?)');
  const insertReview = db.prepare(`INSERT OR IGNORE INTO corridor_review_queue(corridor_version_id,corridor_id,state,reason_code,priority,ranking_json,updated_at)
    VALUES(?,?,?,?,?,?,?)`);
  const rowidForVersion = db.prepare('SELECT corridor_version_rowid FROM physical_corridor_versions WHERE corridor_version_id=?');
  const insertBounds = db.prepare('INSERT OR IGNORE INTO physical_corridor_versions_rtree(corridor_version_rowid,min_lon,max_lon,min_lat,max_lat) VALUES(?,?,?,?,?)');
  const at = new Date().toISOString(); let saved = 0;
  for (let i = 0; i < corridors.length; i += batchSize) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of corridors.slice(i, i + batchSize)) {
        insertCorridor.run(c.corridor_id, at, at, c.identity_state === 'TOPOLOGY_BACKED' ? 'ACTIVE' : 'IDENTITY_UNRESOLVED');
        insertVersion.run(c.corridor_version_id, c.corridor_id, c.run_id, c.snapshot_id, c.algorithm_version, c.classification,
          c.physical_existence, c.motorcycle_access, c.routability, c.canonical_status, c.review_priority, c.length_m,
          c.node_sequence_hash, JSON.stringify(c.node_sequence), c.identity_state, JSON.stringify(c.geometry), JSON.stringify(c.evidence), at);
        const corridorRowid = rowidForVersion.get(c.corridor_version_id).corridor_version_rowid;
        if (c.geometry?.coordinates?.length) {
          let west = 180, east = -180, south = 90, north = -90;
          for (const [lon, lat] of c.geometry.coordinates) { west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat); }
          insertBounds.run(corridorRowid, west, east, south, north);
        }
        for (const id of c.candidate_ids) insertObservation.run(c.corridor_version_id, id, 'OSM_WAY_PART_OBSERVATION');
        const queueState=c.identity_state!=='TOPOLOGY_BACKED'?'AMBIGUOUS':c.tet_supported?'UNREVIEWED':c.review_priority==='LOW_VALUE_FOR_MOTORCYCLE_DISCOVERY'?'LOW_VALUE':'CATALOGUED';
        const reason=queueState==='AMBIGUOUS'?'OSM_TOPOLOGY_ASSOCIATION_UNRESOLVED':queueState==='UNREVIEWED'?'INDEPENDENT_ROUTE_HINT_SUPPORT':queueState==='LOW_VALUE'?'LOW_VALUE_SOURCE_TAGS':'SINGLE_SOURCE_OSM_RESEARCH_CATALOG';
        insertReview.run(c.corridor_version_id, c.corridor_id, queueState,
          reason, c.review_priority,
          JSON.stringify({ length_m: c.length_m, source_observation_count: c.candidate_ids.length, legal_access: 'unknown', routability: 'unknown' }), at);
        saved++;
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return saved;
}

export async function triageCorridorReviewQueue(store,{runId,shouldYield=()=>false,batchSize=1000,includeDiscoveryHintSupport}={}){
  if(!Number.isInteger(batchSize)||batchSize<100||batchSize>5000)throw new Error('corridor triage batch size must be 100-5000');
  const run=store.getDiscoveryRun(runId);if(!run)throw new Error('corridor triage requires an existing discovery run');
  const runConfig=JSON.parse(run.config_json),blindIndependent=runConfig.tet_use==='PROHIBITED_UNTIL_PHASE2_FREEZE',readDiscoveryHints=includeDiscoveryHintSupport??!blindIndependent;
  if(blindIndependent&&readDiscoveryHints)throw new Error('blind independent corridor triage must not read discovery-hint matches before the Phase 2 freeze');
  const stage='CORRIDOR_REVIEW_TRIAGE',prior=stageRow(store.db,run.snapshot_id,runId,stage);
  if(prior?.status==='COMPLETE')return {status:'REUSED',processed:prior.records_seen};
  const hintSupportSql=readDiscoveryHints?`EXISTS(SELECT 1 FROM physical_corridor_observations o JOIN discovery_candidate_matches m USING(candidate_id)
      WHERE o.corridor_version_id=v.corridor_version_id AND m.relationship='same_osm_network_part_support')`:'0';
  const rows=store.db.prepare(`SELECT v.corridor_version_id,v.corridor_id,v.identity_state,v.review_priority,${hintSupportSql} tet_supported
    FROM physical_corridor_versions v WHERE v.run_id=? ORDER BY v.corridor_version_id`).all(runId);
  const offset=prior?.status==='BLOCKED'||prior?.status==='RUNNING'?Number(prior.records_seen):0;
  const update=store.db.prepare(`UPDATE corridor_review_queue SET state=?,reason_code=?,priority=?,ranking_json=?,updated_at=?
    WHERE corridor_version_id=? AND state NOT IN ('INTERESTING','NEEDS_MORE_EVIDENCE','FALSE_POSITIVE','HOLD')`);
  setStage(store.db,run.snapshot_id,runId,stage,'RUNNING',offset);
  for(let i=offset;i<rows.length;i+=batchSize){
    const batch=rows.slice(i,i+batchSize),at=new Date().toISOString();store.db.exec('BEGIN IMMEDIATE');
    try{for(const row of batch){
      const state=row.identity_state!=='TOPOLOGY_BACKED'?'AMBIGUOUS':row.tet_supported?'UNREVIEWED':row.review_priority==='LOW_VALUE_FOR_MOTORCYCLE_DISCOVERY'?'LOW_VALUE':'CATALOGUED';
      const reason=state==='AMBIGUOUS'?'OSM_TOPOLOGY_ASSOCIATION_UNRESOLVED':state==='UNREVIEWED'?'INDEPENDENT_ROUTE_HINT_SUPPORT':state==='LOW_VALUE'?'LOW_VALUE_SOURCE_TAGS':'SINGLE_SOURCE_OSM_RESEARCH_CATALOG';
      const priority=state==='UNREVIEWED'?'CORROBORATED_DISCOVERY':state==='AMBIGUOUS'?'IDENTITY_REVIEW':state==='LOW_VALUE'?'LOW_VALUE_FOR_MOTORCYCLE_DISCOVERY':'CATALOG_ONLY';
      update.run(state,reason,priority,JSON.stringify({source_count:row.tet_supported?2:1,tet_support:Boolean(row.tet_supported),
        research_state:state==='UNREVIEWED'?'SCOUT_RESEARCH_REQUIRED':state==='AMBIGUOUS'?'HUMAN_ESCALATION':'AUTO_RESOLVED',
        human_review_required:state==='AMBIGUOUS'&&row.identity_state!=='TOPOLOGY_BACKED'}),at,row.corridor_version_id);
    }setStage(store.db,run.snapshot_id,runId,stage,'RUNNING',i+batch.length);store.db.exec('COMMIT');}
    catch(error){store.db.exec('ROLLBACK');throw error;}
    await new Promise(resolve=>setImmediate(resolve));
    if(shouldYield()){setStage(store.db,run.snapshot_id,runId,stage,'BLOCKED',i+batch.length);return {status:'BLOCKED',processed:i+batch.length,resumable:true};}
  }
  setStage(store.db,run.snapshot_id,runId,stage,'COMPLETE',rows.length);return {status:'COMPLETE',processed:rows.length};
}

export async function buildCorridorRun(store, { runId, osmium = 'osmium', spawnImpl = spawn, shouldYield = () => false, batchSize = 5000, includeDiscoveryHintSupport } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 100 || batchSize > 20000) throw new Error('topology batch size must be 100-20000');
  const run = store.getDiscoveryRun(runId); if (!run) throw new Error('corridor processing requires an existing discovery run');
  const runConfig=JSON.parse(run.config_json),blindIndependent=runConfig.tet_use==='PROHIBITED_UNTIL_PHASE2_FREEZE',readDiscoveryHints=includeDiscoveryHintSupport??!blindIndependent;
  if(blindIndependent&&readDiscoveryHints)throw new Error('blind independent OSM corridor processing must not read discovery-hint matches before the Phase 2 freeze');
  if (stageRow(store.db, run.snapshot_id, runId, 'CORRIDOR_BUILD')?.status === 'COMPLETE' && stageRow(store.db, run.snapshot_id, runId, 'CORRIDOR_LINEAGE')?.status === 'COMPLETE'
    && stageRow(store.db,run.snapshot_id,runId,'CORRIDOR_REVIEW_TRIAGE')?.status==='COMPLETE') return { ...corridorRunStats(store, runId,{includeDiscoveryHintSupport:readDiscoveryHints}), status: 'REUSED' };
  const snapshot = store.getNetworkSnapshot(run.snapshot_id), artifact = store.getNetworkArtifact(run.snapshot_id);
  if (!snapshot || !artifact || !fs.statSync(artifact.local_path).isFile()) throw new Error('corridor topology requires the registered private PBF artifact');
  const artifactPath = path.resolve(artifact.local_path), storeRoot = fs.realpathSync(store.root);
  if (fs.lstatSync(artifactPath).isSymbolicLink() || fs.realpathSync(artifactPath) !== artifactPath || !artifactPath.startsWith(storeRoot + path.sep)) throw new Error('topology PBF must be a regular artifact inside the private Scout root');
  if (artifact.sha256 !== snapshot.checksum || artifact.byte_size !== fs.statSync(artifactPath).size) throw new Error('registered PBF metadata does not match the pinned snapshot');
  const fileHash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(artifactPath)) fileHash.update(chunk);
  if (fileHash.digest('hex') !== snapshot.checksum) throw new Error('topology PBF checksum does not match the pinned regional snapshot');
  const priorBuild=stageRow(store.db,run.snapshot_id,runId,'CORRIDOR_BUILD');
  const hintSupportSql=readDiscoveryHints?`EXISTS(SELECT 1 FROM discovery_candidate_matches m WHERE m.candidate_id=c.candidate_id AND m.relationship='same_osm_network_part_support')`:'0';
  const candidateRows = priorBuild?.status==='COMPLETE'?[]:store.db.prepare(`SELECT c.candidate_id,c.edge_id,c.part_index,c.classification,c.length_m,c.geometry_json,c.tags_json,
    ${hintSupportSql} tet_supported FROM discovery_candidates c WHERE c.run_id=? ORDER BY c.candidate_id`).all(runId);
  const wayIds = new Set(candidateRows.map(r => r.edge_id)), file = artifactPath;
  const topologyStage = priorBuild?.status==='COMPLETE'?{status:'REUSED'}:await scanWays({ db: store.db, file, snapshotId: run.snapshot_id, runId, stage: 'WAY_REFERENCES', selectedWayIds: wayIds, osmium, spawnImpl, shouldYield, batchSize });
  if (topologyStage.status === 'BLOCKED') return { status: 'BLOCKED', stage: 'WAY_REFERENCES', checkpoint: topologyStage.records_seen };
  const wayNodes = priorBuild?.status==='COMPLETE'?new Map():new Map(store.db.prepare('SELECT edge_id,node_refs_json FROM osm_way_topology WHERE snapshot_id=?').all(run.snapshot_id).map(r => [r.edge_id, JSON.parse(r.node_refs_json)]));
  const endpointIds = new Set();
  if(priorBuild?.status!=='COMPLETE')for (const refs of wayNodes.values()) if (refs.length >= 2) { endpointIds.add(refs[0]); endpointIds.add(refs.at(-1)); }
  const degreeStage = priorBuild?.status==='COMPLETE'?{status:'REUSED'}:await scanWays({ db: store.db, file, snapshotId: run.snapshot_id, runId, stage: 'ENDPOINT_INCIDENCE', endpointIds, osmium, spawnImpl, shouldYield, batchSize });
  if (degreeStage.status === 'BLOCKED') return { status: 'BLOCKED', stage: 'ENDPOINT_INCIDENCE', checkpoint: degreeStage.records_seen };
  const nodeDegree = priorBuild?.status==='COMPLETE'?new Map():new Map(store.db.prepare('SELECT node_id,sum(degree) degree FROM osm_topology_node_incidence WHERE snapshot_id=? AND run_id=? GROUP BY node_id').all(run.snapshot_id, runId).map(r => [r.node_id, Number(r.degree)]));
  const candidates = candidateRows.map(r => ({ ...r, tet_supported:Boolean(r.tet_supported), geometry: JSON.parse(r.geometry_json), tags: JSON.parse(r.tags_json) }));
  let batch = [], saved = 0, ordinal = 0;
  const priorOrdinal = priorBuild?.status === 'BLOCKED' || priorBuild?.status === 'RUNNING' ? priorBuild.records_seen : 0;
  if(priorBuild?.status!=='COMPLETE'){
    setStage(store.db, run.snapshot_id, runId, 'CORRIDOR_BUILD', 'RUNNING', priorOrdinal);
    for (const corridor of buildTopologyCorridors({ candidates, wayNodes, nodeDegree, snapshotId: run.snapshot_id, runId })) {
      if (ordinal++ < priorOrdinal) {if(ordinal%500===0){await new Promise(resolve=>setImmediate(resolve));if(shouldYield()){setStage(store.db,run.snapshot_id,runId,'CORRIDOR_BUILD','BLOCKED',priorOrdinal);return {status:'BLOCKED',stage:'CORRIDOR_BUILD',checkpoint:priorOrdinal,resumable:true};}}continue;}
      batch.push(corridor);
      if (batch.length >= 500) {
        saved += persistCorridors(store.db, batch); batch = [];
        setStage(store.db, run.snapshot_id, runId, 'CORRIDOR_BUILD', 'RUNNING', ordinal);
        if (shouldYield()) { setStage(store.db, run.snapshot_id, runId, 'CORRIDOR_BUILD', 'BLOCKED', ordinal); return { status: 'BLOCKED', stage: 'CORRIDOR_PERSIST', corridors_saved: saved, resumable: true }; }
        await new Promise(resolve=>setImmediate(resolve));
        if (shouldYield()) { setStage(store.db, run.snapshot_id, runId, 'CORRIDOR_BUILD', 'BLOCKED', ordinal); return { status: 'BLOCKED', stage: 'CORRIDOR_PERSIST', corridors_saved: saved, resumable: true }; }
      }
    }
    if (batch.length) saved += persistCorridors(store.db, batch);
    setStage(store.db, run.snapshot_id, runId, 'CORRIDOR_BUILD', 'COMPLETE', ordinal);
  }
  const lineageStage = stageRow(store.db, run.snapshot_id, runId, 'CORRIDOR_LINEAGE');
  if (lineageStage?.status !== 'COMPLETE') {
    const loadPrevious=()=>store.db.prepare(`SELECT * FROM (SELECT v.corridor_version_id,v.corridor_id,v.node_sequence_json,dr.snapshot_id,
      row_number() OVER(PARTITION BY v.corridor_id ORDER BY v.created_at DESC,v.corridor_version_id DESC) rank
      FROM physical_corridor_versions v JOIN discovery_runs dr USING(run_id) WHERE dr.run_id<>? AND dr.country_code=? AND dr.region_id=? AND dr.status='REVIEW_REQUIRED')
      WHERE rank=1`).all(runId, run.country_code, run.region_id).map(r=>({...r,node_sequence:JSON.parse(r.node_sequence_json)}));
    const loadCurrent=()=>store.db.prepare(`SELECT corridor_version_id,corridor_id,node_sequence_json FROM physical_corridor_versions WHERE run_id=?`).all(runId)
      .map(r=>({...r,node_sequence:JSON.parse(r.node_sequence_json)}));
    const pairs = inferRunCorridorLineage({readPriorLineage:readDiscoveryHints,loadPrevious,loadCurrent}), add=store.db.prepare(`INSERT OR IGNORE INTO physical_corridor_lineage(lineage_id,from_version_id,to_version_id,relation,match_state,evidence_json,created_at)
      VALUES(?,?,?,?,?,?,?)`),at=new Date().toISOString();
    store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const pair of pairs) {
        const id=`lin-${hash(`${pair.previous_version_id}\0${pair.next_version_id}\0${pair.relation}`).slice(0,24)}`;
        add.run(id,pair.previous_version_id,pair.next_version_id,pair.relation,pair.match_state,JSON.stringify({shared_nodes:pair.shared_nodes,coverage:pair.coverage,identity_basis:'shared ordered OSM node lineage only'}),at);
        if(pair.relation==='CONTINUES'){
          store.db.prepare('UPDATE physical_corridor_versions SET corridor_id=? WHERE corridor_version_id=?').run(pair.previous_corridor_id,pair.next_version_id);
          store.db.prepare('UPDATE corridor_review_queue SET corridor_id=? WHERE corridor_version_id=?').run(pair.previous_corridor_id,pair.next_version_id);
          store.db.prepare('DELETE FROM physical_corridors WHERE corridor_id=? AND NOT EXISTS(SELECT 1 FROM physical_corridor_versions WHERE corridor_id=?)').run(pair.next_corridor_id,pair.next_corridor_id);
        }else{
          store.db.prepare(`UPDATE corridor_review_queue SET state='AMBIGUOUS',reason_code='CORRIDOR_LINEAGE_AMBIGUOUS',updated_at=? WHERE corridor_version_id=?`).run(at,pair.next_version_id);
        }
      }
      setStage(store.db,run.snapshot_id,runId,'CORRIDOR_LINEAGE','COMPLETE',pairs.length);store.db.exec('COMMIT');
    }catch(error){store.db.exec('ROLLBACK');throw error;}
  }
  const triage=await triageCorridorReviewQueue(store,{runId,shouldYield,includeDiscoveryHintSupport:readDiscoveryHints});if(triage.status==='BLOCKED')return {status:'BLOCKED',stage:'CORRIDOR_REVIEW_TRIAGE',...triage};
  return corridorRunStats(store, runId,{includeDiscoveryHintSupport:readDiscoveryHints});
}
export const buildBelgiumCorridorRun = buildCorridorRun;

export function corridorRunStats(store, runId,{includeDiscoveryHintSupport}={}) {
  const run=store.getDiscoveryRun(runId);if(!run)throw new Error('corridor statistics require an existing discovery run');
  const blindIndependent=JSON.parse(run.config_json).tet_use==='PROHIBITED_UNTIL_PHASE2_FREEZE',readDiscoveryHints=includeDiscoveryHintSupport??!blindIndependent;
  if(blindIndependent&&readDiscoveryHints)throw new Error('blind independent corridor statistics must not read discovery-hint matches before the Phase 2 freeze');
  const counts = store.db.prepare('SELECT classification,count(*) corridors,sum(length_m) length_m FROM physical_corridor_versions WHERE run_id=? GROUP BY classification').all(runId);
  const queue = store.db.prepare('SELECT state,count(*) count FROM corridor_review_queue q JOIN physical_corridor_versions v USING(corridor_version_id) WHERE v.run_id=? GROUP BY state').all(runId);
  const sourceCounts = store.db.prepare(`SELECT count(DISTINCT o.candidate_id) raw_observations,count(DISTINCT v.corridor_id) corridors,
    sum(v.identity_state='TOPOLOGY_BACKED') topology_backed,sum(v.identity_state='REVIEW_REQUIRED') unresolved
    FROM physical_corridor_versions v LEFT JOIN physical_corridor_observations o USING(corridor_version_id) WHERE v.run_id=?`).get(runId);
  const lengths = store.db.prepare('SELECT length_m FROM physical_corridor_versions WHERE run_id=? ORDER BY length_m,corridor_id').all(runId).map(r => Number(r.length_m));
  const bins = Object.fromEntries([['lt_100m',100],['100_500m',500],['500_1000m',1000],['1_5km',5000],['ge_5km',Infinity]].map(([name,max]) => [name,
    lengths.filter((value,index) => (name === 'lt_100m' ? value < max : name === '100_500m' ? value >= 100 && value < max : name === '500_1000m' ? value >= 500 && value < max : name === '1_5km' ? value >= 1000 && value < max : value >= 5000)).length]));
  const support = readDiscoveryHints?store.db.prepare(`SELECT count(DISTINCT v.corridor_id) tet_supported FROM physical_corridor_versions v JOIN physical_corridor_observations o USING(corridor_version_id)
    WHERE v.run_id=? AND EXISTS(SELECT 1 FROM discovery_candidate_matches m WHERE m.candidate_id=o.candidate_id AND m.relationship='same_osm_network_part_support')`).get(runId):{tet_supported:0};
  const byExistence = store.db.prepare('SELECT physical_existence,count(*) count FROM physical_corridor_versions WHERE run_id=? GROUP BY physical_existence').all(runId);
  const byAccess = store.db.prepare('SELECT motorcycle_access,count(*) count FROM physical_corridor_versions WHERE run_id=? GROUP BY motorcycle_access').all(runId);
  const lineage = store.db.prepare(`SELECT relation,match_state,count(*) count FROM physical_corridor_lineage l JOIN physical_corridor_versions v ON v.corridor_version_id=l.to_version_id WHERE v.run_id=? GROUP BY relation,match_state`).all(runId);
  const branchNodes = Number(store.db.prepare(`SELECT count(*) n FROM (SELECT node_id,sum(degree) total FROM osm_topology_node_incidence
    WHERE snapshot_id=(SELECT snapshot_id FROM discovery_runs WHERE run_id=?) AND run_id=? GROUP BY node_id HAVING sum(degree)>2)`).get(runId,runId)?.n??0);
  const topologyRows = store.db.prepare('SELECT identity_state,node_sequence_json FROM physical_corridor_versions WHERE run_id=?').all(runId);
  const topologyDegrees = new Map(store.db.prepare(`SELECT node_id,sum(degree) degree FROM osm_topology_node_incidence WHERE snapshot_id=(SELECT snapshot_id FROM discovery_runs WHERE run_id=?) AND run_id=? GROUP BY node_id`).all(runId,runId).map(r=>[r.node_id,Number(r.degree)]));
  const branchingCorridors = topologyRows.filter(row=>{if(row.identity_state!=='TOPOLOGY_BACKED')return false;const refs=JSON.parse(row.node_sequence_json);return Number(topologyDegrees.get(refs[0])??0)>2||Number(topologyDegrees.get(refs.at(-1))??0)>2;}).length;
  const access = Object.fromEntries(byAccess.map(row=>[row.motorcycle_access,Number(row.count)]));
  const existence = Object.fromEntries(byExistence.map(row=>[row.physical_existence,Number(row.count)]));
  return { run_id: runId, raw_way_part_observations: Number(sourceCounts.raw_observations ?? 0), stable_corridors: Number(sourceCounts.corridors ?? 0),
    topology_backed: Number(sourceCounts.topology_backed ?? 0), identity_unresolved: Number(sourceCounts.unresolved ?? 0),
    length_median_m: lengths.length ? lengths[Math.floor((lengths.length - 1) / 2)] : null, length_distribution_count: bins,
    topology: { branch_nodes: branchNodes, branching_corridors: branchingCorridors,
      lineage: Object.fromEntries(lineage.map(row=>[`${row.relation}:${row.match_state}`,Number(row.count)])),
      parallel_pairs: store.db.prepare(`SELECT count(*) n FROM discovery_candidate_matches m JOIN discovery_candidates c USING(candidate_id) WHERE c.run_id=? AND m.relationship='POSSIBLE_PARALLEL'`).get(runId).n },
    source_support: { osm_only: Number(sourceCounts.corridors ?? 0) - Number(support.tet_supported ?? 0), tet_supported: readDiscoveryHints?Number(support.tet_supported??0):null, other_sources: 0, reference_hint_status:readDiscoveryHints?'AVAILABLE':'NOT_READ' },
    existence: { confirmed: existence.confirmed??0, probable: existence.probable??0, unknown: existence.unknown??0, contradictory: existence.contradictory??0 },
    access: { known_permitted: access.confirmed??0, known_restricted: access.prohibited??0, temporary_restriction: access.temporarily_restricted??0,
      conflicting_or_review: access.contradictory??0, unknown: access.unknown??0 },
    routability: { routable: 0, not_routable: 0, unknown: Number(sourceCounts.corridors ?? 0) },
    by_physical_character: Object.fromEntries(counts.map(r => [r.classification, { count: Number(r.corridors), length_km: Number((r.length_m / 1000).toFixed(3)) }])),
    review_queue: Object.fromEntries(queue.map(r => [r.state, Number(r.count)])), legal_access: 'UNKNOWN unless supported by independent qualified authoritative source', routability: 'UNKNOWN; no routing graph check performed', canonical_status: 'NOT_COMPARED'};
}

export function listCorridorReview(store, { runId, state = 'ALL', limit = 200 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('corridor review limit must be 1-5000');
  const rows = store.db.prepare(`SELECT q.corridor_version_id,q.corridor_id,q.state,q.reason_code,q.priority,q.ranking_json,q.updated_at,
    v.classification,v.physical_existence,v.motorcycle_access,v.routability,v.canonical_status,v.identity_state,v.length_m,v.evidence_json,
    (SELECT count(*) FROM physical_corridor_observations o WHERE o.corridor_version_id=v.corridor_version_id) observation_count
    FROM corridor_review_queue q JOIN physical_corridor_versions v USING(corridor_version_id)
    WHERE v.run_id=? AND (?='ALL' OR q.state=?) ORDER BY CASE q.state WHEN 'AMBIGUOUS' THEN 0 WHEN 'UNREVIEWED' THEN 1 WHEN 'NEEDS_MORE_EVIDENCE' THEN 2 WHEN 'HOLD' THEN 3 WHEN 'LOW_VALUE' THEN 4 WHEN 'CATALOGUED' THEN 5 ELSE 6 END,
    CASE q.priority WHEN 'IDENTITY_REVIEW' THEN 0 WHEN 'CORROBORATED_DISCOVERY' THEN 1 WHEN 'NORMAL_REVIEW' THEN 2 ELSE 3 END,v.length_m DESC,q.corridor_id LIMIT ?`).all(runId, state, state, limit);
  return rows.map(row => ({ ...row, ranking: JSON.parse(row.ranking_json), evidence: JSON.parse(row.evidence_json) }));
}

export function recordCorridorReview(store, { corridorId, decision, reviewer, reason, at = new Date().toISOString() } = {}) {
  const allowed = new Set(['INTERESTING', 'NEEDS_MORE_EVIDENCE', 'LOW_VALUE', 'FALSE_POSITIVE', 'AMBIGUOUS', 'HOLD', 'UNREVIEWED']);
  if (!allowed.has(decision) || !reviewer?.trim() || !reason?.trim() || !Number.isFinite(Date.parse(at))) throw new Error('corridor review needs a valid research decision, reviewer, reason and timestamp');
  const row = store.db.prepare(`SELECT corridor_version_id FROM physical_corridor_versions WHERE corridor_id=? ORDER BY created_at DESC LIMIT 1`).get(corridorId);
  if (!row) throw new Error('unknown Scout corridor');
  const id = `crd-${hash(`${corridorId}\0${decision}\0${reviewer}\0${at}\0${reason}`).slice(0, 24)}`;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('INSERT INTO corridor_review_decisions(decision_id,corridor_id,corridor_version_id,decision,reviewer,reason,decided_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, corridorId, row.corridor_version_id, decision, reviewer.trim(), reason.trim(), at);
    store.db.prepare('UPDATE corridor_review_queue SET state=?,updated_at=? WHERE corridor_version_id=?').run(decision, at, row.corridor_version_id);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return { corridor_id: corridorId, decision_id: id, decision, reviewer: reviewer.trim(), decided_at: at, canonical_write: false, legal_access_change: false };
}
