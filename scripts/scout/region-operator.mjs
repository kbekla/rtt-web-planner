import crypto from 'node:crypto';
import path from 'node:path';
import { inspectRouteFile } from './route-import.mjs';
import { derivePrivateViewport, resolveGeofabrikCountry } from './geofabrik-index.mjs';

const hash=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const safeSlug=(value)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'source';
const bool=(value,key)=>{if(typeof value!=='boolean')throw new Error(`region prepare requires an explicit yes/no choice for ${key}`);return value;};

export function geofabrikNetworkSourceDefinition(provider){
  if(provider?.provider!=='geofabrik'||!/^[A-Z]{2}$/.test(provider?.country_code??'')
    ||!/^https:\/\/download\.geofabrik\.de\/.+-(?:\d{6})\.osm\.pbf$/.test(provider.url??'')||!provider.snapshot_id||!provider.version)
    throw new Error('Geofabrik network source needs an official dated HTTPS extract and unambiguous region metadata');
  return {source_id:`network-geofabrik-${provider.country_code.toLowerCase()}`,name:`Geofabrik ${provider.region_name} OpenStreetMap network extract`,type:'regional-osm-network',organisation:'Geofabrik GmbH / OpenStreetMap contributors',
    expected_formats:['pbf'],coverage:{countries:[provider.country_code],regions:[provider.provider_region_id]},jurisdiction_ids:[`${provider.country_code.toLowerCase()}-country`],location:provider.url,
    adapter_version:'geofabrik-index-v1+osmium-v1',licence:provider.licence,
    reuse:{private_processing:true,redistribution:true,derived_public_use:false},
    roles:{discovery_only:false,physical_existence:false,legal_access:false,routing_network:true,public_reuse:true,jurisdiction_boundaries:false},
    update:{mechanism:'pinned Geofabrik dated country extract'},attribution:provider.attribution,rate_limits:{requests_per_minute:1},
    network_extract:{provider:provider.provider,url:provider.url,version:provider.version,snapshot_id:provider.snapshot_id,checksum_policy:'calculate-after-download',country_code:provider.country_code,
      provider_index_url:provider.provider_index_url,provider_region_id:provider.provider_region_id,latest_metadata_url:provider.latest_metadata_url,byte_size:provider.byte_size,last_modified:provider.last_modified}};
}

export async function prepareRegionPlan(store,{routeFile,countryCode,regionName,sourceName,sourceType,permissions,sourceLicence,attribution,fetchImpl=fetch,now=new Date()}={}){
  if(!routeFile||!sourceName?.trim()||!sourceType?.trim())throw new Error('region prepare needs the exact route file, source name and source type');
  const code=String(countryCode??'').toUpperCase();if(!/^[A-Z]{2}$/.test(code))throw new Error('country code must be ISO alpha-2');
  const intent={private_processing:bool(permissions?.private_processing,'private research'),redistribution:bool(permissions?.redistribution,'redistribution'),
    derived_public_use:bool(permissions?.derived_public_use,'derived/public use'),legal_evidence:bool(permissions?.legal_evidence,'legal-evidence role')};
  if(!intent.private_processing)throw new Error('regional discovery requires affirmative private-research approval');
  if((intent.redistribution||intent.derived_public_use)&&(!sourceLicence?.trim()||!attribution?.trim()))throw new Error('redistribution/derived public use requires an explicit source licence and attribution; otherwise choose NO');
  const inspected=inspectRouteFile(routeFile);if(!['gpx','kml','geojson'].includes(inspected.format))throw new Error('regional wizard supports GPX, KML and GeoJSON route files');
  if(intent.legal_evidence)throw new Error('route-file discovery input cannot be promoted to a legal-evidence source; register independently authorized legal evidence separately');
  const provider=await resolveGeofabrikCountry({countryCode:code,regionName,fetchImpl});
  const regionSlug=safeSlug(provider.region_name),identity=hash(JSON.stringify([code,inspected.checksum,sourceName.trim(),sourceType.trim()]));
  const sourceId=`route-${code.toLowerCase()}-${identity.slice(0,18)}`;
  const runId=`${code.toLowerCase()}-${inspected.checksum.slice(0,12)}-${provider.version.replaceAll('-','')}`;
  const jurisdictionId=`${code.toLowerCase()}-country`;
  const routeSource={source_id:sourceId,name:sourceName.trim(),type:'route-file',organisation:sourceName.trim(),source_type:sourceType.trim(),
    expected_formats:[inspected.format],coverage:{countries:[code],regions:[provider.provider_region_id]},jurisdiction_ids:[jurisdictionId],
    location:'Exact local file selected by the operator; path and provenance are private.',adapter_version:'route-parser-1',
    licence:{name:sourceLicence?.trim()||'Operator-approved private research only',version:intent.redistribution||intent.derived_public_use?'owner-supplied':'private-approval'},
    reuse:{private_processing:true,redistribution:intent.redistribution,derived_public_use:intent.derived_public_use},
    roles:{discovery_only:true,physical_existence:false,legal_access:intent.legal_evidence,routing_network:false,public_reuse:intent.redistribution,jurisdiction_boundaries:false},
    update:{mechanism:'explicit operator-selected file import'},attribution:attribution?.trim()||'Private provenance retained in Scout; redistribution is not authorized.',
    rate_limits:{requests_per_minute:0},source_policy:{evidence_role:intent.legal_evidence?'owner-designated source role; no automatic legal conclusion':'discovery hint only'}};
  const networkSource=geofabrikNetworkSourceDefinition(provider);
  const prior=store.getRegionPlan(runId);
  const runPlan={run_id:runId,prepared_at:prior?.plan.prepared_at??now.toISOString(),country_code:code,region_id:provider.provider_region_id,region_name:provider.region_name,route_format:inspected.format,jurisdiction_ids:[jurisdictionId],
    route_file:{path:path.resolve(routeFile),original_filename:path.basename(routeFile),format:inspected.format,byte_size:inspected.byte_size,sha256:inspected.checksum,
      bounds:inspected.bounds,viewport:derivePrivateViewport(inspected.bounds),observation_count:inspected.observation_count,point_count:inspected.point_count},
    source_name:sourceName.trim(),source_type:sourceType.trim(),permissions:intent,route_source:routeSource,network_source:networkSource,provider,
    classifier:'frozen-current',canonical_status:'NOT_COMPARED',physical_existence:'independent',motorcycle_access:'UNKNOWN',routability:'UNKNOWN'};
  return store.saveRegionPlan(runPlan);
}

export function approveRegionPlan(store,{runId,approvedBy,approvalScope}={}){
  const plan=store.getRegionPlan(runId);if(!plan)throw new Error(`unknown Scout region plan '${runId}'`);
  if(!approvedBy?.trim()||!approvalScope?.trim())throw new Error('region approval requires operator identity and a private-use scope');
  if(plan.plan.permissions.private_processing!==true)throw new Error('private research permission is not affirmative');
  const sourceRoute=store.registerSource(plan.plan.route_source);
  const networkDefinition={...plan.plan.network_source},existingNetwork=store.getSource(networkDefinition.source_id);
  if(existingNetwork?.network_extract?.snapshot_id===networkDefinition.network_extract.snapshot_id&&/^[a-f0-9]{64}$/i.test(existingNetwork.network_extract.sha256??'')){
    networkDefinition.network_extract={...networkDefinition.network_extract,sha256:existingNetwork.network_extract.sha256,checksum_policy:existingNetwork.network_extract.checksum_policy};
  }
  const sourceNetwork=store.registerSource(networkDefinition);
  store.approveSource({source_id:sourceRoute.source_id,approved_by:approvedBy,scope:approvalScope});
  store.approveSource({source_id:sourceNetwork.source_id,approved_by:approvedBy,scope:`${approvalScope}; licensed Geofabrik OSM routing-network processing`});
  return store.updateRegionPlan(runId,{state:'APPROVED',approved_by:approvedBy,approval_scope:approvalScope});
}

export function validateRegionPlanForProcess(store,runId){
  const plan=store.getRegionPlan(runId);if(!plan)throw new Error(`unknown Scout region plan '${runId}'`);
  if(!['APPROVED','RUNNING','BLOCKED','REVIEW_REQUIRED','FAILED','COMPLETE'].includes(plan.state)||!plan.approved_by||!plan.approval_scope)
    throw new Error('region plan requires explicit operator approval before processing');
  const sourceApproval=store.sourceApproval(plan.plan.route_source.source_id),networkApproval=store.sourceApproval(plan.plan.network_source.source_id);
  if(!sourceApproval||sourceApproval.approved_by!==plan.approved_by||sourceApproval.scope!==plan.approval_scope)throw new Error('route-source approval is missing or does not match the region plan');
  if(!networkApproval||networkApproval.approved_by!==plan.approved_by)throw new Error('regional network source is not explicitly approved');
  return plan;
}
