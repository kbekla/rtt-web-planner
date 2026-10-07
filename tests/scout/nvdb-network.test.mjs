import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import {
  NVDB_ADAPTER_VERSION, NVDB_API_BASE, NVDB_LINKS_PATH, acquireNvdbSnapshot, importNvdbSnapshot,
  discoverNvdbRun, nvdbDiscoverySelection, nvdbNorwaySourceDefinition, normalizeNvdbPage,
  normalizeNvdbRoadLink, registerNvdbDiscoverySource,
} from '../../scripts/scout/nvdb-network.mjs';
import { getNvdbObjectType, NVDB_OBJECT_TYPE_REGISTRY, nvdbObjectSourceDefinitions, planNvdbObjectAcquisition } from '../../scripts/scout/nvdb-object-registry.mjs';

const wkt = 'LINESTRING Z (500000 6651411 100,500020 6651430 101)';
const link = (sequence, number, typeVeg, category = 'P') => ({
  veglenkesekvensid: sequence,
  veglenkenummer: number,
  segmentnummer: 7,
  kortform: `0.0-1.0@${sequence}-${number}`,
  referanse: `${sequence}-${number}-7`,
  type: 'HOVED',
  typeVeg,
  typeVeg_sosi: typeVeg.toLowerCase().replaceAll(' ', '_'),
  måledato: '2026-08-01',
  geometri: { wkt, srid: 5973, datafangstdato: '2024-05-01', kommune: 4201, lengde: 28 },
  vegsystemreferanse: { vegsystem: { vegkategori: category, fase: 'V', nummer: number }, strekning: { trafikantgruppe: 'K' }, kortform: `P${number}` },
  fylke: 42,
  kommune: 4201,
  adresse: { navn: 'Synthetic fixture road' },
});

test('official NVDB page normalizes road links into private Scout network edges', () => {
  const page = { objekter: [{ veglenkesekvensid: 9001, veglenker: [
    link(9001, 1, 'Enkel bilveg'),
    link(9001, 2, 'Skogsbilveg'),
    link(9001, 3, 'Sti'),
  ] }] };
  const edges = normalizeNvdbPage(page);
  assert.equal(edges.length, 3, 'all three synthetic road links normalize');
  assert.deepEqual(normalizeNvdbPage(page).map(edge => edge.edge_id), edges.map(edge => edge.edge_id),
    'the same source records produce stable network edge identities');
  assert.equal(new Set(edges.map(edge => edge.edge_id)).size, 3);
  for (const edge of edges) {
    assert.equal(edge.geometry.type, 'LineString');
    assert.equal(edge.geometry.coordinates.length, 2);
    assert.ok(edge.geometry.coordinates[0][0] > 14 && edge.geometry.coordinates[0][0] < 16);
    assert.ok(edge.geometry.coordinates[0][1] > 59 && edge.geometry.coordinates[0][1] < 61);
    assert.equal(edge.evidence[0].source_id, 'no-nvdb-vegkart');
    assert.equal(edge.evidence[0].source_record.typeVeg, edge.tags['nvdb:type_veg']);
    assert.equal(edge.jurisdiction_ids[0], 'NO');
  }
  assert.equal(edges[0].tags['nvdb:road_name'], 'Synthetic fixture road');
  assert.equal(edges[1].tags.highway, undefined, 'NVDB typeVeg is preserved without lossy conversion to an OSM highway tag');
  assert.equal(edges[2].tags.highway, undefined, 'pedestrian/cycle source classes remain NVDB classes');
});

test('NVDB source sequence positions and port node IDs survive normalization as topology, without proving access', () => {
  const page={objekter:[{veglenkesekvensid:9010,porter:[
    {id:1,relativPosisjon:0,tilkobling:{nodeid:7001}},{id:2,relativPosisjon:.5,tilkobling:{nodeid:7002}},{id:3,relativPosisjon:1,tilkobling:{nodeid:7003}},
  ],veglenker:[
    {...link(9010,1,'Enkel bilveg'),startposisjon:0,sluttposisjon:.5,startport:1,sluttport:2},
    {...link(9010,2,'Enkel bilveg'),startposisjon:.5,sluttposisjon:1,startport:2,sluttport:3},
  ]}]};
  const [a,b]=normalizeNvdbPage(page),ta=a.evidence[0].topology,tb=b.evidence[0].topology;
  assert.deepEqual({sequence:ta.sequence_id,link:ta.link_number,from:ta.start_node,to:ta.end_node,fromPosition:ta.start_position,toPosition:ta.end_position,state:ta.topology_state},
    {sequence:'9010',link:1,from:'7001',to:'7002',fromPosition:0,toPosition:.5,state:'EXPLICIT_NVDB_NODE_IDS'});
  assert.equal(tb.start_node,'7002');assert.equal(tb.end_node,'7003');
  assert.equal(ta.end_node,tb.start_node,'shared node gives a source-topology continuation');
  assert.equal(a.tags['nvdb:sequence_id'],'9010');assert.equal(a.tags['nvdb:topology_state'],'EXPLICIT_NVDB_NODE_IDS');
  assert.equal(a.evidence[0].claim,'PHYSICAL_EXISTENCE','sequence topology does not create a legal-access claim');
});

test('missing NVDB positions remain unknown and date/version metadata stays provenance only',()=>{
  const edge=normalizeNvdbRoadLink({...link(9011,1,'Skogsbilveg'),startposisjon:null,sluttposisjon:undefined,
    startdato:'2020-01-01',sluttdato:'2025-01-01',oppdateringsdato:'2024-12-01'});
  assert.equal(edge.evidence[0].topology.start_position,null);
  assert.equal(edge.evidence[0].topology.end_position,null);
  assert.equal(edge.tags['nvdb:start_date'],'2020-01-01');
  assert.equal(edge.tags['nvdb:end_date'],'2025-01-01');
  assert.equal(edge.tags['nvdb:source_update_date'],'2024-12-01');
  assert.equal(edge.evidence[0].claim,'PHYSICAL_EXISTENCE','dates and network identity do not claim motorcycle access');
});

test('EPSG:5973 projection handles Norway-wide UTM zone 33 coordinates precisely', () => {
  const fixtures = [
    { e: -148432.253504365, n: 6481751.773865681, lon: 4, lat: 58 },
    { e: 500000.000000001, n: 6651411.190239697, lon: 15, lat: 60 },
    { e: 1104629.435645437, n: 7845845.077572139, lon: 31, lat: 70 },
    { e: 393619.930827458, n: 8774533.543207480, lon: 10, lat: 79 },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const geometry = { wkt: `LINESTRING Z (${fixture.e} ${fixture.n} 10,${fixture.e + 1} ${fixture.n + 1} 11)`, srid: 5973 };
    const first = normalizeNvdbRoadLink({ ...link(8000, index + 1, 'Skogsbilveg'), geometri: geometry }).geometry.coordinates[0];
    const errorMeters = Math.hypot((first[0] - fixture.lon) * 111320 * Math.cos(fixture.lat * Math.PI / 180), (first[1] - fixture.lat) * 111132);
    assert.ok(errorMeters <= 0.01, `fixture ${index + 1} inverse projection error ${errorMeters}m`);
  }
  assert.throws(() => normalizeNvdbRoadLink({ ...link(8001, 1, 'Skogsbilveg'),
    geometri: { wkt: 'LINESTRING Z (500000 9500000 0,500001 9500001 0)', srid: 5973 } }), /Norway geographic envelope/);
});

test('NVDB source policy is private and does not claim legal access, restrictions or public reuse', () => {
  const source = nvdbNorwaySourceDefinition();
  assert.equal(source.source_id, 'no-nvdb-vegkart');
  assert.equal(source.network_api.provider, 'statens-vegvesen-nvdb-api-les-v4');
  assert.equal(source.reuse.private_processing, true);
  assert.equal(source.reuse.redistribution, false);
  assert.equal(source.reuse.derived_public_use, false);
  assert.equal(source.roles.legal_access, false);
  assert.equal(source.roles.restrictions, false);
  assert.equal(source.roles.public_reuse, false);
  assert.ok(source.attribution.includes('Statens vegvesen'));
  assert.equal(source.network_api.endpoint, NVDB_LINKS_PATH);
  assert.equal(new URL(`${NVDB_API_BASE}${NVDB_LINKS_PATH}`).protocol, 'https:');
});

test('NVDB road-link skeleton only creates private engineered-road research leads', () => {
  const privateRoad = normalizeNvdbRoadLink(link(7, 3, 'Enkel bilveg', 'P'));
  assert.equal(nvdbDiscoverySelection(privateRoad.tags), null,
    'private-category ordinary roads remain ordinary network context, not lane candidates');
  const tractorRoad = nvdbDiscoverySelection({ 'nvdb:type_veg': 'Traktorveg' });
  assert.equal(tractorRoad.research_state, 'SCOUT_RESEARCH_REQUIRED');
  assert.equal(tractorRoad.product_projection, 'NOT_PROJECTED');
  assert.equal(tractorRoad.motorcycle_access, 'unknown');
  assert.equal(tractorRoad.routability, 'unknown');
  for (const type of ['Gang- og sykkelveg', 'Fortau', 'Gangveg', 'Sti', 'Sykkelveg', 'Gågate', 'Enkel bilveg']) {
    assert.equal(nvdbDiscoverySelection({ 'nvdb:type_veg': type }), null, `${type} stays context and does not inflate lane leads`);
  }
  assert.equal(nvdbDiscoverySelection({ 'nvdb:type_veg': 'Traktorveg' }).product_projection, 'NOT_PROJECTED');
  assert.equal(nvdbDiscoverySelection({ 'nvdb:type_veg': 'unknown/missing type' }), null);
});

test('Phase 1 road-link skeleton leaves absent surface/access and identifiers absent', () => {
  const raw = link(8, 4, 'Traktorveg');
  delete raw.vegsystemreferanse.strekning.trafikantgruppe;
  delete raw.adresse;
  delete raw.vegsystemreferanse.kortform;
  const edge = normalizeNvdbRoadLink(raw);
  assert.equal(edge.tags['nvdb:type_veg'], 'Traktorveg');
  assert.equal(edge.tags.surface, undefined);
  assert.equal(edge.tags['nvdb:surface'], undefined);
  assert.equal(edge.tags['nvdb:trafikantgruppe'], undefined);
  assert.equal(edge.tags['nvdb:road_name'], undefined);
  assert.equal(edge.tags['nvdb:road_reference'], undefined);
  assert.equal(edge.evidence[0].claim, 'PHYSICAL_EXISTENCE');
});

test('NVDB object candidates remain metadata-gated and acquisition planning is pinned/resumable', () => {
  assert.deepEqual(NVDB_OBJECT_TYPE_REGISTRY.map(x => x.type_id), [241, 856, 485, 607, 23, 913]);
  assert.equal(getNvdbObjectType(241).evidence_roles.includes('SURFACE'), true);
  assert.equal(getNvdbObjectType(241).cannot_support.includes('motorcycle access'), true);
  assert.equal(getNvdbObjectType(856).cannot_support.includes('permission when no object is returned'), true);
  assert.equal(getNvdbObjectType(607).cannot_support.includes('legal prohibition or motorcycle access from physical presence alone'), true);
  const hash='a'.repeat(64);
  assert.throws(() => planNvdbObjectAcquisition({typeIds:[241],catalogueVersion:'current',catalogueSha256:hash}), /definition checksum/);
  const plan=planNvdbObjectAcquisition({typeIds:[241,913],catalogueVersion:'2.x-fixture',catalogueSha256:hash,definitionChecksums:{241:hash,913:hash}});
  assert.equal(plan.status,'REVIEW_REQUIRED');
  assert.equal(plan.immutable_parent_network,true);
  assert.ok(plan.checkpoint.commit_unit.includes('page + page checksum + cursor'));
  assert.ok(plan.checkpoint.admission.includes('shared A17 heavy-work lease'));
  assert.equal(plan.types[0].status,'HELD_FOR_SCHEMA_AND_APPLICABILITY_VALIDATION');
  assert.throws(() => planNvdbObjectAcquisition({typeIds:[999],catalogueVersion:'x',catalogueSha256:hash,definitionChecksums:{999:hash}}), /not in the reviewed candidate registry/);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scout-nvdb-object-registry-')),store=new ScoutGeoStore(root);
  try {
    for(const definition of nvdbObjectSourceDefinitions()){
      const registered=store.registerSource(definition);
      assert.equal(store.sourceApproval(registered.source_id),null,'registered object source is not implicitly approved');
      assert.equal(store.getSource(registered.source_id).source_status,'DISABLED_REVIEW_REQUIRED');
    }
  } finally { store.close(); fs.rmSync(root,{recursive:true,force:true}); }
});

test('NVDB adapter rejects unrecognized pages and unsupported geometry CRS', () => {
  assert.throws(() => normalizeNvdbPage({ items: [] }), /no recognized road-link array/);
  assert.throws(() => normalizeNvdbRoadLink({ ...link(1, 1, 'Sti'), geometri: { wkt, srid: 4326 } }), /SRID 5973/);
});

test('approved paginated NVDB fixture is checksummed, imported and resumes through Scout network storage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-nvdb-fixture-'));
  const store = new ScoutGeoStore(root);
  try {
    const source = nvdbNorwaySourceDefinition();
    store.registerSource(source);
    store.approveSource({ source_id: source.source_id, approved_by: 'fixture owner', scope: 'NVDB adapter fixture only' });
    const first = { objekter: [{ veglenkesekvensid: 9900, veglenker: [link(9900, 1, 'Enkel bilveg'), link(9900, 2, 'Skogsbilveg')] }] };
    const second = { objekter: [{ veglenkesekvensid: 9900, veglenker: [link(9900, 3, 'Sti')] }] };
    const secondUrl = `${NVDB_API_BASE}/vegnett/veglenkesekvenser?antall=1000&start=next`;
    const pages = [first, second];
    const calls = [];
    const fetchImpl = async url => {
      calls.push(url);
      const page = pages.shift();
      if (!page) throw new Error('fixture page exhausted');
      if (page === first) page.metadata = { neste: { href: secondUrl } };
      return { ok: true, status: 200, url, headers: new Headers(), text: async () => JSON.stringify(page) };
    };
    const acquired = await acquireNvdbSnapshot(store, { snapshotId: 'nvdb-no-fixture-v1', dataRoot: path.join(root, 'network'), fetchImpl, requestIntervalMs: 0 });
    assert.equal(acquired.status, 'COMPLETE');
    assert.equal(acquired.pages_written, 2);
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0]).searchParams.has('sortert'), false, 'current production API no longer accepts the legacy sortert parameter');
    const snapshot = store.getNetworkSnapshot('nvdb-no-fixture-v1');
    assert.equal(snapshot.coverage.point_in_time_consistent, false);
    assert.equal(snapshot.coverage.countries[0], 'NO');
    const imported = await importNvdbSnapshot(store, { snapshotId: 'nvdb-no-fixture-v1', batchSize: 2 });
    assert.equal(imported.status, 'COMPLETE');
    assert.equal(imported.links_normalized, 3);
    assert.equal(store.networkEdgeCount('nvdb-no-fixture-v1'), 3);
    assert.equal(store.networkImportCheckpoint('nvdb-no-fixture-v1').normalizer_version, NVDB_ADAPTER_VERSION);
    assert.equal((await importNvdbSnapshot(store, { snapshotId: 'nvdb-no-fixture-v1' })).status, 'REUSED');
    store.setNetworkImportCheckpoint('nvdb-no-fixture-v1', { source_url: store.getNetworkArtifact('nvdb-no-fixture-v1').source_url,
      records_seen: 2, edges_written: 3, status: 'COMPLETE', normalizer_version: 'nvdb-road-link-normalizer-1' });
    const reprojection = await importNvdbSnapshot(store, { snapshotId: 'nvdb-no-fixture-v1', batchSize: 2 });
    assert.equal(reprojection.status, 'COMPLETE');
    assert.equal(reprojection.links_normalized, 3, 'a new normalizer reprojects prior network rows from raw pinned pages');
    assert.equal(store.networkImportCheckpoint('nvdb-no-fixture-v1').normalizer_version, NVDB_ADAPTER_VERSION);
    assert.equal(fs.statSync(store.getNetworkArtifact('nvdb-no-fixture-v1').local_path).mode & 0o777, 0o600);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('NVDB acquisition resumes safely after yielding before the first page', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-nvdb-yield-'));
  const store = new ScoutGeoStore(root);
  try {
    const source = nvdbNorwaySourceDefinition();
    store.registerSource(source);
    store.approveSource({ source_id: source.source_id, approved_by: 'fixture owner', scope: 'NVDB yield fixture only' });
    const fixture = { objekter: [{ veglenkesekvensid: 9901, veglenker: [link(9901, 1, 'Skogsbilveg')] }] };
    let calls = 0;
    const fetchImpl = async url => {
      calls++;
      return { ok: true, status: 200, url, headers: new Headers(), text: async () => JSON.stringify(fixture) };
    };
    const dataRoot = path.join(root, 'network');
    const yielded = await acquireNvdbSnapshot(store, { snapshotId: 'nvdb-yield-before-first-page', dataRoot, fetchImpl, shouldYield: () => true });
    assert.equal(yielded.status, 'YIELDED');
    assert.equal(fs.existsSync(yielded.partial_path), false);
    const resumed = await acquireNvdbSnapshot(store, { snapshotId: 'nvdb-yield-before-first-page', dataRoot, fetchImpl, requestIntervalMs: 0 });
    assert.equal(resumed.status, 'COMPLETE');
    assert.equal(calls, 1);
    assert.equal((await importNvdbSnapshot(store, { snapshotId: 'nvdb-yield-before-first-page' })).links_normalized, 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('NVDB pagination follows only the two documented official collection paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-nvdb-pagination-'));
  const store = new ScoutGeoStore(root);
  try {
    const source = nvdbNorwaySourceDefinition();
    store.registerSource(source);
    store.approveSource({ source_id: source.source_id, approved_by: 'fixture owner', scope: 'pagination allowlist fixture' });
    const body = { objekter: [], metadata: { neste: { href: 'https://example.invalid/steal' } } };
    await assert.rejects(acquireNvdbSnapshot(store, { snapshotId: 'nvdb-bad-pagination-link', dataRoot: path.join(root, 'network'),
      requestIntervalMs: 0, fetchImpl: async url => ({ ok: true, status: 200, url, headers: new Headers(), text: async () => JSON.stringify(body) }) }),
    /escaped the approved official road-link endpoint/);
    assert.equal(store.getNetworkSnapshot('nvdb-bad-pagination-link'), null);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('NVDB snapshot feeds Scout discovery without OSM and never assigns motorcycle access', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-nvdb-discovery-'));
  const store = new ScoutGeoStore(root);
  try {
    const parent = nvdbNorwaySourceDefinition();
    store.registerSource(parent);
    const checksum = 'b'.repeat(64);
    store.recordNetworkSnapshot({ snapshot_id: 'nvdb-discovery-fixture-v1', source_id: parent.source_id, version: 'fixture', checksum,
      licence: { ...parent.licence, attribution: parent.attribution }, coverage: { countries: ['NO'], regions: ['NO'] } });
    store.saveNetworkEdges('nvdb-discovery-fixture-v1', normalizeNvdbPage({ objekter: [{ veglenkesekvensid: 9933,
      veglenker: [link(9933, 1, 'Traktorveg'), link(9933, 2, 'Enkel bilveg', 'E')] }] }));
    const discovery = registerNvdbDiscoverySource(store, 'nvdb-discovery-fixture-v1').source;
    store.approveSource({ source_id: discovery.source_id, approved_by: 'fixture owner', scope: 'independent NVDB test' });
    store.createDiscoveryRun({ run_id: 'no-nvdb-fixture-run', discovery_source_id: discovery.source_id, snapshot_id: 'nvdb-discovery-fixture-v1',
      country_code: 'NO', region_id: 'NO', title: 'Fixture only', viewport: [4, 57, 32, 72],
      approved_by: 'fixture owner', approval_scope: 'independent NVDB test', config: { discovery_version: 'fixture' } });
    const result = discoverNvdbRun(store, 'no-nvdb-fixture-run', { batchSize: 1 });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.edges_examined, 2);
    assert.equal(result.candidate_count, 1, 'tractor-road research lead is selected; ordinary road remains network context');
    const candidate = store.db.prepare('SELECT * FROM discovery_candidates WHERE run_id=?').get('no-nvdb-fixture-run');
    assert.equal(candidate.motorcycle_access, 'unknown');
    assert.equal(candidate.routability, 'unknown');
    assert.equal(candidate.canonical_status, 'NOT_COMPARED');
    assert.equal(JSON.parse(candidate.provenance_json).network_source_id, 'no-nvdb-vegkart');
    assert.equal(JSON.parse(candidate.provenance_json).product_projection, 'NOT_PROJECTED');
    assert.equal(JSON.parse(candidate.provenance_json).research_state, 'SCOUT_RESEARCH_REQUIRED');
    assert.equal(JSON.parse(candidate.provenance_json).private_network_evidence[0].source_record.typeVeg, 'Traktorveg');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
