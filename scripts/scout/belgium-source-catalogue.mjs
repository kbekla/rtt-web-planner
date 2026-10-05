/** Curated NAP discovery records. Catalogue presence never grants retrieval permission. */
export const BELGIUM_NAP_CANDIDATES = Object.freeze([
  {
    source_id: 'nap-be-wallonia-road-events', dataset_id: 'e732e2f3-dd72-447b-85d4-a635b11d7275',
    name: 'Evénements routiers en Wallonie', provider: 'Service public de Wallonie Mobilité et Infrastructures', country: 'BE', region: 'BE-WAL', jurisdiction: 'be-wallonia',
    catalogue_url: 'https://transportdata.be/en/dataset/walloon-road-traffic-events', access_url: 'https://transportdata.be/en/dataset/walloon-road-traffic-events/resource/1aa4fc01-4dbc-420b-945c-558e0c18342a',
    machine_access: 'HTTP push, DATEX II XML; username/password issued by provider', licence: null, reuse_terms: 'contract required', update_frequency: 'less frequent than yearly (NAP metadata)',
    temporal_semantics: 'real-time road events/incidents/works, exact lifecycle semantics not validated', vehicle_applicability: 'catalogue lists motorcycle; record-specific applicability needs parsing', geometry_detail: 'Walloon motorway and national road locations, EPSG:4258 metadata',
    evidence_roles: ['TEMPORARY_RESTRICTION', 'CLOSURE'], suitability: 'REVIEW_REQUIRED', reason: 'no published licence; contract and provider credentials required; access is not yet approved',
  },
  {
    source_id: 'nap-be-flanders-tn-its', dataset_id: '0ac30f21-2a58-4ed3-bd4a-c20af72c5865',
    name: 'TN-ITS', provider: 'Agentschap Wegen en Verkeer', country: 'BE', region: 'BE-VLG', jurisdiction: 'be-flanders',
    catalogue_url: 'https://transportdata.be/en/dataset/tn-its', access_url: 'https://opendata.apps.mow.vlaanderen.be/tn-its/rest/dataset',
    machine_access: 'public service endpoint; TN-ITS XML, OpenLR/GML location references', licence: null, reuse_terms: 'source-specific licence needs confirmation; NAP catalogue terms also apply', update_frequency: 'daily',
    temporal_semantics: 'changes to speed limits and traffic restrictions; lifecycle/current-status fields not yet validated', vehicle_applicability: 'catalogue lists motorcycle coverage, each record must state applicability', geometry_detail: 'linear/point features; OpenLR/GML',
    evidence_roles: ['LEGAL_ACCESS', 'TEMPORARY_RESTRICTION', 'PERMANENT_RESTRICTION'], suitability: 'REVIEW_REQUIRED', reason: 'current machine-readable record does not expose a clear source-specific licence/reuse agreement; no ingestion until verified',
  },
  {
    source_id: 'nap-be-flanders-datex2-full', dataset_id: null,
    name: 'Verkeerscentrum Vlaanderen DATEX2 full feed', provider: 'Agentschap Wegen en Verkeer / Verkeerscentrum Vlaanderen', country: 'BE', region: 'BE-VLG', jurisdiction: 'be-flanders',
    catalogue_url: 'https://transportdata.be/en/dataset/datex2-feed-verkeerscentrum-vlaanderen-full-version', access_url: 'https://www.verkeerscentrum.be/uitwisseling/datex2v3full',
    machine_access: 'public HTTPS DATEX II service reported in NAP', licence: null, reuse_terms: 'source-specific terms require confirmation', update_frequency: 'minute-level (NAP metadata)',
    temporal_semantics: 'traffic incidents and works; record lifecycle and motorcycle applicability not validated', vehicle_applicability: 'not established at record level', geometry_detail: 'ALERT-C references; motorway/some regional roads',
    evidence_roles: ['TEMPORARY_RESTRICTION', 'CLOSURE'], suitability: 'REVIEW_REQUIRED', reason: 'licence/reuse and legal vehicle applicability need provider confirmation',
  },
  {
    source_id: 'nap-be-brussels-road-events', dataset_id: null,
    name: 'Brussels Road Events', provider: 'Brussels Mobility', country: 'BE', region: 'BE-BRU', jurisdiction: 'be-brussels',
    catalogue_url: 'https://transportdata.be/en/dataset/brussels-road-events', access_url: null,
    machine_access: 'catalogue entry; operational endpoint not verified', licence: 'other-open (NAP label)', reuse_terms: 'scope of reuse unclear', update_frequency: 'less frequent than yearly (NAP metadata)',
    temporal_semantics: 'described as real-time, metadata frequency conflicts', vehicle_applicability: 'unknown', geometry_detail: 'not established',
    evidence_roles: ['TEMPORARY_RESTRICTION', 'CLOSURE'], suitability: 'REVIEW_REQUIRED', reason: 'endpoint, freshness and licence scope are unclear/conflicting',
  },
]);

export function assessCatalogueSource(source) {
  const blockers = [];
  if (!source?.provider || !source?.name || !source?.catalogue_url) blockers.push('catalogue provenance is incomplete');
  if (!source?.access_url || !['public HTTPS', 'public service endpoint', 'HTTP push'].some(prefix => String(source.machine_access).startsWith(prefix))) blockers.push('machine access is not established');
  if (!source?.licence || source.licence === 'other-open' || /unclear|confirmation|contract required|needs confirmation/i.test(String(source.reuse_terms ?? ''))) blockers.push('source-specific reuse permission is not clear');
  if (source.machine_access?.includes('username/password') && source.reuse_terms !== 'contract approved') blockers.push('provider contract/credentials are not approved');
  if (source.suitability === 'REVIEW_REQUIRED') blockers.push(source.reason ?? 'source is held for review');
  return { state: blockers.length ? 'REVIEW_REQUIRED' : 'AUTOMATION_CANDIDATE', ingest_allowed: blockers.length === 0, blockers: [...new Set(blockers)] };
}
