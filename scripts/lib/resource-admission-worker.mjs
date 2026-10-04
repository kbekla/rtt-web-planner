// One bounded state transition, run while the parent holds the kernel flock.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
function bootId() { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { return null; } }
const currentBoot = bootId();
function procStart(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const v = s.slice(s.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    return /^\d+$/.test(v ?? '') ? v : undefined;
  } catch (e) { return e.code === 'ENOENT' || e.code === 'ESRCH' ? null : undefined; }
}
function procGroup(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const v = s.slice(s.lastIndexOf(')') + 2).trim().split(/\s+/)[2];
    return /^\d+$/.test(v ?? '') ? Number(v) : undefined;
  } catch (e) { return e.code === 'ENOENT' || e.code === 'ESRCH' ? null : undefined; }
}
function groupExists(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return null;
  try { process.kill(-pgid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; return null; }
}
function findLauncher(nonce) {
  let uncertain = false;
  let pids;
  try { pids = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch { return null; }
  for (const item of pids) {
    try {
      const proc = `/proc/${item}`;
      if (typeof process.getuid === 'function' && fs.statSync(proc).uid !== process.getuid()) continue;
      const argv = fs.readFileSync(`${proc}/cmdline`, 'utf8').split('\0');
      if (argv.some((x) => x.endsWith('/factory/resource-admission-exec.mjs')) && argv.includes(nonce)) {
        const pid = Number(item), start = procStart(pid);
        if (!start) return null;
        return { alive: true, workload: { pid, pgid: pid, process_start: start, boot_id: currentBoot } };
      }
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') uncertain = true; }
  }
  return uncertain ? null : { alive: false };
}
function identityState(record) {
  if (!record?.pid || !record.process_start || !record.boot_id || !currentBoot) return null;
  if (record.boot_id !== currentBoot) return false;
  const start = procStart(record.pid);
  if (start === null) return false;
  if (start === undefined) return null;
  return start === record.process_start;
}
function liveOrUncertain(record) {
  if (!record?.boot_id || !currentBoot) return null;
  if (record.boot_id !== currentBoot) return false;
  const owner = identityState(record);
  if (owner === true || owner === null) return owner;
  if (!record.workload) {
    if (record.phase === 'reserved') return false;
    if (record.phase === 'launching' && record.priority === 'factory' && record.nonce) {
      const launched = findLauncher(record.nonce);
      if (!launched) return null;
      return launched.alive ? groupExists(launched.workload.pgid) : false;
    }
    return null;
  }
  if (!record.workload.boot_id || record.workload.boot_id !== currentBoot || !record.workload.process_start) return null;
  const leader = procStart(record.workload.pid);
  if (leader === undefined) return null;
  const group = groupExists(record.workload.pgid);
  return group === false ? false : group;
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
  try { fs.writeFileSync(fd, `${JSON.stringify(s, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, input.stateFile);
  const dirFd = fs.openSync(path.dirname(input.stateFile), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}
function recordFor(owner, priority, phase = 'reserved', detail = owner) {
  const identity = input.identity ?? {};
  return { owner, priority, phase, nonce: crypto.randomUUID(), pid: identity.pid, process_start: identity.process_start,
    boot_id: identity.boot_id, workload: null, detail, acquired_at: new Date().toISOString() };
}
function cleanStale(s) {
  if (!currentBoot) return;
  if (s.factory_intent && s.factory_intent.boot_id && s.factory_intent.boot_id !== currentBoot) s.factory_intent = null;
  else if (s.factory_intent && identityState(s.factory_intent) === false) s.factory_intent = null;
  if (s.lease && liveOrUncertain(s.lease) === false) {
    s.history.push({ owner: s.lease.owner, priority: s.lease.priority, reason: 'owner/workload proven stopped or previous boot', recovered_at: new Date().toISOString() });
    s.history = s.history.slice(-100); s.lease = null;
  }
}
const state = readState();
if (state.corrupt) { process.stdout.write(JSON.stringify({ ok: false, reason: 'coordination state unreadable; fail-closed' })); process.exit(0); }
cleanStale(state);
const sameIdentity = (r) => r?.pid === input.identity?.pid && r?.process_start === input.identity?.process_start && r?.boot_id === input.identity?.boot_id;
const sameOwner = (r) => r?.owner === input.owner && sameIdentity(r);
const validIdentity = () => Boolean(input.identity?.pid && input.identity?.process_start && input.identity?.boot_id && currentBoot && input.identity.boot_id === currentBoot);
let result;
switch (input.op) {
  case 'status': result = { ok: true, state }; break;
  case 'scout-acquire':
    if (!validIdentity()) result = { ok: false, reason: 'host identity unavailable; fail-closed' };
    else if (state.factory_intent) result = { ok: false, reason: 'factory-priority-intent', owner: state.factory_intent.owner };
    else if (state.lease) result = { ok: false, reason: 'lease-held', owner: state.lease.owner };
    else { state.lease = recordFor(input.owner, 'background', 'reserved', input.detail); write(state); result = { ok: true, lease: state.lease }; }
    break;
  case 'factory-request': {
    if (!validIdentity()) { result = { ok: false, reason: 'host identity unavailable; fail-closed' }; break; }
    if (state.factory_intent && !sameOwner(state.factory_intent)) { result = { ok: false, reason: 'factory-intent-held', owner: state.factory_intent.owner }; break; }
    if (!state.factory_intent) state.factory_intent = recordFor(input.owner, 'factory', 'waiting', input.detail);
    if (!state.lease) state.lease = { ...recordFor(input.owner, 'factory', 'reserved', input.detail), nonce: state.factory_intent.nonce };
    write(state);
    result = sameOwner(state.lease) && state.lease.nonce === state.factory_intent.nonce && state.lease.priority === 'factory'
      ? { ok: true, granted: true, lease: state.lease, nonce: state.factory_intent.nonce }
      : { ok: true, granted: false, reason: 'waiting-for-background-yield', owner: state.lease.owner, nonce: state.factory_intent.nonce };
    break;
  }
  case 'factory-poll':
    if (!validIdentity() || !sameOwner(state.factory_intent) || state.factory_intent.nonce !== input.nonce) result = { ok: false, reason: 'factory-intent-owner-mismatch' };
    else if (state.lease && (!sameOwner(state.lease) || state.lease.nonce !== input.nonce || state.lease.priority !== 'factory')) result = { ok: true, granted: false, reason: 'waiting-for-background-yield', owner: state.lease.owner };
    else {
      if (!state.lease) state.lease = { ...recordFor(input.owner, 'factory', 'reserved', input.detail), nonce: input.nonce };
      write(state); result = { ok: true, granted: true, lease: state.lease };
    }
    break;
  case 'begin-launch':
    if (!validIdentity() || !sameOwner(state.lease) || state.lease.nonce !== input.nonce) result = { ok: false, reason: 'lease-owner-mismatch' };
    else if (state.lease.phase !== 'reserved') result = { ok: false, reason: 'invalid-launch-phase' };
    else { state.lease.phase = 'launching'; write(state); result = { ok: true, lease: state.lease }; }
    break;
  case 'bind-workload':
    if (!validIdentity() || !sameOwner(state.lease) || state.lease.nonce !== input.nonce) result = { ok: false, reason: 'lease-owner-mismatch' };
    else if (!['reserved', 'launching'].includes(state.lease.phase)) result = { ok: false, reason: 'workload-binding-requires-reserved-or-launching-phase' };
    else if (!Number.isInteger(input.workload?.pgid) || input.workload.pgid <= 0 || !Number.isInteger(input.workload?.pid)
      || input.workload.pid !== input.workload.pgid || !input.workload.process_start || !input.workload.boot_id
      || input.workload.boot_id !== currentBoot || procStart(input.workload.pid) !== input.workload.process_start
      || procGroup(input.workload.pid) !== input.workload.pgid) result = { ok: false, reason: 'invalid-workload-process-identity' };
    else { state.lease.phase = 'running'; state.lease.workload = input.workload; write(state); result = { ok: true, lease: state.lease }; }
    break;
  case 'workload-finished':
    if (!validIdentity() || !sameOwner(state.lease) || state.lease.nonce !== input.nonce) result = { ok: false, reason: 'lease-owner-mismatch' };
    else if (!state.lease.workload || state.lease.phase !== 'running') result = { ok: false, reason: 'no bound workload to finish' };
    else if (groupExists(state.lease.workload.pgid) !== false) result = { ok: false, reason: 'workload process group is still active or uncertain' };
    else { state.lease.phase = 'reserved'; state.lease.workload = null; write(state); result = { ok: true }; }
    break;
  case 'abort-launch':
    if (!validIdentity() || !sameOwner(state.lease) || state.lease.nonce !== input.nonce) result = { ok: false, reason: 'lease-owner-mismatch' };
    else if (state.lease.phase !== 'launching' || state.lease.workload) result = { ok: false, reason: 'launch state cannot be aborted' };
    else {
      const launched = findLauncher(state.lease.nonce);
      if (!launched || launched.alive) result = { ok: false, reason: 'launcher may still be active; fail-closed' };
      else { state.lease.phase = 'reserved'; write(state); result = { ok: true }; }
    }
    break;
  case 'release':
    if (!validIdentity() || !sameOwner(state.lease) || state.lease.nonce !== input.nonce) result = { ok: false, reason: 'lease-owner-mismatch' };
    else if (state.lease.workload && groupExists(state.lease.workload.pgid) !== false) result = { ok: false, reason: 'workload process group is still active or uncertain' };
    else if (state.lease.phase === 'launching' && !state.lease.workload) result = { ok: false, reason: 'launch outcome uncertain; fail-closed' };
    else {
      state.history.push({ owner: state.lease.owner, priority: state.lease.priority, reason: input.reason ?? 'completed', released_at: new Date().toISOString() });
      state.history = state.history.slice(-100); state.lease = null;
      if (state.factory_intent && sameOwner(state.factory_intent) && state.factory_intent.nonce === input.nonce) state.factory_intent = null;
      write(state); result = { ok: true };
    }
    break;
  case 'cancel-factory-intent':
    if (!validIdentity() || !sameOwner(state.factory_intent) || state.factory_intent.nonce !== input.nonce) result = { ok: false, reason: 'factory-intent-owner-mismatch' };
    else if (state.lease && sameOwner(state.lease) && state.lease.nonce === input.nonce) result = { ok: false, reason: 'factory lease already granted' };
    else { state.factory_intent = null; write(state); result = { ok: true }; }
    break;
  default: result = { ok: false, reason: 'unknown-operation' };
}
process.stdout.write(JSON.stringify(result));
