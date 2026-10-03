#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScoutStore } from './core.mjs';
import { readHostSnapshot } from './resources.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const factory = process.env.FACTORY_DIR || path.join(os.homedir(), 'rtt-map-factory');
const store = new ScoutStore(factory);
const [cmd, ...args] = process.argv.slice(2);
const usage = 'scoutctl status|host|list [pending|running|held|done|reviews]|enqueue-fixture <name>|show <candidate-id>';
if (cmd === 'status') console.log(JSON.stringify(store.status(), null, 2));
else if (cmd === 'host') console.log(JSON.stringify(readHostSnapshot(), null, 2));
else if (cmd === 'list') {
  try { console.log(JSON.stringify(store.list(args[0] || 'reviews'), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 2; }
}
else if (cmd === 'show') {
  const file = path.join(factory, 'scout', 'candidates', `${args[0]}.json`);
  if (!fs.existsSync(file)) { console.error(`candidate not found: ${args[0]}`); process.exitCode = 1; }
  else console.log(fs.readFileSync(file, 'utf8'));
} else if (cmd === 'enqueue-fixture') {
  const name = args[0];
  if (!name || !/^[a-z0-9-]+$/.test(name)) { console.error(usage); process.exitCode = 2; }
  else {
    const input = path.join(repo, 'tests/fixtures/scout', `${name}.json`);
    const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
    const job = store.enqueue('synthetic-fixture', raw);
    console.log(job.job_id);
  }
} else { console.error(usage); process.exitCode = 2; }
