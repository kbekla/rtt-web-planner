#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ScoutGeoStore } from './geostore.mjs';
import { NotificationCenter } from './core.mjs';
import { readHostSnapshot } from './resources.mjs';
import { prepareRegionPlan, approveRegionPlan } from './region-operator.mjs';
import { createRealReviewServer } from './review-real-server.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../..'),DEFAULT_PORT=8770,MAX_UPLOAD=16*1024*1024;
const safeId=value=>/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(value??'');
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
const errorMessage=error=>String(error?.message??error).replaceAll(REPO,'Scout installation').slice(0,500);
function privateDirectory(directory){const target=path.resolve(directory);fs.mkdirSync(target,{recursive:true,mode:0o700});if(fs.lstatSync(target).isSymbolicLink()||!fs.statSync(target).isDirectory())throw new Error('private Scout directory is not a real directory');fs.chmodSync(target,0o700);return target;}
function requestHostAllowed(req){const peer=req.socket.remoteAddress,host=(req.headers.host??'').split(':')[0].replace(/^\[|\]$/g,'');return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)&&['127.0.0.1','localhost','::1'].includes(host);}
function escapeHtml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');}
export function operatorBlockedReason(host){
  const c=host.factory_coordination??{};
  if(c.status==='RED')return c.reason??'shared factory admission integrity state is RED';
  if(!c.verified)return host.heavy_work_blocked_reason??c.reason??'shared factory admission is unverified; Scout processing is blocked';
  if(host.factory_job_active||host.planetiler_active)return 'Map factory or Planetiler is active; Scout heavy work is blocked until it finishes.';
  if(c.factory_pending||c.yield_requested)return 'Factory heavy-work intent is pending; Scout yields priority.';
  if(host.local_ai_active)return 'Another local AI workload is active; Scout heavy work is blocked.';
  if(host.other_heavy_workload_active)return 'Another heavyweight RT&T workload is active; Scout heavy work is blocked.';
  return host.heavy_work_blocked_reason??null;
}
export function scoutJobEnvironment(baseEnv, { root, raw, factoryDir, notificationEmail = baseEnv.SCOUT_NOTIFICATION_EMAIL } = {}) {
  return { ...baseEnv, SCOUT_GEO_ROOT: root, SCOUT_RAW_ROOT: raw, FACTORY_DIR: factoryDir,
    ...(notificationEmail ? { SCOUT_NOTIFICATION_EMAIL: notificationEmail } : {}) };
}
export function deriveOperatorHealth(host,notifications,runs){
  if(host.factory_coordination?.status==='RED')return 'RED';
  if(operatorBlockedReason(host))return 'BLOCKED';
  if(notifications.active||runs.some(run=>run.status==='REVIEW_REQUIRED'))return 'AMBER';
  return 'GREEN';
}

const HTML=(token)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="scout-token" content="${token}"><title>RT&T Scout</title><style>
:root{color-scheme:light;--ink:#17231d;--muted:#617168;--paper:#f3f6f2;--card:#fff;--line:#d7e1d8;--green:#187548;--amber:#9a6100;--red:#a32125;--blue:#205c83}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.45 system-ui,sans-serif}header{background:#173b2c;color:#fff;padding:20px max(22px,calc((100vw - 1120px)/2));display:flex;align-items:center;justify-content:space-between;gap:20px}h1{font-size:24px;margin:0}header p{margin:3px 0 0;color:#d0e3d5}.status-pill{border:1px solid #95baa0;border-radius:999px;padding:6px 12px;font-weight:700}.status-pill.AMBER,.status-pill.BLOCKED{background:#fff1ce;color:#6b4300;border-color:#d6a842}.status-pill.RED{background:#fde5e5;color:#762024;border-color:#ce777a}.status-pill.GREEN{background:#e4eee7;color:#124c31;border-color:#95baa0}main{max-width:1120px;margin:24px auto;padding:0 18px 40px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;box-shadow:0 2px 9px #163b2c0b}.wide{grid-column:1/-1}h2{font-size:18px;margin:0 0 14px}h3{margin:0 0 6px;font-size:16px}.muted{color:var(--muted)}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.field{display:grid;gap:5px;margin:10px 0}.field label{font-weight:650}.field input,.field select{padding:10px;border:1px solid #b7c6ba;border-radius:7px;background:#fff;color:var(--ink);font:inherit;max-width:100%}button,.button{border:0;border-radius:7px;padding:10px 14px;background:#176b45;color:#fff;font:650 14px system-ui;cursor:pointer;text-decoration:none;display:inline-block}button.secondary{background:#e4eee7;color:#1d4431}button.danger{background:#833a35}button:disabled{opacity:.45;cursor:not-allowed}.choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.choice{border:1px solid var(--line);border-radius:8px;padding:10px}.choice label{display:flex;gap:8px;align-items:center;font-weight:500}.badge{font-size:12px;font-weight:750;border-radius:999px;padding:3px 8px;background:#e4eee7;color:var(--green)}.badge.AMBER,.badge.BLOCKED,.badge.REVIEW_REQUIRED{background:#fff1ce;color:var(--amber)}.badge.RED,.badge.FAILED{background:#fde5e5;color:var(--red)}.badge.RUNNING{background:#e0f0fb;color:var(--blue)}.run{border-top:1px solid var(--line);padding:13px 0}.run:first-of-type{border:0;padding-top:0}.run p{margin:4px 0 10px}.message{min-height:24px;margin:12px 0;font-weight:650}.error{color:var(--red)}.good{color:var(--green)}.metric{display:inline-block;margin:0 15px 10px 0}.metric b{display:block;font-size:20px}.small{font-size:13px}table{border-collapse:collapse;width:100%}td{border-top:1px solid var(--line);padding:8px 4px;vertical-align:top}td:first-child{color:var(--muted);width:38%}@media(max-width:760px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}.choices{grid-template-columns:1fr}header{padding:16px 20px}}
</style></head><body><header><div><h1>RT&amp;T Scout</h1><p>Private trail discovery and review</p></div><span id="health" class="status-pill">Checking Scout…</span></header><main><div class="grid">
<section class="card"><h2>Host and factory</h2><div id="host" class="muted">Loading read-only status…</div></section>
<section class="card"><h2>Notifications</h2><div id="notifications" class="muted">Loading…</div></section>
<section class="card wide"><h2>Prepare a new region</h2><p class="muted">Choose one route file. Scout derives its checksum and map bounds and resolves the configured regional network. Preparation does not process the route.</p>
<form id="prepare"><div class="field"><label for="route">Route file</label><input id="route" type="file" accept=".gpx,.kml,.geojson,.json" required></div>
<div class="choices"><div class="field"><label for="country">Country code</label><input id="country" maxlength="2" placeholder="e.g. HR" required></div><div class="field"><label for="region">Country/region name</label><input id="region" placeholder="e.g. Croatia" required></div>
<div class="field"><label for="source-name">Source identity</label><input id="source-name" placeholder="e.g. Trans Euro Trail" required></div><div class="field"><label for="source-type">Source type</label><select id="source-type" required><option value="">Choose…</option><option value="community-route">Community / adventure route</option><option value="owner-supplied">Owner-supplied route</option><option value="official-route">Official route file</option></select></div></div>
<p><strong>Confirm permissions for this source.</strong> These choices are recorded. Scout will not broaden them.</p><div class="choices">
${[['private','Private research'],['redistribution','Redistribution'],['derived','Derived/public use'],['legal','Use as legal-access evidence']].map(([key,label])=>`<div class="choice"><strong>${label}</strong><div class="row"><label><input type="radio" name="${key}" value="yes" required> Yes</label><label><input type="radio" name="${key}" value="no" required> No</label></div></div>`).join('')}
</div><div id="license-fields" hidden><div class="choices"><div class="field"><label for="license">Source licence</label><input id="license" maxlength="120"></div><div class="field"><label for="attribution">Required attribution</label><input id="attribution" maxlength="300"></div></div></div>
<p class="small muted">For community GPX discovery, the conservative choices are private research YES; redistribution NO; derived/public use NO; legal-access evidence NO. No route choice establishes motorcycle permission.</p><div class="row"><button id="prepare-button">Prepare region</button><button type="reset" class="secondary">Clear form</button></div></form><div id="prepare-message" class="message" role="status"></div><div id="prepared"></div></section>
<section class="card wide"><div class="row" style="justify-content:space-between"><h2>Runs</h2><button id="refresh" class="secondary">Refresh status</button></div><div id="runs" class="muted">Loading…</div></section>
<section class="card wide"><h2>Operator</h2><p class="muted">Opening this app never starts processing. Use the explicit run buttons below. Status and review are read-only; source decisions are recorded separately.</p><button id="exit" class="danger">Exit Scout</button><span id="exit-message" class="message"></span></section>
</div></main><script nonce="${token}">
const token=document.querySelector('meta[name="scout-token"]').content,el=id=>document.getElementById(id),say=(id,text,bad=false)=>{el(id).textContent=text;el(id).className='message '+(bad?'error':'good');};
async function api(path,options={}){const response=await fetch(path,{...options,credentials:'same-origin',headers:{'x-scout-token':token,...options.headers}});const value=await response.json().catch(()=>({error:'Scout returned an unreadable response'}));if(!response.ok)throw Error(value.error||'Scout request failed');return value;}
function badge(state){return '<span class="badge '+String(state).replace(/[^A-Z_]/g,'')+'">'+state+'</span>';}
function esc(value){const n=document.createElement('span');n.textContent=value??'';return n.innerHTML;}
async function refresh(){try{const s=await api('/api/status');const healthText={GREEN:'GREEN — ready',AMBER:'AMBER — review/action needed',RED:'RED — stopped for safety/integrity',BLOCKED:'BLOCKED — '+(s.factory.blocked_reason||'see factory status')};el('health').textContent=healthText[s.health]||'AMBER — status unavailable';el('health').className='status-pill '+s.health;el('host').innerHTML='<p>'+badge(s.factory.status)+' Shared factory admission</p><p>'+esc(s.factory.blocked_reason||'Ready for heavy work')+'</p><p>Factory '+esc(s.factory.service)+' · Planetiler '+(s.factory.planetiler?'active':'idle')+' · Local AI '+(s.factory.local_ai?'active':'idle')+'</p><p>Lease '+esc(s.factory.lease_owner||'none')+' · RAM '+esc(s.factory.memory_mb)+' MB · CPU '+esc(s.factory.cpu_c??'unknown')+' °C · NVMe '+esc(s.factory.nvme_c??'unknown')+' °C</p>';
el('notifications').textContent=s.notifications.pending+' pending · '+s.notifications.active+' active';
el('runs').innerHTML=s.runs.length?s.runs.map(r=>'<div class="run"><div class="row" style="justify-content:space-between"><h3>'+esc(r.region||r.country_code)+' · '+esc(r.run_id)+'</h3>'+badge(r.status)+'</div><p class="muted">'+(r.kind==='discovery'?r.candidate_count+' independent OSM way-part discoveries · '+r.corroborated_count+' route-supported · '+Number(r.edges_examined||0).toLocaleString()+' edges checked':' '+r.observations_complete+'/'+r.observations_total+' source parts · '+r.candidate_count+' research candidates')+' · '+esc(r.canonical_status||'NOT_COMPARED')+(r.blocked_reason?' · '+esc(r.blocked_reason):'')+'</p><div class="row">'+(r.approvable?'<button class="approve" data-id="'+esc(r.run_id)+'">Approve</button>':'')+(r.kind==='discovery'&&r.processable?'<button class="discovery-process" data-id="'+esc(r.run_id)+'">Process OSM discovery</button>':'')+(r.kind!=='discovery'&&r.processable?'<button class="process" data-id="'+esc(r.run_id)+'">Process approved region</button>':'')+(r.run_exists?'<button class="review" data-id="'+esc(r.run_id)+'">Open Review</button>':'')+'<button class="detail secondary" data-id="'+esc(r.run_id)+'">Details</button></div></div>').join(''):'<p class="muted">No Scout runs registered yet.</p>';
el('runs').querySelectorAll('.approve').forEach(b=>b.onclick=()=>approve(b.dataset.id));el('runs').querySelectorAll('.process').forEach(b=>b.onclick=()=>process(b.dataset.id));el('runs').querySelectorAll('.discovery-process').forEach(b=>b.onclick=()=>processDiscovery(b.dataset.id));el('runs').querySelectorAll('.review').forEach(b=>b.onclick=()=>openReview(b.dataset.id));el('runs').querySelectorAll('.detail').forEach(b=>b.onclick=()=>details(b.dataset.id));}catch(error){el('health').textContent='AMBER';el('host').textContent='Scout status unavailable: '+error.message;}}
el('prepare').addEventListener('change',()=>{const yes=x=>document.querySelector('input[name="'+x+'"]:checked')?.value==='yes';el('license-fields').hidden=!(yes('redistribution')||yes('derived'));});
el('prepare').onsubmit=async event=>{event.preventDefault();const button=el('prepare-button');button.disabled=true;say('prepare-message','Inspecting the selected file and resolving configured provider metadata…');el('prepared').replaceChildren();try{
const file=el('route').files[0],choice=name=>document.querySelector('input[name="'+name+'"]:checked')?.value;
const intent={country_code:el('country').value.trim().toUpperCase(),region:el('region').value.trim(),source_name:el('source-name').value.trim(),source_type:el('source-type').value,
private_research:choice('private')==='yes',redistribution:choice('redistribution')==='yes',derived_public_use:choice('derived')==='yes',legal_evidence:choice('legal')==='yes',source_licence:el('license').value.trim(),attribution:el('attribution').value.trim()};
if(!file)throw Error('Select exactly one route file.');if(!['yes','no'].includes(choice('private')))throw Error('Choose YES or NO for private research.');if(!intent.private_research)throw Error('Private research approval is required for Scout discovery.');
for(const name of ['redistribution','derived','legal'])if(!['yes','no'].includes(choice(name)))throw Error('Choose YES or NO for every source permission.');
if(intent.legal_evidence&&['.gpx','.kml','.kmz'].includes(pathExtension(file.name)))throw Error('A GPX/KML discovery route cannot be treated as legal-access evidence in this workflow. Keep it as a hint or use an authorized legal-evidence source workflow.');
if((intent.redistribution||intent.derived_public_use)&&(!intent.source_licence||!intent.attribution))throw Error('Public or redistribution permission needs the explicit source licence and attribution.');
const result=await api('/api/region/prepare',{method:'POST',headers:{'content-type':'application/octet-stream','x-scout-filename':encodeURIComponent(file.name),'x-scout-intent':encodeURIComponent(JSON.stringify(intent))},body:await file.arrayBuffer()});
say('prepare-message','Prepared. No processing has started. Review the derived metadata, then explicitly approve it.');el('prepared').innerHTML='<div class="choice"><h3>'+esc(result.region_name)+' · '+esc(result.country_code)+'</h3><table><tr><td>Run ID</td><td>'+esc(result.run_id)+'</td></tr><tr><td>Route SHA-256</td><td>'+esc(result.route_sha256)+'</td></tr><tr><td>Route bounds / viewport</td><td>'+esc(result.bounds.join(', '))+'<br>'+esc(result.viewport.join(', '))+'</td></tr><tr><td>Network extract</td><td>'+esc(result.provider)+' · '+esc(result.version)+'<br>'+esc(result.url)+'<br>SHA-256 calculated and pinned only after download</td></tr></table><div class="row"><button id="approve-this">Approve for private Scout processing</button><button id="dismiss" class="secondary">Dismiss</button></div></div>';
el('approve-this').onclick=()=>approve(result.run_id);el('dismiss').onclick=()=>el('prepared').replaceChildren();await refresh();
}catch(error){say('prepare-message',error.message,true);}finally{button.disabled=false;}};
function pathExtension(value){return value.slice(value.lastIndexOf('.')).toLowerCase();}
async function approve(runId){if(!confirm('Record these source permissions and approve this specific region plan for Scout processing? This does not approve motorcycle access, canonical import, or publication.'))return;try{await api('/api/region/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run_id:runId,approved_by:'Karl',approval_scope:'Private Scout regional discovery; permissions explicitly selected in the preparation form'})});say('prepare-message','Approved for the recorded Scout scope. Processing has not started.');await refresh();}catch(error){say('prepare-message',error.message,true);}}
async function process(runId){if(!confirm('Start the approved regional pipeline? Scout will yield to factory intent and save progress for resumption.'))return;try{const result=await api('/api/region/process',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run_id:runId})});say('prepare-message',result.already_running?'This region is already running.':'Regional processing started. You can close this window; Scout state is persistent.');await refresh();}catch(error){say('prepare-message',error.message,true);}}
async function processDiscovery(runId){if(!confirm('Start independent OSM regional discovery? Scout will scan the full registered jurisdiction extent, yield to factory work, and keep access/routability unknown.'))return;try{const result=await api('/api/discovery/process',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run_id:runId})});say('prepare-message',result.already_running?'This discovery run is already running.':'OSM discovery started. You can close this window; Scout state is persistent.');await refresh();}catch(error){say('prepare-message',error.message,true);}}
async function openReview(runId){const blank=window.open('about:blank','_blank');try{const result=await api('/api/review/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run_id:runId})});if(blank)blank.location=result.url;else location.href=result.url;}catch(error){blank?.close();say('prepare-message',error.message,true);}}
async function details(runId){try{const result=await api('/api/region/status?run_id='+encodeURIComponent(runId));alert(JSON.stringify(result,null,2));}catch(error){say('prepare-message',error.message,true);}}
el('refresh').onclick=refresh;el('exit').onclick=async()=>{if(!confirm('Close the Scout operator window? Active jobs keep their persistent state and are not discarded.'))return;try{await api('/api/shutdown',{method:'POST'});say('exit-message','Scout operator closed.');}catch(error){say('exit-message',error.message,true);}};refresh();setInterval(refresh,10000);
</script></body></html>`;

async function readBody(req,maxBytes){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Object.assign(new Error('Selected route file exceeds the 16 MB import limit.'),{status:413});chunks.push(chunk);}return Buffer.concat(chunks,size);}
function routeType(filename){const ext=path.extname(filename).toLowerCase();return ({'.gpx':'gpx','.kml':'kml','.geojson':'geojson','.json':'geojson'})[ext]??null;}
function runSummary(store){return store.listRuns().map(run=>{const plan=store.getRegionPlan(run.run_id),count=Number(store.db.prepare(`SELECT count(*) n FROM candidates c JOIN route_segments s USING(segment_id) JOIN scout_run_observations ro USING(observation_id) WHERE ro.run_id=? AND ro.status='COMPLETE' AND s.pipeline_version=ro.pipeline_version`).get(run.run_id).n);
return {run_id:run.run_id,region:plan?.plan.region_name??run.region_id,country_code:run.country_code,status:plan?.state??run.status,observations_complete:run.observation_counts.COMPLETE??0,observations_total:Object.values(run.observation_counts).reduce((a,b)=>a+b,0),candidate_count:count,canonical_status:run.config.canonical_status??'NOT_COMPARED',run_exists:true,approvable:Boolean(plan&&plan.state==='PREPARED'),processable:Boolean(plan&&['APPROVED','BLOCKED','FAILED','RUNNING'].includes(plan.state)),updated_at:plan?.updated_at??run.updated_at};
}).concat(store.listRegionPlans().filter(plan=>!store.getRun(plan.run_id)).map(plan=>({run_id:plan.run_id,region:plan.plan.region_name,country_code:plan.plan.country_code,status:plan.state,observations_complete:0,observations_total:plan.plan.route_file.observation_count,candidate_count:0,canonical_status:'NOT_COMPARED',run_exists:false,approvable:plan.state==='PREPARED',processable:['APPROVED','BLOCKED','FAILED'].includes(plan.state),updated_at:plan.updated_at})))
.concat(store.listDiscoveryRuns().map(run=>({kind:'discovery',run_id:run.run_id,region:run.region_id,country_code:run.country_code,status:run.status,observations_complete:0,observations_total:0,
  candidate_count:Number(store.db.prepare('SELECT count(*) n FROM discovery_candidates WHERE run_id=?').get(run.run_id).n),corroborated_count:Number(store.db.prepare("SELECT count(DISTINCT candidate_id) n FROM discovery_candidate_matches WHERE relationship='same_osm_network_part_support' AND candidate_id IN (SELECT candidate_id FROM discovery_candidates WHERE run_id=?)").get(run.run_id).n),
  blocked_reason:run.last_error,edges_examined:run.edges_examined,checkpoint_edge_rowid:run.checkpoint_edge_rowid,
  canonical_status:run.config.canonical_status??'NOT_COMPARED',run_exists:true,approvable:false,processable:['PENDING','BLOCKED','FAILED','RUNNING'].includes(run.status),updated_at:run.updated_at})))
.sort((a,b)=>b.updated_at.localeCompare(a.updated_at));}

export function createScoutOperatorServer({geoRoot=process.env.SCOUT_GEO_ROOT,rawRoot=process.env.SCOUT_RAW_ROOT,factoryDir=process.env.FACTORY_DIR??path.join(os.homedir(),'rtt-map-factory'),port=DEFAULT_PORT,spawnImpl=spawn,openReviewer=createRealReviewServer,readHost=readHostSnapshot,notificationEmail=process.env.SCOUT_NOTIFICATION_EMAIL}={}){
  if(!geoRoot||!rawRoot)throw new Error('SCOUT_GEO_ROOT and SCOUT_RAW_ROOT must name private Scout directories');
  const root=path.resolve(geoRoot),raw=path.resolve(rawRoot);if(root===REPO||root.startsWith(REPO+path.sep)||raw===REPO||raw.startsWith(REPO+path.sep))throw new Error('Scout operator data must remain outside the code/public tree');
  privateDirectory(root);privateDirectory(raw);const token=crypto.randomBytes(32).toString('hex'),children=new Map(),reviewers=new Map();let closing=false,boundPort=port;
  const app=http.createServer(async(req,res)=>{
    try{
      if(!requestHostAllowed(req))return json(res,403,{error:'Scout operator is loopback-only.'});
      if(req.method==='GET'&&req.url==='/health')return json(res,200,{status:'RTT_SCOUT_READY'});
      if(req.method==='GET'&&req.url==='/'){
        const scriptToken=crypto.randomBytes(18).toString('base64url');res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'nonce-${scriptToken}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,'referrer-policy':'no-referrer'});return res.end(HTML(token).replaceAll('<script nonce="'+token+'">','<script nonce="'+scriptToken+'">'));
      }
      if(req.method==='GET'&&req.url==='/api/status'){
        const store=new ScoutGeoStore(root);try{const host=readHost({factoryDir}),notifications=new NotificationCenter(path.join(root,'notifications','scout-notifications.json')).state();
          const runs=runSummary(store),notificationState={pending:notifications.pending.length,active:Object.values(notifications.active).filter(item=>!item.resolved).length};
          return json(res,200,{health:deriveOperatorHealth(host,notificationState,runs),factory:{status:host.factory_coordination?.status??'UNVERIFIED',blocked_reason:operatorBlockedReason(host),service:host.factory_service_state??'unknown',planetiler:Boolean(host.planetiler_active),local_ai:Boolean(host.local_ai_active),lease_owner:host.resource_lease_owner??null,memory_mb:host.mem_available_mb??null,cpu_c:host.cpu_temp_c??null,nvme_c:host.nvme_temp_c??null},notifications:notificationState,runs});
        }finally{store.close();}
      }
      if(req.method==='GET'&&req.url.startsWith('/api/region/status?')){
        const id=new URL(req.url,'http://127.0.0.1').searchParams.get('run_id');if(!safeId(id))return json(res,400,{error:'Choose a valid Scout run.'});const store=new ScoutGeoStore(root);try{const p=store.getRegionPlan(id);if(!p)return json(res,404,{error:'Region plan not found.'});const r=store.getRun(id);return json(res,200,{run_id:id,state:p.state,stages:p.stages,last_error:p.last_error,permissions:p.plan.permissions,route:{filename:p.plan.route_file.original_filename,sha256:p.plan.route_file.sha256,bounds:p.plan.route_file.bounds,viewport:p.plan.route_file.viewport},network:{provider:p.plan.provider.provider,version:p.plan.provider.version,snapshot_id:p.plan.provider.snapshot_id,url:p.plan.provider.url,artifact:store.getNetworkArtifact(p.plan.provider.snapshot_id),edges:store.networkEdgeCount(p.plan.provider.snapshot_id)},observations:r?.observation_counts??{},canonical_status:'NOT_COMPARED'});}finally{store.close();}
      }
      const writePaths=['/api/region/prepare','/api/region/approve','/api/region/process','/api/discovery/process','/api/review/open','/api/shutdown'];
      if(req.method==='POST'&&writePaths.includes(req.url.split('?')[0])){
        const origin=req.headers.origin;if(origin!==`http://127.0.0.1:${boundPort}`||req.headers['x-scout-token']!==token)return json(res,403,{error:'This Scout action needs a valid local session.'});
        if(req.url==='/api/region/prepare'){
          if(!routeType(decodeURIComponent(req.headers['x-scout-filename']??'')))return json(res,400,{error:'Select one GPX, KML, or GeoJSON route file.'});
          const input=await readBody(req,MAX_UPLOAD),intent=JSON.parse(decodeURIComponent(req.headers['x-scout-intent']??''));if(input.length===0)return json(res,400,{error:'Selected route file is empty.'});
          const original=path.basename(decodeURIComponent(req.headers['x-scout-filename'])),digest=crypto.createHash('sha256').update(input).digest('hex'),name=`${digest}-${original.replace(/[^a-zA-Z0-9._-]/g,'_')}`,inbox=privateDirectory(path.join(root,'operator-inbox')),selected=path.join(inbox,name);
          if(fs.existsSync(selected)){if(fs.lstatSync(selected).isSymbolicLink()||!fs.statSync(selected).isFile()||crypto.createHash('sha256').update(fs.readFileSync(selected)).digest('hex')!==digest)return json(res,409,{error:'A private selected-file entry already exists with different contents.'});}
          else{const fd=fs.openSync(selected,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,input);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
          const store=new ScoutGeoStore(root);try{const plan=await prepareRegionPlan(store,{routeFile:selected,countryCode:intent.country_code,regionName:intent.region,sourceName:intent.source_name,sourceType:intent.source_type,
            permissions:{private_processing:intent.private_research,redistribution:intent.redistribution,derived_public_use:intent.derived_public_use,legal_evidence:intent.legal_evidence},sourceLicence:intent.source_licence,attribution:intent.attribution});
            return json(res,200,{run_id:plan.run_id,country_code:plan.plan.country_code,region_name:plan.plan.region_name,route_sha256:plan.plan.route_file.sha256,bounds:plan.plan.route_file.bounds,viewport:plan.plan.route_file.viewport,provider:plan.plan.provider.provider,version:plan.plan.provider.version,url:plan.plan.provider.url,snapshot_id:plan.plan.provider.snapshot_id});
          }finally{store.close();}
        }
        const input=await readBody(req,64*1024),body=JSON.parse(input.toString('utf8'));
        if(req.url==='/api/region/approve'){
          if(!safeId(body.run_id)||body.approved_by!=='Karl')return json(res,400,{error:'Region approval identity or plan ID is invalid.'});const store=new ScoutGeoStore(root);try{const p=approveRegionPlan(store,{runId:body.run_id,approvedBy:body.approved_by,approvalScope:body.approval_scope});return json(res,200,{run_id:p.run_id,state:p.state});}finally{store.close();}
        }
        if(req.url==='/api/region/process'){
          if(!safeId(body.run_id))return json(res,400,{error:'Choose a valid Scout run.'});const store=new ScoutGeoStore(root);try{const p=store.getRegionPlan(body.run_id);if(!p||!p.approved_by)return json(res,409,{error:'This region does not have an explicit Karl approval.'});if(['RUNNING'].includes(p.state)||children.has(body.run_id))return json(res,200,{already_running:true,run_id:body.run_id});}finally{store.close();}
          const logDir=privateDirectory(path.join(root,'operator-logs')),log=fs.openSync(path.join(logDir,`${body.run_id}.log`),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);
          const child=spawnImpl(process.execPath,[path.join(HERE,'geoctl.mjs'),'region','process','--run-id',body.run_id],{cwd:REPO,env:scoutJobEnvironment(process.env,{root,raw,factoryDir,notificationEmail}),detached:true,stdio:['ignore',log,log]});fs.closeSync(log);child.once('error',()=>children.delete(body.run_id));child.once('close',()=>children.delete(body.run_id));child.unref();children.set(body.run_id,child);return json(res,202,{started:true,run_id:body.run_id});
        }
        if(req.url==='/api/discovery/process'){
          if(!safeId(body.run_id))return json(res,400,{error:'Choose a valid Scout discovery run.'});const store=new ScoutGeoStore(root);try{const run=store.getDiscoveryRun(body.run_id);if(!run)return json(res,409,{error:'Independent discovery run is not registered.'});
            const approval=store.sourceApproval(run.discovery_source_id);if(!approval||approval.approved_by!==run.approved_by||approval.scope!==run.approval_scope)return json(res,409,{error:'Discovery source approval is no longer active; review it before processing.'});
            if(run.status==='RUNNING'||children.has(body.run_id))return json(res,200,{already_running:true,run_id:body.run_id});}finally{store.close();}
          const logDir=privateDirectory(path.join(root,'operator-logs')),log=fs.openSync(path.join(logDir,`${body.run_id}.log`),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);
          const child=spawnImpl(process.execPath,[path.join(HERE,'geoctl.mjs'),'discover','process','--run-id',body.run_id],{cwd:REPO,env:scoutJobEnvironment(process.env,{root,raw,factoryDir,notificationEmail}),detached:true,stdio:['ignore',log,log]});fs.closeSync(log);child.once('error',()=>children.delete(body.run_id));child.once('close',()=>children.delete(body.run_id));child.unref();children.set(body.run_id,child);return json(res,202,{started:true,run_id:body.run_id});
        }
        if(req.url==='/api/review/open'){
          if(!safeId(body.run_id))return json(res,400,{error:'Choose a valid Scout run.'});const store=new ScoutGeoStore(root);try{if(!store.getRun(body.run_id)&&!store.getDiscoveryRun(body.run_id))return json(res,409,{error:'Review opens after a run has been created.'});}finally{store.close();}
          let entry=reviewers.get(body.run_id);if(!entry){const review=openReviewer({runId:body.run_id,port:0,privateBase:root,databaseFile:path.join(root,'scout.sqlite')});await new Promise((resolve,reject)=>{review.once('listening',resolve);review.once('error',reject);review.listen(0,'127.0.0.1');});entry={server:review,url:`http://127.0.0.1:${review.address().port}/`};reviewers.set(body.run_id,entry);review.once('close',()=>reviewers.delete(body.run_id));}
          return json(res,200,{url:entry.url});
        }
        if(req.url==='/api/shutdown'){
          if(closing)return json(res,200,{stopping:true});closing=true;json(res,200,{stopping:true});setTimeout(()=>{for(const reviewer of reviewers.values())reviewer.server.close();app.close(()=>process.exit(0));},50).unref();return;
        }
      }
      if(req.method!=='GET')return json(res,405,{error:'Unsupported local operator request.'});return json(res,404,{error:'Scout page not found.'});
    }catch(error){if(!res.headersSent)return json(res,error.status??400,{error:errorMessage(error)});res.destroy();}
  });
  app.on('clientError',(_error,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  app.once('close',()=>{for(const entry of reviewers.values()){entry.server.closeAllConnections?.();entry.server.close();}reviewers.clear();});
  app.on('listening',()=>{boundPort=app.address().port;});
  return app;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const server=createScoutOperatorServer();server.listen(Number(process.env.SCOUT_OPERATOR_PORT??DEFAULT_PORT),'127.0.0.1',()=>console.log(`RT&T Scout local operator listening at http://127.0.0.1:${server.address().port}/`));}
  catch(error){console.error(errorMessage(error));process.exitCode=2;}
}
