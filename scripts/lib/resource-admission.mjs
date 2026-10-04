// Development-only shared admission protocol for factory-priority work and
// background Scout/local-AI work. It is deliberately not wired into live
// services. Updates run under a kernel flock so crashes cannot strand a mutex.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./resource-admission-worker.mjs', import.meta.url));
export const resourceAdmissionStateFile = (factoryDir) => path.join(factoryDir, 'state', 'resource-admission.json');
function processStart(pid) { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null; } catch (e) { return e.code === 'ENOENT' || e.code === 'ESRCH' ? null : undefined; } }
function bootId() { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { return null; } }
export function processIdentity(pid = process.pid) { return { pid, process_start: processStart(pid), boot_id: bootId() }; }

export class SharedResourceAdmission {
  constructor(stateFile, { flock = 'flock', timeoutMs = 5000 } = {}) {
    this.stateFile = path.resolve(stateFile);
    this.gateFile = `${this.stateFile}.gate`;
    this.flock = flock;
    this.timeoutMs = timeoutMs;
    this.backgroundNonces = new Map();
  }
  transition(op, fields = {}) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const identity = processIdentity();
    if (op !== 'status' && (!identity.process_start || !identity.boot_id)) return { ok: false, reason: 'host process/boot identity unavailable; fail-closed' };
    const res = spawnSync(this.flock, ['--exclusive', this.gateFile, process.execPath, helper], {
      input: JSON.stringify({ op, stateFile: this.stateFile, identity, ...fields }), encoding: 'utf8', timeout: this.timeoutMs,
      maxBuffer: 128 * 1024, windowsHide: true,
    });
    if (res.error || res.status !== 0) return { ok: false, reason: 'coordination gate unavailable; fail-closed' };
    try { return JSON.parse(res.stdout); } catch { return { ok: false, reason: 'coordination response invalid; fail-closed' }; }
  }
  status() { return this.transition('status'); }
  acquireScout(owner) { return this.transition('scout-acquire', { owner }); }
  requestFactory(owner, detail = owner) { return this.transition('factory-request', { owner, detail }); }
  pollFactory(owner, nonce, detail = owner) { return this.transition('factory-poll', { owner, nonce, detail }); }
  beginLaunch(owner, nonce) { return this.transition('begin-launch', { owner, nonce }); }
  bindWorkload(owner, nonce, workload) { return this.transition('bind-workload', { owner, nonce, workload }); }
  workloadFinished(owner, nonce) { return this.transition('workload-finished', { owner, nonce }); }
  abortLaunch(owner, nonce) { return this.transition('abort-launch', { owner, nonce }); }
  cancelFactoryIntent(owner, nonce) { return this.transition('cancel-factory-intent', { owner, nonce }); }
  release(owner, nonce, reason) {
    const tracked = nonce === undefined;
    const token = tracked ? this.backgroundNonces.get(owner) : nonce;
    if (!token) return tracked ? false : { ok: false, reason: 'lease nonce required' };
    const result = this.transition('release', { owner, nonce: token, reason });
    if (result.ok) this.backgroundNonces.delete(owner);
    return tracked ? result.ok : result;
  }
  // Drop-in lease methods for ScoutHeavyWorkCoordinator.
  acquire(owner) {
    if (!owner || typeof owner !== 'string') return { ok: false, owner: 'invalid-owner' };
    const result = this.transition('scout-acquire', { owner, detail: owner });
    if (result.ok) this.backgroundNonces.set(owner, result.lease.nonce);
    return result.ok ? { ok: true, owner, nonce: result.lease.nonce, recovered: false }
      : { ok: false, owner: result.owner ?? 'unknown', reason: result.reason ?? 'coordination unavailable' };
  }
}
