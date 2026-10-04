// One resumable-friendly observation processing boundary. The caller supplies
// a pinned road-network snapshot and, optionally, the read-only canonical
// master handle. No master path is inferred and no mutation API is used.
import crypto from 'node:crypto';
import { segmentRouteObservation } from './route-segmenter.mjs';

const lines=(geometry)=>geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:[];
const metersLat=(m)=>m/110574;
const metersLon=(m,lat)=>m/Math.max(1000,111320*Math.cos(lat*Math.PI/180));
function spatialCells(geometry,{cellDegrees=0.001,maxCells=10000,maxVertices=50000}={}) {
  const coords=lines(geometry).flat();
  if(coords.length>maxVertices)throw new Error('observation exceeds bounded route-vertex budget; split at original component boundaries before retry');
  const cells=new Map();
  for(const [lon,lat]of coords) {
    const cx=Math.floor(lon/cellDegrees),cy=Math.floor(lat/cellDegrees),key=`${cx}:${cy}`;
    if(!cells.has(key)) {
      if(cells.size>=maxCells)throw new Error('observation exceeds bounded regional network-query budget; defer or split at source component boundary');
      const centerLon=(cx+0.5)*cellDegrees,centerLat=(cy+0.5)*cellDegrees;
      const padLat=metersLat(90)+cellDegrees/2,padLon=metersLon(90,centerLat)+cellDegrees/2;
      cells.set(key,[Math.max(-180,centerLon-padLon),Math.max(-90,centerLat-padLat),Math.min(180,centerLon+padLon),Math.min(90,centerLat+padLat)]);
    }
  }
  return [...cells.values()];
}

export function processRouteObservation(store, observationId, { networkSnapshotId, canonicalMaster=null, jurisdictions=[], maxNetworkEdges=100000,
  networkEdgesPerCell=1000, segmenterOptions={}, shouldYield=()=>false }={}) {
  if(!networkSnapshotId)throw new Error('an explicit pinned networkSnapshotId is required');
  const observationRow=store.getObservation(observationId);if(!observationRow)throw new Error(`unknown route observation '${observationId}'`);
  const snapshot=store.getNetworkSnapshot(networkSnapshotId);if(!snapshot)throw new Error(`unknown network snapshot '${networkSnapshotId}'`);
  const networkSource=store.getSource(snapshot.source_id);if(!networkSource)throw new Error('network snapshot source is missing from the source registry');
  if(!observationRow.geometry)throw new Error('source observation has no usable geometry; retain as discovery hint for review');
  const queryCells=spatialCells(observationRow.geometry);
  const unique=new Map();
  for(const bbox of queryCells) {
    const rows=store.queryNetworkEdges(bbox,{snapshotId:networkSnapshotId,limit:networkEdgesPerCell});
    if(rows.length>=networkEdgesPerCell)throw new Error('regional network query reached its safety cap; classification deferred as ambiguous');
    for(const row of rows)unique.set(row.edge_id,{edge_id:row.edge_id,geometry:row.geometry,tags:row.tags,evidence:row.evidence,jurisdiction_ids:row.jurisdiction_ids});
    if(unique.size>maxNetworkEdges)throw new Error('observation regional network slice exceeds configured edge budget; defer for bounded chunk processing');
  }
  const networkEvidence=[...unique.values()].map((edge)=>({...edge,evidence:(edge.evidence??[]).map((e)=>
    e.question==='physical_existence'&&e.qualified===true&&networkSource.roles.physical_existence!==true?{...e,qualified:false,qualification_blocked_by_source_role:true}:e)}));
  if(shouldYield()) { const error=new Error('shared factory admission requested Scout yield before segmentation');error.code='SCOUT_YIELD_REQUESTED';throw error; }
  const result=segmentRouteObservation({observation_id:observationRow.observation_id,geometry:observationRow.geometry,
    source_language:observationRow.source_language,source_name:observationRow.source_name},networkEvidence,{...segmenterOptions,jurisdictions,shouldYield});
  if(shouldYield()) { const error=new Error('shared factory admission requested Scout yield before persistence');error.code='SCOUT_YIELD_REQUESTED';throw error; }
  for(const segment of result.segments) {
    segment.network_snapshot_id=networkSnapshotId;
    store.saveSegment(segment);
    if(segment.classification==='UNKNOWN')store.saveReviewItem({subject_type:'segment',subject_id:segment.segment_id,reason_code:'SEGMENT_CHARACTER_UNKNOWN',
      explanation:'No unambiguous road-network character evidence supports this route segment. It remains visible as UNKNOWN and is not treated as a trail candidate.',
      context:{classification:segment.classification,evidence:segment.evidence,source_observation_id:observationId},recommended_action:'Check a better licensed/versioned network or collect independent physical-existence evidence.'});
    if(segment.classification==='UNSEALED_ROAD')store.saveReviewItem({subject_type:'segment',subject_id:segment.segment_id,reason_code:'UNSEALED_ROAD_NOT_TRAIL',
      explanation:'The matched network describes an unsealed road/track. This character alone does not show that it is an off-road trail or that motorcycles may use it.',
      context:{classification:segment.classification,jurisdiction_ids:segment.jurisdiction_ids,evidence:segment.evidence},recommended_action:'Check authoritative road status and jurisdiction-specific motorcycle access evidence if this corridor is in scope.'});
  }
  const candidates=[];
  for(const segment of result.candidates) {
    const match=canonicalMaster?canonicalMaster.match({geometry:segment.geometry}):{type:'UNMATCHED',rtt_ids:[],scores:[],reason:'canonical master not supplied'};
    const issues=[];
    if(segment.classification==='PROBABLE_OFFROAD')issues.push({code:'PHYSICAL_EXISTENCE_UNCONFIRMED',message:'Network character indicates a probable off-road corridor; ground existence evidence is not confirmed.'});
    if(match.type==='AMBIGUOUS')issues.push({code:'CANONICAL_MATCH_AMBIGUOUS',message:'Several or weakly corroborated canonical match hypotheses require review.'});
    if(segment.jurisdiction_ids.length>1)issues.push({code:'MULTIPLE_JURISDICTIONS',message:'Physical corridor intersects multiple legal jurisdictions; access evidence must remain jurisdiction-scoped.'});
    const candidate=store.saveCandidate(segment,{candidate_id:`candidate-${segment.segment_id}`,master_match:match.type,matched_rtt_ids:match.rtt_ids,
      match_details:{scores:match.scores??[],reason:match.reason??null,master_sha256:canonicalMaster?.sha256??null,master_feature_count:canonicalMaster?.feature_count??null},
      network_snapshot_id:networkSnapshotId,jurisdiction_ids:segment.jurisdiction_ids,physical_state:segment.classification==='OFFROAD_CONFIRMED'?'confirmed':'unknown',motorcycle_access:'unknown',routability:'unknown',
      review_state:match.type==='AMBIGUOUS'||segment.jurisdiction_ids.length>1?'AWAITING_REVIEW':'AWAITING_EVIDENCE',issues});
    const physicalEvidence=new Map();
    for(const matchEvidence of segment.evidence)for(const evidence of matchEvidence.network_evidence??[])
      if(evidence.question==='physical_existence'&&evidence.outcome==='confirmed'&&evidence.qualified===true&&evidence.reference)physicalEvidence.set(evidence.reference,evidence);
    for(const evidence of physicalEvidence.values())store.saveEvidence({...evidence,candidate_id:candidate.candidate_id,observation_id:observationId,
      source_id:snapshot.source_id,source_version:snapshot.version,question:'physical_existence',outcome:'confirmed'});
    if(match.type==='AMBIGUOUS'||segment.jurisdiction_ids.length>1)store.saveReviewItem({subject_type:'candidate',subject_id:candidate.candidate_id,
      reason_code:match.type==='AMBIGUOUS'?'CANONICAL_MATCH_AMBIGUOUS':'CROSS_JURISDICTION_EVIDENCE_SCOPE',
      explanation:match.type==='AMBIGUOUS'?'Canonical geometry produced an ambiguous match hypothesis; the candidate is retained without merging.':'The same physical segment crosses legal jurisdiction boundaries; access evidence must be assessed separately for each jurisdiction.',
      context:{match_type:match.type,matched_rtt_ids:match.rtt_ids,jurisdiction_ids:segment.jurisdiction_ids,physical_state:'unknown',motorcycle_access:'unknown',routability:'unknown'},
      recommended_action:match.type==='AMBIGUOUS'?'Compare with the appropriate regional canonical master and corroborate identity before grouping.':'Collect current access evidence for each listed jurisdiction without splitting the physical corridor identity.'});
    candidates.push(candidate);
  }
  for(const hypothesis of result.continuity_hypotheses) {
    const candidate_ids=hypothesis.candidate_segment_ids.map((id)=>`candidate-${id}`).sort();
    const identity=[networkSnapshotId,observationId,hypothesis.component_index,candidate_ids,hypothesis.connector_segment_ids,hypothesis.shared_network_edge_ids];
    const hypothesis_id=`corridor-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,24)}`;
    store.saveCorridorHypothesis({hypothesis_id,observation_id:observationId,component_index:hypothesis.component_index,network_snapshot_id:networkSnapshotId,
      candidate_ids,connector_segment_ids:hypothesis.connector_segment_ids,support_edge_ids:hypothesis.shared_network_edge_ids,
      connector_length_m:hypothesis.connector_length_m,hypothesis:hypothesis.hypothesis,geometry_gap_filled:hypothesis.geometry_gap_filled,evidence:hypothesis.evidence});
    hypothesis.hypothesis_id=hypothesis_id;hypothesis.candidate_ids=candidate_ids;hypothesis.network_snapshot_id=networkSnapshotId;
  }
  return {observation_id:observationId,source_geometry:observationRow.geometry,network_snapshot:{snapshot_id:snapshot.snapshot_id,version:snapshot.version,checksum:snapshot.checksum},
    segment_count:result.segments.length,candidate_count:candidates.length,segments:result.segments,candidates,continuity_hypotheses:result.continuity_hypotheses};
}
