// Live check of the AI helper's hybrid placement against the real rtt-ollama service.
// Loads the model, so it is not part of tests/repo (which the pipeline runs during builds).
//   make test-ai        (skips when Ollama or the model is unavailable)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { REPO } from '../../scripts/lib/common.mjs';
import { diagnose, readiness, unload } from '../../scripts/factory/ai.mjs';

const policy = yaml.load(fs.readFileSync(path.join(REPO, 'config', 'factory.yaml'), 'utf8')).ai;
const failure = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/ai-eval.json'), 'utf8'))
  .cases.find((c) => c.id === 'socket-unreachable');
const limits = () => spawnSync('systemctl', ['--user', 'show', 'rtt-ollama.service', '-p', 'MemoryHigh', '-p', 'MemoryMax'], { encoding: 'utf8' }).stdout.trim();
const loaded = async () => ((await (await fetch('http://127.0.0.1:11434/api/ps')).json()).models ?? []).length;

test('while a job runs the helper never uses the CPU', async (t) => {
  const r = await readiness(policy, { busy: true });
  if (/not reachable|not installed/.test(r.reason)) return t.skip(r.reason);
  assert.notEqual(r.mode, 'cpu');
  assert.ok(r.tried.every((x) => x.mode !== 'cpu'));
  // Default (no flag) is the busy path.
  assert.notEqual((await readiness(policy)).mode, 'cpu');
});

test('idle: CPU mode diagnoses, then unloads and restores the memory cap', async (t) => {
  const r = await readiness(policy, { busy: false });
  if (/not reachable|not installed/.test(r.reason)) return t.skip(r.reason);
  if (r.mode !== 'cpu') return t.skip(`CPU mode not available right now: ${r.reason}`);
  const before = limits();
  const d = await diagnose(failure, policy, { busy: false });
  assert.equal(d.mode, 'cpu', d.reason);
  assert.equal(d.stats.gpu_fraction, 0);
  assert.equal(d.suggestion.remediation, failure.expect);
  assert.equal(limits(), before, 'memory limits not restored');
  assert.equal(await loaded(), 0, 'model left loaded after a CPU call');
  console.log(`# cpu: ${d.stats.tokens_per_s} tok/s, ${d.stats.total_ms} ms`);
});

test('busy: GPU mode still works and keeps the model 100 % in VRAM', async (t) => {
  const r = await readiness(policy, { busy: true });
  if (r.mode !== 'gpu') return t.skip(`GPU mode not available: ${r.reason}`);
  const d = await diagnose(failure, policy, { busy: true });
  assert.equal(d.mode, 'gpu', d.reason);
  assert.equal(d.stats.gpu_fraction, 1);
  console.log(`# gpu: ${d.stats.tokens_per_s} tok/s, ${d.stats.total_ms} ms`);
  await unload(policy.model);
});
