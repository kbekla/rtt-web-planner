// NVDB road-link snapshot enrichment candidates. This is deliberately a
// research/validation registry, not an ingestion adapter: each entry stays
// blocked until the live Datakatalog schema, code lists, location semantics,
// licence and claim applicability are pinned and reviewed for that acquisition.
export const NVDB_CATALOGUE_API = 'https://nvdbapiles.atlas.vegvesen.no/datakatalog/api/v1';
export const NVDB_UBERIKET_API = 'https://nvdbapiles.atlas.vegvesen.no/uberiket/api/v1';
export const NVDB_OBJECT_CATALOGUE_VERSION_POLICY = 'fetch-current-version-and-definition-before-each-acquisition';

const held = {
  provider: 'Statens vegvesen NVDB Les V4',
  country_code: 'NO',
  access: 'official-public-api; no authentication requirement documented for most NVDB data',
  licence: { name: 'Norwegian Licence for Open Government Data (NLOD)', version: '1.0',
    url: 'https://data.norge.no/nlod/no/1.0/' },
  attribution: 'Contains data under the Norwegian Licence for Open Government Data (NLOD) made available by the Norwegian Public Roads Administration (Statens vegvesen).',
  private_processing: true,
  redistribution: false,
  derived_public_use: false,
  rate_limit_policy: 'one request per second; source/provider limits prevail',
  snapshot_policy: 'versioned private NDJSON artifact with SHA-256; preserve exact source object/version and raw record',
  location_join_policy: 'never join by nearby geometry alone; validate the current type schema location reference and its linear positions against the pinned road-link/sequence topology first',
  automation_state: 'HELD_FOR_SCHEMA_AND_APPLICABILITY_VALIDATION',
  catalogue_version: null,
  catalogue_definition_sha256: null,
};

const definitions = [
  {
    type_id: 241, name: 'Vegdekke', evidence_roles: ['SURFACE', 'PHYSICAL_CHARACTER'],
    source_claim: 'Road-surface object; documented material/layer/laying-date/width attributes and a centerline/location.',
    can_support: ['surface/material only when the current code list explicitly maps the value and its location join is validated'],
    cannot_support: ['motorcycle access', 'legal public status', 'gravel by absence of a pavement object'],
    unresolved: ['current type/property IDs and code values', 'coverage/completeness by road class', 'linear-location join and applicability dates'],
  },
  {
    type_id: 856, name: 'Trafikkreguleringer', evidence_roles: ['LEGAL_ACCESS', 'TEMPORARY_RESTRICTION', 'CLOSURE'],
    source_claim: 'A section with restrictions for motor traffic or walking/cycling; documented attributes include the restriction, optional time range and a free-text note for exceptions/vehicle types.',
    can_support: ['a restriction claim only after exact code, time, direction/extent and motorcycle applicability are validated'],
    cannot_support: ['a final motorcycle prohibition from an ambiguous/free-text value', 'permission when no object is returned'],
    unresolved: ['current code list/property schema', 'motorcycle semantics for each code and note', 'effective-time interpretation and completeness'],
  },
  {
    type_id: 485, name: 'Vegstengning', evidence_roles: ['CLOSURE', 'TEMPORARY_RESTRICTION'],
    source_claim: 'Information about periodic road closure; its documented definition is temporal closure of a road section.',
    can_support: ['a dated closure candidate after dates, affected vehicles, direction/extent and status are validated'],
    cannot_support: ['permanent prohibition', 'motorcycle applicability unless explicit', 'open status when absent'],
    unresolved: ['current schema and closure-cause values', 'whether each record is active/current and vehicle-specific', 'location join semantics'],
  },
  {
    type_id: 607, name: 'Vegsperring', evidence_roles: ['PHYSICAL_EXISTENCE', 'NETWORK_CONTEXT'],
    source_claim: 'A physical barrier that blocks the road; the NVDB route-dataset specification includes barrier type/function, network-link references, and conditional closed-time attributes.',
    can_support: ['physical barrier and routing-block context when type semantics, network-link references and active schedule are validated'],
    cannot_support: ['legal prohibition or motorcycle access from physical presence alone'],
    unresolved: ['barrier function/value semantics', 'whether a barrier is passable/locked and applicable time', 'point-to-road topology relationship'],
  },
  {
    type_id: 23, name: 'Vegbom', evidence_roles: ['PHYSICAL_EXISTENCE', 'NETWORK_CONTEXT'],
    source_claim: 'A physical gate/maintenance object; the published NVDB specification says it is recorded regardless of whether normally open or closed.',
    can_support: ['physical infrastructure inventory only after current schema validation'],
    cannot_support: ['whether the gate is currently closed', 'whether motorcycles may pass', 'routing closure from this object alone'],
    unresolved: ['current object definition/code lists', 'actual state feed if any', 'network association'],
  },
  {
    type_id: 913, name: 'Gjennomkjøring forbudt', evidence_roles: ['LEGAL_ACCESS'],
    source_claim: 'A no-through-traffic restriction with a linked endpoint object; published product specification describes vehicle applicability, direction, weekday, and an explicit motorcycle-exception field.',
    can_support: ['a restricted-through-movement claim only when paired start/end objects, direction, applicable vehicle code, motorcycle exception and current validity are resolved'],
    cannot_support: ['a corridor-wide closure without resolving the paired endpoint/extent', 'generic access prohibition from the point object alone'],
    unresolved: ['current Datakatalog version/property IDs and code lists', 'relation completeness/currentness', 'extent construction and effective schedule'],
  },
];

export const NVDB_OBJECT_TYPE_REGISTRY = Object.freeze(definitions.map(definition => Object.freeze({
  ...held,
  ...definition,
  source_id: `no-nvdb-object-${definition.type_id}`,
  catalogue_definition_url: `${NVDB_CATALOGUE_API}/vegobjekttyper/${definition.type_id}`,
  object_stream_url: `${NVDB_UBERIKET_API}/vegobjekter/${definition.type_id}/stream`,
  event_endpoint: `${NVDB_UBERIKET_API}/hendelser/vegobjekter/${definition.type_id}`,
  version_fields: ['id', 'versjon', 'gyldighetsperiode', 'sistEndret'],
  preserve_fields: ['egenskaper', 'stedfesting', 'barn', 'raw_object'],
  update_mechanism: 'Uberiket ordered NDJSON stream with start cursor; object change-event endpoint can supply later deltas after validated cursor semantics',
})));

export function getNvdbObjectType(typeId) {
  return NVDB_OBJECT_TYPE_REGISTRY.find(item => item.type_id === Number(typeId)) ?? null;
}

/** Disabled definitions suitable for persistence in Scout's ordinary source registry. */
export function nvdbObjectSourceDefinitions() {
  return NVDB_OBJECT_TYPE_REGISTRY.map(item => ({
    source_id: item.source_id,
    name: `NVDB ${item.name} (${item.type_id})`,
    type: 'official-nvdb-road-object-candidate',
    organisation: item.provider,
    expected_formats: ['NVDB Uberiket NDJSON object stream'],
    coverage: { countries: ['NO'], regions: ['NO'] },
    jurisdiction_ids: ['NO'],
    location: { kind: 'official-read-api-candidate', url: item.object_stream_url,
      catalogue_definition_url: item.catalogue_definition_url },
    adapter_version: 'nvdb-object-evidence-adapter-not-enabled-1',
    licence: item.licence,
    reuse: { private_processing: item.private_processing, redistribution: item.redistribution,
      derived_public_use: item.derived_public_use },
    evidence_roles: item.evidence_roles,
    roles: { discovery_only: false, physical_existence: item.evidence_roles.includes('PHYSICAL_EXISTENCE'),
      legal_access: item.evidence_roles.includes('LEGAL_ACCESS'), routing_network: false, public_reuse: false,
      jurisdiction_boundaries: false, restrictions: item.evidence_roles.some(role => ['TEMPORARY_RESTRICTION', 'CLOSURE', 'PERMANENT_RESTRICTION'].includes(role)) },
    update: { mechanism: item.update_mechanism, catalogue_version_required: true, definition_checksum_required: true },
    attribution: item.attribution,
    rate_limits: { requests_per_minute: 60, politeness_interval_seconds: 1 },
    automation_state: item.automation_state,
    source_status: 'DISABLED_REVIEW_REQUIRED',
  }));
}

/**
 * Produces an acquisition plan only after a caller supplies a pinned live
 * catalogue version and checksums for every selected type definition. It does
 * not fetch data or imply that the type has been approved for evidence fusion.
 */
export function planNvdbObjectAcquisition({ typeIds, catalogueVersion, catalogueSha256, definitionChecksums = {} } = {}) {
  if (!Array.isArray(typeIds) || !typeIds.length) throw new Error('NVDB object acquisition requires explicit object type IDs');
  if (typeof catalogueVersion !== 'string' || !catalogueVersion.trim() || !/^[a-f0-9]{64}$/i.test(catalogueSha256 ?? ''))
    throw new Error('NVDB object acquisition requires a pinned catalogue version and SHA-256');
  const types = typeIds.map(id => {
    const definition = getNvdbObjectType(id);
    if (!definition) throw new Error(`NVDB object type ${id} is not in the reviewed candidate registry`);
    const checksum = definitionChecksums[String(definition.type_id)];
    if (!/^[a-f0-9]{64}$/i.test(checksum ?? '')) throw new Error(`NVDB object type ${id} requires a pinned definition checksum`);
    return { type_id: definition.type_id, source_id: definition.source_id, name: definition.name,
      status: definition.automation_state, object_stream_url: definition.object_stream_url,
      definition_sha256: checksum.toLowerCase(), evidence_roles: definition.evidence_roles };
  });
  return {
    status: 'REVIEW_REQUIRED',
    reason: 'object types are registered candidates only; exact fields, location joins and claim applicability have not been approved for ingestion',
    parent_snapshot_required: true,
    immutable_parent_network: true,
    parent_network_sha256_required: true,
    catalogue: { version: catalogueVersion, sha256: catalogueSha256.toLowerCase() },
    stages: ['VALIDATE_APPROVAL_AND_METADATA', 'ACQUIRE_TYPE_STREAM', 'CHECKPOINT_PAGE_AND_CURSOR_ATOMICALLY',
      'VERIFY_ARTIFACT_SHA256', 'NORMALIZE_PRIVATE_EVIDENCE', 'VALIDATE_LOCATION_JOIN', 'REVIEW_CLAIM_APPLICABILITY'],
    checkpoint: { per_type_cursor: 'last committed NVDB stream start/id-version cursor',
      commit_unit: 'append-only object page + page checksum + cursor in one transaction',
      yield_points: ['before request', 'after durable page commit'],
      admission: 'shared A17 heavy-work lease; lightweight status does not acquire lease',
      resume: 'resume after last committed page; verify pinned parent snapshot, type definition and partial artifact before continuing' },
    provenance: ['provider', 'type_id', 'object_id', 'object_version', 'catalogue_version', 'definition_sha256',
      'retrieved_at', 'object_checksum', 'validity_period', 'location_reference', 'raw_object'],
    types,
  };
}
