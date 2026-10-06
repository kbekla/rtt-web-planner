import fs from 'node:fs';
import path from 'node:path';
import { deriveScoutProductState } from './product-model.mjs';

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
  const referenceRows=store.db.prepare(`SELECT c.candidate_id,s.classification,s.evidence_json
    FROM candidates c JOIN route_segments s USING(segment_id)
    JOIN scout_run_observations ro ON ro.observation_id=s.observation_id AND ro.pipeline_version=s.pipeline_version
    WHERE ro.run_id=? AND ro.status='COMPLETE' AND s.classification IN ('UNSEALED_ROAD','PROBABLE_OFFROAD','OFFROAD_CONFIRMED','UNKNOWN')
    ORDER BY c.candidate_id`).all(referenceRunId);
  const scoutRows=store.db.prepare(`SELECT candidate_id,edge_id,part_index,classification,physical_state,motorcycle_access,routability
    FROM discovery_candidates WHERE run_id=? ORDER BY candidate_id`).all(independentRunId);
  const selectedParts=new Map(scoutRows.map(row=>[`${row.edge_id}#part:${row.part_index}`,row]));
  const seenReferenceParts=new Set(),matchCounts={exact:0,partial:0,parallel:null,ambiguous:null,unmatched:0},misses={};
  let physicalAgreement=0,physicalDisagreement=0,legalEvidenceMissing=0;
  const missReasons=new Set(MISS_REASONS);
  for(const row of referenceRows){
    const parts=[...new Set(JSON.parse(row.evidence_json).filter(x=>x.rule==='interval-network-support'&&typeof x.edge_part_id==='string').map(x=>x.edge_part_id))];
    const matched=parts.map(id=>selectedParts.get(id)).filter(Boolean);
    for(const id of parts)seenReferenceParts.add(id);
    if(matched.length&&matched.length===parts.length)matchCounts.exact++;
    else if(matched.length)matchCounts.partial++;
    else {
      matchCounts.unmatched++;
      const reason=parts.length?'OTHER':'GEOMETRY_MATCH_FAILED';
      if(!missReasons.has(reason))throw new Error('invalid benchmark miss reason');
      misses[reason]=(misses[reason]??0)+1;
    }
    if(matched.length){
      if(matched.every(candidate=>candidate.classification===row.classification))physicalAgreement++;
      else physicalDisagreement++;
      // Discovery/network evidence cannot resolve legal access. This is a
      // measured normal ORANGE outcome, never a reason to infer RED/GREEN.
      legalEvidenceMissing++;
    }
  }
  const independentOnly=scoutRows.filter(row=>!seenReferenceParts.has(`${row.edge_id}#part:${row.part_index}`));
  const productStates={ORDINARY_ROAD:0,GREEN:0,ORANGE:0,RED:0,TEMPORARILY_CLOSED:0,NOT_A_ROUTE:0};
  for(const row of scoutRows){
    const state=deriveScoutProductState({physicalExistence:row.physical_state,physicalCharacter:row.classification,
      motorcycleAccess:row.motorcycle_access,routability:row.routability,credibleDiscovery:true});
    productStates[state]++;
  }
  const total=referenceRows.length,matched=matchCounts.exact+matchCounts.partial;
  return {
    report_version:1,phase:'PHASE_1_BENCHMARK_ONLY',phase2_release:'NOT_APPROVED',created_at:new Date().toISOString(),
    country_code:discovery.country_code,region_id:discovery.region_id,
    independent_run:{run_id:discovery.run_id,status:discovery.status,reference_run_id:null,source_id:discovery.discovery_source_id,
      network_snapshot_id:discovery.snapshot_id,network_version:network.version,network_sha256:network.checksum},
    private_comparison:{run_id:referenceRunId,source_id:reference.source_id,source_role:'DISCOVERY_ONLY_COMPARISON_CORPUS'},
    total_reference_corridors_or_features:total,independently_rediscovered:matched,missed:total-matched,
    rediscovery_percent:total?Number((100*matched/total).toFixed(2)):null,
    matches:matchCounts,miss_reasons:misses,physical_classification_agreement:{agreed:physicalAgreement,disagreed:physicalDisagreement,
      basis:'Only exact shared registered-network way-part references; physical-character comparison, not legal status.'},
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
  const file=path.join(benchDir,`tet-phase1-${safeId}.json`),temp=`${file}.${process.pid}.tmp`;
  if(fs.existsSync(file)||fs.existsSync(temp))throw new Error('benchmark report already exists; refusing overwrite');
  const fd=fs.openSync(temp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,`${JSON.stringify(report,null,2)}\n`);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);fs.chmodSync(file,0o600);return file;
}
