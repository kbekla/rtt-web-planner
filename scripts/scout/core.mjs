// Private, deterministic Scout foundation. No network collectors are registered here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';

export const STATES = Object.freeze({ exists: ['unknown', 'probable', 'confirmed', 'disproved'],
  motorcycle_access: ['unknown', 'probable', 'confirmed', 'prohibited'],
  routability: ['unknown', 'yes', 'no'],
  lifecycle: ['discovered', 'investigating', 'awaiting_review', 'approved_for_import', 'rejected', 'archived'],
  review: ['not_required', 'queued', 'in_review', 'resolved'] });
const idHash = (x) => crypto.createHash('sha256').update(canonicalJson(x)).digest('hex');
const clone = (x) => JSON.parse(JSON.stringify(x));
const now = () => new Date().toISOString();
const SAFE_SOURCES = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const SCOUT_CONFIG = yaml.load(fs.readFileSync(new URL('../../config/scout.yaml', import.meta.url), 'utf8'));
const resourcePolicy = {
  min_mem_available_mb: SCOUT_CONFIG.resource_governor.minimum_available_ram_mb,
  red_mem_available_mb: SCOUT_CONFIG.resource_governor.red_available_ram_mb,
  max_swap_used_mb: SCOUT_CONFIG.resource_governor.maximum_swap_used_mb,
  sustained_load_samples: SCOUT_CONFIG.resource_governor.sustained_load_samples,
  sustained_swap_samples: SCOUT_CONFIG.resource_governor.sustained_swap_samples,
  min_free_disk_bytes: SCOUT_CONFIG.resource_governor.minimum_free_disk_gb * 1e9,
  max_load1: SCOUT_CONFIG.resource_governor.maximum_load1,
  thermal: SCOUT_CONFIG.resource_governor.thermal,
};
const procStart = (pid) => { try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null; } catch { return null; } };
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function normalizeObservation(raw, { sourceKey, observedAt = now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('observation must be an object');
  if (!sourceKey || !SAFE_SOURCES.test(sourceKey)) throw new Error('source adapter key must be 1-64 safe identifier characters');
  const geometry = raw.geometry == null ? null : clone(raw.geometry);
  if (geometry) {
    if (!['LineString', 'MultiLineString'].includes(geometry.type)) throw new Error('geometry must be LineString or MultiLineString');
    const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
    if (!Array.isArray(lines) || !lines.length || lines.some((l) => !Array.isArray(l) || l.length < 2 || l.some((p) => !Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90))) throw new Error('geometry must contain valid WGS84 line coordinates');
  }
  const observation = { source_key: sourceKey, source_id: raw.source_id ?? null, name: raw.name ?? null,
    geometry, provenance: clone(raw.provenance ?? {}), hints: clone(raw.hints ?? []),
    evidence_metadata: clone(raw.evidence ?? []), observed_at: observedAt,
    geometry_sha256: geometry ? idHash(geometry) : null };
  return { observation, transformations: [] };
}

export function candidateFromObservation(observation) {
  const candidateId = `scout-${idHash({ source_key: observation.source_key, source_id: observation.source_id,
    geometry_sha256: observation.geometry_sha256, name: observation.name }).slice(0, 20)}`;
  return { schema_version: 1, candidate_id: candidateId, version: 1, created_at: observation.observed_at,
    updated_at: observation.observed_at, geometry: clone(observation.geometry), geometry_sha256: observation.geometry_sha256,
    observations: [clone(observation)], master_match: { type: 'UNMATCHED', rtt_ids: [] },
    evidence: [], states: { exists: 'unknown', motorcycle_access: 'unknown', routability: 'unknown' },
    confidence: null, duplicate_cluster_id: null, corridor_cluster_id: null, issues: [],
    lifecycle: 'discovered', review: { state: 'not_required', reasons: [], recommended_action: null } };
}

function coordinates(g) { return g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : []; }
function points(g) { return coordinates(g).flat().filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])); }
const eq = (a, b) => canonicalJson(a) === canonicalJson(b);
function canonicalGeometry(g) {
  const lines = coordinates(g).map((line) => {
    const forward = canonicalJson(line), reverse = canonicalJson([...line].reverse());
    return forward <= reverse ? line : [...line].reverse();
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return g?.type === 'LineString' ? { type: 'LineString', coordinates: lines[0] ?? [] } : { type: 'MultiLineString', coordinates: lines };
}
function longitudeReference(geometryPoints) {
  const sum=geometryPoints.reduce((acc,[lon])=>[acc[0]+Math.cos(lon*Math.PI/180),acc[1]+Math.sin(lon*Math.PI/180)],[0,0]);
  return Math.atan2(sum[1],sum[0])*180/Math.PI;
}
function unwrapGeometry(g, reference) {
  const unwrap=(lon)=>{let value=lon;while(value-reference>180)value-=360;while(value-reference< -180)value+=360;return value;};
  const map=(line)=>line.map((point)=>[unwrap(point[0]),...point.slice(1)]);
  return g?.type==='LineString'?{...g,coordinates:map(g.coordinates)}:g?.type==='MultiLineString'?{...g,coordinates:g.coordinates.map(map)}:g;
}
function project(pointsList, lat0) {
  const scale = Math.cos(lat0 * Math.PI / 180) * 111320;
  return pointsList.map(([lon, lat]) => [lon * scale, lat * 110540]);
}
function projectedLines(g, lat0) { return coordinates(g).map((line) => project(line, lat0)); }
function sampleLines(lines, spacing = 25, cap = 4096) {
  const total = lines.reduce((sum, line) => sum + line.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - line[i][0], p[1] - line[i][1]), 0), 0);
  const step = Math.max(spacing, total / cap);
  const out = [];
  for (const line of lines) {
    if (line.length < 2) continue;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(length / step));
      for (let j = 0; j < n; j++) { const t = (j + 0.5) / n; out.push({ point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], weight: length / n }); }
    }
  }
  return out;
}
function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const d = dx * dx + dy * dy;
  const t = d ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function nearest(p, line) {
  let d = Infinity;
  for (let i = 1; i < line.length; i++) d = Math.min(d, pointSegmentDistance(p, line[i - 1], line[i]));
  if (line.length === 1) d = Math.hypot(p[0] - line[0][0], p[1] - line[0][1]);
  return d;
}
function metrics(a, b) {
  const rawA = points(a), rawB = points(b);
  if (rawA.length < 2 || rawB.length < 2) return null;
  const lat0 = [...rawA, ...rawB].reduce((s, p) => s + p[1], 0) / (rawA.length + rawB.length);
  const linesA = projectedLines(a, lat0), linesB = projectedLines(b, lat0);
  const pa = sampleLines(linesA), pb = sampleLines(linesB);
  const directed = (src, dstLines) => src.map(({ point, weight }) => ({ distance: Math.min(...dstLines.map((l) => nearest(point, l))), weight }));
  const da = directed(pa, linesB), db = directed(pb, linesA);
  const coverage = (d, tolerance) => d.reduce((s, v) => s + (v.distance <= tolerance ? v.weight : 0), 0) / Math.max(Number.EPSILON, d.reduce((s, v) => s + v.weight, 0));
  const meanA = da.reduce((s, n) => s + n.distance * n.weight, 0) / da.reduce((s, n) => s + n.weight, 0);
  const meanB = db.reduce((s, n) => s + n.distance * n.weight, 0) / db.reduce((s, n) => s + n.weight, 0);
  const mean = Math.min(meanA, meanB);
  const coverage3 = [coverage(da, 3), coverage(db, 3)], coverage15 = [coverage(da, 15), coverage(db, 15)];
  const overlapA = coverage(da, 18), overlapB = coverage(db, 18);
  return { mean_m: mean, overlap: Math.min(overlapA, overlapB), one_way_overlap: Math.max(overlapA, overlapB),
    tight_coverage: Math.min(...coverage3), loose_coverage: Math.min(...coverage15), candidate_coverage: coverage3[0], master_coverage: coverage3[1] };
}

export function matchMaster(candidate, masterFeatures, thresholds = {}, trustedIdentity = () => false) {
  const configured = SCOUT_CONFIG.matching;
  const policy = { near_m: configured.near_distance_m, partial_overlap: configured.partial_overlap,
    likely_overlap: configured.likely_overlap, likely_distance_m: configured.likely_distance_m,
    tight_coverage: configured.tight_coverage, loose_coverage: 0.05, ...thresholds };
  if (!candidate.geometry) return { type: 'AMBIGUOUS', rtt_ids: [], scores: [], thresholds: policy, reason: 'geometry unavailable' };
  const exact = [], scored = [];
  const candidateRawPoints = points(candidate.geometry);
  const bounds = (pts) => pts.reduce((b,p)=>({minLon:Math.min(b.minLon,p[0]),maxLon:Math.max(b.maxLon,p[0]),minLat:Math.min(b.minLat,p[1]),maxLat:Math.max(b.maxLat,p[1])}),{minLon:Infinity,maxLon:-Infinity,minLat:Infinity,maxLat:-Infinity});
  const referenceLon=longitudeReference(candidateRawPoints),candidateGeometry=unwrapGeometry(candidate.geometry,referenceLon),candidatePoints=points(candidateGeometry);
  if (!candidatePoints.length || candidatePoints.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1])))
    return { type: 'AMBIGUOUS', rtt_ids: [], scores: [], thresholds: policy, reason: 'invalid geometry' };
  const cb = bounds(candidatePoints), midLat = (cb.minLat + cb.maxLat) / 2;
  if (cb.maxLon - cb.minLon > 3 || cb.maxLat - cb.minLat > 3)
    return { type: 'AMBIGUOUS', rtt_ids: [], scores: [], thresholds: policy, reason: 'geometry exceeds local projection extent' };
  const padLat = policy.near_m / 110540, padLon = policy.near_m / Math.max(1113, 111320 * Math.cos(midLat * Math.PI / 180));
  for (const f of masterFeatures) {
    const id = f?.properties?.rtt_id;
    if (!id || !f.geometry) continue;
    const normalizedMaster=unwrapGeometry(f.geometry,referenceLon),fp = points(normalizedMaster);
    if (fp.length < 2) continue;
    const fb = bounds(fp);
    if (fb.maxLon < cb.minLon - padLon || fb.minLon > cb.maxLon + padLon || fb.maxLat < cb.minLat - padLat || fb.minLat > cb.maxLat + padLat) continue;
    if (eq(canonicalGeometry(candidateGeometry), canonicalGeometry(normalizedMaster))) { exact.push(id); continue; }
    const m = metrics(candidateGeometry, normalizedMaster);
    if (m) scored.push({ id, ...m, identity_corroborated: Boolean(trustedIdentity(candidate, f)) });
  }
  if (exact.length) return { type: 'EXACT_EXISTING', rtt_ids: exact.sort(), scores: [], thresholds: policy };
  scored.sort((a, b) => a.mean_m - b.mean_m || a.id.localeCompare(b.id));
  const near = scored.filter((x) => x.mean_m <= policy.near_m || x.loose_coverage >= policy.partial_overlap);
  if (!near.length) return { type: 'NEW_CANDIDATE', rtt_ids: [], scores: scored.slice(0, 3), thresholds: policy };
  const overlap = near.filter((x) => x.loose_coverage >= policy.partial_overlap);
  if (overlap.length > 1 && overlap[0].mean_m - overlap[1].mean_m < 5) return { type: 'AMBIGUOUS', rtt_ids: overlap.map((x) => x.id), scores: overlap, thresholds: policy };
  if (overlap.length && overlap[0].tight_coverage >= policy.tight_coverage && overlap[0].mean_m <= policy.likely_distance_m)
    return { type: overlap[0].identity_corroborated ? 'LIKELY_EXISTING' : 'AMBIGUOUS', rtt_ids: [overlap[0].id], scores: overlap, thresholds: policy };
  if (overlap.length && overlap[0].tight_coverage < policy.tight_coverage && overlap[0].loose_coverage >= policy.partial_overlap) {
    const bothLoose = overlap[0].candidate_coverage === 0 && overlap[0].master_coverage === 0 && overlap[0].loose_coverage >= 0.95;
    return { type: bothLoose ? 'POSSIBLE_PARALLEL' : 'PARTIAL_OVERLAP', rtt_ids: overlap.map((x) => x.id), scores: overlap, thresholds: policy };
  }
  return { type: 'POSSIBLE_PARALLEL', rtt_ids: near.map((x) => x.id), scores: near, thresholds: policy };
}

export function assessEvidence(candidate) {
  const ev = candidate.evidence ?? [];
  // Source-provided metadata stays descriptive. Only separately reviewed/qualified
  // evidence records may affect deterministic states.
  const qualified = ev.filter((e) => e.eligible_for_state === true && e.review_status === 'qualified');
  const exists = qualified.filter((e) => e.question === 'physical_existence' && ['supports', 'contradicts'].includes(e.position));
  const access = qualified.filter((e) => e.question === 'motorcycle_access' && ['supports', 'contradicts'].includes(e.position));
  const state = (arr, yes, no) => arr.some((e) => e.position === 'supports') && arr.some((e) => e.position === 'contradicts') ? 'contradictory'
    : arr.some((e) => e.position === 'supports') ? (arr.some((e) => e.position === 'supports' && e.certainty === 'probable') ? 'probable' : yes)
      : arr.some((e) => e.position === 'contradicts') ? no : 'unknown';
  candidate.states.exists = state(exists, 'confirmed', 'disproved');
  candidate.states.motorcycle_access = state(access, 'confirmed', 'prohibited');
  if (!['unknown', 'yes', 'no'].includes(candidate.states.routability)) candidate.states.routability = 'unknown';
  const reasons = [];
  if (!candidate.geometry) reasons.push('no usable geometry');
  if (['unknown', 'probable', 'contradictory'].includes(candidate.states.exists)) reasons.push('physical existence needs review');
  if (['unknown', 'probable', 'contradictory'].includes(candidate.states.motorcycle_access)) reasons.push('motorcycle access needs review');
  if (candidate.master_match && !['UNMATCHED', 'NEW_CANDIDATE', 'EXACT_EXISTING'].includes(candidate.master_match.type)) reasons.push(`master match requires review (${candidate.master_match.type})`);
  if (reasons.length) { candidate.review = { state: 'queued', reasons, recommended_action: 'review evidence and source records' }; candidate.lifecycle = 'awaiting_review'; }
  else { candidate.review = { state: 'not_required', reasons: [], recommended_action: null }; if (candidate.lifecycle === 'awaiting_review') candidate.lifecycle = 'investigating'; }
  return candidate;
}

export function clusterObservations(candidates, { distance_m = SCOUT_CONFIG.matching.corridor_distance_m, overlap = SCOUT_CONFIG.matching.corridor_overlap } = {}) {
  const sorted = [...candidates].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
  const groups = [];
  for (const c of sorted) {
    let group = groups.find((g) => g.some((m) => { const v = metrics(c.geometry, m.geometry); return v && v.mean_m <= distance_m && v.overlap >= overlap; }));
    if (!group) groups.push(group = []);
    group.push(c);
  }
  return groups.filter((g) => g.length > 1).map((members) => ({ cluster_id: `corridor-${idHash(members.map((m) => m.candidate_id).sort()).slice(0, 16)}`,
    candidate_ids: members.map((m) => m.candidate_id).sort() }));
}

export class ScoutStore {
  constructor(root) { this.root = root; this.state = path.join(root, 'scout'); this.queue = path.join(this.state, 'queue'); }
  ensure() { for (const d of ['pending', 'running', 'held', 'done', 'reviews', 'sources']) fs.mkdirSync(path.join(this.queue, d), { recursive: true }); fs.mkdirSync(this.state, { recursive: true }); this.cleanTemps(); }
  cleanTemps() {
    const visit = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else { const pid = Number(/\.tmp-(\d+)$/.exec(entry.name)?.[1]); if (!pid || pid === process.pid) continue; try { process.kill(pid, 0); } catch { fs.rmSync(file, { force: true }); } }
    } };
    for (const dir of [this.state, this.queue]) if (fs.existsSync(dir)) visit(dir);
  }
  atomic(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp-${process.pid}`; const fd = fs.openSync(tmp, 'w'); fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, file); }
  enqueue(source_key, payload, { max_attempts = 3 } = {}) {
    this.ensure(); const key = idHash({ source_key, payload });
    for (const s of ['pending', 'running', 'held', 'done']) { const file = path.join(this.queue, s, `${key}.json`); if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file)); }
    const job = { job_id: key, source_key, payload: clone(payload), state: 'pending', attempts: 0, max_attempts, not_before: null, created_at: now(), updated_at: now() };
    this.atomic(path.join(this.queue, 'pending', `${key}.json`), job); return job;
  }
  list(state) { if (!['pending','running','held','done','reviews','sources'].includes(state)) throw new Error(`invalid Scout queue '${state}'`); const d = path.join(this.queue, state); return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('.json')).sort().map((x) => JSON.parse(fs.readFileSync(path.join(d, x)))) : []; }
  claim({ now_ms = Date.now() } = {}) { this.ensure(); const job = this.list('pending').find((j) => !j.not_before || Date.parse(j.not_before) <= now_ms); if (!job) return null;
    const from = path.join(this.queue, 'pending', `${job.job_id}.json`), to = path.join(this.queue, 'running', `${job.job_id}.json`);
    try { fs.renameSync(from, to); job.state = 'running'; job.attempts++; job.updated_at = now(); this.atomic(to, job); return job; } catch { return null; } }
  finish(job, state = 'done', error = null, { base_backoff_ms = 60_000 } = {}) {
    const from = path.join(this.queue, 'running', `${job.job_id}.json`); job.updated_at = now();
    if (error && job.attempts < job.max_attempts) { job.state = 'pending'; job.last_error = String(error); job.not_before = new Date(Date.now() + base_backoff_ms * (2 ** (job.attempts - 1))).toISOString(); }
    else if (error) { job.state = 'held'; job.last_error = String(error); job.review_reason = 'source failed after bounded retries'; }
    else job.state = state;
    this.atomic(path.join(this.queue, job.state, `${job.job_id}.json`), job); fs.rmSync(from, { force: true }); return job;
  }
  recover() {
    this.ensure();
    // Validate every persisted queue before the worker can claim or skip an item.
    for (const state of ['pending', 'held', 'done', 'reviews', 'sources']) this.list(state);
    const running = this.list('running'); let recovered = 0;
    for (const j of running) {
      const runningFile = path.join(this.queue, 'running', `${j.job_id}.json`);
      const terminal = ['done','held'].some((state) => fs.existsSync(path.join(this.queue, state, `${j.job_id}.json`)));
      const pendingFile = path.join(this.queue, 'pending', `${j.job_id}.json`);
      if (!terminal && !fs.existsSync(pendingFile)) { j.state = 'pending'; j.recovered_at = now(); this.atomic(pendingFile, j); recovered++; }
      fs.rmSync(runningFile, { force: true });
    }
    return recovered;
  }
  saveCandidate(c) {
    this.atomic(path.join(this.state, 'candidates', `${c.candidate_id}.json`), c);
    const reviewFile = path.join(this.queue, 'reviews', `${c.candidate_id}.json`);
    if (c.review.state === 'queued') this.atomic(reviewFile, { candidate_id: c.candidate_id, name: c.observations[0]?.name ?? null,
      states: clone(c.states), master_match: clone(c.master_match), evidence: clone(c.evidence),
      source_observations: c.observations.map((o) => ({ source_key: o.source_key, hints: clone(o.hints), evidence_metadata: clone(o.evidence_metadata), provenance: clone(o.provenance) })), issues: clone(c.issues),
      reasons: clone(c.review.reasons), recommended_action: c.review.recommended_action, created_at: c.created_at });
    else fs.rmSync(reviewFile, { force: true });
  }
  updateCandidate(candidateId, update) {
    if (!/^scout-[a-f0-9]{20}$/.test(candidateId)) throw new Error('invalid candidate ID');
    const file = path.join(this.state, 'candidates', `${candidateId}.json`);
    const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
    const updated = update(clone(candidate)) ?? candidate;
    updated.version = candidate.version + 1; updated.updated_at = now();
    this.saveCandidate(updated); return updated;
  }
  status() {
    const worker = this.read('worker.json');
    const files = path.join(this.state, 'candidates');
    const candidates = fs.existsSync(files) ? fs.readdirSync(files).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(files, f)))) : [];
    const queue = Object.fromEntries(['pending','running','held','done','reviews'].map((s) => [s, this.list(s).length]));
    const sourceDir = path.join(this.queue, 'sources');
    const sources = fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(sourceDir, f)))) : [];
    return { status: worker?.status ?? (queue.held ? 'AMBER' : 'GREEN'), worker,
      current: worker?.job_id ? { job_id: worker.job_id, source_key: worker.source_key, step: worker.current_step } : null,
      queue, sources, candidates: { total: candidates.length,
        exact_matches: candidates.filter((c) => c.master_match?.type === 'EXACT_EXISTING').length,
        existing_matches: candidates.filter((c) => ['LIKELY_EXISTING','PARTIAL_OVERLAP','POSSIBLE_PARALLEL','AMBIGUOUS'].includes(c.master_match?.type)).length,
        new_candidates: candidates.filter((c) => c.master_match?.type === 'NEW_CANDIDATE').length,
        awaiting_existence: candidates.filter((c) => c.states?.exists === 'unknown' || c.states?.exists === 'contradictory').length,
        awaiting_legal_review: candidates.filter((c) => c.states?.motorcycle_access === 'unknown' || c.states?.motorcycle_access === 'contradictory').length,
        awaiting_routability: candidates.filter((c) => c.states?.routability === 'unknown').length,
        review: queue.reviews },
      ai: this.read('ai.json') ?? { enabled: false, available: false, consultations: 0 },
      resource_governor: this.read('resource.json') ?? { state: 'UNKNOWN' },
      notifications: this.read('notifications.json') ?? { pending_digest: 0, active_alerts: 0 },
      next_scheduled_work: this.read('schedule.json'), last_activity: this.read('activity.json') };
  }
  read(name) { try { return JSON.parse(fs.readFileSync(path.join(this.state, name), 'utf8')); } catch { return null; } }
  candidateCount() { const d = path.join(this.state, 'candidates'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).length : 0; }
}

export class FakeAdapter { constructor(key, observations = []) { this.key = key; this.observations = observations; } async collect(cursor = null) { return { observations: clone(this.observations), cursor, checked_at: now() }; } }
export async function collectAdapter(adapter, store, cursor = null) {
  if (!adapter?.key || !SAFE_SOURCES.test(adapter.key)) throw new Error('adapter key must be 1-64 safe identifier characters');
  try { const result = await adapter.collect(cursor); for (const raw of result.observations ?? []) store.enqueue(adapter.key, raw); store.atomic(path.join(store.queue, 'sources', `${adapter.key}.json`), { key: adapter.key, cursor: result.cursor ?? cursor, last_checked: result.checked_at ?? now(), state: 'GREEN' }); return { queued: result.observations?.length ?? 0 }; }
  catch (e) { store.atomic(path.join(store.queue, 'sources', `${adapter.key}.json`), { key: adapter.key, cursor, last_checked: now(), state: 'AMBER', error: String(e) }); return { queued: 0, error: String(e) }; }
}

export class SourceScheduler {
  constructor(store, { minimum_interval_ms = SCOUT_CONFIG.sources.minimum_interval_seconds * 1000,
    maximum_failures = SCOUT_CONFIG.sources.maximum_attempts, max_per_minute = SCOUT_CONFIG.sources.rate_limit_per_minute } = {}) { this.store = store; this.minimumInterval = minimum_interval_ms; this.maximumFailures = maximum_failures; this.maxPerMinute = max_per_minute; }
  due(sourceKey, { now_ms = Date.now(), minimum_interval_ms = this.minimumInterval } = {}) {
    const source = this.store.list('sources').find((x) => x.key === sourceKey);
    if (source?.retry_at) return now_ms >= Date.parse(source.retry_at);
    return !source?.last_checked || now_ms - Date.parse(source.last_checked) >= minimum_interval_ms;
  }
  async run(adapter, { now_ms = Date.now(), minimum_interval_ms = this.minimumInterval } = {}) {
    const previous = this.store.list('sources').find((x) => x.key === adapter.key);
    const recent = (previous?.recent_checks ?? []).filter((t) => now_ms - Date.parse(t) < 60_000);
    if (recent.length >= this.maxPerMinute) return { queued: 0, deferred: true, reason: 'source rate limit' };
    if (!this.due(adapter.key, { now_ms, minimum_interval_ms })) return { queued: 0, deferred: true, reason: 'source politeness interval' };
    const failures = previous?.state === 'AMBER' ? (previous.failures ?? 1) : 0;
    if (failures >= this.maximumFailures) return { queued: 0, deferred: true, state: 'AMBER', reason: 'bounded source retry budget exhausted' };
    const result = await collectAdapter(adapter, this.store, previous?.cursor ?? null);
    const file = path.join(this.store.queue, 'sources', `${adapter.key}.json`);
    const status = JSON.parse(fs.readFileSync(file, 'utf8'));
    status.recent_checks = [...recent, new Date(now_ms).toISOString()];
    if (result.error) { status.failures = failures + 1; status.retry_at = new Date(now_ms + Math.min(30 * 60_000, 60_000 * (2 ** failures))).toISOString(); this.store.atomic(file, status); }
    else { status.failures = 0; delete status.retry_at; this.store.atomic(file, status); }
    return { ...result, state: status.state, failures: status.failures };
  }
}

export async function consultAI(provider, request, { enabled = SCOUT_CONFIG.ai.enabled, timeout_ms = SCOUT_CONFIG.ai.timeout_seconds * 1000 } = {}) {
  if (!enabled || !provider) return { status: 'disabled', result: null };
  let timer;
  try {
    const result = await Promise.race([provider.assess(clone(request)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('AI timeout')), timeout_ms); })]);
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.summary !== 'string' || !['low','medium','high'].includes(result.confidence)) return { status: 'malformed', result: null };
    const safe = { summary: result.summary.slice(0, 1000), confidence: result.confidence, suggestions: Array.isArray(result.suggestions) ? result.suggestions.filter((s) => typeof s === 'string').slice(0, 10) : [] };
    return { status: 'ok', result: safe };
  } catch (e) { return { status: 'unavailable', result: null, reason: String(e.message ?? e) }; }
  finally { clearTimeout(timer); }
}

export async function consultAIAndRecord(provider, request, context, store, options = {}) {
  const result = await consultAI(provider, request, options);
  const auditFile = path.join(store.state, 'ai-audit.json');
  let records = []; try { records = JSON.parse(fs.readFileSync(auditFile, 'utf8')); } catch { /* first consultation */ }
  records.push({ at: now(), provider: context.provider ?? 'unknown', model: context.model ?? null,
    reason: context.reason ?? 'unspecified', candidate_id: context.candidate_id ?? null,
    job_id: context.job_id ?? null, evidence_refs: clone(context.evidence_refs ?? []), status: result.status,
    result: clone(result.result), uncertainty: result.result?.confidence ?? null,
    usage: context.usage ?? null, action_taken: context.action_taken ?? 'advisory only' });
  if (records.length > 1000) records.splice(0, records.length - 1000);
  store.atomic(auditFile, records);
  store.atomic(path.join(store.state, 'ai.json'), { enabled: options.enabled !== false, available: result.status === 'ok',
    last_status: result.status, last_at: now(), consultations: records.length });
  return result;
}

export function classifyHost(snapshot, history = [], policy = {}) {
  policy = { ...resourcePolicy, ...policy, thermal: { ...resourcePolicy.thermal, ...(policy.thermal ?? {}) } };
  const t = policy.thermal;
  const max = (key) => Math.max(-Infinity, ...[snapshot, ...history].map((x) => x[key]).filter(Number.isFinite));
  const cpu = max('cpu_temp_c'), nvme = max('nvme_temp_c');
  const gpu = Math.max(-Infinity, ...[snapshot, ...history].flatMap((x) => [x.dgpu?.temp_c, x.igpu?.temp_c]).filter(Number.isFinite));
  let thermal = 'NORMAL';
  if (cpu >= t.critical_cpu_c || nvme >= t.critical_nvme_c) thermal = 'CRITICAL';
  else if (cpu >= t.hot_cpu_c || nvme >= t.hot_nvme_c || gpu >= t.gpu_hot_c) thermal = 'HOT';
  else if (cpu >= t.warm_cpu_c || nvme >= t.warm_nvme_c) thermal = 'WARM';
  const lowDisk = snapshot.disk?.free_bytes != null && snapshot.disk.free_bytes < (policy.min_free_disk_bytes ?? 20 * 1e9);
  const trend = [snapshot, ...history].slice(0, policy.trend_window_samples ?? 4);
  const sustained = (key, limit, required) => {
    const high = trend.filter((x) => Number.isFinite(x[key]) && x[key] > limit);
    const times = high.map((x) => Date.parse(x.observed_at)).filter(Number.isFinite);
    return high.length >= required && times.length >= required && Math.max(...times) - Math.min(...times) >= (required - 1) * policy.thermal.sample_interval_seconds * 1000;
  };
  const highLoad = sustained('load1', policy.max_load1, policy.sustained_load_samples);
  const highSwap = sustained('swap_used_mb', policy.max_swap_used_mb, policy.sustained_swap_samples);
  const lowMemory = snapshot.mem_available_mb != null && snapshot.mem_available_mb < (policy.min_mem_available_mb ?? 2048);
  const contention = snapshot.factory_state === 'building' || snapshot.planetiler_active || snapshot.other_heavy_lease ||
    snapshot.local_ai_active || snapshot.other_heavy_workload_active ||
    (snapshot.mem_available_mb != null && snapshot.mem_available_mb < (policy.min_mem_available_mb ?? 2048)) ||
    highSwap || highLoad || lowDisk;
  const unsafeHost = lowDisk || (lowMemory && snapshot.mem_available_mb < (policy.red_mem_available_mb ?? 512));
  return { thermal, contention, allow_heavy: thermal === 'NORMAL' && !contention,
    allow_ai: thermal === 'NORMAL' && !contention && !snapshot.local_ai_active,
    state: thermal === 'CRITICAL' || unsafeHost ? 'RED' : thermal === 'HOT' || thermal === 'WARM' || contention ? 'AMBER' : 'GREEN',
    reasons: [...(contention ? ['shared workload or resource pressure'] : []), ...(thermal !== 'NORMAL' ? [`thermal ${thermal}`] : [])] };
}

export class ThermalGovernor {
  constructor(policy = {}, state = {}) { this.policy = { ...SCOUT_CONFIG.resource_governor.thermal, ...policy }; this.state = state.state ?? 'NORMAL'; this.cool = state.cool ?? 0; this.hotSamples = state.hot_samples ?? 0; this.hotSince = state.hot_since_ms ?? null; }
  serialize() { return { state: this.state, cool: this.cool, hot_samples: this.hotSamples, hot_since_ms: this.hotSince, updated_at: now() }; }
  update(s, now_ms = Date.now()) {
    const p = this.policy, cpu = s.cpu_temp_c ?? -Infinity, nvme = s.nvme_temp_c ?? -Infinity;
    const gpu = Math.max(-Infinity, ...[s.dgpu?.temp_c, s.igpu?.temp_c].filter(Number.isFinite));
    const requested = cpu >= p.critical_cpu_c || nvme >= p.critical_nvme_c ? 'CRITICAL'
      : cpu >= p.hot_cpu_c || nvme >= p.hot_nvme_c || gpu >= p.gpu_hot_c ? 'HOT'
        : cpu >= p.warm_cpu_c || nvme >= p.warm_nvme_c ? 'WARM' : 'NORMAL';
    if (requested === 'CRITICAL') { this.state = 'CRITICAL'; this.cool = 0; this.hotSamples = 0; this.hotSince = null; }
    else if (requested === 'WARM' && this.state === 'NORMAL') { this.state = 'WARM'; this.cool = 0; this.hotSamples = 0; this.hotSince = null; }
    else if (requested === 'HOT' && this.state === 'NORMAL') { this.state = 'WARM'; this.hotSamples = 1; this.hotSince = now_ms; this.cool = 0; }
    else if (requested === 'HOT' && this.state === 'WARM') {
      this.hotSince ??= now_ms;
      this.hotSamples++;
      const duration = Math.max(0, p.hot_entry_samples - 1) * p.sample_interval_seconds * 1000;
      if (this.hotSamples >= p.hot_entry_samples && now_ms - this.hotSince >= duration) { this.state = 'HOT'; this.hotSamples = 0; this.hotSince = null; this.cool = 0; }
    }
    else if (requested === this.state) { this.cool = 0; this.hotSamples = 0; this.hotSince = null; }
    else {
      this.hotSamples = 0; this.hotSince = null;
      const margin = p.recovery_margin_c;
      const below = this.state === 'CRITICAL' ? cpu < p.critical_cpu_c - margin && nvme < p.critical_nvme_c - margin
        : this.state === 'HOT' ? cpu < p.hot_cpu_c - margin && nvme < p.hot_nvme_c - margin && gpu < p.gpu_hot_c - margin
          : cpu < p.warm_cpu_c - margin && nvme < p.warm_nvme_c - margin;
      this.cool = below ? this.cool + 1 : 0;
      if (this.cool >= p.recovery_samples) { this.state = requested; this.cool = 0; this.hotSamples = 0; this.hotSince = null; }
    }
    return { state: this.state, allow_heavy: this.state === 'NORMAL', allow_ai: this.state === 'NORMAL', cool_samples: this.cool };
  }
}

export class ScoutResourceGovernor {
  constructor(store, policy = {}) {
    this.store = store; this.policy = { ...resourcePolicy, ...policy, thermal: { ...resourcePolicy.thermal, ...(policy.thermal ?? {}) } };
    this.thermal = new ThermalGovernor(this.policy.thermal, store.read('thermal-state.json') ?? {});
  }
  evaluate(snapshot, at_ms = Date.now()) {
    const observedAt = new Date(at_ms).toISOString();
    const tempFree = { ...snapshot, observed_at: observedAt, cpu_temp_c: null, nvme_temp_c: null, dgpu: null, igpu: null };
    const history = this.store.read('resource-history.json') ?? [];
    const base = classifyHost(tempFree, history, this.policy);
    const thermal = this.thermal.update(snapshot, at_ms);
    const decision = { ...base, thermal: thermal.state,
      allow_heavy: base.allow_heavy && thermal.allow_heavy,
      allow_ai: base.allow_ai && thermal.allow_ai,
      state: base.state === 'RED' || thermal.state === 'CRITICAL' ? 'RED' : base.state === 'AMBER' || thermal.state !== 'NORMAL' ? 'AMBER' : 'GREEN',
      reasons: [...base.reasons, ...(thermal.state !== 'NORMAL' ? [`thermal ${thermal.state}`] : [])],
      observed_at: observedAt, snapshot: { factory_state: snapshot.factory_state ?? 'unknown', planetiler_active: Boolean(snapshot.planetiler_active),
        local_ai_active: Boolean(snapshot.local_ai_active), mem_available_mb: snapshot.mem_available_mb ?? null,
        swap_used_mb: snapshot.swap_used_mb ?? null, load1: snapshot.load1 ?? null,
        cpu_temp_c: snapshot.cpu_temp_c ?? null, nvme_temp_c: snapshot.nvme_temp_c ?? null,
        dgpu_temp_c: snapshot.dgpu?.temp_c ?? null, igpu_temp_c: snapshot.igpu?.temp_c ?? null,
        disk_free_bytes: snapshot.disk?.free_bytes ?? null } };
    this.store.atomic(path.join(this.store.state, 'thermal-state.json'), this.thermal.serialize());
    this.store.atomic(path.join(this.store.state, 'resource-history.json'), [...history, {
      load1: snapshot.load1 ?? null, swap_used_mb: snapshot.swap_used_mb ?? null,
      mem_available_mb: snapshot.mem_available_mb ?? null, observed_at: observedAt,
    }].slice(-4));
    this.store.atomic(path.join(this.store.state, 'resource.json'), decision);
    return decision;
  }
}

export class HeavyWorkLease {
  constructor(file, { bootId = () => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(); } catch { return null; } }, alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, processStart = procStart } = {}) { this.file = file; this.bootId = bootId; this.alive = alive; this.processStart = processStart; }
  read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; } }
  acquire(owner, { pid = process.pid } = {}) {
    const old = this.read(), boot = this.bootId(), existed = fs.existsSync(this.file);
    if (old && old.boot_id === boot && this.alive(old.pid) && old.process_start === this.processStart(old.pid)) return { ok: false, owner: old.owner };
    if (old || existed) fs.rmSync(this.file, { force: true });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try { const fd = fs.openSync(this.file, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ owner, pid, process_start: this.processStart(pid), boot_id: boot, acquired_at: now() })); fs.fsyncSync(fd); fs.closeSync(fd); return { ok: true, recovered: Boolean(old) }; }
    catch (e) { if (e.code === 'EEXIST') return { ok: false, owner: this.read()?.owner ?? 'unknown' }; throw e; }
  }
  release(owner) { const old = this.read(); if (old?.owner !== owner || old?.pid !== process.pid || old.boot_id !== this.bootId() || old.process_start !== this.processStart(process.pid)) return false; fs.rmSync(this.file, { force: true }); return true; }
}

// Cooperative workload boundary. Call observe() between bounded processing chunks;
// the chunk callback must persist its own resumable checkpoint before yielding.
export class ScoutHeavyWorkCoordinator {
  constructor({ lease, resources, owner, checkpoint, unloadAI = async () => {}, persistCheckpoint = async () => {},
  }) {
    this.lease = lease; this.resources = resources; this.owner = owner;
    this.checkpoint = checkpoint; this.unloadAI = unloadAI; this.persistCheckpoint = persistCheckpoint; this.active = false;
  }
  async start(snapshot, resumeFrom = null) {
    if (this.active) throw new Error('Scout heavy-work session already active');
    const decision = this.resources.evaluate(snapshot);
    if (!decision.allow_heavy) return { started: false, state: decision.state, reason: decision.reasons.join('; ') || `host hold (${decision.thermal})` };
    if (snapshot.factory_coordination_verified !== true) return { started: false, state: 'AMBER', reason: 'BLOCKED_FACTORY_COORDINATION_UNAVAILABLE' };
    const acquired = this.lease.acquire(this.owner);
    if (!acquired.ok) return { started: false, state: 'AMBER', reason: `heavy-work lease held by ${acquired.owner}` };
    this.active = true;
    return { started: true, owner: this.owner, recovered_lease: acquired.recovered, resume_from: clone(resumeFrom) };
  }
  async observe(snapshot) {
    if (!this.active) throw new Error('Scout heavy-work session is not active');
    let decision = this.resources.evaluate(snapshot);
    const shared = this.lease.status?.();
    const coordination = shared?.state;
    const coordinationUnavailable = typeof this.lease.status === 'function' && !shared?.ok;
    const factoryPriority = coordinationUnavailable || Boolean(coordination?.factory_intent || coordination?.lease?.priority === 'factory');
    if (factoryPriority) decision = { ...decision, allow_heavy: false, allow_ai: false, state: 'AMBER',
      reasons: [...decision.reasons, coordinationUnavailable ? 'shared admission status unavailable' : 'factory priority admission requested'] };
    if (decision.allow_heavy) return { yielded: false, decision };
    if (typeof this.checkpoint !== 'function') throw new Error('cooperative heavy work requires a checkpoint callback');
    const checkpoint = await this.checkpoint();
    await this.persistCheckpoint(checkpoint);
    try { await this.unloadAI(); }
    catch (error) { return { yielded: true, checkpoint, decision, lease_released: false, fault: `optional AI stop failed: ${error.message ?? error}` }; }
    const released = this.lease.release(this.owner);
    this.active = !released;
    return { yielded: true, checkpoint, decision, lease_released: released };
  }
  complete() { const released = this.lease.release(this.owner); this.active = !released; return released; }
}

export class NotificationCenter {
  constructor(file, { providers = {}, cooldown_ms = SCOUT_CONFIG.notifications.cooldown_seconds * 1000,
    repeat_reminder_ms = SCOUT_CONFIG.notifications.repeat_reminder_seconds * 1000, now_ms = () => Date.now(), max_events = 1000, max_digest = 5000 } = {}) { this.file = file; this.providers = providers; this.cooldown = cooldown_ms; this.repeatReminder = repeat_reminder_ms; this.clock = now_ms; this.maxEvents = max_events; this.maxDigest = max_digest; }
  state() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { events: [], active: {} }; } }
  save(s) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const t = `${this.file}.tmp-${process.pid}`; const fd = fs.openSync(t, 'w'); fs.writeFileSync(fd, JSON.stringify(s, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(t, this.file); }
  async emit({ key, severity, message, channels = ['EMAIL','SMS'], recovery = false }) { const s = this.state(), old = s.active[key], nowMs = this.clock();
    if (!key || !['INFO','AMBER','RED'].includes(severity) || typeof message !== 'string') throw new Error('notification requires a dedupe key, valid severity, and short message');
    if (recovery) { if (!old || old.resolved) return { sent: false, reason: 'not-active' }; }
    else if (old && !old.resolved) {
      const rank = { INFO: 0, AMBER: 1, RED: 2 };
      if (rank[severity] < rank[old.severity]) return { sent: false, reason: 'lower-severity' };
      if (rank[severity] === rank[old.severity] && nowMs - old.last_sent_ms < Math.max(this.cooldown, this.repeatReminder)) return { sent: false, reason: 'cooldown' };
    }
    const event = { key, severity: recovery ? 'INFO' : severity, message, recovery, at: new Date(nowMs).toISOString(), delivery: {} };
    for (const channel of channels) { try { await this.providers[channel]?.send(event); event.delivery[channel] = this.providers[channel] ? 'sent' : 'unconfigured'; } catch (e) { event.delivery[channel] = `failed: ${e.message ?? e}`; } }
    s.events.push(event); if (s.events.length > this.maxEvents) s.events.splice(0, s.events.length - this.maxEvents);
    if (recovery) s.active[key] = { ...old, resolved: true, recovered_at: event.at }; else s.active[key] = { severity, last_sent_ms: nowMs, resolved: false };
    this.save(s); return { sent: true, event };
  }
  digest(items) { const s = this.state(); s.digest = [...(s.digest ?? []), ...clone(items)].slice(-this.maxDigest); this.save(s); return s.digest.length; }
}

export class TestDeliveryProvider { constructor() { this.deliveries = []; } async send(event) { this.deliveries.push(clone(event)); } }

export function workerLock(file, { bootId = () => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(); } catch { return null; } }, alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, processStart = procStart } = {}) {
  let old = null; try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no lock */ }
  const existed = fs.existsSync(file);
  const boot = bootId(); if (old && old.boot_id === boot && alive(old.pid) && old.process_start === processStart(old.pid)) return { ok: false, owner: old.pid };
  if (old || existed) fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, process_start: processStart(process.pid), boot_id: boot, heartbeat_at: now() })); fs.fsyncSync(fd); fs.closeSync(fd); return { ok: true, recovered: Boolean(old) }; }
  catch (e) { if (e.code === 'EEXIST') return { ok: false, owner: (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).pid; } catch { return null; } })() }; throw e; }
}

export function makeHeartbeat({ status = 'GREEN', job_id = null, source_key = null, current_step = 'idle' } = {}) { return { status, job_id, source_key, current_step, pid: process.pid, boot_id: (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(); } catch { return null; } })(), heartbeat_at: now() }; }
