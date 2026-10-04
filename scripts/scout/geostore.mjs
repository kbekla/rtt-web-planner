// Private Scout geospatial metadata store. The original source bytes live in a
// content-addressed private file store; SQLite indexes the versioned records.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { REPO } from '../lib/common.mjs';

export const SCOUT_GEOSCHEMA_VERSION = 4;
const json = (value) => JSON.stringify(value);

export class ScoutGeoStore {
  constructor(root, { databaseFile = path.join(root, 'scout.sqlite') } = {}) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if(fs.lstatSync(this.root).isSymbolicLink())throw new Error('Scout geostore root cannot be a symlink');
    const privateRoot=fs.realpathSync(this.root),repository=fs.realpathSync(REPO);
    if(privateRoot===repository||privateRoot.startsWith(repository+path.sep))throw new Error('Scout geostore must remain outside the repository/public tree');
    fs.chmodSync(this.root,0o700);
    databaseFile=path.resolve(databaseFile);
    if(databaseFile!==this.root&&!databaseFile.startsWith(this.root+path.sep))throw new Error('Scout database must remain inside its private geostore root');
    const databaseFd=fs.openSync(databaseFile,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
    try { if(!fs.fstatSync(databaseFd).isFile())throw new Error('Scout database must be a regular file');fs.fchmodSync(databaseFd,0o600); }
    finally { fs.closeSync(databaseFd); }
    this.db = new DatabaseSync(databaseFile);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.migrate();
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) SELECT ${SCOUT_GEOSCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS source_registry (
        source_id TEXT PRIMARY KEY, current_revision INTEGER NOT NULL, current_json TEXT NOT NULL,
        health TEXT NOT NULL DEFAULT 'UNKNOWN', last_retrieval TEXT, last_successful_processing TEXT,
        next_due TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_registry_versions (
        source_id TEXT NOT NULL, revision INTEGER NOT NULL, definition_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(source_id, revision), FOREIGN KEY(source_id) REFERENCES source_registry(source_id)
      );
      CREATE TABLE IF NOT EXISTS source_files (
        file_id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, relative_name TEXT NOT NULL, sha256 TEXT NOT NULL,
        version INTEGER NOT NULL, format TEXT NOT NULL, raw_path TEXT NOT NULL, byte_size INTEGER NOT NULL,
        parser_version TEXT NOT NULL, status TEXT NOT NULL, imported_at TEXT NOT NULL,
        UNIQUE(source_id, relative_name, sha256, parser_version), FOREIGN KEY(source_id) REFERENCES source_registry(source_id)
      );
      CREATE TABLE IF NOT EXISTS route_observations (
        observation_id TEXT PRIMARY KEY, file_id INTEGER NOT NULL, source_part TEXT NOT NULL, source_name TEXT,
        source_language TEXT, geometry_json TEXT NOT NULL, geometry_sha256 TEXT NOT NULL, metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(file_id, source_part), FOREIGN KEY(file_id) REFERENCES source_files(file_id)
      );
      CREATE TABLE IF NOT EXISTS jurisdictions (
        jurisdiction_id TEXT PRIMARY KEY, country_code TEXT NOT NULL, admin1_code TEXT, admin2_code TEXT,
        language TEXT, version TEXT NOT NULL, effective_from TEXT, effective_to TEXT,
        boundary_json TEXT NOT NULL, metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jurisdiction_versions (
        jurisdiction_id TEXT NOT NULL, country_code TEXT NOT NULL, admin1_code TEXT, admin2_code TEXT,
        language TEXT, version TEXT NOT NULL, effective_from TEXT, effective_to TEXT,
        boundary_json TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(jurisdiction_id,version)
      );
      CREATE TABLE IF NOT EXISTS observation_jurisdictions (
        observation_id TEXT NOT NULL, jurisdiction_id TEXT NOT NULL, relation TEXT NOT NULL,
        coverage REAL, certainty TEXT NOT NULL, PRIMARY KEY(observation_id, jurisdiction_id),
        FOREIGN KEY(observation_id) REFERENCES route_observations(observation_id),
        FOREIGN KEY(jurisdiction_id) REFERENCES jurisdictions(jurisdiction_id)
      );
      CREATE TABLE IF NOT EXISTS network_snapshots (
        snapshot_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, version TEXT NOT NULL, checksum TEXT NOT NULL,
        licence_json TEXT NOT NULL, coverage_json TEXT NOT NULL, imported_at TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES source_registry(source_id)
      );
      CREATE TABLE IF NOT EXISTS network_edges (
        edge_rowid INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL, edge_id TEXT NOT NULL, geometry_json TEXT NOT NULL,
        tags_json TEXT NOT NULL, evidence_json TEXT NOT NULL, jurisdiction_ids_json TEXT NOT NULL,
        UNIQUE(snapshot_id, edge_id), FOREIGN KEY(snapshot_id) REFERENCES network_snapshots(snapshot_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS network_edges_rtree USING rtree(edge_rowid, min_lon, max_lon, min_lat, max_lat);
      CREATE TABLE IF NOT EXISTS route_segments (
        segment_rowid INTEGER PRIMARY KEY, segment_id TEXT NOT NULL UNIQUE, observation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, component_index INTEGER NOT NULL, classification TEXT NOT NULL,
        confidence REAL, geometry_json TEXT NOT NULL, evidence_json TEXT NOT NULL, pipeline_version TEXT NOT NULL,
        jurisdiction_ids_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(observation_id) REFERENCES route_observations(observation_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS route_segments_rtree USING rtree(segment_rowid, min_lon, max_lon, min_lat, max_lat);
      CREATE TABLE IF NOT EXISTS candidates (
        candidate_id TEXT PRIMARY KEY, segment_id TEXT NOT NULL, candidate_version INTEGER NOT NULL,
        master_match TEXT NOT NULL, physical_state TEXT NOT NULL, motorcycle_access TEXT NOT NULL,
        routability TEXT NOT NULL, review_state TEXT NOT NULL, issues_json TEXT NOT NULL,
        matched_rtt_ids_json TEXT NOT NULL DEFAULT '[]', match_details_json TEXT NOT NULL DEFAULT '{}',
        network_snapshot_id TEXT, jurisdiction_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(segment_id) REFERENCES route_segments(segment_id)
      );
      CREATE TABLE IF NOT EXISTS evidence (
        evidence_id TEXT PRIMARY KEY, candidate_id TEXT, observation_id TEXT, question TEXT NOT NULL,
        outcome TEXT NOT NULL, jurisdiction_id TEXT, source_id TEXT NOT NULL, source_version TEXT,
        evidence_time TEXT, valid_from TEXT, valid_to TEXT, original_language TEXT, evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL, FOREIGN KEY(candidate_id) REFERENCES candidates(candidate_id),
        FOREIGN KEY(observation_id) REFERENCES route_observations(observation_id),
        FOREIGN KEY(jurisdiction_id) REFERENCES jurisdictions(jurisdiction_id),
        FOREIGN KEY(source_id) REFERENCES source_registry(source_id)
      );
      CREATE TABLE IF NOT EXISTS review_items (
        review_id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, reason_code TEXT NOT NULL,
        explanation TEXT NOT NULL, context_json TEXT NOT NULL, recommended_action TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'OPEN', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(subject_type,subject_id,reason_code)
      );
      CREATE INDEX IF NOT EXISTS source_files_source_idx ON source_files(source_id, imported_at);
      CREATE INDEX IF NOT EXISTS observations_file_idx ON route_observations(file_id);
      CREATE INDEX IF NOT EXISTS segments_observation_idx ON route_segments(observation_id, ordinal);
      CREATE INDEX IF NOT EXISTS candidates_review_idx ON candidates(review_state, updated_at);
      CREATE INDEX IF NOT EXISTS evidence_question_idx ON evidence(question, jurisdiction_id, evidence_time);
    `);
    const version = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get()?.version;
    if(version===1) {
      this.db.exec(`ALTER TABLE candidates ADD COLUMN matched_rtt_ids_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE candidates ADD COLUMN match_details_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE candidates ADD COLUMN network_snapshot_id TEXT;
        ALTER TABLE candidates ADD COLUMN jurisdiction_ids_json TEXT NOT NULL DEFAULT '[]';
        UPDATE schema_version SET version=${SCOUT_GEOSCHEMA_VERSION};`);
    } else if(version===2||version===3)this.db.exec(`UPDATE schema_version SET version=${SCOUT_GEOSCHEMA_VERSION};`);
    else if(version!==SCOUT_GEOSCHEMA_VERSION)throw new Error(`unsupported Scout geostore schema version ${version}`);
  }
  registerSource(definition) {
    const source = validateSourceDefinition(definition);
    const old = this.db.prepare('SELECT current_revision,current_json FROM source_registry WHERE source_id=?').get(source.source_id);
    if (old && old.current_json === json(source)) return { source_id: source.source_id, revision: old.current_revision, unchanged: true };
    const revision = (old?.current_revision ?? 0) + 1, at = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO source_registry(source_id,current_revision,current_json,health,updated_at)
        VALUES(?,?,?,'UNKNOWN',?) ON CONFLICT(source_id) DO UPDATE SET current_revision=excluded.current_revision,current_json=excluded.current_json,updated_at=excluded.updated_at`)
        .run(source.source_id, revision, json(source), at);
      this.db.prepare('INSERT INTO source_registry_versions(source_id,revision,definition_json,created_at) VALUES(?,?,?,?)')
        .run(source.source_id, revision, json(source), at);
      this.db.exec('COMMIT');
      return { source_id: source.source_id, revision, unchanged: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getSource(sourceId) {
    const row = this.db.prepare('SELECT current_revision,current_json,health,last_retrieval,last_successful_processing,next_due FROM source_registry WHERE source_id=?').get(sourceId);
    return row ? { ...JSON.parse(row.current_json), revision: row.current_revision, health: row.health,
      last_retrieval: row.last_retrieval, last_successful_processing: row.last_successful_processing, next_due: row.next_due } : null;
  }
  listSources() { return this.db.prepare('SELECT source_id,current_revision,current_json,health,last_retrieval,last_successful_processing,next_due FROM source_registry ORDER BY source_id').all()
    .map((r) => ({ ...JSON.parse(r.current_json), revision: r.current_revision, health: r.health,
      last_retrieval: r.last_retrieval, last_successful_processing: r.last_successful_processing, next_due: r.next_due })); }
  recordSourceActivity(sourceId, { health, retrievedAt, processedAt, nextDue } = {}) {
    const validHealth=['UNKNOWN','GREEN','AMBER','RED','DISABLED'];
    if(!validHealth.includes(health))throw new Error('invalid source health state');
    const result=this.db.prepare(`UPDATE source_registry SET health=?,last_retrieval=COALESCE(?,last_retrieval),
      last_successful_processing=COALESCE(?,last_successful_processing),next_due=COALESCE(?,next_due),updated_at=? WHERE source_id=?`)
      .run(health,retrievedAt??null,processedAt??null,nextDue??null,new Date().toISOString(),sourceId);
    if(result.changes!==1)throw new Error(`unknown source '${sourceId}'`);
  }
  recordFile(file) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.getSource(file.source_id)?.reuse?.private_processing) throw new Error('source does not authorize private processing');
      const old = this.db.prepare('SELECT file_id,version,status FROM source_files WHERE source_id=? AND relative_name=? AND sha256=? AND parser_version=?')
        .get(file.source_id, file.relative_name, file.sha256, file.parser_version);
      if (old) { this.db.exec('COMMIT'); return { ...old, file_id:Number(old.file_id), version:Number(old.version), duplicate: old.status === 'processed' }; }
      const version = Number(this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM source_files WHERE source_id=? AND relative_name=?').get(file.source_id, file.relative_name).version);
      const result = this.db.prepare(`INSERT INTO source_files(source_id,relative_name,sha256,version,format,raw_path,byte_size,parser_version,status,imported_at)
        VALUES(?,?,?,?,?,?,?,?,'processing',?)`).run(file.source_id, file.relative_name, file.sha256, version, file.format,
        file.raw_path, file.byte_size, file.parser_version, file.imported_at ?? new Date().toISOString());
      this.db.exec('COMMIT');return { file_id:Number(result.lastInsertRowid), version, status: 'processing', duplicate: false };
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  completeFileImport(fileId, observations) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare(`INSERT OR IGNORE INTO route_observations(observation_id,file_id,source_part,source_name,source_language,geometry_json,geometry_sha256,metadata_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      for (const o of observations) insert.run(o.observation_id, fileId, o.source_part, o.source_name ?? null, o.source_language ?? null,
        json(o.geometry), o.geometry_sha256, json(o.metadata ?? {}), o.created_at ?? new Date().toISOString());
      this.db.prepare("UPDATE source_files SET status='processed' WHERE file_id=?").run(fileId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  observationsForFile(fileId) {
    return this.db.prepare('SELECT * FROM route_observations WHERE file_id=? ORDER BY source_part').all(fileId).map((r) => ({
      ...r, geometry: JSON.parse(r.geometry_json), metadata: JSON.parse(r.metadata_json),
    }));
  }
  getObservation(observationId) {
    const row=this.db.prepare('SELECT * FROM route_observations WHERE observation_id=?').get(observationId);
    return row?{...row,geometry:JSON.parse(row.geometry_json),metadata:JSON.parse(row.metadata_json)}:null;
  }
  recordNetworkSnapshot(snapshot) {
    const source=this.getSource(snapshot.source_id);
    if(!source?.roles?.routing_network||!source.reuse.private_processing)throw new Error('network snapshot source must authorize private routing-network processing');
    if(!snapshot.snapshot_id||!snapshot.version||!/^[a-f0-9]{64}$/i.test(snapshot.checksum??'')||!snapshot.licence||!snapshot.coverage)throw new Error('network snapshot requires stable ID, version, checksum, licence and coverage');
    this.db.prepare(`INSERT INTO network_snapshots(snapshot_id,source_id,version,checksum,licence_json,coverage_json,imported_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_id) DO NOTHING`).run(snapshot.snapshot_id,snapshot.source_id,snapshot.version,snapshot.checksum.toLowerCase(),json(snapshot.licence),json(snapshot.coverage),snapshot.imported_at??new Date().toISOString());
  }
  getNetworkSnapshot(snapshotId) {
    const row=this.db.prepare('SELECT * FROM network_snapshots WHERE snapshot_id=?').get(snapshotId);
    return row?{...row,licence:JSON.parse(row.licence_json),coverage:JSON.parse(row.coverage_json)}:null;
  }
  saveNetworkEdge(snapshotId, edge) {
    const parts=edge.geometry?.type==='LineString'?[edge.geometry.coordinates]:edge.geometry?.type==='MultiLineString'?edge.geometry.coordinates:[];
    const coords=parts.flat();
    if(!edge.edge_id||coords.length<2||coords.some((p)=>!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1])||Math.abs(p[0])>180||Math.abs(p[1])>90))throw new Error('network edge requires stable ID and valid WGS84 line geometry');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO network_edges(snapshot_id,edge_id,geometry_json,tags_json,evidence_json,jurisdiction_ids_json) VALUES(?,?,?,?,?,?)
        ON CONFLICT(snapshot_id,edge_id) DO UPDATE SET geometry_json=excluded.geometry_json,tags_json=excluded.tags_json,evidence_json=excluded.evidence_json,jurisdiction_ids_json=excluded.jurisdiction_ids_json`)
        .run(snapshotId,edge.edge_id,json(edge.geometry),json(edge.tags??{}),json(edge.evidence??[]),json(edge.jurisdiction_ids??[]));
      const row=this.db.prepare('SELECT edge_rowid FROM network_edges WHERE snapshot_id=? AND edge_id=?').get(snapshotId,edge.edge_id);
      const bounds=coords.reduce((b,p)=>[Math.min(b[0],p[0]),Math.max(b[1],p[0]),Math.min(b[2],p[1]),Math.max(b[3],p[1])],[Infinity,-Infinity,Infinity,-Infinity]);
      this.db.prepare('DELETE FROM network_edges_rtree WHERE edge_rowid=?').run(row.edge_rowid);
      this.db.prepare('INSERT INTO network_edges_rtree(edge_rowid,min_lon,max_lon,min_lat,max_lat) VALUES(?,?,?,?,?)').run(row.edge_rowid,...bounds);
      this.db.exec('COMMIT');return edge.edge_id;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  queryNetworkEdges(bbox, { limit=5000, snapshotId=null } = {}) {
    validateBbox(bbox);
    if(!Number.isInteger(limit)||limit<1||limit>20000)throw new Error('network edge result limit must be 1-20000');
    if(snapshotId&&!this.getNetworkSnapshot(snapshotId))throw new Error(`unknown network snapshot '${snapshotId}'`);
    const sql=`SELECT e.* FROM network_edges e JOIN network_edges_rtree r USING(edge_rowid) WHERE r.max_lon>=? AND r.min_lon<=? AND r.max_lat>=? AND r.min_lat<=? AND (? IS NULL OR e.snapshot_id=?) ORDER BY e.edge_rowid LIMIT ?`;
    const rows=bbox[0]<=bbox[2]?this.db.prepare(sql).all(bbox[0],bbox[2],bbox[1],bbox[3],snapshotId,snapshotId,limit):
      this.db.prepare(sql).all(bbox[0],180,bbox[1],bbox[3],snapshotId,snapshotId,limit).concat(this.db.prepare(sql).all(-180,bbox[2],bbox[1],bbox[3],snapshotId,snapshotId,limit));
    return [...new Map(rows.map((row)=>[row.edge_rowid,row])).values()].sort((a,b)=>a.edge_rowid-b.edge_rowid).slice(0,limit).map((r)=>({
      ...r,geometry:JSON.parse(r.geometry_json),tags:JSON.parse(r.tags_json),evidence:JSON.parse(r.evidence_json),jurisdiction_ids:JSON.parse(r.jurisdiction_ids_json)}));
  }
  saveCandidate(segment, { candidate_id=`candidate-${segment.segment_id}`, master_match='UNMATCHED', matched_rtt_ids=[], match_details={}, network_snapshot_id=null,
    jurisdiction_ids=segment.jurisdiction_ids??[], physical_state='unknown', motorcycle_access='unknown', routability='unknown', review_state='OPEN', issues=[] } = {}) {
    const states={physical_state:['unknown','probable','confirmed','disproved','contradictory'],motorcycle_access:['unknown','probable','confirmed','prohibited','contradictory'],routability:['unknown','yes','no','contradictory']};
    for(const [key,allowed]of Object.entries(states))if(!allowed.includes({physical_state,motorcycle_access,routability}[key]))throw new Error(`invalid candidate ${key}`);
    if(!['EXACT_EXISTING','LIKELY_EXISTING','PARTIAL_OVERLAP','POSSIBLE_PARALLEL','AMBIGUOUS','NEW_CANDIDATE','UNMATCHED'].includes(master_match))throw new Error('invalid canonical match state');
    if(!Array.isArray(issues)||!Array.isArray(matched_rtt_ids)||!Array.isArray(jurisdiction_ids)||!match_details||typeof match_details!=='object')throw new Error('candidate issues, match IDs, jurisdiction IDs and match details must be structured values');
    const at=new Date().toISOString();
    if(network_snapshot_id&&!this.getNetworkSnapshot(network_snapshot_id))throw new Error(`unknown network snapshot '${network_snapshot_id}'`);
    this.db.prepare(`INSERT INTO candidates(candidate_id,segment_id,candidate_version,master_match,physical_state,motorcycle_access,routability,review_state,issues_json,matched_rtt_ids_json,match_details_json,network_snapshot_id,jurisdiction_ids_json,created_at,updated_at)
      VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET candidate_version=candidates.candidate_version+1,master_match=excluded.master_match,
      physical_state=excluded.physical_state,motorcycle_access=excluded.motorcycle_access,routability=excluded.routability,review_state=excluded.review_state,issues_json=excluded.issues_json,
      matched_rtt_ids_json=excluded.matched_rtt_ids_json,match_details_json=excluded.match_details_json,network_snapshot_id=excluded.network_snapshot_id,jurisdiction_ids_json=excluded.jurisdiction_ids_json,updated_at=excluded.updated_at
      WHERE candidates.segment_id IS NOT excluded.segment_id OR candidates.master_match IS NOT excluded.master_match OR candidates.physical_state IS NOT excluded.physical_state
      OR candidates.motorcycle_access IS NOT excluded.motorcycle_access OR candidates.routability IS NOT excluded.routability OR candidates.review_state IS NOT excluded.review_state OR candidates.issues_json IS NOT excluded.issues_json
      OR candidates.matched_rtt_ids_json IS NOT excluded.matched_rtt_ids_json OR candidates.match_details_json IS NOT excluded.match_details_json OR candidates.network_snapshot_id IS NOT excluded.network_snapshot_id OR candidates.jurisdiction_ids_json IS NOT excluded.jurisdiction_ids_json`)
      .run(candidate_id,segment.segment_id,master_match,physical_state,motorcycle_access,routability,review_state,json(issues),json(matched_rtt_ids),json(match_details),network_snapshot_id,json(jurisdiction_ids),at,at);
    return this.db.prepare('SELECT * FROM candidates WHERE candidate_id=?').get(candidate_id);
  }
  saveEvidence(record) {
    const source=this.getSource(record.source_id);
    if(!source?.reuse?.private_processing)throw new Error('evidence source does not authorize private processing');
    const roles={physical_existence:'physical_existence',motorcycle_access:'legal_access',routability:'routing_network'};
    if(!roles[record.question]||source.roles?.[roles[record.question]]!==true)throw new Error(`source is not registered for ${record.question} evidence`);
    if(!['confirmed','disproved','prohibited','supports','contradicts','unknown'].includes(record.outcome))throw new Error('invalid evidence outcome');
    if(record.qualified===true&&!record.reference)throw new Error('qualified evidence requires a stable reference');
    if(record.jurisdiction_id&&!this.db.prepare('SELECT 1 FROM jurisdictions WHERE jurisdiction_id=?').get(record.jurisdiction_id))throw new Error('evidence jurisdiction is not registered');
    if(record.candidate_id&&!this.db.prepare('SELECT 1 FROM candidates WHERE candidate_id=?').get(record.candidate_id))throw new Error('evidence candidate is not registered');
    if(record.observation_id&&!this.getObservation(record.observation_id))throw new Error('evidence observation is not registered');
    const stable=[record.candidate_id??null,record.observation_id??null,record.question,record.outcome,record.source_id,record.source_version??source.revision,
      record.reference??null,record.evidence_time??null,record.valid_from??null,record.valid_to??null,record.jurisdiction_id??null];
    const evidence_id=record.evidence_id??`evidence-${crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0,24)}`;
    this.db.prepare(`INSERT OR IGNORE INTO evidence(evidence_id,candidate_id,observation_id,question,outcome,jurisdiction_id,source_id,source_version,evidence_time,valid_from,valid_to,original_language,evidence_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(evidence_id,record.candidate_id??null,record.observation_id??null,record.question,record.outcome,
      record.jurisdiction_id??null,record.source_id,record.source_version??String(source.revision),record.evidence_time??null,record.valid_from??null,record.valid_to??null,
      record.original_language??null,json({...record,evidence_id,source_revision:source.revision}),record.created_at??new Date().toISOString());
    return evidence_id;
  }
  listEvidence({candidateId=null,observationId=null,limit=1000}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>10000)throw new Error('evidence query limit must be 1-10000');
    let rows;
    if(candidateId&&observationId)rows=this.db.prepare('SELECT * FROM evidence WHERE candidate_id=? AND observation_id=? ORDER BY evidence_time,evidence_id LIMIT ?').all(candidateId,observationId,limit);
    else if(candidateId)rows=this.db.prepare('SELECT * FROM evidence WHERE candidate_id=? ORDER BY evidence_time,evidence_id LIMIT ?').all(candidateId,limit);
    else if(observationId)rows=this.db.prepare('SELECT * FROM evidence WHERE observation_id=? ORDER BY evidence_time,evidence_id LIMIT ?').all(observationId,limit);
    else rows=this.db.prepare('SELECT * FROM evidence ORDER BY evidence_time,evidence_id LIMIT ?').all(limit);
    return rows.map((r)=>({...r,evidence:JSON.parse(r.evidence_json)}));
  }
  saveReviewItem({subject_type,subject_id,reason_code,explanation,context={},recommended_action,state='OPEN'}) {
    if(!['observation','segment','candidate','source'].includes(subject_type)||!subject_id||!reason_code||!explanation||!recommended_action)throw new Error('review item requires subject, reason, explanation and recommended action');
    if(!['OPEN','IN_PROGRESS','DEFERRED','RESOLVED'].includes(state))throw new Error('invalid review state');
    const review_id=`review-${crypto.createHash('sha256').update(`${subject_type}\0${subject_id}\0${reason_code}`).digest('hex').slice(0,24)}`,at=new Date().toISOString();
    this.db.prepare(`INSERT INTO review_items(review_id,subject_type,subject_id,reason_code,explanation,context_json,recommended_action,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(subject_type,subject_id,reason_code) DO UPDATE SET explanation=excluded.explanation,context_json=excluded.context_json,
      recommended_action=excluded.recommended_action,updated_at=excluded.updated_at WHERE review_items.state!='RESOLVED'`)
      .run(review_id,subject_type,subject_id,reason_code,explanation,json(context),recommended_action,state,at,at);
    return this.db.prepare('SELECT * FROM review_items WHERE review_id=?').get(review_id);
  }
  listReviewItems({state='OPEN',limit=500}={}) {
    if(!['OPEN','IN_PROGRESS','DEFERRED','RESOLVED','ALL'].includes(state)||!Number.isInteger(limit)||limit<1||limit>5000)throw new Error('invalid review queue query');
    const rows=state==='ALL'?this.db.prepare('SELECT * FROM review_items ORDER BY created_at,review_id LIMIT ?').all(limit):
      this.db.prepare('SELECT * FROM review_items WHERE state=? ORDER BY created_at,review_id LIMIT ?').all(state,limit);
    return rows.map((r)=>({...r,context:JSON.parse(r.context_json)}));
  }
  setReviewState(reviewId,state) {
    if(!['OPEN','IN_PROGRESS','DEFERRED','RESOLVED'].includes(state))throw new Error('invalid review state');
    const result=this.db.prepare('UPDATE review_items SET state=?,updated_at=? WHERE review_id=?').run(state,new Date().toISOString(),reviewId);
    if(result.changes!==1)throw new Error(`unknown review item '${reviewId}'`);
  }
  addJurisdiction(jurisdiction) {
    const j = validateJurisdiction(jurisdiction);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const source=this.getSource(j.boundary_source.source_id);
      if(!source?.reuse?.private_processing||source.roles?.jurisdiction_boundaries!==true)throw new Error('jurisdiction boundary source must be registered for private boundary processing');
      const metadata={...j.metadata,boundary_source:j.boundary_source};
      const serialized=json(j.boundary),metadataJson=json(metadata);
      const prior=this.db.prepare('SELECT boundary_json,metadata_json FROM jurisdiction_versions WHERE jurisdiction_id=? AND version=?').get(j.jurisdiction_id,j.version);
      if(prior&&(prior.boundary_json!==serialized||prior.metadata_json!==metadataJson))throw new Error('jurisdiction boundary versions are immutable; use a new version for changed geometry or provenance');
      this.db.prepare(`INSERT OR IGNORE INTO jurisdiction_versions(jurisdiction_id,country_code,admin1_code,admin2_code,language,version,effective_from,effective_to,boundary_json,metadata_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(j.jurisdiction_id,j.country_code,j.admin1_code,j.admin2_code,j.language,j.version,j.effective_from,j.effective_to,serialized,metadataJson,new Date().toISOString());
      this.db.prepare(`INSERT INTO jurisdictions(jurisdiction_id,country_code,admin1_code,admin2_code,language,version,effective_from,effective_to,boundary_json,metadata_json)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(jurisdiction_id) DO UPDATE SET country_code=excluded.country_code,admin1_code=excluded.admin1_code,
        admin2_code=excluded.admin2_code,language=excluded.language,version=excluded.version,effective_from=excluded.effective_from,
        effective_to=excluded.effective_to,boundary_json=excluded.boundary_json,metadata_json=excluded.metadata_json`)
        .run(j.jurisdiction_id,j.country_code,j.admin1_code,j.admin2_code,j.language,j.version,j.effective_from,j.effective_to,serialized,metadataJson);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return j.jurisdiction_id;
  }
  listJurisdictions() { return this.db.prepare('SELECT * FROM jurisdictions ORDER BY jurisdiction_id').all().map((j) => ({ ...j,
    boundary: JSON.parse(j.boundary_json), metadata: JSON.parse(j.metadata_json) })); }
  listJurisdictionVersions(jurisdictionId=null) {
    const rows=jurisdictionId?this.db.prepare('SELECT * FROM jurisdiction_versions WHERE jurisdiction_id=? ORDER BY created_at,version').all(jurisdictionId):
      this.db.prepare('SELECT * FROM jurisdiction_versions ORDER BY jurisdiction_id,created_at,version').all();
    return rows.map((j)=>({...j,boundary:JSON.parse(j.boundary_json),metadata:JSON.parse(j.metadata_json)}));
  }
  saveSegment(segment) {
    const coords = segment.geometry.type === 'LineString' ? segment.geometry.coordinates : segment.geometry.coordinates.flat();
    if (coords.length < 2 || coords.some((p) => !Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) throw new Error('segment geometry must contain valid WGS84 line coordinates');
    const bounds = coords.reduce((b, p) => [Math.min(b[0],p[0]),Math.max(b[1],p[0]),Math.min(b[2],p[1]),Math.max(b[3],p[1])], [Infinity,-Infinity,Infinity,-Infinity]);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO route_segments(segment_id,observation_id,ordinal,component_index,classification,confidence,geometry_json,evidence_json,pipeline_version,jurisdiction_ids_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(segment_id) DO UPDATE SET classification=excluded.classification,confidence=excluded.confidence,
        geometry_json=excluded.geometry_json,evidence_json=excluded.evidence_json,pipeline_version=excluded.pipeline_version,jurisdiction_ids_json=excluded.jurisdiction_ids_json`)
        .run(segment.segment_id,segment.observation_id,segment.ordinal,segment.component_index,segment.classification,segment.confidence ?? null,
          json(segment.geometry),json(segment.evidence ?? []),segment.pipeline_version,json(segment.jurisdiction_ids ?? []),segment.created_at ?? new Date().toISOString());
      const rowid = this.db.prepare('SELECT segment_rowid FROM route_segments WHERE segment_id=?').get(segment.segment_id).segment_rowid;
      this.db.prepare('DELETE FROM route_segments_rtree WHERE segment_rowid=?').run(rowid);
      this.db.prepare('INSERT INTO route_segments_rtree(segment_rowid,min_lon,max_lon,min_lat,max_lat) VALUES(?,?,?,?,?)').run(rowid,...bounds);
      this.db.exec('COMMIT'); return segment.segment_id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  querySegments(bbox, { limit = 500 } = {}) {
    validateBbox(bbox);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error('viewport result limit must be 1-2000');
    const sql = `SELECT s.* FROM route_segments s JOIN route_segments_rtree r USING(segment_rowid)
      WHERE r.max_lon>=? AND r.min_lon<=? AND r.max_lat>=? AND r.min_lat<=? ORDER BY s.segment_id LIMIT ?`;
    const rows = bbox[0] <= bbox[2]
      ? this.db.prepare(sql).all(bbox[0],bbox[2],bbox[1],bbox[3],limit)
      : this.db.prepare(sql).all(bbox[0],180,bbox[1],bbox[3],limit).concat(this.db.prepare(sql).all(-180,bbox[2],bbox[1],bbox[3],limit));
    return [...new Map(rows.map((r) => [r.segment_id,r])).values()].sort((a,b) => a.segment_id.localeCompare(b.segment_id)).slice(0,limit).map((r) => ({ ...r, geometry: JSON.parse(r.geometry_json),
        evidence: JSON.parse(r.evidence_json), jurisdiction_ids: JSON.parse(r.jurisdiction_ids_json) }));
  }
  queryCandidateSegments(bbox,{limit=500}={}) {
    validateBbox(bbox);if(!Number.isInteger(limit)||limit<1||limit>2000)throw new Error('candidate viewport result limit must be 1-2000');
    const sql=`SELECT c.*,s.observation_id,s.ordinal,s.component_index,s.classification,s.confidence,s.geometry_json,s.evidence_json,s.pipeline_version,s.jurisdiction_ids_json
      FROM candidates c JOIN route_segments s ON s.segment_id=c.segment_id JOIN route_segments_rtree r USING(segment_rowid)
      WHERE r.max_lon>=? AND r.min_lon<=? AND r.max_lat>=? AND r.min_lat<=? ORDER BY c.candidate_id LIMIT ?`;
    const rows=bbox[0]<=bbox[2]?this.db.prepare(sql).all(bbox[0],bbox[2],bbox[1],bbox[3],limit):
      this.db.prepare(sql).all(bbox[0],180,bbox[1],bbox[3],limit).concat(this.db.prepare(sql).all(-180,bbox[2],bbox[1],bbox[3],limit));
    return [...new Map(rows.map((r)=>[r.candidate_id,r])).values()].sort((a,b)=>a.candidate_id.localeCompare(b.candidate_id)).slice(0,limit).map((r)=>({...r,
      issues:JSON.parse(r.issues_json),matched_rtt_ids:JSON.parse(r.matched_rtt_ids_json),match_details:JSON.parse(r.match_details_json),jurisdiction_ids:JSON.parse(r.jurisdiction_ids_json),
      geometry:JSON.parse(r.geometry_json),evidence:JSON.parse(r.evidence_json)}));
  }
  close() { this.db.close(); }
}

function validateBbox(bbox) {
  if(!Array.isArray(bbox)||bbox.length!==4||bbox.some((x)=>!Number.isFinite(x))||bbox[0]<-180||bbox[0]>180||bbox[2]<-180||bbox[2]>180||bbox[1]<-90||bbox[3]>90||bbox[1]>bbox[3])throw new Error('invalid west,south,east,north bbox');
}

export function validateSourceDefinition(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('source registry entry must be an object');
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(source.source_id ?? '')) throw new Error('source ID must be a stable safe identifier');
  for (const field of ['name','type','organisation','expected_formats','coverage','jurisdiction_ids','location','adapter_version','licence','reuse','roles','update','attribution','rate_limits']) {
    if (source[field] === undefined || source[field] === null) throw new Error(`source registry entry requires ${field}`);
  }
  if (!Array.isArray(source.expected_formats) || !source.expected_formats.length) throw new Error('source expected_formats must be a non-empty array');
  if (!Array.isArray(source.coverage.countries) || !Array.isArray(source.coverage.regions) || !Array.isArray(source.jurisdiction_ids)) throw new Error('source coverage must list countries, regions and jurisdictions');
  for (const role of ['discovery_only','physical_existence','legal_access','routing_network','public_reuse','jurisdiction_boundaries']) if (typeof source.roles[role] !== 'boolean') throw new Error(`source role '${role}' must be explicit`);
  for (const permission of ['private_processing','redistribution','derived_public_use']) if (typeof source.reuse[permission] !== 'boolean') throw new Error(`reuse permission '${permission}' must be explicit`);
  if (source.roles.legal_access && !source.reuse.private_processing) throw new Error('legal evidence source must authorize private processing');
  if (source.roles.public_reuse && !source.reuse.redistribution) throw new Error('public reuse role requires redistribution permission');
  if (!source.licence.name || !source.licence.version || !source.update.mechanism || !source.adapter_version) throw new Error('source licence, version, update mechanism and adapter version are required');
  return JSON.parse(JSON.stringify(source));
}

export function validateJurisdiction(j) {
  if (!j || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,95}$/.test(j.jurisdiction_id ?? '')) throw new Error('jurisdiction requires a stable ID');
  if (!/^[A-Z]{2}$/.test(j.country_code ?? '')) throw new Error('jurisdiction country_code must be ISO alpha-2');
  if (!j.version || !j.boundary || !['Polygon','MultiPolygon'].includes(j.boundary.type)) throw new Error('jurisdiction requires versioned Polygon or MultiPolygon boundary');
  if(!j.boundary_source||!j.boundary_source.source_id||!j.boundary_source.version||!/^([a-f0-9]{64})$/i.test(j.boundary_source.checksum??'')||!j.boundary_source.licence?.name)
    throw new Error('jurisdiction boundary requires registered source, source version, checksum and licence');
  return { admin1_code: null, admin2_code: null, language: null, effective_from: null, effective_to: null, metadata: {}, ...j };
}
