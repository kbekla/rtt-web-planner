// Persistent, crash-safe job queue on the local filesystem.
//
//   $FACTORY_DIR/queue/pending/<job>.json   waiting to run
//   $FACTORY_DIR/queue/running/<job>.json   claimed by the worker (at most one)
//   $FACTORY_DIR/queue/held/<job>.json      AMBER: waiting for a human
//   $FACTORY_DIR/queue/done/<job>.json      finished successfully
//   $FACTORY_DIR/queue/cancelled/<job>.json removed by a human
//   $FACTORY_DIR/queue/logs/<job>/attempt-<n>.log
//
// Every write goes to a temp file and is renamed into place, and moves between
// states are renames, so a crash or power loss never leaves a half-written job.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { FACTORY, REPO } from '../lib/common.mjs';

export const QUEUE = path.join(FACTORY, 'queue');
export const STATES = ['pending', 'running', 'held', 'done', 'cancelled'];
export const STATE_DIR = path.join(FACTORY, 'state');
export const JOB_TYPES = ['build', 'verify', 'repro', 'refresh', 'trails'];
// The RT&T trail layer is its own artefact, not a region: trails jobs always use this name.
export const TRAILS = 'rtt-trails';

export function ensureDirs() {
  for (const s of [...STATES, 'logs']) fs.mkdirSync(path.join(QUEUE, s), { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

/** Test mode: only with RTT_FACTORY_TEST=1 and a throwaway factory under the OS temp dir. */
export const TEST_MODE = process.env.RTT_FACTORY_TEST === '1' && FACTORY.startsWith(os.tmpdir() + path.sep);

export function loadPolicy(repo = REPO) {
  const file = TEST_MODE && process.env.RTT_FACTORY_POLICY ? process.env.RTT_FACTORY_POLICY : path.join(repo, 'config', 'factory.yaml');
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const jobFile = (state, id) => path.join(QUEUE, state, `${id}.json`);

export function list(state) {
  const dir = path.join(QUEUE, state);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => { try { return readJson(path.join(dir, f)); } catch { return null; } }).filter(Boolean);
}

export function find(id) {
  for (const s of STATES) if (fs.existsSync(jobFile(s, id))) return { state: s, job: readJson(jobFile(s, id)) };
  return null;
}

export function save(state, job) {
  job.updated_at = new Date().toISOString();
  writeJsonAtomic(jobFile(state, job.id), job);
}

/** Move a job between states, saving its current contents in the new state. */
export function move(job, from, to) {
  save(from, job);
  fs.renameSync(jobFile(from, job.id), jobFile(to, job.id));
}

export function enqueue({ type, region, by = 'user', priority = 50, options = {}, note = null }) {
  if (!JOB_TYPES.includes(type)) throw new Error(`unknown job type '${type}' (${JOB_TYPES.join(', ')})`);
  if ((type === 'trails') !== (region === TRAILS)) throw new Error(`job type 'trails' goes with '${TRAILS}' and only with it (got ${type} ${region})`);
  if (!/^[a-z0-9-]+$/.test(region)) throw new Error(`invalid region '${region}'`);
  ensureDirs();
  const now = new Date();
  const id = `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${region}-${type}-${crypto.randomBytes(2).toString('hex')}`;
  const job = { id, type, region, priority, created_at: now.toISOString(), created_by: by, options, note,
    approved: false, not_before: null, attempts: [], remediations: {}, events: [] };
  save('pending', job);
  return job;
}

/** Jobs of this type and region that are pending, running or held. */
export const active = (type, region) => ['pending', 'running', 'held']
  .flatMap((s) => list(s)).filter((j) => j.type === type && j.region === region);

/** Next runnable pending job: lowest priority number, then oldest; skips backoff. */
export function next(now = Date.now()) {
  return list('pending')
    .filter((j) => !j.not_before || Date.parse(j.not_before) <= now)
    .sort((a, b) => (a.priority - b.priority) || a.created_at.localeCompare(b.created_at))[0] ?? null;
}

export function event(job, msg, extra = {}) {
  job.events.push({ at: new Date().toISOString(), msg, ...extra });
  if (job.events.length > 200) job.events.splice(0, job.events.length - 200);
}

// --- RED stop ----------------------------------------------------------------
const RED_FILE = path.join(STATE_DIR, 'red.json');
export const red = () => (fs.existsSync(RED_FILE) ? readJson(RED_FILE) : null);
export function setRed(reason, job = null) {
  ensureDirs();
  writeJsonAtomic(RED_FILE, { at: new Date().toISOString(), reason, job });
}
export function clearRed() { fs.rmSync(RED_FILE, { force: true }); }
