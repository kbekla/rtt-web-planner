// Lightweight host telemetry sampled while a build runs.
//
// Each sample reads sysfs/procfs (CPU, iGPU and NVMe temperatures, iGPU load
// and VRAM, RAM, swap and load) plus optional scratch size. NVIDIA is queried
// for temperature, utilization, clocks and throttle reasons only when runtime
// PM is already "active"; power.draw is intentionally excluded. Missing
// sensors read as null.
// The sampler times itself and reports its own cost in the summary.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } };
const num = (v) => (v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function findHwmon(name) {
  const root = '/sys/class/hwmon';
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (read(path.join(root, d, 'name')) === name) return path.join(root, d);
  }
  return null;
}

function findDrmDevice(driver) {
  const root = '/sys/class/drm';
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (!/^card\d+$/.test(d)) continue;
    const dev = path.join(root, d, 'device');
    try {
      if (path.basename(fs.readlinkSync(path.join(dev, 'driver'))) === driver) return fs.realpathSync(dev);
    } catch { /* not a driver-bound device */ }
  }
  return null;
}

// nvidia-smi fields deliberately exclude power.draw: this A17's GTX 1650 has
// a known bogus ~170 W report despite its lower configured power limit.
export function parseNvidiaTelemetry(csv) {
  const fields = String(csv ?? '').trim().split(',').map((s) => s.trim());
  if (fields.length < 5) return null;
  return {
    temp_c: num(fields[0]),
    busy_pct: num(fields[1]),
    vram_used_mb: num(fields[2]),
    core_clock_mhz: num(fields[3]),
    memory_clock_mhz: num(fields[4]),
    throttle_reasons: fields[5] && !/^n\/a$/i.test(fields[5]) ? fields[5] : null,
  };
}

export function nvidiaQueryAllowed(runtimeStatus) { return runtimeStatus === 'active'; }

/** Locate sensors once; returns a sample() function. */
export function createSampler() {
  const cpu = findHwmon('k10temp') ?? findHwmon('coretemp');
  const nvme = findHwmon('nvme');
  const amd = findDrmDevice('amdgpu');
  const amdHwmon = findHwmon('amdgpu');
  const nvidia = findDrmDevice('nvidia');
  const nvidiaRuntime = nvidia ? read(path.join(nvidia, 'power', 'runtime_status')) : null;
  const hasSmi = nvidiaQueryAllowed(nvidiaRuntime) && spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8', timeout: 1500 }).status === 0;
  const milliC = (dir) => (dir ? num(read(path.join(dir, 'temp1_input'))) : null);
  const sensors = {
    cpu_temp: cpu && `${cpu}/temp1_input (${read(`${cpu}/temp1_label`) ?? 'temp1'})`,
    nvme_temp: nvme && `${nvme}/temp1_input`,
    igpu: amd,
    dgpu: nvidia ? { device: nvidia, runtime_pm: nvidiaRuntime, query_available: Boolean(hasSmi) } : null,
  };

  function nvidiaSample() {
    if (!hasSmi) return null;
    const pm = read(path.join(nvidia, 'power', 'runtime_status'));
    if (!nvidiaQueryAllowed(pm)) return { runtime_pm: pm, temp_c: null, busy_pct: null, vram_used_mb: null,
      core_clock_mhz: null, memory_clock_mhz: null, throttle_reasons: null };
    const clockRes = spawnSync('nvidia-smi', ['--query-gpu=temperature.gpu,utilization.gpu,memory.used,clocks.current.sm,clocks.current.memory,clocks_throttle_reasons.active',
      '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2000 });
    return { runtime_pm: pm, ...(clockRes.status === 0 ? parseNvidiaTelemetry(clockRes.stdout) : null) };
  }

  function meminfo() {
    const out = {};
    for (const line of (read('/proc/meminfo') ?? '').split('\n')) {
      const m = /^(\w+):\s+(\d+)/.exec(line);
      if (m) out[m[1]] = Number(m[2]);
    }
    return out;
  }

  function sample(scratchDir) {
    const mem = meminfo();
    const t = milliC(amdHwmon);
    const vramUsed = amd ? num(read(`${amd}/mem_info_vram_used`)) : null;
    let scratch = null;
    if (scratchDir && fs.existsSync(scratchDir)) {
      scratch = Number(spawnSync('du', ['-sb', scratchDir], { encoding: 'utf8' }).stdout.split('\t')[0]) || 0;
    }
    const cpuT = milliC(cpu);
    const nvmeT = milliC(nvme);
    return {
      cpu_temp_c: cpuT === null ? null : cpuT / 1000,
      nvme_temp_c: nvmeT === null ? null : nvmeT / 1000,
      igpu: amd ? {
        temp_c: t === null ? null : t / 1000,
        busy_pct: num(read(`${amd}/gpu_busy_percent`)),
        vram_used_mb: vramUsed === null ? null : Math.round(vramUsed / 2 ** 20),
      } : null,
      dgpu: nvidiaSample(),
      mem_used_mb: mem.MemTotal ? Math.round((mem.MemTotal - mem.MemAvailable) / 1024) : null,
      swap_used_mb: mem.SwapTotal !== undefined ? Math.round((mem.SwapTotal - mem.SwapFree) / 1024) : null,
      load1: num((read('/proc/loadavg') ?? '').split(' ')[0]),
      scratch_bytes: scratch,
    };
  }

  const host = {
    mem_total_mb: Math.round((meminfo().MemTotal ?? 0) / 1024),
    swap_total_mb: Math.round((meminfo().SwapTotal ?? 0) / 1024),
    igpu_vram_total_mb: amd ? Math.round((num(read(`${amd}/mem_info_vram_total`)) ?? 0) / 2 ** 20) : null,
  };
  return { sensors, host, sample };
}

/**
 * Sample every intervalMs until stop(). Samples are appended to `file` as JSON
 * lines (elapsed seconds + readings); stop() returns peaks and sampler cost.
 */
export function startTelemetry({ file, scratchDir, intervalMs = Number(process.env.RTT_TELEMETRY_INTERVAL_MS || 5000) }) {
  const { sensors, host, sample } = createSampler();
  const started = Date.now();
  const fd = file ? fs.openSync(file, 'w') : null;
  const peaks = {};
  const sums = {};
  const counts = {};
  let count = 0;
  let costMs = 0;
  const track = (key, v) => {
    if (v === null || v === undefined) return;
    peaks[key] = Math.max(peaks[key] ?? -Infinity, v);
    sums[key] = (sums[key] ?? 0) + v;
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const tick = () => {
    const t0 = performance.now();
    const s = sample(scratchDir);
    costMs += performance.now() - t0;
    count++;
    const row = { t: Math.round((Date.now() - started) / 100) / 10, ...s };
    if (fd !== null) fs.writeSync(fd, JSON.stringify(row) + '\n');
    track('cpu_temp_c', s.cpu_temp_c);
    track('nvme_temp_c', s.nvme_temp_c);
    track('igpu_temp_c', s.igpu?.temp_c);
    track('igpu_busy_pct', s.igpu?.busy_pct);
    track('igpu_vram_used_mb', s.igpu?.vram_used_mb);
    track('dgpu_temp_c', s.dgpu?.temp_c);
    track('dgpu_busy_pct', s.dgpu?.busy_pct);
    track('dgpu_vram_used_mb', s.dgpu?.vram_used_mb);
    track('mem_used_mb', s.mem_used_mb);
    track('swap_used_mb', s.swap_used_mb);
    track('load1', s.load1);
    track('scratch_bytes', s.scratch_bytes);
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      tick();
      if (fd !== null) fs.closeSync(fd);
      const round = (v) => Math.round(v * 10) / 10;
      return {
        elapsed_s: round((Date.now() - started) / 1000),
        interval_ms: intervalMs,
        samples: count,
        sampler_cost_ms: Math.round(costMs),
        sensors,
        host,
        peak: Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, round(v)])),
        mean: Object.fromEntries(Object.entries(sums).filter(([k]) => /busy|load|temp/.test(k))
          .map(([k, v]) => [k, round(v / counts[k])])),
      };
    },
  };
}
