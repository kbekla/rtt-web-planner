#!/usr/bin/env node
// Intentionally dormant worker entrypoint. It consumes only already queued local observations.
import path from 'node:path';
import os from 'node:os';
import { ScoutStore, makeHeartbeat, workerLock, normalizeObservation, candidateFromObservation, assessEvidence, matchMaster } from './core.mjs';

const factory = process.env.FACTORY_DIR || path.join(os.homedir(), 'rtt-map-factory');
const store = new ScoutStore(factory);
const redFile = path.join(store.state, 'red.json');
const recordRed = (reason) => {
  store.atomic(redFile, { status: 'RED', reason: String(reason), at: new Date().toISOString(), requires_manual_review: true });
  store.atomic(path.join(store.state, 'worker.json'), makeHeartbeat({ status: 'RED', current_step: 'integrity-hold' }));
};
const lock = workerLock(path.join(store.state, 'worker.lock'));
if (!lock.ok) { console.error(`another Scout worker owns pid ${lock.owner}`); process.exit(1); }
store.ensure();
if (store.read('red.json')) { console.error(`Scout is held RED: ${store.read('red.json').reason}`); process.exit(0); }
try { store.recover(); }
catch (e) { recordRed(`queue recovery failed: ${e.message ?? e}`); console.error(store.read('red.json').reason); process.exit(0); }
const heartbeat = (status, job_id, current_step, source_key = null) => store.atomic(path.join(store.state, 'worker.json'), makeHeartbeat({ status, job_id, current_step, source_key }));
heartbeat('GREEN', null, 'idle');
const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function cycle() {
  const job = store.claim();
  if (!job) { heartbeat('GREEN', null, 'idle'); return false; }
  heartbeat('GREEN', job.job_id, 'normalise', job.source_key);
  try {
    const { observation } = normalizeObservation(job.payload, { sourceKey: job.source_key });
    const c = candidateFromObservation(observation);
    c.master_match = matchMaster(c, []);
    assessEvidence(c); store.saveCandidate(c);
    store.atomic(path.join(store.state, 'activity.json'), { at: new Date().toISOString(), source_key: job.source_key, candidate_id: c.candidate_id });
    store.finish(job); heartbeat('GREEN', null, 'idle'); return true;
  } catch (e) {
    const result = store.finish(job, 'held', e.message);
    heartbeat(result.state === 'held' ? 'AMBER' : 'GREEN', null, 'source-error'); return true;
  }
}
do {
  if (stopping) break;
  let processed;
  try { processed = await cycle(); }
  catch (e) { recordRed(`worker state failure: ${e.message ?? e}`); break; }
  if (once) break;
  if (!processed) await new Promise((r) => setTimeout(r, 30_000));
} while (!stopping);
if (!store.read('red.json')) heartbeat('GREEN', null, stopping ? 'stopped' : 'idle');
