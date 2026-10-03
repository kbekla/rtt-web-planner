#!/usr/bin/env node
// Migrate the canonical (legacy) RT&T app map into the Phase 3 contract, into the
// PRIVATE master only. Nothing is published, registered or built.
//
//   node scripts/rtt/migrate-canonical.mjs --input <map.geojson> --readiness <readiness-v2-features.jsonl>
//        --reconstruction <reconstruction-features.jsonl> [--captured YYYY-MM-DD] [--out <dir>]
//
// Rules (all deterministic; geometry is copied byte for byte):
//   rtt_id      opaque: "rtt-trail-" + HMAC-SHA256(private salt, legacy key)[:12]. The legacy
//               key is the record's existing source feature id, or its upstream fragment id
//               when it has none. Legacy keys can name sources, so they never become public;
//               the crosswalk is private. The salt lives in $FACTORY_DIR/private/rtt/id-salt.
//   name        the existing name, except the placeholder "Verified lane", which is omitted
//   kind        the existing legal classification, exact string (absent if none)
//   status      (published as `access`) the existing closure override if present, else the
//               existing closure status, exact string (absent if none). All other access
//               attributes are kept unchanged in the private sidecar.
//   provenance  the RT&T verified master itself: source rtt-verified-master, method
//               rtt_verified, captured = the canonical map's generation date, osm_derived false
//               (owner's RTT_VERIFIED classification). Research history and the historical
//               audit indicators stay in the private sidecar only.
// Outputs ($FACTORY_DIR/private/rtt/master/<captured>-<input sha12>/):
//   master.geojson         contract features (validated by scripts/rtt/validate.mjs)
//   master-private.jsonl   per rtt_id: legacy key, exact original properties, private_audit,
//                          research_inputs, open issues
//   crosswalk.jsonl        legacy key -> rtt_id
//   candidate-sources.yaml registry candidate for rtt-verified-master, approved: false
//   migration.json         inputs, rules, counts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FACTORY, sha256File } from '../lib/common.mjs';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const input = opt('--input');
const readinessFile = opt('--readiness');
const reconFile = opt('--reconstruction');
if (!input || !readinessFile || !reconFile) {
  console.error('usage: migrate-canonical.mjs --input <map.geojson> --readiness <jsonl> --reconstruction <jsonl> [--captured YYYY-MM-DD] [--out dir]');
  process.exit(2);
}
export const PLACEHOLDER_NAMES = ['Verified lane'];

const src = JSON.parse(fs.readFileSync(input, 'utf8'));
const captured = opt('--captured') ?? String(src.metadata?.generated_at ?? '').slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(captured)) throw new Error('cannot determine the capture date; pass --captured');
const jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
const readiness = jsonl(readinessFile);
const recon = jsonl(reconFile);
const F = src.features;
if (readiness.length !== F.length || recon.length !== F.length) throw new Error('readiness/reconstruction rows must match the input feature count');

// Private, persistent salt: same legacy key -> same rtt_id on every run.
const saltFile = path.join(FACTORY, 'private', 'rtt', 'id-salt');
fs.mkdirSync(path.dirname(saltFile), { recursive: true });
if (!fs.existsSync(saltFile)) fs.writeFileSync(saltFile, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
const salt = fs.readFileSync(saltFile, 'utf8').trim();
const rttId = (key) => `rtt-trail-${crypto.createHmac('sha256', salt).update(key).digest('hex').slice(0, 12)}`;

const inputSha = sha256File(input);
const outDir = path.resolve(opt('--out') ?? path.join(FACTORY, 'private', 'rtt', 'master', `${captured}-${inputSha.slice(0, 12)}`));
fs.mkdirSync(outDir, { recursive: true });

const features = [];
const sidecar = [];
const crosswalk = [];
const seen = new Map();
F.forEach((f, i) => {
  const p = f.properties ?? {};
  const r = readiness[i];
  const rec = recon[i];
  if (r.i !== i || rec.i !== i) throw new Error(`row order mismatch at ${i}`);
  const legacyKey = p.rtt_source_feature_id ? `source:${p.rtt_source_feature_id}` : rec.fragment_id ? `fragment:${rec.fragment_id}` : null;
  if (!legacyKey) throw new Error(`feature ${i} has no legacy key`);
  const id = rttId(legacyKey);
  if (seen.has(id)) throw new Error(`rtt_id collision: ${id} for features ${seen.get(id)} and ${i}`);
  seen.set(id, i);
  const props = { rtt_id: id };
  const name = p.track_name ?? p.name;
  if (name && !PLACEHOLDER_NAMES.includes(name)) props.name = name;
  if (p.legal_classification) props.kind = p.legal_classification;
  const access = p.rtt_closure_override_status ?? p.closure_status;
  if (access) props.status = access;
  props.version = 1;
  props.provenance = { source: 'rtt-verified-master', method: 'rtt_verified', captured, osm_derived: false,
    notes: 'Canonical RT&T map migrated into the Phase 3 contract; history in the private master sidecar.' };
  features.push({ type: 'Feature', properties: props, geometry: f.geometry });
  sidecar.push({ rtt_id: id, feature_index: i, legacy_key: legacyKey, legacy_properties: p,
    research_inputs: r.research_inputs, private_audit: r.private_audit, open_issues: r.open_issues,
    migration_integrity_clean: r.migration_integrity_clean });
  crosswalk.push({ legacy_key: legacyKey, rtt_id: id });
});

fs.writeFileSync(path.join(outDir, 'master.geojson'), JSON.stringify({ type: 'FeatureCollection', name: 'rtt-verified-master', features }) + '\n');
fs.writeFileSync(path.join(outDir, 'master-private.jsonl'), sidecar.map((x) => JSON.stringify(x)).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'crosswalk.jsonl'), crosswalk.map((x) => JSON.stringify(x)).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'candidate-sources.yaml'), `# CANDIDATE ONLY: not registered. Approval is the owner's decision.
sources:
  rtt-verified-master:
    name: RT&T verified master (canonical app map, migrated ${new Date().toISOString().slice(0, 10)})
    licence: RT&T proprietary
    attribution: '© RT&T'
    methods: [rtt_verified]
    osm_derived: false
    approved: false
`);
const manifest = { migrated_at: new Date().toISOString(), input: { file: path.resolve(input), sha256: inputSha, features: F.length },
  readiness: { file: path.resolve(readinessFile), sha256: sha256File(readinessFile) },
  reconstruction: { file: path.resolve(reconFile), sha256: sha256File(reconFile) },
  salt_file: saltFile, captured, placeholder_names: PLACEHOLDER_NAMES, output: { features: features.length } };
fs.writeFileSync(path.join(outDir, 'migration.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`migrated ${features.length} features -> ${outDir}`);
console.log(outDir);
