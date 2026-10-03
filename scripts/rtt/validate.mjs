#!/usr/bin/env node
// Validate RT&T trail features against schema/rtt-trails.schema.json and the
// provenance rules in config/rtt/sources.yaml.
//
//   errors       hard failures: the whole input is rejected (bad JSON/schema,
//                duplicate rtt_id, invalid geometry)
//   quarantined  valid features that must NOT enter the proprietary layer:
//                OSM-derived, unknown/unapproved source, or a method the source
//                doesn't allow. They are reported for licensing review, never
//                dropped silently.
//   accepted     everything else
//
// usage: scripts/rtt/validate.mjs <features.geojson> [--report out.json]
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { FACTORY, REPO } from '../lib/common.mjs';

/**
 * The contract: schema + source registry. The repo registry
 * (config/rtt/sources.yaml) holds synthetic test sources only. Real sources live
 * in the private, local registry ($FACTORY_DIR/private/rtt/sources.yaml, or
 * RTT_PRIVATE_SOURCES), which is never committed or published.
 */
export function privateSourcesFile() {
  return process.env.RTT_PRIVATE_SOURCES || path.join(FACTORY, 'private', 'rtt', 'sources.yaml');
}

export function loadContract(repo = REPO) {
  const sources = { ...(yaml.load(fs.readFileSync(path.join(repo, 'config', 'rtt', 'sources.yaml'), 'utf8')).sources ?? {}) };
  const priv = privateSourcesFile();
  if (fs.existsSync(priv)) {
    for (const [id, s] of Object.entries(yaml.load(fs.readFileSync(priv, 'utf8'))?.sources ?? {})) {
      if (sources[id]) throw new Error(`source '${id}' is defined in both the repo and the private registry`);
      sources[id] = { ...s, private: true };
    }
  }
  return {
    schema: JSON.parse(fs.readFileSync(path.join(repo, 'schema', 'rtt-trails.schema.json'), 'utf8')),
    sources,
  };
}

// Equirectangular length in metres; good enough to reject zero-length lines.
function lineLengthM(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1];
    const [x2, y2] = coords[i];
    const k = Math.cos(((y1 + y2) / 2) * Math.PI / 180);
    m += Math.hypot((x2 - x1) * k, y2 - y1) * 111_320;
  }
  return m;
}

function geometryErrors(g) {
  if (!g || typeof g !== 'object') return ['missing geometry'];
  const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : null;
  if (!lines) return [`geometry type must be LineString or MultiLineString, got ${g.type}`];
  if (!Array.isArray(lines) || lines.length === 0) return ['geometry has no lines'];
  const errs = [];
  lines.forEach((line, i) => {
    if (!Array.isArray(line) || line.length < 2) { errs.push(`line ${i} has fewer than 2 points`); return; }
    for (const p of line) {
      if (!Array.isArray(p) || p.length < 2 || !p.slice(0, 2).every(Number.isFinite)) { errs.push(`line ${i} has a non-numeric coordinate`); return; }
      if (p[0] < -180 || p[0] > 180 || p[1] < -85.05112878 || p[1] > 85.05112878) { errs.push(`line ${i} coordinate ${p} outside WGS84/Web Mercator range`); return; }
    }
    if (lineLengthM(line) < 1) errs.push(`line ${i} is shorter than 1 m`);
  });
  return errs;
}

function propertyErrors(props, schema) {
  const spec = schema.properties.properties;
  const errs = [];
  if (!props || typeof props !== 'object') return ['missing properties'];
  for (const k of spec.required) if (props[k] === undefined) errs.push(`missing '${k}'`);
  for (const [k, v] of Object.entries(props)) {
    const f = spec.properties[k];
    if (!f) { errs.push(`unknown property '${k}' (schema allows: ${Object.keys(spec.properties).join(', ')})`); continue; }
    if (f.enum && !f.enum.includes(v)) errs.push(`${k}='${v}' not in ${f.enum.join('|')}`);
    if (f.pattern && !(typeof v === 'string' && new RegExp(f.pattern).test(v))) errs.push(`${k}='${v}' does not match ${f.pattern}`);
    if (f.type === 'string' && typeof v !== 'string') errs.push(`${k} must be a string`);
    if (f.maxLength && typeof v === 'string' && v.length > f.maxLength) errs.push(`${k} longer than ${f.maxLength}`);
    if (f.type === 'integer' && !(Number.isInteger(v) && v >= (f.minimum ?? -Infinity))) errs.push(`${k} must be an integer >= ${f.minimum}`);
  }
  const p = props.provenance;
  if (p && typeof p === 'object') {
    const ps = spec.properties.provenance;
    for (const k of ps.required) if (p[k] === undefined) errs.push(`missing 'provenance.${k}'`);
    for (const [k, v] of Object.entries(p)) {
      const f = ps.properties[k];
      if (!f) { errs.push(`unknown property 'provenance.${k}'`); continue; }
      if (f.enum && !f.enum.includes(v)) errs.push(`provenance.${k}='${v}' not in ${f.enum.join('|')}`);
      if (f.pattern && !(typeof v === 'string' && new RegExp(f.pattern).test(v))) errs.push(`provenance.${k}='${v}' does not match ${f.pattern}`);
      if (f.type === 'boolean' && typeof v !== 'boolean') errs.push(`provenance.${k} must be true or false`);
    }
  } else if (p !== undefined) {
    errs.push('provenance must be an object');
  }
  return errs;
}

/** Why a valid feature may not enter the proprietary layer ([] = it may). */
function provenanceIssues(p, sources) {
  const src = sources[p.source];
  const issues = [];
  if (p.osm_derived === true) issues.push('osm-derived: traced/snapped/copied from OpenStreetMap (ODbL); licensing review required');
  if (!src) return [...issues, `unknown source '${p.source}' (not in config/rtt/sources.yaml)`];
  if (src.osm_derived) issues.push(`source '${p.source}' is OSM-derived`);
  if (src.approved !== true) issues.push(`source '${p.source}' is not approved`);
  if (!(src.methods ?? []).includes(p.method)) issues.push(`method '${p.method}' not allowed for source '${p.source}'`);
  return issues;
}

export function validate(fc, contract = loadContract()) {
  const { schema, sources } = contract;
  const out = { schema_version: schema.schema_version, errors: [], accepted: [], quarantined: [] };
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    out.errors.push('input is not a GeoJSON FeatureCollection');
    return out;
  }
  const seen = new Map();
  fc.features.forEach((f, i) => {
    const id = f?.properties?.rtt_id;
    const where = `feature ${i}${id ? ` (${id})` : ''}`;
    const errs = [
      ...(f?.type === 'Feature' ? [] : ['not a GeoJSON Feature']),
      ...geometryErrors(f?.geometry),
      ...propertyErrors(f?.properties, schema),
    ];
    if (id) {
      if (seen.has(id)) errs.push(`duplicate rtt_id (also feature ${seen.get(id)})`);
      else seen.set(id, i);
    }
    if (errs.length) { out.errors.push(...errs.map((e) => `${where}: ${e}`)); return; }
    const issues = provenanceIssues(f.properties.provenance, sources);
    if (issues.length) out.quarantined.push({ rtt_id: id, reasons: issues, feature: f });
    else out.accepted.push(f);
  });
  return out;
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const file = process.argv[2];
  if (!file) { console.error('usage: validate.mjs <features.geojson> [--report out.json]'); process.exit(2); }
  let fc;
  try { fc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(1); }
  const r = validate(fc);
  const ri = process.argv.indexOf('--report');
  if (ri > 0) fs.writeFileSync(process.argv[ri + 1], JSON.stringify({ ...r, accepted: r.accepted.map((f) => f.properties.rtt_id), quarantined: r.quarantined.map(({ rtt_id, reasons }) => ({ rtt_id, reasons })) }, null, 2) + '\n');
  console.log(`accepted ${r.accepted.length}, quarantined ${r.quarantined.length}, errors ${r.errors.length}`);
  for (const q of r.quarantined) console.log(`QUARANTINED ${q.rtt_id}: ${q.reasons.join('; ')}`);
  for (const e of r.errors) console.log(`ERROR ${e}`);
  process.exit(r.errors.length ? 1 : 0);
}
