#!/usr/bin/env node
// mapwatch: deterministic, read-only monitor for the map factory.
//
//   scripts/mapwatch.mjs status [--region R] [--json]      one-shot status
//   scripts/mapwatch.mjs watch  [--region R] [--interval S] [--until-idle]
//                                                         print changes as they happen
//   scripts/mapwatch.mjs report [--region R]              write JSON + Markdown reports
//
// It reads what the pipeline already records:
//   output/<region>/<id>/{status.json, manifest.json, build.log, telemetry.jsonl}
//   output/<region>/current                 (promoted build)
//   state/pipeline-<region>.json            (scripts/pipeline step and state)
//   logs/failures/*/status.json             (preserved failed or interrupted attempts)
// A "running" record whose process is gone is reported as "aborted".
//
// mapwatch never changes map data, config, styles or build logic. The only files
// it writes are its own reports, in $FACTORY_DIR/reports/. No network, no AI/API.
import fs from 'node:fs';
import path from 'node:path';
import { FACTORY } from './lib/common.mjs';
import { createSampler } from './lib/telemetry.mjs';

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status';
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const onlyRegion = opt('--region');

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Last `bytes` of a file as lines (cheap on multi-MB logs). */
function tailLines(file, n, bytes = 64 * 1024) {
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const len = Math.min(size, bytes);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  return stripAnsi(buf.toString('utf8')).split('\n').filter((l) => l.trim()).slice(-n);
}

/** Current Planetiler stage and its latest progress line, from build.log. */
function planetilerProgress(logFile) {
  const lines = tailLines(logFile, 200);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*(\d+:\d+:\d+) \w+ \[([\w:]+)\] - (.*)$/.exec(lines[i]);
    if (m) return { stage: m[2].split(':')[0], clock: m[1], line: m[3].trim().slice(0, 160) };
  }
  return null;
}

const lastTelemetry = (file) => {
  const line = tailLines(file, 1, 4096)[0];
  try { return line ? JSON.parse(line) : null; } catch { return null; }
};

function buildRecord(region, dir, id, current) {
  const st = readJson(path.join(dir, 'status.json'));
  const mf = readJson(path.join(dir, 'manifest.json'));
  let state = st?.state ?? (mf ? 'succeeded' : 'incomplete');
  if (state === 'running' && !alive(st.pid)) state = 'aborted';
  const rec = {
    id,
    state,
    promoted: id === current,
    stage: st?.stage ?? (mf ? 'done' : null),
    started_at: st?.started_at ?? null,
    finished_at: st?.finished_at ?? mf?.created_at ?? null,
  };
  if (state === 'running') {
    rec.elapsed_s = Math.round((Date.now() - Date.parse(st.started_at)) / 1000);
    rec.planetiler = planetilerProgress(path.join(dir, 'build.log'));
    rec.telemetry = lastTelemetry(path.join(dir, 'telemetry.jsonl'));
  }
  if (state === 'failed' || state === 'aborted') {
    rec.error = st?.error ?? 'process exited without recording a result';
    rec.log_tail = st?.log_tail ? st.log_tail.split('\n').slice(-20) : tailLines(path.join(dir, 'build.log'), 20);
  }
  if (mf) {
    const tel = mf.stats?.telemetry;
    rec.build_id_scheme = mf.build_id_scheme ?? 1;
    rec.output = { bytes: mf.output.bytes, sha256: mf.output.sha256 };
    rec.snapshot = mf.inputs?.osm?.file ?? null;
    rec.stats = {
      seconds: mf.stats?.seconds ?? null,
      peak_rss_mb: mf.stats?.peak_rss_kb ? Math.round(mf.stats.peak_rss_kb / 1024) : null,
      peak_scratch_bytes: mf.stats?.peak_scratch_bytes ?? null,
      peaks: tel?.peak ?? null,
      sampler_cost_ms: tel?.sampler_cost_ms ?? null,
    };
  }
  return rec;
}

function failures() {
  const root = path.join(FACTORY, 'logs', 'failures');
  if (!isDir(root)) return [];
  return fs.readdirSync(root).sort().reverse().map((name) => {
    const st = readJson(path.join(root, name, 'status.json')) ?? {};
    return {
      dir: path.join(root, name),
      region: st.region ?? null,
      kind: name.includes('-pipeline-') ? 'pipeline' : 'build',
      build_id: st.build_id ?? null,
      state: st.state ?? null,
      stage: st.stage ?? st.step ?? null,
      error: st.error ?? (st.exit_code !== undefined ? `exit ${st.exit_code}` : null),
      at: st.finished_at ?? st.updated_at ?? null,
      log_tail: (st.log_tail ?? '').split('\n').filter((l) => l.trim()).slice(-12),
    };
  }).filter((f) => !onlyRegion || f.region === onlyRegion);
}

export function collect() {
  const outRoot = path.join(FACTORY, 'output');
  const regions = (isDir(outRoot) ? fs.readdirSync(outRoot) : [])
    .filter((r) => isDir(path.join(outRoot, r)) && (!onlyRegion || r === onlyRegion)).sort();
  const sampler = createSampler();
  return {
    generated_at: new Date().toISOString(),
    factory: FACTORY,
    host: { ...sampler.host, now: sampler.sample(null) },
    regions: regions.map((region) => {
      const rdir = path.join(outRoot, region);
      let current = null;
      try { current = fs.readlinkSync(path.join(rdir, 'current')); } catch { /* none promoted */ }
      const pipe = readJson(path.join(FACTORY, 'state', `pipeline-${region}.json`));
      if (pipe?.state === 'running' && !alive(pipe.pid)) pipe.state = 'aborted';
      return {
        region,
        current,
        pipeline: pipe && {
          state: pipe.state, step: pipe.step, build_id: pipe.build_id, started_at: pipe.started_at,
          finished_at: pipe.finished_at ?? null, log: pipe.log,
          ...(pipe.state === 'failed' || pipe.state === 'aborted'
            ? { log_tail: (pipe.log_tail ?? '').split('\n').filter((l) => l.trim()).slice(-20) } : {}),
        },
        builds: fs.readdirSync(rdir).filter((d) => /^[0-9a-f]{16}$/.test(d) && isDir(path.join(rdir, d))).sort()
          .map((id) => buildRecord(region, path.join(rdir, id), id, current)),
      };
    }),
    failures: failures(),
  };
}

// --- human-readable rendering ----------------------------------------------
const gb = (b) => {
  if (b === null || b === undefined) return '-';
  return b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`;
};
const deg = (v) => (v === null || v === undefined ? '-' : `${Number(v).toFixed(1)}°C`);
const dur = (s) => (s === null || s === undefined ? '-' : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`);

function hostLine(h) {
  const n = h.now;
  const parts = [`CPU ${deg(n.cpu_temp_c)}`, `NVMe ${deg(n.nvme_temp_c)}`];
  if (n.igpu) parts.push(`iGPU ${deg(n.igpu.temp_c)} ${n.igpu.busy_pct ?? '-'}% ${n.igpu.vram_used_mb ?? '-'}/${h.igpu_vram_total_mb} MB`);
  if (n.dgpu) parts.push(n.dgpu.temp_c === null ? `dGPU ${n.dgpu.runtime_pm}` : `dGPU ${deg(n.dgpu.temp_c)} ${n.dgpu.busy_pct}% ${n.dgpu.vram_used_mb} MB`);
  parts.push(`RAM ${n.mem_used_mb}/${h.mem_total_mb} MB`, `swap ${n.swap_used_mb}/${h.swap_total_mb} MB`, `load ${n.load1}`);
  return parts.join(' · ');
}

export function renderMarkdown(s) {
  const out = [`# mapwatch report`, '', `Generated ${s.generated_at} · factory \`${s.factory}\``, '', `**Host now:** ${hostLine(s.host)}`, ''];
  for (const r of s.regions) {
    out.push(`## ${r.region}`, '', `Promoted: ${r.current ? `\`${r.current}\`` : 'none'}`);
    if (r.pipeline) {
      const p = r.pipeline;
      out.push(`Pipeline: **${p.state}** at step \`${p.step}\`${p.build_id ? ` (build \`${p.build_id}\`)` : ''}, started ${p.started_at}${p.finished_at ? `, finished ${p.finished_at}` : ''}`);
      if (p.log_tail) out.push('', '```', ...p.log_tail, '```');
    }
    out.push('', '| Build | State | Stage | Time | PMTiles | Peak RSS | Peak scratch | Peak CPU / NVMe | sha256 |',
      '|---|---|---|---|---|---|---|---|---|');
    for (const b of r.builds) {
      const st = b.stats ?? {};
      const stage = b.state === 'running' && b.planetiler ? `${b.stage}: ${b.planetiler.stage}` : (b.stage ?? '-');
      out.push(`| \`${b.id}\`${b.promoted ? ' ★' : ''} | ${b.state} | ${stage} | ${dur(b.elapsed_s ?? st.seconds)} | ${gb(b.output?.bytes)} | `
        + `${st.peak_rss_mb ? `${(st.peak_rss_mb / 1024).toFixed(1)} GB` : '-'} | ${gb(st.peak_scratch_bytes)} | `
        + `${st.peaks ? `${deg(st.peaks.cpu_temp_c)} / ${deg(st.peaks.nvme_temp_c)}` : '-'} | ${b.output ? `\`${b.output.sha256.slice(0, 12)}…\`` : '-'} |`);
    }
    for (const b of r.builds.filter((x) => x.state === 'running')) {
      out.push('', `Running \`${b.id}\`: ${b.planetiler ? `[${b.planetiler.stage}] ${b.planetiler.line}` : b.stage}`);
    }
    for (const b of r.builds.filter((x) => x.log_tail)) {
      out.push('', `**${b.state} \`${b.id}\`** at stage \`${b.stage}\`: ${b.error}`, '', '```', ...b.log_tail, '```');
    }
    out.push('');
  }
  out.push(`## Preserved failures (${s.failures.length})`, '');
  if (!s.failures.length) out.push('None.');
  for (const f of s.failures.slice(0, 20)) {
    out.push(`- \`${path.basename(f.dir)}\`: ${f.kind} ${f.state ?? ''} at \`${f.stage}\`: ${f.error ?? '-'}`);
  }
  return out.join('\n') + '\n';
}

/** Fields whose change is worth a line in `watch`. */
function changeKey(s) {
  return JSON.stringify(s.regions.map((r) => [r.region, r.current, r.pipeline?.state, r.pipeline?.step,
    r.builds.map((b) => [b.id, b.state, b.stage, b.planetiler?.stage])]));
}

function watchLines(s) {
  const t = s.generated_at.slice(11, 19);
  const lines = [];
  for (const r of s.regions) {
    if (r.pipeline && (r.pipeline.state !== 'succeeded' || !r.builds.some((b) => b.state === 'running'))) {
      lines.push(`${t} ${r.region} pipeline ${r.pipeline.state} step=${r.pipeline.step}${r.pipeline.build_id ? ` build=${r.pipeline.build_id}` : ''}`);
    }
    for (const b of r.builds.filter((x) => ['running', 'failed', 'aborted'].includes(x.state))) {
      const tel = b.telemetry;
      lines.push(`${t} ${r.region} build ${b.id} ${b.state} stage=${b.stage}${b.planetiler ? `/${b.planetiler.stage}` : ''}`
        + `${b.elapsed_s !== undefined ? ` elapsed=${dur(b.elapsed_s)}` : ''}`
        + `${tel ? ` cpu=${deg(tel.cpu_temp_c)} nvme=${deg(tel.nvme_temp_c)} ram=${tel.mem_used_mb}MB scratch=${gb(tel.scratch_bytes)}` : ''}`
        + `${b.error ? ` error="${b.error}"` : ''}`);
    }
  }
  return lines;
}

const anyRunning = (s) => s.regions.some((r) => r.pipeline?.state === 'running' || r.builds.some((b) => b.state === 'running'));

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  if (command === 'status') {
    const s = collect();
    process.stdout.write(argv.includes('--json') ? JSON.stringify(s, null, 2) + '\n' : renderMarkdown(s));
  } else if (command === 'report') {
    const s = collect();
    const dir = path.join(FACTORY, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = s.generated_at.replace(/[:.]/g, '-');
    for (const name of [`mapwatch-${stamp}`, 'latest']) {
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(s, null, 2) + '\n');
      fs.writeFileSync(path.join(dir, `${name}.md`), renderMarkdown(s));
    }
    console.log(`wrote ${path.join(dir, `mapwatch-${stamp}`)}.{json,md} (and latest.{json,md})`);
  } else if (command === 'watch') {
    const interval = Number(opt('--interval') || 10) * 1000;
    const heartbeat = 5 * 60 * 1000; // repeat running lines every 5 min even without changes
    let lastKey = null;
    let lastPrint = 0;
    for (;;) {
      const s = collect();
      const key = changeKey(s);
      if (key !== lastKey || Date.now() - lastPrint >= heartbeat) {
        const lines = watchLines(s);
        console.log(lines.length ? lines.join('\n') : `${s.generated_at.slice(11, 19)} idle (no running builds or pipelines)`);
        lastKey = key;
        lastPrint = Date.now();
      }
      if (argv.includes('--until-idle') && !anyRunning(s)) break;
      await new Promise((r) => setTimeout(r, interval));
    }
  } else {
    console.error('usage: mapwatch.mjs status|watch|report [--region R] [--json] [--interval S] [--until-idle]');
    process.exit(2);
  }
}
