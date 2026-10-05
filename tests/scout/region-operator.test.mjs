import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScoutGeoStore } from '../../scripts/scout/geostore.mjs';
import { derivePrivateViewport, resolveGeofabrikCountry } from '../../scripts/scout/geofabrik-index.mjs';
import { approveRegionPlan, prepareRegionPlan } from '../../scripts/scout/region-operator.mjs';

const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'scout-region-intent-'));
const route=`<?xml version="1.0"?><gpx><trk><name>synthetic route</name><trkseg><trkpt lat="45.1" lon="15.2"/><trkpt lat="45.2" lon="15.3"/></trkseg></trk></gpx>`;
const index={type:'FeatureCollection',features:[{type:'Feature',properties:{id:'europe/croatia',name:'Croatia','iso3166-1:alpha2':['HR'],urls:{pbf:'https://download.geofabrik.de/europe/croatia-latest.osm.pbf'}}}]};
function fetchFixture({duplicate=false,mismatchBytes=false,redirectLatest=false}={}){const calls=[];return {calls,fetch:async(url,init={})=>{calls.push([url,init.method??'GET']);if(url==='https://download.geofabrik.de/index-v1-nogeom.json')return new Response(JSON.stringify(duplicate?{...index,features:[...index.features,...index.features]}:index),{status:200});
  const latest=url.endsWith('croatia-latest.osm.pbf'),dated=url.endsWith('croatia-261004.osm.pbf');if(latest&&redirectLatest&&init.method==='HEAD')return new Response(null,{status:307,headers:{location:'https://download.geofabrik.de/europe/croatia-261004.osm.pbf'}});
  if((latest||dated)&&init.method==='HEAD')return new Response(null,{status:200,headers:{'last-modified':'Sun, 04 Oct 2026 21:00:00 GMT','content-length':String(dated&&mismatchBytes?456:123)}});return new Response('unexpected',{status:404});}};}
const intent={private_processing:true,redistribution:false,derived_public_use:false,legal_evidence:false};
test('Geofabrik lookup resolves ISO country metadata to a verified dated URL, never a latest processing URL',async()=>{
  const fixture=fetchFixture(),region=await resolveGeofabrikCountry({countryCode:'HR',regionName:'Croatia',fetchImpl:fixture.fetch});
  assert.equal(region.region_name,'Croatia');assert.equal(region.version,'2026-10-04');assert.equal(region.snapshot_id,'geofabrik-hr-20261004');
  assert.equal(region.url,'https://download.geofabrik.de/europe/croatia-261004.osm.pbf');assert.doesNotMatch(region.url,/latest/i);
  assert.deepEqual(fixture.calls.map(c=>c[1]),['GET','HEAD','HEAD']);assert.equal(region.licence.version,'1.0');assert.match(region.attribution,/OpenStreetMap contributors/);
});
test('Geofabrik same-origin latest redirects are followed and pinned to the dated target',async()=>{
  const fixture=fetchFixture({redirectLatest:true}),region=await resolveGeofabrikCountry({countryCode:'HR',regionName:'Croatia',fetchImpl:fixture.fetch});
  assert.equal(region.version,'2026-10-04');assert.equal(region.url,'https://download.geofabrik.de/europe/croatia-261004.osm.pbf');
  assert.deepEqual(fixture.calls.map(c=>c[0]),['https://download.geofabrik.de/index-v1-nogeom.json','https://download.geofabrik.de/europe/croatia-latest.osm.pbf','https://download.geofabrik.de/europe/croatia-261004.osm.pbf']);
});
test('ambiguous, mismatched, or unverifiable regional provider metadata fails closed',async()=>{
  await assert.rejects(resolveGeofabrikCountry({countryCode:'HR',regionName:'Croatia',fetchImpl:fetchFixture({duplicate:true}).fetch}),/multiple Geofabrik extracts/);
  await assert.rejects(resolveGeofabrikCountry({countryCode:'HR',regionName:'Dalmatia',fetchImpl:fetchFixture().fetch}),/does not uniquely confirm/);
  await assert.rejects(resolveGeofabrikCountry({countryCode:'HR',regionName:'Croatia',fetchImpl:fetchFixture({mismatchBytes:true}).fetch}),/could not be verified/);
});
test('route-selected bounds derive a padded viewport and handle antimeridian wrap',()=>{
  assert.deepEqual(derivePrivateViewport([15.2,45.1,15.3,45.2]),[15.185821,45.09,15.314179,45.21]);
  const wrapped=derivePrivateViewport([179.8,-1,-179.7,1]);assert.ok(wrapped[0]>wrapped[2]);assert.ok(wrapped[0]<180&&wrapped[2]>-180);
});
test('regional prepare hashes only the selected route, preserves explicit permissions, and is idempotent',async()=>{
  const dir=root(),store=new ScoutGeoStore(path.join(dir,'state')),file=path.join(dir,'selected.gpx'),decoy=path.join(dir,'not-selected.gpx');fs.writeFileSync(file,route);fs.writeFileSync(decoy,'not this file');
  try{
    const common={routeFile:file,countryCode:'HR',regionName:'Croatia',sourceName:'Synthetic community source',sourceType:'community-route',permissions:intent,fetchImpl:fetchFixture().fetch,now:new Date('2026-10-04T22:00:00.000Z')};
    const first=await prepareRegionPlan(store,common),again=await prepareRegionPlan(store,common);
    const expected=crypto.createHash('sha256').update(route).digest('hex');assert.equal(first.plan.route_file.sha256,expected);assert.equal(first.run_id,again.run_id);assert.deepEqual(again,first);
    assert.deepEqual(first.plan.permissions,intent);assert.equal(first.plan.route_source.reuse.redistribution,false);assert.equal(first.plan.route_source.reuse.derived_public_use,false);assert.equal(first.plan.route_source.roles.legal_access,false);
    assert.equal(first.plan.route_source.roles.discovery_only,true);assert.equal(first.plan.network_source.network_extract.sha256,undefined);assert.equal(first.plan.network_source.network_extract.checksum_policy,'calculate-after-download');
    assert.equal(first.plan.provider.url,'https://download.geofabrik.de/europe/croatia-261004.osm.pbf');assert.deepEqual(store.listSources(),[],'prepare does not create approvals or register an executable source');
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('regional preparation requires explicit permission choices and explicit terms for broader rights',async()=>{
  const dir=root(),store=new ScoutGeoStore(path.join(dir,'state')),file=path.join(dir,'selected.gpx');fs.writeFileSync(file,route);
  try{
    const base={routeFile:file,countryCode:'HR',regionName:'Croatia',sourceName:'Source',sourceType:'community-route',fetchImpl:fetchFixture().fetch};
    await assert.rejects(prepareRegionPlan(store,{...base,permissions:{...intent,private_processing:false}}),/affirmative private-research/);
    await assert.rejects(prepareRegionPlan(store,{...base,permissions:{...intent,redistribution:true}}),/explicit source licence and attribution/);
    await assert.rejects(prepareRegionPlan(store,{...base,permissions:{...intent,derived_public_use:true}}),/explicit source licence and attribution/);
    await assert.rejects(prepareRegionPlan(store,{...base,permissions:{...intent,legal_evidence:true}}),/cannot be promoted to a legal-evidence source/);
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('approval is a separate deliberate action and never changes selected permission values',async()=>{
  const dir=root(),store=new ScoutGeoStore(path.join(dir,'state')),file=path.join(dir,'selected.gpx');fs.writeFileSync(file,route);
  try{
    const plan=await prepareRegionPlan(store,{routeFile:file,countryCode:'HR',regionName:'Croatia',sourceName:'Synthetic TET hint',sourceType:'community-route',permissions:intent,fetchImpl:fetchFixture().fetch});
    assert.equal(plan.state,'PREPARED');assert.equal(approveRegionPlan(store,{runId:plan.run_id,approvedBy:'Karl',approvalScope:'Private discovery only'}).state,'APPROVED');
    const approved=store.getRegionPlan(plan.run_id);assert.deepEqual(approved.plan.permissions,intent);assert.equal(approved.plan.route_source.reuse.redistribution,false);
    assert.equal(store.sourceApproval(approved.plan.route_source.source_id).scope,'Private discovery only');
    assert.match(store.sourceApproval(approved.plan.network_source.source_id).scope,/licensed Geofabrik OSM/);
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
