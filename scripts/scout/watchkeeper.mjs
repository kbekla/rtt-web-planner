import crypto from 'node:crypto';
import { communityClaimEffect, sourceAutomationDecision, validateLegalStatusRecord } from './corridor-evidence.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const at = () => new Date().toISOString();
const stable = value => JSON.stringify(value, (_key, entry) => Array.isArray(entry) ? entry : entry && typeof entry === 'object'
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);

export function sourcePollDecision(source, state, now = new Date(), { approved = false } = {}) {
  const interval = Number(source?.update?.poll_interval_seconds ?? source?.update_frequency_seconds);
  if (!Number.isFinite(interval) || interval < 60) return { due: false, state: 'REVIEW_REQUIRED', reason: 'source-specific polling interval is missing or unsafe' };
  if (!sourceAutomationDecision(source).allowed) return { due: false, state: 'REVIEW_REQUIRED', reason: 'source licence/use policy is incomplete' };
  if (approved !== true) return { due: false, state: 'REVIEW_REQUIRED', reason: 'source has not been explicitly approved for scheduled retrieval' };
  if (!state?.last_success_at) return { due: true, state: 'DUE', reason: 'no successful fetch recorded' };
  const next = state.next_due_at ? Date.parse(state.next_due_at) : Date.parse(state.last_success_at) + interval * 1000;
  if (!Number.isFinite(next)) return { due: false, state: 'REVIEW_REQUIRED', reason: 'source next-due timestamp is invalid' };
  return { due: now.getTime() >= next, state: now.getTime() >= next ? 'DUE' : 'CURRENT', next_due_at: new Date(next).toISOString() };
}

export function recordSourceFetch(store, { sourceId, version, sha256, retrievedAt = at(), payloadReference = null } = {}) {
  const source = store.getSource(sourceId); if (!source) throw new Error('source fetch needs a registered source');
  if (!sourceAutomationDecision(source).allowed) throw new Error('source fetch is blocked pending licence and private-use review');
  if (!store.sourceApproval(sourceId)) throw new Error('source fetch requires explicit active source approval');
  if (!/^[a-f0-9]{64}$/i.test(sha256 ?? '') || !version || !Number.isFinite(Date.parse(retrievedAt))) throw new Error('source fetch needs a version, retrieval time and SHA-256');
  const previous = store.db.prepare('SELECT * FROM source_watch_state WHERE source_id=?').get(sourceId);
  const priorEvent = store.db.prepare('SELECT current_version,current_sha256 FROM source_change_events WHERE source_id=? ORDER BY retrieved_at DESC LIMIT 1').get(sourceId);
  const changed = Boolean(priorEvent && (priorEvent.current_version !== version || priorEvent.current_sha256 !== sha256));
  const eventType = !priorEvent ? 'INITIAL_SNAPSHOT' : changed ? 'SOURCE_CHANGED' : 'NO_CHANGE';
  const eventId = `chg-${hash(`${sourceId}\0${version}\0${sha256}\0${retrievedAt}`).slice(0, 24)}`;
  const interval = Number(source.update?.poll_interval_seconds ?? source.update_frequency_seconds);
  const nextDue = Number.isFinite(interval) && interval >= 60 ? new Date(Date.parse(retrievedAt) + interval * 1000).toISOString() : null;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare(`INSERT OR IGNORE INTO source_change_events(change_event_id,source_id,prior_version,current_version,prior_sha256,current_sha256,retrieved_at,event_type,payload_reference,details_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(eventId, sourceId, priorEvent?.current_version ?? null, version, priorEvent?.current_sha256 ?? null, sha256.toLowerCase(), retrievedAt,
      eventType, payloadReference, JSON.stringify({ changed }));
    store.db.prepare(`INSERT INTO source_watch_state(source_id,cursor_json,last_attempt_at,last_success_at,next_due_at,failure_count,health,last_error_code)
      VALUES(?,?,?,?,?,0,'GREEN',NULL) ON CONFLICT(source_id) DO UPDATE SET cursor_json=excluded.cursor_json,last_attempt_at=excluded.last_attempt_at,
      last_success_at=excluded.last_success_at,next_due_at=excluded.next_due_at,failure_count=0,health='GREEN',last_error_code=NULL`)
      .run(sourceId, JSON.stringify({ version, sha256: sha256.toLowerCase(), retrieved_at: retrievedAt }), retrievedAt, retrievedAt, nextDue);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return { event_id: eventId, event_type: eventType, changed, next_due_at: nextDue };
}

export function recordSourceFailure(store, { sourceId, errorCode, failedAt = at() } = {}) {
  const source = store.getSource(sourceId); if (!source) throw new Error('source failure needs a registered source');
  const prior = store.db.prepare('SELECT failure_count FROM source_watch_state WHERE source_id=?').get(sourceId), failures = Number(prior?.failure_count ?? 0) + 1;
  const policy = source.update?.retry_policy ?? {}, base = Number(policy.base_seconds), max = Number(policy.max_seconds), maxRetries = Number(policy.max_retries);
  if (![base, max, maxRetries].every(Number.isFinite) || base < 1 || max < base || maxRetries < 1) {
    store.db.prepare(`INSERT INTO source_watch_state(source_id,cursor_json,last_attempt_at,failure_count,health,last_error_code) VALUES(?,'{}',?,?, 'AMBER','RETRY_POLICY_REVIEW_REQUIRED')
      ON CONFLICT(source_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,failure_count=excluded.failure_count,health='AMBER',last_error_code=excluded.last_error_code`)
      .run(sourceId, failedAt, failures);
    return { state: 'AMBER', retry_at: null, reason: 'source retry policy is not explicitly configured' };
  }
  const retry = failures > maxRetries ? null : new Date(Date.parse(failedAt) + Math.min(max, base * 2 ** (failures - 1)) * 1000).toISOString();
  store.db.prepare(`INSERT INTO source_watch_state(source_id,cursor_json,last_attempt_at,next_due_at,failure_count,health,last_error_code) VALUES(?,'{}',?,?,?,?,?)
    ON CONFLICT(source_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,next_due_at=excluded.next_due_at,failure_count=excluded.failure_count,health=excluded.health,last_error_code=excluded.last_error_code`)
    .run(sourceId, failedAt, retry, failures, retry ? 'AMBER' : 'RED', String(errorCode ?? 'SOURCE_FAILURE').slice(0, 80));
  return { state: retry ? 'AMBER' : 'RED', retry_at: retry, failure_count: failures };
}

export function saveLegalStatusRecord(store, record) {
  const source = store.getSource(record?.source_id); if (!source) throw new Error('legal status source is not registered');
  if (!store.sourceApproval(record.source_id)) throw new Error('legal status ingestion requires explicit source approval');
  validateLegalStatusRecord(record, source);
  if (!store.db.prepare('SELECT 1 FROM jurisdictions WHERE jurisdiction_id=?').get(record.jurisdiction_id)) throw new Error('legal status jurisdiction is not registered');
  if (record.corridor_id && !store.db.prepare('SELECT 1 FROM physical_corridors WHERE corridor_id=?').get(record.corridor_id)) throw new Error('legal status corridor is not registered');
  if (record.supersedes_record_id) {
    const previous = store.db.prepare('SELECT source_id,jurisdiction_id,corridor_id FROM legal_status_records WHERE status_record_id=?').get(record.supersedes_record_id);
    if (!previous || previous.source_id !== record.source_id || previous.jurisdiction_id !== record.jurisdiction_id || previous.corridor_id !== (record.corridor_id ?? null)) throw new Error('amendment must supersede a record for the same source, corridor and jurisdiction');
  }
  if (record.qualified === true && (record.extraction !== 'HUMAN_VERIFIED' || source.authority?.category !== 'AUTHORITATIVE' || record.review_state !== 'VERIFIED' || record.geometry_identity !== 'MATCHED' || record.jurisdiction_identity !== 'MATCHED')) throw new Error('only human-verified authoritative records with matched geometry and jurisdiction may be qualified as legal evidence');
  const statusId = record.status_record_id ?? `legal-${hash(stable({ source_id: record.source_id, source_version: record.source_version, source_document_reference: record.source_document_reference,
    geometry_reference: record.geometry_reference, legal_effect: record.legal_effect, effective_from: record.effective_from, effective_until: record.effective_until, supersedes: record.supersedes_record_id ?? null })).slice(0, 24)}`;
  const persisted = { ...record, status_record_id: statusId, qualified: record.qualified === true, review_state: record.qualified ? 'VERIFIED' : (record.review_state ?? 'NEEDS_HUMAN_REVIEW') };
  const old = store.db.prepare('SELECT evidence_json FROM legal_status_records WHERE status_record_id=?').get(statusId);
  if(old){if(old.evidence_json!==JSON.stringify(persisted))throw new Error('legal status record identity collision with changed evidence');return {status_record_id:statusId,review_state:persisted.review_state,qualified:persisted.qualified,reused:true};}
  store.db.prepare(`INSERT OR IGNORE INTO legal_status_records(status_record_id,corridor_id,jurisdiction_id,source_id,source_version,claim_type,legal_effect,temporal_kind,
    effective_from,effective_until,published_at,retrieved_at,vehicle_classes_json,geometry_reference_json,source_document_reference,original_language,original_text_reference,
    supersedes_record_id,extraction,review_state,qualified,evidence_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(statusId, record.corridor_id ?? null, record.jurisdiction_id, record.source_id, record.source_version ?? String(source.revision),
    record.claim_type, record.legal_effect, record.temporal_kind, record.effective_from ?? null, record.effective_until ?? null, record.published_at ?? null, record.retrieved_at,
    JSON.stringify(record.vehicle_classes), JSON.stringify(record.geometry_reference), record.source_document_reference, record.original_language ?? null,
    record.original_text_reference ?? null, record.supersedes_record_id ?? null, record.extraction ?? 'DETERMINISTIC', persisted.review_state, persisted.qualified ? 1 : 0,
    JSON.stringify(persisted), record.created_at ?? at());
  return { status_record_id: statusId, review_state: persisted.review_state, qualified: persisted.qualified };
}

export function saveCommunityClaim(store, claim, { now = at(), freshDays = 180 } = {}) {
  const source = store.getSource(claim?.source_id); if (!source || source.reuse?.private_processing !== true) throw new Error('community claim source is not approved for private processing');
  if (!store.sourceApproval(claim.source_id)) throw new Error('community claim source requires explicit active source approval');
  const effect = communityClaimEffect(claim, { at: now, freshDays });
  const id = claim.claim_id ?? `claim-${hash(stable({ source_id: claim.source_id, source_reference: claim.source_reference, claim_type: claim.claim_type, observed_at: claim.observed_at })).slice(0, 24)}`;
  const prior=store.db.prepare('SELECT claim_json FROM community_claims WHERE claim_id=?').get(id),claimJson=stable(claim);
  if(prior){const old=JSON.parse(prior.claim_json);if(stable(old)!==stable(claim))throw new Error('community claim identity collision with changed evidence');
    store.db.prepare('UPDATE community_claims SET freshness_state=? WHERE claim_id=?').run(effect.fresh?'FRESH':'STALE',id);return {claim_id:id,...effect,reused:true};}
  store.db.prepare(`INSERT OR IGNORE INTO community_claims(claim_id,corridor_id,source_id,claim_type,observed_at,recorded_at,geometry_reference_json,media_reference,
    provenance_json,independence_group,freshness_state,claim_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, claim.corridor_id ?? null, claim.source_id, claim.claim_type, claim.observed_at,
    now, JSON.stringify(claim.geometry_reference ?? null), claim.media_reference ?? null, JSON.stringify(claim.provenance ?? {}), claim.independence_group ?? claim.source_reference ?? id,
    effect.fresh ? 'FRESH' : 'STALE', claimJson);
  return { claim_id: id, ...effect };
}

export function refreshCommunityFreshness(store, { now = at(), freshDays = 180 } = {}) {
  if (!Number.isFinite(Date.parse(now)) || !Number.isInteger(freshDays) || freshDays < 1) throw new Error('freshness refresh needs a valid time and positive day policy');
  const rows=store.db.prepare('SELECT claim_id,observed_at,freshness_state FROM community_claims').all(),update=store.db.prepare('UPDATE community_claims SET freshness_state=? WHERE claim_id=?');
  let becameStale=0,becameFresh=0;
  store.db.exec('BEGIN IMMEDIATE');try{for(const row of rows){const age=Date.parse(now)-Date.parse(row.observed_at),state=age>=0&&age<=freshDays*86400000?'FRESH':'STALE';
    if(state!==row.freshness_state){update.run(state,row.claim_id);if(state==='STALE')becameStale++;else becameFresh++;}}store.db.exec('COMMIT');}catch(error){store.db.exec('ROLLBACK');throw error;}
  return {checked:rows.length,became_stale:becameStale,became_fresh:becameFresh,history_deleted:0};
}

export function registerPartnerLayer(store, layer) {
  if (!layer?.source_id || !store.getSource(layer.source_id) || !layer.owner || !layer.audience || !layer.permission_reference || !layer.storage_boundary || !layer.attribution) throw new Error('partner layers require explicit owner, access policy, permission, storage boundary and attribution');
  if (layer.permission_confirmed !== true) throw new Error('partner geometry remains disabled until explicit permission is recorded');
  const id = layer.layer_id ?? `partner-${hash(stable(layer)).slice(0, 24)}`;
  store.db.prepare(`INSERT OR IGNORE INTO partner_layers(layer_id,source_id,owner,audience,permission_reference,storage_boundary,attribution,active,metadata_json)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, layer.source_id, layer.owner, layer.audience, layer.permission_reference, layer.storage_boundary, layer.attribution, 0, JSON.stringify(layer));
  return { layer_id: id, active: false, state: 'SEPARATE_LAYER_DISABLED_UNTIL_EXPLICIT_ACTIVATION' };
}
