#!/usr/bin/env node
// Private development reviewer. It binds only to loopback and the API below
// contains synthetic fixture data, never Scout's raw/private storage.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FACTORY, REPO } from '../lib/common.mjs';
import { SCOUT_REVIEW_FIXTURE } from './review-fixtures.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.pbf':'application/x-protobuf','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
const safeInside=(base,relative)=>{const resolved=path.resolve(base,relative);return resolved===base||resolved.startsWith(base+path.sep)?resolved:null;};
function reply(res,status,body,type='text/plain; charset=utf-8',headers={}) { res.writeHead(status,{'content-type':type,'x-content-type-options':'nosniff','cache-control':'no-store',
  'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'",...headers});res.end(body); }

function longitudeIntervals(longitudes) {
  const values=[...new Set(longitudes.map((value)=>(((value+180)%360)+360)%360))].sort((a,b)=>a-b);
  if(!values.length)return [];
  let largest=-1,gapIndex=0;
  for(let i=0;i<values.length;i++) {
    const next=i===values.length-1?values[0]+360:values[i+1],gap=next-values[i];
    if(gap>largest){largest=gap;gapIndex=i;}
  }
  const start=values[(gapIndex+1)%values.length],end=values[gapIndex];
  if(start<=end)return [[start,end]];
  return [[start,360],[0,end]];
}
function bboxIntersects(geometry,bbox) {
  const points=[];
  const walk=(value)=>{if(Array.isArray(value)&&value.length>=2&&typeof value[0]==='number'&&typeof value[1]==='number')points.push(value);else if(Array.isArray(value))value.forEach(walk);};
  walk(geometry?.coordinates);
  if(!points.length)return false;
  const minLat=Math.min(...points.map((p)=>p[1])),maxLat=Math.max(...points.map((p)=>p[1]));
  if(minLat>bbox[3]||maxLat<bbox[1])return false;
  const featureIntervals=longitudeIntervals(points.map((p)=>p[0]));
  const queryIntervals=bbox[0]<=bbox[2]?[[bbox[0]+180,bbox[2]+180]]:[[bbox[0]+180,360],[0,bbox[2]+180]];
  return featureIntervals.some(([a,b])=>queryIntervals.some(([c,d])=>a<=d&&c<=b));
}

export function createReviewServer({port=0,basemapStyle=path.join(FACTORY,'assets/styles/monaco/style.json'),basemapTiles=path.join(FACTORY,'output/monaco/current/monaco.pmtiles')}={}) {
  const repoVendor=path.join(REPO,'node_modules');
  const mapRoot=path.join(FACTORY,'assets');
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.method!=='GET'&&req.method!=='HEAD')return reply(res,405,'method not allowed');
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/')return reply(res,200,HTML,'text/html; charset=utf-8');
      if(url.pathname==='/review.js')return reply(res,200,CLIENT,'text/javascript; charset=utf-8');
      if(url.pathname==='/api/status')return reply(res,200,JSON.stringify({mode:'SYNTHETIC_PRIVATE_REVIEW',private_data_loaded:false,fixture_features:SCOUT_REVIEW_FIXTURE.segments.features.length}),MIME['.json']);
      if(url.pathname==='/api/source-routes')return reply(res,200,JSON.stringify(SCOUT_REVIEW_FIXTURE.source_routes),MIME['.json']);
      if(url.pathname==='/api/segments') {
        const bbox=(url.searchParams.get('bbox')??'').split(',').map(Number);
        if(bbox.length!==4||bbox.some((v)=>!Number.isFinite(v))||bbox[0]<-180||bbox[0]>180||bbox[2]<-180||bbox[2]>180||bbox[1]<-90||bbox[3]>90||bbox[1]>bbox[3])return reply(res,400,'invalid bbox');
        const result={...SCOUT_REVIEW_FIXTURE.segments,features:SCOUT_REVIEW_FIXTURE.segments.features.filter((feature)=>bboxIntersects(feature.geometry,bbox))};
        return reply(res,200,JSON.stringify(result),MIME['.json']);
      }
      if(url.pathname==='/api/canonical')return reply(res,200,JSON.stringify(SCOUT_REVIEW_FIXTURE.canonical),MIME['.json']);
      if(url.pathname==='/assets/style.json') {
        const style=JSON.parse(fs.readFileSync(basemapStyle,'utf8'));
        const origin=`http://127.0.0.1:${server.address().port}`;
        if(style.glyphs?.startsWith('/'))style.glyphs=origin+style.glyphs;
        if(style.sprite?.startsWith('/'))style.sprite=origin+style.sprite;
        for(const source of Object.values(style.sources??{})) if(source.url?.startsWith('pmtiles://'))source.url='pmtiles:///tiles/monaco.pmtiles';
        return reply(res,200,JSON.stringify(style),MIME['.json']);
      }
      if(url.pathname==='/tiles/monaco.pmtiles') {
        const st=fs.statSync(basemapTiles);const range=req.headers.range;
        if(range) {const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m)return reply(res,416,'invalid range');const start=m[1]?Number(m[1]):0,end=Math.min(m[2]?Number(m[2]):st.size-1,st.size-1);if(start>end||start>=st.size)return reply(res,416,'range unavailable');
          res.writeHead(206,{'content-type':'application/vnd.pmtiles','accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${st.size}`,'content-length':end-start+1,'x-content-type-options':'nosniff'});if(req.method==='HEAD')return res.end();return fs.createReadStream(basemapTiles,{start,end}).pipe(res);}
        res.writeHead(200,{'content-type':'application/vnd.pmtiles','accept-ranges':'bytes','content-length':st.size,'x-content-type-options':'nosniff'});if(req.method==='HEAD')return res.end();return fs.createReadStream(basemapTiles).pipe(res);
      }
      for(const [prefix,base] of [['/assets/styles/monaco/',path.join(mapRoot,'styles/monaco')],['/assets/glyphs/',path.join(mapRoot,'glyphs')],['/assets/sprites/',path.join(mapRoot,'sprites')],['/vendor/maplibre-gl/',path.join(repoVendor,'maplibre-gl/dist')],['/vendor/pmtiles/',path.join(repoVendor,'pmtiles/dist')]]) {
        if(url.pathname.startsWith(prefix)) {
          let rel;try{rel=decodeURIComponent(url.pathname.slice(prefix.length));}catch{return reply(res,400,'bad path');}
          const file=safeInside(base,rel);if(!file)return reply(res,404,'not found');
          let real;try{real=fs.realpathSync(file);}catch{return reply(res,404,'not found');}
          const realBase=fs.realpathSync(base);if(real!==realBase&&!real.startsWith(realBase+path.sep))return reply(res,404,'not found');
          const st=fs.statSync(real);if(!st.isFile())return reply(res,404,'not found');
          res.writeHead(200,{'content-type':MIME[path.extname(real)]??'application/octet-stream','content-length':st.size,'x-content-type-options':'nosniff'});if(req.method==='HEAD')return res.end();return fs.createReadStream(real).pipe(res);
        }
      }
      reply(res,404,'not found');
    } catch { if(!res.headersSent)reply(res,500,'review server error');else res.destroy(); }
  });
  server.listen(port,'127.0.0.1');
  return server;
}

const HTML=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RT&amp;T Scout private review</title><link rel="stylesheet" href="/vendor/maplibre-gl/maplibre-gl.css"><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;font:14px system-ui,sans-serif;color:#17212b}body{display:grid;grid-template-columns:minmax(0,1fr) 350px}#map{height:100%;min-height:450px}.panel{padding:16px;overflow:auto;background:#fff;border-left:1px solid #ccd3d9}.badge{padding:5px 8px;background:#fff3cd;border:1px solid #e2bd53;border-radius:4px;font-weight:700}.legend{display:grid;gap:7px;margin:16px 0}.legend span{display:flex;align-items:center;gap:9px}.swatch{width:27px;border-top:4px solid}.road{border-color:#535e68}.unsealed{border-color:#a86b21}.probable{border-color:#b82f88;border-top-style:dashed}.confirmed{border-color:#d33824}.unknown{border-color:#7b8490;border-top-style:dotted}.canonical{border-color:#1565c0}.source{border-color:#72777e;border-top-style:dashed}.match-swatch{width:30px;height:4px;background:#17212b}.match-swatch.likely{background:repeating-linear-gradient(90deg,#17212b 0 11px,transparent 11px 14px)}.match-swatch.partial{background:repeating-linear-gradient(90deg,#17212b 0 6px,transparent 6px 9px)}.match-swatch.parallel{background:repeating-linear-gradient(90deg,#17212b 0 2px,transparent 2px 5px)}.match-swatch.ambiguous{background:repeating-linear-gradient(90deg,#17212b 0 1px,transparent 1px 4px)}label{display:block;margin:9px 0}select{padding:5px;max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px system-ui}.small{font-size:12px;color:#556}.filters{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px}.filters label{margin:3px 0}.filters select{width:100%}</style></head>
<body><div id="map" aria-label="Private Scout synthetic review map"></div><aside class="panel"><div class="badge">PRIVATE DEV • SYNTHETIC DATA ONLY</div><h1>Scout review</h1>
<p>Original source routes stay distinct from Scout-derived segments. No legal conclusion is inferred from route use.</p>
<div class="filters">
<label>Segment type <select data-filter="classification"><option value="ALL">All</option><option>ROAD</option><option>UNSEALED_ROAD</option><option>PROBABLE_OFFROAD</option><option>OFFROAD_CONFIRMED</option><option>UNKNOWN</option></select></label>
<label>Canonical match <select data-filter="match"><option value="ALL">All</option><option>EXACT_EXISTING</option><option>LIKELY_EXISTING</option><option>PARTIAL_OVERLAP</option><option>POSSIBLE_PARALLEL</option><option>AMBIGUOUS</option><option>NEW_CANDIDATE</option></select></label>
<label>Country <select data-filter="country_code"><option value="ALL">All</option><option>MC</option></select></label>
<label>Region <select data-filter="region"><option value="ALL">All</option><option>MC-synthetic</option></select></label>
<label>Physical existence <select data-filter="physical_existence"><option value="ALL">All</option><option>confirmed</option><option>probable</option><option>unknown</option><option>contradictory</option></select></label>
<label>Motorcycle access <select data-filter="motorcycle_access"><option value="ALL">All</option><option>confirmed</option><option>prohibited</option><option>unknown</option><option>contradictory</option></select></label>
<label>Routability <select data-filter="routability"><option value="ALL">All</option><option>yes</option><option>no</option><option>unknown</option></select></label>
<label>Review state <select data-filter="review_state"><option value="ALL">All</option><option>OPEN</option><option>REVIEW</option><option>AWAITING_EVIDENCE</option><option>RESOLVED</option></select></label>
<label>Source <select data-filter="source_id"><option value="ALL">All</option><option>synthetic-routes</option></select></label>
</div>
<label><input id="show-source" type="checkbox" checked> Original source route</label><label><input id="show-canonical" type="checkbox" checked> Synthetic canonical matches</label>
<div class="legend"><strong>Layers • colour = physical character</strong><span><i class="swatch source"></i>Complete source route</span><span><i class="swatch road"></i>Ordinary road</span><span><i class="swatch unsealed"></i>Unsealed road</span><span><i class="swatch probable"></i>Probable off-road</span><span><i class="swatch confirmed"></i>Physically confirmed</span><span><i class="swatch unknown"></i>Unknown / ambiguous</span><span><i class="swatch canonical"></i>Canonical comparison</span><strong>Candidate pattern = canonical relationship</strong><span><i class="match-swatch exact"></i>Exact / new candidate (solid)</span><span><i class="match-swatch likely"></i>Likely existing (long dash)</span><span><i class="match-swatch partial"></i>Partial overlap (dash)</span><span><i class="match-swatch parallel"></i>Possible parallel (dot)</span><span><i class="match-swatch ambiguous"></i>Ambiguous (fine dot)</span></div>
<h2>Selection</h2><pre id="inspector">Select a source route, segment or canonical comparison.</pre><p class="small">Physical existence, motorcycle access and routability are separate fields. Jurisdiction annotations identify boundaries; they do not interpret access law.</p>
</aside><script src="/vendor/pmtiles/pmtiles.js"></script><script src="/review.js" type="module"></script></body></html>`;

const CLIENT=`import * as maplibregl from '/vendor/maplibre-gl/maplibre-gl.mjs';
const protocol=new pmtiles.Protocol();maplibregl.addProtocol('pmtiles',protocol.tile);
const style=await(await fetch('/assets/style.json')).json(),map=new maplibregl.Map({container:'map',style,center:[7.4225,43.735],zoom:14.2,attributionControl:false});window.__scoutMap=map;
map.addControl(new maplibregl.NavigationControl(),'top-right');map.addControl(new maplibregl.AttributionControl({compact:false}),'bottom-right');
const colors={ROAD:'#535e68',UNSEALED_ROAD:'#a86b21',PROBABLE_OFFROAD:'#b82f88',OFFROAD_CONFIRMED:'#d33824',UNKNOWN:'#7b8490'};
const addLine=(id,data,paint,filter)=>{map.addSource(id,{type:'geojson',data});map.addLayer({id:id+'-line',source:id,type:'line',...(filter?{filter}:{}),paint});};
const route=await(await fetch('/api/source-routes')).json(),segments=await(await fetch('/api/segments?bbox=-180,-90,180,90')).json(),canonical=await(await fetch('/api/canonical')).json();
map.on('load',()=>{
 addLine('source-routes',route,{ 'line-color':'#72777e','line-width':2,'line-dasharray':[2,2],'line-opacity':0.85});
 addLine('segments',segments,{ 'line-color':['match',['get','classification'],'ROAD',colors.ROAD,'UNSEALED_ROAD',colors.UNSEALED_ROAD,'PROBABLE_OFFROAD',colors.PROBABLE_OFFROAD,'OFFROAD_CONFIRMED',colors.OFFROAD_CONFIRMED,colors.UNKNOWN],'line-width':['match',['get','classification'],'PROBABLE_OFFROAD',6,'OFFROAD_CONFIRMED',6,4],'line-dasharray':['match',['get','match'],'LIKELY_EXISTING',['literal',[6,1]],'PARTIAL_OVERLAP',['literal',[3,1]],'POSSIBLE_PARALLEL',['literal',[1,1]],'AMBIGUOUS',['literal',[0.5,1.5]],['literal',[1,0]]],'line-opacity':0.9});
 addLine('canonical',canonical,{'line-color':'#1565c0','line-width':3,'line-dasharray':[2,1],'line-opacity':0.8});
 const update=()=>{map.setLayoutProperty('source-routes-line','visibility',document.querySelector('#show-source').checked?'visible':'none');map.setLayoutProperty('canonical-line','visibility',document.querySelector('#show-canonical').checked?'visible':'none');const filters=[...document.querySelectorAll('[data-filter]')].map((el)=>[el.dataset.filter,el.value]).filter(([,value])=>value!=='ALL').map(([key,value])=>['==',['get',key],value]);map.setFilter('segments-line',filters.length?['all',...filters]:null);};
 document.querySelectorAll('[data-filter],#show-source,#show-canonical').forEach((el)=>el.addEventListener('change',update));
 update();
 const inspector=document.querySelector('#inspector');map.on('click',(event)=>{const hits=map.queryRenderedFeatures(event.point,{layers:['source-routes-line','segments-line','canonical-line']});if(!hits.length){inspector.textContent='Select a source route, segment or canonical comparison.';return;}const feature=hits[0];inspector.textContent=JSON.stringify({layer:feature.layer.id,geometry_type:feature.geometry.type,...feature.properties},null,2);});
 window.__scoutReview={ready:true,counts:{source_routes:route.features.length,segments:segments.features.length,canonical:canonical.features.length},featureIds:segments.features.map(f=>f.properties.id),filters:[...document.querySelectorAll('[data-filter]')].map(el=>el.dataset.filter)};
});`;

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) { const port=Number(process.env.SCOUT_REVIEW_PORT||8765);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('SCOUT_REVIEW_PORT must be an unprivileged TCP port');const server=createReviewServer({port});server.on('listening',()=>console.log(`private synthetic Scout review at http://127.0.0.1:${server.address().port}/`)); }
