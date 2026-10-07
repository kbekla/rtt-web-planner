import crypto from 'node:crypto';

export const SPW_ROAD_SERVICE = 'https://geoservices.wallonie.be/arcgis/rest/services/MOBILITE/RES_ROUTIER_REGIONAL/MapServer';
export const SPW_ROAD_METADATA = 'https://geoportail.wallonie.be/catalogue/bdcb789c-4b02-4c0c-863a-98dac4ed0240.html';
export const SPW_ROAD_LAYERS = Object.freeze({ 4: 'motorways', 5: 'rings', 6: 'national_roads' });
export const SPW_ATTRIBUTION = 'Service public de Wallonie (SPW) — Réseau routier régional (cite source version/date and modifications)';

export function spwRoadSourceDefinition() {
  return {
    source_id: 'spw-wallonia-regional-road-network', name: 'Réseau routier régional', type: 'authoritative-regional-road-network',
    organisation: 'Service public de Wallonie — Mobilité et Infrastructures', authority: { category: 'AUTHORITATIVE', authority_id: 'spw-wallonia', jurisdiction: 'BE-WAL' },
    url: SPW_ROAD_SERVICE, location: SPW_ROAD_SERVICE, metadata_url: SPW_ROAD_METADATA, dataset_id: 'bdcb789c-4b02-4c0c-863a-98dac4ed0240',
    expected_formats: ['ArcGIS REST JSON', 'GeoJSON'], adapter_version: 'spw-arcgis-rest-v1',
    coverage: { countries: ['BE'], regions: ['BE-WAL'] }, jurisdiction_ids: ['be-wallonia'],
    licence: { name: 'Creative Commons Attribution 4.0 International', version: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    reuse: { private_processing: true, redistribution: true, derived_public_use: true, attribution_required: true }, attribution: SPW_ATTRIBUTION,
    roles: { discovery_only: false, physical_existence: true, legal_access: false, routing_network: true, public_reuse: true, jurisdiction_boundaries: false },
    evidence_roles: ['PHYSICAL_EXISTENCE', 'NETWORK_IDENTITY', 'NETWORK_CONTEXT'],
    lineage: { upstream_source_ids: ['spw-picc', 'spw-bdr'], lineage_note: 'Road-axis geometry derives from PICC and route attributes are enriched from BDR; count as one SPW authority, not independent PICC and BDR corroboration.' },
    update: { mechanism: 'official ArcGIS REST service', update_frequency: 'when necessary', poll_interval_seconds: 2592000,
      retry_policy: { base_seconds: 900, max_seconds: 86400, max_retries: 5 } },
    rate_limits: { requests_per_minute: 6, politeness_interval_ms: 10000 },
  };
}

export function spwServiceMetadataVersion(metadata) {
  if (!metadata || !metadata.capabilities?.split(',').map(x => x.trim()).includes('Query') || !Array.isArray(metadata.layers)) throw new Error('SPW service metadata lacks the approved query-capable layer catalogue');
  const layers = Object.entries(SPW_ROAD_LAYERS).map(([id, name]) => ({ id: Number(id), name }));
  for (const layer of layers) {
    const actual = metadata.layers.find(x => x.id === layer.id);
    if (!actual || actual.type !== 'Feature Layer' || !/Polyline$/i.test(actual.geometryType ?? '')) throw new Error('SPW road service layer identity or geometry type changed; review required');
  }
  const version = metadata.documentInfo?.Version;
  if (typeof version !== 'string' || !version.trim()) throw new Error('SPW service version is unavailable; review required');
  return { version, service_version: metadata.currentVersion ?? null, sha256: crypto.createHash('sha256').update(stableJson(metadata)).digest('hex'), layers };
}

export function normalizeSpwFeature(feature, { layerId, sourceVersion, retrievedAt = null } = {}) {
  const layer = SPW_ROAD_LAYERS[layerId];
  if (!layer) throw new Error('SPW feature came from an unregistered layer');
  const properties = feature?.properties ?? feature?.attributes, geometry = feature?.geometry;
  if (!properties || !geometry) throw new Error('SPW feature lacks attributes or geometry');
  let lines, type;
  if (geometry.type === 'LineString') { lines = [geometry.coordinates]; type = 'LineString'; }
  else if (geometry.type === 'MultiLineString') { lines = geometry.coordinates; type = 'MultiLineString'; }
  else if (Array.isArray(geometry.paths)) { lines = geometry.paths; type = lines.length === 1 ? 'LineString' : 'MultiLineString'; }
  else throw new Error('SPW road feature geometry is not a line');
  if (!lines.length || lines.some(line => !Array.isArray(line) || line.length < 2 || line.some(p => !Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90))) {
    throw new Error('SPW query must return valid WGS84 geometry using outSR=4326; multipart components must remain separate');
  }
  const id = properties.OBJECTID ?? properties.objectid ?? properties.objectId;
  if (id === undefined || id === null || String(id) === '') throw new Error('SPW feature has no stable source object identifier');
  return {
    source_id: 'spw-wallonia-regional-road-network', source_version: sourceVersion ?? null, retrieved_at: retrievedAt,
    source_feature_id: `spw:${layer}:${id}`, layer,
    geometry: { type, coordinates: structuredClone(type === 'LineString' ? lines[0] : lines) },
    attributes: {
      route_code: properties.CODE_ROUTE ?? properties.code_route ?? null, route_number: properties.NUMERO_ROUTE ?? properties.numero_route ?? null,
      name: properties.NOM_ROUTE ?? properties.nom_route ?? null, road_type: properties.TYPE_DESC ?? properties.type_desc ?? properties.TYPE ?? null,
      subtype: properties.SOUS_TYPE_DESC ?? properties.sous_type_desc ?? properties.SOUS_TYPE ?? null,
      managed_length_m: Number(properties.LONGUEUR_GESTION ?? properties.longueur_gestion) || null,
      axis_id: properties.AXE_ID ?? properties.axe_id ?? null, source_object_id: String(id),
    },
    evidence_roles: ['PHYSICAL_EXISTENCE', 'NETWORK_IDENTITY', 'NETWORK_CONTEXT'], motorcycle_access: 'UNKNOWN', routability: 'UNKNOWN',
  };
}

const stableJson = value => JSON.stringify(sortObject(value));
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObject(value[key])]));
  return value;
}

const rad = x => x * Math.PI / 180;
function localXY(point, origin) { const scale = Math.cos(rad((point[1] + origin[1]) / 2)) * 111320; return [(point[0] - origin[0]) * scale, (point[1] - origin[1]) * 110574]; }
function distance(a, b) { return Math.hypot(...localXY(a, b)); }
function pointSegmentDistance(point, a, b) {
  const p = localXY(point, point), x = localXY(a, point), y = localXY(b, point), dx = y[0] - x[0], dy = y[1] - x[1];
  const denominator = dx * dx + dy * dy, t = denominator ? Math.max(0, Math.min(1, ((p[0] - x[0]) * dx + (p[1] - x[1]) * dy) / denominator)) : 0;
  return Math.hypot(p[0] - x[0] - t * dx, p[1] - x[1] - t * dy);
}
function geometryLines(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}
function edgeRecords(geometry) { return geometryLines(geometry).flatMap((line, part) => line.slice(1).map((point, i) => ({ a: line[i], b: point, part }))); }
function corridorEnvelope(edges,paddingM=12){
  let minLon=Infinity,maxLon=-Infinity,minLat=Infinity,maxLat=-Infinity;
  for(const edge of edges)for(const point of [edge.a,edge.b]){minLon=Math.min(minLon,point[0]);maxLon=Math.max(maxLon,point[0]);minLat=Math.min(minLat,point[1]);maxLat=Math.max(maxLat,point[1]);}
  const lonPadding=paddingM/(111320*Math.max(.1,Math.cos(Math.max(Math.abs(minLat),Math.abs(maxLat))*Math.PI/180))),latPadding=paddingM/110574;
  return {minLon:minLon-lonPadding,maxLon:maxLon+lonPadding,minLat:minLat-latPadding,maxLat:maxLat+latPadding};
}
function edgesInEnvelope(edges,envelope){return edges.filter(edge=>{
  const minLon=Math.min(edge.a[0],edge.b[0]),maxLon=Math.max(edge.a[0],edge.b[0]),minLat=Math.min(edge.a[1],edge.b[1]),maxLat=Math.max(edge.a[1],edge.b[1]);
  return maxLon>=envelope.minLon&&minLon<=envelope.maxLon&&maxLat>=envelope.minLat&&minLat<=envelope.maxLat;
});}
function edgeLength(edge) { return distance(edge.a, edge.b); }
function sampleEdges(edges, step = 15) {
  const result = [];
  for (const edge of edges) {
    const length = edgeLength(edge), count = Math.max(1, Math.ceil(length / step));
    for (let i = 0; i < count; i++) { const t = (i + .5) / count; result.push({ edge, point: [edge.a[0] + (edge.b[0] - edge.a[0]) * t, edge.a[1] + (edge.b[1] - edge.a[1]) * t] }); }
  }
  return result;
}
function bearing(edge) { return Math.atan2((edge.b[0] - edge.a[0]) * Math.cos(rad((edge.a[1] + edge.b[1]) / 2)), edge.b[1] - edge.a[1]) * 180 / Math.PI; }
function bearingDelta(a, b) { let d = Math.abs(bearing(a) - bearing(b)) % 180; return Math.min(d, 180 - d); }
function nearest(sample, edges, maxAngle) {
  let result = { distance: Infinity, angle: 180, part: null };
  for (const edge of edges) {
    const angle = bearingDelta(sample.edge, edge);
    if (angle > maxAngle) continue;
    const d = pointSegmentDistance(sample.point, edge.a, edge.b);
    if (d < result.distance) result = { distance: d, angle, part: edge.part };
  }
  return result;
}
function support(samples, edges, maxDistance, maxAngle) {
  const hits = samples.map(sample => nearest(sample, edges, maxAngle)).filter(hit => hit.distance <= maxDistance);
  return { ratio: hits.length / (samples.length || 1), hits };
}
function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] : Infinity; }
function endpoints(geometry) { return geometryLines(geometry).filter(line => line.length > 1).flatMap(line => [line[0], line.at(-1)]); }
function endpointGap(a, b) {
  const aa = endpoints(a), bb = endpoints(b); if (aa.length !== 2 || bb.length !== 2) return Infinity;
  return Math.min(Math.max(distance(aa[0], bb[0]), distance(aa[1], bb[1])), Math.max(distance(aa[0], bb[1]), distance(aa[1], bb[0])));
}
const norm = x => String(x ?? '').trim().normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
function routeIdentity(a, b) {
  const values = object => [object.attributes?.route_number, object.attributes?.route_code, object.attributes?.ref, object.attributes?.name].map(norm).filter(Boolean);
  const av = new Set(values(a)); return values(b).some(value => av.has(value));
}
function geometryLength(edges) { return edges.reduce((sum, edge) => sum + edgeLength(edge), 0); }

/** Conservative SPW-to-corridor relation. It records evidence only; it never changes legal access or routability. */
export function compareSpwCorridor(corridor, spw, { competitors = [] } = {}) {
  return compareSpwCorridors(corridor,[spw],{competitors})[0]?.match??{relationship:'NO_MATCH',reason:'line geometry unavailable',motorcycle_access_effect:'NONE',routability_effect:'NONE'};
}

/** Compare one corridor to a local candidate set while computing every
 * candidate's corridor support once. Calling the single-feature matcher once
 * per nearby source edge repeated all competitor geometry work quadratically. */
export function compareSpwCorridors(corridor, spws, { competitors = [] } = {}) {
  if(!Array.isArray(spws)||!Array.isArray(competitors))throw new Error('corridor comparison inputs must be arrays');
  const a=edgeRecords(corridor?.geometry),as=sampleEdges(a),envelope=corridorEnvelope(a),all=[...new Set([...spws,...competitors])],metrics=new Map();
  for(const spw of all){
    const b=edgeRecords(spw?.geometry);if(!a.length||!b.length){metrics.set(spw,{empty:true});continue;}
    // For corridor-to-network support, segments outside the corridor's
    // 12 m envelope cannot contribute a hit. Keep the full edge list and its
    // samples for reciprocal coverage so long source geometry is never
    // artificially made to look like a full match.
    const localB=edgesInEnvelope(b,envelope),bs=sampleEdges(b),sa=support(as,localB,12,20),sb=support(bs,a,12,20),da=sa.hits.map(x=>x.distance);
    metrics.set(spw,{b,sa,sb,p50:percentile(da,.5),p95:percentile(da,.95),bestAngle:percentile([...sa.hits,...sb.hits].map(hit=>hit.angle),.1),endpointMax:endpointGap(corridor.geometry,spw.geometry),identity:routeIdentity(corridor,spw)});
  }
  return spws.map(spw=>{
    const m=metrics.get(spw);if(!m||m.empty)return {spw,match:{relationship:'NO_MATCH',reason:'line geometry unavailable',motorcycle_access_effect:'NONE',routability_effect:'NONE'}};
    const competing=all.some(other=>other!==spw&&other.source_feature_id!==spw.source_feature_id&&(()=>{const candidate=metrics.get(other);return candidate&&!candidate.empty&&candidate.sa.ratio>=.8&&Math.abs(candidate.p95-m.p95)<=2;})());
    const {b,sa,sb,p50,p95,bestAngle,endpointMax,identity}=m;
    let relationship='NO_MATCH',reason='insufficient reciprocal linear support, direction agreement or endpoint continuity';
    if(competing){relationship='AMBIGUOUS';reason='multiple SPW alignments have indistinguishable geometric support';}
    else if(sa.ratio>=.8&&sb.ratio>=.8&&p50>=3&&p95<=30&&bestAngle<=15){relationship='PARALLEL';reason='nearby aligned geometries remain separate; proximity does not transfer identity';}
    else if(identity&&sa.ratio>=.98&&sb.ratio>=.98&&p95<=1.5&&endpointMax<=3&&bestAngle<=8){relationship='EXACT';reason='reciprocal near-coincident geometry, route identity, direction and endpoint support';}
    else if(identity&&sa.ratio>=.8&&sb.ratio>=.8&&p95<=8&&endpointMax<=20&&bestAngle<=12){relationship='LIKELY';reason='reciprocal geometry, route identity, direction and endpoint continuity';}
    else if(bestAngle<=18&&sa.ratio>=.35&&sb.ratio>=.15&&p95<=12){relationship='PARTIAL';reason='aligned reciprocal support covers only part of at least one geometry';}
    else if((sa.ratio>=.2||sb.ratio>=.2)&&!identity){relationship='AMBIGUOUS';reason='some geometric overlap lacks sufficient route identity for a stronger relationship';}
    return {spw,match:{relationship,reason,identity_match:identity,support_ratio_corridor:sa.ratio,support_ratio_spw:sb.ratio,
      p50_distance_m:Number.isFinite(p50)?Number(p50.toFixed(2)):null,p95_distance_m:Number.isFinite(p95)?Number(p95.toFixed(2)):null,
      endpoint_max_distance_m:Number.isFinite(endpointMax)?Number(endpointMax.toFixed(2)):null,aligned_edge_bearing_p10_deg:Number(bestAngle.toFixed(2)),
      corridor_length_m:geometryLength(a),spw_feature_length_m:geometryLength(b),
      identity_basis:['reciprocal sampled line support','local direction agreement','endpoint continuity','route name/reference equality','competing-alignment separation'],
      evidence_role:['PHYSICAL_EXISTENCE','NETWORK_IDENTITY','NETWORK_CONTEXT'],motorcycle_access_effect:'NONE',routability_effect:'NONE'}};
  });
}
