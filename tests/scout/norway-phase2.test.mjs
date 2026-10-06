import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkFrozenNorwayAgainstTet, NORWAY_PHASE1_BASELINE, scoreNorwayRouteFeature, summarizeNorwayBenchmarkFeatures, verifyNorwayPhase2Freeze } from '../../scripts/scout/norway-phase2.mjs';

const route={type:'LineString',coordinates:[[10,60],[10.002,60]]};
const edge=(id,source,geometry,tags={})=>({edge_id:id,source,geometry,tags});

test('Norway route reconstruction treats ordinary paved and gravel roads as full physical support, without access inference',()=>{
  const same={type:'LineString',coordinates:[[10,60],[10.002,60]]};
  const result=scoreNorwayRouteFeature(route,[edge('nvdb:1','NVDB',same,{'nvdb:type_veg':'Enkel bilveg'}),edge('osm:1','OSM',same,{highway:'tertiary',surface:'gravel'})]);
  assert.equal(result.identity,'EXACT_IDENTITY');
  assert.equal(result.coverage,1);
  assert.equal(result.legal_access,'UNKNOWN');
  assert.equal(result.routability,'UNKNOWN');
  assert.equal(result.physical_character_km.GRAVEL_ROAD,Number(result.total_length_km.toFixed(3)));
});

test('parallel geometry inside the search radius is ambiguous, not snapped to one road',()=>{
  const north=route.coordinates.map(([x,y])=>[x,y+0.00005]),south=route.coordinates.map(([x,y])=>[x,y-0.00005]);
  const result=scoreNorwayRouteFeature(route,[edge('osm:north','OSM',{type:'LineString',coordinates:north},{highway:'track'}),edge('nvdb:south','NVDB',{type:'LineString',coordinates:south},{'nvdb:type_veg':'Skogsbilveg'})]);
  assert.equal(result.identity,'AMBIGUOUS_IDENTITY');
  assert.equal(result.ambiguous_km,result.total_length_km);
});

test('a nearer aligned edge cannot silently win over a distinct plausible parallel corridor',()=>{
  const slightlyOffset=route.coordinates.map(([x,y])=>[x,y+0.000025]),farther=route.coordinates.map(([x,y])=>[x,y+0.000075]);
  const result=scoreNorwayRouteFeature(route,[edge('osm:near','OSM',{type:'LineString',coordinates:slightlyOffset},{highway:'track'}),
    edge('nvdb:parallel','NVDB',{type:'LineString',coordinates:farther},{'nvdb:type_veg':'Skogsbilveg'})]);
  assert.equal(result.identity,'AMBIGUOUS_IDENTITY');
  assert.equal(result.unambiguous_km,0);
  assert.equal(result.ambiguous_km,result.total_length_km);
});

test('crossing geometry is rejected by bearing alignment and source road character does not imply access',()=>{
  const crossing={type:'LineString',coordinates:[[10.001,59.999],[10.001,60.001]]};
  const result=scoreNorwayRouteFeature(route,[edge('nvdb:x','NVDB',crossing,{'nvdb:type_veg':'Enkel bilveg'})]);
  assert.equal(result.identity,'NO_CORRIDOR_SUPPORT');
  assert.equal(result.unresolved_km,result.total_length_km);
  assert.equal(result.legal_access,'UNKNOWN');
});

test('length-weighted reconstruction reports ambiguous and unresolved kilometres separately',()=>{
  const result=summarizeNorwayBenchmarkFeatures([
    {result:{total_length_km:10,reconstructed_km:7,ambiguous_km:2,physical_character_km:{GRAVEL_ROAD:5},ambiguous_physical_character_km:{FOREST_ROAD:2}}},
  ]);
  assert.equal(result.independent_network_reconstruction_percent,70);
  assert.equal(result.reconstructed_km,7);assert.equal(result.ambiguous_km,2);assert.equal(result.unresolved_km,1);
  assert.deepEqual(result.physical_character_km,{GRAVEL_ROAD:5});
  assert.deepEqual(result.ambiguous_physical_character_km,{FOREST_ROAD:2});
});

test('frozen TET benchmark verifies the freeze checksum before it opens the comparison file',async()=>{
  await assert.rejects(verifyNorwayPhase2Freeze({root:'/tmp/nonexistent-norway-phase2-fixture'}),/blocked until the independent Norway Phase 2 freeze/);
  await assert.rejects(benchmarkFrozenNorwayAgainstTet({root:'/tmp/nonexistent-norway-phase2-fixture',tetFile:'/path/must-not-be-opened.gpx'}),/blocked until the independent Norway Phase 2 freeze/);
});

test('Phase 1 benchmark figures are a frozen, immutable baseline independent from Phase 2',()=>{
  assert.equal(NORWAY_PHASE1_BASELINE.run_id,'no-phase1-nvdb-20261006');
  assert.equal(NORWAY_PHASE1_BASELINE.edges_examined,3_104_901);
  assert.equal(NORWAY_PHASE1_BASELINE.candidate_pieces,514_859);
  assert.equal(NORWAY_PHASE1_BASELINE.reference_features,17);
  assert.equal(NORWAY_PHASE1_BASELINE.exact,0);assert.equal(NORWAY_PHASE1_BASELINE.partial,0);
  assert.equal(NORWAY_PHASE1_BASELINE.route_processing.road_km,7137.013);
  assert.equal(NORWAY_PHASE1_BASELINE.route_processing.unknown_reasons_km.no_network_match,988.746);
  assert.ok(Object.isFrozen(NORWAY_PHASE1_BASELINE));
});
