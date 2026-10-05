import { spawn as nodeSpawn } from 'node:child_process';
import procFs from 'node:fs';

const children = new Set();
let cleanupPromise = null;

/** Spawn each test child in its own process group so descendants are owned too. */
export function spawnTracked(command, args = [], options = {}) {
  const child = nodeSpawn(command, args, { ...options, detached: true });
  children.add(child);
  return child;
}

export function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', resolve));
}

function signalGroup(child, signal) {
  if (!Number.isInteger(child.pid)) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export function processGroupHasLiveMembers(pgid) {
  let entries;
  try { entries = procFs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)); } catch { return false; }
  for (const entry of entries) {
    let stat;
    try { stat = procFs.readFileSync(`/proc/${entry}/stat`, 'utf8'); } catch { continue; }
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') return true;
  }
  return false;
}

async function waitForGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupHasLiveMembers(pgid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processGroupHasLiveMembers(pgid);
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  const settled = await Promise.race([
    promise.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  clearTimeout(timer);
  return settled;
}
const childGroupStopped = (child, timeoutMs) => Promise.all([waitForClose(child), waitForGroupExit(child.pid, timeoutMs)])
  .then(([, groupStopped]) => groupStopped);

/** Terminate and reap one test child/group; allow the factory's 5 s stop budget. */
export async function stopTrackedChild(child, { graceMs = 7000 } = {}) {
  if (!children.has(child)) return waitForClose(child);
  const pgid = child.pid;
  signalGroup(child, 'SIGTERM');
  await settlesWithin(childGroupStopped(child, graceMs), graceMs);
  signalGroup(child, 'SIGKILL');
  const stopped = await settlesWithin(childGroupStopped(child, graceMs * 2), graceMs * 2 + 100);
  children.delete(child);
  if (!stopped) throw new Error(`test child process group ${pgid} did not stop after SIGKILL`);
}

/** Finalizer shared by test files; safe after assertions, cancellation or errors. */
export function cleanupTrackedChildren({ graceMs = 7000 } = {}) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const pending = [...children];
    for (const child of pending) signalGroup(child, 'SIGTERM');
    await settlesWithin(Promise.all(pending.map((child) => childGroupStopped(child, graceMs))).then((result) => result.every(Boolean)), graceMs);
    for (const child of pending) signalGroup(child, 'SIGKILL');
    const stopped = await settlesWithin(Promise.all(pending.map((child) => childGroupStopped(child, graceMs * 2))).then((result) => result.every(Boolean)), graceMs * 2 + 100);
    children.clear();
    if (!stopped) throw new Error('one or more test-owned worker/helper process groups survived SIGKILL');
  })();
  return cleanupPromise;
}

/** SIGINT/SIGTERM cleanup is asynchronous so the test process waits for child reaping. */
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    void cleanupTrackedChildren().finally(() => process.exit(code));
  });
}
