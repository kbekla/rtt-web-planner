import crypto from 'node:crypto';
import { lengthMeters } from './route-segmenter.mjs';

export const CORRIDOR_ALGORITHM_VERSION = 'osm-topology-corridors-1';
const hash = (value, size = 32) => crypto.createHash('sha256').update(value).digest('hex').slice(0, size);
const compatible = (a, b) => a === b && ['PROBABLE_OFFROAD', 'UNSEALED_ROAD', 'UNKNOWN'].includes(a);

function canonicalNodes(nodes) {
  if (nodes.length < 2) return nodes.join(',');
  const reversed = [...nodes].reverse();
  const isLoop = nodes[0] === nodes.at(-1);
  if (!isLoop) return nodes.join(',') < reversed.join(',') ? nodes.join(',') : reversed.join(',');
    const ring = nodes.slice(0, -1), rotations = [];
    for (const values of [ring, [...ring].reverse()]) for (let i = 0; i < values.length; i++) rotations.push([...values.slice(i), ...values.slice(0, i)].join(','));
  const selected = rotations.sort()[0]; return `${selected},${selected.split(',')[0]}`;
}
function canonicalCycle(items) {
  const ring = items.slice(0, -1), variants = [];
  for (const values of [ring, [...ring].reverse()]) for (let i = 0; i < values.length; i++) variants.push([...values.slice(i), ...values.slice(0, i)]);
  return [...variants.sort((a, b) => a.join(',').localeCompare(b.join(',')))[0], variants[0]?.[0]];
}
function geoLength(coords) { return coords.slice(1).reduce((sum, p, i) => sum + lengthMeters(coords[i], p), 0); }

/** Cross-snapshot identity continuity uses shared ordered OSM node lineage only.
 * Geometry similarity may be added as review context, never as an identity join. */
export function inferCorridorLineage(previous, next, { minimumSharedNodes = 3, minimumCoverage = 0.8 } = {}) {
  if (!Number.isInteger(minimumSharedNodes) || minimumSharedNodes < 2 || !Number.isFinite(minimumCoverage) || minimumCoverage <= 0 || minimumCoverage > 1) throw new Error('invalid corridor lineage policy');
  const indexed = new Map();
  for (const candidate of next) {
    if (!Array.isArray(candidate.node_sequence) || candidate.node_sequence.length < minimumSharedNodes) continue;
    candidate.node_sequence.forEach((node, i) => { const values = indexed.get(node) ?? []; values.push([candidate, i]); indexed.set(node, values); });
  }
  const proposals = [];
  for (const prior of previous) {
    const a = prior.node_sequence; if (!Array.isArray(a) || a.length < minimumSharedNodes) continue;
    const matches = new Map();
    for (let i = 0; i < a.length; i++) for (const [current, j] of indexed.get(a[i]) ?? []) {
      if (current.corridor_id === prior.corridor_id) continue;
      const key = current.corridor_id; let overlap = 1;
      while (i + overlap < a.length && j + overlap < current.node_sequence.length && a[i + overlap] === current.node_sequence[j + overlap]) overlap++;
      let reverse = 1;
      while (i + reverse < a.length && j - reverse >= 0 && a[i + reverse] === current.node_sequence[j - reverse]) reverse++;
      const value = Math.max(overlap, reverse), old = matches.get(key);
      if (!old || value > old.shared_nodes) matches.set(key, { previous_corridor_id: prior.corridor_id, previous_version_id: prior.corridor_version_id,
        next_corridor_id: current.corridor_id, next_version_id: current.corridor_version_id, shared_nodes: value,
        coverage: Number((value / Math.min(a.length, current.node_sequence.length)).toFixed(6)) });
    }
    for (const value of matches.values()) if (value.shared_nodes >= minimumSharedNodes && value.coverage >= minimumCoverage) proposals.push(value);
  }
  const oldCounts = new Map(), nextCounts = new Map();
  for (const pair of proposals) { oldCounts.set(pair.previous_corridor_id, (oldCounts.get(pair.previous_corridor_id) ?? 0) + 1); nextCounts.set(pair.next_corridor_id, (nextCounts.get(pair.next_corridor_id) ?? 0) + 1); }
  return proposals.map(pair => {
    const oldN = oldCounts.get(pair.previous_corridor_id), nextN = nextCounts.get(pair.next_corridor_id);
    // One prior corridor mapping to multiple current identities is a split;
    // multiple priors mapping to one current identity is a merge.
    const relation = oldN > 1 && nextN > 1 ? 'AMBIGUOUS' : oldN > 1 ? 'SPLIT' : nextN > 1 ? 'MERGE' : 'CONTINUES';
    return { ...pair, relation, match_state: relation === 'CONTINUES' ? 'MATCHED' : 'REVIEW_REQUIRED', retain_prior_identity: relation === 'CONTINUES' };
  }).sort((a, b) => a.previous_corridor_id.localeCompare(b.previous_corridor_id) || a.next_corridor_id.localeCompare(b.next_corridor_id));
}

/** Groups immutable OSM way-part observations only through shared mapped nodes.
 * Geometry closeness never establishes identity; uncertain ways remain explicit. */
export function* buildTopologyCorridors({ candidates, wayNodes, nodeDegree, snapshotId, runId }) {
  const rows = [...candidates].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
  const topology = new Map(), endpoints = new Map(), unresolved = [], byId = new Map(rows.map(r => [r.candidate_id, r]));
  for (const candidate of rows) {
    const refs = wayNodes.get(candidate.edge_id);
    if (!Array.isArray(refs) || refs.length < 2 || candidate.part_index !== 0 ||
      candidate.geometry?.type !== 'LineString' || candidate.geometry.coordinates.length !== refs.length) {
      unresolved.push(candidate.candidate_id); continue;
    }
    topology.set(candidate.candidate_id, refs);
  }
  const parent = new Map(rows.map(r => [r.candidate_id, r.candidate_id]));
  const find = id => { const p = parent.get(id); if (p === id) return id; const root = find(p); parent.set(id, root); return root; };
  const join = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set([x, y].sort().at(-1), [x, y].sort()[0]); };
  const representativeByPath = new Map(), representative = new Map();
  for (const [id, refs] of topology) {
    const key = canonicalNodes(refs), old = representativeByPath.get(key);
    if (old) { representative.set(id, old); join(id, old); }
    else { representativeByPath.set(key, id); representative.set(id, id); }
  }
  for (const [id, refs] of topology) if (representative.get(id) === id) {
    for (const node of [refs[0], refs.at(-1)]) { const ids = endpoints.get(node) ?? []; ids.push(id); endpoints.set(node, ids); }
  }
  const links = [];
  for (const [node, idsUnsorted] of endpoints) {
    const ids = [...new Set(idsUnsorted)].sort();
    if (Number(nodeDegree.get(node) ?? 0) !== 2 || ids.length !== 2) continue;
    const a = byId.get(ids[0]), b = byId.get(ids[1]);
    if (!a || !b || !compatible(a.classification, b.classification)) continue;
    join(a.candidate_id, b.candidate_id); links.push({ node_id: node, candidate_ids: ids, rule: 'shared-osm-node-degree-two-same-character' });
  }
  const groups = new Map();
  for (const row of rows) { const root = find(row.candidate_id), list = groups.get(root) ?? []; list.push(row); groups.set(root, list); }
  const linksByRoot = new Map();
  for (const link of links) { const root = find(link.candidate_ids[0]), list = linksByRoot.get(root) ?? []; list.push(link); linksByRoot.set(root, list); }
  for (const members of groups.values()) {
    let nodeSequence = [], coordinates = [], remaining = new Set(members.filter(m => topology.has(m.candidate_id) && representative.get(m.candidate_id) === m.candidate_id).map(m => m.candidate_id));
    if (remaining.size) {
      const isLinked = (node, ownId) => Number(nodeDegree.get(node) ?? 0) === 2 && (endpoints.get(node) ?? []).some(id => id !== ownId && remaining.has(id) && compatible(byId.get(ownId)?.classification, byId.get(id)?.classification));
      const starts = [...remaining].flatMap(id => { const refs = topology.get(id); return [
        { id, reverse: false, node: refs[0] }, { id, reverse: true, node: refs.at(-1) },
      ].filter(x => !isLinked(x.node, id)).map(({ id: candidateId, reverse }) => ({ id: candidateId, reverse })); }).sort((a, b) => `${canonicalNodes(topology.get(a.id))}:${a.reverse}:${a.id}`.localeCompare(`${canonicalNodes(topology.get(b.id))}:${b.reverse}:${b.id}`));
      const start = starts[0] ?? { id: [...remaining].sort()[0], reverse: false };
      let current = start.id, reverse = start.reverse;
      // Walk from an unlinked boundary through degree-two nodes. Branches,
      // crossings, class changes and absent topology stop the chain.
      while (current && remaining.has(current)) {
        remaining.delete(current); const row = byId.get(current); let rowRefs = [...topology.get(current)], rowCoords = [...row.geometry.coordinates];
        if (reverse) { rowRefs.reverse(); rowCoords.reverse(); }
        if (!nodeSequence.length) { nodeSequence = rowRefs; coordinates = rowCoords; }
        else if (nodeSequence.at(-1) === rowRefs[0]) { nodeSequence.push(...rowRefs.slice(1)); coordinates.push(...rowCoords.slice(1)); }
        else { remaining.add(current); break; }
        const tail = rowRefs.at(-1), adjacent = (endpoints.get(tail) ?? []).filter(id => remaining.has(id) && compatible(row.classification, byId.get(id)?.classification));
        current = adjacent.length === 1 && Number(nodeDegree.get(tail) ?? 0) === 2 ? adjacent[0] : null;
        reverse = current ? topology.get(current).at(-1) === tail : false;
      }
      if (remaining.size) {
        // A component with a cycle/branch is retained as one observation set, but
        // ordered geometry is not fabricated across the ambiguous topology.
        nodeSequence = members.flatMap(m => topology.get(m.candidate_id) ?? []);
        coordinates = [];
      }
    }
    const candidateIds = members.map(m => m.candidate_id).sort();
    const canonical = nodeSequence.length ? canonicalNodes(nodeSequence) : `unresolved:${candidateIds.join(',')}`;
    const identityHash = hash(`${CORRIDOR_ALGORITHM_VERSION}\0${canonical}`);
    const corridorId = `corr-${identityHash}`;
    const versionId = `cv-${hash(`${runId}\0${snapshotId}\0${identityHash}`)}`;
    const classification = members.every(m => m.classification === members[0].classification) ? members[0].classification : 'UNKNOWN';
    const identityState = nodeSequence.length && coordinates.length > 1 ? 'TOPOLOGY_BACKED' : 'REVIEW_REQUIRED';
    const geometry = coordinates.length > 1 ? { type: 'LineString', coordinates } : members.length === 1 ? members[0].geometry : null;
    const lengthM = geometry ? geoLength(coordinates) : members.reduce((n, m) => n + Number(m.length_m ?? 0), 0);
    const lowValue = members.every(m => ['driveway', 'parking_aisle', 'parking', 'alley', 'drive-through'].includes(String(m.tags?.service ?? '')));
    const tetSupported=members.some(m=>Boolean(m.tet_supported));
    yield { corridor_id: corridorId, corridor_version_id: versionId, run_id: runId, snapshot_id: snapshotId,
      algorithm_version: CORRIDOR_ALGORITHM_VERSION, candidate_ids: candidateIds, classification,
      physical_existence: 'probable', motorcycle_access: 'unknown', routability: 'unknown', canonical_status: 'NOT_COMPARED',
      review_priority: lowValue ? 'LOW_VALUE_FOR_MOTORCYCLE_DISCOVERY' : tetSupported?'CORROBORATED_DISCOVERY':'CATALOG_ONLY', tet_supported:tetSupported, identity_state: identityState,
      length_m: lengthM, node_sequence_hash: hash(canonical, 64), node_sequence: nodeSequence, geometry,
      evidence: { identity_rule: identityState === 'TOPOLOGY_BACKED' ? 'ordered shared OSM node topology; way reversal canonicalized' : 'topology association ambiguous; observations kept separate',
        links: linksByRoot.get(find(members[0].candidate_id)) ?? [], unresolved_candidate_ids: candidateIds.filter(id => unresolved.includes(id)),
        source_snapshot: snapshotId, limitations: ['OSM mapped topology is not proof of physical access or legal passage', 'OSM geometry is not routability evidence'] } };
  }
}
function firstRow(rows, id) { return rows.find(row => row.candidate_id === id); }

export const LEGAL_CLAIM_TYPES = new Set(['LEGAL_ACCESS', 'TEMPORARY_RESTRICTION', 'PERMANENT_RESTRICTION', 'CLOSURE', 'LEGAL_STATUS']);
const RESTRICTIONS = new Set(['PROHIBIT_MOTORCYCLE', 'CLOSE_TO_MOTORCYCLE', 'PROHIBIT_MOTOR_VEHICLES']);
const PERMISSIONS = new Set(['PERMIT_MOTORCYCLE', 'OPEN_TO_MOTORCYCLE']);
const isoTime = value => value == null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

export function validateLegalStatusRecord(record, source) {
  if (!record || !LEGAL_CLAIM_TYPES.has(record.claim_type)) throw new Error('legal status requires a recognized claim type');
  if (!source || source.reuse?.private_processing !== true || source.roles?.legal_access !== true) throw new Error('source is not registered and approved as private legal-access evidence');
  if (!record.jurisdiction_id || !record.source_document_reference || !record.geometry_reference || typeof record.geometry_reference !== 'object') throw new Error('legal status requires jurisdiction, source document and affected-geometry references');
  if (![...RESTRICTIONS, ...PERMISSIONS, 'REVOKE', 'UNKNOWN'].includes(record.legal_effect)) throw new Error('legal status effect is invalid');
  if (!['PERMANENT', 'TEMPORARY', 'EMERGENCY'].includes(record.temporal_kind)) throw new Error('legal status temporal kind is invalid');
  if (!isoTime(record.effective_from) || !isoTime(record.effective_until) || !isoTime(record.published_at) || !isoTime(record.retrieved_at)) throw new Error('legal status dates must be ISO-compatible timestamps');
  if (record.effective_from && record.effective_until && Date.parse(record.effective_until) < Date.parse(record.effective_from)) throw new Error('legal status expiry precedes its effective date');
  if (record.temporal_kind === 'PERMANENT' && record.effective_until) throw new Error('permanent legal status cannot have an expiry; use an amendment or revocation record');
  if (!Array.isArray(record.vehicle_classes) || !record.vehicle_classes.length || typeof record.motorcycle_applicability !== 'boolean') throw new Error('legal status must state affected vehicle classes and motorcycle applicability');
  if (!['DETERMINISTIC', 'AI_EXTRACTED', 'HUMAN_VERIFIED'].includes(record.extraction ?? 'DETERMINISTIC')) throw new Error('legal status extraction provenance is invalid');
  if (record.extraction === 'AI_EXTRACTED' && record.final_legal_decision === true) throw new Error('AI extraction cannot set final legal truth');
  return true;
}

export function evaluateMotorcycleAccess(records, { at = new Date().toISOString(), geometryIdentity = 'UNRESOLVED', jurisdictionIdentity = 'UNRESOLVED' } = {}) {
  if (!isoTime(at)) throw new Error('evaluation time must be an ISO timestamp');
  if (geometryIdentity !== 'MATCHED' || jurisdictionIdentity !== 'MATCHED') return { access: 'unknown', operational_state: 'REVIEW_REQUIRED', reason: 'legal evidence geometry or jurisdiction identity is unresolved' };
  const time = Date.parse(at), active = (records ?? []).filter(r => r.qualified === true && r.authority_category === 'AUTHORITATIVE' && r.motorcycle_applicability === true &&
    (!r.effective_from || Date.parse(r.effective_from) <= time) && (!r.effective_until || time <= Date.parse(r.effective_until)) && !r.revoked_at);
  const superseded = new Set(active.map(r => r.supersedes_record_id).filter(Boolean));
  const current = active.filter(r => !superseded.has(r.status_record_id));
  if (current.some(r => r.legal_effect === 'REVOKE')) return { access: 'unknown', operational_state: 'VISIBLE_NOT_ROUTABLE', reason: 'authoritative access status was revoked; no current replacement permission is present' };
  const restrictions = current.filter(r => RESTRICTIONS.has(r.legal_effect));
  const permissions = current.filter(r => PERMISSIONS.has(r.legal_effect));
  if (restrictions.length) return { access: restrictions.some(r => r.temporal_kind === 'TEMPORARY' || r.temporal_kind === 'EMERGENCY') ? 'temporarily_restricted' : 'prohibited',
    operational_state: restrictions.some(r => r.temporal_kind === 'TEMPORARY' || r.temporal_kind === 'EMERGENCY') ? 'TEMPORARILY_CLOSED' : 'RESTRICTED_OR_REJECTED',
    contradiction: permissions.length > 0, contradiction_state: permissions.length ? 'REVIEW_REQUIRED' : null,
    reason: 'current authoritative motorcycle restriction', evidence_ids: [...restrictions, ...permissions].map(r => r.status_record_id).sort() };
  if (permissions.length && !current.some(r => RESTRICTIONS.has(r.legal_effect))) return { access: 'confirmed', operational_state: 'VISIBLE_NOT_ROUTABLE', reason: 'current authoritative access evidence; routability has not been verified', evidence_ids: permissions.map(r => r.status_record_id).sort() };
  return { access: 'unknown', operational_state: 'VISIBLE_NOT_ROUTABLE', reason: 'no current authoritative motorcycle access evidence' };
}

export function deriveOperationalState({ physical = 'unknown', access = 'unknown', routability = 'unknown', accessEvaluation = null } = {}) {
  if (accessEvaluation?.operational_state === 'TEMPORARILY_CLOSED' || accessEvaluation?.operational_state === 'RESTRICTED_OR_REJECTED') return accessEvaluation.operational_state;
  if (accessEvaluation?.operational_state === 'REVIEW_REQUIRED') return 'REVIEW_REQUIRED';
  if (access === 'temporarily_restricted') return 'TEMPORARILY_CLOSED';
  if (access === 'prohibited') return 'RESTRICTED_OR_REJECTED';
  if (physical === 'confirmed' && access === 'confirmed' && routability === 'yes') return 'ROUTABLE';
  if (physical !== 'unknown') return 'VISIBLE_NOT_ROUTABLE';
  return 'REVIEW_REQUIRED';
}

export function communityClaimEffect(claim, { at = new Date().toISOString(), freshDays = 180 } = {}) {
  const allowed = new Set(['TRAVERSED', 'BLOCKED', 'GATE_PRESENT', 'SURFACE_CHANGED', 'SIGN_SEEN', 'LEGAL_SIGNAGE_REPORTED', 'CLOSED', 'REOPENED', 'GEOMETRY_DIFFERENT']);
  if (!claim || !allowed.has(claim.claim_type) || !claim.source_id || !claim.observed_at || !isoTime(claim.observed_at)) throw new Error('community evidence needs a typed claim, provenance and valid observation time');
  const age = Date.parse(at) - Date.parse(claim.observed_at), fresh = age >= 0 && age <= freshDays * 86400000;
  return { physical_effect: fresh && ['TRAVERSED', 'BLOCKED', 'GATE_PRESENT', 'SURFACE_CHANGED', 'GEOMETRY_DIFFERENT'].includes(claim.claim_type) ? 'corroboration' : 'none',
    access_effect: 'none', fresh, historical_record_retained: true };
}

export function sourceAutomationDecision(source) {
  if (!source?.licence?.name || !source?.licence?.version || !source?.reuse || source.reuse.private_processing !== true) return { allowed: false, state: 'REVIEW_REQUIRED', reason: 'licence/private-processing permission is incomplete' };
  if (!Array.isArray(source.evidence_roles) && !source.roles) return { allowed: false, state: 'REVIEW_REQUIRED', reason: 'evidence roles are not registered' };
  return { allowed: true, state: 'REGISTERED', reason: null };
}
