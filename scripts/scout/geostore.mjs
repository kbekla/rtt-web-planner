// Private Scout geospatial metadata store. The original source bytes live in a
// content-addressed private file store; SQLite indexes the versioned records.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { REPO } from '../lib/common.mjs';

export const SCOUT_GEOSCHEMA_VERSION = 11;
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
      CREATE TABLE IF NOT EXISTS osm_way_topology (
        snapshot_id TEXT NOT NULL, edge_id TEXT NOT NULL, osm_version INTEGER NOT NULL,
        node_refs_json TEXT NOT NULL, topology_hash TEXT NOT NULL, status TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(snapshot_id,edge_id),
        FOREIGN KEY(snapshot_id,edge_id) REFERENCES network_edges(snapshot_id,edge_id)
      );
      CREATE TABLE IF NOT EXISTS osm_topology_stage_state (
        snapshot_id TEXT NOT NULL, run_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
        records_seen INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        PRIMARY KEY(snapshot_id,run_id,stage), FOREIGN KEY(snapshot_id) REFERENCES network_snapshots(snapshot_id),
        FOREIGN KEY(run_id) REFERENCES discovery_runs(run_id)
      );
      CREATE TABLE IF NOT EXISTS osm_topology_node_incidence (
        snapshot_id TEXT NOT NULL, run_id TEXT NOT NULL, way_id TEXT NOT NULL, node_id TEXT NOT NULL,
        degree INTEGER NOT NULL CHECK(degree>0), PRIMARY KEY(snapshot_id,run_id,way_id,node_id),
        FOREIGN KEY(snapshot_id) REFERENCES network_snapshots(snapshot_id), FOREIGN KEY(run_id) REFERENCES discovery_runs(run_id)
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
      CREATE TABLE IF NOT EXISTS corridor_hypotheses (
        hypothesis_id TEXT PRIMARY KEY, observation_id TEXT NOT NULL, component_index INTEGER NOT NULL,
        network_snapshot_id TEXT NOT NULL, candidate_ids_json TEXT NOT NULL, connector_segment_ids_json TEXT NOT NULL,
        support_edge_ids_json TEXT NOT NULL, connector_length_m REAL NOT NULL, hypothesis TEXT NOT NULL,
        geometry_gap_filled INTEGER NOT NULL CHECK(geometry_gap_filled IN (0,1)), evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(observation_id) REFERENCES route_observations(observation_id),
        FOREIGN KEY(network_snapshot_id) REFERENCES network_snapshots(snapshot_id)
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
      CREATE TABLE IF NOT EXISTS source_approvals (
        approval_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, approved_by TEXT NOT NULL, scope TEXT NOT NULL,
        approved_at TEXT NOT NULL, revoked_at TEXT, FOREIGN KEY(source_id) REFERENCES source_registry(source_id)
      );
      CREATE TABLE IF NOT EXISTS scout_runs (
        run_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, country_code TEXT NOT NULL,
        region_id TEXT NOT NULL, config_json TEXT NOT NULL, status TEXT NOT NULL, approved_by TEXT NOT NULL,
        approval_scope TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT,
        FOREIGN KEY(source_id) REFERENCES source_registry(source_id), FOREIGN KEY(snapshot_id) REFERENCES network_snapshots(snapshot_id)
      );
      CREATE TABLE IF NOT EXISTS scout_region_plans (
        run_id TEXT PRIMARY KEY, plan_json TEXT NOT NULL, state TEXT NOT NULL,
        stages_json TEXT NOT NULL, approved_by TEXT, approval_scope TEXT,
        approved_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scout_run_observations (
        run_id TEXT NOT NULL, observation_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        checkpoint_json TEXT NOT NULL DEFAULT '{}', pipeline_version TEXT, started_at TEXT, completed_at TEXT, last_error TEXT,
        PRIMARY KEY(run_id,observation_id), FOREIGN KEY(run_id) REFERENCES scout_runs(run_id),
        FOREIGN KEY(observation_id) REFERENCES route_observations(observation_id)
      );
      CREATE TABLE IF NOT EXISTS discovery_runs (
        run_id TEXT PRIMARY KEY, discovery_source_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
        country_code TEXT NOT NULL, region_id TEXT NOT NULL, reference_run_id TEXT,
        config_json TEXT NOT NULL, approved_by TEXT NOT NULL, approval_scope TEXT NOT NULL, status TEXT NOT NULL, checkpoint_edge_rowid INTEGER NOT NULL DEFAULT 0,
        edges_examined INTEGER NOT NULL DEFAULT 0, candidates_created INTEGER NOT NULL DEFAULT 0,
        corroborated_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_error TEXT, FOREIGN KEY(discovery_source_id) REFERENCES source_registry(source_id),
        FOREIGN KEY(snapshot_id) REFERENCES network_snapshots(snapshot_id), FOREIGN KEY(reference_run_id) REFERENCES scout_runs(run_id)
      );
      CREATE TABLE IF NOT EXISTS discovery_candidates (
        candidate_rowid INTEGER PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, source_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
        edge_id TEXT NOT NULL, part_index INTEGER NOT NULL, classification TEXT NOT NULL,
        physical_state TEXT NOT NULL, motorcycle_access TEXT NOT NULL, routability TEXT NOT NULL,
        canonical_status TEXT NOT NULL, access_tag_state TEXT NOT NULL, length_m REAL NOT NULL,
        geometry_json TEXT NOT NULL, tags_json TEXT NOT NULL, provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(run_id,snapshot_id,edge_id,part_index),
        FOREIGN KEY(run_id) REFERENCES discovery_runs(run_id), FOREIGN KEY(source_id) REFERENCES source_registry(source_id),
        FOREIGN KEY(snapshot_id) REFERENCES network_snapshots(snapshot_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS discovery_candidates_rtree USING rtree(candidate_rowid,min_lon,max_lon,min_lat,max_lat);
      CREATE TABLE IF NOT EXISTS discovery_candidate_sources (
        candidate_id TEXT NOT NULL, source_id TEXT NOT NULL, relationship TEXT NOT NULL,
        source_reference TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(candidate_id,source_id,relationship,source_reference),
        FOREIGN KEY(candidate_id) REFERENCES discovery_candidates(candidate_id),
        FOREIGN KEY(source_id) REFERENCES source_registry(source_id)
      );
      CREATE TABLE IF NOT EXISTS discovery_candidate_matches (
        candidate_id TEXT NOT NULL, related_type TEXT NOT NULL, related_id TEXT NOT NULL,
        relationship TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(candidate_id,related_type,related_id,relationship),
        FOREIGN KEY(candidate_id) REFERENCES discovery_candidates(candidate_id)
      );
      CREATE TABLE IF NOT EXISTS physical_corridors (
        corridor_id TEXT PRIMARY KEY, identity_scheme TEXT NOT NULL, created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, current_status TEXT NOT NULL DEFAULT 'ACTIVE'
      );
      CREATE TABLE IF NOT EXISTS physical_corridor_versions (
        corridor_version_rowid INTEGER PRIMARY KEY, corridor_version_id TEXT NOT NULL UNIQUE, corridor_id TEXT NOT NULL, run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL, algorithm_version TEXT NOT NULL, classification TEXT NOT NULL,
        physical_existence TEXT NOT NULL, motorcycle_access TEXT NOT NULL, routability TEXT NOT NULL,
        canonical_status TEXT NOT NULL, review_priority TEXT NOT NULL, length_m REAL NOT NULL,
        node_sequence_hash TEXT NOT NULL, node_sequence_json TEXT NOT NULL, identity_state TEXT NOT NULL, geometry_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(run_id,node_sequence_hash),
        FOREIGN KEY(corridor_id) REFERENCES physical_corridors(corridor_id),
        FOREIGN KEY(run_id) REFERENCES discovery_runs(run_id),
        FOREIGN KEY(snapshot_id) REFERENCES network_snapshots(snapshot_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS physical_corridor_versions_rtree USING rtree(corridor_version_rowid,min_lon,max_lon,min_lat,max_lat);
      CREATE TABLE IF NOT EXISTS physical_corridor_observations (
        corridor_version_id TEXT NOT NULL, candidate_id TEXT NOT NULL, relation TEXT NOT NULL,
        PRIMARY KEY(corridor_version_id,candidate_id),
        FOREIGN KEY(corridor_version_id) REFERENCES physical_corridor_versions(corridor_version_id),
        FOREIGN KEY(candidate_id) REFERENCES discovery_candidates(candidate_id)
      );
      CREATE TABLE IF NOT EXISTS physical_corridor_lineage (
        lineage_id TEXT PRIMARY KEY, from_version_id TEXT NOT NULL, to_version_id TEXT NOT NULL,
        relation TEXT NOT NULL, match_state TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(from_version_id) REFERENCES physical_corridor_versions(corridor_version_id),
        FOREIGN KEY(to_version_id) REFERENCES physical_corridor_versions(corridor_version_id)
      );
      CREATE TABLE IF NOT EXISTS corridor_review_decisions (
        decision_id TEXT PRIMARY KEY, corridor_id TEXT NOT NULL, corridor_version_id TEXT NOT NULL,
        decision TEXT NOT NULL, reviewer TEXT NOT NULL, reason TEXT NOT NULL, decided_at TEXT NOT NULL,
        FOREIGN KEY(corridor_id) REFERENCES physical_corridors(corridor_id),
        FOREIGN KEY(corridor_version_id) REFERENCES physical_corridor_versions(corridor_version_id)
      );
      CREATE TABLE IF NOT EXISTS external_corridor_evidence (
        evidence_id TEXT PRIMARY KEY, corridor_version_id TEXT NOT NULL, corridor_id TEXT NOT NULL, source_id TEXT NOT NULL,
        source_version TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_feature_id TEXT NOT NULL, relationship TEXT NOT NULL,
        geometry_json TEXT NOT NULL, attributes_json TEXT NOT NULL, evidence_json TEXT NOT NULL, retrieved_at TEXT NOT NULL,
        UNIQUE(corridor_version_id,source_id,source_version,source_sha256,source_feature_id),
        FOREIGN KEY(corridor_version_id) REFERENCES physical_corridor_versions(corridor_version_id),
        FOREIGN KEY(corridor_id) REFERENCES physical_corridors(corridor_id), FOREIGN KEY(source_id) REFERENCES source_registry(source_id)
      );
      CREATE INDEX IF NOT EXISTS external_corridor_evidence_corridor_idx ON external_corridor_evidence(corridor_id,retrieved_at);
      CREATE TABLE IF NOT EXISTS corridor_review_queue (
        corridor_version_id TEXT PRIMARY KEY, corridor_id TEXT NOT NULL, state TEXT NOT NULL,
        reason_code TEXT NOT NULL, priority TEXT NOT NULL, ranking_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(corridor_version_id) REFERENCES physical_corridor_versions(corridor_version_id),
        FOREIGN KEY(corridor_id) REFERENCES physical_corridors(corridor_id)
      );
      CREATE TABLE IF NOT EXISTS legal_status_records (
        status_record_id TEXT PRIMARY KEY, corridor_id TEXT, jurisdiction_id TEXT NOT NULL,
        source_id TEXT NOT NULL, source_version TEXT NOT NULL, claim_type TEXT NOT NULL,
        legal_effect TEXT NOT NULL, temporal_kind TEXT NOT NULL, effective_from TEXT, effective_until TEXT,
        published_at TEXT, retrieved_at TEXT NOT NULL, vehicle_classes_json TEXT NOT NULL,
        geometry_reference_json TEXT NOT NULL, source_document_reference TEXT NOT NULL,
        original_language TEXT, original_text_reference TEXT, supersedes_record_id TEXT, extraction TEXT NOT NULL,
        review_state TEXT NOT NULL, qualified INTEGER NOT NULL CHECK(qualified IN (0,1)),
        evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(corridor_id) REFERENCES physical_corridors(corridor_id),
        FOREIGN KEY(jurisdiction_id) REFERENCES jurisdictions(jurisdiction_id),
        FOREIGN KEY(source_id) REFERENCES source_registry(source_id),
        FOREIGN KEY(supersedes_record_id) REFERENCES legal_status_records(status_record_id)
      );
      CREATE TABLE IF NOT EXISTS source_watch_state (
        source_id TEXT PRIMARY KEY, cursor_json TEXT NOT NULL, last_attempt_at TEXT,
        last_success_at TEXT, next_due_at TEXT, failure_count INTEGER NOT NULL DEFAULT 0,
        health TEXT NOT NULL DEFAULT 'UNKNOWN', last_error_code TEXT,
        FOREIGN KEY(source_id) REFERENCES source_registry(source_id)
      );
      CREATE TABLE IF NOT EXISTS source_change_events (
        change_event_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, prior_version TEXT, current_version TEXT,
        prior_sha256 TEXT, current_sha256 TEXT, retrieved_at TEXT NOT NULL, event_type TEXT NOT NULL,
        payload_reference TEXT, details_json TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES source_registry(source_id)
      );
      CREATE TABLE IF NOT EXISTS community_claims (
        claim_id TEXT PRIMARY KEY, corridor_id TEXT, source_id TEXT NOT NULL, claim_type TEXT NOT NULL,
        observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL, geometry_reference_json TEXT NOT NULL,
        media_reference TEXT, provenance_json TEXT NOT NULL, independence_group TEXT,
        freshness_state TEXT NOT NULL, claim_json TEXT NOT NULL,
        FOREIGN KEY(corridor_id) REFERENCES physical_corridors(corridor_id),
        FOREIGN KEY(source_id) REFERENCES source_registry(source_id)
      );
      CREATE TABLE IF NOT EXISTS partner_layers (
        layer_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, owner TEXT NOT NULL, audience TEXT NOT NULL,
        permission_reference TEXT NOT NULL, storage_boundary TEXT NOT NULL, attribution TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)), metadata_json TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES source_registry(source_id)
      );
      CREATE TABLE IF NOT EXISTS network_artifacts (
        snapshot_id TEXT PRIMARY KEY, provider TEXT NOT NULL, source_url TEXT NOT NULL, local_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, etag TEXT, last_modified TEXT, status TEXT NOT NULL,
        updated_at TEXT NOT NULL, FOREIGN KEY(snapshot_id) REFERENCES network_snapshots(snapshot_id)
      );
      CREATE TABLE IF NOT EXISTS network_import_checkpoints (
        snapshot_id TEXT PRIMARY KEY, source_url TEXT NOT NULL, records_seen INTEGER NOT NULL DEFAULT 0,
        edges_written INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, updated_at TEXT NOT NULL,
        normalizer_version TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(snapshot_id) REFERENCES network_snapshots(snapshot_id)
      );
      CREATE TABLE IF NOT EXISTS review_decisions (
        decision_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, decision TEXT NOT NULL, reviewer TEXT NOT NULL,
        reason TEXT NOT NULL, decided_at TEXT NOT NULL, FOREIGN KEY(candidate_id) REFERENCES candidates(candidate_id)
      );
      CREATE INDEX IF NOT EXISTS scout_run_observations_status_idx ON scout_run_observations(run_id,status,observation_id);
      CREATE INDEX IF NOT EXISTS review_decisions_candidate_idx ON review_decisions(candidate_id,decided_at);
      CREATE INDEX IF NOT EXISTS source_files_source_idx ON source_files(source_id, imported_at);
      CREATE INDEX IF NOT EXISTS observations_file_idx ON route_observations(file_id);
      CREATE INDEX IF NOT EXISTS segments_observation_idx ON route_segments(observation_id, ordinal);
      CREATE INDEX IF NOT EXISTS segments_observation_pipeline_idx ON route_segments(observation_id, pipeline_version, ordinal);
      CREATE INDEX IF NOT EXISTS candidates_review_idx ON candidates(review_state, updated_at);
      CREATE INDEX IF NOT EXISTS corridor_hypothesis_observation_idx ON corridor_hypotheses(observation_id,component_index);
      CREATE INDEX IF NOT EXISTS evidence_question_idx ON evidence(question, jurisdiction_id, evidence_time);
      CREATE INDEX IF NOT EXISTS legal_status_corridor_idx ON legal_status_records(corridor_id,jurisdiction_id,effective_from,effective_until);
      CREATE INDEX IF NOT EXISTS legal_status_source_idx ON legal_status_records(source_id,retrieved_at);
      CREATE INDEX IF NOT EXISTS corridor_review_queue_state_idx ON corridor_review_queue(state,priority,updated_at);
    `);
    const version = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get()?.version;
    if(version===1) {
      this.db.exec(`ALTER TABLE candidates ADD COLUMN matched_rtt_ids_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE candidates ADD COLUMN match_details_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE candidates ADD COLUMN network_snapshot_id TEXT;
        ALTER TABLE candidates ADD COLUMN jurisdiction_ids_json TEXT NOT NULL DEFAULT '[]';
        UPDATE schema_version SET version=${SCOUT_GEOSCHEMA_VERSION};`);
    } else if(version===10)this.db.exec(`ALTER TABLE network_import_checkpoints ADD COLUMN normalizer_version TEXT NOT NULL DEFAULT '';
      UPDATE schema_version SET version=${SCOUT_GEOSCHEMA_VERSION};`);
    else if(version===2||version===3||version===4||version===5||version===6||version===7||version===8||version===9)this.db.exec(`UPDATE schema_version SET version=${SCOUT_GEOSCHEMA_VERSION};`);
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
  approveSource({source_id,approved_by,scope,approved_at=new Date().toISOString()}) {
    if(!this.getSource(source_id)||!approved_by?.trim()||!scope?.trim())throw new Error('source approval requires a registered source, reviewer identity and explicit scope');
    const approval_id=`approval-${crypto.createHash('sha256').update(`${source_id}\0${approved_by}\0${scope}\0${approved_at}`).digest('hex').slice(0,24)}`;
    this.db.prepare('INSERT OR IGNORE INTO source_approvals(approval_id,source_id,approved_by,scope,approved_at) VALUES(?,?,?,?,?)').run(approval_id,source_id,approved_by.trim(),scope.trim(),approved_at);
    return this.db.prepare('SELECT * FROM source_approvals WHERE approval_id=?').get(approval_id);
  }
  sourceApproval(sourceId) { return this.db.prepare('SELECT * FROM source_approvals WHERE source_id=? AND revoked_at IS NULL ORDER BY approved_at DESC LIMIT 1').get(sourceId)??null; }
  createRun({run_id,source_id,snapshot_id,country_code,region_id,title,viewport,approved_by,approval_scope}) {
    if(!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(run_id??''))throw new Error('run ID must be a stable safe identifier');
    if(this.getDiscoveryRun(run_id))throw new Error('route-processing run ID conflicts with an existing OSM discovery run');
    const source=this.getSource(source_id),snapshot=this.getNetworkSnapshot(snapshot_id);
    if(!source?.reuse?.private_processing||source.roles?.discovery_only!==true)throw new Error('run source must be registered for private discovery processing');
    if(!snapshot||!this.getSource(snapshot.source_id)?.roles?.routing_network)throw new Error('run requires a registered routing-network snapshot');
    if(!/^[A-Z]{2}$/.test(country_code??'')||!source.coverage.countries.includes(country_code)||!snapshot.coverage.countries?.includes(country_code))throw new Error('run country is not covered by both registered sources');
    if(typeof region_id!=='string'||!region_id.trim()||!Array.isArray(viewport)||viewport.length!==4||viewport.some(v=>!Number.isFinite(v)))throw new Error('run requires region ID and four numeric viewport bounds');
    if(viewport[0]<-180||viewport[2]>180||viewport[1]<-90||viewport[3]>90||viewport[1]>viewport[3])throw new Error('run viewport is invalid');
    if(!approved_by?.trim()||!approval_scope?.trim())throw new Error('run requires explicit operator approval identity and scope');
    const sourceApproval=this.sourceApproval(source_id);
    if(!sourceApproval||sourceApproval.approved_by!==approved_by.trim()||sourceApproval.scope!==approval_scope.trim())throw new Error('source must have a matching explicit active operator approval before a run can be created');
    const config={title:title?.trim()||`${country_code} Scout private review`,viewport,canonical_status:'NOT_COMPARED'};
    const prior=this.db.prepare('SELECT * FROM scout_runs WHERE run_id=?').get(run_id);
    const at=new Date().toISOString();
    if(prior){if(prior.source_id!==source_id||prior.snapshot_id!==snapshot_id||prior.country_code!==country_code||prior.region_id!==region_id||prior.config_json!==json(config)||prior.approved_by!==approved_by||prior.approval_scope!==approval_scope)throw new Error('run ID already exists with different immutable inputs');return this.getRun(run_id);}
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO scout_runs(run_id,source_id,snapshot_id,country_code,region_id,config_json,status,approved_by,approval_scope,created_at,updated_at) VALUES(?,?,?,?,?,?,\'PENDING\',?,?,?,?)')
        .run(run_id,source_id,snapshot_id,country_code,region_id,json(config),approved_by.trim(),approval_scope.trim(),at,at);
      const observations=this.db.prepare('SELECT o.observation_id FROM route_observations o JOIN source_files f USING(file_id) WHERE f.source_id=? ORDER BY o.observation_id').all(source_id);
      const add=this.db.prepare("INSERT INTO scout_run_observations(run_id,observation_id,status) VALUES(?,?,'PENDING')");
      for(const o of observations)add.run(run_id,o.observation_id);
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
    return this.getRun(run_id);
  }
  getRun(runId) {
    const r=this.db.prepare('SELECT * FROM scout_runs WHERE run_id=?').get(runId);if(!r)return null;
    const counts=this.db.prepare("SELECT status,count(*) count FROM scout_run_observations WHERE run_id=? GROUP BY status").all(runId);
    return {...r,config:JSON.parse(r.config_json),observation_counts:Object.fromEntries(counts.map(x=>[x.status,x.count]))};
  }
  listRuns(){return this.db.prepare('SELECT run_id FROM scout_runs ORDER BY created_at,run_id').all().map(r=>this.getRun(r.run_id));}
  createDiscoveryRun({run_id,discovery_source_id,snapshot_id,country_code,region_id,reference_run_id=null,title,viewport,approved_by,approval_scope,config={}}) {
    if(reference_run_id!==null&&reference_run_id!==undefined)throw new Error('discovery runs cannot reference comparison/source-route runs; attach them only in the post-completion benchmark');
    if(!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(run_id??''))throw new Error('discovery run ID must be a stable safe identifier');
    const source=this.getSource(discovery_source_id),snapshot=this.getNetworkSnapshot(snapshot_id);
    if(!source?.reuse?.private_processing||source.roles?.discovery_only!==true||source.roles?.legal_access===true)throw new Error('discovery source must be registered for private discovery and not legal-access evidence');
    if(!snapshot||snapshot.source_id!==source.parent_network_source_id||source.bound_snapshot_id&&snapshot_id!==source.bound_snapshot_id)throw new Error('discovery run requires the registered network snapshot named by its discovery source');
    const networkSource=snapshot&&this.getSource(snapshot.source_id);
    const nvdbNetwork=networkSource?.source_id==='no-nvdb-vegkart'&&networkSource.network_api?.provider==='statens-vegvesen-nvdb-api-les-v4';
    const osmNetwork=String(networkSource?.type??'').toLowerCase().includes('osm');
    if(!networkSource?.roles?.routing_network||networkSource.roles.discovery_only===true||(!osmNetwork&&!nvdbNetwork))throw new Error('independent discovery requires an explicitly supported authoritative or public network source, never a route/discovery corpus');
    if(!snapshot.checksum||this.networkEdgeCount(snapshot_id)<1)throw new Error('discovery run requires a checksum-pinned imported network snapshot');
    if(!/^[A-Z]{2}$/.test(country_code??'')||!source.coverage.countries.includes(country_code)||!snapshot.coverage.countries?.includes(country_code))throw new Error('discovery region is not covered by registered source and snapshot');
    if(typeof region_id!=='string'||!region_id.trim()||!Array.isArray(viewport)||viewport.length!==4||viewport.some(v=>!Number.isFinite(v)))throw new Error('discovery run requires region ID and four numeric viewport bounds');
    if(viewport[0]<-180||viewport[2]>180||viewport[1]<-90||viewport[3]>90||viewport[1]>viewport[3])throw new Error('discovery viewport is invalid');
    if(!approved_by?.trim()||!approval_scope?.trim())throw new Error('discovery run requires explicit operator approval identity and scope');
    const approval=this.sourceApproval(discovery_source_id);if(!approval||approval.approved_by!==approved_by.trim()||approval.scope!==approval_scope.trim())throw new Error('discovery source needs a matching explicit active operator approval');
    if(reference_run_id){const reference=this.getRun(reference_run_id);if(!reference||reference.country_code!==country_code||reference.snapshot_id!==snapshot_id)throw new Error('discovery reference run must use this same country and pinned snapshot');}
    const normalized={title:title??`${region_id} independent Scout discovery`,viewport,canonical_status:'NOT_COMPARED',...config};
    if(this.getRun(run_id))throw new Error('discovery run ID conflicts with an existing route-processing run');
    const encoded=json(normalized),prior=this.db.prepare('SELECT * FROM discovery_runs WHERE run_id=?').get(run_id);
    if(prior){if(prior.discovery_source_id!==discovery_source_id||prior.snapshot_id!==snapshot_id||prior.country_code!==country_code||prior.region_id!==region_id||prior.reference_run_id!==reference_run_id||prior.config_json!==encoded||prior.approved_by!==approved_by.trim()||prior.approval_scope!==approval_scope.trim())throw new Error('discovery run ID already exists with different immutable inputs');return this.getDiscoveryRun(run_id);}
    const at=new Date().toISOString();this.db.prepare(`INSERT INTO discovery_runs(run_id,discovery_source_id,snapshot_id,country_code,region_id,reference_run_id,config_json,approved_by,approval_scope,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'PENDING',?,?)`).run(run_id,discovery_source_id,snapshot_id,country_code,region_id,reference_run_id,encoded,approved_by.trim(),approval_scope.trim(),at,at);
    return this.getDiscoveryRun(run_id);
  }
  getDiscoveryRun(runId){const row=this.db.prepare('SELECT * FROM discovery_runs WHERE run_id=?').get(runId);return row?{...row,config:JSON.parse(row.config_json)}:null;}
  listDiscoveryRuns(){return this.db.prepare('SELECT run_id FROM discovery_runs ORDER BY created_at,run_id').all().map(r=>this.getDiscoveryRun(r.run_id));}
  updateDiscoveryRun(runId,{status,checkpoint_edge_rowid,edges_examined,candidates_created,corroborated_count,last_error=null}={}){
    const allowed=['PENDING','RUNNING','COMPLETE','BLOCKED','REVIEW_REQUIRED','FAILED','SUPERSEDED'];if(status&&!allowed.includes(status))throw new Error('invalid discovery run status');
    for(const n of [checkpoint_edge_rowid,edges_examined,candidates_created,corroborated_count])if(n!==undefined&&(!Number.isSafeInteger(n)||n<0))throw new Error('discovery run checkpoint/counts must be nonnegative integers');
    const changed=this.db.prepare(`UPDATE discovery_runs SET status=coalesce(?,status),checkpoint_edge_rowid=coalesce(?,checkpoint_edge_rowid),
      edges_examined=coalesce(?,edges_examined),candidates_created=coalesce(?,candidates_created),corroborated_count=coalesce(?,corroborated_count),
      last_error=?,updated_at=? WHERE run_id=?`).run(status??null,checkpoint_edge_rowid??null,edges_examined??null,candidates_created??null,corroborated_count??null,last_error,new Date().toISOString(),runId);
    if(changed.changes!==1)throw new Error(`unknown discovery run '${runId}'`);return this.getDiscoveryRun(runId);
  }
  saveDiscoveryCandidateBatch(runId,rows){
    if(!Array.isArray(rows)||rows.length>1000)throw new Error('discovery candidate batch must contain 0-1000 rows');
    const run=this.getDiscoveryRun(runId);if(!run)throw new Error(`unknown discovery run '${runId}'`);
    const insert=this.db.prepare(`INSERT OR IGNORE INTO discovery_candidates(candidate_id,run_id,source_id,snapshot_id,edge_id,part_index,classification,physical_state,motorcycle_access,routability,
      canonical_status,access_tag_state,length_m,geometry_json,tags_json,provenance_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const rowFor=this.db.prepare('SELECT candidate_rowid FROM discovery_candidates WHERE candidate_id=?');
    const addBounds=this.db.prepare('INSERT OR IGNORE INTO discovery_candidates_rtree(candidate_rowid,min_lon,max_lon,min_lat,max_lat) VALUES(?,?,?,?,?)');
    const sourceLink=this.db.prepare('INSERT OR IGNORE INTO discovery_candidate_sources VALUES(?,?,?,?,?,?)');
    const matchLink=this.db.prepare('INSERT OR IGNORE INTO discovery_candidate_matches VALUES(?,?,?,?,?,?)');
    const at=new Date().toISOString();this.db.exec('BEGIN IMMEDIATE');let inserted=0;const newlyCorroborated=new Set();
    try{
      for(const c of rows){
        if(!c.candidate_id||c.run_id&&c.run_id!==runId||c.source_id!==run.discovery_source_id||c.snapshot_id!==run.snapshot_id||!c.edge_id||!Number.isSafeInteger(c.part_index)||c.part_index<0||
          !['ROAD','UNSEALED_ROAD','PROBABLE_OFFROAD','OFFROAD_CONFIRMED','UNKNOWN'].includes(c.classification)||!['unknown','probable'].includes(c.physical_state)||
          c.motorcycle_access!=='unknown'||c.routability!=='unknown'||c.canonical_status!=='NOT_COMPARED'||!['OSM_TAGS_PRESENT','NO_EXPLICIT_ACCESS_TAG','NO_EXPLICIT_MOTORCYCLE_ACCESS_EVIDENCE'].includes(c.access_tag_state)||!Number.isFinite(c.length_m)||c.length_m<0)
          throw new Error('invalid discovery candidate or unsafe access/routability/canonical state');
        const coordinates=c.geometry?.type==='LineString'?c.geometry.coordinates:null;if(!coordinates||coordinates.length<2||coordinates.some(p=>!Array.isArray(p)||p.length<2||p.some(v=>!Number.isFinite(v))))throw new Error('discovery candidate requires one valid LineString part');
        const bounds=coordinates.reduce((b,p)=>[Math.min(b[0],p[0]),Math.max(b[1],p[0]),Math.min(b[2],p[1]),Math.max(b[3],p[1])],[Infinity,-Infinity,Infinity,-Infinity]);
        const result=insert.run(c.candidate_id,runId,c.source_id,c.snapshot_id,c.edge_id,c.part_index,c.classification,c.physical_state,'unknown','unknown','NOT_COMPARED',c.access_tag_state,c.length_m,json(c.geometry),json(c.tags??{}),json(c.provenance??{}),at);if(result.changes)inserted++;
        const row=rowFor.get(c.candidate_id);if(!row)throw new Error('discovery candidate insert was not recoverable');addBounds.run(row.candidate_rowid,...bounds);
        for(const s of c.sources??[])sourceLink.run(c.candidate_id,s.source_id,s.relationship,s.source_reference,json(s.evidence??{}),at);
        for(const m of c.matches??[]){const link=matchLink.run(c.candidate_id,m.related_type,m.related_id,m.relationship,json(m.evidence??{}),at);
          if(link.changes&&m.relationship==='same_osm_network_part_support')newlyCorroborated.add(c.candidate_id);}
      }
      this.db.exec('COMMIT');return {inserted,newly_corroborated:newlyCorroborated.size};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  queryDiscoveryCandidates(runId,bbox,{limit=1000}={}){
    validateBbox(bbox);if(!Number.isInteger(limit)||limit<1||limit>10000)throw new Error('discovery viewport limit must be 1-10000');
    const run=this.getDiscoveryRun(runId);if(!run)throw new Error(`unknown discovery run '${runId}'`);
    const sql=`SELECT c.* FROM discovery_candidates c JOIN discovery_candidates_rtree r USING(candidate_rowid) WHERE c.run_id=? AND r.max_lon>=? AND r.min_lon<=? AND r.max_lat>=? AND r.min_lat<=? ORDER BY c.candidate_id LIMIT ?`;
    const rows=bbox[0]<=bbox[2]?this.db.prepare(sql).all(runId,bbox[0],bbox[2],bbox[1],bbox[3],limit+1):
      this.db.prepare(sql).all(runId,bbox[0],180,bbox[1],bbox[3],limit+1).concat(this.db.prepare(sql).all(runId,-180,bbox[2],bbox[1],bbox[3],limit+1));
    const unique=[...new Map(rows.map(r=>[r.candidate_id,r])).values()].slice(0,limit);
    return {truncated:rows.length>limit,features:unique.map(r=>({...r,geometry:JSON.parse(r.geometry_json),tags:JSON.parse(r.tags_json),provenance:JSON.parse(r.provenance_json),
      sources:this.db.prepare('SELECT source_id,relationship,source_reference,evidence_json FROM discovery_candidate_sources WHERE candidate_id=? ORDER BY source_id,relationship').all(r.candidate_id).map(x=>({...x,evidence:JSON.parse(x.evidence_json)})),
      matches:this.db.prepare('SELECT related_type,related_id,relationship,evidence_json FROM discovery_candidate_matches WHERE candidate_id=? ORDER BY relationship,related_id').all(r.candidate_id).map(x=>({...x,evidence:JSON.parse(x.evidence_json)}))}))};
  }
  saveRegionPlan(plan){
    if(!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(plan?.run_id??'')||!plan?.route_source?.source_id||!plan?.network_source?.source_id||!plan?.provider?.snapshot_id)throw new Error('region plan is missing stable source/provider identities');
    for(const permission of ['private_processing','redistribution','derived_public_use'])if(typeof plan.permissions?.[permission]!=='boolean')throw new Error(`region plan must explicitly record ${permission}`);
    if(typeof plan.permissions.legal_evidence!=='boolean'||plan.permissions.private_processing!==true)throw new Error('region plan needs affirmative private research intent and an explicit legal-evidence role');
    if(plan.permissions.legal_evidence)throw new Error('route-file discovery input cannot be promoted to a legal-evidence source by the regional wizard');
    const normalized=JSON.parse(json(plan)),encoded=json(normalized),prior=this.db.prepare('SELECT plan_json FROM scout_region_plans WHERE run_id=?').get(plan.run_id);
    if(prior){if(prior.plan_json!==encoded)throw new Error('region plan ID already exists with different source, permission, or provider inputs');return this.getRegionPlan(plan.run_id);}
    const at=new Date().toISOString();this.db.prepare('INSERT INTO scout_region_plans(run_id,plan_json,state,stages_json,created_at,updated_at) VALUES(?,?,\'PREPARED\',?,?,?)')
      .run(plan.run_id,encoded,json({inspection:'COMPLETE',provider_resolution:'COMPLETE',route_import:'PENDING',network_acquire:'PENDING',network_import:'PENDING',run_create:'PENDING',processing:'PENDING'}),at,at);
    return this.getRegionPlan(plan.run_id);
  }
  getRegionPlan(runId){const row=this.db.prepare('SELECT * FROM scout_region_plans WHERE run_id=?').get(runId);return row?{...row,plan:JSON.parse(row.plan_json),stages:JSON.parse(row.stages_json)}:null;}
  listRegionPlans(){return this.db.prepare('SELECT run_id FROM scout_region_plans ORDER BY created_at,run_id').all().map(r=>this.getRegionPlan(r.run_id));}
  updateRegionPlan(runId,{state,stage,status_error,approved_by,approval_scope,approved_at}={}){
    const prior=this.getRegionPlan(runId);if(!prior)throw new Error(`unknown Scout region plan '${runId}'`);
    const allowed=['PREPARED','APPROVED','RUNNING','BLOCKED','REVIEW_REQUIRED','COMPLETE','FAILED'];
    if(state&&!allowed.includes(state))throw new Error('invalid region plan state');
    const stages={...prior.stages};if(stage){if(typeof stage.name!=='string'||!['PENDING','RUNNING','COMPLETE','BLOCKED','FAILED','REVIEW_REQUIRED'].includes(stage.status))throw new Error('invalid region plan stage update');stages[stage.name]=stage.status;}
    const nextApproval=approved_by?{approved_by:approved_by.trim(),approval_scope:approval_scope?.trim(),approved_at:approved_at??new Date().toISOString()}:{};
    if(approved_by&&(!approved_by.trim()||!nextApproval.approval_scope))throw new Error('region plan approval requires operator and scope');
    this.db.prepare(`UPDATE scout_region_plans SET state=coalesce(?,state),stages_json=?,approved_by=coalesce(?,approved_by),approval_scope=coalesce(?,approval_scope),approved_at=coalesce(?,approved_at),last_error=?,updated_at=? WHERE run_id=?`)
      .run(state??null,json(stages),nextApproval.approved_by??null,nextApproval.approval_scope??null,nextApproval.approved_at??null,status_error??null,new Date().toISOString(),runId);
    return this.getRegionPlan(runId);
  }
  runObservations(runId){return this.db.prepare(`SELECT ro.*,o.source_part,o.source_name FROM scout_run_observations ro JOIN route_observations o USING(observation_id)
    WHERE ro.run_id=? ORDER BY ro.observation_id`).all(runId).map(r=>({...r,checkpoint:JSON.parse(r.checkpoint_json)}));}
  setRunStatus(runId,status,{last_error=null}={}){
    if(!['PENDING','RUNNING','COMPLETE','BLOCKED','REVIEW_REQUIRED','FAILED','SUPERSEDED'].includes(status))throw new Error('invalid Scout run status');
    const result=this.db.prepare('UPDATE scout_runs SET status=?,last_error=?,updated_at=? WHERE run_id=?').run(status,last_error,new Date().toISOString(),runId);
    if(result.changes!==1)throw new Error(`unknown Scout run '${runId}'`);
  }
  setRunObservation(runId,observationId,status,{checkpoint={},error=null,pipeline_version=null}={}){
    if(!['PENDING','RUNNING','COMPLETE','BLOCKED','REVIEW_REQUIRED','FAILED','SUPERSEDED'].includes(status))throw new Error('invalid run observation status');
    const at=new Date().toISOString(),result=this.db.prepare(`UPDATE scout_run_observations SET status=?,attempts=attempts+?,checkpoint_json=?,pipeline_version=COALESCE(?,pipeline_version),
      started_at=CASE WHEN ?='RUNNING' THEN COALESCE(started_at,?) ELSE started_at END,completed_at=CASE WHEN ?='COMPLETE' THEN ? ELSE completed_at END,last_error=?
      WHERE run_id=? AND observation_id=?`).run(status,status==='RUNNING'?1:0,json(checkpoint),pipeline_version,status,at,status,at,error,runId,observationId);
    if(result.changes!==1)throw new Error('observation is not part of this run');
  }
  recordNetworkArtifact(artifact){
    const snap=this.getNetworkSnapshot(artifact.snapshot_id);if(!snap||!artifact.provider||!artifact.source_url||!artifact.local_path||!Number.isSafeInteger(artifact.byte_size)||artifact.byte_size<1||!/^[a-f0-9]{64}$/i.test(artifact.sha256??''))throw new Error('network artifact requires registered snapshot and verified private file metadata');
    const resolved=path.resolve(artifact.local_path),root=fs.realpathSync(this.root);
    if(resolved!==root&&!resolved.startsWith(root+path.sep))throw new Error('network artifact must remain inside the private Scout data root');
    const real=fs.realpathSync(resolved);if(real===root||!real.startsWith(root+path.sep)||fs.lstatSync(resolved).isSymbolicLink()||!fs.statSync(resolved).isFile())throw new Error('network artifact must be a regular non-symlink file inside the private Scout root');
    const at=new Date().toISOString();this.db.prepare(`INSERT INTO network_artifacts(snapshot_id,provider,source_url,local_path,byte_size,sha256,etag,last_modified,status,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'VERIFIED',?) ON CONFLICT(snapshot_id) DO UPDATE SET provider=excluded.provider,source_url=excluded.source_url,local_path=excluded.local_path,
      byte_size=excluded.byte_size,sha256=excluded.sha256,etag=excluded.etag,last_modified=excluded.last_modified,status='VERIFIED',updated_at=excluded.updated_at`)
      .run(artifact.snapshot_id,artifact.provider,artifact.source_url,artifact.local_path,artifact.byte_size,artifact.sha256.toLowerCase(),artifact.etag??null,artifact.last_modified??null,at);
  }
  getNetworkArtifact(snapshotId){return this.db.prepare('SELECT * FROM network_artifacts WHERE snapshot_id=?').get(snapshotId)??null;}
  networkImportCheckpoint(snapshotId){return this.db.prepare('SELECT * FROM network_import_checkpoints WHERE snapshot_id=?').get(snapshotId)??null;}
  networkEdgeCount(snapshotId){return this.db.prepare('SELECT count(*) count FROM network_edges WHERE snapshot_id=?').get(snapshotId).count;}
  networkExtent(snapshotId){
    if(!this.getNetworkSnapshot(snapshotId))throw new Error(`unknown network snapshot '${snapshotId}'`);
    const row=this.db.prepare(`SELECT min(r.min_lon) west,min(r.min_lat) south,max(r.max_lon) east,max(r.max_lat) north
      FROM network_edges e JOIN network_edges_rtree r USING(edge_rowid) WHERE e.snapshot_id=?`).get(snapshotId);
    return row&&[row.west,row.south,row.east,row.north].every(Number.isFinite)?[row.west,row.south,row.east,row.north]:null;
  }
  setNetworkImportCheckpoint(snapshotId,{source_url,records_seen,edges_written,status,normalizer_version=''}){
    if(!this.getNetworkSnapshot(snapshotId)||!source_url||!Number.isSafeInteger(records_seen)||records_seen<0||!Number.isSafeInteger(edges_written)||edges_written<0||!['RUNNING','YIELDED','COMPLETE','FAILED'].includes(status))throw new Error('invalid network import checkpoint');
    if(typeof normalizer_version!=='string')throw new Error('invalid network normalizer version');
    this.db.prepare(`INSERT INTO network_import_checkpoints(snapshot_id,source_url,records_seen,edges_written,status,updated_at,normalizer_version) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_id) DO UPDATE SET source_url=excluded.source_url,records_seen=excluded.records_seen,edges_written=excluded.edges_written,status=excluded.status,updated_at=excluded.updated_at,normalizer_version=excluded.normalizer_version`)
      .run(snapshotId,source_url,records_seen,edges_written,status,new Date().toISOString(),normalizer_version);
  }
  recordReviewDecision({candidate_id,decision,reviewer,reason,decided_at=new Date().toISOString()}){
    const states=['UNREVIEWED','ACCEPT_FOR_RESEARCH','NEEDS_MORE_EVIDENCE','REJECT_FALSE_POSITIVE','AMBIGUOUS','HOLD'];
    if(!this.db.prepare('SELECT 1 FROM candidates WHERE candidate_id=?').get(candidate_id)||!states.includes(decision)||decision==='UNREVIEWED'||!reviewer?.trim()||!reason?.trim())throw new Error('review decision requires an existing candidate, valid decision, reviewer and reason');
    const decision_id=`decision-${crypto.randomUUID()}`;this.db.prepare('INSERT INTO review_decisions VALUES(?,?,?,?,?,?)').run(decision_id,candidate_id,decision,reviewer.trim(),reason.trim(),decided_at);
    return this.db.prepare('SELECT * FROM review_decisions WHERE decision_id=?').get(decision_id);
  }
  latestReviewDecision(candidateId){return this.db.prepare('SELECT * FROM review_decisions WHERE candidate_id=? ORDER BY decided_at DESC,decision_id DESC LIMIT 1').get(candidateId)??null;}
  listRunReviewCandidates({runId=null,decision='UNREVIEWED'}={}){
    const allowed=['UNREVIEWED','ACCEPT_FOR_RESEARCH','NEEDS_MORE_EVIDENCE','REJECT_FALSE_POSITIVE','AMBIGUOUS','HOLD','ALL'];
    if(!allowed.includes(decision))throw new Error('invalid candidate review decision filter');
    const whereRun=runId?'AND ro.run_id=?':'',params=runId?[runId]:[];
    const rows=this.db.prepare(`SELECT DISTINCT ro.run_id,r.country_code,r.region_id,o.observation_id,c.candidate_id,c.segment_id,c.master_match,c.physical_state,c.motorcycle_access,c.routability,c.issues_json,s.classification,s.confidence
      FROM scout_run_observations ro JOIN scout_runs r USING(run_id) JOIN route_observations o USING(observation_id)
      JOIN route_segments s ON s.observation_id=o.observation_id AND s.pipeline_version=ro.pipeline_version
      JOIN candidates c USING(segment_id) WHERE ro.status='COMPLETE' ${whereRun}
      ORDER BY ro.run_id,c.candidate_id`).all(...params);
    return rows.map((row)=>{
      const latest=this.latestReviewDecision(row.candidate_id),reviewDecision=latest?.decision??'UNREVIEWED';
      return {...row,issues:JSON.parse(row.issues_json),decision:reviewDecision,reviewer:latest?.reviewer??null,reason:latest?.reason??null,decided_at:latest?.decided_at??null};
    }).filter(row=>decision==='ALL'||row.decision===decision);
  }
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
    this.saveNetworkEdges(snapshotId, [edge]);
    return edge.edge_id;
  }
  // Batch insertion keeps network-snapshot import bounded and restart-safe.
  // Each caller chooses a modest batch size; a crash rolls back only that batch
  // and stable edge IDs make replay idempotent.
  saveNetworkEdges(snapshotId, edges) {
    if (!this.getNetworkSnapshot(snapshotId)) throw new Error(`unknown network snapshot '${snapshotId}'`);
    if (!Array.isArray(edges) || edges.length > 5000) throw new Error('network edge batch must contain 0-5000 edges');
    const insert = this.db.prepare(`INSERT INTO network_edges(snapshot_id,edge_id,geometry_json,tags_json,evidence_json,jurisdiction_ids_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(snapshot_id,edge_id) DO UPDATE SET geometry_json=excluded.geometry_json,tags_json=excluded.tags_json,evidence_json=excluded.evidence_json,jurisdiction_ids_json=excluded.jurisdiction_ids_json`);
    const rowFor = this.db.prepare('SELECT edge_rowid FROM network_edges WHERE snapshot_id=? AND edge_id=?');
    const removeBounds = this.db.prepare('DELETE FROM network_edges_rtree WHERE edge_rowid=?');
    const addBounds = this.db.prepare('INSERT INTO network_edges_rtree(edge_rowid,min_lon,max_lon,min_lat,max_lat) VALUES(?,?,?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const edge of edges) {
        const parts=edge.geometry?.type==='LineString'?[edge.geometry.coordinates]:edge.geometry?.type==='MultiLineString'?edge.geometry.coordinates:[];
        const coords=parts.flat();
        if(!edge.edge_id||coords.length<2||coords.some((p)=>!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1])||Math.abs(p[0])>180||Math.abs(p[1])>90))throw new Error('network edge requires stable ID and valid WGS84 line geometry');
        insert.run(snapshotId,edge.edge_id,json(edge.geometry),json(edge.tags??{}),json(edge.evidence??[]),json(edge.jurisdiction_ids??[]));
        const row=rowFor.get(snapshotId,edge.edge_id);
        const bounds=coords.reduce((b,p)=>[Math.min(b[0],p[0]),Math.max(b[1],p[0]),Math.min(b[2],p[1]),Math.max(b[3],p[1])],[Infinity,-Infinity,Infinity,-Infinity]);
        removeBounds.run(row.edge_rowid);addBounds.run(row.edge_rowid,...bounds);
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return edges.length;
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
  saveCorridorHypothesis(hypothesis) {
    const required=['hypothesis_id','observation_id','component_index','network_snapshot_id','candidate_ids','connector_segment_ids','support_edge_ids','connector_length_m','hypothesis','evidence'];
    if(required.some((key)=>hypothesis?.[key]==null)||!Array.isArray(hypothesis.candidate_ids)||hypothesis.candidate_ids.length<2||
      !Array.isArray(hypothesis.connector_segment_ids)||!Array.isArray(hypothesis.support_edge_ids)||!hypothesis.support_edge_ids.length||
      !Number.isFinite(hypothesis.connector_length_m)||hypothesis.connector_length_m<0||hypothesis.geometry_gap_filled!==false)
      throw new Error('corridor continuity hypothesis must be a non-destructive, evidence-backed connector record');
    if(!this.getObservation(hypothesis.observation_id)||!this.getNetworkSnapshot(hypothesis.network_snapshot_id))throw new Error('corridor hypothesis references unknown observation or network snapshot');
    const candidateIds=[...hypothesis.candidate_ids].sort(),connectorIds=[...hypothesis.connector_segment_ids],edgeIds=[...hypothesis.support_edge_ids].sort();
    for(const id of candidateIds)if(!this.db.prepare('SELECT 1 FROM candidates WHERE candidate_id=?').get(id))throw new Error(`corridor hypothesis references unknown candidate '${id}'`);
    for(const id of connectorIds)if(!this.db.prepare('SELECT 1 FROM route_segments WHERE segment_id=?').get(id))throw new Error(`corridor hypothesis references unknown connector segment '${id}'`);
    const prior=this.db.prepare('SELECT candidate_ids_json,connector_segment_ids_json,support_edge_ids_json,evidence_json FROM corridor_hypotheses WHERE hypothesis_id=?').get(hypothesis.hypothesis_id);
    if(prior&&(prior.candidate_ids_json!==json(candidateIds)||prior.connector_segment_ids_json!==json(connectorIds)||prior.support_edge_ids_json!==json(edgeIds)||prior.evidence_json!==json(hypothesis.evidence)))
      throw new Error('corridor hypothesis identity collision with different evidence');
    this.db.prepare(`INSERT OR IGNORE INTO corridor_hypotheses(hypothesis_id,observation_id,component_index,network_snapshot_id,candidate_ids_json,connector_segment_ids_json,
      support_edge_ids_json,connector_length_m,hypothesis,geometry_gap_filled,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(hypothesis.hypothesis_id,hypothesis.observation_id,hypothesis.component_index,hypothesis.network_snapshot_id,json(candidateIds),json(connectorIds),json(edgeIds),
        hypothesis.connector_length_m,hypothesis.hypothesis,0,json(hypothesis.evidence),new Date().toISOString());
    return this.db.prepare('SELECT * FROM corridor_hypotheses WHERE hypothesis_id=?').get(hypothesis.hypothesis_id);
  }
  listCorridorHypotheses(observationId=null) {
    const rows=observationId?this.db.prepare('SELECT * FROM corridor_hypotheses WHERE observation_id=? ORDER BY component_index,hypothesis_id').all(observationId):
      this.db.prepare('SELECT * FROM corridor_hypotheses ORDER BY observation_id,component_index,hypothesis_id').all();
    return rows.map((r)=>({...r,candidate_ids:JSON.parse(r.candidate_ids_json),connector_segment_ids:JSON.parse(r.connector_segment_ids_json),
      support_edge_ids:JSON.parse(r.support_edge_ids_json),evidence:JSON.parse(r.evidence_json),geometry_gap_filled:Boolean(r.geometry_gap_filled)}));
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
  const claimRoles = new Set(['DISCOVERY_HINT','PHYSICAL_EXISTENCE','PHYSICAL_CHARACTER','NETWORK_IDENTITY','NETWORK_CONTEXT','LEGAL_ACCESS','TEMPORARY_RESTRICTION','PERMANENT_RESTRICTION','ROUTING_NETWORK','SURFACE','CLOSURE','CORROBORATION']);
  if (source.evidence_roles !== undefined && (!Array.isArray(source.evidence_roles) || source.evidence_roles.some(role => !claimRoles.has(role)))) throw new Error('source evidence_roles must be a list of registered claim roles');
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
