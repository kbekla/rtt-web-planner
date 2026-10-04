import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from '@playwright/test';
import { createReviewServer } from '../../scripts/scout/review-server.mjs';
import { SCOUT_REVIEW_FIXTURE } from '../../scripts/scout/review-fixtures.mjs';

function get(address,route) { return new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:address.port,path:route},(res)=>{let body='';res.setEncoding('utf8');res.on('data',(chunk)=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));});req.on('error',reject);}); }
test('private review server binds loopback and serves only synthetic, status-dimensional map fixtures',async(t)=>{
  const server=createReviewServer({port:0});await new Promise((resolve)=>server.once('listening',resolve));t.after(()=>new Promise((resolve)=>server.close(resolve)));
  assert.equal(server.address().address,'127.0.0.1');
  const html=await get(server.address(),'/');assert.equal(html.status,200);assert.match(html.body,/PRIVATE DEV.*SYNTHETIC DATA ONLY/);
  const status=await get(server.address(),'/api/status');assert.equal(JSON.parse(status.body).private_data_loaded,false);
  const segments=await get(server.address(),'/api/segments?bbox=-180,-90,180,90');const data=JSON.parse(segments.body);
  assert.equal(data.features.length,SCOUT_REVIEW_FIXTURE.segments.features.length);
  for(const feature of data.features) for(const field of ['classification','match','physical_existence','motorcycle_access','routability','review_state']) assert.ok(field in feature.properties);
  assert.equal((await get(server.address(),'/private/scout.sqlite')).status,404);
  assert.equal((await get(server.address(),'/raw/private.gpx')).status,404);
  assert.equal((await get(server.address(),'/api/segments?bbox=0,91,2,92')).status,400);
  const local=JSON.parse((await get(server.address(),'/api/segments?bbox=7.41,43.73,7.43,43.74')).body);
  assert.equal(local.features.length,SCOUT_REVIEW_FIXTURE.segments.features.length);
  const outside=JSON.parse((await get(server.address(),'/api/segments?bbox=-73,40,-72,41')).body);
  assert.equal(outside.features.length,0);
  assert.equal((await get(server.address(),'/api/segments?bbox=0,0,181,1')).status,400);
  const style=await get(server.address(),'/assets/style.json');assert.equal(style.status,200);assert.match(style.body,/pmtiles:\/\/\/tiles\/monaco.pmtiles/);
  const range=await get(server.address(),'/tiles/monaco.pmtiles');assert.equal(range.status,200);assert.ok(Number(range.headers['content-length'])>100_000);
});

test('private MapLibre reviewer renders route, segmentation, canonical comparison, filtering and inspector',async(t)=>{
  const server=createReviewServer({port:0});await new Promise((resolve)=>server.once('listening',resolve));t.after(()=>new Promise((resolve)=>server.close(resolve)));
  let browser;
  try {
    browser=await chromium.launch({headless:true,timeout:10000});
    const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];
    page.on('pageerror',(error)=>errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__scoutReview?.ready,{timeout:12000});
    assert.deepEqual(await page.evaluate(()=>window.__scoutReview.counts),{source_routes:1,segments:7,canonical:2});
    const hit=await page.evaluate(()=>{const map=window.__scoutMap,point=map.project([7.4245,43.735]);return {id:map.queryRenderedFeatures(point,{layers:['segments-line']})[0]?.properties.id,point};});
    assert.equal(hit.id,'synthetic-road-2');await page.mouse.click(hit.point.x,hit.point.y);
    const inspector=await page.locator('#inspector').textContent();
    for(const field of ['classification','motorcycle_access','physical_existence','routability'])assert.match(inspector,new RegExp(field));
    await page.locator('[data-filter="classification"]').selectOption('PROBABLE_OFFROAD');
    const filters=await page.evaluate(()=>window.__scoutMap.getFilter('segments-line'));
    assert.ok(JSON.stringify(filters).includes('PROBABLE_OFFROAD'));
    const matchStyle=JSON.stringify(await page.evaluate(()=>window.__scoutMap.getPaintProperty('segments-line','line-dasharray')));
    for(const state of ['LIKELY_EXISTING','PARTIAL_OVERLAP','POSSIBLE_PARALLEL','AMBIGUOUS'])assert.ok(matchStyle.includes(state));
    await page.locator('[data-filter="country_code"]').selectOption('MC');
    assert.ok(JSON.stringify(await page.evaluate(()=>window.__scoutMap.getFilter('segments-line'))).includes('country_code'));
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();}
});
