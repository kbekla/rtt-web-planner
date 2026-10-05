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
import { evaluateMotorcycleAccess, deriveOperationalState } from './corridor-evidence.mjs';
import { deriveScoutProductState, deriveResearchWorkflow, publicScoutStatus, routeUseDecision } from './product-model.mjs';

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
function tableExists(db,name){return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));}
function escapeHtml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');}
const RELEVANT_OSM_TAGS=['highway','surface','tracktype','smoothness','service','access','motor_vehicle','motorcycle','vehicle','construction','ford','bridge','tunnel','name','ref','lit','width','oneway'];
function selectedTags(raw){const input=JSON.parse(raw),out={};for(const key of RELEVANT_OSM_TAGS)if(input[key]!=null)out[key]=input[key];return out;}
function corridorLegalAssessment(db,corridorId,physical='probable',routability='unknown'){
  const rows=db.prepare('SELECT l.*,s.current_json source_json FROM legal_status_records l JOIN source_registry s USING(source_id) WHERE l.corridor_id=? ORDER BY l.retrieved_at DESC').all(corridorId);
  const records=rows.map(r=>{const source=JSON.parse(r.source_json);return {...JSON.parse(r.evidence_json),status_record_id:r.status_record_id,source_id:r.source_id,source_version:r.source_version,
    authority_category:source.authority?.category??'UNKNOWN',source_authority_name:source.authority?.name??null,qualified:Boolean(r.qualified),review_state:r.review_state};});
  const access=evaluateMotorcycleAccess(records,{geometryIdentity:'MATCHED',jurisdictionIdentity:'MATCHED'});
  return {records,access,operational_state:deriveOperationalState({physical,access:access.access,routability,accessEvaluation:access})};
}
function corridorProduct(physical, classification, access, accessEvaluation, routability, reviewState='CATALOGUED', identityState='MATCHED', legalRecords=[], geometryAvailable=false){
  const productState=deriveScoutProductState({physicalExistence:physical,physicalCharacter:classification,motorcycleAccess:access,
    accessEvaluation, routability, credibleDiscovery:true});
  const researchState=deriveResearchWorkflow({reviewState,productState,geometryIdentity:identityState,
    authoritativeConflict:accessEvaluation?.contradiction===true||accessEvaluation?.operational_state==='REVIEW_REQUIRED'});
  const statusRecord=legalRecords.find(record=>accessEvaluation?.evidence_ids?.includes(record.status_record_id)&&record.authority_category==='AUTHORITATIVE'&&record.source_authority_name&&
    ['PROHIBIT_MOTORCYCLE','CLOSE_TO_MOTORCYCLE','PROHIBIT_MOTOR_VEHICLES'].includes(record.legal_effect));
  return {product_state:productState,product:publicScoutStatus({productState,authorityName:statusRecord?.source_authority_name,
      authorityDirectlySupportsStatus:Boolean(statusRecord&&(productState==='RED'||productState==='TEMPORARILY_CLOSED')),restrictionUntil:statusRecord?.effective_until}),research_state:researchState,
    route_modes:{automatic:routeUseDecision({productState,mode:'AUTO',geometryAvailable,routability}).allowed,
      manual:routeUseDecision({productState,mode:'MANUAL',geometryAvailable,routability}).allowed}};
}
function hasUsableLine(geometryJson){try{const geometry=JSON.parse(geometryJson);return geometry?.type==='LineString'?Array.isArray(geometry.coordinates)&&geometry.coordinates.length>=2:geometry?.type==='MultiLineString'&&geometry.coordinates.some(line=>Array.isArray(line)&&line.length>=2);}catch{return false;}}
export function queryRouteHintSupports(db,candidateId){
  return db.prepare(`SELECT m.relationship,m.related_id route_candidate_id,sf.source_id,sr.current_json source_json,
    sf.relative_name,sf.sha256,sf.version,ro.source_part,m.evidence_json
    FROM discovery_candidate_matches m JOIN candidates c ON c.candidate_id=m.related_id JOIN route_segments rs ON rs.segment_id=c.segment_id
    JOIN route_observations ro ON ro.observation_id=rs.observation_id JOIN source_files sf ON sf.file_id=ro.file_id
    JOIN source_registry sr ON sr.source_id=sf.source_id WHERE m.candidate_id=? AND m.relationship='same_osm_network_part_support'`).all(candidateId)
    .map(item=>({...item,source:JSON.parse(item.source_json),evidence:JSON.parse(item.evidence_json)}));
}
function geometryLength(geometry){const parts=geometry.type==='LineString'?[geometry.coordinates]:geometry.coordinates;return parts.reduce((sum,line)=>sum+line.slice(1).reduce((n,p,i)=>n+lengthMeters(line[i],p),0),0);}

export function createRealReviewServer({runId,port=0,privateBase=DEFAULT_PRIVATE_BASE,databaseFile=null,onError=()=>{},autostart=true}={}){
  if(!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(runId))throw new Error('review requires one explicit safe Scout run ID');
  const base=path.resolve(privateBase),legacyRoot=path.join(base,runId),dbFile=databaseFile?path.resolve(databaseFile):path.join(legacyRoot,'state/scout.sqlite');
  if(fs.lstatSync(base).isSymbolicLink())throw new Error('private review storage cannot contain symlinks');
  assertNoSymlinkComponents(base,path.dirname(dbFile));
  try{if(fs.lstatSync(dbFile).isSymbolicLink())throw new Error('private review storage cannot contain symlinks');}catch(error){if(error.code!=='ENOENT')throw error;}
  const storageRoot=path.dirname(dbFile);
  if(!inPrivateTree(storageRoot,base)||fs.realpathSync(base)===fs.realpathSync(REPO))throw new Error('review data must remain in configured private Scout storage');
  const st=fs.statSync(dbFile);if(!st.isFile()||(st.mode&0o077)!==0)throw new Error('private review database must be a regular owner-only file');
  const db=new DatabaseSync(dbFile,{readOnly:true});
  const standardRun=db.prepare('SELECT * FROM scout_runs WHERE run_id=?').get(runId),discoveryRow=standardRun?null:db.prepare('SELECT * FROM discovery_runs WHERE run_id=?').get(runId);
  if(!standardRun&&!discoveryRow){db.close();throw new Error(`Scout run '${runId}' is not registered`);}
  const isDiscovery=Boolean(discoveryRow),runRow=standardRun??discoveryRow,routeRunId=isDiscovery?discoveryRow.reference_run_id:runId;
  const run={...runRow,run_id:runId,config:JSON.parse(runRow.config_json)};
  const snapshot=db.prepare('SELECT snapshot_id,source_id,version,checksum,licence_json,coverage_json FROM network_snapshots WHERE snapshot_id=?').get(run.snapshot_id);
  if(!snapshot){db.close();throw new Error('registered run network snapshot is missing');}
  const referenceRun=routeRunId?db.prepare('SELECT * FROM scout_runs WHERE run_id=?').get(routeRunId):null;
  const sourceId=isDiscovery?(referenceRun?.source_id??discoveryRow.discovery_source_id):run.source_id;
  const sourceRow=db.prepare('SELECT current_json FROM source_registry WHERE source_id=?').get(sourceId);
  if(!sourceRow){db.close();throw new Error('registered private source record is missing');}
  const discoverySourceRow=isDiscovery?db.prepare('SELECT current_json FROM source_registry WHERE source_id=?').get(discoveryRow.discovery_source_id):null;
  if(isDiscovery&&!discoverySourceRow){db.close();throw new Error('registered private OSM discovery source record is missing');}
  const networkSource=db.prepare('SELECT current_json FROM source_registry WHERE source_id=?').get(snapshot.source_id);
  if(!networkSource){db.close();throw new Error('registered regional network source is missing');}
  const source=JSON.parse(sourceRow.current_json),discoverySource=discoverySourceRow?JSON.parse(discoverySourceRow.current_json):null,network=JSON.parse(networkSource.current_json),licence=JSON.parse(snapshot.licence_json);
  const matchedNetworkIds=new Set();
  for(const row of db.prepare(`SELECT s.evidence_json FROM route_segments s JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version
    WHERE ro.run_id=? AND ro.status='COMPLETE'`).iterate(routeRunId??'__no_reference_run__')){
    for(const item of JSON.parse(row.evidence_json)){if(item.edge_id)matchedNetworkIds.add(item.edge_id);for(const id of item.edge_ids??[])matchedNetworkIds.add(id);}
  }
  const tagByEdge=new Map(),networkIds=[...matchedNetworkIds];
  for(let i=0;i<networkIds.length;i+=500){const chunk=networkIds.slice(i,i+500),rows=db.prepare(`SELECT edge_id,tags_json FROM network_edges WHERE snapshot_id=? AND edge_id IN (${chunk.map(()=>'?').join(',')})`).all(snapshot.snapshot_id,...chunk);for(const row of rows)tagByEdge.set(row.edge_id,selectedTags(row.tags_json));}
  const continuityBySubject=new Map();
  for(const row of db.prepare(`SELECT h.hypothesis_id,h.candidate_ids_json,h.connector_segment_ids_json FROM corridor_hypotheses h
    JOIN scout_run_observations ro USING(observation_id) WHERE ro.run_id=? AND ro.status='COMPLETE' AND EXISTS(
      SELECT 1 FROM json_each(h.candidate_ids_json) ids JOIN candidates c ON c.candidate_id=ids.value
      JOIN route_segments s USING(segment_id) WHERE s.pipeline_version=ro.pipeline_version)`).all(routeRunId??'__no_reference_run__')){
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
        const routeCounts=routeRunId?db.prepare(`SELECT (SELECT count(*) FROM scout_run_observations WHERE run_id=?) observations,
          (SELECT count(*) FROM route_segments s JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version WHERE ro.run_id=? AND ro.status='COMPLETE') segments,
          (SELECT count(*) FROM candidates c JOIN route_segments s USING(segment_id) JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version WHERE ro.run_id=? AND ro.status='COMPLETE') candidates,
          (SELECT count(DISTINCT h.hypothesis_id) FROM corridor_hypotheses h JOIN scout_run_observations ro USING(observation_id)
            WHERE ro.run_id=? AND ro.status='COMPLETE' AND EXISTS(SELECT 1 FROM json_each(h.candidate_ids_json) ids JOIN candidates c ON c.candidate_id=ids.value
              JOIN route_segments s USING(segment_id) WHERE s.pipeline_version=ro.pipeline_version)) corridor_hypotheses`)
          .get(routeRunId,routeRunId,routeRunId,routeRunId):{observations:0,segments:0,candidates:0,corridor_hypotheses:0};
        const networkEdges=Number(db.prepare('SELECT count(*) n FROM network_edges WHERE snapshot_id=?').get(snapshot.snapshot_id).n);
        const discoveryCandidates=isDiscovery?Number(db.prepare('SELECT count(*) n FROM discovery_candidates WHERE run_id=?').get(runId).n):0;
        const physicalCorridors=tableExists(db,'physical_corridor_versions')?Number(db.prepare('SELECT count(*) n FROM physical_corridor_versions WHERE run_id=?').get(runId).n):0;
        // State-index-first keeps this scalar bounded to active review states.
        const corridorQueue=tableExists(db,'corridor_review_queue')?Number(db.prepare(`SELECT count(*) n FROM corridor_review_queue q INDEXED BY corridor_review_queue_state_idx
          CROSS JOIN physical_corridor_versions v ON v.corridor_version_id=q.corridor_version_id
          WHERE q.state IN ('UNREVIEWED','AMBIGUOUS','NEEDS_MORE_EVIDENCE') AND v.run_id=?`).get(runId).n):0;
        const discoveryCorroborated=isDiscovery?Number(db.prepare(`SELECT count(DISTINCT d.candidate_id) n FROM discovery_candidates d
          JOIN discovery_candidate_matches m ON m.candidate_id=d.candidate_id WHERE d.run_id=? AND m.relationship='same_osm_network_part_support'`).get(runId).n):0;
        const counts={...routeCounts,network_edges:networkEdges,discovery_candidates:discoveryCandidates,physical_corridors:physicalCorridors,
          corridor_review_queue:corridorQueue,discovery_corroborated:discoveryCorroborated};
        return reply(res,200,JSON.stringify({mode:'PRIVATE_SCOUT_REVIEW',bind:'127.0.0.1',public:false,read_only:true,private_data_loaded:true,
          run_id:runId,run_status:run.status,country_code:run.country_code,region_id:run.region_id,title:run.config.title,source_id:source.source_id,
          discovery_run:isDiscovery,reference_run_id:routeRunId,discovery_source_id:discoverySource?.source_id??null,
          network_snapshot_id:snapshot.snapshot_id,network_version:snapshot.version,network_sha256:snapshot.checksum,
          attribution:licence.attribution??network.attribution,licence:licence.name,matched_network_edge_ids:matchedNetworkIds.size,...counts}),MIME['.json']);
      }
      if(url.pathname==='/api/review-queue'){
        if(!isDiscovery||!tableExists(db,'corridor_review_queue'))return reply(res,200,JSON.stringify({state:'UNREVIEWED',count:0,items:[]}),MIME['.json']);
        const state=url.searchParams.get('state')??'UNREVIEWED',limit=Number(url.searchParams.get('limit')??200);
        if(!['UNREVIEWED','AMBIGUOUS','NEEDS_MORE_EVIDENCE','LOW_VALUE','CATALOGUED','HOLD'].includes(state)||!Number.isInteger(limit)||limit<1||limit>500)return reply(res,400,'invalid review queue state or limit');
        // UNREVIEWED/AMBIGUOUS rows are selective; CROSS JOIN preserves the
        // queue-state-index-first plan and avoids catalog-wide geometry scans.
        const rows=db.prepare(`SELECT v.corridor_id,v.corridor_version_id,v.classification,v.physical_existence,v.motorcycle_access,v.routability,
          v.canonical_status,v.identity_state,v.length_m,v.geometry_json,q.state,q.reason_code,q.priority
          FROM corridor_review_queue q INDEXED BY corridor_review_queue_state_idx
          CROSS JOIN physical_corridor_versions v ON v.corridor_version_id=q.corridor_version_id
          WHERE q.state=? AND v.run_id=?
          ORDER BY CASE q.priority WHEN 'HIGH_VALUE' THEN 0 WHEN 'LEGAL_REVIEW' THEN 1 WHEN 'GEOMETRY_REVIEW' THEN 2 WHEN 'NORMAL_REVIEW' THEN 3 ELSE 4 END,
            v.length_m DESC,v.corridor_id LIMIT ?`).all(state,runId,limit+1);
        const items=rows.slice(0,limit).map(row=>{const legal=corridorLegalAssessment(db,row.corridor_id,row.physical_existence,row.routability),product=corridorProduct(row.physical_existence,row.classification,legal.access.access,legal.access,row.routability,row.state,row.identity_state,legal.records,hasUsableLine(row.geometry_json));return feature(JSON.parse(row.geometry_json),{corridor_id:row.corridor_id,corridor_version_id:row.corridor_version_id,
          classification:row.classification,physical_existence:row.physical_existence,motorcycle_access:row.motorcycle_access,routability:row.routability,
          canonical_status:row.canonical_status,identity_state:row.identity_state,length_m:row.length_m,review_state:row.state,review_reason:row.reason_code,review_priority:row.priority,...product});});
        return reply(res,200,JSON.stringify({state:state==='UNREVIEWED'?'SCOUT_RESEARCH_REQUIRED':state,count:items.length,truncated:rows.length>limit,items}),MIME['.json']);
      }
      if(url.pathname==='/api/source-routes'){
        const rows=routeRunId?db.prepare(`SELECT o.observation_id,o.source_part,o.source_name,o.geometry_json,f.version,f.sha256 FROM route_observations o JOIN source_files f USING(file_id)
          JOIN scout_run_observations ro USING(observation_id) WHERE ro.run_id=? ORDER BY o.source_part`).all(routeRunId):[];
        const collection={type:'FeatureCollection',features:rows.map(r=>feature(lineGeometry(r),{id:r.observation_id,source_part:r.source_part,source_name:r.source_name,
          source_id:source.source_id,source_file_version:r.version,source_file_sha256:r.sha256,privacy:'private discovery geometry'}))};
        return reply(res,200,JSON.stringify(collection),MIME['.json']);
      }
      if(url.pathname.startsWith('/api/segment/')){
        if(!routeRunId)return reply(res,404,'segment not found');
        const segmentId=decodeURIComponent(url.pathname.slice('/api/segment/'.length));
        if(!/^[a-z0-9._:-]{1,160}$/i.test(segmentId))return reply(res,404,'segment not found');
        const r=db.prepare(`SELECT s.segment_id,s.observation_id,s.ordinal,s.component_index,s.classification,s.confidence,s.geometry_json,s.evidence_json,
          s.jurisdiction_ids_json,o.source_part,o.source_name,c.candidate_id,c.master_match,c.physical_state,c.motorcycle_access,c.routability,c.review_state,c.issues_json,c.matched_rtt_ids_json,c.match_details_json
          FROM route_segments s JOIN route_observations o USING(observation_id) JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version
          LEFT JOIN candidates c USING(segment_id) WHERE ro.run_id=? AND ro.status='COMPLETE' AND s.segment_id=?`).get(routeRunId,segmentId);
        if(!r)return reply(res,404,'segment not found');
        const geometry=lineGeometry(r),evidence=JSON.parse(r.evidence_json),ids=[...new Set(evidence.flatMap(e=>[...(e.edge_id?[e.edge_id]:[]),...(e.edge_ids??[])]))];
        const details=JSON.parse(r.match_details_json??'{}'),match=r.master_match==='UNMATCHED'&&details.reason==='canonical master not supplied'?'NOT_COMPARED':r.master_match??'NOT_COMPARED';
        const decision=db.prepare('SELECT decision,reviewer,reason,decided_at FROM review_decisions WHERE candidate_id=? ORDER BY decided_at DESC,decision_id DESC LIMIT 1').get(r.candidate_id);
        const network_matches=ids.map(id=>{const edge=db.prepare('SELECT tags_json FROM network_edges WHERE snapshot_id=? AND edge_id=?').get(snapshot.snapshot_id,id);return {edge_id:id,tags:edge?selectedTags(edge.tags_json):{}};});
        return reply(res,200,JSON.stringify(feature(geometry,{id:r.segment_id,segment_id:r.segment_id,candidate_id:r.candidate_id,source_observation_id:r.observation_id,
          source_part:r.source_part,source_track:r.source_name,classification:r.classification,confidence:r.confidence,match,physical_existence:r.physical_state??'unknown',
          motorcycle_access:r.motorcycle_access??'unknown',routability:r.routability??'unknown',review_state:r.review_state??'AWAITING_EVIDENCE',
          length_m:Number(geometryLength(geometry).toFixed(2)),review_decision:decision?.decision??'UNREVIEWED',reviewer:decision?.reviewer??null,
          reviewed_at:decision?.decided_at??null,review_reason:decision?.reason??null,corridor_hypothesis_id:continuityBySubject.get(r.candidate_id??r.segment_id)??null,
          jurisdiction_ids:JSON.parse(r.jurisdiction_ids_json),matched_rtt_ids:JSON.parse(r.matched_rtt_ids_json??'[]'),issues:JSON.parse(r.issues_json??'[]'),network_matches,evidence})),MIME['.json']);
      }
      if(url.pathname==='/api/segments'){
        const bounds=bbox(url.searchParams.get('bbox'));if(!bounds)return reply(res,400,'invalid bbox');
        const [w,s,e,n]=bounds,limit=Number(url.searchParams.get('limit')??2000);if(!Number.isInteger(limit)||limit<1||limit>20000)return reply(res,400,'limit must be 1-20000');
        const query=db.prepare(`SELECT s.segment_id,s.observation_id,s.ordinal,s.component_index,s.classification,s.confidence,s.geometry_json,s.evidence_json,
          s.jurisdiction_ids_json,s.pipeline_version,o.source_part,o.source_name,c.candidate_id,c.master_match,c.physical_state,c.motorcycle_access,c.routability,c.review_state,c.issues_json,c.matched_rtt_ids_json,c.match_details_json
          FROM route_segments s JOIN route_observations o USING(observation_id) JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version
          LEFT JOIN candidates c USING(segment_id) JOIN route_segments_rtree r USING(segment_rowid)
          WHERE ro.run_id=? AND ro.status='COMPLETE'
            AND r.max_lon>=? AND r.min_lon<=? AND r.max_lat>=? AND r.min_lat<=? ORDER BY s.segment_id LIMIT ?`);
        const rows=routeRunId?(w<=e?query.all(routeRunId,w,e,s,n,limit+1):query.all(routeRunId,w,180,s,n,limit+1).concat(query.all(routeRunId,-180,e,s,n,limit+1))):[];
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
            network_matches:ids.map(id=>({edge_id:id,tags:tagByEdge.get(id)??{}})),evidence_summary:{rules:[...new Set(evidence.map(e=>e.rule).filter(Boolean))],network_edge_ids:ids}});
        });
        return reply(res,200,JSON.stringify({type:'FeatureCollection',features,truncated:rows.length>limit,read_only:true}),MIME['.json']);
      }
      if(url.pathname==='/api/discovery-candidates'){
        if(!isDiscovery)return reply(res,200,JSON.stringify({type:'FeatureCollection',features:[],truncated:false}),MIME['.json']);
        const bounds=bbox(url.searchParams.get('bbox'));if(!bounds)return reply(res,400,'invalid bbox');const limit=Number(url.searchParams.get('limit')??1000);
        if(!Number.isInteger(limit)||limit<1||limit>10000)return reply(res,400,'limit must be 1-10000');const [w,s,e,n]=bounds;
        const sql=`SELECT d.* FROM discovery_candidates d JOIN discovery_candidates_rtree r USING(candidate_rowid) WHERE d.run_id=? AND r.max_lon>=? AND r.min_lon<=? AND r.max_lat>=? AND r.min_lat<=? ORDER BY d.candidate_id LIMIT ?`;
        const rows=w<=e?db.prepare(sql).all(runId,w,e,s,n,limit+1):db.prepare(sql).all(runId,w,180,s,n,limit+1).concat(db.prepare(sql).all(runId,-180,e,s,n,limit+1));
        const unique=[...new Map(rows.map(r=>[r.candidate_id,r])).values()].slice(0,limit),features=unique.map(r=>{
          const sources=db.prepare('SELECT source_id,relationship,source_reference,evidence_json FROM discovery_candidate_sources WHERE candidate_id=? ORDER BY source_id,relationship').all(r.candidate_id)
            .map(x=>({source_id:x.source_id,relationship:x.relationship,source_reference:x.source_reference,evidence:JSON.parse(x.evidence_json)}));
          const matches=db.prepare('SELECT related_type,related_id,relationship,evidence_json FROM discovery_candidate_matches WHERE candidate_id=? ORDER BY relationship,related_id').all(r.candidate_id)
            .map(x=>({related_type:x.related_type,related_id:x.related_id,relationship:x.relationship,evidence:JSON.parse(x.evidence_json)}));
          const tags=JSON.parse(r.tags_json),provenance=JSON.parse(r.provenance_json),geometry=JSON.parse(r.geometry_json);
          return feature(geometry,{candidate_id:r.candidate_id,source_id:r.source_id,origin:'OSM',discovery_source_id:discoverySource.source_id,
            classification:r.classification,physical_state:r.physical_state,motorcycle_access:r.motorcycle_access,routability:r.routability,canonical_status:r.canonical_status,
            match:r.canonical_status,review_decision:'UNREVIEWED',unknown_reason:r.classification==='UNKNOWN'?'osm_character_signals_insufficient':'NONE',confidence:null,
            length_m:r.length_m,access_tag_state:r.access_tag_state,osm_way_id:r.edge_id,osm_part_index:r.part_index,tags,provenance,sources,matches,
            multi_source_corroborated:matches.length>0,existence_evidence:provenance.existence_basis});
        });
        return reply(res,200,JSON.stringify({type:'FeatureCollection',features,truncated:rows.length>limit,source_id:discoverySource.source_id,
          attribution:licence.attribution??network.attribution,licence:licence.name}),MIME['.json']);
      }
      if(url.pathname==='/api/corridors'){
        if(!isDiscovery)return reply(res,200,JSON.stringify({type:'FeatureCollection',features:[],truncated:false}),MIME['.json']);
        const bounds=bbox(url.searchParams.get('bbox'));if(!bounds)return reply(res,400,'invalid bbox');const limit=Number(url.searchParams.get('limit')??1000);
        if(!Number.isInteger(limit)||limit<1||limit>5000)return reply(res,400,'limit must be 1-5000');const [w,s,e,n]=bounds;
        const sql=`SELECT v.corridor_version_id,v.corridor_id,v.classification,v.physical_existence,v.motorcycle_access,v.routability,v.canonical_status,
          v.identity_state,v.length_m,v.geometry_json,q.state review_state,q.priority review_priority,q.reason_code review_reason FROM physical_corridor_versions v
          JOIN physical_corridor_versions_rtree r USING(corridor_version_rowid) LEFT JOIN corridor_review_queue q USING(corridor_version_id)
          WHERE v.run_id=? AND r.max_lon>=? AND r.min_lon<=? AND r.max_lat>=? AND r.min_lat<=? ORDER BY q.state,v.length_m DESC,v.corridor_id LIMIT ?`;
        const rows=w<=e?db.prepare(sql).all(runId,w,e,s,n,limit+1):db.prepare(sql).all(runId,w,180,s,n,limit+1).concat(db.prepare(sql).all(runId,-180,e,s,n,limit+1));
        const unique=[...new Map(rows.map(r=>[r.corridor_version_id,r])).values()].slice(0,limit);
        const features=unique.map(r=>{
          const sourceCount=Number(db.prepare('SELECT count(DISTINCT source_id) n FROM physical_corridor_observations o JOIN discovery_candidate_sources s USING(candidate_id) WHERE o.corridor_version_id=?').get(r.corridor_version_id).n);
          const observationCount=Number(db.prepare('SELECT count(*) n FROM physical_corridor_observations WHERE corridor_version_id=?').get(r.corridor_version_id).n);
          const tetSupport=Number(db.prepare(`SELECT count(DISTINCT o.candidate_id) n FROM physical_corridor_observations o WHERE o.corridor_version_id=? AND EXISTS(
            SELECT 1 FROM discovery_candidate_matches m WHERE m.candidate_id=o.candidate_id AND m.relationship='same_osm_network_part_support')`).get(r.corridor_version_id).n);
          const legal=corridorLegalAssessment(db,r.corridor_id,r.physical_existence,r.routability),product=corridorProduct(r.physical_existence,r.classification,legal.access.access,legal.access,r.routability,r.review_state??'CATALOGUED',r.identity_state,legal.records,hasUsableLine(r.geometry_json));
          return feature(JSON.parse(r.geometry_json),{corridor_id:r.corridor_id,corridor_version_id:r.corridor_version_id,classification:r.classification,
            physical_existence:r.physical_existence,motorcycle_access:legal.access.access,routability:r.routability,operational_state:legal.operational_state,canonical_status:r.canonical_status,
            identity_state:r.identity_state,review_priority:r.review_priority,review_state:r.review_state??'CATALOGUED',review_reason:r.review_reason??null,length_m:r.length_m,
            ...product,review_decision:product.research_state,match:r.canonical_status,unknown_reason:r.identity_state==='REVIEW_REQUIRED'?'topology_association_unresolved':r.classification==='UNKNOWN'?'osm_character_signals_insufficient':'NONE',
            observation_count:observationCount,source_count:sourceCount,tet_supported_observations:tetSupport,source_kind:tetSupport?'OSM + TET hint':'OSM discovery'});
        });
        return reply(res,200,JSON.stringify({type:'FeatureCollection',features,truncated:rows.length>limit,read_only:true,canonical_status:'NOT_COMPARED'}),MIME['.json']);
      }
      if(url.pathname.startsWith('/api/corridor/')){
        if(!isDiscovery)return reply(res,404,'corridor not found');const id=decodeURIComponent(url.pathname.slice('/api/corridor/'.length));
        if(!/^corr-[a-f0-9]{32}$/.test(id))return reply(res,404,'corridor not found');
        const row=db.prepare(`SELECT v.*,q.state review_state,q.priority queue_priority,q.reason_code review_reason FROM physical_corridor_versions v
          LEFT JOIN corridor_review_queue q USING(corridor_version_id) WHERE v.run_id=? AND v.corridor_id=? ORDER BY v.created_at DESC LIMIT 1`).get(runId,id);
        if(!row)return reply(res,404,'corridor not found');
        const parts=db.prepare(`SELECT d.candidate_id,d.edge_id,d.part_index,d.classification,d.length_m,d.tags_json,d.provenance_json
          FROM physical_corridor_observations o JOIN discovery_candidates d USING(candidate_id) WHERE o.corridor_version_id=? ORDER BY d.edge_id,d.part_index`).all(row.corridor_version_id)
          .map(p=>({...p,tags:JSON.parse(p.tags_json),provenance:JSON.parse(p.provenance_json),route_hint_supports:queryRouteHintSupports(db,p.candidate_id)}));
        const assessment=corridorLegalAssessment(db,id,row.physical_existence,row.routability),product=corridorProduct(row.physical_existence,row.classification,assessment.access.access,assessment.access,row.routability,row.review_state??'CATALOGUED',row.identity_state,assessment.records,hasUsableLine(row.geometry_json)),now=Date.now();
        const legal=assessment.records.map(record=>({...record,temporal_state:record.effective_from&&Date.parse(record.effective_from)>now?'FUTURE':record.effective_until&&Date.parse(record.effective_until)<now?'EXPIRED':'ACTIVE'}));
        const lineage=db.prepare(`SELECT lineage_id,from_version_id,to_version_id,relation,match_state,evidence_json,created_at FROM physical_corridor_lineage
          WHERE from_version_id=? OR to_version_id=? ORDER BY created_at DESC`).all(row.corridor_version_id,row.corridor_version_id)
          .map(item=>({...item,evidence:JSON.parse(item.evidence_json)}));
        const community=db.prepare(`SELECT count(DISTINCT independence_group) independent_claims,count(*) records FROM community_claims WHERE corridor_id=?`).get(id);
        const hasExternalEvidence=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='external_corridor_evidence'").get());
        const externalNetworkEvidence=hasExternalEvidence?db.prepare(`SELECT source_id,source_version,source_sha256,source_feature_id,relationship,geometry_json,attributes_json,evidence_json,retrieved_at
          FROM external_corridor_evidence WHERE corridor_id=? ORDER BY retrieved_at DESC,source_id,source_feature_id`).all(id).map(item=>({
            source_id:item.source_id,source_version:item.source_version,source_sha256:item.source_sha256,source_feature_id:item.source_feature_id,relationship:item.relationship,
            geometry:JSON.parse(item.geometry_json),attributes:JSON.parse(item.attributes_json),evidence:JSON.parse(item.evidence_json),retrieved_at:item.retrieved_at,
          })):[];
        const latest=db.prepare('SELECT decision,reviewer,reason,decided_at FROM corridor_review_decisions WHERE corridor_id=? ORDER BY decided_at DESC LIMIT 1').get(id)??null;
        return reply(res,200,JSON.stringify({type:'Feature',id,geometry:JSON.parse(row.geometry_json),properties:{corridor_id:id,corridor_version_id:row.corridor_version_id,
          classification:row.classification,physical_existence:row.physical_existence,motorcycle_access:row.motorcycle_access,routability:row.routability,
          canonical_status:row.canonical_status,identity_state:row.identity_state,review_priority:row.queue_priority??row.review_priority,review_state:row.review_state??'CATALOGUED',review_reason:row.review_reason??null,length_m:row.length_m,
          observation_count:parts.length,observations:parts,lineage,legal_status:legal,legal_access_evaluation:assessment.access,community_evidence:{independent_claims:Number(community.independent_claims??0),records:Number(community.records??0)},external_network_evidence:externalNetworkEvidence,review:latest,evidence:JSON.parse(row.evidence_json),
          operational_state:assessment.operational_state,...product,route_eligible:product.route_modes.automatic&&row.routability==='yes'}}),MIME['.json']);
      }
      if(url.pathname==='/api/network'){
        const bounds=bbox(url.searchParams.get('bbox'));if(!bounds)return reply(res,400,'invalid bbox');
        if(Number(url.searchParams.get('zoom')??0)<7)return reply(res,200,JSON.stringify({type:'FeatureCollection',features:[],truncated:false,zoomed_out:true}),MIME['.json']);
        const limit=Number(url.searchParams.get('limit')??1000);if(!Number.isInteger(limit)||limit<1||limit>5000)return reply(res,400,'limit must be 1-5000');
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
  server.on('close',()=>db.close());if(autostart)server.listen(port,'127.0.0.1');return server;
}

const HTML=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RT&amp;T Scout • {{RUN_TITLE}}</title>
<link rel="stylesheet" href="/vendor/maplibre-gl/maplibre-gl.css"><style>*{box-sizing:border-box}html,body{margin:0;height:100%;font:14px system-ui,sans-serif;color:#17212b}body{display:grid;grid-template-columns:minmax(0,1fr) 360px}#map{height:100%;min-height:420px;background:#e8ecef}.panel{padding:16px;overflow:auto;background:#fff;border-left:1px solid #ccd3d9}.badge{padding:6px 8px;background:#fff0e5;border:1px solid #d98d57;border-radius:4px;font-weight:700;color:#612d0d}.legend{display:grid;gap:6px;margin:14px 0}.legend span{display:flex;align-items:center;gap:8px}.swatch{width:26px;border-top:4px solid}.product-green{border-color:#16834a}.product-orange{border-color:#ed8b12}.product-red{border-color:#c62828}.product-closed{border-color:#5b1515;border-top-style:dashed}.ROAD{border-color:#555f68}.UNSEALED_ROAD{border-color:#a76c20}.PROBABLE_OFFROAD{border-color:#b82f88;border-top-style:dashed}.OFFROAD_CONFIRMED{border-color:#d33824}.UNKNOWN{border-color:#7c8791;border-top-style:dotted}.source{border-color:#1b6c93;border-top-style:dashed}.network{border-color:#adb9bb;border-top-width:2px}.continuity{border-color:#087f8c;border-top-style:dotted}.discovery{border-color:#d04c18;border-top-style:dashed}label{display:block;margin:8px 0}select{padding:5px;max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px system-ui}.small{font-size:12px;color:#556}.filters{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px}.filters label{margin:3px 0}.filters select{width:100%}@media(max-width:850px){body{grid-template-columns:1fr;grid-template-rows:55% 45%}.panel{border-left:0;border-top:1px solid #ccd3d9}}</style></head><body>
<div id="map" aria-label="Private Scout regional review map"></div><aside class="panel"><div class="badge">PRIVATE LOOPBACK REVIEW • APPROVED SOURCE MATERIAL</div><h1>{{RUN_TITLE}}</h1><p class="badge">{{CANONICAL_NOTE}}</p><p id="summary">Loading private validation records…</p>
<section id="corridor-review-panel"><h2>Scout research required</h2><p id="review-queue-note" class="small">Loading corridor review queue…</p><ol id="review-queue-list" style="max-height:300px;overflow:auto;padding-left:25px"></ol></section>
<p>Normal roads remain normal roads. GREEN / ORANGE / RED / temporary-closure colours describe Scout lane status. Source-route hints, OSM discoveries and candidate sections remain separate private evidence layers; none grants access.</p>
<div class="filters"><label>Physical character <select data-filter="classification"><option value="ALL">All</option><option>ROAD</option><option>UNSEALED_ROAD</option><option>PROBABLE_OFFROAD</option><option>OFFROAD_CONFIRMED</option><option>UNKNOWN</option></select></label>
<label>Canonical comparison <select data-filter="match"><option value="ALL">All</option><option>EXACT_EXISTING</option><option>LIKELY_EXISTING</option><option>PARTIAL_OVERLAP</option><option>POSSIBLE_PARALLEL</option><option>AMBIGUOUS</option><option>NEW_CANDIDATE</option><option>UNMATCHED</option><option>NOT_COMPARED</option></select></label>
<label>UNKNOWN reason <select data-filter="unknown_reason"><option value="ALL">All</option><option>no_network_match</option><option>competing_network_classes</option><option>interval_support_uncertain</option><option>network_tags_insufficient</option><option>multiple_unknown_reasons</option><option value="NONE">Not UNKNOWN</option></select></label>
<label>Candidate length <select data-filter="candidate_length"><option value="ALL">All</option><option value="LT100">Under 100 m</option><option value="100_500">100–500 m</option><option value="500_1000">500–1,000 m</option><option value="GE1000">1,000 m or longer</option></select></label>
<label>Match-margin score <select data-filter="confidence_band"><option value="ALL">All</option><option value="HIGH">Above 0.5</option><option value="MID">0.1–0.5</option><option value="LOW">0.1 or below</option><option value="UNKNOWN">Unknown score</option></select></label>
<label>Rider-facing status <select data-filter="product_state"><option value="ALL">All</option><option>ORDINARY_ROAD</option><option>GREEN</option><option>ORANGE</option><option>RED</option><option>TEMPORARILY_CLOSED</option></select></label><label>Motorcycle access <select data-filter="motorcycle_access"><option value="ALL">All</option><option>unknown</option><option>confirmed</option><option>prohibited</option><option>contradictory</option></select></label><label>Routability <select data-filter="routability"><option value="ALL">All</option><option>unknown</option><option>yes</option><option>no</option></select></label>
<label>Scout workflow <select data-filter="research_state"><option value="ALL">All</option><option>SCOUT_RESEARCH_REQUIRED</option><option>AUTO_RESOLVED</option><option>HUMAN_ESCALATION</option><option>QA_SAMPLE</option></select></label>
<label>Corridor priority <select data-filter="review_priority"><option value="ALL">All</option><option>CORROBORATED_DISCOVERY</option><option>IDENTITY_REVIEW</option><option>CATALOG_ONLY</option><option>LOW_VALUE_FOR_MOTORCYCLE_DISCOVERY</option><option>NORMAL_REVIEW</option></select></label><label>Topology identity <select data-filter="identity_state"><option value="ALL">All</option><option>TOPOLOGY_BACKED</option><option>REVIEW_REQUIRED</option></select></label></div>
<label><input id="show-source" type="checkbox" checked> Complete private source routes</label><label><input id="show-network" type="checkbox" checked> Regional OSM network evidence</label><label><input id="show-corridors" type="checkbox" checked> Stable physical corridor hypotheses</label><label><input id="show-discovery" type="checkbox"> Independent OSM discoveries (raw way-parts)</label>
<div class="legend"><strong>Corridors: rider-facing status (private evidence remains in the inspector)</strong><span><i class="swatch product-green"></i>GREEN · Verified lane</span><span><i class="swatch product-orange"></i>ORANGE · Unverified lane</span><span><i class="swatch product-red"></i>RED · Known applicable prohibition</span><span><i class="swatch product-closed"></i>TEMPORARILY CLOSED · active dated restriction</span><span><i class="swatch ROAD"></i>Ordinary road (separate from Scout lanes)</span><strong>Source/derived layers</strong><span><i class="swatch ROAD"></i>Ordinary road</span><span><i class="swatch UNSEALED_ROAD"></i>Unsealed road</span><span><i class="swatch PROBABLE_OFFROAD"></i>Probable physical character (OSM mapped; unverified)</span><span><i class="swatch OFFROAD_CONFIRMED"></i>Physical existence confirmed by qualified evidence</span><span><i class="swatch UNKNOWN"></i>Unknown / identity review</span><span><i class="swatch continuity"></i>Ambiguous connector hypothesis (not merged)</span><span><i class="swatch source"></i>Complete private source route</span><span><i class="swatch network"></i>Matched network way</span><span><i class="swatch discovery"></i>Raw OSM way-part observation</span></div>
<p class="small" id="segment-note">Derived sections load by viewport (up to 2,000 features at a time).</p><p class="small" id="network-note">Matched OSM edges cited by segmentation • © OpenStreetMap contributors • ODbL 1.0</p><p class="small" id="discovery-note">Raw OSM way-parts load by viewport (up to 1,000 features at a time).</p><p class="small" id="corridor-note">Stable corridor hypotheses load by viewport (up to 1,000 features at a time).</p><h2>Selection</h2><pre id="inspector">Select a corridor, source section or network edge.</pre>
<p class="small">Match-margin score is geometric clearance, not a probability. Access/motorcycle tags are shown as source text only; the physical classifier ignores them and they do not establish RT&amp;T legal access. Network geometry and tags remain source evidence. Muted network lines show cited edges only. Extract coverage outlines are approximate, not legal boundaries. Source routes are private discovery material only and do not prove existence or legal access.</p></aside>
<script src="/review.js" type="module"></script></body></html>`;

const CLIENT=`import * as maplibregl from '/vendor/maplibre-gl/maplibre-gl.mjs';
const map=new maplibregl.Map({container:'map',style:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#e8ecef'}}]},center:{{CENTER}},zoom:{{ZOOM}},attributionControl:false});
window.__scoutMap=map;map.addControl(new maplibregl.NavigationControl(),'top-right');map.addControl(new maplibregl.AttributionControl({customAttribution:'© OpenStreetMap contributors • ODbL 1.0'}),'bottom-right');
const colors={ROAD:'#555f68',UNSEALED_ROAD:'#a76c20',PROBABLE_OFFROAD:'#b82f88',OFFROAD_CONFIRMED:'#d33824',UNKNOWN:'#7c8791'};let routes,segments,network,canonical,discoveries,corridors;
const source=(id,data)=>{map.addSource(id,{type:'geojson',data});return map.getSource(id);};
const fetchJson=async(url)=>{const r=await fetch(url);if(!r.ok)throw new Error('private Scout data request failed');return r.json();};
function bbox(){const b=map.getBounds();return [b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].join(',');}
async function refreshNetwork(){if(!document.querySelector('#show-network').checked)return;const data=await fetchJson('/api/network?bbox='+encodeURIComponent(bbox())+'&zoom='+map.getZoom().toFixed(1)+'&limit=1000');network.setData(data);document.querySelector('#network-note').textContent='Matched OSM edges cited by segmentation • © OpenStreetMap contributors • ODbL 1.0'+(data.truncated?' • viewport cap reached; zoom in to inspect all cited edges':'');}
async function refreshDiscoveries(){if(!document.querySelector('#show-discovery').checked)return;const note=document.querySelector('#discovery-note');try{const data=await fetchJson('/api/discovery-candidates?bbox='+encodeURIComponent(bbox())+'&limit=1000');discoveries.setData(data);note.textContent=data.features.length.toLocaleString()+' OSM way-parts in this viewport'+(data.truncated?' • viewport cap reached; zoom in to inspect every way-part':'')+' • OSM is not legal-access evidence';if(window.__scoutReview){window.__scoutReview.counts.discovery_candidates=data.features.length;window.__scoutReview.counts.discovery_truncated=data.truncated;}}catch{note.textContent='OSM discovery layer unavailable; retry by moving the map. Private reviewer remains read-only.';}}
async function refreshCorridors(){if(!document.querySelector('#show-corridors').checked)return;const note=document.querySelector('#corridor-note');try{const data=await fetchJson('/api/corridors?bbox='+encodeURIComponent(bbox())+'&limit=1000');corridors.setData(data);note.textContent=data.features.length.toLocaleString()+' stable corridor hypotheses in this viewport'+(data.truncated?' • viewport cap reached; zoom in to inspect all':'')+' • colour is rider-facing status; source evidence remains in private detail';if(window.__scoutReview){window.__scoutReview.counts.corridors_loaded=data.features.length;window.__scoutReview.counts.corridors_truncated=data.truncated;}}catch{note.textContent='Corridor layer unavailable; this run may not have a completed topology reconciliation.';}}
function filters(){const terms=[],productTerms=[];for(const el of document.querySelectorAll('[data-filter]')){const k=el.dataset.filter,v=el.value;if(v==='ALL')continue;
if(k==='candidate_length'){terms.push(['any',['!=',['get','candidate_id'],null],['!=',['get','corridor_id'],null]]);if(v==='LT100')terms.push(['<',['get','length_m'],100]);if(v==='100_500')terms.push(['all',['>=',['get','length_m'],100],['<',['get','length_m'],500]]);if(v==='500_1000')terms.push(['all',['>=',['get','length_m'],500],['<',['get','length_m'],1000]]);if(v==='GE1000')terms.push(['>=',['get','length_m'],1000]);}
else if(k==='confidence_band'){if(v==='UNKNOWN')terms.push(['==',['get','confidence'],null]);if(v==='HIGH')terms.push(['>',['get','confidence'],0.5]);if(v==='MID')terms.push(['all',['>=',['get','confidence'],0.1],['<=',['get','confidence'],0.5]]);if(v==='LOW')terms.push(['<=',['get','confidence'],0.1]);}
else if(k==='product_state'||k==='research_state')productTerms.push(['==',['get',k],v]);else terms.push(['==',['get',k],v]);}map.setFilter('segments-line',terms.length?['all',...terms]:null);map.setFilter('discovery-line',terms.length?['all',...terms]:null);const corridorFilters=[...terms,...productTerms];map.setFilter('corridor-line',corridorFilters.length?['all',...corridorFilters]:null);}
const allBounds=(features)=>{let west=180,south=90,east=-180,north=-90;for(const f of features){const walk=x=>{if(Array.isArray(x)&&typeof x[0]==='number'){west=Math.min(west,x[0]);east=Math.max(east,x[0]);south=Math.min(south,x[1]);north=Math.max(north,x[1]);}else if(Array.isArray(x))x.forEach(walk);};walk(f.geometry.coordinates);}return [[west,south],[east,north]];};
async function refreshSegments(){const note=document.querySelector('#segment-note');try{const data=await fetchJson('/api/segments?bbox='+encodeURIComponent(bbox())+'&limit=2000');segments.setData(data);note.textContent=data.features.length.toLocaleString()+' derived sections in this viewport'+(data.truncated?' • viewport cap reached; zoom in to inspect every section':'');if(window.__scoutReview){window.__scoutReview.counts.segments_loaded=data.features.length;window.__scoutReview.counts.segments_truncated=data.truncated;}}catch{note.textContent='Derived sections unavailable; retry by moving the map.';}}
const status=await fetchJson('/api/status'),[routesData,canonicalData,reviewQueue]=await Promise.all([fetchJson('/api/source-routes'),fetchJson('/api/canonical'),fetchJson('/api/review-queue?state=UNREVIEWED&limit=200')]);routes=routesData;segments={type:'FeatureCollection',features:[]};canonical=canonicalData;discoveries={type:'FeatureCollection',features:[]};corridors={type:'FeatureCollection',features:[]};
document.querySelector('#summary').textContent=status.observations+' private source parts • '+status.segments.toLocaleString()+' derived sections • '+status.candidates+' source-route candidates • '+status.discovery_candidates+' raw OSM way-parts ('+status.discovery_corroborated+' exact TET support links) • '+status.physical_corridors+' stable corridor hypotheses • '+status.corridor_review_queue+' in Scout research / human-escalation queues • '+status.network_edges.toLocaleString()+' OSM network edges. OSM does not establish legal access or routability.';
document.querySelector('#review-queue-note').textContent=reviewQueue.count.toLocaleString()+' SCOUT_RESEARCH_REQUIRED items; uncertainty is a normal ORANGE outcome, not a request for Karl to decide local law'+(reviewQueue.truncated?' shown (queue is paged)':'');
const queueList=document.querySelector('#review-queue-list');for(const item of reviewQueue.items){const li=document.createElement('li'),button=document.createElement('button'),p=item.properties;button.type='button';button.textContent=p.classification+' · '+Math.round(p.length_m)+' m · '+p.corridor_id;button.style.cssText='display:block;width:100%;margin:3px 0;padding:6px;text-align:left;font-size:12px';button.onclick=async()=>{try{const detail=await fetchJson('/api/corridor/'+encodeURIComponent(p.corridor_id));document.querySelector('#inspector').textContent=JSON.stringify({corridor_id:p.corridor_id,queue_state:p.review_state,queue_reason:p.review_reason,...detail.properties},null,2);map.fitBounds(allBounds([item]),{padding:90,maxZoom:14});}catch{document.querySelector('#inspector').textContent='This private corridor item could not be loaded.';}};li.append(button);queueList.append(li);}
const initialize=()=>{network=source('network', {type:'FeatureCollection',features:[]});source('source-routes',routes);segments=source('segments',segments);source('canonical',canonical);discoveries=source('discoveries',discoveries);corridors=source('corridors',corridors);
map.addLayer({id:'network-line',source:'network',type:'line',paint:{'line-color':'#84999e','line-width':['interpolate',['linear'],['zoom'],7,0.8,13,2.4],'line-opacity':0.9}});
map.addLayer({id:'source-routes-line',source:'source-routes',type:'line',paint:{'line-color':'#1b6c93','line-width':2.2,'line-dasharray':[2,2],'line-opacity':0.8}});
map.addLayer({id:'segments-line',source:'segments',type:'line',paint:{'line-color':['match',['get','classification'],'ROAD',colors.ROAD,'UNSEALED_ROAD',colors.UNSEALED_ROAD,'PROBABLE_OFFROAD',colors.PROBABLE_OFFROAD,'OFFROAD_CONFIRMED',colors.OFFROAD_CONFIRMED,colors.UNKNOWN],'line-width':['match',['get','classification'],'PROBABLE_OFFROAD',4.4,'OFFROAD_CONFIRMED',4.4,'UNKNOWN',2.5,3],'line-dasharray':['match',['get','classification'],'PROBABLE_OFFROAD',['literal',[2.5,1]],'UNKNOWN',['literal',[0.8,1.8]],['literal',[1,0]]],'line-opacity':0.95}});
map.addLayer({id:'continuity-hypothesis-line',source:'segments',type:'line',filter:['all',['==',['get','classification'],'UNKNOWN'],['!=',['get','corridor_hypothesis_id'],null]],paint:{'line-color':'#087f8c','line-width':5,'line-dasharray':[0.35,1.1],'line-opacity':0.9}});
map.addLayer({id:'canonical-line',source:'canonical',type:'line',paint:{'line-color':'#1565c0','line-width':3,'line-dasharray':[2,1]}});
map.addLayer({id:'discovery-line',source:'discoveries',type:'line',paint:{'line-color':['match',['get','classification'],'PROBABLE_OFFROAD','#d04c18','UNSEALED_ROAD','#b46e10','UNKNOWN','#8c3e9e','#8c3e9e'],'line-width':['interpolate',['linear'],['zoom'],6,1.4,11,3.8],'line-dasharray':[1.3,1.1],'line-opacity':0.92}});
map.addLayer({id:'corridor-line',source:'corridors',type:'line',paint:{'line-color':['match',['get','product_state'],'GREEN','#16834a','ORANGE','#ed8b12','RED','#c62828','TEMPORARILY_CLOSED','#5b1515',colors.UNKNOWN],'line-width':['interpolate',['linear'],['zoom'],6,2.4,11,5.2],'line-dasharray':['match',['get','identity_state'],'REVIEW_REQUIRED',['literal',[0.7,1.4]],['literal',[1,0]]],'line-opacity':0.95}});
document.querySelectorAll('[data-filter]').forEach(el=>el.addEventListener('change',filters));document.querySelector('#show-source').addEventListener('change',e=>map.setLayoutProperty('source-routes-line','visibility',e.target.checked?'visible':'none'));
document.querySelector('#show-network').addEventListener('change',()=>refreshNetwork().catch(()=>{}));filters();const bounds={{VIEWPORT}};map.fitBounds(bounds,{padding:42,maxZoom:9});
document.querySelector('#show-discovery').addEventListener('change',e=>map.setLayoutProperty('discovery-line','visibility',e.target.checked?'visible':'none'));
document.querySelector('#show-corridors').addEventListener('change',()=>refreshCorridors().catch(()=>{}));
let timer;map.on('moveend',()=>{clearTimeout(timer);timer=setTimeout(()=>{refreshSegments();refreshNetwork().catch(()=>{});refreshDiscoveries().catch(()=>{});refreshCorridors().catch(()=>{});},180);});refreshSegments();refreshNetwork().catch(()=>{});refreshDiscoveries().catch(()=>{});refreshCorridors().catch(()=>{});
const inspector=document.querySelector('#inspector');map.on('click',async event=>{const hits=map.queryRenderedFeatures(event.point,{layers:['corridor-line','discovery-line','segments-line','source-routes-line','network-line','canonical-line']});if(!hits.length){inspector.textContent='No route section at this point.';return;}const hit=hits[0];inspector.textContent=JSON.stringify({layer:hit.layer.id,...hit.properties},null,2);if(hit.layer.id==='corridor-line'&&hit.properties.corridor_id){try{const detail=await fetchJson('/api/corridor/'+encodeURIComponent(hit.properties.corridor_id));inspector.textContent=JSON.stringify({layer:hit.layer.id,...detail.properties},null,2);}catch{inspector.textContent+='\\n\\nPrivate corridor evidence could not be loaded.';}}else if(hit.layer.id==='segments-line'&&hit.properties.segment_id){try{const detail=await fetchJson('/api/segment/'+encodeURIComponent(hit.properties.segment_id));inspector.textContent=JSON.stringify({layer:hit.layer.id,...detail.properties},null,2);}catch{inspector.textContent+='\\n\\nDetailed private evidence could not be loaded.';}}});
window.__scoutReview={ready:true,mode:'PRIVATE_SCOUT_REVIEW',counts:{source_routes:routes.features.length,segments_total:status.segments,segments_loaded:0,segments_truncated:false,candidates:status.candidates,discovery_candidates:0,discovery_truncated:false,discovery_corroborated:status.discovery_corroborated,corridor_hypotheses:status.corridor_hypotheses,physical_corridors:status.physical_corridors,corridor_review_queue:status.corridor_review_queue,corridors_loaded:0,corridors_truncated:false,canonical:canonical.features.length},filterCount:document.querySelectorAll('[data-filter]').length};};
if(map.isStyleLoaded())initialize();else map.once('load',initialize);`;

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const runId=process.env.SCOUT_REVIEW_RUN_ID,privateBase=process.env.SCOUT_GEO_ROOT;if(!runId||!privateBase)throw new Error('SCOUT_REVIEW_RUN_ID and SCOUT_GEO_ROOT are required; select an explicit private run');const port=Number(process.env.SCOUT_REVIEW_PORT||8766);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('SCOUT_REVIEW_PORT must be an unprivileged port');const server=createRealReviewServer({runId,privateBase,databaseFile:path.join(privateBase,'scout.sqlite'),port});server.on('listening',()=>console.log(`private loopback Scout review at http://127.0.0.1:${server.address().port}/`));}
