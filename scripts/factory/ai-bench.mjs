#!/usr/bin/env node
// Benchmark candidate local models for the AI helper on the GTX 1650.
//   node scripts/factory/ai-bench.mjs [--label idle|load] model [model ...]
// For each model it cold-loads, runs every case in tests/fixtures/ai-eval.json
// (temperature 0, fixed seed, JSON schema), and samples every 500 ms:
//   - nvidia-smi: VRAM used, GPU utilisation, GPU temperature
//   - CPU temperature (k10temp)
//   - rtt-ollama.service cgroup memory (system RAM used by the runtime + model)
//   - system MemAvailable and swap
// It reports accuracy, tokens/s, the Ollama GPU placement, and peaks. Results
// are appended to $FACTORY_DIR/ai/bench/<label>.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FACTORY, REPO } from '../lib/common.mjs';
import { createSampler } from '../lib/telemetry.mjs';
import { SCHEMA, gpuState, prompt, unload } from './ai.mjs';

const argv = process.argv.slice(2);
const li = argv.indexOf('--label');
const label = li >= 0 ? argv.splice(li, 2)[1] : 'idle';
const models = argv;
const cases = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/ai-eval.json'), 'utf8')).cases;
const HOST = 'http://127.0.0.1:11434';
const post = async (p, b) => (await fetch(HOST + p, { method: 'POST', body: JSON.stringify(b) })).json();

const cgroupMem = () => {
  const r = spawnSync('systemctl', ['--user', 'show', 'rtt-ollama.service', '-p', 'MemoryCurrent', '--value'], { encoding: 'utf8' });
  const v = Number(r.stdout.trim());
  return Number.isFinite(v) ? Math.round(v / 2 ** 20) : null;
};
const { sample } = createSampler();

const outDir = path.join(FACTORY, 'ai', 'bench');
fs.mkdirSync(outDir, { recursive: true });

for (const model of models) {
  for (const m of models) await unload(m);
  await new Promise((r) => setTimeout(r, 2000));
  const base = gpuState();
  const peaks = { vram_used_mb: 0, gpu_util_pct: 0, gpu_temp_c: 0, cpu_temp_c: 0, svc_mem_mb: 0, swap_used_mb: 0 };
  let minAvail = Infinity;
  const timer = setInterval(() => {
    const g = gpuState();
    const s = sample(null);
    if (g?.used_mb !== undefined) {
      peaks.vram_used_mb = Math.max(peaks.vram_used_mb, g.used_mb);
      peaks.gpu_util_pct = Math.max(peaks.gpu_util_pct, g.util_pct);
      peaks.gpu_temp_c = Math.max(peaks.gpu_temp_c, g.temp_c);
    }
    peaks.cpu_temp_c = Math.max(peaks.cpu_temp_c, s.cpu_temp_c ?? 0);
    peaks.svc_mem_mb = Math.max(peaks.svc_mem_mb, cgroupMem() ?? 0);
    peaks.swap_used_mb = Math.max(peaks.swap_used_mb, s.swap_used_mb ?? 0);
    const avail = Math.round(Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1024);
    minAvail = Math.min(minAvail, avail);
  }, 500);

  const results = [];
  let tokens = 0;
  let evalNs = 0;
  let loadMs = 0;
  let placementInfo = null;
  for (const c of cases) {
    const t0 = Date.now();
    const res = await post('/api/generate', {
      model, prompt: prompt({ job: 'bench', ...c }), format: SCHEMA, stream: false, think: false,
      options: { temperature: 0, seed: 42, num_ctx: 4096 },
    });
    if (!placementInfo) {
      const ps = await (await fetch(`${HOST}/api/ps`)).json();
      const p = ps.models.find((x) => x.name === model);
      placementInfo = p && { size_mb: Math.round(p.size / 2 ** 20), vram_mb: Math.round(p.size_vram / 2 ** 20), gpu_pct: Math.round((p.size_vram / p.size) * 100) };
      loadMs = Math.round((res.load_duration ?? 0) / 1e6);
    }
    let got = null;
    try { got = JSON.parse(res.response); } catch { /* counted as wrong */ }
    tokens += res.eval_count ?? 0;
    evalNs += res.eval_duration ?? 0;
    results.push({ id: c.id, expect: c.expect, got: got?.remediation ?? null, ok: got?.remediation === c.expect,
      unknown_case: c.rules_class === 'unknown', ms: Date.now() - t0, summary: got?.summary?.slice(0, 120) });
  }
  clearInterval(timer);
  const correct = results.filter((r) => r.ok).length;
  const unk = results.filter((r) => r.unknown_case);
  const row = {
    label, model, at: new Date().toISOString(),
    accuracy: `${correct}/${results.length}`,
    unknown_cases: `${unk.filter((r) => r.ok).length}/${unk.length}`,
    unsafe: results.filter((r) => r.expect === 'hold' && r.got !== 'hold').map((r) => `${r.id}->${r.got}`),
    tokens_per_s: Math.round((tokens / (evalNs / 1e9)) * 10) / 10,
    mean_case_ms: Math.round(results.reduce((n, r) => n + r.ms, 0) / results.length),
    load_ms: loadMs,
    placement: placementInfo,
    vram_baseline_mb: base?.used_mb ?? null,
    peaks,
    min_mem_available_mb: minAvail,
    misses: results.filter((r) => !r.ok).map((r) => `${r.id}: want ${r.expect}, got ${r.got}`),
  };
  fs.appendFileSync(path.join(outDir, `${label}.jsonl`), JSON.stringify({ ...row, results }) + '\n');
  console.log(JSON.stringify(row));
}
for (const m of models) await unload(m);
