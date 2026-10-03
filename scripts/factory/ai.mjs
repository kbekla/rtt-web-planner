// Optional local AI helper (Ollama on 127.0.0.1). Advisory only.
//
// The model may summarise a failure and suggest one remediation from
// rules.AI_SELECTABLE. It cannot run commands, edit files or override the rules:
// the worker passes its suggestion through rules.decide(), which ignores it
// unless the rules classify the failure as `unknown`.
//
// Hybrid placement (config/factory.yaml ai.modes):
//   busy (a job is running): GPU only. The model must fit entirely in the GTX
//     1650's VRAM, with system RAM and swap within limits, and Ollama must place
//     100 % of it on the GPU. Otherwise the model is unloaded and the worker
//     carries on rules-only. It never takes CPU or RAM from Planetiler.
//   idle (no job running, e.g. diagnosing a failed job): the whole machine.
//     Modes are tried in the configured order (default cpu, then gpu; on this A17
//     the CPU is about 2x faster than the power-capped GPU). CPU mode requires
//     plenty of free RAM and a quiet system. It raises the rtt-ollama memory cap
//     only for the call, then always unloads the model and restores the cap.
// Callers that don't say they are idle get the busy (GPU-only) behaviour.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { AI_SELECTABLE, CLASSES, UNKNOWN } from './rules.mjs';

const HOST = process.env.RTT_OLLAMA_HOST || 'http://127.0.0.1:11434';

export const DEFAULTS = {
  model: 'qwen2.5-coder:3b',
  num_ctx: 4096,
  modes: { busy: ['gpu'], idle: ['cpu', 'gpu'] },
  // GPU mode. VRAM the model needs beyond its file size (KV cache q8_0 at 4k ctx, CUDA context).
  vram_overhead_mb: 700,
  // Don't load if the system has less than this available (Planetiler uses up to ~10 GB).
  min_mem_available_mb: 2048,
  max_swap_used_mb: 2048,
  // CPU mode (idle only). 6 threads beat 12 on the Ryzen 5 4600H (memory-bound).
  cpu_threads: 6,
  cpu_min_mem_available_mb: 6144,
  cpu_max_load: 4,
  cpu_memory_high: '5G',
  cpu_memory_max: '6G',
  service: 'rtt-ollama.service',
  timeout_ms: 180_000,
};

async function api(path, body, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HOST}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function meminfo() {
  const m = {};
  for (const l of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const x = /^(\w+):\s+(\d+)/.exec(l);
    if (x) m[x[1]] = Number(x[2]) / 1024;
  }
  return { available_mb: Math.round(m.MemAvailable), swap_used_mb: Math.round(m.SwapTotal - m.SwapFree) };
}

/** NVIDIA GPU state via nvidia-smi, or null when the card is absent or asleep. */
export function gpuState() {
  const pm = (() => { try { return fs.readFileSync('/sys/bus/pci/devices/0000:01:00.0/power/runtime_status', 'utf8').trim(); } catch { return null; } })();
  if (pm && pm !== 'active') return { runtime_pm: pm };
  const r = spawnSync('nvidia-smi', ['--query-gpu=memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu',
    '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0) return null;
  const [total, used, free, util, temp] = r.stdout.trim().split(',').map((s) => Number(s.trim()));
  return { runtime_pm: pm ?? 'active', total_mb: total, used_mb: used, free_mb: free, util_pct: util, temp_c: temp };
}

/** Is `model` loaded, and is it 100 % in VRAM? */
async function placement(model) {
  const ps = await api('/api/ps');
  const m = (ps.models ?? []).find((x) => x.name === model || x.model === model);
  if (!m) return { loaded: false };
  return { loaded: true, size: m.size, size_vram: m.size_vram, gpu_fraction: m.size ? m.size_vram / m.size : 0 };
}

export async function unload(model) {
  try { await api('/api/generate', { model, keep_alive: 0 }, 10_000); } catch { /* already gone */ }
}

const load1 = () => { try { return Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]); } catch { return 0; } };

/** GPU-only checks. Returns null if OK, else the reason it can't run. */
async function gpuBlocked(c, modelMb, mem) {
  const gpu = gpuState();
  if (!gpu || gpu.free_mb === undefined) return 'NVIDIA GPU unavailable or asleep';
  const p = await placement(c.model);
  const need = modelMb + c.vram_overhead_mb;
  // A model left loaded on the CPU by an earlier idle call doesn't count against VRAM.
  if ((!p.loaded || p.gpu_fraction < 0.001) && gpu.free_mb < need) return `free VRAM ${gpu.free_mb} MB < needed ${need} MB`;
  if (p.loaded && p.gpu_fraction >= 0.001 && p.gpu_fraction < 0.999) {
    await unload(c.model);
    return `model was ${(p.gpu_fraction * 100).toFixed(0)} % in VRAM; unloaded`;
  }
  if (mem.available_mb < c.min_mem_available_mb) return `system RAM available ${mem.available_mb} MB < ${c.min_mem_available_mb} MB`;
  if (mem.swap_used_mb > c.max_swap_used_mb) return `swap in use ${mem.swap_used_mb} MB > ${c.max_swap_used_mb} MB`;
  return null;
}

/** CPU checks (idle only). Returns null if OK, else the reason it can't run. */
function cpuBlocked(c, mem) {
  if (mem.available_mb < c.cpu_min_mem_available_mb) return `system RAM available ${mem.available_mb} MB < ${c.cpu_min_mem_available_mb} MB`;
  if (mem.swap_used_mb > c.max_swap_used_mb) return `swap in use ${mem.swap_used_mb} MB > ${c.max_swap_used_mb} MB`;
  const l = load1();
  if (l > c.cpu_max_load) return `system busy (load ${l} > ${c.cpu_max_load})`;
  return null;
}

/**
 * Where can the helper run right now? `busy` = a job is running (default: true,
 * the safe GPU-only path). Returns { ok, mode: 'gpu'|'cpu'|'rules-only', reason,
 * tried: [{mode, reason}], mem, model_mb }.
 */
export async function readiness(cfg = {}, { busy = true } = {}) {
  const c = { ...DEFAULTS, ...cfg, modes: { ...DEFAULTS.modes, ...(cfg.modes ?? {}) } };
  const out = { ok: false, mode: 'rules-only', model: c.model, busy, tried: [] };
  try {
    await api('/api/version', null, 1500);
  } catch {
    return { ...out, reason: 'ollama service not reachable' };
  }
  let tags;
  try { tags = await api('/api/tags'); } catch (e) { return { ...out, reason: String(e.message) }; }
  const info = (tags.models ?? []).find((m) => m.name === c.model);
  if (!info) return { ...out, reason: `model ${c.model} not installed` };
  out.model_mb = Math.round(info.size / 2 ** 20);
  out.mem = meminfo();
  for (const mode of busy ? c.modes.busy : c.modes.idle) {
    if (mode === 'cpu' && busy) continue; // never on the CPU while a job runs
    const blocked = mode === 'gpu' ? await gpuBlocked(c, out.model_mb, out.mem)
      : mode === 'cpu' ? cpuBlocked(c, out.mem) : `unknown mode '${mode}'`;
    out.tried.push({ mode, reason: blocked ?? 'ok' });
    if (!blocked) return { ...out, ok: true, mode, reason: mode === 'gpu' ? 'fits in VRAM' : `CPU, ${c.cpu_threads} threads (factory idle)` };
  }
  return { ...out, reason: out.tried.map((t) => `${t.mode}: ${t.reason}`).join('; ') || 'no mode allowed' };
}

/** Read the service's current memory limits, so they can be restored exactly. */
function serviceLimits(service) {
  const r = spawnSync('systemctl', ['--user', 'show', service, '-p', 'MemoryHigh', '-p', 'MemoryMax'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=')));
}
function setServiceLimits(service, high, max) {
  return spawnSync('systemctl', ['--user', 'set-property', '--runtime', service, `MemoryHigh=${high}`, `MemoryMax=${max}`],
    { encoding: 'utf8' }).status === 0;
}

const CLASS_IDS = [...CLASSES.map((c) => c.id), UNKNOWN.id];

export const SCHEMA = {
  type: 'object',
  properties: {
    class: { type: 'string', enum: CLASS_IDS },
    remediation: { type: 'string', enum: AI_SELECTABLE },
    summary: { type: 'string', maxLength: 400 },
  },
  required: ['class', 'remediation', 'summary'],
};

export function prompt(failure) {
  const classes = CLASSES.map((c) => `- ${c.id}: ${c.why}`).join('\n');
  return `You diagnose failures of an unattended map-tile build pipeline (OpenStreetMap -> Planetiler -> PMTiles -> browser tests).
You can only recommend; you cannot run commands or change files.

Failure classes:
${classes}
- unknown: none of the above.

Remediations you may choose (pick exactly one):
- resume: the job was interrupted (signal, restart, reboot); re-run it.
- retry-after-backoff: transient network/download problem; wait and retry unchanged.
- retry-reduced-threads: out of memory; retry with fewer threads.
- retry-render-tests: the browser test harness timed out or crashed (not a screenshot difference).
- hold: anything else, including test assertion failures, screenshot differences, corrupted or unsupported input, I/O errors, or when unsure. Holding is always safe.

How to decide:
1. A checksum mismatch, a failed test assertion, a screenshot difference, a full disk, a disk I/O error, or corrupt/unsupported input data -> hold. Retrying cannot fix these.
2. A host-name lookup, DNS, "unreachable", connection or HTTP 5xx error while downloading, in any language or library (curl, Java, Node) -> retry-after-backoff.
3. The browser, page or context crashed or closed, or the browser test harness timed out -> retry-render-tests.
4. The process was killed by a signal, stopped, or exited without recording a result, with no sign of running out of memory -> resume.
5. Running out of memory (OutOfMemoryError, OOM killer, "Killed" with exit 137 and memory messages) -> retry-reduced-threads.
6. If none of these clearly applies -> hold.

Job: ${failure.job ?? '-'}  Stage: ${failure.stage ?? '-'}  Exit code: ${failure.exit_code ?? '-'}
Error: ${failure.error ?? '-'}
Log tail:
${(failure.log_tail ?? '').split('\n').slice(-40).join('\n')}

Reply with JSON: {"class": ..., "remediation": ..., "summary": "<one or two sentences for the operator>"}`;
}

/**
 * Ask the model. Returns { class, remediation, summary, stats } or null, plus a
 * rules-only reason when it declined.
 */
export async function diagnose(failure, cfg = {}, { busy = true } = {}) {
  const c = { ...DEFAULTS, ...cfg, modes: { ...DEFAULTS.modes, ...(cfg.modes ?? {}) } };
  const ready = await readiness(c, { busy });
  if (!ready.ok) return { suggestion: null, mode: 'rules-only', reason: ready.reason };
  const cpu = ready.mode === 'cpu';
  let res;
  let p = {};
  let limits = null;
  try {
    if (cpu) {
      // Raise the service's RAM cap for this call only; restored in `finally`.
      limits = serviceLimits(c.service);
      if (!limits || !setServiceLimits(c.service, c.cpu_memory_high, c.cpu_memory_max)) {
        return { suggestion: null, mode: 'rules-only', reason: `cannot raise ${c.service} memory limits for CPU mode` };
      }
      await unload(c.model); // reload with CPU placement
    }
    res = await api('/api/generate', {
      model: c.model,
      prompt: prompt(failure),
      format: SCHEMA,
      stream: false,
      think: false,
      keep_alive: cpu ? 0 : undefined,
      options: { temperature: 0, seed: 42, num_ctx: c.num_ctx, ...(cpu ? { num_gpu: 0, num_thread: c.cpu_threads } : {}) },
    }, c.timeout_ms);
    p = await placement(c.model);
  } catch (e) {
    return { suggestion: null, mode: 'rules-only', reason: `generate failed (${ready.mode}): ${e.message}` };
  } finally {
    if (cpu) {
      await unload(c.model);
      if (limits) setServiceLimits(c.service, limits.MemoryHigh, limits.MemoryMax);
    }
  }
  if (!cpu && p.loaded && p.gpu_fraction < 0.999) {
    await unload(c.model);
    return { suggestion: null, mode: 'rules-only', reason: `model spilled to CPU (${(p.gpu_fraction * 100).toFixed(0)} % in VRAM); unloaded` };
  }
  let parsed;
  try { parsed = JSON.parse(res.response); } catch { return { suggestion: null, mode: 'rules-only', reason: 'model returned invalid JSON' }; }
  if (!AI_SELECTABLE.includes(parsed.remediation)) return { suggestion: null, mode: 'rules-only', reason: 'model chose a remediation outside the approved list' };
  return {
    mode: ready.mode,
    suggestion: { class: parsed.class, remediation: parsed.remediation, summary: String(parsed.summary).slice(0, 400) },
    stats: {
      eval_tokens: res.eval_count,
      tokens_per_s: res.eval_duration ? Math.round((res.eval_count / (res.eval_duration / 1e9)) * 10) / 10 : null,
      prompt_tokens: res.prompt_eval_count,
      prompt_tokens_per_s: res.prompt_eval_duration ? Math.round(res.prompt_eval_count / (res.prompt_eval_duration / 1e9)) : null,
      total_ms: Math.round(res.total_duration / 1e6),
      load_ms: Math.round((res.load_duration ?? 0) / 1e6),
      gpu_fraction: cpu ? 0 : (p.gpu_fraction ?? null),
    },
  };
}
