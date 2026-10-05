import crypto from 'node:crypto';
import { sourceAutomationDecision } from './corridor-evidence.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const json = value => JSON.stringify(ordered(value));
const RELATIONSHIPS = new Set(['EXACT', 'LIKELY', 'PARTIAL', 'PARALLEL', 'AMBIGUOUS', 'NO_MATCH']);

/** Persist external network comparisons as private source evidence, never as access or routing truth. */
export function saveExternalNetworkEvidence(store, { sourceId, sourceVersion, sourceSha256, retrievedAt = new Date().toISOString(), matches } = {}) {
  const source = store.getSource(sourceId);
  if (!source || !sourceAutomationDecision(source).allowed) throw new Error('external network evidence is blocked by source reuse policy');
  if (!store.sourceApproval(sourceId)) throw new Error('external network evidence requires explicit active source approval');
  if (!source.evidence_roles?.some(role => ['PHYSICAL_EXISTENCE', 'NETWORK_IDENTITY', 'NETWORK_CONTEXT'].includes(role))) throw new Error('source has no registered physical/network evidence role');
  if (!sourceVersion || !/^[a-f0-9]{64}$/i.test(sourceSha256 ?? '') || !Number.isFinite(Date.parse(retrievedAt)) || !Array.isArray(matches)) throw new Error('external network evidence needs pinned version, SHA-256, retrieval timestamp and match records');
  for (const row of matches) {
    if (!row?.corridor_id || !row?.corridor_version_id || !row?.feature?.source_feature_id || row.feature.source_id !== sourceId || row.feature.source_version !== sourceVersion || !RELATIONSHIPS.has(row.match?.relationship)) throw new Error('external corridor match has incomplete or inconsistent provenance');
    if (!row.feature.geometry || !Array.isArray(row.match.identity_basis) || row.match.motorcycle_access_effect !== 'NONE' || row.match.routability_effect !== 'NONE') throw new Error('external corridor evidence must retain geometry basis and leave access/routability unchanged');
  }
  const insert = store.db.prepare(`INSERT OR IGNORE INTO external_corridor_evidence
    (evidence_id,corridor_version_id,corridor_id,source_id,source_version,source_sha256,source_feature_id,relationship,geometry_json,attributes_json,evidence_json,retrieved_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of matches) {
      const evidenceId = `xev-${hash(`${row.corridor_version_id}\0${sourceId}\0${sourceVersion}\0${sourceSha256}\0${row.feature.source_feature_id}`).slice(0, 24)}`;
      const evidence = { ...row.match, authority: source.authority ?? null, evidence_roles: source.evidence_roles, lineage: source.lineage ?? null, source_retrieved_at: retrievedAt, source_sha256: sourceSha256.toLowerCase() };
      const result = insert.run(evidenceId,row.corridor_version_id,row.corridor_id,sourceId,sourceVersion,sourceSha256.toLowerCase(),row.feature.source_feature_id,row.match.relationship,
        json(row.feature.geometry),json(row.feature.attributes ?? {}),json(evidence),retrievedAt);
      inserted += Number(result.changes);
      if (!result.changes) {
        const old=store.db.prepare(`SELECT relationship,geometry_json,attributes_json,evidence_json FROM external_corridor_evidence WHERE evidence_id=?`).get(evidenceId);
        if (!old || old.relationship!==row.match.relationship || old.geometry_json!==json(row.feature.geometry) || old.attributes_json!==json(row.feature.attributes??{}) || old.evidence_json!==json(evidence)) {
          throw new Error('external source feature changed under the same pinned source version; checksum/version must be reviewed');
        }
      }
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return { inserted, supplied: matches.length };
}

export function listExternalCorridorEvidence(db, corridorId) {
  return db.prepare(`SELECT evidence_id,corridor_version_id,source_id,source_version,source_sha256,source_feature_id,relationship,geometry_json,attributes_json,evidence_json,retrieved_at
    FROM external_corridor_evidence WHERE corridor_id=? ORDER BY retrieved_at DESC,source_id,source_feature_id`).all(corridorId)
    .map(row => ({ evidence_id: row.evidence_id, corridor_version_id: row.corridor_version_id, source_id: row.source_id, source_version: row.source_version, source_sha256: row.source_sha256,
      source_feature_id: row.source_feature_id, relationship: row.relationship, geometry: JSON.parse(row.geometry_json), attributes: JSON.parse(row.attributes_json),
      evidence: JSON.parse(row.evidence_json), retrieved_at: row.retrieved_at }));
}
