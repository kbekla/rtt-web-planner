// Read-only A17 snapshot adapter. Missing host interfaces remain null/unknown.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createSampler } from '../lib/telemetry.mjs';
import { resourceAdmissionStateFile } from '../lib/resource-admission.mjs';

const run = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
};
function processCommands() {
  const list = [];
  const exclude = new Set([process.pid]);
  let ancestor = process.ppid;
  while (ancestor > 1 && !exclude.has(ancestor)) {
    exclude.add(ancestor);
    try {
      const stat = fs.readFileSync(`/proc/${ancestor}/stat`, 'utf8');
      ancestor = Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[1]);
    }
    catch { break; }
  }
  for (const entry of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    const pid = Number(entry);
    if (exclude.has(pid)) continue;
    try { list.push({ pid, cmdline: fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ').trim() }); } catch { /* process ended */ }
  }
  return list;
}
export function readHostSnapshot(options = {}) {
  const sampler = options.sampler ?? (options.sample ? null : createSampler());
  const factoryDir = options.factoryDir ?? process.env.FACTORY_DIR ?? path.join(os.homedir(), 'rtt-map-factory');
  const sample = options.sample ?? sampler?.sample ?? (() => ({}));
  const commands = options.commands ?? processCommands();
  const runCommand = options.runCommand ?? run;
  const telemetry = sample(null);
  const mem = Object.fromEntries((() => { try { return fs.readFileSync('/proc/meminfo', 'utf8').split('\n'); } catch { return []; } })()
    .map((l) => /^([A-Za-z]+):\s+(\d+)/.exec(l)).filter(Boolean).map((m) => [m[1], Number(m[2])]));
  const active = (unit) => runCommand('systemctl', ['--user', 'is-active', unit]) === 'active';
  const factoryService = active('rtt-factory.service');
  const planetiler = commands.some((p) => /planetiler|build-region\.mjs/.test(p.cmdline));
  const runningJobs = path.join(factoryDir, 'queue', 'running');
  const factoryJob = fs.existsSync(runningJobs) && fs.readdirSync(runningJobs).some((f) => f.endsWith('.json'));
  const ollamaService = active('rtt-ollama.service') || commands.some((p) => /ollama\s+serve/.test(p.cmdline));
  const ollama = ollamaService ? (runCommand('ollama', ['ps'])
    ?? runCommand('curl', ['--fail', '--silent', '--show-error', '--max-time', '2', 'http://127.0.0.1:11434/api/ps'])) : null;
  let ollamaHasLoadedModel = null;
  if (ollama !== null) {
    try {
      const parsed = JSON.parse(ollama);
      if (Array.isArray(parsed.models)) ollamaHasLoadedModel = parsed.models.length > 0;
    } catch {
      const lines = ollama.split('\n').filter((line) => line.trim());
      if (lines.length) ollamaHasLoadedModel = lines.length > 1;
    }
  }
  const localAIProcess = commands.some((p) => /ollama\s+runner|llama[-_]server|vllm|llm-worker/i.test(p.cmdline));
  const localAI = localAIProcess || (ollamaService && (ollamaHasLoadedModel === null || ollamaHasLoadedModel));
  const otherHeavy = commands.filter((p) => /java.*planetiler|check-repro|geometry-match/i.test(p.cmdline))
    .map(({ pid, cmdline }) => ({ pid, kind: /planetiler/i.test(cmdline) ? 'planetiler' : /check-repro/i.test(cmdline) ? 'repro-check' : 'geometry-match' }));
  const otherHeavyActive = otherHeavy.length > 0;
  const leaseFile = path.join(factoryDir, 'state', 'heavy-work.json');
  let lease = null; const leaseExists = fs.existsSync(leaseFile);
  try { lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8')); } catch { /* unreadable existing leases fail closed below */ }
  const bootId = (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } })();
  const validCurrentBootLease = lease && lease.boot_id === bootId;
  const admissionFile = resourceAdmissionStateFile(factoryDir);
  const admissionExists = fs.existsSync(admissionFile);
  let admissionState = null; let admissionUnreadable = false;
  try { admissionState = JSON.parse(fs.readFileSync(admissionFile, 'utf8')); }
  catch { admissionUnreadable = admissionExists; }
  const admissionMalformed = admissionExists && !admissionUnreadable &&
    (admissionState?.schema !== 1 || !('lease' in admissionState) || !('factory_intent' in admissionState));
  const admissionLease = admissionState?.schema === 1 ? admissionState.lease : null;
  const admissionCurrentBoot = admissionLease?.boot_id === bootId;
  const workerFile = path.join(factoryDir, 'state', 'worker.json');
  let factoryWorker = null; try { factoryWorker = JSON.parse(fs.readFileSync(workerFile, 'utf8')); } catch { /* worker state unavailable */ }
  let disk = null;
  try { const s = fs.statfsSync(factoryDir); disk = { free_bytes: s.bavail * s.bsize, total_bytes: s.blocks * s.bsize }; } catch { /* not mounted */ }
  const detectedOtherWorkloads = [...otherHeavy, ...commands.filter((p) => /ollama|llama[-_]server|vllm|llm-worker/i.test(p.cmdline))
    .map(({ pid, cmdline }) => ({ pid, kind: /ollama/i.test(cmdline) ? 'local-ai' : 'local-ai-worker' }))];
  const heartbeatAge = factoryWorker?.heartbeat_at ? (Date.now() - Date.parse(factoryWorker.heartbeat_at)) / 1000 : Infinity;
  const factoryProtocolLive = factoryService && factoryWorker?.coordination_protocol === 'rtt-heavy-admission-v1'
    && heartbeatAge >= 0 && heartbeatAge <= 60;
  const coordinationVerified = factoryProtocolLive && !admissionUnreadable && !admissionMalformed;
  const activeAdmissionLease = admissionCurrentBoot ? admissionLease : null;
  const factoryIntent = admissionState?.factory_intent ?? null;
  const factoryCoordination = { verified: coordinationVerified,
    status: admissionUnreadable || admissionMalformed ? 'RED' : coordinationVerified ? 'VERIFIED' : 'UNVERIFIED',
    reason: admissionUnreadable || admissionMalformed ? 'shared admission state invalid; fail closed'
      : coordinationVerified ? null : 'factory worker has not reported a fresh shared-admission heartbeat',
    factory_intent: factoryIntent?.owner ?? null,
    factory_pending: Boolean(factoryIntent && !(activeAdmissionLease?.priority === 'factory'
      && activeAdmissionLease.owner === factoryIntent.owner && activeAdmissionLease.nonce === factoryIntent.nonce)),
    yield_requested: Boolean(factoryIntent && activeAdmissionLease?.priority === 'background'),
    pending_since: factoryIntent?.acquired_at ?? null,
    lease_owner: activeAdmissionLease?.owner ?? null,
    lease_workload: activeAdmissionLease?.detail ?? activeAdmissionLease?.workload?.name ?? null,
    lease_acquired_at: activeAdmissionLease?.acquired_at ?? null,
    lease_priority: activeAdmissionLease?.priority ?? null,
    lease_phase: activeAdmissionLease?.phase ?? null,
    blocked_reason: admissionUnreadable || admissionMalformed ? 'shared admission state invalid; fail closed'
      : coordinationVerified ? null : 'BLOCKED_FACTORY_COORDINATION_UNVERIFIED' };
  const heavyWorkBlockedReason = factoryCoordination.status === 'RED' ? factoryCoordination.reason
    : factoryCoordination.verified ? null : 'BLOCKED_FACTORY_COORDINATION_UNVERIFIED';
  return { ...telemetry,
    sensor_sources: options.sensor_sources ?? sampler?.sensors ?? null,
    host_capacity: options.host_capacity ?? sampler?.host ?? null,
    mem_available_mb: mem.MemAvailable == null ? null : Math.round(mem.MemAvailable / 1024),
    mem_total_mb: mem.MemTotal == null ? null : Math.round(mem.MemTotal / 1024),
    swap_total_mb: mem.SwapTotal == null ? null : Math.round(mem.SwapTotal / 1024),
    swap_free_mb: mem.SwapFree == null ? null : Math.round(mem.SwapFree / 1024),
    factory_state: planetiler || factoryJob ? 'building' : factoryService ? 'active' : 'idle',
    factory_service_active: factoryService, factory_job_active: factoryJob,
    factory_worker: factoryWorker ? { pid: factoryWorker.pid ?? null, phase: factoryWorker.phase ?? null, job: factoryWorker.job ?? null,
      heartbeat_at: factoryWorker.heartbeat_at ?? null } : null,
    planetiler_active: planetiler, local_ai_active: localAI, other_heavy_workload_active: otherHeavyActive, ollama_service_active: ollamaService,
    factory_coordination: factoryCoordination, factory_coordination_verified: coordinationVerified,
    heavy_work_blocked_reason: heavyWorkBlockedReason,
    resource_lease_owner: factoryCoordination.lease_owner,
    other_heavy_lease: validCurrentBootLease ? { owner: lease.owner, pid: lease.pid }
      : leaseExists && !lease ? { owner: 'unknown', status: 'unreadable' } : null,
    disk, scratch_bytes: telemetry.scratch_bytes ?? null,
    other_heavy_processes: detectedOtherWorkloads };
}
