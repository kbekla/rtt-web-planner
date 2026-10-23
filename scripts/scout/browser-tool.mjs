import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BROWSER_HOME = path.join(os.homedir(), 'Projects', 'rtt-council-inspector');
const DEFAULT_CHROME = '/usr/bin/google-chrome';

export function browserToolStatus({ browserHome = process.env.SCOUT_BROWSER_HOME || DEFAULT_BROWSER_HOME, exists = fs.existsSync } = {}) {
  const entry = path.join(browserHome, 'scripts', 'scout-investigate.ts');
  const tsx = path.join(browserHome, 'node_modules', '.bin', 'tsx');
  const chrome = process.env.SCOUT_CHROME_EXECUTABLE || DEFAULT_CHROME;
  const codex = process.env.SCOUT_CODEX_BIN || path.join(os.homedir(), '.local/npm/bin/codex');
  const checks = { entry: exists(entry), runner: exists(tsx), chrome: exists(chrome), codex: exists(codex) };
  return {
    capability: 'scout.visual_browser.v1', status: Object.values(checks).every(Boolean) ? 'READY' : 'BLOCKED',
    browser_home: browserHome, checks, execution: 'bounded, independent, read-only Scout research',
    worker_auto_enabled: false, // separate research tool: no candidate-worker activation
  };
}

export function parseBrowserOutput(text) {
  const trimmed = text.trim();
  const data = JSON.parse(trimmed);
  if (!data || typeof data !== 'object' || typeof data.id !== 'string' || !['completed','paused','failed','stopped'].includes(data.status)) {
    throw Error('Browser tool produced an invalid research result');
  }
  if (!Array.isArray(data.visitedUrls) || !Array.isArray(data.evidence)) throw Error('Browser tool result missing provenance');
  return data;
}

export async function researchWithBrowser(instruction, {
  browserHome = process.env.SCOUT_BROWSER_HOME || DEFAULT_BROWSER_HOME,
  maxSteps = 6, timeoutMs = 240000, spawnImpl = spawn
} = {}) {
  if (typeof instruction !== 'string' || instruction.trim().length < 5 || instruction.length > 3000) {
    throw Error('Supply a specific research question (5–3000 characters)');
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 12) throw Error('Browser step limit must be 1–12');
  const status = browserToolStatus({browserHome});
  if (status.status !== 'READY') throw Error('Scout visual browser is not ready: ' + JSON.stringify(status.checks));
  // The browser is an independent investigation tool, not an input to canonical mapping
  // or a trigger for Scout's heavy-work scheduling or source approvals.
  const childArgs = [path.join(browserHome, 'scripts','scout-investigate.ts'), instruction.trim()];
  const childEnv = {
    ...process.env, NODE_ENV: 'development', SCOUT_BROWSER_AI: 'codex',
    SCOUT_BROWSER_USE_VISION: 'true', SCOUT_HEADLESS: 'true',
    SCOUT_CHROME_EXECUTABLE: process.env.SCOUT_CHROME_EXECUTABLE || DEFAULT_CHROME,
    SCOUT_BROWSER_MAX_STEPS: String(maxSteps)
  };
  return new Promise((resolve, reject) => {
    const child = spawnImpl(path.join(browserHome, 'node_modules/.bin/tsx'), childArgs, {
      cwd: browserHome, env: childEnv, stdio: ['ignore','pipe','pipe']
    });
    let out = '', err = '', settled = false;
    const fail = e => {if (!settled) {settled = true;clearTimeout(timer);reject(e);}};
    const timer = setTimeout(() => {child.kill('SIGKILL');fail(Error('Scout browser exceeded time budget'))}, timeoutMs);
    child.stdout?.on('data', data => {out += String(data);if (out.length>200000) {child.kill('SIGKILL');fail(Error('Browser result too large'))}});
    child.stderr?.on('data', data => {err = (err + String(data)).slice(-3000)});
    child.on('error', fail);
    child.on('close', code => {
      if(settled)return;
      if(code !== 0) return fail(Error('Scout browser failed (' + code + '): ' + (err||out).slice(-500)));
      try {const result=parseBrowserOutput(out);if(result.status!=='completed')return fail(Error('Scout browser did not complete: '+(result.error||result.status))); settled=true;clearTimeout(timer);resolve(result)}
      catch(error){fail(error)}
    });
  });
}
