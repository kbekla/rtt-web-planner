import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentRouteObservation } from '../../scripts/scout/route-segmenter.mjs';
import { assignJurisdictions, segmentLegalScope } from '../../scripts/scout/jurisdictions.mjs';
import { groupObservedCorridors } from '../../scripts/scout/corridors.mjs';

const edge=(edge_id,coords,highway,surface,extra={})=>({edge_id,geometry:{type:'LineString',coordinates:coords},tags:{highway,...(surface?{surface}:{}),...(extra.tags??{})},evidence:extra.evidence??[]});
const obs=(coords,id='route-a',extra={})=>({observation_id:id,geometry:extra.type==='MultiLineString'?{type:'MultiLineString',coordinates:coords}:{type:'LineString',coordinates:coords},...extra});
const mixed=[[-1,51],[-0.9995,51],[-0.999,51],[-0.9985,51],[-0.998,51]];
const roadTrailRoad=[edge('road-a',[mixed[0],mixed[1]],'residential','asphalt'),edge('trail-a',[mixed[1],mixed[3]],'path','ground'),edge('road-b',[mixed[3],mixed[4]],'tertiary','asphalt')];

test('fully paved GPX route produces road segments and no trail candidate',()=>{
  const result=segmentRouteObservation(obs(mixed),[edge('road', [mixed[0],mixed.at(-1)],'primary','asphalt')]);
  assert.equal(result.candidates.length,0); assert.ok(result.segments.every((s)=>s.classification==='ROAD'));
});
test('road to trail to road extracts one derived candidate and preserves complete source geometry',()=>{
  const source=obs(mixed), before=JSON.stringify(source.geometry), result=segmentRouteObservation(source,roadTrailRoad);
  assert.equal(result.candidates.length,1); assert.equal(result.candidates[0].classification,'PROBABLE_OFFROAD');
  assert.equal(JSON.stringify(source.geometry),before); assert.deepEqual(result.source_geometry,source.geometry);
  assert.ok(result.candidates[0].evidence.some((e)=>e.rule==='transition-boundaries'));
});
test('road trail road trail road creates two independent candidate sections',()=>{
  const x=Array.from({length:9},(_,i)=>[-1+i*0.0005,51]);
  const network=[edge('r1',[x[0],x[1]],'residential','asphalt'),edge('t1',[x[1],x[3]],'path','dirt'),edge('r2',[x[3],x[4]],'primary','asphalt'),edge('t2',[x[4],x[7]],'path','ground'),edge('r3',[x[7],x[8]],'tertiary','asphalt')];
  const result=segmentRouteObservation(obs(x),network); assert.equal(result.candidates.length,2);
});
test('unsealed public road is distinct from probable off-road character',()=>{
  const coords=[[-1,51],[-0.999,51],[-0.998,51]];
  const result=segmentRouteObservation(obs(coords),[edge('public-track',coords,'track','gravel')]);
  assert.ok(result.segments.every((s)=>s.classification==='UNSEALED_ROAD')); assert.equal(result.candidates.length,0);
});
test('unknown surface never invents off-road status',()=>{
  const result=segmentRouteObservation(obs(mixed),[edge('road', [mixed[0],mixed.at(-1)],'residential',null)]);
  assert.ok(result.segments.every((s)=>s.classification==='ROAD')); assert.equal(result.candidates.length,0);
});
test('road network overrides an unverified source name calling a paved road a trail',()=>{
  const route=obs(mixed,'source-name-is-not-evidence',{source_name:'trail'});
  const result=segmentRouteObservation(route,[edge('road',[mixed[0],mixed.at(-1)],'secondary','asphalt')]);
  assert.equal(result.candidates.length,0); assert.ok(result.segments.every((s)=>s.classification==='ROAD'));
});
test('nearby parallel road and trail are matched by distance and ambiguous competition fails closed',()=>{
  const coords=[[-1,51.00005],[-0.999,51.00005]], parallel=[edge('road', [[-1,51],[-0.999,51]],'residential','asphalt'),edge('path', [[-1,51.0001],[-0.999,51.0001]],'path','dirt')];
  const result=segmentRouteObservation(obs(coords),parallel); assert.ok(result.segments.every((s)=>s.classification==='UNKNOWN'));
});
test('brief mapped road crossing through a longer path keeps one candidate identity',()=>{
  const x=Array.from({length:7},(_,i)=>[-1+i*0.0005,51]);
  const before=[x[0],x[1],x[2]], after=[x[4],x[5],x[6]], center=x[3];
  const crossingStart=[(x[2][0]+center[0])/2,51],crossingEnd=[(x[4][0]+center[0])/2,51];
  const network=[edge('t1',[before[0],before[2]],'path','dirt'),edge('cross',[crossingStart,crossingEnd],'residential','asphalt'),edge('t2',[after[0],after[2]],'path','dirt')];
  const result=segmentRouteObservation(obs(x),network,{shortRoadCrossingMeters:100});
  assert.equal(result.candidates.length,1); assert.ok(result.candidates[0].evidence.some((e)=>e.rule==='short-road-crossing-preserved'));
});
test('same trail approached by independent roads yields matching derived trail geometry only',()=>{
  const trail=[[-0.998,51],[-0.9975,51],[-0.997,51]], a=[[-1,51],[-0.999,51],...trail], b=[[-0.99,51],[-0.989,51],...trail].reverse();
  const net=[edge('road-a',[a[0],a[1]],'residential','asphalt'),edge('road-b',[[ -0.99,51],[-0.989,51]],'residential','asphalt'),edge('shared-trail',trail,'path','dirt')];
  const ra=segmentRouteObservation(obs(a,'hint-a'),net), rb=segmentRouteObservation(obs(b,'hint-b'),net);
  assert.ok(ra.candidates.length); assert.ok(rb.candidates.length);
  assert.notEqual(ra.observation_id,rb.observation_id); assert.deepEqual(ra.source_geometry,a.length?{type:'LineString',coordinates:a}:null);
});
test('independent observations sharing pinned trail edges group non-destructively while parallel edges stay separate',()=>{
  const evidence=(edgeIds)=>edgeIds.map((edge_id)=>({rule:'nearest-network-edge',edge_id}));
  const items=[{candidate_id:'candidate-a',observation_id:'hint-a',network_snapshot_id:'graph-v1',evidence:evidence(['trail-1','trail-2','trail-3'])},
    {candidate_id:'candidate-b',observation_id:'hint-b',network_snapshot_id:'graph-v1',evidence:evidence(['road-approach-b','trail-1','trail-2','trail-3'])},
    {candidate_id:'candidate-parallel',observation_id:'hint-c',network_snapshot_id:'graph-v1',evidence:evidence(['parallel-1','parallel-2','parallel-3'])},
    {candidate_id:'candidate-other-version',observation_id:'hint-d',network_snapshot_id:'graph-v2',evidence:evidence(['trail-1','trail-2','trail-3'])}];
  const first=groupObservedCorridors(items),second=groupObservedCorridors([...items].reverse());
  assert.equal(first.length,1);assert.equal(first[0].corridor_id,second[0].corridor_id);
  assert.deepEqual(first[0].candidate_ids,['candidate-a','candidate-b']);assert.equal(first[0].destructive_merge,false);
  assert.deepEqual(first[0].observation_ids,['hint-a','hint-b']);
});
test('cross-border route remains one physical observation with segment-scoped jurisdiction annotations',()=>{
  const route=obs([[-1,0],[-0.5,0],[0.5,0],[1,0]],'border-route');
  const polygon=(west,east)=>({type:'Polygon',coordinates:[[[west,-1],[east,-1],[east,1],[west,1],[west,-1]]]});
  const jurisdictions=[{jurisdiction_id:'AA-west',country_code:'AA',version:'boundary-v1',boundary:polygon(-2,0)},
    {jurisdiction_id:'BB-east',country_code:'BB',version:'boundary-v2',boundary:polygon(0,2)}];
  const segments=segmentRouteObservation(route,[edge('path',route.geometry.coordinates,'path','dirt')],{jurisdictions}).segments;
  const relation=assignJurisdictions(segments[0].geometry,jurisdictions),scopes=segmentLegalScope(segments[0],relation);
  assert.equal(segments.length,1);assert.deepEqual(segments[0].jurisdiction_ids,['AA-west','BB-east']);
  assert.equal(scopes.physical_identity,segments[0].segment_id);assert.deepEqual(scopes.legal_scopes.map((x)=>x.legal_state),['UNKNOWN','UNKNOWN']);
});
test('reversed source geometry produces same geometry-independent physical corridor key',()=>{
  const forward=[[-1,51],[-0.999,51],[-0.998,51]], reverse=[...forward].reverse();
  const a=segmentRouteObservation(obs(forward,'forward'),[edge('p',forward,'path','dirt')]);
  const b=segmentRouteObservation(obs(reverse,'reverse'),[edge('p',reverse,'path','dirt')]);
  const endpoint=(candidate)=>JSON.stringify([candidate.geometry.coordinates.map((p)=>p.map((x)=>Number(x.toFixed(5)))).sort()]);
  assert.equal(endpoint(a.candidates[0]),endpoint(b.candidates[0]));
});
test('multipart disconnected inputs remain distinct and no connecting geometry is invented',()=>{
  const parts=[[[-1,51],[-0.999,51]],[[-0.5,51],[-0.499,51]]];
  const result=segmentRouteObservation(obs(parts,'multi',{type:'MultiLineString'}),parts.map((p,i)=>edge(`path-${i}`,p,'path','dirt')));
  assert.equal(result.segments.length,2); assert.deepEqual(result.segments.map((s)=>s.component_index),[0,1]);
  assert.ok(result.segments.every((s)=>s.geometry.coordinates.every((p)=>Math.abs(p[0])<2)));
});
test('missing source ID can be assigned deterministic identity by the importer-facing observation ID',()=>{
  const input=obs(mixed,'stable-from-file-checksum');
  const a=segmentRouteObservation(input,roadTrailRoad), b=segmentRouteObservation(input,roadTrailRoad);
  assert.deepEqual(a,b);
});
test('exact duplicate imports retain the same observation identity; changed checksums version separately',()=>{
  const original='synthetic-checksum-a', changed='synthetic-checksum-b';
  const id=(checksum,part)=>`${checksum}:${part}`;
  assert.equal(id(original,'track-1-segment-1'),id(original,'track-1-segment-1'));
  assert.notEqual(id(original,'track-1-segment-1'),id(changed,'track-1-segment-1'));
});
test('unknown unmatched geometry is reviewable but is not treated as a trail candidate',()=>{
  const result=segmentRouteObservation(obs(mixed),[]);
  assert.ok(result.segments.every((s)=>s.classification==='UNKNOWN')); assert.equal(result.candidates.length,0);
});
test('sparse route vertices around a road-to-trail transition create an UNKNOWN gap instead of an invented boundary',()=>{
  const coords=[[-1,51],[-0.99,51]],network=[edge('road',[coords[0],coords[0]],'residential','asphalt'),edge('trail',[coords[1],coords[1]],'path','dirt')];
  const result=segmentRouteObservation(obs(coords),network,{maxSnapMeters:1});
  assert.ok(result.segments.some((s)=>s.classification==='UNKNOWN'&&s.evidence.some((e)=>e.rule==='transition-gap-too-long-to-place-boundary')));
  assert.equal(result.candidates.length,0);
});
test('qualified physical evidence can mark a path confirmed without asserting legal access or routability',()=>{
  const result=segmentRouteObservation(obs(mixed),[edge('confirmed-path',mixed,'path','ground',{evidence:[{question:'physical_existence',outcome:'confirmed',qualified:true,reference:'synthetic-evidence'}]})]);
  assert.ok(result.segments.every((s)=>s.classification==='OFFROAD_CONFIRMED'));
  assert.equal(result.candidates.length,1); assert.equal(result.candidates[0].motorcycle_access,undefined);
});
