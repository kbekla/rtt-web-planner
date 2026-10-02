#!/usr/bin/env node
// Record scripts/pipeline progress for mapwatch.
//   pipeline-state.mjs <region> start | step <name> | build-id <id> | done | fail <step> <exit-code>
// State: $FACTORY_DIR/state/pipeline-<region>.json. A failure also copies the
// state and the pipeline log tail to $FACTORY_DIR/logs/failures/.
import fs from 'node:fs';
import path from 'node:path';
import { FACTORY } from './common.mjs';

const [region, action, a, b] = process.argv.slice(2);
const file = path.join(FACTORY, 'state', `pipeline-${region}.json`);
const now = new Date().toISOString();
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const logFile = process.env.RTT_PIPELINE_LOG ?? prev.log ?? null;
const tail = (n = 80) => (logFile && fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-n - 1).join('\n') : '');

let st;
switch (action) {
  case 'start':
    // The pipeline shell is our parent; mapwatch checks it is still alive.
    st = { region, state: 'running', step: null, steps: [], build_id: null, pid: process.ppid,
      started_at: now, log: logFile };
    break;
  case 'step':
    st = { ...prev, step: a, steps: [...(prev.steps ?? []), { step: a, at: now }] };
    break;
  case 'build-id':
    st = { ...prev, build_id: a };
    break;
  case 'done':
    st = { ...prev, state: 'succeeded', step: 'done', finished_at: now };
    break;
  case 'fail':
    st = { ...prev, state: 'failed', step: a, exit_code: Number(b), finished_at: now, log_tail: tail() };
    break;
  default:
    console.error('usage: pipeline-state.mjs <region> start|step <name>|build-id <id>|done|fail <step> <rc>');
    process.exit(2);
}
st.updated_at = now;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(st, null, 2) + '\n');
if (action === 'fail') {
  const dest = path.join(FACTORY, 'logs', 'failures', `${now.replace(/[:.]/g, '-')}-${region}-pipeline-${a || 'unknown'}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'status.json'), JSON.stringify(st, null, 2) + '\n');
  if (logFile && fs.existsSync(logFile)) fs.copyFileSync(logFile, path.join(dest, 'pipeline.log'));
}
