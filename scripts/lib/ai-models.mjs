#!/usr/bin/env node
// Pull the models pinned in config/ai.lock and verify their manifest digests.
//   node scripts/lib/ai-models.mjs pull | verify
// Requires rtt-ollama.service to be running.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { FACTORY, REPO, readTable } from './common.mjs';

const HOST = 'http://127.0.0.1:11434';
const pinned = readTable(path.join(REPO, 'config', 'ai.lock')).filter(([k]) => k === 'model').map(([, tag, digest]) => ({ tag, digest }));
const installed = async () => ((await (await fetch(`${HOST}/api/tags`)).json()).models ?? []);
const mode = process.argv[2] ?? 'verify';
let bad = 0;
for (const { tag, digest } of pinned) {
  let m = (await installed()).find((x) => x.name === tag);
  if (!m && mode === 'pull') {
    const r = spawnSync(path.join(FACTORY, 'tools', 'ollama', 'bin', 'ollama'), ['pull', tag], { stdio: 'inherit', env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' } });
    if (r.status !== 0) { console.error(`pull ${tag} failed`); bad++; continue; }
    m = (await installed()).find((x) => x.name === tag);
  }
  if (!m) { console.error(`missing ${tag}`); bad++; continue; }
  if (m.digest !== digest) { console.error(`FATAL: ${tag} digest ${m.digest} != pinned ${digest}`); bad++; continue; }
  console.log(`ok   ${tag} ${digest.slice(0, 12)}`);
}
process.exit(bad ? 1 : 0);
