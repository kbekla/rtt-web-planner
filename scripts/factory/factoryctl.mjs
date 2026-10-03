#!/usr/bin/env node
// Control and dashboard for the unattended factory.
//
//   factoryctl status [--json]            dashboard: worker, current job/stage, queue,
//                                         disk, thermals, AI mode, last failure
//   factoryctl enqueue <type> <region> [--threads N] [--priority P] [--note TEXT]
//                                         type: build | verify | repro | refresh
//   factoryctl list [state]               jobs by state (pending running held done cancelled)
//   factoryctl show <job>                 one job as JSON
//   factoryctl approve <job>              AMBER -> run: mark approved, back to pending
//   factoryctl retry <job>                held -> pending with a fresh retry budget
//   factoryctl cancel <job>               pending/held -> cancelled
//   factoryctl clear-red                  clear a RED stop after fixing its cause
//   factoryctl schedule                   enqueue scheduled verify/repro jobs (timer)
//   factoryctl deploy [commit]            point the runner checkout at a commit, test it,
//                                         restart the worker
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FACTORY, REPO } from '../lib/common.mjs';
import { createSampler } from '../lib/telemetry.mjs';
import { collect } from '../mapwatch.mjs';
import { readiness } from './ai.mjs';
import { diskCheck } from './guards.mjs';
import * as Q from './queue.mjs';

const [cmd = 'status', ...args] = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const RUNNER = path.join(FACTORY, 'runner', 'repo');
const die = (msg) => { console.error(msg); process.exit(1); };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function need(id) {
  const f = Q.find(id) ?? Q.STATES.flatMap((s) => Q.list(s).map((job) => ({ state: s, job }))).find((x) => x.job.id.startsWith(id));
  if (!f) die(`no job ${id}`);
  return f;
}

const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};
const gb = (b) => `${(b / 1e9).toFixed(1)} GB`;
const deg = (v) => (v === null || v === undefined ? '-' : `${Number(v).toFixed(0)}°C`);

function systemd(unit) {
  const r = spawnSync('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'NRestarts', '--value'], { encoding: 'utf8' });
  const [active, sub, restarts] = r.stdout.trim().split('\n');
  return { active, sub, restarts: Number(restarts) || 0 };
}

async function dashboard() {
  const policy = Q.loadPolicy();
  const worker = readJson(path.join(Q.STATE_DIR, 'worker.json'));
  const alive = worker?.pid ? (() => { try { process.kill(worker.pid, 0); return true; } catch { return false; } })() : false;
  const running = Q.list('running')[0] ?? null;
  const pending = Q.list('pending');
  const held = Q.list('held');
  const done = Q.list('done');
  const mw = collect();
  const host = createSampler().sample(null);
  const st = fs.statfsSync(FACTORY);
  const nextJob = Q.next();
  const aiOff = { mode: 'rules-only', reason: 'disabled in config/factory.yaml' };
  const aiBusy = policy.ai?.enabled ? await readiness(policy.ai, { busy: true }).catch((e) => ({ mode: 'rules-only', reason: e.message })) : aiOff;
  const aiIdle = policy.ai?.enabled ? await readiness(policy.ai, { busy: false }).catch((e) => ({ mode: 'rules-only', reason: e.message })) : aiOff;
  const linger = spawnSync('loginctl', ['show-user', process.env.USER ?? '', '-p', 'Linger', '--value'], { encoding: 'utf8' }).stdout.trim();

  let current = null;
  if (running) {
    const pipe = readJson(path.join(Q.STATE_DIR, `pipeline-${running.region}.json`));
    const region = mw.regions.find((r) => r.region === running.region);
    const build = region?.builds.find((b) => b.state === 'running');
    const attempt = running.attempts.at(-1);
    current = {
      job: running.id, type: running.type, region: running.region, attempt: attempt?.n,
      step: pipe?.state === 'running' ? pipe.step : null,
      planetiler_stage: build?.planetiler?.stage ?? null,
      elapsed_s: attempt ? Math.round((Date.now() - Date.parse(attempt.started_at)) / 1000) : null,
    };
  }
  const failures = [
    ...[...done, ...held, ...pending, ...(running ? [running] : [])].flatMap((j) => j.attempts.filter((a) => a.decision)
      .map((a) => ({ at: a.ended_at, job: j.id, class: a.decision.class, remediation: a.decision.remediation, level: a.decision.level, why: a.decision.why, ai: a.ai?.suggestion?.summary ?? null }))),
  ].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));

  return {
    generated_at: new Date().toISOString(),
    worker: { ...systemd('rtt-factory.service'), pid: worker?.pid ?? null, alive, phase: worker?.phase ?? null,
      wait_reason: worker?.wait_reason ?? null, commit: worker?.commit ?? null,
      heartbeat_age_s: worker?.heartbeat_at ? Math.round((Date.now() - Date.parse(worker.heartbeat_at)) / 1000) : null,
      linger: linger === 'yes' },
    red: Q.red(),
    current,
    queue: { pending: pending.map((j) => ({ id: j.id, type: j.type, region: j.region, not_before: j.not_before })),
      held: held.map((j) => ({ id: j.id, type: j.type, region: j.region, level: j.held?.level, reason: j.held?.reason })),
      done: done.length },
    disk: { free_bytes: st.bavail * st.bsize, size_bytes: st.blocks * st.bsize,
      next_job: nextJob ? { id: nextJob.id, ...diskCheck(nextJob, policy) } : null },
    thermals: { cpu_c: host.cpu_temp_c, nvme_c: host.nvme_temp_c, igpu_c: host.igpu?.temp_c ?? null,
      dgpu_c: host.dgpu?.temp_c ?? null, dgpu: host.dgpu?.runtime_pm ?? null,
      mem_used_mb: host.mem_used_mb, swap_used_mb: host.swap_used_mb, load1: host.load1 },
    ai: { model: policy.ai?.model, busy: { mode: aiBusy.mode, reason: aiBusy.reason }, idle: { mode: aiIdle.mode, reason: aiIdle.reason },
      // What the AI would use right now, given whether a job is running.
      now: running ? aiBusy.mode : aiIdle.mode },
    last_failure: failures[0] ?? null,
    preserved_failures: mw.failures.length,
    promoted: Object.fromEntries(mw.regions.map((r) => [r.region, r.current])),
  };
}

function render(d) {
  const w = d.worker;
  const L = [];
  const status = d.red ? 'RED' : d.queue.held.length ? 'AMBER' : 'GREEN';
  L.push(`RT&T map factory  ${d.generated_at.replace('T', ' ').slice(0, 19)}Z   status: ${status}`);
  L.push(`worker   ${w.active}/${w.sub} pid ${w.pid ?? '-'} ${w.alive ? '' : '(not running) '}phase ${w.phase ?? '-'}`
    + `${w.wait_reason ? ` (${w.wait_reason})` : ''}  heartbeat ${w.heartbeat_age_s ?? '-'}s ago  restarts ${w.restarts}`
    + `  commit ${w.commit?.slice(0, 10) ?? '-'}  linger ${w.linger ? 'on' : 'OFF'}`);
  if (d.red) L.push(`RED      ${d.red.reason}  (since ${d.red.at}; fix, then: factoryctl clear-red)`);
  if (d.current) {
    const c = d.current;
    L.push(`current  ${c.region} ${c.type}  step ${c.step ?? '-'}${c.planetiler_stage ? ` / planetiler ${c.planetiler_stage}` : ''}`
      + `  elapsed ${fmtDur(c.elapsed_s * 1000)}  attempt ${c.attempt}  (${c.job})`);
  } else {
    L.push('current  none');
  }
  L.push(`queue    ${d.queue.pending.length} pending, ${d.queue.held.length} held, ${d.queue.done} done`);
  for (const j of d.queue.pending.slice(0, 8)) L.push(`         - ${j.type} ${j.region}${j.not_before ? ` (after ${j.not_before.slice(11, 16)}Z)` : ''}  ${j.id}`);
  for (const j of d.queue.held) L.push(`  HELD   - ${j.type} ${j.region} [${j.level}] ${j.reason}  ${j.id}`);
  const nd = d.disk.next_job;
  L.push(`disk     ${gb(d.disk.free_bytes)} free of ${gb(d.disk.size_bytes)}${nd ? `; next job ${nd.ok ? 'fits' : 'BLOCKED'}: ${nd.reason}` : ''}`);
  const t = d.thermals;
  L.push(`thermals CPU ${deg(t.cpu_c)}  NVMe ${deg(t.nvme_c)}  iGPU ${deg(t.igpu_c)}  dGPU ${t.dgpu_c === null ? (t.dgpu ?? '-') : deg(t.dgpu_c)}`
    + `  RAM ${(t.mem_used_mb / 1024).toFixed(1)} GB  swap ${(t.swap_used_mb / 1024).toFixed(1)} GB  load ${t.load1}`);
  L.push(`ai       ${d.ai.model}: during builds ${d.ai.busy.mode} (${d.ai.busy.reason}); when idle ${d.ai.idle.mode} (${d.ai.idle.reason})`);
  const f = d.last_failure;
  L.push(`last failure  ${f ? `${f.at?.replace('T', ' ').slice(0, 16)}Z ${f.class} -> ${f.remediation} [${f.level}] ${f.job}` : 'none'}`);
  if (f?.ai) L.push(`              AI: ${f.ai}`);
  L.push(`promoted ${Object.entries(d.promoted).map(([r, id]) => `${r}=${id?.slice(0, 8) ?? '-'}`).join('  ')}   preserved failure records: ${d.preserved_failures}`);
  return L.join('\n') + '\n';
}

function schedule() {
  const policy = Q.loadPolicy();
  const s = policy.schedule ?? {};
  const sunday = new Date().getDay() === 0;
  const made = [];
  for (const [region, r] of Object.entries(policy.regions ?? {})) {
    if (!r.enabled) continue;
    const want = [];
    if (s.verify === 'daily') want.push('verify');
    if (s.repro === 'weekly' && sunday) want.push('repro');
    if (s.repro === 'daily') want.push('repro');
    for (const type of want) {
      if (Q.active(type, region).length) continue;
      made.push(Q.enqueue({ type, region, by: 'schedule', priority: type === 'verify' ? 60 : 70 }).id);
    }
  }
  if (policy.trails?.enabled && s.trails === 'weekly' && sunday && !Q.active('trails', Q.TRAILS).length) {
    made.push(Q.enqueue({ type: 'trails', region: Q.TRAILS, by: 'schedule', priority: 65 }).id);
  }
  console.log(made.length ? `scheduled: ${made.join(', ')}` : 'scheduled: nothing new');
}

function deploy(ref = 'HEAD') {
  const sh = (c, a, o = {}) => {
    const r = spawnSync(c, a, { encoding: 'utf8', stdio: 'inherit', ...o });
    if (r.status !== 0) die(`deploy: ${c} ${a.join(' ')} failed`);
  };
  const sha = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  if (!sha) die(`deploy: unknown commit ${ref}`);
  const dirty = fs.existsSync(RUNNER)
    ? spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: RUNNER, encoding: 'utf8' }).stdout.trim() : '';
  if (dirty) die(`deploy: runner has local changes; inspect ${RUNNER} first:\n${dirty}`);
  if (!fs.existsSync(path.join(RUNNER, '.git'))) {
    fs.mkdirSync(path.dirname(RUNNER), { recursive: true });
    sh('git', ['worktree', 'add', '--detach', RUNNER, sha], { cwd: REPO });
  } else {
    sh('git', ['checkout', '--detach', sha], { cwd: RUNNER });
  }
  sh('npm', ['ci', '--offline', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: RUNNER });
  sh('node', ['--test', 'tests/repo/build-id.test.mjs', 'tests/repo/factory.test.mjs', 'tests/repo/hygiene.test.mjs'], { cwd: RUNNER });
  Q.ensureDirs();
  Q.writeJsonAtomic(path.join(Q.STATE_DIR, 'runner.json'), { commit: sha, deployed_at: new Date().toISOString(), path: RUNNER });
  sh('scripts/install-units', [], { cwd: RUNNER });
  const active = systemd('rtt-factory.service').active === 'active';
  if (active) sh('systemctl', ['--user', 'restart', 'rtt-factory.service']);
  console.log(`deployed ${sha.slice(0, 12)} to ${RUNNER}${active ? ' and restarted the worker' : ' (start: systemctl --user start rtt-factory.service)'}`);
}

switch (cmd) {
  case 'status': {
    const d = await dashboard();
    process.stdout.write(args.includes('--json') ? JSON.stringify(d, null, 2) + '\n' : render(d));
    break;
  }
  case 'enqueue': {
    const [type, region] = args;
    if (!type || !region) die('usage: factoryctl enqueue <build|verify|repro|refresh> <region> [--threads N] [--priority P] [--note TEXT]');
    const options = {};
    if (opt('--threads')) options.threads = Number(opt('--threads'));
    const job = Q.enqueue({ type, region, options, priority: Number(opt('--priority') ?? 50), note: opt('--note') ?? null });
    console.log(job.id);
    break;
  }
  case 'list':
    for (const s of args[0] ? [args[0]] : Q.STATES) {
      for (const j of Q.list(s)) console.log(`${s.padEnd(9)} ${j.id}  ${j.type} ${j.region}  attempts ${j.attempts.length}${j.held ? `  [${j.held.level}] ${j.held.reason}` : ''}`);
    }
    break;
  case 'show': console.log(JSON.stringify(need(args[0]).job, null, 2)); break;
  case 'approve': case 'retry': {
    const { state, job } = need(args[0]);
    if (state !== 'held' && !(cmd === 'approve' && state === 'pending')) die(`${job.id} is ${state}, not held`);
    if (cmd === 'approve') job.approved = true;
    if (cmd === 'retry') job.remediations = {};
    job.not_before = null;
    delete job.held;
    Q.event(job, `${cmd} by ${process.env.USER ?? 'user'}`);
    Q.move(job, state, 'pending');
    console.log(`${job.id}: pending`);
    break;
  }
  case 'cancel': {
    const { state, job } = need(args[0]);
    if (state === 'running') die('job is running; stop the worker first (systemctl --user stop rtt-factory)');
    Q.event(job, `cancelled by ${process.env.USER ?? 'user'}`);
    Q.move(job, state, 'cancelled');
    console.log(`${job.id}: cancelled`);
    break;
  }
  case 'clear-red': Q.clearRed(); console.log('RED cleared'); break;
  case 'schedule': schedule(); break;
  case 'deploy': deploy(args[0]); break;
  default: die('usage: factoryctl status|enqueue|list|show|approve|retry|cancel|clear-red|schedule|deploy');
}
