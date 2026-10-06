import fs from 'node:fs';
import path from 'node:path';
import { deriveScoutProductState } from './product-model.mjs';
import { lengthMeters } from './route-segmenter.mjs';

const MISS_REASONS = Object.freeze(['NO_OFFICIAL_SOURCE','SOURCE_COVERAGE_GAP','GEOMETRY_MATCH_FAILED','LEGAL_EVIDENCE_MISSING','LICENCE_BLOCKED','SOURCE_UNAVAILABLE','OTHER']);
const classes = new Set(['ROAD','UNSEALED_ROAD','PROBABLE_OFFROAD','OFFROAD_CONFIRMED','UNKNOWN']);

/**
 * Compare only after an independent discovery run completed. This exact
 * network-part benchmark consumes no TET geometry during discovery and never
 * treats TET as access evidence.
 */
export function benchmarkTetAgainstIndependentDiscovery(store,{independentRunId,referenceRunId}={}) {
  const discovery=store.getDiscoveryRun(independentRunId);
  if(!discovery)throw new Error(`unknown independent discovery run '${independentRunId}'`);
  if(discovery.status!=='COMPLETE')throw new Error('TET benchmark is gated until independent discovery is COMPLETE');
  if(discovery.reference_run_id!==null)throw new Error('benchmark refuses a discovery run that used a reference run');
  if(discovery.edges_examined!==store.networkEdgeCount(discovery.snapshot_id))throw new Error('benchmark requires a full-snapshot independent discovery pass');
  const discoverySource=store.getSource(discovery.discovery_source_id),network=store.getNetworkSnapshot(discovery.snapshot_id),networkSource=network&&store.getSource(network.source_id);
  const supportedNetwork=String(networkSource?.type??'').toLowerCase().includes('osm')||networkSource?.network_api?.provider==='statens-vegvesen-nvdb-api-les-v4';
  if(!discoverySource||!network||!networkSource?.roles?.routing_network||!supportedNetwork||
      discoverySource.roles?.legal_access===true||discoverySource.parent_network_source_id!==network.source_id)
    throw new Error('independent discovery source/snapshot provenance is invalid');
  const reference=store.getRun(referenceRunId);
  if(!reference)throw new Error(`unknown final comparison run '${referenceRunId}'`);
  if(reference.country_code!==discovery.country_code)throw new Error('comparison and independent runs must be in the same jurisdiction');
  const referenceTotal=Object.values(reference.observation_counts).reduce((sum,value)=>sum+Number(value),0);
  if(!reference.observation_counts.COMPLETE||reference.observation_counts.COMPLETE!==referenceTotal)throw new Error('comparison corpus must be fully processed before benchmarking');
  const referenceSource=store.getSource(reference.source_id);
  if(!referenceSource||referenceSource.roles?.discovery_only!==true||referenceSource.roles?.legal_access===true||referenceSource.reuse?.private_processing!==true||referenceSource.source_id===network.source_id)
    throw new Error('comparison run is not a privately approved discovery-only source');
  const comparisonApproval=store.sourceApproval(reference.source_id);
  if(!comparisonApproval||comparisonApproval.approved_by!==reference.approved_by||comparisonApproval.scope!==reference.approval_scope)
    throw new Error('comparison source approval is missing, revoked or differs from the immutable reference run');
  // Route observations are the corpus features. Requiring a pre-existing
  // candidate row here would make a failed discovery look like an empty
  // benchmark. Ordinary ROAD sections are counted as road context, while a
  // feature enters the corridor denominator only when Scout's independent
  // post-run segmentation found non-ROAD material.
  const featureRows=store.db.prepare(`SELECT o.observation_id,o.source_name,s.segment_id,s.classification,s.geometry_json,s.evidence_json
    FROM scout_run_observations ro JOIN route_observations o USING(observation_id)
    LEFT JOIN route_segments s ON s.observation_id=o.observation_id AND s.pipeline_version=(
      SELECT max(s2.pipeline_version) FROM route_segments s2 WHERE s2.observation_id=o.observation_id)
    WHERE ro.run_id=? AND ro.status='COMPLETE' ORDER BY o.observation_id,s.ordinal`).all(referenceRunId);
  const featureMap=new Map();
  const segmentation={classes:{},distance_km_by_class:{},unknown_reasons:{},unknown_reason_km:{}};
  for(const row of featureRows){
    let feature=featureMap.get(row.observation_id);if(!feature){feature={observation_id:row.observation_id,segments:[]};featureMap.set(row.observation_id,feature);}
    if(!row.segment_id)continue;
    const geometry=JSON.parse(row.geometry_json),lines=geometry.type==='LineString'?[geometry.coordinates]:geometry.coordinates;
    const km=lines.reduce((sum,line)=>sum+line.slice(1).reduce((n,p,i)=>n+lengthMeters(line[i],p),0),0)/1000;
    feature.segments.push({segment_id:row.segment_id,classification:row.classification,evidence:JSON.parse(row.evidence_json)});
    segmentation.classes[row.classification]=(segmentation.classes[row.classification]??0)+1;
    segmentation.distance_km_by_class[row.classification]=(segmentation.distance_km_by_class[row.classification]??0)+km;
    if(row.classification==='UNKNOWN'){
      const reasons=[...new Set(JSON.parse(row.evidence_json).flatMap(e=>e.rule==='interval-network-ambiguity'&&e.reason?[e.reason]:e.rule==='no-network-match-within-threshold'?['no_network_match']:[]))];
      const reason=reasons.length===1?reasons[0]:reasons.length?'multiple_unknown_reasons':'unknown_unspecified';
      segmentation.unknown_reasons[reason]=(segmentation.unknown_reasons[reason]??0)+1;
      segmentation.unknown_reason_km[reason]=(segmentation.unknown_reason_km[reason]??0)+km;
    }
  }
  const referenceFeatures=[...featureMap.values()].filter(feature=>feature.segments.some(segment=>segment.classification!=='ROAD'));
  const scoutRows=store.db.prepare(`SELECT candidate_id,edge_id,part_index,classification,physical_state,motorcycle_access,routability
    FROM discovery_candidates WHERE run_id=? ORDER BY candidate_id`).all(independentRunId);
  const selectedParts=new Map(scoutRows.map(row=>[`${row.edge_id}#part:${row.part_index}`,row]));
  const seenReferenceParts=new Set(),matchCounts={exact:0,partial:0,parallel:null,ambiguous:0,unmatched:0},misses={};
  const missDetails=[];let physicalAgreement=0,physicalDisagreement=0,legalEvidenceMissing=0,matchedSegmentCount=0;
  const missReasons=new Set(MISS_REASONS);
  const matchedReferenceParts=new Set();
  for(let featureIndex=0;featureIndex<referenceFeatures.length;featureIndex++){
    const feature=referenceFeatures[featureIndex],segments=feature.segments.filter(segment=>segment.classification!=='ROAD');
    const supportedBySegment=segments.map(segment=>[...new Set(segment.evidence.filter(e=>e.rule==='interval-network-support'&&typeof e.edge_part_id==='string').map(e=>e.edge_part_id))]);
    const supportedParts=[...new Set(supportedBySegment.flat())],matchedParts=supportedParts.filter(id=>selectedParts.has(id));
    const ambiguousParts=[...new Set(segments.flatMap(segment=>segment.evidence.filter(e=>e.rule==='interval-network-ambiguity').flatMap(e=>e.edge_part_ids??[])))];
    const ambiguousCandidateParts=ambiguousParts.filter(id=>selectedParts.has(id));
    const matchedSegments=new Set();
    for(let i=0;i<supportedBySegment.length;i++)for(const id of supportedBySegment[i]){
      seenReferenceParts.add(id);
      if(selectedParts.has(id)){matchedSegments.add(segments[i].segment_id);matchedReferenceParts.add(id);}
    }
    for(const id of ambiguousParts)seenReferenceParts.add(id);
    if(matchedSegments.size&&matchedSegments.size===segments.length)matchCounts.exact++;
    else if(matchedSegments.size)matchCounts.partial++;
    else if(ambiguousCandidateParts.length){matchCounts.ambiguous++;misses.GEOMETRY_MATCH_FAILED=(misses.GEOMETRY_MATCH_FAILED??0)+1;
      missDetails.push({feature_index:featureIndex+1,reason:'GEOMETRY_MATCH_FAILED',non_road_segment_count:segments.length,network_supported_parts:supportedParts.length,
        ambiguous_candidate_parts:ambiguousCandidateParts.length});}
    else {
      matchCounts.unmatched++;
      const allEvidence=segments.flatMap(segment=>segment.evidence),hasNetworkSupport=supportedParts.length>0;
      const reason=!hasNetworkSupport||allEvidence.some(e=>e.reason==='no_network_match'||e.rule==='no-network-match-within-threshold')?'SOURCE_COVERAGE_GAP':'OTHER';
      if(!missReasons.has(reason))throw new Error('invalid benchmark miss reason');
      misses[reason]=(misses[reason]??0)+1;
      missDetails.push({feature_index:featureIndex+1,reason,non_road_segment_count:segments.length,network_supported_parts:supportedParts.length,ambiguous_candidate_parts:0});
    }
    matchedSegmentCount+=matchedSegments.size;
    for(const segment of segments){
      const ids=[...new Set(segment.evidence.filter(e=>e.rule==='interval-network-support'&&typeof e.edge_part_id==='string').map(e=>e.edge_part_id))];
      const candidates=ids.map(id=>selectedParts.get(id)).filter(Boolean);
      if(candidates.length){if(candidates.every(candidate=>candidate.classification===segment.classification))physicalAgreement++;else physicalDisagreement++;legalEvidenceMissing++;}
    }
  }
  const independentOnly=scoutRows.filter(row=>!seenReferenceParts.has(`${row.edge_id}#part:${row.part_index}`));
  const productStates={ORDINARY_ROAD:0,GREEN:0,ORANGE:0,RED:0,TEMPORARILY_CLOSED:0,NOT_A_ROUTE:0};
  for(const row of scoutRows){
    const state=deriveScoutProductState({physicalExistence:row.physical_state,physicalCharacter:row.classification,
      motorcycleAccess:row.motorcycle_access,routability:row.routability,credibleDiscovery:true});
    productStates[state]++;
  }
  const total=referenceFeatures.length,matched=matchCounts.exact+matchCounts.partial;
  for(const key of ['distance_km_by_class','unknown_reason_km'])for(const [name,value]of Object.entries(segmentation[key]))segmentation[key][name]=Number(value.toFixed(3));
  return {
    report_version:2,phase:'PHASE_1_BENCHMARK_ONLY',phase2_release:'NOT_APPROVED',created_at:new Date().toISOString(),
    country_code:discovery.country_code,region_id:discovery.region_id,
    independent_run:{run_id:discovery.run_id,status:discovery.status,reference_run_id:null,source_id:discovery.discovery_source_id,
      network_snapshot_id:discovery.snapshot_id,network_version:network.version,network_sha256:network.checksum},
    private_comparison:{run_id:referenceRunId,source_id:reference.source_id,source_role:'DISCOVERY_ONLY_COMPARISON_CORPUS'},
    total_reference_corridors_or_features:total,reference_route_feature_count:featureMap.size,ordinary_road_only_features_excluded:featureMap.size-total,
    reference_segmentation:segmentation,independently_rediscovered:matched,confirmed_rediscovery_percent:total?Number((100*matched/total).toFixed(2)):null,
    ambiguously_supported_features:matchCounts.ambiguous,missed:total-matched,
    rediscovery_percent:total?Number((100*matched/total).toFixed(2)):null,
    matches:matchCounts,miss_reasons:misses,miss_details:missDetails,physical_classification_agreement:{agreed:matchedSegmentCount?physicalAgreement:null,disagreed:matchedSegmentCount?physicalDisagreement:null,
      matched_non_road_segments:matchedSegmentCount,basis:'Only exact shared registered-network way-part references; physical-character comparison, not legal status. Null expected state is not inferred from the TET corpus.'},
    product_state_counts:productStates,legal_evidence_missing_on_matches:legalEvidenceMissing,
    authoritative_state_comparison:{green:null,orange:null,red:null,temporarily_closed:null,
      reason:'The comparison source is discovery-only and cannot supply expected legal/product states. Compare against a separately approved authoritative/current RT&T state corpus.'},
    authoritative_upgrades_or_downgrades:null,
    extra_independent_candidate_way_parts:independentOnly.length,
    match_method:'EXACT_SHARED_NETWORK_EDGE_PART_IDENTITY_ONLY',
    limitations:['Partial matches are only set-level partial support.','PARALLEL and AMBIGUOUS require a separately validated post-run geometry adjudicator and are intentionally null, not zero.',
      'Unmatched reasons are provisional and conservative; OTHER means reference evidence cites network parts that Scout did not select as candidate way-parts.',
      'No TET geometry, route, evidence, or metadata was read by the independent discovery pass. TET data is accessed only by this post-completion comparison.',
      'No TET, OSM, or NVDB road-network record is by itself legal-access evidence.'],
    human_approval_required_before_phase2:true,
  };
}

/** Persist benchmark cross-references in a private, mode-0600 atomic report. */
export function writePrivateTetBenchmark(root,report){
  const safeId=String(report?.independent_run?.run_id??'').replace(/[^A-Za-z0-9._-]/g,'');
  if(!safeId||safeId!==report.independent_run.run_id)throw new Error('benchmark run ID is not a safe filename');
  const privateRoot=fs.realpathSync(root),benchDir=path.join(privateRoot,'benchmarks');
  fs.mkdirSync(benchDir,{recursive:true,mode:0o700});if(fs.lstatSync(benchDir).isSymbolicLink()||fs.realpathSync(benchDir)!==benchDir)throw new Error('benchmark directory must remain inside private Scout storage');
  fs.chmodSync(benchDir,0o700);
  const suffix=Number(report.report_version??1)>1?`-v${Number(report.report_version)}`:'';
  const file=path.join(benchDir,`tet-phase1-${safeId}${suffix}.json`),temp=`${file}.${process.pid}.tmp`;
  if(fs.existsSync(file)||fs.existsSync(temp))throw new Error('benchmark report already exists; refusing overwrite');
  const fd=fs.openSync(temp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,`${JSON.stringify(report,null,2)}\n`);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);fs.chmodSync(file,0o600);return file;
}
