import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopologyCorridors, deriveOperationalState, evaluateMotorcycleAccess, inferCorridorLineage, sourceAutomationDecision, validateLegalStatusRecord, communityClaimEffect } from '../../scripts/scout/corridor-evidence.mjs';
import { parseOsmiumOplWay, recordCorridorReview, triageCorridorReviewQueue } from '../../scripts/scout/osm-topology.mjs';
import { registerOsmDiscoverySource } from '../../scripts/scout/osm-discovery.mjs';
import { sourcePollDecision, saveLegalStatusRecord, saveCommunityClaim, refreshCommunityFreshness, registerPartnerLayer, recordSourceFetch, recordSourceFailure } from '../../scripts/scout/watchkeeper.mjs';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const feature = (id, nodes, classification = 'PROBABLE_OFFROAD', reverse = false, tags = {}) => {
  const coordinates = nodes.map((_, i) => [4 + i * 0.001, 50]); if (reverse) coordinates.reverse();
  return { candidate_id: id, edge_id: `osm:way:${id.slice(1)}`, part_index: 0, classification, physical_state: 'probable', length_m: 100,
    geometry: { type: 'LineString', coordinates }, tags };
};
const runCorridors = (items, wayNodes, nodeDegree, run = 'run-a') => [...buildTopologyCorridors({ candidates: items, wayNodes: new Map(wayNodes), nodeDegree: new Map(nodeDegree), snapshotId: 'snapshot-a', runId: run })];

test('corridor identity survives way split/join and reversal through shared mapped topology', () => {
  const split = runCorridors([feature('w1', ['1', '2']), feature('w2', ['2', '3'])], [['osm:way:1', ['1', '2']], ['osm:way:2', ['2', '3']]], [['1', 1], ['2', 2], ['3', 1]]);
  const joined = runCorridors([feature('w3', ['1', '2', '3'], 'PROBABLE_OFFROAD', true)], [['osm:way:3', ['3', '2', '1']]], [['1', 1], ['2', 2], ['3', 1]], 'run-b');
  assert.equal(split.length, 1); assert.equal(joined.length, 1); assert.equal(split[0].corridor_id, joined[0].corridor_id);
  assert.deepEqual(split[0].node_sequence, ['1', '2', '3']);
});

test('parallel paths, coordinate crossings without shared nodes, and real junctions remain separate', () => {
  const roads = [feature('w10', ['1', 'a', '2']), feature('w11', ['1', 'b', '2']), feature('w12', ['cross-a', 'cross-b'])];
  const refById = new Map([['osm:way:10',['1','a','2']],['osm:way:11',['1','b','2']],['osm:way:12',['cross-a','cross-b']]]);
  const result = runCorridors(roads, refById, [['1', 4], ['2', 4], ['cross-a', 1], ['cross-b', 1], ['a',2],['b',2]]);
  assert.equal(result.length, 3); assert.ok(result.every(r => r.candidate_ids.length === 1));
});

test('duplicate observations of one exact OSM node path share corridor identity without losing provenance', () => {
  const items=[feature('w40',['1','2','3']),feature('w41',['1','2','3'])];
  const result=runCorridors(items,items.map(row=>[row.edge_id,['1','2','3']]),[['1',4],['2',4],['3',4]]);
  assert.equal(result.length,1); assert.equal(result[0].candidate_ids.length,2); assert.equal(result[0].identity_state,'TOPOLOGY_BACKED');
});

test('cross-snapshot corridor identity follows only unique continuous node lineage and flags split/merge',()=>{
  const prior=[{corridor_id:'old-a',corridor_version_id:'old-v',node_sequence:['1','2','3','4','5']}];
  const continued=inferCorridorLineage(prior,[{corridor_id:'new-a',corridor_version_id:'new-v',node_sequence:['0','1','2','3','4','5','6']}]);
  assert.equal(continued[0].relation,'CONTINUES');assert.equal(continued[0].retain_prior_identity,true);
  const split=inferCorridorLineage(prior,[{corridor_id:'new-a',corridor_version_id:'new-v1',node_sequence:['1','2','3']},{corridor_id:'new-b',corridor_version_id:'new-v2',node_sequence:['3','4','5']}]);
  assert.equal(split.length,2);assert.ok(split.every(pair=>pair.relation==='SPLIT'&&pair.match_state==='REVIEW_REQUIRED'));
  assert.deepEqual(inferCorridorLineage(prior,[{corridor_id:'new-unknown',corridor_version_id:'v',node_sequence:['a','b','c','d']}]),[]);
});

test('shared node chains stop at a branch and never fill ambiguous/missing topology gaps', () => {
  const items = [feature('w20', ['1', '2']), feature('w21', ['2', '3']), feature('w22', ['2', '4'])];
  const result = runCorridors(items, items.map(r => [r.edge_id, r.edge_id.endsWith('20') ? ['1', '2'] : r.edge_id.endsWith('21') ? ['2', '3'] : ['2', '4']]), [['1', 1], ['2', 3], ['3', 1], ['4', 1]]);
  assert.equal(result.length, 3);
  const unresolved = runCorridors([feature('w30', ['1', '2'])], [], []);
  assert.equal(unresolved[0].identity_state, 'REVIEW_REQUIRED'); assert.equal(unresolved[0].motorcycle_access, 'unknown');
});

test('OSM OPL parser preserves way version and ordered node references', () => {
  assert.deepEqual(parseOsmiumOplWay('w123 v7 dV c0 t2026-10-03T20:20:50Z i0 u Thighway=track,name=Green%20%Lane Nn4,n5,n6'),
    { way_id: 'osm:way:123', osm_version: 7, node_refs: ['4', '5', '6'], complete: true });
  assert.equal(parseOsmiumOplWay('n123 v1 dV c0 t2026-01-01T00:00:00Z i0 u T x4 y50'), null);
  assert.equal(parseOsmiumOplWay('w124 v1 dV c0 t2026-01-01T00:00:00Z i0 u Thighway=track Nn4,n?').complete, false);
});

const legal = (overrides = {}) => ({ source_id: 'authority', source_version: '2026-1', jurisdiction_id: 'be-wallonia', claim_type: 'TEMPORARY_RESTRICTION',
  legal_effect: 'PROHIBIT_MOTORCYCLE', temporal_kind: 'TEMPORARY', effective_from: '2026-10-01T00:00:00Z', effective_until: '2026-10-31T23:59:59Z',
  published_at: '2026-09-29T10:00:00Z', retrieved_at: '2026-10-02T10:00:00Z', vehicle_classes: ['motorcycle'], motorcycle_applicability: true,
  geometry_reference: { id: 'authority-segment-1' }, geometry_identity: 'MATCHED', jurisdiction_identity: 'MATCHED', source_document_reference: 'private-doc:hash-1', extraction: 'HUMAN_VERIFIED', review_state: 'VERIFIED',
  qualified: true, authority_category: 'AUTHORITATIVE', status_record_id: 'order-1', ...overrides });

test('current authoritative restriction overrides older permission, expiry restores underlying permission only while valid', () => {
  const permit = legal({ status_record_id: 'permit', claim_type: 'LEGAL_ACCESS', legal_effect: 'PERMIT_MOTORCYCLE', temporal_kind: 'PERMANENT', effective_from: '2020-01-01T00:00:00Z', effective_until: null });
  const ban = legal();
  const matched = { geometryIdentity: 'MATCHED', jurisdictionIdentity: 'MATCHED' };
  assert.equal(evaluateMotorcycleAccess([permit, ban], { at: '2026-10-05T12:00:00Z', ...matched }).operational_state, 'TEMPORARILY_CLOSED');
  assert.equal(evaluateMotorcycleAccess([permit, ban], { at: '2026-11-01T00:00:00Z', ...matched }).access, 'confirmed');
  assert.equal(evaluateMotorcycleAccess([ban], { at: '2026-11-01T00:00:00Z', ...matched }).access, 'unknown');
  const sameTimePermission=legal({status_record_id:'conflicting-permit',claim_type:'LEGAL_ACCESS',legal_effect:'PERMIT_MOTORCYCLE',temporal_kind:'PERMANENT',effective_from:'2020-01-01T00:00:00Z',effective_until:null});
  const conflict=evaluateMotorcycleAccess([ban,sameTimePermission],{at:'2026-10-05T12:00:00Z', ...matched});
  assert.equal(conflict.operational_state,'TEMPORARILY_CLOSED');assert.equal(conflict.contradiction,true);assert.equal(conflict.contradiction_state,'REVIEW_REQUIRED');
});

test('amendment supersedes original expiry; future amendment does not prematurely replace active order', () => {
  const original = legal({ effective_until: '2026-10-10T00:00:00Z' });
  const amendment = legal({ status_record_id: 'order-2', effective_from: '2026-10-08T00:00:00Z', effective_until: '2026-11-15T00:00:00Z', supersedes_record_id: 'order-1' });
  const matched = { geometryIdentity: 'MATCHED', jurisdictionIdentity: 'MATCHED' };
  assert.equal(evaluateMotorcycleAccess([original, amendment], { at: '2026-10-09T00:00:00Z', ...matched }).evidence_ids[0], 'order-2');
  const scheduled = { ...amendment, effective_from: '2026-10-20T00:00:00Z', effective_until: '2026-12-01T00:00:00Z' };
  assert.equal(evaluateMotorcycleAccess([original, scheduled], { at: '2026-10-09T00:00:00Z', ...matched }).evidence_ids[0], 'order-1');
});

test('parallel legal geometry aliases fail closed and access is independent from routability', () => {
  assert.equal(evaluateMotorcycleAccess([legal()]).operational_state, 'REVIEW_REQUIRED');
  assert.equal(evaluateMotorcycleAccess([legal()], { geometryIdentity: 'AMBIGUOUS', jurisdictionIdentity: 'MATCHED' }).operational_state, 'REVIEW_REQUIRED');
  assert.equal(deriveOperationalState({ physical: 'confirmed', access: 'unknown', routability: 'yes' }), 'VISIBLE_NOT_ROUTABLE');
  assert.equal(deriveOperationalState({ physical: 'confirmed', access: 'confirmed', routability: 'yes' }), 'ROUTABLE');
  assert.equal(deriveOperationalState({ physical: 'confirmed', access: 'temporarily_restricted', routability: 'yes' }), 'TEMPORARILY_CLOSED');
  assert.equal(deriveOperationalState({ physical: 'confirmed', access: 'prohibited', routability: 'yes' }), 'RESTRICTED_OR_REJECTED');
  assert.equal(deriveOperationalState({ physical: 'confirmed', access: 'prohibited', routability: 'yes', accessEvaluation: { operational_state: 'RESTRICTED_OR_REJECTED' } }), 'RESTRICTED_OR_REJECTED');
});

test('physical existence remains intact during closure, while community and OSM access labels cannot create legal permission', () => {
  const closed=evaluateMotorcycleAccess([legal()],{at:'2026-10-05T12:00:00Z',geometryIdentity:'MATCHED',jurisdictionIdentity:'MATCHED'});
  const physical={state:'probable',source:'osm-way:synthetic',access:closed.access,routability:'unknown'};
  assert.equal(physical.state,'probable');assert.equal(physical.access,'temporarily_restricted');
  assert.equal(communityClaimEffect({source_id:'rider',claim_type:'LEGAL_SIGNAGE_REPORTED',observed_at:'2026-10-05T00:00:00Z'},{at:'2026-10-05T12:00:00Z'}).access_effect,'none');
  assert.equal(sourceAutomationDecision({licence:{name:'ODbL',version:'1.0'},reuse:{private_processing:true},roles:{discovery_only:true,legal_access:false}}).allowed,true);
  assert.equal(evaluateMotorcycleAccess([],{}).access,'unknown');
});

test('community traversal affects physical corroboration only and stale history remains', () => {
  const claim = { source_id: 'rider:synthetic', source_reference: 'report-1', claim_type: 'TRAVERSED', observed_at: '2026-10-01T00:00:00Z' };
  assert.deepEqual(communityClaimEffect(claim, { at: '2026-10-05T00:00:00Z' }), { physical_effect: 'corroboration', access_effect: 'none', fresh: true, historical_record_retained: true });
  assert.equal(communityClaimEffect(claim, { at: '2027-07-01T00:00:00Z' }).fresh, false);
  assert.equal(communityClaimEffect(claim, { at: '2027-07-01T00:00:00Z' }).access_effect, 'none');
});

test('OSM and unclear licence sources are not promoted to authoritative legal evidence', () => {
  assert.equal(sourceAutomationDecision({ licence: { name: 'ODbL', version: '1.0' }, reuse: { private_processing: true }, roles: { discovery_only: true } }).allowed, true);
  assert.equal(sourceAutomationDecision({ licence: {}, reuse: { private_processing: true }, roles: {} }).allowed, false);
  assert.throws(() => validateLegalStatusRecord(legal(), { reuse: { private_processing: true }, roles: { discovery_only: true } }), /legal-access evidence/);
});

test('Watchkeeper records source changes, bounded failures, private legal records and partner separation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-evidence-')); fs.chmodSync(root, 0o700);
  const store = new ScoutGeoStore(root);
  try {
    const source = { source_id: 'authority', name: 'Synthetic Authority', type: 'government', organisation: 'Synthetic Authority', expected_formats: ['GeoJSON'],
      coverage: { countries: ['BE'], regions: ['Wallonia'] }, jurisdiction_ids: ['be-wallonia'], location: 'fixture://authority', adapter_version: 'fixture-1',
      licence: { name: 'Open Data', version: '1' }, attribution: 'Synthetic', rate_limits: { requests_per_second: 1 }, authority: { category: 'AUTHORITATIVE' },
      roles: { discovery_only: false, physical_existence: false, legal_access: true, routing_network: false, public_reuse: false, jurisdiction_boundaries: false },
      reuse: { private_processing: true, redistribution: false, derived_public_use: false }, update: { mechanism: 'synthetic fixture', poll_interval_seconds: 3600, retry_policy: { base_seconds: 5, max_seconds: 20, max_retries: 2 } } };
    store.registerSource(source); store.approveSource({ source_id: source.source_id, approved_by: 'test', scope: 'synthetic legal model' });
    store.db.prepare(`INSERT INTO jurisdictions(jurisdiction_id,country_code,version,boundary_json,metadata_json) VALUES('be-wallonia','BE','v1','{}','{}')`).run();
    assert.equal(sourcePollDecision(source, null).state,'REVIEW_REQUIRED');
    assert.equal(sourcePollDecision(source, null,new Date(),{approved:true}).due, true);
    const f1 = recordSourceFetch(store, { sourceId: source.source_id, version: '1', sha256: 'a'.repeat(64), retrievedAt: '2026-10-01T00:00:00Z' });
    const f2 = recordSourceFetch(store, { sourceId: source.source_id, version: '2', sha256: 'b'.repeat(64), retrievedAt: '2026-10-02T00:00:00Z' });
    assert.equal(f1.event_type, 'INITIAL_SNAPSHOT'); assert.equal(f2.event_type, 'SOURCE_CHANGED');
    assert.equal(recordSourceFailure(store, { sourceId: source.source_id, errorCode: 'HTTP_503', failedAt: '2026-10-03T00:00:00Z' }).state, 'AMBER');
    recordSourceFailure(store,{sourceId:source.source_id,errorCode:'HTTP_503',failedAt:'2026-10-03T00:00:05Z'});
    assert.equal(recordSourceFailure(store,{sourceId:source.source_id,errorCode:'HTTP_503',failedAt:'2026-10-03T00:00:15Z'}).state,'RED');
    store.db.prepare(`INSERT INTO physical_corridors(corridor_id,identity_scheme,created_at,last_seen_at) VALUES('corr-test','test','2026-10-01','2026-10-01')`).run();
    assert.throws(() => saveLegalStatusRecord(store, legal({ source_id: source.source_id, corridor_id: 'corr-test', source_document_reference: undefined, geometry_reference: { id: 'g' } })), /source document/);
    const saved = saveLegalStatusRecord(store, legal({ source_id: source.source_id, corridor_id: 'corr-test', source_document_reference: 'doc:private', geometry_reference: { id: 'g' } }));
    assert.equal(saved.qualified, true);
    const rider = { source_id: 'rider', source_reference: 'same-report', claim_type: 'TRAVERSED', observed_at: '2026-10-01T00:00:00Z' };
    store.registerSource({ ...source, source_id: 'rider', name: 'Rider report', type: 'community', organisation: 'Synthetic rider', roles: { discovery_only: true, physical_existence: true, legal_access: false, routing_network: false, public_reuse: false, jurisdiction_boundaries: false },
      reuse: { private_processing: true, redistribution: false, derived_public_use: false }, authority: { category: 'COMMUNITY' } });
    store.approveSource({ source_id:'rider',approved_by:'test',scope:'synthetic community observations' });
    assert.equal(saveCommunityClaim(store, rider, { now: '2026-10-02T00:00:00Z' }).access_effect, 'none');
    const original=saveCommunityClaim(store, rider, { now: '2026-10-02T00:00:00Z' });
    assert.equal(saveCommunityClaim(store, rider, { now: '2026-10-02T00:00:00Z' }).claim_id, original.claim_id);
    store.registerSource({ ...source, source_id: 'rider-copy', name: 'Copied rider report', organisation: 'Synthetic mirror', roles: { discovery_only: true, physical_existence: true, legal_access: false, routing_network: false, public_reuse: false, jurisdiction_boundaries: false },
      reuse: { private_processing: true, redistribution: false, derived_public_use: false }, authority: { category: 'COMMUNITY' } });
    store.approveSource({ source_id:'rider-copy',approved_by:'test',scope:'synthetic duplicate report' });
    saveCommunityClaim(store,{...rider,source_id:'rider-copy'},{now:'2026-10-02T00:00:00Z'});
    assert.equal(store.db.prepare('SELECT count(DISTINCT independence_group) n FROM community_claims').get().n,1,'mirrored copies of one report are one independent source');
    assert.deepEqual(refreshCommunityFreshness(store,{now:'2027-07-01T00:00:00Z'}),{checked:2,became_stale:2,became_fresh:0,history_deleted:0});
    assert.throws(() => registerPartnerLayer(store, { source_id: 'authority', owner: 'partner', audience: 'members', permission_reference: 'none', storage_boundary: 'separate', attribution: 'partner', permission_confirmed: false }), /explicit permission/);
    const layer = registerPartnerLayer(store, { source_id: 'authority', owner: 'partner', audience: 'members', permission_reference: 'agreement:synthetic', storage_boundary: 'separate-partner-store', attribution: 'partner', permission_confirmed: true });
    assert.equal(layer.active, false);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('corridor triage checkpoints, queues corroboration/identity issues, suppresses catalog-only fragments and retains research decisions',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scout-corridor-triage-'));fs.chmodSync(root,0o700);const store=new ScoutGeoStore(root);
  try{
    const network={source_id:'triage-network',name:'Synthetic OSM',type:'regional-network',organisation:'Synthetic',expected_formats:['pbf'],coverage:{countries:['BE'],regions:['BE']},jurisdiction_ids:[],location:'fixture://pbf',adapter_version:'fixture',licence:{name:'ODbL',version:'1.0'},attribution:'© OpenStreetMap contributors',reuse:{private_processing:true,redistribution:true,derived_public_use:false},roles:{discovery_only:false,physical_existence:false,legal_access:false,routing_network:true,public_reuse:true,jurisdiction_boundaries:false},update:{mechanism:'fixture'},rate_limits:{requests_per_minute:0}};
    store.registerSource(network);store.recordNetworkSnapshot({snapshot_id:'triage-snapshot',source_id:network.source_id,version:'fixture-1',checksum:'a'.repeat(64),licence:network.licence,coverage:{countries:['BE'],regions:['BE']}});
    store.saveNetworkEdge('triage-snapshot',{edge_id:'w-1',geometry:{type:'LineString',coordinates:[[4,50],[4.01,50.01]]},tags:{highway:'track'},evidence:{},jurisdiction_ids:[]});
    const registered=registerOsmDiscoverySource(store,'triage-snapshot');store.approveSource({source_id:registered.source.source_id,approved_by:'test',scope:'triage fixture'});
    store.createDiscoveryRun({run_id:'triage-run',discovery_source_id:registered.source.source_id,snapshot_id:'triage-snapshot',country_code:'BE',region_id:'BE',title:'triage',viewport:[3,49,5,51],approved_by:'test',approval_scope:'triage fixture'});
    const candidates=Array.from({length:4},(_,i)=>({candidate_id:`triage-candidate-${i}`,source_id:registered.source.source_id,snapshot_id:'triage-snapshot',edge_id:`w-${i}`,part_index:0,classification:'PROBABLE_OFFROAD',physical_state:'probable',motorcycle_access:'unknown',routability:'unknown',canonical_status:'NOT_COMPARED',access_tag_state:'NO_EXPLICIT_ACCESS_TAG',length_m:100,geometry:{type:'LineString',coordinates:[[4,50+i*0.001],[4.01,50.01+i*0.001]]},tags:{highway:'track'},provenance:{},matches:i===0?[{related_type:'route_candidate',related_id:'tet-hint',relationship:'same_osm_network_part_support',evidence:{}}]:[]}));
    store.saveDiscoveryCandidateBatch('triage-run',candidates);
    for(let i=0;i<150;i++){
      const corridor=`corr-${String(i).padStart(3,'0')}`,version=`cv-${String(i).padStart(3,'0')}`,candidate=candidates[i%4].candidate_id,identity=i===2?'REVIEW_REQUIRED':'TOPOLOGY_BACKED',priority=i===1?'LOW_VALUE_FOR_MOTORCYCLE_DISCOVERY':i===0?'CORROBORATED_DISCOVERY':'CATALOG_ONLY';
      store.db.prepare("INSERT INTO physical_corridors(corridor_id,identity_scheme,created_at,last_seen_at) VALUES(?,'fixture','2026-10-01','2026-10-01')").run(corridor);
      store.db.prepare(`INSERT INTO physical_corridor_versions(corridor_version_id,corridor_id,run_id,snapshot_id,algorithm_version,classification,physical_existence,motorcycle_access,routability,canonical_status,review_priority,length_m,node_sequence_hash,node_sequence_json,identity_state,geometry_json,evidence_json,created_at)
        VALUES(?,?,'triage-run','triage-snapshot','fixture','PROBABLE_OFFROAD','probable','unknown','unknown','NOT_COMPARED',?,100,?,'["1","2","3"]',?,'null','{}','2026-10-01')`).run(version,corridor,priority,String(i).padStart(64,'0'),identity);
      store.db.prepare("INSERT INTO physical_corridor_observations(corridor_version_id,candidate_id,relation) VALUES(?,?,'OSM_WAY_PART_OBSERVATION')").run(version,candidate);
      store.db.prepare("INSERT INTO corridor_review_queue(corridor_version_id,corridor_id,state,reason_code,priority,ranking_json,updated_at) VALUES(?,?,'UNREVIEWED','fixture','NORMAL_REVIEW','{}','2026-10-01')").run(version,corridor);
    }
    const first=triageCorridorReviewQueue(store,{runId:'triage-run',batchSize:100,shouldYield:()=>true});assert.deepEqual(first,{status:'BLOCKED',processed:100,resumable:true});
    const resumed=triageCorridorReviewQueue(store,{runId:'triage-run',batchSize:100});assert.deepEqual(resumed,{status:'COMPLETE',processed:150});
    const states=store.db.prepare('SELECT state,count(*) n FROM corridor_review_queue GROUP BY state').all().map(r=>[r.state,Number(r.n)]).sort();
    assert.deepEqual(states,[['AMBIGUOUS',1],['CATALOGUED',110],['LOW_VALUE',1],['UNREVIEWED',38]].sort());
    recordCorridorReview(store,{corridorId:'corr-003',decision:'INTERESTING',reviewer:'Karl',reason:'Synthetic manual research review'});
    assert.deepEqual(triageCorridorReviewQueue(store,{runId:'triage-run'}),{status:'REUSED',processed:150});
    assert.equal(store.db.prepare("SELECT state FROM corridor_review_queue WHERE corridor_id='corr-003'").get().state,'INTERESTING');
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
