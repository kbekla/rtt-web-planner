// Official Statens vegvesen NVDB Les V4 adapter. Raw API pages, normalized
// network edges and their provenance stay inside the private Scout store.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import proj4 from 'proj4';
import { lengthMeters } from './route-segmenter.mjs';

export const NVDB_API_BASE = 'https://nvdbapiles.atlas.vegvesen.no';
export const NVDB_API_VERSION = 'nvdb-api-les-v4';
export const NVDB_ADAPTER_VERSION = 'nvdb-road-link-normalizer-2';
// The V4 collection endpoint returns paginated sequence records containing
// their segment/link geometries. The documented next-page href uses the
// official unversioned public facade path on the same API host.
export const NVDB_LINKS_PATH = '/vegnett/api/v4/veglenkesekvenser';
const NVDB_PAGINATION_PATH = '/vegnett/veglenkesekvenser';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
// NVDB uses UTM zone 33 coordinates across Norway, including far beyond the
// nominal 12-18 degree area of EPSG:5973. Proj4js uses extended transverse
// Mercator for this transform; do not substitute a narrow-zone polynomial.
const nvdbToGeographic = proj4(
  '+proj=utm +zone=33 +ellps=GRS80 +units=m +no_defs',
  '+proj=longlat +ellps=GRS80 +no_defs',
);

export function nvdbNorwaySourceDefinition() {
  return {
    source_id: 'no-nvdb-vegkart',
    name: 'Norwegian National Road Database (NVDB) road links',
    type: 'authoritative-regional-network',
    organisation: 'Statens vegvesen',
    expected_formats: ['NVDB API Les V4 paginated JSON'],
    coverage: { countries: ['NO'], regions: ['NO'] },
    jurisdiction_ids: ['NO'],
    location: { kind: 'official-read-api', url: `${NVDB_API_BASE}${NVDB_LINKS_PATH}` },
    adapter_version: NVDB_ADAPTER_VERSION,
    network_api: {
      provider: 'statens-vegvesen-nvdb-api-les-v4', base_url: NVDB_API_BASE,
      endpoint: NVDB_LINKS_PATH, query: { antall: 1000, inkluderAntall: false },
      projection: 'EPSG:5973', coverage_country: 'NO', snapshot_policy: 'private-complete-paginated-response-bundle',
      consistency: 'live paginated API; retrieval interval and bundle checksum are recorded; provider does not promise a point-in-time transaction snapshot',
      client_header: 'X-Client: RT&T Scout', minimum_request_interval_seconds: 1,
      max_retries: 3,
    },
    licence: { name: 'Norsk lisens for offentlige data (NLOD)', version: '1.0', url: 'https://data.norge.no/nlod/no/1.0/' },
    reuse: { private_processing: true, redistribution: false, derived_public_use: false },
    evidence_roles: ['PHYSICAL_EXISTENCE', 'NETWORK_IDENTITY', 'NETWORK_CONTEXT', 'ROUTING_NETWORK'],
    roles: { discovery_only: false, physical_existence: true, legal_access: false, routing_network: true,
      public_reuse: false, jurisdiction_boundaries: false, restrictions: false },
    update: { mechanism: 'explicitly acquired paginated NVDB Les V4 response snapshot; no background polling enabled' },
    attribution: 'Contains data under the Norwegian Licence for Open Government Data (NLOD) made available by the Norwegian Public Roads Administration (Statens vegvesen).',
    rate_limits: { requests_per_minute: 60, politeness_interval_seconds: 1 },
  };
}

function inverseUtm33(easting, northing) {
  if (!Number.isFinite(easting) || !Number.isFinite(northing) || easting < -2000000 || easting > 2000000 || northing < 0 || northing > 10000000)
    throw new Error('NVDB EPSG:5973 coordinate is outside valid UTM bounds');
  const coordinate = nvdbToGeographic.forward([easting, northing]);
  const [longitude, latitude] = coordinate;
  // Broad Norway envelope includes mainland, Svalbard and Jan Mayen. It is a
  // post-transform sanity check, not a dataset-derived or route-derived extent.
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -12 || longitude > 35 || latitude < 56 || latitude > 82)
    throw new Error('NVDB EPSG:5973 coordinate transforms outside the configured Norway geographic envelope');
  return [longitude, latitude];
}

function parseLineStringZ(wkt, srid) {
  if (srid !== 5973 || typeof wkt !== 'string') throw new Error('NVDB geometry must explicitly declare EPSG:5973 WKT');
  const match = /^\s*LINESTRING(?:\s+Z)?\s*\((.*)\)\s*$/i.exec(wkt);
  if (!match) throw new Error('NVDB road-link geometry must be a LINESTRING');
  const points = match[1].split(',').map(piece => {
    const values = piece.trim().split(/\s+/).map(Number);
    if (values.length < 2 || values.some(value => !Number.isFinite(value))) throw new Error('NVDB WKT contains an invalid coordinate');
    return inverseUtm33(values[0], values[1]);
  });
  if (points.length < 2) throw new Error('NVDB road-link geometry must contain at least two coordinates');
  return { type: 'LineString', coordinates: points };
}

function internalHighway(typeVeg, category) {
  const label = String(typeVeg ?? '').normalize('NFKC').toLowerCase();
  if (/sti|gangveg|gang- og sykkel|sykkelveg|gågate|fortau/.test(label)) return 'path';
  if (/traktorveg|kjerreveg|skogsbilveg|skogveg|terrengveg/.test(label)) return 'track';
  // Private-road category is preserved as context only. It is not proof of
  // surface, physical character, or motorcycle access.
  if (String(category ?? '').toUpperCase() === 'P') return 'unclassified';
  if (/bilveg|rampe|rundkjøring|kjøreveg/.test(label)) return 'unclassified';
  return null;
}

export function normalizeNvdbRoadLink(link) {
  const geometry = link?.geometri;
  const sequenceId = link?.veglenkesekvensid, linkNumber = link?.veglenkenummer;
  const segmentNumber = link?.segmentnummer ?? 'unsegmented';
  if (!Number.isSafeInteger(Number(sequenceId)) || !Number.isSafeInteger(Number(linkNumber)))
    throw new Error('NVDB road link requires sequence and link identities');
  if (!geometry || geometry.srid !== 5973) throw new Error('NVDB road link must provide geometry with SRID 5973');
  const ref = link.vegsystemreferanse ?? {}, system = ref.vegsystem ?? {}, stretch = ref.strekning ?? {};
  const tags = {
    ...(internalHighway(link.typeVeg, system.vegkategori) ? { highway: internalHighway(link.typeVeg, system.vegkategori) } : {}),
    'nvdb:type_veg': link.typeVeg ?? null,
    'nvdb:type_veg_sosi': link.typeVeg_sosi ?? null,
    'nvdb:vegkategori': system.vegkategori ?? null,
    'nvdb:vegfase': system.fase ?? null,
    'nvdb:vegnummer': system.nummer ?? null,
    'nvdb:trafikantgruppe': stretch.trafikantgruppe ?? null,
    'nvdb:network_type': link.type ?? null,
    'nvdb:detail_level': link.detaljnivå ?? null,
    'nvdb:medium': geometry.medium ?? null,
    'nvdb:county': link.fylke ?? null,
    'nvdb:municipality': link.kommune ?? geometry.kommune ?? null,
    'nvdb:road_name': link.adresse?.navn ?? null,
    'nvdb:road_reference': ref.kortform ?? null,
    'nvdb:measurement_date': link.måledato ?? null,
    'nvdb:geometry_capture_date': geometry.datafangstdato ?? null,
    'nvdb:start_date': link.startdato ?? link.metadata?.startdato ?? null,
    'nvdb:length_m': link.lengde ?? geometry.lengde ?? null,
  };
  for (const [key, value] of Object.entries(tags)) if (value === null || value === undefined) delete tags[key];
  const originalIdentity = String(link.kortform ?? link.referanse ?? `${sequenceId}-${linkNumber}-${segmentNumber}-${link.startposisjon}-${link.sluttposisjon}`);
  const edgeId = `nvdb:segment:${sequenceId}:${linkNumber}:${segmentNumber}:${sha256(originalIdentity).slice(0, 16)}`;
  const normalizedGeometry = parseLineStringZ(geometry.wkt, geometry.srid);
  return {
    edge_id: edgeId, geometry: normalizedGeometry, tags,
    evidence: [{ source_id: 'no-nvdb-vegkart', source_authority: 'Statens vegvesen', claim: 'PHYSICAL_EXISTENCE',
      source_reference: originalIdentity, source_object_id: String(sequenceId), link_number: Number(linkNumber), segment_number: Number(segmentNumber),
      source_geometry_srid: geometry.srid, source_wkt: geometry.wkt, geometry_capture_date: geometry.datafangstdato ?? null,
      measurement_date: link.måledato ?? null, source_record: link }],
    jurisdiction_ids: ['NO'],
  };
}

export function normalizeNvdbPage(page) {
  const rows = Array.isArray(page) ? page : page?.objekter ?? page?.veglenkesekvenser ?? page?.veglenkesegmenter;
  if (!Array.isArray(rows)) throw new Error('NVDB page has no recognized road-link array');
  const edges = [];
  for (const row of rows) {
    // The segmented link endpoint is the canonical acquisition target. Also
    // accept a sequence response fixture for compatibility with API V4.
    if (row.geometri) edges.push(normalizeNvdbRoadLink(row));
    else if (Array.isArray(row.veglenker)) for (const link of row.veglenker) {
      edges.push(normalizeNvdbRoadLink({ ...link, veglenkesekvensid: row.veglenkesekvensid,
        segmentnummer: link.segmentnummer ?? row.segmentnummer, vegsystemreferanse: link.vegsystemreferanse ?? row.vegsystemreferanse,
        fylke: link.fylke ?? row.fylke, kommune: link.kommune ?? row.kommune,
        adresse: link.adresse ?? row.adresse, metadata: link.metadata ?? row.metadata }));
    }
  }
  return edges;
}

export function nvdbDiscoverySelection(tags = {}) {
  const type = String(tags['nvdb:type_veg'] ?? '').normalize('NFKC').toLowerCase();
  const category = String(tags['nvdb:vegkategori'] ?? '').toUpperCase();
  const trailNetworkType = /sti|gangveg|gang- og sykkel|sykkelveg|gågate|fortau|traktorveg|kjerreveg|skogsbilveg|skogveg|terrengveg/.test(type);
  const privateRoad = category === 'P';
  if (!trailNetworkType && !privateRoad) return null;
  // NVDB road-link classification identifies network kind but does not supply
  // adequate surface/physical-character or motorcycle-access proof.
  return { classification: 'UNKNOWN', selection_rule: trailNetworkType ? 'official-nvdb-nonstandard-road-link' : 'official-nvdb-private-road-link-review-lead',
    physical_state: 'probable', motorcycle_access: 'unknown', routability: 'unknown', canonical_status: 'NOT_COMPARED',
    access_tag_state: 'NO_EXPLICIT_MOTORCYCLE_ACCESS_EVIDENCE', relevant_tags: tags };
}

function safeApiUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('NVDB pagination URL is invalid'); }
  if (url.protocol !== 'https:' || url.hostname !== 'nvdbapiles.atlas.vegvesen.no' || url.username || url.password || url.hash
      || ![NVDB_LINKS_PATH, NVDB_PAGINATION_PATH].includes(url.pathname))
    throw new Error('NVDB pagination link escaped the approved official road-link endpoint');
  return url;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function writeAtomic(file, contents) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); fs.chmodSync(file, 0o600); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
}

export async function acquireNvdbSnapshot(store, { sourceId = 'no-nvdb-vegkart', snapshotId, dataRoot, fetchImpl = fetch,
  shouldYield = () => false, requestIntervalMs = 1000, sleepImpl = sleep, maxRetries = 3, onPage = () => {} } = {}) {
  const source = store.getSource(sourceId);
  if (!source || source.source_id !== 'no-nvdb-vegkart' || source.network_api?.provider !== 'statens-vegvesen-nvdb-api-les-v4' || source.reuse?.private_processing !== true)
    throw new Error('NVDB network source is not registered for private processing');
  if (!store.sourceApproval(sourceId)) throw new Error('NVDB network acquisition requires explicit source approval');
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(snapshotId ?? '')) throw new Error('NVDB snapshot ID must be a safe stable ID');
  const root = path.resolve(dataRoot), privateRoot = fs.realpathSync(store.root);
  if (root !== privateRoot && !root.startsWith(privateRoot + path.sep)) throw new Error('NVDB source pages must remain inside private Scout storage');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink() || !fs.realpathSync(root).startsWith(privateRoot + path.sep)) throw new Error('NVDB network directory cannot escape the private Scout root');
  const complete = path.join(root, `${snapshotId}.nvdb.jsonl`), part = `${complete}.part`, cursorFile = `${part}.cursor.json`;
  const priorArtifact = store.getNetworkArtifact(snapshotId);
  if (priorArtifact) {
    const existing = store.getNetworkSnapshot(snapshotId);
    const checksum = await hashFile(priorArtifact.local_path);
    if (checksum !== priorArtifact.sha256 || checksum !== existing?.checksum) throw new Error('registered NVDB snapshot checksum mismatch');
    return { status: 'REUSED', snapshot_id: snapshotId, sha256: checksum, bytes: priorArtifact.byte_size };
  }
  let cursor = null;
  if (fs.existsSync(cursorFile)) {
    if (fs.lstatSync(cursorFile).isSymbolicLink() || (fs.existsSync(part) && fs.lstatSync(part).isSymbolicLink())) throw new Error('NVDB partial snapshot may not be a symlink');
    cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
    if (cursor.snapshot_id !== snapshotId || !Number.isSafeInteger(cursor.pages_written) || cursor.pages_written < 0) throw new Error('NVDB snapshot resume cursor is invalid');
    cursor.next_url = safeApiUrl(cursor.next_url).href;
  }
  const startedAt = cursor?.started_at ?? new Date().toISOString();
  let nextUrl = cursor?.next_url ?? new URL(`${NVDB_LINKS_PATH}?antall=${source.network_api.query.antall}&inkluderAntall=false`, NVDB_API_BASE).href;
  let pages = cursor?.pages_written ?? 0, first = !cursor;
  if (first && fs.existsSync(part)) throw new Error('untracked NVDB partial artifact exists; refusing to overwrite');
  while (nextUrl) {
    if (shouldYield()) {
      writeAtomic(cursorFile, JSON.stringify({ snapshot_id: snapshotId, started_at: startedAt, next_url: nextUrl, pages_written: pages }));
      return { status: 'YIELDED', snapshot_id: snapshotId, pages_written: pages, partial_path: part };
    }
    if (!first) await sleepImpl(requestIntervalMs);
    first = false;
    let response;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      response = await fetchImpl(safeApiUrl(nextUrl).href, { headers: { Accept: 'application/json', 'X-Client': 'RT&T Scout' }, redirect: 'manual' });
      if (response.ok) break;
      if (response.status !== 429 && response.status !== 503) throw new Error(`NVDB road-link API returned HTTP ${response.status}`);
      if (attempt === maxRetries) throw new Error(`NVDB road-link API retry budget exhausted after HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleepImpl(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 300000) : attempt * 2000);
    }
    if (response.url && safeApiUrl(response.url).href !== safeApiUrl(nextUrl).href) throw new Error('NVDB road-link API redirected outside the registered endpoint');
    const body = await response.text();
    let page; try { page = JSON.parse(body); } catch { throw new Error('NVDB road-link API returned malformed JSON'); }
    if (!Array.isArray(page?.objekter) && !Array.isArray(page?.veglenkesekvenser) && !Array.isArray(page?.veglenkesegmenter)) throw new Error('NVDB response omitted the road-link collection');
    const next = page.metadata?.neste?.href ?? null;
    nextUrl = next ? safeApiUrl(next).href : null;
    fs.appendFileSync(part, `${body}\n`, { mode: 0o600 });
    const fd = fs.openSync(part, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    pages++;
    writeAtomic(cursorFile, JSON.stringify({ snapshot_id: snapshotId, started_at: startedAt, next_url: nextUrl, pages_written: pages }));
    onPage({ pages_written: pages, next_page_pending: Boolean(nextUrl) });
  }
  if (!pages) throw new Error('NVDB returned an empty snapshot');
  const completedAt = new Date().toISOString(), checksum = await hashFile(part), bytes = fs.statSync(part).size;
  fs.renameSync(part, complete); fs.chmodSync(complete, 0o600); fs.unlinkSync(cursorFile);
  const version = `${NVDB_API_VERSION};retrieval=${startedAt}/${completedAt};pages=${pages};consistency=live-window`;
  const coverage = { countries: ['NO'], regions: ['NO'], source_api: NVDB_API_BASE, endpoint: NVDB_LINKS_PATH,
    projection: 'EPSG:5973', retrieved_at_start: startedAt, retrieved_at_complete: completedAt, page_count: pages,
      point_in_time_consistent: false, artifact_format: 'NVDB API response JSONL', attribution_scope: 'dataset-level only; never attached to public lane features' };
  const licence = { ...source.licence, attribution: source.attribution };
  store.recordNetworkSnapshot({ snapshot_id: snapshotId, source_id: sourceId, version, checksum, licence, coverage, imported_at: completedAt });
  store.recordNetworkArtifact({ snapshot_id: snapshotId, provider: 'statens-vegvesen-nvdb-api-les-v4', source_url: `${NVDB_API_BASE}${NVDB_LINKS_PATH}`,
    local_path: complete, byte_size: bytes, sha256: checksum, last_modified: completedAt });
  return { status: 'COMPLETE', snapshot_id: snapshotId, version, sha256: checksum, bytes, pages_written: pages, point_in_time_consistent: false };
}

export async function importNvdbSnapshot(store, { snapshotId, batchSize = 500, shouldYield = () => false, onBatch = () => {} } = {}) {
  const snapshot = store.getNetworkSnapshot(snapshotId), artifact = store.getNetworkArtifact(snapshotId);
  if (!snapshot || !artifact || artifact.provider !== 'statens-vegvesen-nvdb-api-les-v4') throw new Error('NVDB import requires a verified registered NVDB snapshot artifact');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error('NVDB batch size must be 1-5000');
  const file = path.resolve(artifact.local_path), root = fs.realpathSync(store.root);
  if (fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file || !file.startsWith(root + path.sep)) throw new Error('NVDB page artifact must be a private regular file');
  if (await hashFile(file) !== snapshot.checksum || snapshot.checksum !== artifact.sha256) throw new Error('NVDB page artifact failed checksum validation');
  let checkpoint = store.networkImportCheckpoint(snapshotId);
  if (checkpoint && checkpoint.normalizer_version !== NVDB_ADAPTER_VERSION) {
    const linkedRuns = store.db.prepare('SELECT count(*) n FROM discovery_runs WHERE snapshot_id=?').get(snapshotId).n;
    if (linkedRuns) throw new Error('NVDB normalization version changed after discovery began; create a separately pinned normalized snapshot for review');
    store.setNetworkImportCheckpoint(snapshotId, { source_url: artifact.source_url, records_seen: 0,
      edges_written: store.networkEdgeCount(snapshotId), status: 'RUNNING', normalizer_version: NVDB_ADAPTER_VERSION });
    checkpoint = store.networkImportCheckpoint(snapshotId);
  }
  const skippedPages = checkpoint?.records_seen ?? 0;
  if (checkpoint?.normalizer_version === NVDB_ADAPTER_VERSION && checkpoint?.status === 'COMPLETE' && checkpoint.edges_written === store.networkEdgeCount(snapshotId))
    return { status: 'REUSED', pages_seen: checkpoint.records_seen, links_normalized: 0, edges_total: checkpoint.edges_written };
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let batch = [], pagesSeen = 0, normalized = 0, yielded = false;
  const flush = () => {
    if (!batch.length) return;
    const current = batch; batch = []; store.saveNetworkEdges(snapshotId, current); normalized += current.length;
  };
  for await (const line of reader) {
    if (!line.trim()) continue;
    pagesSeen++; if (pagesSeen <= skippedPages) continue;
    let page; try { page = JSON.parse(line); } catch { throw new Error(`invalid NVDB snapshot page ${pagesSeen}`); }
    for (const edge of normalizeNvdbPage(page)) {
      batch.push(edge);
      if (batch.length >= batchSize) flush();
    }
    flush();
    store.setNetworkImportCheckpoint(snapshotId, { source_url: artifact.source_url, records_seen: pagesSeen,
      edges_written: store.networkEdgeCount(snapshotId), status: 'RUNNING', normalizer_version: NVDB_ADAPTER_VERSION });
    onBatch({ pages_seen: pagesSeen, links_normalized: normalized });
    if (shouldYield()) { yielded = true; break; }
  }
  if (!yielded) {
    const count = store.networkEdgeCount(snapshotId);
    store.setNetworkImportCheckpoint(snapshotId, { source_url: artifact.source_url, records_seen: pagesSeen,
      edges_written: count, status: 'COMPLETE', normalizer_version: NVDB_ADAPTER_VERSION });
  }
  return { status: yielded ? 'YIELDED' : 'COMPLETE', pages_seen: pagesSeen, links_normalized: normalized,
    edges_total: store.networkEdgeCount(snapshotId), yielded };
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function nvdbDiscoverySourceDefinition(parent, snapshot) {
  const id = `nvdb-discovery-no-${sha256(snapshot.snapshot_id).slice(0, 10)}`;
  return { source_id: id, name: 'NVDB official road-link discovery adapter', type: 'regional-nvdb-discovery-adapter',
    organisation: parent.organisation, expected_formats: ['registered NVDB private network snapshot'], coverage: parent.coverage,
    jurisdiction_ids: parent.jurisdiction_ids, location: { kind: 'registered-private-network-snapshot', snapshot_id: snapshot.snapshot_id,
      parent_source_id: parent.source_id, version: snapshot.version, sha256: snapshot.checksum }, adapter_version: NVDB_ADAPTER_VERSION,
    parent_network_source_id: parent.source_id, bound_snapshot_id: snapshot.snapshot_id, licence: snapshot.licence,
    reuse: { private_processing: true, redistribution: false, derived_public_use: false },
    roles: { discovery_only: true, physical_existence: true, legal_access: false, routing_network: false, public_reuse: false, jurisdiction_boundaries: false },
    update: { mechanism: 'explicitly pinned NVDB API page bundle; no scheduled retrieval' }, attribution: parent.attribution,
    rate_limits: { requests_per_minute: 0, politeness_interval_seconds: 0 } };
}

export function registerNvdbDiscoverySource(store, snapshotId) {
  const snapshot = store.getNetworkSnapshot(snapshotId), parent = snapshot && store.getSource(snapshot.source_id);
  if (!snapshot || !parent || parent.source_id !== 'no-nvdb-vegkart' || parent.network_api?.provider !== 'statens-vegvesen-nvdb-api-les-v4'
    || parent.reuse?.private_processing !== true || !snapshot.checksum || snapshot.coverage?.countries?.length !== 1 || snapshot.coverage.countries[0] !== 'NO')
    throw new Error('independent discovery requires a pinned, privately approved Norway NVDB network snapshot');
  const registered = store.registerSource(nvdbDiscoverySourceDefinition(parent, snapshot));
  return { source: store.getSource(registered.source_id), ...registered };
}

export function discoverNvdbRun(store, runId, { batchSize = 500, shouldYield = () => false, onProgress = () => {} } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000) throw new Error('NVDB discovery batch size must be 1-2000');
  const run = store.getDiscoveryRun(runId);
  if (!run) throw new Error(`unknown independent discovery run '${runId}'`);
  if (run.reference_run_id !== null) throw new Error('independent discovery cannot use a comparison/reference run');
  if (run.status === 'COMPLETE') return { run_id: runId, status: 'REUSED', edges_examined: run.edges_examined, candidate_count: run.candidates_created };
  const snapshot = store.getNetworkSnapshot(run.snapshot_id), source = store.getSource(run.discovery_source_id);
  const parent = snapshot && store.getSource(snapshot.source_id), approval = store.sourceApproval(run.discovery_source_id);
  if (!snapshot || !source || parent?.source_id !== 'no-nvdb-vegkart' || source.parent_network_source_id !== parent.source_id
      || source.bound_snapshot_id !== run.snapshot_id || source.roles?.legal_access === true || !approval
      || approval.approved_by !== run.approved_by || approval.scope !== run.approval_scope)
    throw new Error('NVDB discovery run source/snapshot binding or explicit approval is invalid');
  let cursor = run.checkpoint_edge_rowid, examined = run.edges_examined;
  let created = Number(store.db.prepare('SELECT count(*) n FROM discovery_candidates WHERE run_id=?').get(runId).n);
  store.updateDiscoveryRun(runId, { status: 'RUNNING', last_error: null });
  const query = store.db.prepare('SELECT edge_rowid,edge_id,geometry_json,tags_json,evidence_json FROM network_edges WHERE snapshot_id=? AND edge_rowid>? ORDER BY edge_rowid LIMIT ?');
  for (;;) {
    if (shouldYield()) {
      store.updateDiscoveryRun(runId, { status: 'BLOCKED', checkpoint_edge_rowid: cursor, edges_examined: examined, candidates_created: created,
        last_error: 'shared factory admission requested a safe yield' });
      return { run_id: runId, status: 'BLOCKED', edges_examined: examined, candidate_count: created, resumable: true };
    }
    const rows = query.all(run.snapshot_id, cursor, batchSize); if (!rows.length) break;
    const out = [];
    for (const row of rows) {
      const tags = JSON.parse(row.tags_json), selection = nvdbDiscoverySelection(tags);
      if (selection) {
        const geometry = JSON.parse(row.geometry_json), parts = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
          const coords = parts[partIndex]; if (!Array.isArray(coords) || coords.length < 2) continue;
          const edgePartId = `${row.edge_id}#part:${partIndex}`;
          const candidateId = `ndc-${sha256(`${runId}\0${run.snapshot_id}\0${row.edge_id}\0${partIndex}\0${NVDB_ADAPTER_VERSION}`).slice(0, 24)}`;
          const sourceEvidence = JSON.parse(row.evidence_json ?? '[]');
          out.push({ candidate_id: candidateId, run_id: runId, source_id: source.source_id, snapshot_id: run.snapshot_id,
            edge_id: row.edge_id, part_index: partIndex, classification: selection.classification, physical_state: 'probable',
            motorcycle_access: 'unknown', routability: 'unknown', canonical_status: 'NOT_COMPARED', access_tag_state: selection.access_tag_state,
            length_m: coords.slice(1).reduce((sum, point, index) => sum + lengthMeters(coords[index], point), 0), geometry: { type: 'LineString', coordinates: coords },
            tags, provenance: { source_id: source.source_id, source_revision: source.revision, network_source_id: parent.source_id,
              snapshot_id: snapshot.snapshot_id, snapshot_version: snapshot.version, snapshot_sha256: snapshot.checksum,
              nvdb_segment_id: row.edge_id, adapter_version: NVDB_ADAPTER_VERSION, selection_rule: selection.selection_rule,
              existence_basis: 'official NVDB road-link geometry; physical character remains uncertain where the record does not establish it',
              access_interpretation: 'NVDB road-network presence is not motorcycle permission; motorcycle_access remains unknown',
              canonical_interpretation: 'no canonical dataset supplied; NOT_COMPARED is not NEW', private_network_evidence: sourceEvidence },
            sources: [{ source_id: source.source_id, relationship: 'origin', source_reference: edgePartId,
              evidence: { selection_rule: selection.selection_rule, snapshot_id: run.snapshot_id, claim: 'PHYSICAL_EXISTENCE' } }], matches: [] });
        }
      }
      cursor = row.edge_rowid; examined++;
    }
    for (let i = 0; i < out.length; i += 1000) created += store.saveDiscoveryCandidateBatch(runId, out.slice(i, i + 1000)).inserted;
    store.updateDiscoveryRun(runId, { checkpoint_edge_rowid: cursor, edges_examined: examined, candidates_created: created });
    onProgress({ run_id: runId, edges_examined: examined, candidates_created: created });
  }
  store.updateDiscoveryRun(runId, { status: 'COMPLETE', checkpoint_edge_rowid: cursor, edges_examined: examined, candidates_created: created, last_error: null });
  return { run_id: runId, status: 'COMPLETE', country_code: run.country_code, region_id: run.region_id,
    edges_examined: examined, candidate_count: created, motorcycle_access_unknown: created, routability_unknown: created, canonical_status: 'NOT_COMPARED' };
}
