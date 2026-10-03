#!/usr/bin/env node
// Unattended factory worker, run by rtt-factory.service from the deployed runner
// checkout ($FACTORY_DIR/runner/repo). One job at a time, forever.
//
// Loop: pick the next pending job -> gates (RED stop, refusal, approval, runner
// integrity, power/thermal wait, disk guard) -> run the deterministic command ->
// done, or classify the failure with scripts/factory/rules.mjs and apply exactly
// the remediation the rules allow (GREEN), hold for a human (AMBER) or stop the
// queue (RED).
//
// Checkpointing: jobs are durable files; pipeline steps are idempotent (pinned
// inputs are re-verified, an existing build ID is reused, tests and promotion
// re-run). After a crash, power loss or reboot, a job left in running/ is
// recovered as "interrupted" and resumed. A Planetiler run that was cut off
// restarts that region's build from the beginning; Planetiler has no internal
// checkpoint, and the partial attempt is preserved in logs/failures/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { FACTORY, REPO } from '../lib/common.mjs';
import { classify, decide } from './rules.mjs';
import { diagnose } from './ai.mjs';
import { cleanScratch, diskCheck, refusal, startWait } from './guards.mjs';
import * as Q from './queue.mjs';

const policy = Q.loadPolicy();
const POLL_MS = (policy.worker?.poll_s ?? 30) * 1000 * (process.env.RTT_FACTORY_FAST ? 0.02 : 1);
const STOP_TIMEOUT_MS = (policy.worker?.stop_timeout_s ?? 90) * 1000;
const WORKER_FILE = path.join(Q.STATE_DIR, 'worker.json');
const git = (...a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }).stdout.trim();
const commit = git('rev-parse', 'HEAD');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

let state = { pid: process.pid, commit, repo: REPO, started_at: new Date().toISOString(), phase: 'starting', job: null };
let stopping = false;
let child = null;
let lastGroup = null;

/**
 * On stop, wait until every process in the job's group has exited, not just its
 * leader, so grandchildren (build-region) can finish cleaning up and recording
 * their failure before systemd kills what is left of the unit.
 */
async function waitForGroup(pgid, ms) {
  const deadline = Date.now() + ms;
  while (pgid && Date.now() < deadline) {
    try { process.kill(-pgid, 0); } catch { return true; }
    await sleep(200);
  }
  return false;
}

function heartbeat(patch = {}) {
  state = { ...state, ...patch, heartbeat_at: new Date().toISOString() };
  Q.writeJsonAtomic(WORKER_FILE, state);
}

// --- single instance --------------------------------------------------------
const bootId = () => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } };

/** Is `pid` a live factory worker (not just any process that reused the pid)? */
function isWorker(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some((a) => a.endsWith('factory/worker.mjs')); } catch { return false; }
}

/**
 * Single-instance lock. The lock records the pid and the boot it was taken in.
 * It only counts if it is from this boot and the pid is still a worker, so a
 * pid reused after a reboot (or by an unrelated process) never blocks startup.
 */
function acquire() {
  Q.ensureDirs();
  const lockFile = path.join(Q.STATE_DIR, 'worker.pid');
  let held = null;
  try {
    const text = fs.readFileSync(lockFile, 'utf8').trim();
    held = text.startsWith('{') ? JSON.parse(text) : { pid: Number(text), boot_id: null }; // old plain-pid format
  } catch { /* no lock */ }
  if (held?.pid && held.pid !== process.pid && (held.boot_id === null || held.boot_id === bootId()) && isWorker(held.pid)) {
    log(`another worker (pid ${held.pid}) is running; exiting`);
    process.exit(1);
  }
  if (held?.pid && held.pid !== process.pid) log(`replacing stale worker lock (pid ${held.pid}${held.boot_id && held.boot_id !== bootId() ? ', previous boot' : ', not a worker'})`);
  Q.writeJsonAtomic(lockFile, { pid: process.pid, boot_id: bootId(), started_at: new Date().toISOString() });
}

/** Remove temp files left by atomic writes of processes that are gone (e.g. killed workers). */
function cleanTempFiles() {
  let n = 0;
  for (const dir of [Q.STATE_DIR, ...Q.STATES.map((s) => path.join(Q.QUEUE, s))]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const pid = Number(/\.tmp-(\d+)$/.exec(f)?.[1]);
      if (!pid || pid === process.pid) continue;
      try { process.kill(pid, 0); continue; } catch { /* writer is gone */ }
      fs.rmSync(path.join(dir, f), { force: true });
      n++;
    }
  }
  return n;
}

// --- job commands -----------------------------------------------------------
const UNIT_TESTS = ['--test', 'tests/repo/*.test.mjs', 'tests/schema/*.test.mjs', 'tests/attribution/*.test.mjs'];
function command(job) {
  // Tests substitute harmless commands (queue.TEST_MODE only: throwaway factory under /tmp).
  if (Q.TEST_MODE && process.env.RTT_FACTORY_COMMANDS) return JSON.parse(process.env.RTT_FACTORY_COMMANDS)[job.type];
  const r = job.region;
  switch (job.type) {
    case 'build': return [['scripts/pipeline', r]];
    case 'verify': return [['node', ...UNIT_TESTS], ['npx', 'playwright', 'test']];
    case 'repro': return [['node', 'scripts/check-repro.mjs', r]];
    case 'refresh': return [['node', 'scripts/fetch-region.mjs', r, '--refresh'], ['scripts/pipeline', r]];
    // RT&T trail layer: validate -> build -> style -> tests -> render tests -> promote.
    case 'trails': return [['scripts/rtt/pipeline-trails', policy.trails?.input ?? 'tests/fixtures/rtt/trails-synthetic.geojson']];
    default: throw new Error(`unknown job type ${job.type}`);
  }
}

function tail(file, n = 80) {
  if (!fs.existsSync(file)) return '';
  const size = fs.statSync(file).size;
  const len = Math.min(size, 128 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  // eslint-disable-next-line no-control-regex
  return buf.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-n).join('\n');
}

/** Run each command in sequence in its own process group; resolves { code, signal, step }. */
async function runSteps(job, logFile) {
  const out = fs.openSync(logFile, 'a');
  const env = { ...process.env, FACTORY_DIR: FACTORY, RTT_REGION: job.region, RTT_BUILD_ID: job.type === 'verify' ? 'current' : (process.env.RTT_BUILD_ID ?? '') };
  if (!env.RTT_BUILD_ID) delete env.RTT_BUILD_ID;
  if (job.options?.threads) env.PLANETILER_THREADS = String(job.options.threads);
  try {
    for (const [i, argv] of command(job).entries()) {
      fs.writeSync(out, `\n### ${new Date().toISOString()} step ${i + 1}: ${argv.join(' ')}\n`);
      const res = await new Promise((resolve) => {
        child = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', out, out], detached: true });
        lastGroup = child.pid;
        heartbeat({ child_pid: child.pid });
        child.on('error', (e) => resolve({ code: 127, signal: null, error: e.message }));
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
      child = null;
      if (res.code !== 0) return { ...res, step: i + 1, argv };
      if (stopping) return { code: 130, signal: 'SIGTERM', step: i + 1, argv };
    }
    return { code: 0 };
  } finally {
    fs.closeSync(out);
    heartbeat({ child_pid: null });
  }
}

// --- failure handling -------------------------------------------------------
async function handleFailure(job, from, text, meta = {}) {
  let ai = null;
  // The AI is consulted only where it can matter: failures the rules can't
  // classify. Never while shutting down.
  if (policy.ai?.enabled && !process.env.RTT_FACTORY_NO_AI && !stopping && classify(text).class === 'unknown') {
    const lastStage = readPipelineStep(job.region);
    ai = await diagnose({ job: `${job.type} ${job.region}`, stage: meta.stage ?? lastStage, exit_code: meta.exit_code,
      // The failed job's processes have exited, so the factory is idle: the helper may use
      // the whole machine. Its CPU mode still checks load and RAM, so stragglers keep it on the GPU.
      error: text.split('\n')[0], log_tail: text }, policy.ai, { busy: false })
      .catch((e) => ({ suggestion: null, mode: 'rules-only', reason: e.message }));
  }
  const d = decide(job, text, ai?.suggestion ?? null);
  const attempt = job.attempts.at(-1);
  if (attempt) Object.assign(attempt, { decision: d, ai: ai && { mode: ai.mode, reason: ai.reason ?? null, suggestion: ai.suggestion ?? null, stats: ai.stats ?? null } });
  Q.event(job, `failure: ${d.class} -> ${d.remediation} (${d.level}, ${d.source})`, { why: d.why });
  log(`${job.id}: ${d.class} -> ${d.remediation} [${d.level}] ${d.why}`);

  if (d.level === 'GREEN') {
    job.remediations[d.remediation] = (job.remediations[d.remediation] ?? 0) + 1;
    if (d.source === 'ai') job.ai_remediations = (job.ai_remediations ?? 0) + 1;
    const n = job.remediations[d.remediation];
    if (d.remediation === 'retry-after-backoff') job.not_before = new Date(Date.now() + (n === 1 ? 5 : 30) * 60_000).toISOString();
    if (d.remediation === 'retry-reduced-threads') {
      job.options.threads = Math.max(1, Math.floor((job.options.threads ?? os.cpus().length) / 2));
    }
    if (d.remediation === 'clean-scratch') Q.event(job, `clean-scratch freed ${(cleanScratch() / 1e9).toFixed(1)} GB`);
    Q.move(job, from, 'pending');
  } else {
    job.held = { at: new Date().toISOString(), level: d.level, class: d.class, reason: d.why };
    Q.move(job, from, 'held');
    if (d.level === 'RED') Q.setRed(`${d.class}: ${d.why}`, job.id);
  }
}

function readPipelineStep(region) {
  try { return JSON.parse(fs.readFileSync(path.join(Q.STATE_DIR, `pipeline-${region}.json`), 'utf8')).step; } catch { return null; }
}

/** Jobs left in running/ by a worker that died (crash, kill, power loss, reboot). */
async function recover() {
  const orphans = Q.list('running');
  // Killed or interrupted builds leave scratch behind; clear what no live process owns.
  const freed = cleanScratch();
  if (freed) log(`startup: cleaned ${(freed / 1e6).toFixed(0)} MB of stale scratch`);
  const temps = cleanTempFiles();
  if (temps) log(`startup: removed ${temps} stale temp file(s)`);
  for (const job of orphans) {
    const a = job.attempts.at(-1);
    if (a && !a.ended_at) Object.assign(a, { ended_at: new Date().toISOString(), result: 'aborted' });
    log(`recovering ${job.id} (worker restarted during the job)`);
    Q.event(job, 'recovered after worker restart');
    await handleFailure(job, 'running',
      `worker restarted: the previous worker exited during the job (state: aborted)\n${a?.log ? tail(a.log, 40) : ''}`);
  }
}

function runnerDirty() {
  if (Q.TEST_MODE) return [];
  const lines = git('status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean);
  // Lock files rewritten by an approved refresh job are expected.
  return lines.filter((l) => !/config\/regions\/[a-z0-9-]+\.lock\.json$/.test(l));
}

// --- gates + run ------------------------------------------------------------
async function runOne(job) {
  const refused = refusal(job, policy);
  if (refused) {
    job.attempts.push({ n: job.attempts.length + 1, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), result: 'refused' });
    return handleFailure(job, 'pending', refused);
  }
  const needsApproval = job.type === 'refresh'
    || (job.type === 'trails' ? !policy.trails?.enabled : !policy.regions?.[job.region]?.enabled);
  if (needsApproval && !job.approved) {
    job.held = { at: new Date().toISOString(), level: 'AMBER', class: 'approval',
      reason: job.type === 'refresh' ? 'New OSM snapshots need approval (AMBER).'
        : job.type === 'trails' ? 'RT&T trail builds are not enabled (trails.enabled in config/factory.yaml) (AMBER).'
          : `Region '${job.region}' is not enabled in config/factory.yaml (AMBER).` };
    Q.event(job, 'held: needs approval');
    return Q.move(job, 'pending', 'held');
  }
  const dirty = runnerDirty();
  if (dirty.length) {
    Q.setRed(`runner checkout ${REPO} has uncommitted changes to tracked files: ${dirty.join('; ')}`);
    return;
  }
  const wait = startWait(policy);
  if (wait) { heartbeat({ phase: 'waiting', wait_reason: wait, job: job.id }); return; }
  let disk = diskCheck(job, policy);
  if (!disk.ok) {
    const freed = cleanScratch();
    disk = diskCheck(job, policy);
    if (!disk.ok) {
      job.held = { at: new Date().toISOString(), level: 'AMBER', class: 'disk-guard', reason: `disk guard: ${disk.reason}` };
      Q.event(job, `held: disk guard (${disk.reason}; cleaned ${(freed / 1e9).toFixed(1)} GB)`);
      return Q.move(job, 'pending', 'held');
    }
  }

  const n = job.attempts.length + 1;
  const logDir = path.join(Q.QUEUE, 'logs', job.id);
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `attempt-${n}.log`);
  job.attempts.push({ n, started_at: new Date().toISOString(), log: logFile, disk: disk.reason, worker_pid: process.pid, commit });
  Q.event(job, `attempt ${n} started`);
  Q.move(job, 'pending', 'running');
  heartbeat({ phase: 'running', job: job.id, job_started_at: new Date().toISOString(), wait_reason: null });
  log(`${job.id}: attempt ${n} (${disk.reason})`);

  const res = await runSteps(job, logFile);
  if (stopping && lastGroup) {
    const gone = await waitForGroup(lastGroup, STOP_TIMEOUT_MS * 0.9);
    log(`job process group ${lastGroup} ${gone ? 'exited' : 'still running at stop timeout'}`);
  }
  const a = job.attempts.at(-1);
  a.ended_at = new Date().toISOString();
  if (res.code === 0) {
    a.result = 'ok';
    Q.event(job, `attempt ${n} succeeded`);
    Q.move(job, 'running', 'done');
    log(`${job.id}: done`);
  } else {
    a.result = 'failed';
    a.exit_code = res.code;
    const why = stopping ? `interrupted by SIGTERM (worker stop) during step ${res.step}`
      : `step ${res.step} (${res.argv.join(' ')}) exited ${res.code ?? res.signal}${res.error ? `: ${res.error}` : ''}`;
    await handleFailure(job, 'running', `${why}\n${tail(logFile)}`, { exit_code: res.code });
  }
  heartbeat({ phase: 'idle', job: null, job_started_at: null });
}

/** Block system sleep while the worker runs (a child, so it dies with the unit). */
function inhibitSleep() {
  if (Q.TEST_MODE) return null;
  const p = spawn('systemd-inhibit', ['--what=sleep:idle', '--who=rtt-factory', '--why=unattended map builds',
    '--mode=block', 'sleep', 'infinity'], { stdio: 'ignore' });
  p.on('error', (e) => log(`sleep inhibitor unavailable: ${e.message}`));
  p.on('exit', (code) => { if (!stopping) log(`sleep inhibitor exited (${code})`); });
  return p;
}

async function main() {
  acquire();
  const inhibitor = inhibitSleep();
  process.on('exit', () => inhibitor?.kill());
  heartbeat({ phase: 'recovering' });
  const hb = setInterval(() => heartbeat(), 15_000);
  await recover();
  heartbeat({ phase: 'idle' });
  log(`worker ${process.pid} up at ${commit.slice(0, 12)} (${REPO})`);
  while (!stopping) {
    const red = Q.red();
    if (red) {
      heartbeat({ phase: 'red', wait_reason: red.reason });
      if (process.env.RTT_FACTORY_ONCE) break;
      await sleep(POLL_MS); continue;
    }
    const job = Q.next();
    if (!job) {
      heartbeat({ phase: 'idle', wait_reason: null });
      if (process.env.RTT_FACTORY_ONCE) break;
      await sleep(POLL_MS); continue;
    }
    await runOne(job);
    if (state.phase === 'waiting') await sleep(POLL_MS);
    if (process.env.RTT_FACTORY_ONCE && !Q.next()) break;
  }
  clearInterval(hb);
  heartbeat({ phase: stopping ? 'stopped' : 'idle', job: null });
  process.exit(0);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping${child ? `, signalling job process group ${child.pid}` : ''}`);
    heartbeat({ phase: 'stopping' });
    if (child) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { process.kill(-lastGroup, 'SIGKILL'); } catch { /* gone */ } }, STOP_TIMEOUT_MS).unref();
    } else {
      process.exit(0);
    }
  });
}

main().catch((e) => { log(`worker crashed: ${e.stack ?? e}`); process.exit(1); });
