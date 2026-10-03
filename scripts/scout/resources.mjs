// Read-only A17 snapshot adapter. Missing host interfaces remain null/unknown.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createSampler } from '../lib/telemetry.mjs';

const run = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
};
function processCommands() {
  const list = [];
  for (const entry of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try { list.push({ pid: Number(entry), cmdline: fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ').trim() }); } catch { /* process ended */ }
  }
  return list;
}
export function readHostSnapshot({ factoryDir = process.env.FACTORY_DIR || path.join(os.homedir(), 'rtt-map-factory'), sample = createSampler().sample, commands = processCommands(), runCommand = run } = {}) {
  const telemetry = sample(null);
  const mem = Object.fromEntries((() => { try { return fs.readFileSync('/proc/meminfo', 'utf8').split('\n'); } catch { return []; } })()
    .map((l) => /^([A-Za-z]+):\s+(\d+)/.exec(l)).filter(Boolean).map((m) => [m[1], Number(m[2])]));
  const active = (unit) => runCommand('systemctl', ['--user', 'is-active', unit]) === 'active';
  const factoryService = active('rtt-factory.service');
  const planetiler = commands.some((p) => /planetiler|build-region\.mjs/.test(p.cmdline));
  const runningJobs = path.join(factoryDir, 'queue', 'running');
  const factoryJob = fs.existsSync(runningJobs) && fs.readdirSync(runningJobs).some((f) => f.endsWith('.json'));
  const ollama = active('rtt-ollama.service') || commands.some((p) => /ollama serve/.test(p.cmdline)) ? runCommand('ollama', ['ps']) : null;
  const localAI = Boolean(ollama && ollama.split('\n').filter((line) => line.trim()).length > 1);
  const leaseFile = path.join(factoryDir, 'state', 'heavy-work.json');
  let lease = null; try { lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8')); } catch { /* no shared lease */ }
  let disk = null;
  try { const s = fs.statfsSync(factoryDir); disk = { free_bytes: s.bavail * s.bsize, total_bytes: s.blocks * s.bsize }; } catch { /* not mounted */ }
  return { ...telemetry,
    mem_available_mb: mem.MemAvailable == null ? null : Math.round(mem.MemAvailable / 1024),
    factory_state: planetiler || factoryJob ? 'building' : factoryService ? 'active' : 'idle',
    planetiler_active: planetiler, local_ai_active: localAI,
    other_heavy_lease: lease && lease.boot_id === (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } })()
      ? { owner: lease.owner, pid: lease.pid } : null,
    disk, scratch_bytes: telemetry.scratch_bytes ?? null,
    other_heavy_processes: commands.filter((p) => /ollama|java.*planetiler|check-repro|geometry-match/i.test(p.cmdline)).map(({ pid, cmdline }) => ({ pid, cmdline: cmdline.slice(0, 240) })) };
}
