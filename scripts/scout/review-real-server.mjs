#!/usr/bin/env node
// Read-only, loopback-only reviewer for one explicitly approved Scout run.
// This server never mounts raw source bytes or public paths.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FACTORY, REPO } from '../lib/common.mjs';
import { lengthMeters } from './route-segmenter.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PRIVATE_BASE=path.join(FACTORY,'scout/private/real-source-validation');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.pbf':'application/x-protobuf','.svg':'image/svg+xml','.woff2':'font/woff2'};
const reply=(res,status,body,type='text/plain; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'x-content-type-options':'nosniff','cache-control':'no-store',
  'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'"});res.end(body);};
function bbox(query){const b=(query??'').split(',').map(Number);if(b.length!==4||b.some(v=>!Number.isFinite(v))||b[0]<-180||b[0]>180||b[2]<-180||b[2]>180||b[1]<-90||b[3]>90||b[1]>b[3])return null;return b;}
function inPrivateTree(root,base){const realRoot=fs.realpathSync(root),realBase=fs.realpathSync(base),realRepo=fs.realpathSync(REPO);return (realRoot===realBase||realRoot.startsWith(realBase+path.sep))&&!realRoot.startsWith(realRepo+path.sep);}
function assertNoSymlinkComponents(base,target){
  const relative=path.relative(base,target);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('private review path escapes its configured root');
  let current=base;for(const part of relative.split(path.sep).filter(Boolean)){current=path.join(current,part);try{if(fs.lstatSync(current).isSymbolicLink())throw new Error('private review storage cannot contain symlinks');}catch(error){if(error.code!=='ENOENT')throw error;}}
}
function lineGeometry(row,coordinates='geometry_json'){return JSON.parse(row[coordinates]);}
function feature(geometry,properties){return {type:'Feature',geometry,properties};}
function escapeHtml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');}
const RELEVANT_OSM_TAGS=['highway','surface','tracktype','smoothness','service','access','motor_vehicle','motorcycle','vehicle','construction','ford','bridge','tunnel','name','ref','lit','width','oneway'];
function selectedTags(raw){const input=JSON.parse(raw),out={};for(const key of RELEVANT_OSM_TAGS)if(input[key]!=null)out[key]=input[key];return out;}
function geometryLength(geometry){const parts=geometry.type==='LineString'?[geometry.coordinates]:geometry.coordinates;return parts.reduce((sum,line)=>sum+line.slice(1).reduce((n,p,i)=>n+lengthMeters(line[i],p),0),0);}

export function createRealReviewServer({runId,port=0,privateBase=DEFAULT_PRIVATE_BASE,databaseFile=null,onError=()=>{}}={}){
  if(!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(runId))throw new Error('review requires one explicit safe Scout run ID');
  const base=path.resolve(privateBase),legacyRoot=path.join(base,runId),dbFile=databaseFile?path.resolve(databaseFile):path.join(legacyRoot,'state/scout.sqlite');
  if(fs.lstatSync(base).isSymbolicLink())throw new Error('private review storage cannot contain symlinks');
  assertNoSymlinkComponents(base,path.dirname(dbFile));
  try{if(fs.lstatSync(dbFile).isSymbolicLink())throw new Error('private review storage cannot contain symlinks');}catch(error){if(error.code!=='ENOENT')throw error;}
  const storageRoot=path.dirname(dbFile);
  if(!inPrivateTree(storageRoot,base)||fs.realpathSync(base)===fs.realpathSync(REPO))throw new Error('review data must remain in configured private Scout storage');
  const st=fs.statSync(dbFile);if(!st.isFile()||(st.mode&0o077)!==0)throw new Error('private review database must be a regular owner-only file');
  const db=new DatabaseSync(dbFile,{readOnly:true});
  const runRow=db.prepare('SELECT * FROM scout_runs WHERE run_id=?').get(runId);if(!runRow){db.close();throw new Error(`Scout run '${runId}' is not registered`);}
  const run={...runRow,config:JSON.parse(runRow.config_json)};
  const snapshot=db.prepare('SELECT snapshot_id,source_id,version,checksum,licence_json,coverage_json FROM network_snapshots WHERE snapshot_id=?').get(run.snapshot_id);
  if(!snapshot){db.close();throw new Error('registered run network snapshot is missing');}
  const sourceRow=db.prepare('SELECT current_json FROM source_registry WHERE source_id=?').get(run.source_id);
  if(!sourceRow){db.close();throw new Error('approved private route source record is missing');}
  const networkSource=db.prepare('SELECT current_json FROM source_registry WHERE source_id=?').get(snapshot.source_id);
  if(!networkSource){db.close();throw new Error('registered regional network source is missing');}
  const source=JSON.parse(sourceRow.current_json),network=JSON.parse(networkSource.current_json),licence=JSON.parse(snapshot.licence_json);
  const matchedNetworkIds=new Set();
  for(const row of db.prepare(`SELECT s.evidence_json FROM route_segments s JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version
    WHERE ro.run_id=? AND ro.status='COMPLETE'`).iterate(runId)){
    for(const item of JSON.parse(row.evidence_json)){if(item.edge_id)matchedNetworkIds.add(item.edge_id);for(const id of item.edge_ids??[])matchedNetworkIds.add(id);}
  }
  const tagByEdge=new Map(),networkIds=[...matchedNetworkIds];
  for(let i=0;i<networkIds.length;i+=500){const chunk=networkIds.slice(i,i+500),rows=db.prepare(`SELECT edge_id,tags_json FROM network_edges WHERE snapshot_id=? AND edge_id IN (${chunk.map(()=>'?').join(',')})`).all(snapshot.snapshot_id,...chunk);for(const row of rows)tagByEdge.set(row.edge_id,selectedTags(row.tags_json));}
  const continuityBySubject=new Map();
  for(const row of db.prepare(`SELECT h.hypothesis_id,h.candidate_ids_json,h.connector_segment_ids_json FROM corridor_hypotheses h
    JOIN scout_run_observations ro USING(observation_id) WHERE ro.run_id=? AND ro.status='COMPLETE' AND EXISTS(
      SELECT 1 FROM json_each(h.candidate_ids_json) ids JOIN candidates c ON c.candidate_id=ids.value
      JOIN route_segments s USING(segment_id) WHERE s.pipeline_version=ro.pipeline_version)`).all(runId)){
    for(const id of JSON.parse(row.candidate_ids_json))continuityBySubject.set(id,row.hypothesis_id);
    for(const id of JSON.parse(row.connector_segment_ids_json))continuityBySubject.set(id,row.hypothesis_id);
  }
  const hostAllowed=(req,srv)=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&new Set(['127.0.0.1','localhost','[::1]']).has((req.headers.host??'').split(':')[0].replace(/^\[/,'').replace(/\]$/,''));
  const server=http.createServer((req,res)=>{
    try{
      if(!hostAllowed(req,server))return reply(res,403,'loopback access only');
      if(req.method!=='GET'&&req.method!=='HEAD')return reply(res,405,'read-only GET/HEAD endpoints only');
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/')return reply(res,200,HTML.replaceAll('{{RUN_TITLE}}',escapeHtml(run.config.title??`${run.country_code} Scout review`))
        .replaceAll('{{COUNTRY_CODE}}',escapeHtml(run.country_code)).replaceAll('{{CANONICAL_NOTE}}',run.config.canonical_status==='COMPARED'?'Canonical comparison was performed using the registered read-only regional master.':`No ${escapeHtml(run.country_code)} canonical master was supplied. Canonical comparison was not performed; “unmatched” is not a NEW result.`),'text/html; charset=utf-8');
      if(url.pathname==='/review.js'){const [w,s,e,n]=run.config.viewport,center=[(w+e)/2,(s+n)/2],span=Math.max(e-w,n-s),zoom=Math.max(2,Math.min(12,Math.log2(360/Math.max(span,0.01))+0.2));return reply(res,200,CLIENT.replaceAll('{{CENTER}}',JSON.stringify(center)).replaceAll('{{ZOOM}}',zoom.toFixed(2)).replaceAll('{{VIEWPORT}}',JSON.stringify([[w,s],[e,n]])),'text/javascript; charset=utf-8');}
      if(url.pathname.startsWith('/vendor/maplibre-gl/')){
        const name=decodeURIComponent(url.pathname.slice('/vendor/maplibre-gl/'.length));
        if(!['maplibre-gl.css','maplibre-gl.mjs','maplibre-gl-shared.mjs','maplibre-gl-worker.mjs'].includes(name))return reply(res,404,'not found');
        const base=path.resolve(HERE,'../../node_modules/maplibre-gl/dist'),file=path.join(base,name);
        const real=fs.realpathSync(file);if(!real.startsWith(fs.realpathSync(base)+path.sep))return reply(res,404,'not found');
        return reply(res,200,fs.readFileSync(real),MIME[path.extname(real)]);
      }
      if(url.pathname==='/api/status'){
        const counts=db.prepare(`SELECT (SELECT count(*) FROM scout_run_observations WHERE run_id=?) observations,
          (SELECT count(*) FROM route_segments s JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version WHERE ro.run_id=? AND ro.status='COMPLETE') segments,
          (SELECT count(*) FROM candidates c JOIN route_segments s USING(segment_id) JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version WHERE ro.run_id=? AND ro.status='COMPLETE') candidates,
          (SELECT count(DISTINCT h.hypothesis_id) FROM corridor_hypotheses h JOIN scout_run_observations ro USING(observation_id)
            WHERE ro.run_id=? AND ro.status='COMPLETE' AND EXISTS(SELECT 1 FROM json_each(h.candidate_ids_json) ids JOIN candidates c ON c.candidate_id=ids.value
              JOIN route_segments s USING(segment_id) WHERE s.pipeline_version=ro.pipeline_version)) corridor_hypotheses,
          (SELECT count(*) FROM network_edges WHERE snapshot_id=?) network_edges`)
          .get(runId,runId,runId,runId,snapshot.snapshot_id);
        return reply(res,200,JSON.stringify({mode:'PRIVATE_SCOUT_REVIEW',bind:'127.0.0.1',public:false,read_only:true,private_data_loaded:true,
          run_id:runId,run_status:run.status,country_code:run.country_code,region_id:run.region_id,title:run.config.title,source_id:source.source_id,
          network_snapshot_id:snapshot.snapshot_id,network_version:snapshot.version,network_sha256:snapshot.checksum,
          attribution:licence.attribution??network.attribution,licence:licence.name,matched_network_edge_ids:matchedNetworkIds.size,...counts}),MIME['.json']);
      }
      if(url.pathname==='/api/source-routes'){
        const rows=db.prepare(`SELECT o.observation_id,o.source_part,o.source_name,o.geometry_json,f.version,f.sha256 FROM route_observations o JOIN source_files f USING(file_id)
          JOIN scout_run_observations ro USING(observation_id) WHERE ro.run_id=? ORDER BY o.source_part`).all(runId);
        const collection={type:'FeatureCollection',features:rows.map(r=>feature(lineGeometry(r),{id:r.observation_id,source_part:r.source_part,source_name:r.source_name,
          source_id:source.source_id,source_file_version:r.version,source_file_sha256:r.sha256,privacy:'private discovery geometry'}))};
        return reply(res,200,JSON.stringify(collection),MIME['.json']);
      }
      if(url.pathname==='/api/segments'){
        const bounds=bbox(url.searchParams.get('bbox'));if(!bounds)return reply(res,400,'invalid bbox');
        const [w,s,e,n]=bounds,limit=Number(url.searchParams.get('limit')??10000);if(!Number.isInteger(limit)||limit<1||limit>20000)return reply(res,400,'limit must be 1-20000');
        const query=db.prepare(`SELECT s.segment_id,s.observation_id,s.ordinal,s.component_index,s.classification,s.confidence,s.geometry_json,s.evidence_json,
          s.jurisdiction_ids_json,s.pipeline_version,o.source_part,o.source_name,c.candidate_id,c.master_match,c.physical_state,c.motorcycle_access,c.routability,c.review_state,c.issues_json,c.matched_rtt_ids_json,c.match_details_json
          FROM route_segments s JOIN route_observations o USING(observation_id) JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version
          LEFT JOIN candidates c USING(segment_id) JOIN route_segments_rtree r USING(segment_rowid)
          WHERE ro.run_id=? AND ro.status='COMPLETE'
            AND r.max_lon>=? AND r.min_lon<=? AND r.max_lat>=? AND r.min_lat<=? ORDER BY s.segment_id LIMIT ?`);
        const rows=w<=e?query.all(runId,w,e,s,n,limit+1):query.all(runId,w,180,s,n,limit+1).concat(query.all(runId,-180,e,s,n,limit+1));
        const unique=[...new Map(rows.map(r=>[r.segment_id,r])).values()].slice(0,limit);
        const features=unique.map(r=>{
          const geometry=lineGeometry(r),evidence=JSON.parse(r.evidence_json),unknownReasons=[...new Set(evidence.flatMap(e=>e.rule==='interval-network-ambiguity'&&e.reason?[e.reason]:e.rule==='no-network-match-within-threshold'?['no_network_match']:[]))].sort();
          const ids=[...new Set(evidence.flatMap(e=>[...(e.edge_id?[e.edge_id]:[]),...(e.edge_ids??[])]))];
          const details=JSON.parse(r.match_details_json??'{}'),match=r.master_match==='UNMATCHED'&&details.reason==='canonical master not supplied'?'NOT_COMPARED':r.master_match??'NOT_COMPARED';
          const decision=db.prepare('SELECT decision,reviewer,reason,decided_at FROM review_decisions WHERE candidate_id=? ORDER BY decided_at DESC,decision_id DESC LIMIT 1').get(r.candidate_id);
          return feature(geometry,{id:r.segment_id,segment_id:r.segment_id,candidate_id:r.candidate_id,source_observation_id:r.observation_id,
            source_part:r.source_part,source_track:r.source_name,classification:r.classification,unknown_reason:unknownReasons.length===1?unknownReasons[0]:unknownReasons.length?'multiple_unknown_reasons':'NONE',
            confidence:r.confidence,match,physical_existence:r.physical_state??'unknown',motorcycle_access:r.motorcycle_access??'unknown',routability:r.routability??'unknown',review_state:r.review_state??'AWAITING_EVIDENCE',
            length_m:Number(geometryLength(geometry).toFixed(2)),review_decision:decision?.decision??'UNREVIEWED',reviewer:decision?.reviewer??null,reviewed_at:decision?.decided_at??null,review_reason:decision?.reason??null,
            corridor_hypothesis_id:continuityBySubject.get(r.candidate_id??r.segment_id)??null,
            jurisdiction_ids:JSON.parse(r.jurisdiction_ids_json),matched_rtt_ids:JSON.parse(r.matched_rtt_ids_json??'[]'),issues:JSON.parse(r.issues_json??'[]'),
            network_matches:ids.map(id=>({edge_id:id,tags:tagByEdge.get(id)??{}})),evidence});
        });
        return reply(res,200,JSON.stringify({type:'FeatureCollection',features,truncated:rows.length>limit,read_only:true}),MIME['.json']);
      }
      if(url.pathname==='/api/network'){
        const bounds=bbox(url.searchParams.get('bbox'));if(!bounds)return reply(res,400,'invalid bbox');
        if(Number(url.searchParams.get('zoom')??0)<7)return reply(res,200,JSON.stringify({type:'FeatureCollection',features:[],truncated:false,zoomed_out:true}),MIME['.json']);
        const limit=Number(url.searchParams.get('limit')??5000);if(!Number.isInteger(limit)||limit<1||limit>5000)return reply(res,400,'limit must be 1-5000');
        if(!matchedNetworkIds.size)return reply(res,200,JSON.stringify({type:'FeatureCollection',features:[],truncated:false,attribution:licence.attribution,licence:licence.name}),MIME['.json']);
        const ids=[...matchedNetworkIds].slice(0,30000),placeholders=ids.map(()=>'?').join(','),[w,s,e,n]=bounds;
        const query=db.prepare(`SELECT e.edge_id,e.geometry_json,e.tags_json FROM network_edges e JOIN network_edges_rtree r USING(edge_rowid)
          WHERE e.snapshot_id=? AND e.edge_id IN (${placeholders}) AND r.max_lon>=? AND r.min_lon<=? AND r.max_lat>=? AND r.min_lat<=? ORDER BY e.edge_rowid LIMIT ?`);
        const rows=w<=e?query.all(snapshot.snapshot_id,...ids,w,e,s,n,limit+1):query.all(snapshot.snapshot_id,...ids,w,180,s,n,limit+1).concat(query.all(snapshot.snapshot_id,...ids,-180,e,s,n,limit+1));
        const unique=[...new Map(rows.map(r=>[r.edge_id,r])).values()].slice(0,limit);
        const features=unique.map(r=>feature(lineGeometry(r),{id:r.edge_id,osm_edge_id:r.edge_id,...selectedTags(r.tags_json)}));
        return reply(res,200,JSON.stringify({type:'FeatureCollection',features,truncated:rows.length>limit,attribution:licence.attribution,licence:licence.name}),MIME['.json']);
      }
      if(url.pathname==='/api/canonical')return reply(res,200,JSON.stringify({type:'FeatureCollection',features:[],coverage:run.config.canonical_status==='COMPARED'?'registered read-only canonical comparison':'canonical reference not supplied; NOT_COMPARED'}),MIME['.json']);
      return reply(res,404,'not found');
    }catch(error){try{onError(error);}catch{}return reply(res,500,'private reviewer request failed');}
  });
  server.on('close',()=>db.close());server.listen(port,'127.0.0.1');return server;
}

const HTML=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RT&amp;T Scout • {{RUN_TITLE}}</title>
<link rel="stylesheet" href="/vendor/maplibre-gl/maplibre-gl.css"><style>*{box-sizing:border-box}html,body{margin:0;height:100%;font:14px system-ui,sans-serif;color:#17212b}body{display:grid;grid-template-columns:minmax(0,1fr) 360px}#map{height:100%;min-height:420px;background:#e8ecef}.panel{padding:16px;overflow:auto;background:#fff;border-left:1px solid #ccd3d9}.badge{padding:6px 8px;background:#fff0e5;border:1px solid #d98d57;border-radius:4px;font-weight:700;color:#612d0d}.legend{display:grid;gap:6px;margin:14px 0}.legend span{display:flex;align-items:center;gap:8px}.swatch{width:26px;border-top:4px solid}.ROAD{border-color:#555f68}.UNSEALED_ROAD{border-color:#a76c20}.PROBABLE_OFFROAD{border-color:#b82f88;border-top-style:dashed}.OFFROAD_CONFIRMED{border-color:#d33824}.UNKNOWN{border-color:#7c8791;border-top-style:dotted}.source{border-color:#1b6c93;border-top-style:dashed}.network{border-color:#adb9bb;border-top-width:2px}.continuity{border-color:#087f8c;border-top-style:dotted}label{display:block;margin:8px 0}select{padding:5px;max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px system-ui}.small{font-size:12px;color:#556}.filters{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px}.filters label{margin:3px 0}.filters select{width:100%}@media(max-width:850px){body{grid-template-columns:1fr;grid-template-rows:55% 45%}.panel{border-left:0;border-top:1px solid #ccd3d9}}</style></head><body>
<div id="map" aria-label="Private Scout regional review map"></div><aside class="panel"><div class="badge">PRIVATE LOOPBACK REVIEW • APPROVED SOURCE MATERIAL</div><h1>{{RUN_TITLE}}</h1><p class="badge">{{CANONICAL_NOTE}}</p><p id="summary">Loading private validation records…</p>
<p>Complete source routes remain separate from derived segments. Route membership is discovery-only. Motorcycle access and routability are unknown.</p>
<div class="filters"><label>Physical character <select data-filter="classification"><option value="ALL">All</option><option>ROAD</option><option>UNSEALED_ROAD</option><option>PROBABLE_OFFROAD</option><option>OFFROAD_CONFIRMED</option><option>UNKNOWN</option></select></label>
<label>Canonical comparison <select data-filter="match"><option value="ALL">All</option><option>EXACT_EXISTING</option><option>LIKELY_EXISTING</option><option>PARTIAL_OVERLAP</option><option>POSSIBLE_PARALLEL</option><option>AMBIGUOUS</option><option>NEW_CANDIDATE</option><option>UNMATCHED</option></select></label>
<label>UNKNOWN reason <select data-filter="unknown_reason"><option value="ALL">All</option><option>no_network_match</option><option>competing_network_classes</option><option>interval_support_uncertain</option><option>network_tags_insufficient</option><option>multiple_unknown_reasons</option><option value="NONE">Not UNKNOWN</option></select></label>
<label>Candidate length <select data-filter="candidate_length"><option value="ALL">All</option><option value="LT100">Under 100 m</option><option value="100_500">100–500 m</option><option value="500_1000">500–1,000 m</option><option value="GE1000">1,000 m or longer</option></select></label>
<label>Match-margin score <select data-filter="confidence_band"><option value="ALL">All</option><option value="HIGH">Above 0.5</option><option value="MID">0.1–0.5</option><option value="LOW">0.1 or below</option><option value="UNKNOWN">Unknown score</option></select></label>
<label>Motorcycle access <select data-filter="motorcycle_access"><option value="ALL">All</option><option>unknown</option><option>confirmed</option><option>prohibited</option><option>contradictory</option></select></label><label>Routability <select data-filter="routability"><option value="ALL">All</option><option>unknown</option><option>yes</option><option>no</option></select></label>
<label>Operator review <select data-filter="review_decision"><option value="ALL">All</option><option>UNREVIEWED</option><option>ACCEPT_FOR_RESEARCH</option><option>NEEDS_MORE_EVIDENCE</option><option>REJECT_FALSE_POSITIVE</option><option>AMBIGUOUS</option><option>HOLD</option></select></label></div>
<label><input id="show-source" type="checkbox" checked> Complete private source routes</label><label><input id="show-network" type="checkbox" checked> Regional OSM network matches</label>
<div class="legend"><strong>Physical character • line style shows source / evidence</strong><span><i class="swatch ROAD"></i>Ordinary road</span><span><i class="swatch UNSEALED_ROAD"></i>Unsealed road</span><span><i class="swatch PROBABLE_OFFROAD"></i>Probable off-road</span><span><i class="swatch OFFROAD_CONFIRMED"></i>Physical existence confirmed by qualified evidence</span><span><i class="swatch UNKNOWN"></i>Unknown / ambiguous</span><span><i class="swatch continuity"></i>Ambiguous connector hypothesis (not merged)</span><span><i class="swatch source"></i>Complete private source route</span><span><i class="swatch network"></i>Matched network way</span></div>
<p class="small" id="network-note">Matched OSM edges cited by segmentation • © OpenStreetMap contributors • ODbL 1.0</p><h2>Selection</h2><pre id="inspector">Select a route section or network edge.</pre>
<p class="small">Match-margin score is geometric clearance, not a probability. Access/motorcycle tags are shown as source text only; the physical classifier ignores them and they do not establish RT&amp;T legal access. Network geometry and tags remain source evidence. Muted network lines show cited edges only. Extract coverage outlines are approximate, not legal boundaries. Source routes are private discovery material only and do not prove existence or legal access.</p></aside>
<script src="/review.js" type="module"></script></body></html>`;

const CLIENT=`import * as maplibregl from '/vendor/maplibre-gl/maplibre-gl.mjs';
const map=new maplibregl.Map({container:'map',style:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#e8ecef'}}]},center:{{CENTER}},zoom:{{ZOOM}},attributionControl:false});
window.__scoutMap=map;map.addControl(new maplibregl.NavigationControl(),'top-right');map.addControl(new maplibregl.AttributionControl({customAttribution:'© OpenStreetMap contributors • ODbL 1.0'}),'bottom-right');
const colors={ROAD:'#555f68',UNSEALED_ROAD:'#a76c20',PROBABLE_OFFROAD:'#b82f88',OFFROAD_CONFIRMED:'#d33824',UNKNOWN:'#7c8791'};let routes,segments,network,canonical;
const source=(id,data)=>map.addSource(id,{type:'geojson',data});
const fetchJson=async(url)=>{const r=await fetch(url);if(!r.ok)throw new Error('private Scout data request failed');return r.json();};
function bbox(){const b=map.getBounds();return [b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].join(',');}
async function refreshNetwork(){if(!document.querySelector('#show-network').checked)return;const data=await fetchJson('/api/network?bbox='+encodeURIComponent(bbox())+'&zoom='+map.getZoom().toFixed(1));network.setData(data);document.querySelector('#network-note').textContent='Matched OSM edges cited by segmentation • © OpenStreetMap contributors • ODbL 1.0'+(data.truncated?' • zoom in to see all cited edges at this viewport':'');}
function filters(){const terms=[];for(const el of document.querySelectorAll('[data-filter]')){const k=el.dataset.filter,v=el.value;if(v==='ALL')continue;
if(k==='candidate_length'){terms.push(['!=',['get','candidate_id'],null]);if(v==='LT100')terms.push(['<',['get','length_m'],100]);if(v==='100_500')terms.push(['all',['>=',['get','length_m'],100],['<',['get','length_m'],500]]);if(v==='500_1000')terms.push(['all',['>=',['get','length_m'],500],['<',['get','length_m'],1000]]);if(v==='GE1000')terms.push(['>=',['get','length_m'],1000]);}
else if(k==='confidence_band'){if(v==='UNKNOWN')terms.push(['==',['get','confidence'],null]);if(v==='HIGH')terms.push(['>',['get','confidence'],0.5]);if(v==='MID')terms.push(['all',['>=',['get','confidence'],0.1],['<=',['get','confidence'],0.5]]);if(v==='LOW')terms.push(['<=',['get','confidence'],0.1]);}
else terms.push(['==',['get',k],v]);}map.setFilter('segments-line',terms.length?['all',...terms]:null);}
const allBounds=(features)=>{let west=180,south=90,east=-180,north=-90;for(const f of features){const walk=x=>{if(Array.isArray(x)&&typeof x[0]==='number'){west=Math.min(west,x[0]);east=Math.max(east,x[0]);south=Math.min(south,x[1]);north=Math.max(north,x[1]);}else if(Array.isArray(x))x.forEach(walk);};walk(f.geometry.coordinates);}return [[west,south],[east,north]];};
const status=await fetchJson('/api/status'),[routesData,segmentsData,canonicalData]=await Promise.all([fetchJson('/api/source-routes'),fetchJson('/api/segments?bbox=-180,-90,180,90'),fetchJson('/api/canonical')]);routes=routesData;segments=segmentsData;canonical=canonicalData;
document.querySelector('#summary').textContent=status.observations+' private source parts • '+status.segments.toLocaleString()+' derived sections • '+status.candidates+' candidate sections • '+status.corridor_hypotheses+' non-destructive continuity hypotheses • '+status.network_edges.toLocaleString()+' OSM network edges.';
const initialize=()=>{source('network', {type:'FeatureCollection',features:[]});source('source-routes',routes);source('segments',segments);source('canonical',canonical);
map.addLayer({id:'network-line',source:'network',type:'line',paint:{'line-color':'#84999e','line-width':['interpolate',['linear'],['zoom'],7,0.8,13,2.4],'line-opacity':0.9}});
map.addLayer({id:'source-routes-line',source:'source-routes',type:'line',paint:{'line-color':'#1b6c93','line-width':2.2,'line-dasharray':[2,2],'line-opacity':0.8}});
map.addLayer({id:'segments-line',source:'segments',type:'line',paint:{'line-color':['match',['get','classification'],'ROAD',colors.ROAD,'UNSEALED_ROAD',colors.UNSEALED_ROAD,'PROBABLE_OFFROAD',colors.PROBABLE_OFFROAD,'OFFROAD_CONFIRMED',colors.OFFROAD_CONFIRMED,colors.UNKNOWN],'line-width':['match',['get','classification'],'PROBABLE_OFFROAD',4.4,'OFFROAD_CONFIRMED',4.4,'UNKNOWN',2.5,3],'line-dasharray':['match',['get','classification'],'PROBABLE_OFFROAD',['literal',[2.5,1]],'UNKNOWN',['literal',[0.8,1.8]],['literal',[1,0]]],'line-opacity':0.95}});
map.addLayer({id:'continuity-hypothesis-line',source:'segments',type:'line',filter:['all',['==',['get','classification'],'UNKNOWN'],['!=',['get','corridor_hypothesis_id'],null]],paint:{'line-color':'#087f8c','line-width':5,'line-dasharray':[0.35,1.1],'line-opacity':0.9}});
map.addLayer({id:'canonical-line',source:'canonical',type:'line',paint:{'line-color':'#1565c0','line-width':3,'line-dasharray':[2,1]}});
document.querySelectorAll('[data-filter]').forEach(el=>el.addEventListener('change',filters));document.querySelector('#show-source').addEventListener('change',e=>map.setLayoutProperty('source-routes-line','visibility',e.target.checked?'visible':'none'));
document.querySelector('#show-network').addEventListener('change',()=>refreshNetwork().catch(()=>{}));filters();const bounds={{VIEWPORT}};map.fitBounds(bounds,{padding:42,maxZoom:9});
let timer;map.on('moveend',()=>{clearTimeout(timer);timer=setTimeout(()=>refreshNetwork().catch(()=>{}),180);});refreshNetwork().catch(()=>{});
const inspector=document.querySelector('#inspector');map.on('click',event=>{const hits=map.queryRenderedFeatures(event.point,{layers:['segments-line','source-routes-line','network-line','canonical-line']});inspector.textContent=hits.length?JSON.stringify({layer:hits[0].layer.id,...hits[0].properties},null,2):'No route section at this point.';});
window.__scoutReview={ready:true,mode:'PRIVATE_SCOUT_REVIEW',counts:{source_routes:routes.features.length,segments:segments.features.length,candidates:segments.features.filter(f=>f.properties.candidate_id).length,corridor_hypotheses:status.corridor_hypotheses,canonical:canonical.features.length},filterCount:document.querySelectorAll('[data-filter]').length};};
if(map.isStyleLoaded())initialize();else map.once('load',initialize);`;

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const runId=process.env.SCOUT_REVIEW_RUN_ID,privateBase=process.env.SCOUT_GEO_ROOT;if(!runId||!privateBase)throw new Error('SCOUT_REVIEW_RUN_ID and SCOUT_GEO_ROOT are required; select an explicit private run');const port=Number(process.env.SCOUT_REVIEW_PORT||8766);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('SCOUT_REVIEW_PORT must be an unprivileged port');const server=createRealReviewServer({runId,privateBase,databaseFile:path.join(privateBase,'scout.sqlite'),port});server.on('listening',()=>console.log(`private loopback Scout review at http://127.0.0.1:${server.address().port}/`));}
