import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CATALOG = fileURLToPath(new URL('../../config/scout/europe-source-catalog.json', import.meta.url));
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATALOG_ONLY = new Set(['pt-snig-transport','it-rndt-transport','bg-inspire-transport','ro-national-geoportal-transport',
  'hu-lechner-transport','gr-national-geodata-transport','lv-geolatvija-transport','li-llv-transport','me-geoportal-transport',
  'mk-ossp-transport','md-national-geoportal-transport','ie-geohive-roads','gb-sct-authoritative-sources-pending']);
const RESTRICTION_LEADS = new Set(['no-nvdb-vegkart','se-nvdb','fi-digiroad','is-umferdin-conditions','ee-road-register',
  'be-vlg-wegenregister','dk-dataforsyningen-road','cy-dls-inspire-roads','tr-kgm-road-information']);
const LIVE_CONDITION_LEADS = new Set(['is-umferdin-conditions','tr-kgm-road-information']);
const COUNTRY_NAMES = Object.freeze({NO:'Norway',SE:'Sweden',FI:'Finland',IS:'Iceland',FR:'France',ES:'Spain',NL:'Netherlands',DE:'Germany',CH:'Switzerland',BE:'Belgium',AT:'Austria',PL:'Poland',CZ:'Czechia',EE:'Estonia',LU:'Luxembourg',HR:'Croatia',SI:'Slovenia',LT:'Lithuania',LV:'Latvia',DK:'Denmark',IE:'Ireland',PT:'Portugal',IT:'Italy',CY:'Cyprus',BG:'Bulgaria',RO:'Romania',SK:'Slovakia',HU:'Hungary',GR:'Greece',MT:'Malta',LI:'Liechtenstein',AL:'Albania',XK:'Kosovo',ME:'Montenegro',BA:'Bosnia and Herzegovina',RS:'Serbia',MK:'North Macedonia',MD:'Moldova',UA:'Ukraine',AD:'Andorra',AM:'Armenia',AZ:'Azerbaijan',BY:'Belarus',GE:'Georgia',MC:'Monaco',RU:'Russia',SM:'San Marino',TR:'Turkey',VA:'Vatican City',FO:'Faroe Islands','GB-NIR':'Northern Ireland',GG:'Guernsey',GI:'Gibraltar',JE:'Jersey',KZ:'Kazakhstan',AX:'Åland Islands'});

/** Load the owner-supplied Europe leads without turning them into active sources. */
export function loadEuropeSourceCatalog(file = DEFAULT_CATALOG) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  validateEuropeSourceCatalog(parsed);
  return parsed;
}

export function validateEuropeSourceCatalog(catalog) {
  if (!catalog || catalog.catalog_id !== 'europe-authoritative-transport-leads' || catalog.catalog_version !== 1 || !Array.isArray(catalog.source_candidates)) {
    throw new Error('unsupported Europe source catalogue');
  }
  const excluded = new Set(catalog.scope?.excluded_jurisdictions ?? []);
  const ids = new Set();
  for (const source of catalog.source_candidates) {
    if (!source || !ID.test(source.source_id ?? '') || ids.has(source.source_id)) throw new Error('Europe source catalogue has an invalid or duplicate source ID');
    ids.add(source.source_id);
    if (!/^[A-Z]{2}$/.test(source.country_code ?? '') || typeof source.jurisdiction_id !== 'string' || !source.jurisdiction_id) {
      throw new Error(`Europe source '${source.source_id}' has incomplete jurisdiction identity`);
    }
    if (excluded.has(source.jurisdiction_id) || excluded.has(source.admin1_code)) {
      throw new Error(`Europe source '${source.source_id}' falls in an explicitly excluded jurisdiction`);
    }
    if (source.automation_enabled === true || source.reuse_verified === true || source.download_url) {
      throw new Error(`Europe source '${source.source_id}' cannot be activated from an unverified lead`);
    }
  }
  if (catalog.scope?.separate_jurisdictions?.includes('GB-SCT') !== true || catalog.activation_policy?.automatic_retrieval !== false ||
      catalog.activation_policy?.private_processing !== false || catalog.activation_policy?.redistribution !== false || catalog.activation_policy?.derived_public_use !== false) {
    throw new Error('Europe source catalogue activation and jurisdiction safeguards are incomplete');
  }
  return { source_count: ids.size, excluded_jurisdictions: [...excluded].sort(), separate_jurisdictions: [...catalog.scope.separate_jurisdictions] };
}

/** Return source leads scoped to a country; this does not approve or acquire them. */
export function listEuropeSourceCandidates({ countryCode = null, catalog = loadEuropeSourceCatalog() } = {}) {
  validateEuropeSourceCatalog(catalog);
  const code = countryCode ? String(countryCode).toUpperCase() : null;
  return catalog.source_candidates.filter(source => !code || source.country_code === code).map(source => ({
    ...source,
    assessment_state: 'REVIEW_REQUIRED',
    authority_state: 'UNVERIFIED',
    roles: classifyEuropeSourceRoles(source),
    licence_state: /CC BY|CC0|ODbL|Open Licence|open data|commercial open/i.test(source.reported_terms ?? '') ? 'REPORTED_UNVERIFIED' : 'UNKNOWN',
    attribution_state: /attribution|CC BY|ODbL/i.test(source.reported_terms ?? '') ? 'REPORTED_REQUIREMENT_UNVERIFIED' : 'UNKNOWN',
    automation_enabled: false,
    automation_state: 'DISABLED_REVIEW_REQUIRED',
    reuse_verified: false,
    permissions: { private_processing: false, redistribution: false, derived_public_use: false, legal_evidence: false },
    missing_evidence: missingEvidenceFor(source),
  }));
}

export function classifyEuropeSourceRoles(source) {
  const catalogueOnly = CATALOG_ONLY.has(source.source_id);
  const network = !catalogueOnly;
  return {
    discovery_physical_network: catalogueOnly ? 'CATALOGUE_ONLY' : 'POTENTIAL_UNVERIFIED',
    legal_motorcycle_access: 'NOT_ESTABLISHED',
    restrictions_closures: RESTRICTION_LEADS.has(source.source_id) ? 'POTENTIAL_UNVERIFIED' : 'NOT_IDENTIFIED',
    routing_geometry: network ? 'POTENTIAL_GEOMETRY_NOT_ROUTING_VALIDATED' : 'NOT_IDENTIFIED',
    live_conditions: LIVE_CONDITION_LEADS.has(source.source_id) ? 'POTENTIAL_UNVERIFIED' : 'NOT_IDENTIFIED',
    catalogue_only: catalogueOnly,
  };
}

export function missingEvidenceFor(source) {
  const missing = ['official source/dataset identity and current metadata', 'exact endpoint and permitted machine-access method',
    'dataset-specific licence/version and commercial/derived-use terms', 'attribution text and placement requirements',
    'coverage geometry, update/version semantics and checksum strategy', 'adapter/parser specification and safe polling limits'];
  if (source.source_id === 'gb-sct-authoritative-sources-pending') missing.push('Scotland-specific authority inventory and explicit jurisdiction verification model');
  if (source.source_id === 'tr-kgm-road-information') missing.push('split network, restriction and live-condition products into exact official datasets; identify secondary authoritative sources for forest, village and off-road coverage');
  if (classifyEuropeSourceRoles(source).catalogue_only) missing.push('select an individual dataset from the catalogue; catalogue presence is not an ingestable dataset');
  if (classifyEuropeSourceRoles(source).restrictions_closures !== 'NOT_IDENTIFIED') missing.push('record-level motorcycle applicability, restriction dates and affected-geometry semantics');
  missing.push('independent evidence that can establish motorcycle access; road geometry/network presence alone is insufficient');
  return missing;
}

/** Operator-ready report; all source/use claims remain clearly marked unverified. */
export function renderEuropeCoverageMatrix({ countryCode = null, catalog = loadEuropeSourceCatalog() } = {}) {
  const rows = listEuropeSourceCandidates({ countryCode, catalog });
  const lines = [
    '| Country/Jurisdiction | Source | Authority | Role | Licence state | Private processing | Derived public use | Attribution | Automation state | Missing evidence/gaps |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    const roles = Object.entries(row.roles).filter(([key, value]) => key !== 'catalogue_only' && value !== 'NOT_IDENTIFIED').map(([key, value]) => `${key}=${value}`).join('<br>') || 'No dataset role established';
    const country = row.admin1_code ? `${COUNTRY_NAMES[row.country_code] ?? row.country_code} / ${row.jurisdiction_id}` : `${COUNTRY_NAMES[row.country_code] ?? row.country_code} (${row.jurisdiction_id})`;
    lines.push(`| ${md(country)} | ${md(`${row.dataset} — ${row.portal}`)} | ${md(row.authority)} | ${md(roles)} | ${row.licence_state} | NO | NO | ${row.attribution_state} | ${row.automation_state} | ${md(row.missing_evidence.join('; '))} |`);
  }
  if (!countryCode) for (const code of catalog.scope?.not_yet_represented ?? []) {
    lines.push(`| ${md(`${COUNTRY_NAMES[code] ?? code} (${code})`)} | No source lead in supplied list | — | NONE_IDENTIFIED | UNKNOWN | NO | NO | UNKNOWN | NO_SOURCE_REVIEW_REQUIRED | Identify official authority and exact datasets; verify jurisdiction, endpoint, licence, reuse, attribution, geometry and update terms |`);
  }
  return lines.join('\n');
}

function md(value) { return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' '); }
