import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ScoutStore, FakeAdapter, collectAdapter, normalizeObservation, candidateFromObservation, matchMaster, clusterObservations, assessEvidence, consultAI, classifyHost, ThermalGovernor, HeavyWorkLease, NotificationCenter, TestDeliveryProvider, workerLock } from '../../scripts/scout/core.mjs';

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
test('missing geometry and missing name are retained for review', () => {
  const c = candidateFromObservation(obs(null, null)); assessEvidence(c);
  assert.equal(c.geometry, null); assert.equal(c.observations[0].name, null); assert.equal(c.review.state, 'queued');
  assert.ok(c.review.reasons.includes('no usable geometry'));
});
test('AI disabled, absent, timed out, errored, malformed, and nonsense are non-authoritative', async () => {
  assert.equal((await consultAI(null, {}, { enabled: false })).status, 'disabled');
  assert.equal((await consultAI(null, {})).status, 'disabled');
  assert.equal((await consultAI({ assess: () => new Promise(() => {}) }, {}, { timeout_ms: 5 })).status, 'unavailable');
  assert.equal((await consultAI({ assess: () => { throw new Error('provider down'); } }, {})).status, 'unavailable');
  assert.equal((await consultAI({ assess: async () => 'nonsense' }, {})).status, 'malformed');
  assert.equal((await consultAI({ assess: async () => ({ summary: 4, confidence: 'permission granted', suggestions: [] }) }, {})).status, 'malformed');
});
test('AI result is constrained to a bounded advisory structure', async () => {
  const result = await consultAI({ assess: async () => ({ summary: 'review clues', confidence: 'low', suggestions: ['inspect sign'] }) }, {});
  assert.equal(result.status, 'ok'); assert.deepEqual(result.result.suggestions, ['inspect sign']);
});
test('queue restart recovery preserves jobs and duplicate submission returns same job', () => {
  const store = new ScoutStore(path.join(tmp, 'queue-recover')); const a = store.enqueue('synthetic', { x: 1 }), b = store.enqueue('synthetic', { x: 1 });
  assert.equal(a.job_id, b.job_id); store.claim(); assert.equal(store.list('running').length, 1); assert.equal(store.recover(), 1); assert.equal(store.list('pending').length, 1);
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
  for (const s of [{ factory_state: 'building' }, { other_heavy_lease: true }, { mem_available_mb: 1000 }, { swap_used_mb: 3000 }, { local_ai_active: true }]) {
    const r = classifyHost({ ...s, mem_available_mb: s.mem_available_mb ?? 6000, swap_used_mb: s.swap_used_mb ?? 0 });
    assert.equal(r.allow_heavy, false);
  }
  assert.equal(classifyHost({ factory_state: 'idle', mem_available_mb: 6000, swap_used_mb: 0 }).allow_heavy, true);
});
test('Planetiler starting while heavy work is active causes a yield decision', () => {
  const decision = classifyHost({ planetiler_active: true, mem_available_mb: 8000, swap_used_mb: 0 });
  assert.equal(decision.allow_heavy, false); assert.ok(decision.reasons.length);
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
  assert.equal(g.update({ cpu_temp_c: 91 }).state, 'HOT');
  assert.equal(g.update({ cpu_temp_c: 82 }).allow_heavy, false); assert.equal(g.update({ cpu_temp_c: 82 }).allow_heavy, false);
  assert.equal(g.update({ cpu_temp_c: 82 }).allow_heavy, true);
});
test('heavy lease permits one owner and recovers a lease from a previous boot', () => {
  const f = path.join(tmp, 'lease', 'heavy.json'); let boot = 'boot-a';
  const lease = new HeavyWorkLease(f, { bootId: () => boot, alive: () => true });
  assert.equal(lease.acquire('planetiler', { pid: 1 }).ok, true); assert.equal(lease.acquire('scout', { pid: 2 }).ok, false);
  boot = 'boot-b'; assert.equal(lease.acquire('scout', { pid: 2 }).recovered, true);
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
test('notifications queue a digest without credentials', () => {
  const c = new NotificationCenter(path.join(tmp, 'digest', 'state.json'));
  assert.equal(c.digest([{ candidates: 2 }]), 1); assert.deepEqual(c.state().digest, [{ candidates: 2 }]);
});
test('private Scout files stay outside tracked public data and the trail whitelist stays unchanged', () => {
  const store = new ScoutStore(path.join(tmp, 'private-check')); const c = cand([[0, 0], [0.01, 0]]); store.saveCandidate(c);
  assert.ok(fs.existsSync(path.join(store.state, 'candidates', `${c.candidate_id}.json`)));
  const schema = JSON.parse(fs.readFileSync(new URL('../../schema/rtt-trails.schema.json', import.meta.url)));
  assert.ok(JSON.stringify(schema).includes('provenance')); assert.equal(c.observations[0].source_key, 'synthetic-test');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
