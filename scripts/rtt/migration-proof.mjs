#!/usr/bin/env node
// Independent proof for a canonical-map migration (scripts/rtt/migrate-canonical.mjs).
// Re-reads the original input and every output and recomputes each claim from scratch.
//   node scripts/rtt/migration-proof.mjs --input <map.geojson> --master <private master dir>
// Writes <master>/proof.json and <master>/MIGRATION-PROOF.md. Private; nothing is published.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../lib/common.mjs';
import { PUBLIC_TILE_FIELDS, checkTileProperties } from './publish-check.mjs';
import { loadContract, validate } from './validate.mjs';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const input = opt('--input');
const dir = opt('--master');
const IN = JSON.parse(fs.readFileSync(input, 'utf8')).features;
const OUT = JSON.parse(fs.readFileSync(path.join(dir, 'master.geojson'), 'utf8')).features;
const jsonl = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map(JSON.parse);
const SIDE = jsonl('master-private.jsonl');
const XW = jsonl('crosswalk.jsonl');
const mig = JSON.parse(fs.readFileSync(path.join(dir, 'migration.json'), 'utf8'));
const READY = fs.readFileSync(mig.readiness.file, 'utf8').trim().split('\n').map(JSON.parse);
const P = {};
const eq = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

// 1. counts
P.input_count = IN.length;
P.output_count = OUT.length;
P.sidecar_count = SIDE.length;

// 2. identity
const ids = OUT.map((f) => f.properties.rtt_id);
P.rtt_ids_unique = new Set(ids).size;
const legacyOf = (p, i) => (p.rtt_source_feature_id ? `source:${p.rtt_source_feature_id}` : SIDE[i].legacy_key);
P.identity_preserved = IN.filter((f, i) => SIDE[i].feature_index === i && SIDE[i].rtt_id === ids[i]
  && XW.find((x) => x.rtt_id === ids[i])?.legacy_key === legacyOf(f.properties, i)).length;
P.legacy_source_ids_in_crosswalk = IN.filter((f) => f.properties.rtt_source_feature_id).length;
P.legacy_fragment_keys_in_crosswalk = XW.filter((x) => x.legacy_key.startsWith('fragment:')).length;
P.crosswalk_one_to_one = new Set(XW.map((x) => x.legacy_key)).size === XW.length && new Set(XW.map((x) => x.rtt_id)).size === XW.length;

// 3. geometry
P.geometry_exact_match = IN.filter((f, i) => eq(f.geometry, OUT[i].geometry)).length;

// 4. classification / access
P.kind_changes = IN.filter((f, i) => (f.properties.legal_classification ?? null) !== (OUT[i].properties.kind ?? null)).length;
P.access_value_changes = IN.filter((f, i) => ((f.properties.rtt_closure_override_status ?? f.properties.closure_status) ?? null) !== (OUT[i].properties.status ?? null)).length;
P.legacy_properties_preserved_exactly = IN.filter((f, i) => eq(f.properties, SIDE[i].legacy_properties)).length;
const tally = (arr) => arr.reduce((m, v) => { const k = v ?? '(none)'; m[k] = (m[k] ?? 0) + 1; return m; }, {});
P.kind_in = tally(IN.map((f) => f.properties.legal_classification));
P.kind_out = tally(OUT.map((f) => f.properties.kind));
P.access_out = tally(OUT.map((f) => f.properties.status));

// 5. names
const nameIn = (f) => f.properties.track_name ?? f.properties.name ?? null;
const changed = IN.map((f, i) => [nameIn(f), OUT[i].properties.name ?? null]).filter(([a, b]) => a !== b);
P.names_changed = changed.length;
P.names_changed_only_by_placeholder_rule = changed.every(([a, b]) => mig.placeholder_names.includes(a) && b === null);
P.genuine_names_in = IN.filter((f) => nameIn(f) && !mig.placeholder_names.includes(nameIn(f))).length;
P.genuine_names_preserved = IN.filter((f, i) => nameIn(f) && !mig.placeholder_names.includes(nameIn(f)) && OUT[i].properties.name === nameIn(f)).length;

// 6. private audit: in the private master sidecar, absent from the contract record and the public projection
P.private_audit_in_sidecar = SIDE.filter((s, i) => s.private_audit && eq(s.private_audit, READY[i].private_audit)).length;
P.no_upstream_record_indicator = SIDE.filter((s) => s.private_audit && s.private_audit.upstream_record === null).length;
const AUDIT_KEYS = ['private_audit', 'research_inputs', 'legacy_properties', 'legacy_key', 'open_issues', 'base_class', 'output_class',
  'review_status', 'rtt_source_feature_id', 'restriction_reasons', 'track_name', 'legal_classification', 'rtt_tet'];
P.master_records_with_audit_keys = OUT.filter((f) => AUDIT_KEYS.some((k) => k in f.properties || k in (f.properties.provenance ?? {}))).length;
const project = (p) => Object.fromEntries(Object.entries({ rtt_id: p.rtt_id, name: p.name, kind: p.kind, access: p.status }).filter(([, v]) => v !== undefined));
const pub = OUT.map((f) => project(f.properties));
P.public_projection_whitelist_violations = pub.reduce((n, p, i) => n + checkTileProperties(p, `f${i}`).length, 0);
P.public_projection_fields = [...new Set(pub.flatMap((p) => Object.keys(p)))].sort();
P.public_whitelist = PUBLIC_TILE_FIELDS;
P.public_contains_legacy_ids = pub.filter((p) => /source:|fragment:|council|grm|trailvidz|tet-/i.test(JSON.stringify(p))).length;

// 7. open issues: unchanged from the readiness report
const issuesNow = SIDE.filter((s) => s.open_issues.length).map((s) => ({ legacy_key: s.legacy_key, rtt_id: s.rtt_id, issues: s.open_issues }));
const issuesBefore = READY.filter((r) => r.open_issues.length).map((r) => canonicalJson(r.open_issues));
P.open_issues = issuesNow;
P.open_issues_unchanged = issuesNow.length === issuesBefore.length && issuesNow.every((x, k) => canonicalJson(x.issues) === issuesBefore[k]);

// 8. validation through the existing gate
const fc = JSON.parse(fs.readFileSync(path.join(dir, 'master.geojson'), 'utf8'));
const run = (registry) => {
  process.env.RTT_PRIVATE_SOURCES = registry;
  const r = validate(fc, loadContract());
  const reasons = tally(r.quarantined.flatMap((q) => q.reasons));
  return { accepted: r.accepted.length, quarantined: r.quarantined.length, errors: r.errors.length, geometry_reviews: r.reviews.length,
    quarantine_reasons: reasons, reviews: r.reviews };
};
P.validation_as_is = run(path.join(dir, 'candidate-sources.yaml'));
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-proof-')), 'approved.yaml');
fs.writeFileSync(tmp, fs.readFileSync(path.join(dir, 'candidate-sources.yaml'), 'utf8').replace('approved: false', 'approved: true\n    approved_by: SIMULATION ONLY (migration proof)'));
P.validation_if_approved_SIMULATION = run(tmp);
fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
delete process.env.RTT_PRIVATE_SOURCES;

fs.writeFileSync(path.join(dir, 'proof.json'), JSON.stringify(P, null, 2) + '\n');
const ok = (b) => (b ? 'PASS' : 'FAIL');
const lines = [
  ['input count', P.input_count, ok(P.input_count === 14315)],
  ['output count', P.output_count, ok(P.output_count === P.input_count)],
  ['identity preserved (legacy key -> rtt_id, 1:1)', `${P.identity_preserved}/${P.input_count}`, ok(P.identity_preserved === P.input_count && P.crosswalk_one_to_one)],
  ['rtt_id unique', `${P.rtt_ids_unique}/${P.output_count}`, ok(P.rtt_ids_unique === P.output_count)],
  ['geometry exact match', `${P.geometry_exact_match}/${P.input_count}`, ok(P.geometry_exact_match === P.input_count)],
  ['legal classification (kind) changes', P.kind_changes, ok(P.kind_changes === 0)],
  ['access value changes', P.access_value_changes, ok(P.access_value_changes === 0)],
  ['all original attributes preserved exactly (private master)', `${P.legacy_properties_preserved_exactly}/${P.input_count}`, ok(P.legacy_properties_preserved_exactly === P.input_count)],
  ['names changed', `${P.names_changed} (placeholder rule only: ${P.names_changed_only_by_placeholder_rule}); genuine names ${P.genuine_names_preserved}/${P.genuine_names_in} preserved`, ok(P.names_changed_only_by_placeholder_rule && P.genuine_names_preserved === P.genuine_names_in)],
  ['private audit in private master', `${P.private_audit_in_sidecar}/${P.input_count}`, ok(P.private_audit_in_sidecar === P.input_count)],
  ['no-upstream-record indicators', P.no_upstream_record_indicator, ok(P.no_upstream_record_indicator === 37)],
  ['audit/legacy keys in contract records', P.master_records_with_audit_keys, ok(P.master_records_with_audit_keys === 0)],
  ['public projection whitelist violations', P.public_projection_whitelist_violations, ok(P.public_projection_whitelist_violations === 0)],
  ['public projection fields', P.public_projection_fields.join(', '), ok(P.public_projection_fields.every((k) => PUBLIC_TILE_FIELDS.includes(k)))],
  ['legacy/source ids in public projection', P.public_contains_legacy_ids, ok(P.public_contains_legacy_ids === 0)],
  ['open issues unchanged', `${P.open_issues.length}`, ok(P.open_issues_unchanged && P.open_issues.length === 11)],
];
const md = [`# Migration proof`, '', `Input: ${path.resolve(input)} (sha256 ${mig.input.sha256})`, `Master: ${path.resolve(dir)}`, '',
  '| Check | Result | |', '|---|---|---|', ...lines.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`), '',
  `Validation as-is (candidate source not approved): accepted ${P.validation_as_is.accepted}, quarantined ${P.validation_as_is.quarantined}, errors ${P.validation_as_is.errors}, geometry reviews ${P.validation_as_is.geometry_reviews}; quarantine reasons ${JSON.stringify(P.validation_as_is.quarantine_reasons)}`,
  `Validation if approved (SIMULATION, throwaway registry copy): accepted ${P.validation_if_approved_SIMULATION.accepted}, quarantined ${P.validation_if_approved_SIMULATION.quarantined}, errors ${P.validation_if_approved_SIMULATION.errors}, geometry reviews ${P.validation_if_approved_SIMULATION.geometry_reviews}`,
  '', '## Open issues (11)', '', '| rtt_id | legacy key | issue |', '|---|---|---|',
  ...P.open_issues.map((x) => `| ${x.rtt_id} | ${x.legacy_key} | ${x.issues.join('; ')} |`), '',
  `kind in: ${JSON.stringify(P.kind_in)}`, `kind out: ${JSON.stringify(P.kind_out)}`, `access out: ${JSON.stringify(P.access_out)}`];
fs.writeFileSync(path.join(dir, 'MIGRATION-PROOF.md'), md.join('\n') + '\n');
console.log(lines.map(([a, b, c]) => `${c}  ${a}: ${b}`).join('\n'));
console.log(md.slice(md.findIndex((l) => l.startsWith('Validation as-is')), md.findIndex((l) => l.startsWith('## Open issues'))).join('\n'));
