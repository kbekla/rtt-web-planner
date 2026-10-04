// Internal child for resource-admission.mjs. The parent holds a kernel flock
// while this process performs one bounded state transition.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const bootId = () => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } };
const procStart = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null; } catch { return null; } };
function groupExists(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return null;
  try { process.kill(-pgid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; return null; }
}
function workerExists(identity) {
  if (!identity?.pid || !identity?.process_start) return null;
  const start = procStart(identity.pid);
  if (start === null) return false;
  return start === identity.process_start;
}
function liveOrUncertain(record, currentBoot) {
  if (!record || record.boot_id !== currentBoot) return false;
  const ownerLive = workerExists(record);
  if (ownerLive === true) return true;
  if (ownerLive === null) return null;
  if (!record.workload) return ['reserved'].includes(record.phase) ? false : null;
  const groupLive = groupExists(record.workload.pgid);
  return groupLive === false ? false : groupLive;
}
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(input.stateFile, 'utf8'));
    if (s.schema !== 1 || !Array.isArray(s.history) || !('lease' in s) || !('factory_intent' in s)) return { corrupt: true };
    return s;
  } catch (e) { return e.code === 'ENOENT' ? { schema: 1, lease: null, factory_intent: null, history: [] } : { corrupt: true }; }
}
function write(s) {
  s.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(input.stateFile), { recursive: true, mode: 0o700 });
  const tmp = `${input.stateFile}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(s, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, input.stateFile);
  const dirFd = fs.openSync(path.dirname(input.stateFile), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}
function recordFor(owner, priority, phase = 'reserved') {
  const identity = input.identity ?? {};
  return { owner, priority, phase, nonce: crypto.randomUUID(), pid: identity.pid, process_start: identity.process_start, boot_id: identity.boot_id, workload: null,
    acquired_at: new Date().toISOString() };
}
function cleanStale(s) {
  const currentBoot = bootId();
  if (s.factory_intent && s.factory_intent.boot_id !== currentBoot) s.factory_intent = null;
  else if (s.factory_intent && workerExists(s.factory_intent) === false) s.factory_intent = null;
  if (s.lease) {
    const alive = liveOrUncertain(s.lease, currentBoot);
    if (alive === false) {
      s.history.push({ owner: s.lease.owner, priority: s.lease.priority, reason: 'owner/workload proven stopped or prior boot', recovered_at: new Date().toISOString() });
      s.history = s.history.slice(-100); s.lease = null;
    }
  }
}
const state = readState();
if (state.corrupt) { process.stdout.write(JSON.stringify({ ok: false, reason: 'coordination state unreadable; fail-closed' })); process.exit(0); }
cleanStale(state);
let result;
const sameOwner = (r) => r?.owner === input.owner && r?.pid === input.identity?.pid && r?.process_start === input.identity?.process_start && r?.boot_id === input.identity?.boot_id;
switch (input.op) {
  case 'status': result = { ok: true, state }; break;
  case 'scout-acquire':
    if (state.factory_intent) result = { ok: false, reason: 'factory-priority-intent', owner: state.factory_intent.owner };
    else if (state.lease) result = { ok: false, reason: 'lease-held', owner: state.lease.owner };
    else { state.lease = recordFor(input.owner, 'background'); write(state); result = { ok: true, lease: state.lease }; }
    break;
  case 'factory-request': {
    if (state.factory_intent && !sameOwner(state.factory_intent)) { result = { ok: false, reason: 'factory-intent-held', owner: state.factory_intent.owner }; break; }
    if (!state.factory_intent) state.factory_intent = recordFor(input.owner, 'factory', 'waiting');
    if (!state.lease) state.lease = { ...recordFor(input.owner, 'factory'), nonce: state.factory_intent.nonce };
    write(state);
    result = state.lease.owner === input.owner && state.lease.priority === 'factory'
      ? { ok: true, granted: true, lease: state.lease, nonce: state.factory_intent.nonce }
      : { ok: true, granted: false, reason: 'waiting-for-background-yield', owner: state.lease.owner, nonce: state.factory_intent.nonce };
    break;
  }
  case 'factory-poll':
    if (!sameOwner(state.factory_intent) || state.factory_intent.nonce !== input.nonce) result = { ok: false, reason: 'factory-intent-owner-mismatch' };
    else if (state.lease && (state.lease.owner !== input.owner || state.lease.priority !== 'factory')) result = { ok: true, granted: false, reason: 'waiting-for-background-yield', owner: state.lease.owner };
    else {
      if (!state.lease) state.lease = { ...recordFor(input.owner, 'factory'), nonce: input.nonce };
      write(state); result = { ok: true, granted: true, lease: state.lease };
    }
    break;
  case 'begin-launch':
    if (!sameOwner(state.lease) || state.lease.nonce !== input.nonce) result = { ok: false, reason: 'lease-owner-mismatch' };
    else if (state.lease.phase !== 'reserved') result = { ok: false, reason: 'invalid-launch-phase' };
    else { state.lease.phase = 'launching'; write(state); result = { ok: true, lease: state.lease }; }
    break;
  case 'bind-workload':
    if (!sameOwner(state.lease) || state.lease.nonce !== input.nonce) result = { ok: false, reason: 'lease-owner-mismatch' };
    else if (state.lease.phase !== 'launching') result = { ok: false, reason: 'workload-binding-requires-launching-phase' };
    else if (!Number.isInteger(input.workload?.pgid) || input.workload.pgid <= 0) result = { ok: false, reason: 'invalid-workload-process-group' };
    else { state.lease.phase = 'running'; state.lease.workload = input.workload; write(state); result = { ok: true, lease: state.lease }; }
    break;
  case 'release':
    if (!sameOwner(state.lease) || state.lease.nonce !== input.nonce) result = { ok: false, reason: 'lease-owner-mismatch' };
    else {
      state.history.push({ owner: state.lease.owner, priority: state.lease.priority, reason: input.reason ?? 'completed', released_at: new Date().toISOString() });
      state.history = state.history.slice(-100); state.lease = null;
      if (state.factory_intent && sameOwner(state.factory_intent) && state.factory_intent.nonce === input.nonce) state.factory_intent = null;
      write(state); result = { ok: true };
    }
    break;
  default: result = { ok: false, reason: 'unknown-operation' };
}
process.stdout.write(JSON.stringify(result));
