// Deterministic, private first-pass discovery from an explicitly registered
// OSM snapshot. One result represents one immutable OSM way part; Scout does
// not infer junction connectivity from coincident coordinates.
import crypto from 'node:crypto';
import { classifyNetworkEdge, lengthMeters } from './route-segmenter.mjs';

export const OSM_DISCOVERY_VERSION='osm-way-discovery-1';
const ACCESS_KEYS=['access','vehicle','motor_vehicle','motorcycle'];
const TAG_KEYS=['highway','surface','tracktype','smoothness','service','access','vehicle','motor_vehicle','motorcycle','name','ref','construction','ford','bridge','tunnel','lit','width','dirtbike:scale','mtb:scale','trail_visibility'];
const UNSEALED=new Set(['unpaved','compacted','fine_gravel','gravel','ground','dirt','earth','mud','sand','grass','pebblestone']);
const ROUGH=new Set(['bad','very_bad','horrible','very_horrible','impassable']);
const RESTRICTIVE=new Set(['no','private','destination','customers','agricultural','forestry','permit','use_sidepath']);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const lineParts=geometry=>geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:[];
const length=coords=>coords.slice(1).reduce((n,p,i)=>n+lengthMeters(coords[i],p),0);
const selectedTags=tags=>Object.fromEntries(TAG_KEYS.filter(k=>tags?.[k]!=null).map(k=>[k,tags[k]]));

export function osmDiscoverySelection(tags={}){
  const highway=String(tags.highway??'').toLowerCase(),service=String(tags.service??'').toLowerCase(),classification=classifyNetworkEdge({tags});
  const surface=String(tags.surface??'').toLowerCase(),tracktype=String(tags.tracktype??'').toLowerCase(),smoothness=String(tags.smoothness??'').toLowerCase();
  const rugged=UNSEALED.has(surface)||/^grade[3-5]$/.test(tracktype)||ROUGH.has(smoothness)||tags['dirtbike:scale']!=null||tags['mtb:scale']!=null||['poor','horrible'].includes(String(tags.trail_visibility??'').toLowerCase());
  const lifecycle=String(tags.lifecycle??'').toLowerCase();
  if(highway==='construction'||highway==='proposed'||['razed','destroyed','abandoned','disused'].includes(lifecycle)||(tags.construction&&String(tags.construction).toLowerCase()!=='no'))return null;
  let selected=false,rule=null;
  if(highway==='track'&&classification!=='ROAD'){selected=true;rule='track-way-not-classified-as-ordinary-road';}
  else if(['path','bridleway'].includes(highway)&&classification!=='ROAD'&&(classification!=='UNKNOWN'||rugged)){selected=true;rule='path-like-way-with-network-or-physical-trail-signals';}
  else if(highway==='footway'&&classification!=='ROAD'&&rugged){selected=true;rule='footway-with-explicit-roughness-or-trail-scale-context';}
  else if(highway==='service'&&!['driveway','parking_aisle','drive-through'].includes(service)&&classification!=='ROAD'&&(classification!=='UNKNOWN'||rugged)){selected=true;rule='non-driveway-service-way-with-trail-signals';}
  else if(highway==='unclassified'&&classification!=='ROAD'&&(classification!=='UNKNOWN'||rugged)){selected=true;rule='unclassified-way-with-trail-signals';}
  if(!selected)return null;
  const accessTags=Object.fromEntries(ACCESS_KEYS.filter(k=>tags[k]!=null).map(k=>[k,tags[k]]));
  const restrictiveTags=Object.fromEntries(Object.entries(accessTags).filter(([,v])=>RESTRICTIVE.has(String(v).toLowerCase())));
  return {classification,selection_rule:rule,physical_state:'probable',motorcycle_access:'unknown',routability:'unknown',canonical_status:'NOT_COMPARED',
    access_tag_state:Object.keys(accessTags).length?'OSM_TAGS_PRESENT':'NO_EXPLICIT_ACCESS_TAG',access_tags:accessTags,restrictive_tags:restrictiveTags,
    relevant_tags:selectedTags(tags)};
}

export function registerOsmDiscoverySource(store,snapshotId){
  const snapshot=store.getNetworkSnapshot(snapshotId);if(!snapshot)throw new Error('discovery requires an explicitly registered OSM network snapshot');
  const parent=store.getSource(snapshot.source_id);if(!parent?.roles?.routing_network||parent.reuse?.private_processing!==true||!snapshot.checksum)throw new Error('network snapshot source is not registered and approved for private processing');
  const country=(snapshot.coverage.countries??[]).length===1?snapshot.coverage.countries[0]:null;if(!country)throw new Error('OSM discovery needs a snapshot with one unambiguous country');
  const sid=`osm-discovery-${country.toLowerCase()}-${digest(snapshotId).slice(0,10)}`;
  const definition={source_id:sid,name:`OSM mapped-way discovery from ${parent.name}`,type:'regional-osm-discovery-adapter',organisation:parent.organisation,
    expected_formats:['registered-osm-network-snapshot'],coverage:parent.coverage,jurisdiction_ids:parent.jurisdiction_ids,
    location:{kind:'registered-private-network-snapshot',snapshot_id:snapshotId,parent_source_id:parent.source_id,version:snapshot.version,sha256:snapshot.checksum},
    adapter_version:OSM_DISCOVERY_VERSION,parent_network_source_id:parent.source_id,bound_snapshot_id:snapshotId,
    licence:snapshot.licence,reuse:{private_processing:true,redistribution:false,derived_public_use:false},
    roles:{discovery_only:true,physical_existence:true,legal_access:false,routing_network:false,public_reuse:false,jurisdiction_boundaries:false},
    update:{mechanism:'explicitly pinned parent OSM network snapshot; no automatic network retrieval'},
    attribution:parent.attribution,rate_limits:{requests_per_minute:0,politeness_interval_seconds:0}};
  const registered=store.registerSource(definition);return {source:store.getSource(sid),...registered};
}

function referenceCandidateParts(store,runId){
  if(!runId)return new Map();const run=store.getRun(runId);if(!run)throw new Error(`unknown reference Scout run '${runId}'`);
  const rows=store.db.prepare(`SELECT s.segment_id,c.candidate_id,o.source_name,f.source_id,s.evidence_json FROM scout_run_observations ro
    JOIN route_observations o USING(observation_id) JOIN source_files f USING(file_id)
    JOIN route_segments s ON s.observation_id=ro.observation_id AND s.pipeline_version=ro.pipeline_version
    JOIN candidates c USING(segment_id) WHERE ro.run_id=? AND ro.status='COMPLETE' AND s.classification IN ('PROBABLE_OFFROAD','OFFROAD_CONFIRMED') ORDER BY c.candidate_id`).all(runId);
  const byPart=new Map();
  for(const row of rows)for(const item of JSON.parse(row.evidence_json))if(item.rule==='interval-network-support'&&item.edge_part_id){
    const entry={candidate_id:row.candidate_id,segment_id:row.segment_id,source_id:row.source_id};const list=byPart.get(item.edge_part_id)??[];list.push(entry);byPart.set(item.edge_part_id,list);
  }
  return byPart;
}

export function discoverOsmRun(store,runId,{batchSize=500,shouldYield=()=>false,yieldReason=()=> 'shared host admission requested a safe yield',onProgress=()=>{}}={}){
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>2000)throw new Error('OSM discovery batch size must be 1-2000');
  const run=store.getDiscoveryRun(runId);if(!run)throw new Error(`unknown discovery run '${runId}'`);
  if(run.status==='COMPLETE')return {...discoveryStats(store,runId),status:'REUSED'};
  const snapshot=store.getNetworkSnapshot(run.snapshot_id),source=store.getSource(run.discovery_source_id);
  if(!snapshot||!source||source.roles.discovery_only!==true||source.roles.legal_access===true||source.bound_snapshot_id!==run.snapshot_id||snapshot.source_id!==source.parent_network_source_id)
    throw new Error('discovery run source/snapshot binding is invalid');
  const approval=store.sourceApproval(source.source_id);if(!approval||approval.approved_by!==run.approved_by||approval.scope!==run.approval_scope)throw new Error('discovery source approval is missing, revoked or differs from this immutable run approval');
  const supportByPart=referenceCandidateParts(store,run.reference_run_id);let cursor=run.checkpoint_edge_rowid,examined=run.edges_examined;
  // Recover counters once so a crash between a candidate batch commit and its
  // cursor checkpoint is harmless; then update counts incrementally per batch.
  let candidatesCreated=Number(store.db.prepare('SELECT count(*) n FROM discovery_candidates WHERE run_id=?').get(runId).n);
  let corroboratedCount=Number(store.db.prepare("SELECT count(DISTINCT candidate_id) n FROM discovery_candidate_matches WHERE relationship='same_osm_network_part_support' AND candidate_id IN (SELECT candidate_id FROM discovery_candidates WHERE run_id=?)").get(runId).n);
  store.updateDiscoveryRun(runId,{status:'RUNNING',last_error:null});
  const query=store.db.prepare(`SELECT edge_rowid,edge_id,geometry_json,tags_json FROM network_edges WHERE snapshot_id=? AND edge_rowid>? ORDER BY edge_rowid LIMIT ?`);
  for(;;){
    if(shouldYield()){const reason=yieldReason()??'shared host admission requested a safe yield';store.updateDiscoveryRun(runId,{status:'BLOCKED',checkpoint_edge_rowid:cursor,edges_examined:examined,last_error:reason});return {...discoveryStats(store,runId),status:'BLOCKED',reason,resumable:true};}
    const rows=query.all(run.snapshot_id,cursor,batchSize);if(!rows.length)break;
    const out=[];
    for(const row of rows){
      const tags=JSON.parse(row.tags_json),selected=osmDiscoverySelection(tags);
      if(selected){const geometry=JSON.parse(row.geometry_json),parts=lineParts(geometry);
        for(let i=0;i<parts.length;i++){
          const coords=parts[i];if(!Array.isArray(coords)||coords.length<2)continue;
          // Candidate identity is stable within a run but remains a distinct
          // persisted record across separately approved/reviewed runs.
          const edgePartId=`${row.edge_id}#part:${i}`,matches=supportByPart.get(edgePartId)??[],candidateId=`odc-${digest(`${runId}\0${run.snapshot_id}\0${row.edge_id}\0${i}\0${OSM_DISCOVERY_VERSION}`).slice(0,24)}`;
          const provenance={source_id:source.source_id,source_revision:source.revision,network_source_id:snapshot.source_id,snapshot_id:snapshot.snapshot_id,snapshot_version:snapshot.version,
            snapshot_sha256:snapshot.checksum,osm_way_id:row.edge_id,geometry_part_index:i,adapter_version:OSM_DISCOVERY_VERSION,selection_rule:selected.selection_rule,
            existence_basis:'OSM mapped geometry only; probable and unverified; no field confirmation',access_interpretation:'source tags are context only; motorcycle_access remains unknown',
            canonical_interpretation:'no canonical dataset supplied; NOT_COMPARED is not NEW'};
          out.push({candidate_id:candidateId,run_id:runId,source_id:source.source_id,snapshot_id:run.snapshot_id,edge_id:row.edge_id,part_index:i,
            classification:selected.classification,physical_state:selected.physical_state,motorcycle_access:'unknown',routability:'unknown',canonical_status:'NOT_COMPARED',
            access_tag_state:selected.access_tag_state,length_m:length(coords),geometry:{type:'LineString',coordinates:coords},tags:selected.relevant_tags,
            provenance,sources:[{source_id:source.source_id,relationship:'origin',source_reference:edgePartId,evidence:{selection_rule:selected.selection_rule,snapshot_id:run.snapshot_id}}],
            matches:matches.map(m=>({related_type:'route_candidate',related_id:m.candidate_id,relationship:'same_osm_network_part_support',
              evidence:{network_snapshot_id:run.snapshot_id,osm_way_part_id:edgePartId,source_candidate_segment_id:m.segment_id}})),
            sourceLinks:matches.map(m=>({source_id:m.source_id,relationship:'corroborates',source_reference:m.candidate_id,evidence:{network_snapshot_id:run.snapshot_id,osm_way_part_id:edgePartId}}))});
        }
      }
      cursor=row.edge_rowid;examined++;
    }
    for(let i=0;i<out.length;i+=1000){const batch=out.slice(i,i+1000);for(const c of batch){c.sources.push(...c.sourceLinks);delete c.sourceLinks;}
      const saved=store.saveDiscoveryCandidateBatch(runId,batch);candidatesCreated+=saved.inserted;corroboratedCount+=saved.newly_corroborated;}
    store.updateDiscoveryRun(runId,{checkpoint_edge_rowid:cursor,edges_examined:examined,candidates_created:candidatesCreated,corroborated_count:corroboratedCount});
    onProgress({run_id:runId,checkpoint_edge_rowid:cursor,edges_examined:examined,candidates_created:candidatesCreated});
  }
  store.updateDiscoveryRun(runId,{status:'COMPLETE',checkpoint_edge_rowid:cursor,edges_examined:examined,
    candidates_created:candidatesCreated,corroborated_count:corroboratedCount,last_error:null});
  return {...discoveryStats(store,runId),status:'COMPLETE',research_state:'SCOUT_RESEARCH_REQUIRED'};
}

export function discoveryStats(store,runId){
  const run=store.getDiscoveryRun(runId);if(!run)throw new Error(`unknown discovery run '${runId}'`);
  const countByClass=store.db.prepare('SELECT classification,count(*) count FROM discovery_candidates WHERE run_id=? GROUP BY classification').all(runId);
  const candidates=store.db.prepare('SELECT count(*) total,sum(physical_state=?) existence_probable,sum(access_tag_state=?) access_tags_present FROM discovery_candidates WHERE run_id=?').get('probable','OSM_TAGS_PRESENT',runId);
  const restrictionCount=Number(store.db.prepare(`SELECT count(*) n FROM discovery_candidates WHERE run_id=? AND EXISTS(SELECT 1 FROM json_each(tags_json) WHERE key IN ('access','vehicle','motor_vehicle','motorcycle') AND lower(value) IN ('no','private','destination','customers','agricultural','forestry','permit','use_sidepath'))`).get(runId).n);
  const corroborated=Number(store.db.prepare("SELECT count(DISTINCT candidate_id) n FROM discovery_candidate_matches m JOIN discovery_candidates c USING(candidate_id) WHERE c.run_id=? AND relationship='same_osm_network_part_support'").get(runId).n);
  const tetCandidates=run.reference_run_id?Number(store.db.prepare(`SELECT count(DISTINCT c.candidate_id) n FROM candidates c JOIN route_segments s USING(segment_id)
    JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version WHERE ro.run_id=? AND ro.status='COMPLETE' AND s.classification IN ('PROBABLE_OFFROAD','OFFROAD_CONFIRMED')`).get(run.reference_run_id).n):0;
  return {run_id:runId,status:run.status,country_code:run.country_code,region_id:run.region_id,reference_run_id:run.reference_run_id,snapshot_id:run.snapshot_id,
    edges_examined:run.edges_examined,candidate_count:Number(candidates.total??0),candidate_by_physical_character:Object.fromEntries(countByClass.map(x=>[x.classification,x.count])),
    tet_derived_candidate_count:tetCandidates,physical_state_probable:Number(candidates.existence_probable??0),motorcycle_access_unknown:Number(candidates.total??0),legal_access_known_count:0,legal_access_unknown_count:Number(candidates.total??0),routability_unknown:Number(candidates.total??0),
    access_tagged_count:Number(candidates.access_tags_present??0),no_explicit_access_tag_count:Number(candidates.total??0)-Number(candidates.access_tags_present??0),explicit_restriction_tag_count:restrictionCount,
    canonical_status:'NOT_COMPARED',matched_tet_candidate_count:corroborated,multi_source_corroborated_count:corroborated,independent_of_tet_count:Number(candidates.total??0)-corroborated,
    canonical_new_candidate_count:0,ambiguous_physical_character_count:Number(countByClass.find(x=>x.classification==='UNKNOWN')?.count??0),
    geometry_parallel_or_ambiguous_match_count:null,geometry_identity_matching:'NOT_RUN; only exact OSM way-part support links are created; proximity alone is not identity'};
}
