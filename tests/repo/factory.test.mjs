// Unattended factory: rules, queue, guards and the worker loop, against a
// throwaway factory under the OS temp dir with harmless test commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { REPO } from '../../scripts/lib/common.mjs';
import { AI_SELECTABLE, REMEDIATIONS, classify, decide } from '../../scripts/factory/rules.mjs';

const eval_ = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/ai-eval.json'), 'utf8'));

// --- rules (authoritative) ----------------------------------------------------
test('rules classify every labelled failure as documented', () => {
  for (const c of eval_.cases) assert.equal(classify(`${c.error}\n${c.log_tail}`).class, c.rules_class, c.id);
});

test('AI suggestions only apply to unknown failures and only from the approved list', () => {
  const job = { remediations: {} };
  const shot = eval_.cases.find((c) => c.id === 'screenshot-diff');
  assert.equal(decide(job, `${shot.error}\n${shot.log_tail}`, { remediation: 'retry-render-tests' }).remediation, 'hold');
  const tamper = eval_.cases.find((c) => c.id === 'jar-tampered');
  assert.equal(decide(job, tamper.error, { remediation: 'resume' }).level, 'RED');
  const unk = eval_.cases.find((c) => c.id === 'java-unknownhost');
  const d = decide(job, unk.log_tail, { remediation: 'retry-after-backoff' });
  assert.deepEqual([d.remediation, d.source], ['retry-after-backoff', 'ai']);
  assert.equal(decide(job, unk.log_tail, { remediation: 'stop-queue' }).remediation, 'hold');
  assert.equal(decide({ remediations: {}, ai_remediations: 1 }, unk.log_tail, { remediation: 'retry-after-backoff' }).level, 'AMBER',
    'at most one AI-chosen remediation per job');
  assert.ok(!AI_SELECTABLE.some((r) => REMEDIATIONS[r].level === 'RED'));
});

test('retry budgets turn GREEN into AMBER', () => {
  const dns = 'curl: (6) Could not resolve host: x';
  assert.equal(decide({ remediations: { 'retry-after-backoff': 1 } }, dns).level, 'GREEN');
  assert.equal(decide({ remediations: { 'retry-after-backoff': 2 } }, dns).level, 'AMBER');
  assert.equal(decide({ remediations: { resume: 2, 'retry-after-backoff': 1, 'retry-reduced-threads': 1 } }, 'interrupted by SIGTERM').level, 'AMBER');
});

test('no remediation edits code, config, styles or goldens', () => {
  for (const [id, r] of Object.entries(REMEDIATIONS)) {
    assert.doesNotMatch(r.description, /\b(edit|commit|update[- ]snapshots|goldens? (are )?updated)\b/i, id);
  }
});

// --- worker against a throwaway factory ----------------------------------------
const factory = fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-factory-'));
const policyFile = path.join(factory, 'policy.yaml');
const basePolicy = {
  regions: { monaco: { enabled: true }, uk: { enabled: true } },
  refuse: { names: ['planet'], url_patterns: ['planet'], max_snapshot_bytes: 20e9 },
  disk: { margin_gb: 1, margin_pct: 0 },
  thermal: {}, power: { require_ac: false },
  ai: { enabled: false },
  worker: { poll_s: 1, stop_timeout_s: 5 },
};
const setPolicy = (patch = {}) => fs.writeFileSync(policyFile, yaml.dump({ ...basePolicy, ...patch }));
setPolicy();

const env = (commands) => ({ ...process.env, FACTORY_DIR: factory, RTT_FACTORY_TEST: '1', RTT_FACTORY_POLICY: policyFile,
  RTT_FACTORY_NO_AI: '1', RTT_FACTORY_FAST: '1', RTT_FACTORY_COMMANDS: JSON.stringify(commands) });
const ctl = (...a) => spawnSync('node', [path.join(REPO, 'scripts/factory/factoryctl.mjs'), ...a],
  { encoding: 'utf8', env: env({}) });
const enqueue = (type, region) => ctl('enqueue', type, region).stdout.trim();
const where = (id) => {
  for (const s of ['pending', 'running', 'held', 'done', 'cancelled']) {
    const f = path.join(factory, 'queue', s, `${id}.json`);
    if (fs.existsSync(f)) return { state: s, job: JSON.parse(fs.readFileSync(f, 'utf8')) };
  }
  return null;
};
/** Run the worker until the queue has nothing runnable (RTT_FACTORY_ONCE). */
const runWorker = (commands) => spawnSync('node', [path.join(REPO, 'scripts/factory/worker.mjs')],
  { encoding: 'utf8', env: { ...env(commands), RTT_FACTORY_ONCE: '1' }, timeout: 60_000 });
const reset = () => { for (const s of ['pending', 'running', 'held', 'done', 'cancelled']) fs.rmSync(path.join(factory, 'queue', s), { recursive: true, force: true }); fs.rmSync(path.join(factory, 'state', 'red.json'), { force: true }); };

test('a successful job ends in done', () => {
  reset();
  const id = enqueue('verify', 'monaco');
  const r = runWorker({ verify: [['sh', '-c', 'echo hello']] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(where(id).state, 'done');
  assert.match(fs.readFileSync(where(id).job.attempts[0].log, 'utf8'), /hello/);
});

test('a network failure is retried later (GREEN backoff)', () => {
  reset();
  const id = enqueue('verify', 'monaco');
  runWorker({ verify: [['sh', '-c', 'echo "curl: (6) Could not resolve host: download.geofabrik.de"; exit 6']] });
  const { state, job } = where(id);
  assert.equal(state, 'pending');
  assert.equal(job.remediations['retry-after-backoff'], 1);
  assert.ok(Date.parse(job.not_before) > Date.now() + 4 * 60_000);
});

test('a screenshot mismatch is held for review (AMBER)', () => {
  reset();
  const id = enqueue('verify', 'monaco');
  runWorker({ verify: [['sh', '-c', 'echo "Error: Screenshot comparison failed:"; exit 1']] });
  assert.equal(where(id).state, 'held');
  assert.equal(where(id).job.held.level, 'AMBER');
});

test('an integrity failure stops the queue (RED) until cleared', async () => {
  reset();
  const bad = enqueue('verify', 'monaco');
  const next = enqueue('verify', 'uk');
  runWorker({ verify: [['sh', '-c', 'echo "planetiler.jar does not match tools.lock"; exit 1']] });
  assert.equal(where(bad).state, 'held');
  assert.ok(fs.existsSync(path.join(factory, 'state', 'red.json')));
  const w = spawn('node', [path.join(REPO, 'scripts/factory/worker.mjs')], { env: env({ verify: [['true']] }) });
  await new Promise((r) => setTimeout(r, 1500));
  w.kill('SIGTERM');
  await new Promise((r) => w.on('close', r));
  assert.equal(where(next).state, 'pending', 'nothing runs while RED');
  assert.match(ctl('status').stdout, /status: RED/);
  ctl('clear-red');
  runWorker({ verify: [['true']] });
  assert.equal(where(next).state, 'done');
});

test('full-planet jobs are refused (RED)', () => {
  reset();
  const id = enqueue('build', 'planet');
  runWorker({ build: [['true']] });
  assert.equal(where(id).state, 'held');
  assert.match(JSON.parse(fs.readFileSync(path.join(factory, 'state', 'red.json'), 'utf8')).reason, /refused/);
});

test('regions not enabled, and refresh jobs, wait for approval (AMBER)', () => {
  reset();
  const other = enqueue('build', 'colorado');
  const refresh = enqueue('refresh', 'monaco');
  runWorker({ build: [['true']], refresh: [['true']] });
  assert.equal(where(other).state, 'held');
  assert.equal(where(refresh).state, 'held');
  ctl('approve', refresh);
  runWorker({ refresh: [['true']] });
  assert.equal(where(refresh).state, 'done');
});

test('the disk guard holds a job that does not fit', () => {
  reset();
  setPolicy({ disk: { margin_gb: 1e6, margin_pct: 0 } });
  const id = enqueue('verify', 'monaco');
  runWorker({ verify: [['true']] });
  setPolicy();
  assert.equal(where(id).state, 'held');
  assert.equal(where(id).job.held.class, 'disk-guard');
  assert.match(ctl('status').stdout, /HELD.*disk guard/);
});

test('a job left running by a dead worker is resumed after restart', () => {
  reset();
  const id = enqueue('verify', 'monaco');
  const p = where(id);
  p.job.attempts.push({ n: 1, started_at: new Date().toISOString() });
  fs.mkdirSync(path.join(factory, 'queue', 'running'), { recursive: true });
  fs.renameSync(path.join(factory, 'queue', 'pending', `${id}.json`), path.join(factory, 'queue', 'running', `${id}.json`));
  fs.writeFileSync(path.join(factory, 'queue', 'running', `${id}.json`), JSON.stringify(p.job));
  runWorker({ verify: [['true']] });
  const { state, job } = where(id);
  assert.equal(state, 'done');
  assert.equal(job.remediations.resume, 1);
  assert.equal(job.attempts[0].decision.class, 'interrupted');
});

test('SIGTERM interrupts the job, records it and requeues it for resume', async () => {
  reset();
  const id = enqueue('verify', 'monaco');
  const w = spawn('node', [path.join(REPO, 'scripts/factory/worker.mjs')], { env: env({ verify: [['sleep', '30']] }) });
  for (let i = 0; i < 50 && where(id)?.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(where(id).state, 'running');
  await new Promise((r) => setTimeout(r, 300));
  w.kill('SIGTERM');
  const code = await new Promise((r) => w.on('close', r));
  assert.equal(code, 0);
  const { state, job } = where(id);
  assert.equal(state, 'pending');
  assert.equal(job.attempts[0].decision.class, 'interrupted');
  assert.equal(job.remediations.resume, 1);
});

test('on SIGTERM the worker waits for the whole job process group to clean up', async () => {
  reset();
  const mark = path.join(factory, 'grandchild-cleaned-up');
  const id = enqueue('verify', 'monaco');
  // The leader exits at once; its child needs 1 s to clean up after SIGTERM.
  const inner = `trap "sleep 1; touch ${mark}; exit 1" TERM; while true; do sleep 0.1; done`;
  const w = spawn('node', [path.join(REPO, 'scripts/factory/worker.mjs')],
    { env: env({ verify: [['sh', '-c', `sh -c '${inner}' & wait`]] }) });
  for (let i = 0; i < 50 && where(id)?.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 500));
  w.kill('SIGTERM');
  await new Promise((r) => w.on('close', r));
  assert.ok(fs.existsSync(mark), 'worker exited before the grandchild finished cleaning up');
  assert.equal(where(id).state, 'pending');
});

test('stale scratch: dead-pid dirs go at once, pid-less dirs after 15 min, live dirs stay', () => {
  const scratch = path.join(factory, 'scratch');
  const mk = (name, ageMin = 0) => {
    const d = path.join(scratch, name);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'data');
    fs.writeFileSync(f, 'x'.repeat(1000));
    const t = (Date.now() - ageMin * 60_000) / 1000;
    fs.utimesSync(f, t, t);
    fs.utimesSync(d, t, t);
  };
  const dead = spawnSync('true').pid;
  mk(`uk-0123456789abcdef-${dead}`);            // dead owner, fresh: stale
  mk(`uk-0123456789abcdef-${process.pid}`);     // live owner: keep
  mk('repro-uk-fresh');                         // no pid, fresh: keep
  mk('repro-uk-old', 30);                       // no pid, 30 min idle: stale
  const r = spawnSync('node', ['-e', "import('./scripts/factory/guards.mjs').then(g => console.log(g.cleanScratch()))"],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, FACTORY_DIR: factory } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(scratch).sort(), [`uk-0123456789abcdef-${process.pid}`, 'repro-uk-fresh'].sort());
  assert.equal(Number(r.stdout.trim()), 2000);
});

test('dashboard shows region, queue, disk, thermals and last failure', () => {
  const out = ctl('status').stdout;
  for (const re of [/^worker /m, /^current /m, /^queue /m, /^disk .*free/m, /^thermals CPU/m, /^ai /m, /^last failure .*interrupted/m]) {
    assert.match(out, re);
  }
  const d = JSON.parse(ctl('status', '--json').stdout);
  assert.ok(d.disk.free_bytes > 0);
});

test.after(() => fs.rmSync(factory, { recursive: true, force: true }));

test('AI helper falls back to rules-only when the model would not fit', async (t) => {
  const { DEFAULTS, readiness, unload } = await import('../../scripts/factory/ai.mjs');
  const live = await readiness({});
  if (/not reachable|not installed/.test(live.reason)) return t.skip(`local AI not available: ${live.reason}`);
  // The VRAM gate applies before loading; a model already 100 % in VRAM is fine.
  await unload(DEFAULTS.model);
  const vram = await readiness({ vram_overhead_mb: 1e6 });
  assert.equal(vram.mode, 'rules-only');
  assert.match(vram.reason, /VRAM|was \d+ % in VRAM/);
  const ram = await readiness({ min_mem_available_mb: 1e7 });
  assert.equal(ram.mode, 'rules-only');
  assert.match(ram.reason, /system RAM/);
});
