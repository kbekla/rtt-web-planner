import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readHostSnapshot } from '../../scripts/scout/resources.mjs';
import { openCanonicalMasterReadOnly } from '../../scripts/scout/canonical-readonly.mjs';
import { parseNvidiaTelemetry, nvidiaQueryAllowed, parseSysfsTemperatureC } from '../../scripts/lib/telemetry.mjs';
import { processIdentity, SharedResourceAdmission } from '../../scripts/lib/resource-admission.mjs';
import { zohoSmtpDefaults } from '../../scripts/scout/zoho-smtp.mjs';
import { ScoutStore, FakeAdapter, collectAdapter, SourceScheduler, normalizeObservation, candidateFromObservation, matchMaster, clusterObservations, assessEvidence, consultAI, consultAIAndRecord, classifyHost, ThermalGovernor, ScoutResourceGovernor, HeavyWorkLease, ScoutHeavyWorkCoordinator, NotificationCenter, TestDeliveryProvider, workerLock } from '../../scripts/scout/core.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-scout-'));
const line = (coords) => ({ type: 'LineString', coordinates: coords });
const master = (coords, id = 'rtt-trail-000000000001') => ({ type: 'Feature', properties: { rtt_id: id }, geometry: line(coords) });
const obs = (coords, id = 'hint-a', extra = {}) => normalizeObservation({ source_id: id, geometry: coords ? line(coords) : null, ...extra }, { sourceKey: 'synthetic-test', observedAt: '2026-10-03T00:00:00.000Z' }).observation;
const cand = (coords, id, extra) => candidateFromObservation(obs(coords, id, extra));
const close = (a, b) => Math.abs(a - b) < 0.0001;

test('normalisation preserves source geometry exactly and records no transformation', () => {
  const source = line([[0, 0], [0.01, 0.01]]);
  const out = normalizeObservation({ geometry: source, hints: ['discovery only'] }, { sourceKey: 'synthetic' });
  assert.deepEqual(out.observation.geometry, source); assert.deepEqual(out.transformations, []);
});
test('source adapters can omit geometry, source id, and name without inventing evidence', async () => {
  const store = new ScoutStore(path.join(tmp, 'adapter-store'));
  const result = await collectAdapter(new FakeAdapter('synthetic-empty', [{ hints: ['possible trail'] }]), store);
  assert.equal(result.queued, 1); const job = store.list('pending')[0];
  const { observation } = normalizeObservation(job.payload, { sourceKey: job.source_key });
  assert.equal(observation.source_id, null); assert.equal(observation.name, null); assert.equal(observation.geometry, null); assert.deepEqual(observation.evidence_metadata, []);
});
test('source evidence metadata and route hints cannot directly establish legal access', () => {
  const c = candidateFromObservation(obs([[0, 0], [0.01, 0]], 'route-hint', { hints: ['community route'], evidence: [{ question: 'motorcycle_access', position: 'supports', reference: 'synthetic-route' }] }));
  assessEvidence(c); assert.equal(c.states.motorcycle_access, 'unknown'); assert.equal(c.evidence.length, 0);
  assert.equal(c.observations[0].evidence_metadata.length, 1);
});
test('exact master geometry produces EXACT_EXISTING and leaves input untouched', () => {
  const c = cand([[0, 0], [0.01, 0.01]]), original = JSON.stringify(master([[0, 0], [0.01, 0.01]]));
  assert.equal(matchMaster(c, [JSON.parse(original)]).type, 'EXACT_EXISTING'); assert.equal(JSON.stringify(master([[0, 0], [0.01, 0.01]])), original);
});
test('antimeridian canonical matching unwraps a computational copy without changing source geometry',()=>{
  const geometry={type:'LineString',coordinates:[[179.9,10],[-179.9,10]]},candidate=candidateFromObservation(obs(null,'dateline',{geometry}));
  const masterFeature=master([[-179.9,10],[179.9,10]],'rtt-trail-dateline');
  const before=JSON.stringify(candidate.geometry),result=matchMaster(candidate,[masterFeature]);
  assert.equal(result.type,'EXACT_EXISTING');assert.deepEqual(result.rtt_ids,['rtt-trail-dateline']);assert.equal(JSON.stringify(candidate.geometry),before);
});
test('exact matching ignores line direction and MultiLineString component order without rewriting observations', () => {
  const g = { type: 'MultiLineString', coordinates: [[[0, 0], [0.01, 0]], [[0, 1], [0.01, 1]]] };
  const reversed = { type: 'MultiLineString', coordinates: [[[0.01, 1], [0, 1]], [[0.01, 0], [0, 0]]] };
  const c = candidateFromObservation(obs(null, 'reversed', { geometry: g }));
  assert.equal(matchMaster(c, [{ type: 'Feature', properties: { rtt_id: 'rtt-trail-000000000001' }, geometry: reversed }]).type, 'EXACT_EXISTING');
  assert.deepEqual(c.geometry, g);
});
test('partial overlap is distinguished from exact identity', () => {
  const c = cand([[0, 0], [0.005, 0.005], [0.01, 0.01]]);
  const m = master([[0.005, 0.005], [0.01, 0.01], [0.015, 0.015]]);
  assert.equal(matchMaster(c, [m], { near_m: 100, partial_overlap: 0.2, likely_overlap: 0.99 }).type, 'PARTIAL_OVERLAP');
});
test('high geometric similarity alone remains ambiguous; trusted identity can raise likely-existing', () => {
  const c = cand([[0, 0], [0.01, 0]]), m = master([[0, 0], [0.01, 0]]);
  m.geometry.coordinates.splice(1, 0, [0.005, 0]);
  assert.equal(matchMaster(c, [m]).type, 'AMBIGUOUS');
  assert.equal(matchMaster(c, [m], {}, () => true).type, 'LIKELY_EXISTING');
});
test('sparse and dense representations of the same partial path get similar length coverage', () => {
  const c = cand([[0, 0], [0.01, 0]]), m = master([[0.005, 0], [0.01, 0], [0.015, 0]]);
  const result = matchMaster(c, [m], { partial_overlap: 0.2 });
  assert.equal(result.type, 'PARTIAL_OVERLAP'); assert.ok(result.scores[0].loose_coverage > 0.45);
});
test('nearby parallel geometry cannot prove identity or join a corridor', () => {
  const a = cand([[0, 0], [0.01, 0]], 'a'), b = cand([[0, 0.0002], [0.01, 0.0002]], 'b');
  assert.equal(matchMaster(a, [master([[0, 0.0002], [0.01, 0.0002]])]).type, 'POSSIBLE_PARALLEL');
  assert.equal(clusterObservations([a, b]).length, 0);
});
test('master matching scales across a synthetic canonical-sized feature set', () => {
  const c = cand([[0, 0], [0.001, 0]], 'scale');
  const features = Array.from({ length: 14_315 }, (_, i) => master([[10 + i * 0.001, 20], [10.0005 + i * 0.001, 20]], `rtt-trail-${String(i).padStart(12, '0')}`));
  const result = matchMaster(c, features);
  assert.equal(result.type, 'NEW_CANDIDATE'); assert.deepEqual(result.scores, []);
});
test('close parallel tracks remain possible-parallel instead of likely-existing or a corridor merge', () => {
  const a = cand([[0, 0], [0.01, 0]], 'close-a'), b = cand([[0, 0.00009], [0.01, 0.00009]], 'close-b');
  const match = matchMaster(a, [master([[0, 0.00009], [0.01, 0.00009]])]);
  assert.equal(match.type, 'POSSIBLE_PARALLEL'); assert.equal(clusterObservations([a, b]).length, 0);
});
test('two independent hints on one corridor cluster without destructive merge', () => {
  const a = cand([[0, 0], [0.01, 0]], 'a'), b = cand([[0, 0], [0.01, 0]], 'b');
  const groups = clusterObservations([a, b]); assert.equal(groups.length, 1); assert.equal(groups[0].candidate_ids.length, 2);
  assert.notEqual(a.candidate_id, b.candidate_id); assert.equal(a.observations.length, 1); assert.equal(b.observations.length, 1);
});
test('three independent states remain separate for existence, legal access, and routeability', () => {
  const c = cand([[0, 0], [0.01, 0]]);
  c.evidence = [{ question: 'physical_existence', position: 'supports', reference: 'synthetic-e1', eligible_for_state: true, review_status: 'qualified' }]; c.states.routability = 'yes'; assessEvidence(c);
  assert.equal(c.states.exists, 'confirmed'); assert.equal(c.states.motorcycle_access, 'unknown'); assert.equal(c.states.routability, 'yes'); assert.equal(c.review.state, 'queued');
  c.evidence.push({ question: 'motorcycle_access', position: 'supports', reference: 'synthetic-e2', eligible_for_state: true, review_status: 'qualified' }); c.states.routability = 'no'; assessEvidence(c);
  assert.equal(c.states.motorcycle_access, 'confirmed'); assert.equal(c.states.routability, 'no');
});
test('contradictory legal evidence stays explicit and queues review', () => {
  const c = cand([[0, 0], [0.01, 0]]); c.evidence = [
    { question: 'motorcycle_access', position: 'supports', reference: 'synthetic-e1', eligible_for_state: true, review_status: 'qualified' },
    { question: 'motorcycle_access', position: 'contradicts', reference: 'synthetic-e2', eligible_for_state: true, review_status: 'qualified' }];
  assessEvidence(c); assert.equal(c.states.motorcycle_access, 'contradictory'); assert.equal(c.review.state, 'queued');
});
test('qualified but provisional evidence stays probable and remains reviewable', () => {
  const c = cand([[0, 0], [0.01, 0]]); c.evidence = [
    { question: 'physical_existence', position: 'supports', certainty: 'probable', reference: 'synthetic-e3', eligible_for_state: true, review_status: 'qualified' },
    { question: 'motorcycle_access', position: 'supports', certainty: 'probable', reference: 'synthetic-e4', eligible_for_state: true, review_status: 'qualified' }];
  assessEvidence(c); assert.equal(c.states.exists, 'probable'); assert.equal(c.states.motorcycle_access, 'probable'); assert.equal(c.review.state, 'queued');
});
test('missing geometry and missing name are retained for review', () => {
  const c = candidateFromObservation(obs(null, null)); assessEvidence(c);
  assert.equal(c.geometry, null); assert.equal(c.observations[0].name, null); assert.equal(c.review.state, 'queued');
  assert.ok(c.review.reasons.includes('no usable geometry'));
});
test('geometry-less candidates cannot be asserted new against an empty master view', () => {
  const result = matchMaster(cand(null), []);
  assert.equal(result.type, 'AMBIGUOUS'); assert.equal(result.reason, 'geometry unavailable');
});
test('source identifiers are path-safe and queue listing rejects traversal', () => {
  assert.throws(() => normalizeObservation({}, { sourceKey: '../private' }), /safe identifier/);
  const store = new ScoutStore(path.join(tmp, 'path-safe'));
  assert.throws(() => store.list('../private'), /invalid Scout queue/);
});
test('AI disabled, absent, timed out, errored, malformed, and nonsense are non-authoritative', async () => {
  assert.equal((await consultAI(null, {}, { enabled: false })).status, 'disabled');
  assert.equal((await consultAI(null, {})).status, 'disabled');
  assert.equal((await consultAI({ assess: () => new Promise(() => {}) }, {}, { enabled: true, timeout_ms: 5 })).status, 'unavailable');
  assert.equal((await consultAI({ assess: () => { throw new Error('provider down'); } }, {}, { enabled: true })).status, 'unavailable');
  assert.equal((await consultAI({ assess: async () => 'nonsense' }, {}, { enabled: true })).status, 'malformed');
  assert.equal((await consultAI({ assess: async () => ({ summary: 4, confidence: 'permission granted', suggestions: [] }) }, {}, { enabled: true })).status, 'malformed');
});
test('AI result is constrained to a bounded advisory structure', async () => {
  const result = await consultAI({ assess: async () => ({ summary: 'review clues', confidence: 'low', suggestions: ['inspect sign'] }) }, {}, { enabled: true });
  assert.equal(result.status, 'ok'); assert.deepEqual(result.result.suggestions, ['inspect sign']);
});
test('queue restart recovery preserves jobs and duplicate submission returns same job', () => {
  const store = new ScoutStore(path.join(tmp, 'queue-recover')); const a = store.enqueue('synthetic', { x: 1 }), b = store.enqueue('synthetic', { x: 1 });
  assert.equal(a.job_id, b.job_id); store.claim(); assert.equal(store.list('running').length, 1); assert.equal(store.recover(), 1); assert.equal(store.list('pending').length, 1);
});
test('crash recovery does not resurrect an already completed queue item', () => {
  const store = new ScoutStore(path.join(tmp, 'queue-terminal')); const j = store.enqueue('synthetic', { x: 9 });
  store.claim(); const completed = { ...j, state: 'done' };
  store.atomic(path.join(store.queue, 'done', `${j.job_id}.json`), completed);
  assert.equal(store.recover(), 0); assert.equal(store.list('pending').length, 0); assert.equal(store.list('done').length, 1);
});
test('source scheduler obeys politeness interval and bounded retry backoff', async () => {
  const store = new ScoutStore(path.join(tmp, 'source-scheduler')); let calls = 0;
  const broken = { key: 'temporary-api', collect: async () => { calls++; throw new Error('offline'); } };
  const scheduler = new SourceScheduler(store, { minimum_interval_ms: 60_000, maximum_failures: 2 });
  const first = await scheduler.run(broken, { now_ms: 1_000_000 }); assert.equal(first.failures, 1); assert.equal(calls, 1);
  assert.equal((await scheduler.run(broken, { now_ms: 1_000_001 })).deferred, true); assert.equal(calls, 1);
  const second = await scheduler.run(broken, { now_ms: 1_061_000 }); assert.equal(second.failures, 2);
  const exhausted = await scheduler.run(broken, { now_ms: 1_181_000 }); assert.equal(exhausted.deferred, true); assert.equal(exhausted.state, 'AMBER'); assert.equal(calls, 2);
});
test('source scheduler enforces a rolling per-minute request cap', async () => {
  const store = new ScoutStore(path.join(tmp, 'source-rate-limit')), nowMs = Date.now();
  const adapter = new FakeAdapter('polite-source', [{ source_id: 'one' }]);
  const scheduler = new SourceScheduler(store, { minimum_interval_ms: 0, max_per_minute: 1 });
  assert.equal((await scheduler.run(adapter, { now_ms: nowMs })).queued, 1);
  assert.equal((await scheduler.run(adapter, { now_ms: nowMs + 1 })).reason, 'source rate limit');
  assert.equal((await scheduler.run(adapter, { now_ms: nowMs + 60_001 })).queued, 1);
});
test('candidate updates are versioned and AI consultations are privately audited', async () => {
  const store = new ScoutStore(path.join(tmp, 'audit')); const c = cand([[0, 0], [0.01, 0]], 'audit'); store.saveCandidate(c);
  const updated = store.updateCandidate(c.candidate_id, (value) => { value.issues.push('inspect junction'); return value; });
  assert.equal(updated.version, 2); assert.ok(updated.issues.includes('inspect junction'));
  await consultAIAndRecord(null, {}, { provider: 'fake', reason: 'synthetic-test', candidate_id: c.candidate_id, evidence_refs: ['synthetic-e1'] }, store, { enabled: true });
  const audit = store.read('ai-audit.json'); assert.equal(audit[0].status, 'disabled'); assert.equal(audit[0].action_taken, 'advisory only');
});
test('worker one-shot recovers, processes queued work, and persists full review context', () => {
  const root = path.join(tmp, 'worker-run'), store = new ScoutStore(root);
  store.enqueue('synthetic', { source_id: 'private-fixture-1', name: null, geometry: null, hints: ['discovery-only'] });
  const r = spawnSync(process.execPath, ['scripts/scout/worker.mjs', '--once'], { cwd: process.cwd(), env: { ...process.env, FACTORY_DIR: root }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(store.list('pending').length, 0); assert.equal(store.list('done').length, 1); assert.equal(store.list('reviews').length, 1);
  const review = store.list('reviews')[0]; assert.ok(review.reasons.includes('no usable geometry')); assert.equal(review.states.motorcycle_access, 'unknown');
  assert.ok(store.read('worker.json').heartbeat_at); assert.ok(store.read('activity.json'));
});
test('worker does not assert a new trail before the canonical master is loaded', () => {
  const root = path.join(tmp, 'worker-unmatched'), store = new ScoutStore(root);
  store.enqueue('synthetic', { source_id: 'unmatched-1', geometry: line([[0, 0], [0.01, 0]]) });
  const r = spawnSync(process.execPath, ['scripts/scout/worker.mjs', '--once'], { cwd: process.cwd(), env: { ...process.env, FACTORY_DIR: root }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); const candidateFile = path.join(store.state, 'candidates', fs.readdirSync(path.join(store.state, 'candidates'))[0]);
  const candidate = JSON.parse(fs.readFileSync(candidateFile));
  assert.equal(candidate.master_match.type, 'UNMATCHED'); assert.equal(candidate.master_match.reason, 'canonical master not loaded');
});
test('source retry is bounded and ultimately held for review', () => {
  const store = new ScoutStore(path.join(tmp, 'retry')); store.enqueue('synthetic', { x: 2 }, { max_attempts: 2 });
  let j = store.claim(); j = store.finish(j, 'done', 'temporary', { base_backoff_ms: 1 }); assert.equal(j.state, 'pending');
  j.not_before = null; store.atomic(path.join(store.queue, 'pending', `${j.job_id}.json`), j); j = store.claim();
  j = store.finish(j, 'done', 'still broken'); assert.equal(j.state, 'held'); assert.match(j.review_reason, /bounded retries/);
});
test('adapter error is contained to its own source state', async () => {
  const store = new ScoutStore(path.join(tmp, 'source-isolation'));
  const bad = await collectAdapter({ key: 'broken-source', collect: async () => { throw new Error('offline'); } }, store);
  const good = await collectAdapter(new FakeAdapter('working-source', [{ source_id: 'x' }]), store);
  assert.equal(bad.queued, 0); assert.equal(good.queued, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.queue, 'sources', 'broken-source.json'))).state, 'AMBER');
});
test('deterministic processing and candidate IDs repeat identically', () => {
  const a = cand([[0, 0], [0.01, 0]], 'same'), b = cand([[0, 0], [0.01, 0]], 'same');
  assert.equal(a.candidate_id, b.candidate_id); assert.deepEqual(a, b);
});
test('factory build, other heavy lease, RAM/swap pressure, and local AI prevent Scout heavy work', () => {
  for (const s of [{ factory_state: 'building' }, { other_heavy_lease: true }, { mem_available_mb: 1000 }, { local_ai_active: true }]) {
    const r = classifyHost({ ...s, mem_available_mb: s.mem_available_mb ?? 6000, swap_used_mb: 0 });
    assert.equal(r.allow_heavy, false);
  }
  const nowMs = 1_800_000_000_000, at = (delta) => new Date(nowMs - delta).toISOString();
  assert.equal(classifyHost({ mem_available_mb: 6000, swap_used_mb: 3000, observed_at: at(0) }).allow_heavy, true, 'one swap sample does not trip contention');
  assert.equal(classifyHost({ mem_available_mb: 6000, swap_used_mb: 3000, observed_at: at(0) },
    [{ swap_used_mb: 3000, observed_at: at(10_000) }, { swap_used_mb: 3000, observed_at: at(20_000) }]).allow_heavy, false);
  assert.equal(classifyHost({ mem_available_mb: 6000, swap_used_mb: 0, load1: 13, observed_at: at(0) },
    [{ load1: 13, observed_at: at(10_000) }, { load1: 13, observed_at: at(20_000) }]).allow_heavy, false);
  assert.equal(classifyHost({ mem_available_mb: 6000, swap_used_mb: 0, load1: 13, observed_at: at(0) },
    [{ load1: 13, observed_at: at(1_000) }, { load1: 13, observed_at: at(2_000) }]).allow_heavy, true, 'rapid samples are not sustained load');
  assert.equal(classifyHost({ factory_state: 'idle', mem_available_mb: 6000, swap_used_mb: 0 }).allow_heavy, true);
});
test('Planetiler starting while heavy work is active causes a yield decision', () => {
  const decision = classifyHost({ planetiler_active: true, mem_available_mb: 8000, swap_used_mb: 0 });
  assert.equal(decision.allow_heavy, false); assert.ok(decision.reasons.length);
});
test('host snapshot reuses factory job state and detects loaded Ollama without starting services', () => {
  const root = path.join(tmp, 'host-snapshot'), running = path.join(root, 'queue', 'running'); fs.mkdirSync(running, { recursive: true });
  fs.writeFileSync(path.join(running, 'job.json'), '{}');
  const snapshot = readHostSnapshot({ factoryDir: root, sample: () => ({ cpu_temp_c: 50, nvme_temp_c: 40, dgpu: { power_w: 170 } }),
    commands: [{ pid: 1, cmdline: 'ollama serve' }], runCommand: (bin, args) => args[0] === 'is-active' ? 'active' : 'NAME ID SIZE PROCESSOR UNTIL\nqwen2.5 123 4GB 100% GPU 2m' });
  assert.equal(snapshot.factory_state, 'building'); assert.equal(snapshot.planetiler_active, false);
  assert.equal(snapshot.local_ai_active, true); assert.equal(snapshot.other_heavy_lease, null);
});
test('an active but unloaded Ollama service is distinguished from model work through its read-only API', () => {
  const snapshot = readHostSnapshot({ factoryDir: path.join(tmp, 'ollama-unloaded'), sample: () => ({}), commands: [],
    runCommand: (bin, args) => args.includes('is-active') ? (args.at(-1) === 'rtt-ollama.service' ? 'active' : 'inactive')
      : bin === 'ollama' ? null : bin === 'curl' ? '{"models":[]}' : null });
  assert.equal(snapshot.ollama_service_active, true);
  assert.equal(snapshot.local_ai_active, false);
});
test('host telemetry reports sampler sources/capacity and additional host contention signals', () => {
  const source = { cpu_temp: '/sys/hwmon/cpu', nvme_temp: '/sys/hwmon/nvme', igpu: '/sys/drm/amdgpu', dgpu: null };
  const capacity = { mem_total_mb: 16000, swap_total_mb: 4000, igpu_vram_total_mb: 512 };
  const root = path.join(tmp, 'host-telemetry'); fs.mkdirSync(path.join(root, 'queue', 'running'), { recursive: true });
  const snapshot = readHostSnapshot({ factoryDir: root, sampler: { sensors: source, host: capacity, sample: () => ({ load1: 1, mem_used_mb: 7000, swap_used_mb: 0 }) },
    commands: [{ pid: 12, cmdline: 'java -jar planetiler.jar' }, { pid: 13, cmdline: 'llama-server --model local.gguf' }], runCommand: () => null });
  assert.deepEqual(snapshot.sensor_sources, source); assert.deepEqual(snapshot.host_capacity, capacity);
  assert.equal(snapshot.planetiler_active, true); assert.equal(snapshot.local_ai_active, true);
  assert.equal(snapshot.factory_state, 'building'); assert.ok(Number.isInteger(snapshot.mem_available_mb));
  assert.ok(Number.isInteger(snapshot.mem_total_mb)); assert.ok(Number.isInteger(snapshot.swap_total_mb));
  assert.ok(Number.isInteger(snapshot.swap_free_mb)); assert.ok(snapshot.disk.free_bytes > 0);
});
test('host snapshot fails closed for unknown Ollama state and corrupt shared lease', () => {
  const root = path.join(tmp, 'host-unknown'), leasePath = path.join(root, 'state', 'heavy-work.json'); fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  fs.writeFileSync(leasePath, '{corrupt');
  const snapshot = readHostSnapshot({ factoryDir: root, sample: () => ({ cpu_temp_c: 50, nvme_temp_c: 40 }),
    commands: [{ pid: 1, cmdline: 'ollama serve' }], runCommand: () => null });
  assert.equal(snapshot.local_ai_active, true); assert.deepEqual(snapshot.other_heavy_lease, { owner: 'unknown', status: 'unreadable' });
  assert.equal(snapshot.factory_coordination_verified, false); assert.equal(snapshot.heavy_work_blocked_reason, 'BLOCKED_FACTORY_COORDINATION_UNVERIFIED');
  assert.ok(snapshot.other_heavy_processes.every((p) => !Object.hasOwn(p, 'cmdline')));
  assert.equal(classifyHost({ ...snapshot, mem_available_mb: 8000, swap_used_mb: 0 }).allow_heavy, false);
});
test('host snapshot exposes shared lease owner and unverified coordination without process arguments', () => {
  const root = path.join(tmp, 'admission-host-status'), file = path.join(root, 'state', 'resource-admission.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  fs.writeFileSync(file, JSON.stringify({ schema: 1, lease: { owner: 'factory-build', priority: 'factory', phase: 'running', boot_id: boot }, factory_intent: null }));
  const snapshot = readHostSnapshot({ factoryDir: root, sample: () => ({ cpu_temp_c: 60, nvme_temp_c: 40 }), commands: [], runCommand: () => null });
  assert.equal(snapshot.factory_coordination.status, 'UNVERIFIED'); assert.equal(snapshot.resource_lease_owner, 'factory-build');
  assert.equal(snapshot.factory_coordination.lease_phase, 'running'); assert.equal(snapshot.heavy_work_blocked_reason, 'BLOCKED_FACTORY_COORDINATION_UNVERIFIED');
});
test('Scout status verifies a fresh factory protocol heartbeat and exposes a pending yield safely', () => {
  const root = path.join(tmp, 'admission-verified-status'), stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir, { recursive: true });
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(stateDir, 'worker.json'), JSON.stringify({ coordination_protocol: 'rtt-heavy-admission-v1', heartbeat_at: now }));
  fs.writeFileSync(path.join(stateDir, 'resource-admission.json'), JSON.stringify({ schema: 1, history: [],
    lease: { owner: 'scout:synthetic', priority: 'background', phase: 'running', boot_id: boot, detail: 'synthetic geometry batch', acquired_at: now, nonce: 'lease-a' },
    factory_intent: { owner: 'factory:verify-123', priority: 'factory', boot_id: boot, acquired_at: now, nonce: 'intent-a' } }));
  const snapshot = readHostSnapshot({ factoryDir: root, sample: () => ({ cpu_temp_c: 60, nvme_temp_c: 40 }), commands: [],
    runCommand: (_bin, args) => args.includes('is-active') ? 'active' : null });
  assert.equal(snapshot.factory_coordination.verified, true);
  assert.equal(snapshot.factory_coordination.status, 'VERIFIED');
  assert.equal(snapshot.factory_coordination.lease_owner, 'scout:synthetic');
  assert.equal(snapshot.factory_coordination.lease_workload, 'synthetic geometry batch');
  assert.equal(snapshot.factory_coordination.yield_requested, true);
  assert.equal(snapshot.factory_coordination.factory_pending, true);
  assert.equal(snapshot.heavy_work_blocked_reason, null);
});
test('scoutctl status combines read-only host, thermal, lease, AI, notification, test and activity state', () => {
  const root = path.join(tmp, 'scoutctl-status'); fs.mkdirSync(root, { recursive: true });
  const result = spawnSync(process.execPath, ['scripts/scout/scoutctl.mjs', 'status'], { cwd: process.cwd(),
    env: { ...process.env, FACTORY_DIR: root }, encoding: 'utf8', timeout: 8000 });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.factory_coordination.verified, false); assert.equal(status.heavy_work_blocked_reason, 'BLOCKED_FACTORY_COORDINATION_UNVERIFIED');
  assert.ok(Object.hasOwn(status.thermal, 'cpu_temp_c')); assert.equal(status.ai.local_ai_active, Boolean(status.host.local_ai_active));
  assert.ok(status.notification_status); assert.equal(status.regression_health.status, 'UNKNOWN');
  assert.equal(status.last_successful_activity, null);
});
test('thermal warm, hot, critical states pause in increasing severity; bogus NVIDIA power is ignored', () => {
  assert.equal(classifyHost({ cpu_temp_c: 86 }).thermal, 'WARM');
  assert.equal(classifyHost({ cpu_temp_c: 91 }).thermal, 'HOT');
  assert.equal(classifyHost({ cpu_temp_c: 99 }).state, 'RED');
  assert.equal(classifyHost({ cpu_temp_c: 40, dgpu: { power_w: 170 }, mem_available_mb: 8000, swap_used_mb: 0 }).thermal, 'NORMAL');
});
test('temperature trend considers recent history, while policy can set thresholds', () => {
  assert.equal(classifyHost({ cpu_temp_c: 60 }, [{ cpu_temp_c: 91 }]).thermal, 'HOT');
  assert.equal(classifyHost({ cpu_temp_c: 60 }, [], { thermal: { warm_cpu_c: 55, hot_cpu_c: 70, critical_cpu_c: 90, warm_nvme_c: 70, hot_nvme_c: 75, critical_nvme_c: 80, gpu_hot_c: 85 } }).thermal, 'WARM');
});
test('thermal hysteresis requires sustained cooling before resuming heavy work', () => {
  const g = new ThermalGovernor({ warm_cpu_c: 85, hot_cpu_c: 90, critical_cpu_c: 98, warm_nvme_c: 65, hot_nvme_c: 72, critical_nvme_c: 80, gpu_hot_c: 85, recovery_margin_c: 5, recovery_samples: 3 });
  assert.equal(g.update({ cpu_temp_c: 91 }, 0).state, 'WARM');
  assert.equal(g.update({ cpu_temp_c: 91 }, 10_000).state, 'WARM'); assert.equal(g.update({ cpu_temp_c: 91 }, 20_000).state, 'HOT');
  assert.equal(g.update({ cpu_temp_c: 82 }, 30_000).allow_heavy, false); assert.equal(g.update({ cpu_temp_c: 82 }, 40_000).allow_heavy, false);
  assert.equal(g.update({ cpu_temp_c: 82 }, 50_000).allow_heavy, true);
});
test('thermal governor uses the hottest available GPU sensor and NVIDIA power is not a thermal input', () => {
  const g = new ThermalGovernor({ warm_cpu_c: 85, hot_cpu_c: 90, critical_cpu_c: 98, warm_nvme_c: 65,
    hot_nvme_c: 72, critical_nvme_c: 80, gpu_hot_c: 85, hot_entry_samples: 1, sample_interval_seconds: 0 });
  assert.equal(g.update({ cpu_temp_c: 60, igpu: { temp_c: 92 }, dgpu: { temp_c: 60, power_w: 170 } }, 10_000).state, 'WARM');
  assert.equal(g.update({ cpu_temp_c: 60, igpu: { temp_c: 92 }, dgpu: { temp_c: 60, power_w: 170 } }, 20_000).state, 'HOT');
  assert.equal(g.update({ cpu_temp_c: 60, igpu: { temp_c: 60 }, dgpu: { temp_c: 60, power_w: 170 } }, 30_000).state, 'HOT', 'one cool sample must not clear HOT');
});
test('NVIDIA telemetry parses temperature/clocks/utilization and never imports bogus power draw', () => {
  const parsed = parseNvidiaTelemetry('56, 22, 1536, 300, 810, SW Power Cap');
  assert.deepEqual(parsed, { temp_c: 56, busy_pct: 22, vram_used_mb: 1536, core_clock_mhz: 300,
    memory_clock_mhz: 810, throttle_reasons: 'SW Power Cap' });
  assert.equal(Object.hasOwn(parsed, 'power_w'), false);
  assert.equal(nvidiaQueryAllowed('active'), true); assert.equal(nvidiaQueryAllowed('suspended'), false);
  assert.equal(parseNvidiaTelemetry('N/A, N/A, 0, N/A, N/A, Not Active').temp_c, null);
});
test('A17 hwmon millidegree readings parse to Celsius and preserve unknown values', () => {
  assert.equal(parseSysfsTemperatureC('54250\n'), 54.25);
  assert.equal(parseSysfsTemperatureC('32850'), 32.85);
  assert.equal(parseSysfsTemperatureC('N/A'), null);
});
test('HOT needs sustained samples while CRITICAL immediately holds', () => {
  const g = new ThermalGovernor({ hot_entry_samples: 3 });
  assert.equal(g.update({ cpu_temp_c: 91 }, 1_000).state, 'WARM');
  assert.equal(g.update({ cpu_temp_c: 91 }, 11_000).state, 'WARM');
  assert.equal(g.update({ cpu_temp_c: 91 }, 21_000).state, 'HOT');
  assert.equal(g.update({ cpu_temp_c: 98 }, 22_000).state, 'CRITICAL');
});
test('resource governor persists thermal state and defers work through a restart', () => {
  const store = new ScoutStore(path.join(tmp, 'resource-persist'));
  let governor = new ScoutResourceGovernor(store, { thermal: { warm_cpu_c: 85, hot_cpu_c: 90, critical_cpu_c: 98,
    warm_nvme_c: 65, hot_nvme_c: 72, critical_nvme_c: 80, gpu_hot_c: 85, recovery_margin_c: 5, recovery_samples: 2 } });
  assert.equal(governor.evaluate({ cpu_temp_c: 91, mem_available_mb: 8000, swap_used_mb: 0 }).allow_heavy, false);
  governor = new ScoutResourceGovernor(store, { thermal: { warm_cpu_c: 85, hot_cpu_c: 90, critical_cpu_c: 98,
    warm_nvme_c: 65, hot_nvme_c: 72, critical_nvme_c: 80, gpu_hot_c: 85, recovery_margin_c: 5, recovery_samples: 2 } });
  assert.equal(governor.evaluate({ cpu_temp_c: 79, mem_available_mb: 8000, swap_used_mb: 0 }).allow_heavy, false);
  const recovered = governor.evaluate({ cpu_temp_c: 79, mem_available_mb: 8000, swap_used_mb: 0 });
  assert.equal(recovered.allow_heavy, true); assert.equal(store.read('resource.json').state, 'GREEN');
});
test('cooperative heavy work is gated, checkpoints on factory/thermal holds, and resumes after cooldown', async () => {
  const root = path.join(tmp, 'cooperative-work'), store = new ScoutStore(root);
  const lease = new HeavyWorkLease(path.join(root, 'state', 'heavy-work.json'));
  const resources = new ScoutResourceGovernor(store, { thermal: { hot_entry_samples: 2, recovery_samples: 2 } });
  const saved = [], stoppedAI = [];
  const worker = new ScoutHeavyWorkCoordinator({ lease, resources, owner: 'scout-bulk', factoryCoordinationVerified: true,
    checkpoint: async () => ({ offset: saved.length + 10 }), persistCheckpoint: async (point) => saved.push(point),
    unloadAI: async () => stoppedAI.push(true) });
  const cool = { factory_state: 'idle', factory_coordination_verified: true, mem_available_mb: 8000, swap_used_mb: 0, cpu_temp_c: 70, nvme_temp_c: 40 };
  assert.equal((await worker.start({ ...cool, factory_state: 'building' })).started, false);
  const started = await worker.start(cool); assert.equal(started.started, true);
  const yielded = await worker.observe({ ...cool, factory_state: 'building' });
  assert.equal(yielded.yielded, true); assert.equal(yielded.lease_released, true); assert.deepEqual(saved, [{ offset: 10 }]); assert.equal(stoppedAI.length, 1);
  const resumed = await worker.start(cool, yielded.checkpoint); assert.equal(resumed.started, true); assert.deepEqual(resumed.resume_from, yielded.checkpoint);
  assert.equal(worker.complete(), true);
  assert.equal((await worker.start(cool)).started, true);
  const warm = await worker.observe({ ...cool, cpu_temp_c: 86 }); assert.equal(warm.yielded, true); assert.equal(warm.decision.thermal, 'WARM');
  assert.equal(worker.active, false);
  assert.equal((await worker.start(cool)).started, false, 'hysteresis must keep work paused until sustained cooldown');
  resources.evaluate(cool); resources.evaluate(cool);
  assert.equal((await worker.start(cool)).started, true); assert.equal(worker.complete(), true);
});
test('heavy lease permits one owner and recovers a lease from a previous boot', () => {
  const f = path.join(tmp, 'lease', 'heavy.json'); let boot = 'boot-a';
  const lease = new HeavyWorkLease(f, { bootId: () => boot, alive: () => true });
  assert.equal(lease.acquire('planetiler', { pid: 1 }).ok, true); assert.equal(lease.acquire('scout', { pid: 2 }).ok, false);
  boot = 'boot-b'; assert.equal(lease.acquire('scout', { pid: 2 }).recovered, true);
});
test('idle host still fails closed for heavy work until factory coordination is verified', async () => {
  const root = path.join(tmp, 'unverified-factory-coordination'), store = new ScoutStore(root);
  const lease = new HeavyWorkLease(path.join(root, 'state', 'heavy-work.json'));
  const worker = new ScoutHeavyWorkCoordinator({ lease, resources: new ScoutResourceGovernor(store), owner: 'scout-bulk' });
  const result = await worker.start({ factory_state: 'idle', mem_available_mb: 8000, swap_used_mb: 0, cpu_temp_c: 60, nvme_temp_c: 35 });
  assert.deepEqual([result.started, result.state, result.reason], [false, 'AMBER', 'BLOCKED_FACTORY_COORDINATION_UNAVAILABLE']);
  assert.equal(fs.existsSync(path.join(root, 'state', 'heavy-work.json')), false, 'blocked start must not take the shared lease');
  const verified = await worker.start({ factory_state: 'idle', factory_coordination_verified: true, mem_available_mb: 8000, swap_used_mb: 0 });
  assert.equal(verified.started, true, 'a fresh read-only factory heartbeat can unlock the shared admission path');
  assert.equal(worker.complete(), true);
});
test('Scout heavy work waits for another local AI lease owner', async () => {
  const root = path.join(tmp, 'ai-heavy-lease'), store = new ScoutStore(root);
  const lease = new HeavyWorkLease(path.join(root, 'state', 'heavy-work.json'));
  assert.equal(lease.acquire('ollama').ok, true);
  const resources = new ScoutResourceGovernor(store);
  const worker = new ScoutHeavyWorkCoordinator({ lease, resources, owner: 'scout-ai', checkpoint: async () => null, factoryCoordinationVerified: true });
  const result = await worker.start({ factory_state: 'idle', factory_coordination_verified: true, mem_available_mb: 8000, swap_used_mb: 0 });
  assert.equal(result.started, false); assert.match(result.reason, /ollama/);
  assert.equal(lease.release('ollama'), true);
});
test('shared admission serializes factory priority, Scout yield and resume admission', async () => {
  const admission = new SharedResourceAdmission(path.join(tmp, 'shared-admission', 'state.json'));
  const scout = admission.acquire('scout-bulk'); assert.equal(scout.ok, true);
  const intent = admission.requestFactory('scout-bulk');
  assert.equal(intent.granted, false); assert.match(intent.reason, /waiting-for-background-yield/);
  assert.equal(admission.pollFactory('scout-bulk', intent.nonce).granted, false, 'matching labels cannot bypass a different-priority lease');
  assert.equal(admission.acquire('scout-ai').ok, false, 'factory intent blocks new low-priority admission');
  assert.equal(admission.release('scout-bulk'), true, 'checkpointed Scout work releases its lease');
  const factory = admission.pollFactory('scout-bulk', intent.nonce);
  assert.equal(factory.granted, true);
  assert.equal(admission.acquire('scout-ai').ok, false, 'factory lease excludes Scout/local AI');
  assert.equal(admission.bindWorkload('scout-bulk', factory.lease.nonce, { pgid: process.pid }).ok, false,
    'work must not be bound before the launch handshake');
  assert.equal(admission.beginLaunch('scout-bulk', factory.lease.nonce).ok, true);
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  assert.equal(admission.bindWorkload('scout-bulk', factory.lease.nonce, { ...processIdentity(child.pid), pgid: child.pid }).ok, true);
  process.kill(-child.pid, 'SIGTERM'); await new Promise((resolve) => child.once('close', resolve));
  assert.equal(admission.workloadFinished('scout-bulk', factory.lease.nonce).ok, true);
  assert.equal(admission.release('scout-bulk', factory.lease.nonce).ok, true);
  assert.equal(admission.acquire('scout-ai').ok, true, 'Scout can resume after factory completion');
});
test('active Scout work checkpoints and unloads optional AI when factory intent arrives', async () => {
  const root = path.join(tmp, 'shared-admission-yield'), admission = new SharedResourceAdmission(path.join(root, 'state', 'resource-admission.json'));
  const resources = new ScoutResourceGovernor(new ScoutStore(root)); let checkpoints = 0, unloads = 0, persisted = null;
  const scout = new ScoutHeavyWorkCoordinator({ lease: admission, resources, owner: 'scout-bulk', factoryCoordinationVerified: true,
    checkpoint: async () => { checkpoints++; return { offset: 12 }; }, persistCheckpoint: async (c) => { persisted = c; }, unloadAI: async () => { unloads++; } });
  const snapshot = { factory_state: 'idle', factory_coordination_verified: true, mem_available_mb: 8000, swap_used_mb: 0 };
  assert.equal((await scout.start(snapshot)).started, true);
  const intent = admission.requestFactory('factory-worker'); assert.equal(intent.granted, false);
  const yielded = await scout.observe(snapshot);
  assert.equal(yielded.yielded, true); assert.equal(yielded.lease_released, true);
  assert.deepEqual(persisted, { offset: 12 }); assert.equal(checkpoints, 1); assert.equal(unloads, 1);
  assert.equal(admission.pollFactory('factory-worker', intent.nonce).granted, true);
});
test('shared admission rejects uncertain workload ownership and recovers only proven stale boots', async () => {
  const file = path.join(tmp, 'shared-admission-stale', 'state.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const admission = new SharedResourceAdmission(file);
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const deadOwner = spawn('true');
  await new Promise((resolve, reject) => { deadOwner.once('spawn', resolve); deadOwner.once('error', reject); });
  const deadIdentity = processIdentity(deadOwner.pid);
  await new Promise((resolve) => deadOwner.once('close', resolve));
  const child = spawn(process.execPath, [path.resolve('scripts/factory/resource-admission-exec.mjs'), 'test-nonce', process.cwd(), '["true"]'],
    { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const currentPgid = child.pid;
  fs.writeFileSync(file, JSON.stringify({ schema: 1, boot_id: boot, factory_intent: null, history: [], lease: {
    owner: 'crashed-factory', priority: 'factory', phase: 'running', pid: deadIdentity.pid, process_start: deadIdentity.process_start, boot_id: boot,
    nonce: 'test-nonce', workload: { pid: child.pid, pgid: currentPgid, process_start: processIdentity(child.pid).process_start, boot_id: boot },
  } }));
  assert.equal(admission.acquire('scout-after-crash').ok, false, 'a surviving workload group keeps admission closed after worker death');
  const state = JSON.parse(fs.readFileSync(file, 'utf8')); state.lease.phase = 'reserved'; state.lease.workload = null; fs.writeFileSync(file, JSON.stringify(state));
  child.stdin.end(); await new Promise((resolve) => child.once('close', resolve));
  assert.equal(admission.acquire('scout-after-unbound-spawn-crash').ok, true,
    'an unbound wrapper exits on owner pipe closure before Scout reclaims the reserved lease');
  const rebootState = JSON.parse(fs.readFileSync(file, 'utf8')); rebootState.lease.boot_id = 'previous-boot'; fs.writeFileSync(file, JSON.stringify(rebootState));
  assert.equal(admission.acquire('scout-after-reboot').ok, true, 'a proven prior boot has no surviving workload');
});
test('concurrent shared admission grants at most one background worker', async () => {
  const state = path.join(tmp, 'shared-admission-race', 'state.json');
  const code = `import { SharedResourceAdmission } from ${JSON.stringify(new URL('../../scripts/lib/resource-admission.mjs', import.meta.url).href)}; const hold = setInterval(() => {}, 1000); const r = new SharedResourceAdmission(process.argv[1]).acquire(process.argv[2]); console.log(JSON.stringify(r));`;
  const run = (owner) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, state, owner], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '', settled = false; child.stderr.on('data', (b) => error += b);
    child.stdout.on('data', (b) => { output += b; const line = output.split('\n')[0]; if (!settled && line) { settled = true; resolve({ child, result: JSON.parse(line) }); } });
    child.on('error', reject); child.on('close', (status) => { if (!settled) reject(new Error(`synthetic coordinator worker failed (${status}): ${error.slice(0, 200)}`)); });
  });
  const workers = await Promise.all([run('worker-a'), run('worker-b')]);
  const results = workers.map((w) => w.result);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 1);
  for (const worker of workers) worker.child.kill('SIGTERM');
  await Promise.all(workers.map(({ child }) => new Promise((resolve) => child.once('close', resolve))));
});
test('worker lock ignores stale boot ownership', () => {
  const f = path.join(tmp, 'worker-lock', 'lock.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ pid: 1, boot_id: 'old' }));
  assert.equal(workerLock(f, { bootId: () => 'new', alive: () => true }).recovered, true);
});
test('notification dedupe, escalation, recovery, and provider errors never throw', async () => {
  let clock = 1000; const email = new TestDeliveryProvider(); const failing = { send: async () => { throw new Error('offline'); } };
  const center = new NotificationCenter(path.join(tmp, 'notify', 'state.json'), { providers: { EMAIL: email, SMS: failing }, cooldown_ms: 100, now_ms: () => clock });
  assert.equal((await center.emit({ key: 'hot', severity: 'AMBER', message: 'warm' })).sent, true);
  assert.equal((await center.emit({ key: 'hot', severity: 'AMBER', message: 'warm' })).reason, 'cooldown');
  clock += 101; assert.equal((await center.emit({ key: 'hot', severity: 'RED', message: 'critical' })).sent, true);
  assert.equal((await center.emit({ key: 'hot', severity: 'INFO', message: 'recovered', recovery: true })).sent, true);
  assert.equal(email.deliveries.length, 3); assert.match(center.state().events[0].delivery.SMS, /failed/);
});
test('notification severity cannot downgrade an active RED and can remind after its interval', async () => {
  let clock = 10_000; const center = new NotificationCenter(path.join(tmp, 'notify-escalation', 'state.json'),
    { cooldown_ms: 100, repeat_reminder_ms: 500, now_ms: () => clock });
  await center.emit({ key: 'integrity', severity: 'RED', message: 'integrity hold' });
  assert.equal((await center.emit({ key: 'integrity', severity: 'AMBER', message: 'degraded' })).reason, 'lower-severity');
  clock += 501; assert.equal((await center.emit({ key: 'integrity', severity: 'RED', message: 'still held' })).sent, true);
  const restarted = new NotificationCenter(path.join(tmp, 'notify-escalation', 'state.json'), { now_ms: () => clock });
  assert.equal(restarted.state().events.length, 2);
});
test('corrupt persistent queue enters durable RED and refuses another worker pass', () => {
  const root = path.join(tmp, 'worker-corrupt'), store = new ScoutStore(root); store.ensure();
  fs.writeFileSync(path.join(store.queue, 'pending', 'bad.json'), '{broken');
  const first = spawnSync(process.execPath, ['scripts/scout/worker.mjs', '--once'], { cwd: process.cwd(), env: { ...process.env, FACTORY_DIR: root }, encoding: 'utf8' });
  assert.equal(first.status, 0); assert.match(store.read('red.json').reason, /queue recovery failed/);
  const second = spawnSync(process.execPath, ['scripts/scout/worker.mjs', '--once'], { cwd: process.cwd(), env: { ...process.env, FACTORY_DIR: root }, encoding: 'utf8' });
  assert.equal(second.status, 0); assert.equal(store.read('red.json').status, 'RED');
});
test('notifications queue a digest without credentials', () => {
  const c = new NotificationCenter(path.join(tmp, 'digest', 'state.json'));
  assert.equal(c.digest([{ candidates: 2 }]), 1); assert.deepEqual(c.state().digest, [{ candidates: 2 }]);
});
test('Zoho SMTP defaults expose configuration and credential path but no credential value', () => {
  assert.deepEqual({ host: zohoSmtpDefaults.host, port: zohoSmtpDefaults.port, username: zohoSmtpDefaults.username,
    from: zohoSmtpDefaults.from, fromName: zohoSmtpDefaults.fromName }, {
    host: 'smtp.zoho.eu', port: 587, username: 'info@roadtrailandtide.com',
    from: 'scouta17@roadtrailandtide.com', fromName: 'RT&T Scout A17',
  });
  assert.equal(zohoSmtpDefaults.credentialFile, '/home/karl/.config/rtt-scout/credentials/zoho-smtp-password');
  assert.equal(Object.hasOwn(zohoSmtpDefaults, 'password'), false);
});
test('private Scout files stay outside tracked public data and the trail whitelist stays unchanged', () => {
  const store = new ScoutStore(path.join(tmp, 'private-check')); const c = cand([[0, 0], [0.01, 0]]); store.saveCandidate(c);
  assert.ok(fs.existsSync(path.join(store.state, 'candidates', `${c.candidate_id}.json`)));
  const schema = JSON.parse(fs.readFileSync(new URL('../../schema/rtt-trails.schema.json', import.meta.url)));
  assert.ok(JSON.stringify(schema).includes('provenance')); assert.equal(c.observations[0].source_key, 'synthetic-test');
});

test('canonical master integration requires explicit 14,315-feature input and only matches read-only', () => {
  const f = path.join(tmp, 'explicit-canonical-master.geojson');
  const features = Array.from({ length: 14315 }, (_, i) => ({ type: 'Feature', properties: { rtt_id: `rtt-trail-${String(i).padStart(6, '0')}` },
    geometry: i === 0 ? line([[-1, 50], [-0.999, 50]]) : i === 1 ? line([[-1, 50.00001], [-0.999, 50.00001]]) : { type: 'Point', coordinates: [i % 170, -80 + (i % 160)] } }));
  const content = JSON.stringify({ type: 'FeatureCollection', features }); fs.writeFileSync(f, content);
  const before = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  assert.throws(() => openCanonicalMasterReadOnly(), /supplied explicitly/);
  const link = `${f}.link`; fs.symlinkSync(f, link);
  assert.throws(() => openCanonicalMasterReadOnly(link), /cannot open explicit canonical master read-only/);
  const master = openCanonicalMasterReadOnly(f);
  assert.equal(master.feature_count, 14315); assert.equal(master.sha256, before);
  assert.deepEqual(Object.keys(master).sort(), ['feature_count', 'match', 'sha256', 'source_path'].sort(), 'matching API exposes no master record collection or write method');
  const result = master.match(cand([[-1, 50], [-0.999, 50]]));
  assert.equal(result.type, 'EXACT_EXISTING'); assert.deepEqual(result.rtt_ids, ['rtt-trail-000000']);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), before, 'matching must not mutate the supplied master');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
