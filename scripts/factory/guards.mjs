// Start gates for the unattended worker: planet refusal, disk guard, thermals, power.
import fs from 'node:fs';
import path from 'node:path';
import { FACTORY, REPO } from '../lib/common.mjs';
import { createSampler } from '../lib/telemetry.mjs';

const GB = 1e9;

/** RED refusal: full-planet builds and anything too large to be a regional extract. */
export function refusal(job, policy, repo = REPO) {
  const r = policy.refuse ?? {};
  if ((r.names ?? []).includes(job.region)) return `REFUSED: region '${job.region}' is a full-planet build`;
  const cfgFile = path.join(repo, 'config', 'regions', `${job.region}.yaml`);
  if (fs.existsSync(cfgFile)) {
    const text = fs.readFileSync(cfgFile, 'utf8');
    const url = /url:\s*(\S+)/.exec(text)?.[1] ?? '';
    for (const pat of r.url_patterns ?? []) {
      if (url.includes(pat)) return `REFUSED: source URL ${url} matches '${pat}' (full-planet)`;
    }
  }
  const lockFile = path.join(repo, 'config', 'regions', `${job.region}.lock.json`);
  if (fs.existsSync(lockFile)) {
    const bytes = JSON.parse(fs.readFileSync(lockFile, 'utf8')).bytes;
    if (r.max_snapshot_bytes && bytes > r.max_snapshot_bytes) {
      return `REFUSED: snapshot is ${(bytes / GB).toFixed(1)} GB, over the ${(r.max_snapshot_bytes / GB).toFixed(0)} GB limit`;
    }
  }
  return null;
}

/** Latest successful manifest for a region, if any. */
function lastManifest(region) {
  const dir = path.join(FACTORY, 'output', region);
  if (!fs.existsSync(dir)) return null;
  const ms = fs.readdirSync(dir).filter((d) => /^[0-9a-f]{16}$/.test(d))
    .map((d) => path.join(dir, d, 'manifest.json')).filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))).sort((a, b) => a.created_at.localeCompare(b.created_at));
  return ms.at(-1) ?? null;
}

/**
 * Bytes a job needs: snapshot (if not on disk) + scratch + output + margin.
 * Returns { ok, free, need, parts, reason }.
 */
export function diskCheck(job, policy, repo = REPO) {
  const d = policy.disk ?? {};
  const st = fs.statfsSync(FACTORY);
  const free = st.bavail * st.bsize;
  const size = st.blocks * st.bsize;
  const margin = Math.max((d.margin_gb ?? 25) * GB, ((d.margin_pct ?? 5) / 100) * size);
  const headroom = d.headroom ?? 1.25;

  const lockFile = path.join(repo, 'config', 'regions', `${job.region}.lock.json`);
  const lock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : null;
  const snapshotBytes = lock?.bytes ?? 0;
  const snapshotOnDisk = lock && fs.existsSync(path.join(FACTORY, 'sources', 'osm', job.region, lock.file));
  const m = lastManifest(job.region);
  const scratch = m?.stats?.peak_scratch_bytes ? m.stats.peak_scratch_bytes * headroom : snapshotBytes * (d.ratio_scratch ?? 5.5);
  const output = m?.output?.bytes ? m.output.bytes * headroom : snapshotBytes * (d.ratio_output ?? 0.85);

  let parts;
  switch (job.type) {
    case 'verify': parts = { tests: 1 * GB }; break;
    case 'repro': parts = { scratch, output }; break;
    case 'refresh': parts = { snapshot: (snapshotBytes || 3 * GB) * headroom, scratch, output }; break;
    default: parts = { snapshot: snapshotOnDisk ? 0 : snapshotBytes, scratch, output };
  }
  if (!lock && job.type !== 'verify') parts.unknown_region_allowance = 10 * GB;
  parts.margin = margin;
  const need = Object.values(parts).reduce((a, b) => a + b, 0);
  const fmt = (b) => `${(b / GB).toFixed(1)} GB`;
  return {
    ok: free >= need, free, need, parts,
    reason: `free ${fmt(free)} ${free >= need ? '>=' : '<'} needed ${fmt(need)} (${Object.entries(parts).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')})`,
  };
}

/** Delete factory scratch dirs that no live process owns. Returns bytes freed. */
export function cleanScratch() {
  const dir = path.join(FACTORY, 'scratch');
  if (!fs.existsSync(dir)) return 0;
  const walk = (q, fn) => {
    try {
      const s = fs.statSync(q);
      fn(s);
      if (s.isDirectory()) for (const f of fs.readdirSync(q)) walk(path.join(q, f), fn);
    } catch { /* vanished */ }
  };
  // Anything last written before this boot can't belong to a live process.
  const bootMs = (() => {
    try { return Number(/^btime (\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]) * 1000; } catch { return 0; }
  })();
  let freed = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let newest = 0;
    let bytes = 0;
    walk(p, (s) => { newest = Math.max(newest, s.mtimeMs); if (s.isFile()) bytes += s.size; });
    // Build scratch dirs end in the owning pid: stale once it is gone, however recent.
    // A reused pid after a reboot is caught by the boot-time check.
    const pid = Number(/-(\d+)$/.exec(name)?.[1]);
    let stale;
    if (newest < bootMs) stale = true;
    else if (pid) { try { process.kill(pid, 0); stale = false; } catch { stale = true; } }
    // Others (e.g. check-repro output) have no pid: stale after 15 minutes without writes.
    else stale = Date.now() - newest >= 15 * 60 * 1000;
    if (!stale) continue;
    fs.rmSync(p, { recursive: true, force: true });
    freed += bytes;
  }
  return freed;
}

const sampler = { s: null };
/** Thermal and power gates. Returns null if OK to start, else the reason to wait. */
export function startWait(policy) {
  sampler.s ??= createSampler();
  const now = sampler.s.sample(null);
  const t = policy.thermal ?? {};
  if (t.cpu_max_start_c && now.cpu_temp_c !== null && now.cpu_temp_c > t.cpu_max_start_c) {
    return `CPU ${now.cpu_temp_c.toFixed(1)}°C > ${t.cpu_max_start_c}°C; cooling down`;
  }
  if (t.nvme_max_start_c && now.nvme_temp_c !== null && now.nvme_temp_c > t.nvme_max_start_c) {
    return `NVMe ${now.nvme_temp_c.toFixed(1)}°C > ${t.nvme_max_start_c}°C; cooling down`;
  }
  if (policy.power?.require_ac) {
    const ac = (() => { try { return fs.readFileSync('/sys/class/power_supply/ACAD/online', 'utf8').trim(); } catch { return null; } })();
    if (ac === '0') return 'on battery; waiting for AC power';
  }
  return null;
}
