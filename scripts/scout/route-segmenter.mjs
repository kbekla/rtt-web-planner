import crypto from 'node:crypto';
import { assignJurisdictions } from './jurisdictions.mjs';

// Conservative, deterministic route-to-network classifier. This creates derived
// segment geometries; it never edits an imported observation's source geometry.
export const SEGMENTATION_VERSION = 'network-segmenter-1';
export const SEGMENT_CLASSES = Object.freeze(['ROAD','UNSEALED_ROAD','PROBABLE_OFFROAD','OFFROAD_CONFIRMED','UNKNOWN']);
const ROAD = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','residential','living_street','unclassified','road']);
const PATH = new Set(['path','bridleway','footway','steps','cycleway']);
const UNSEALED = new Set(['unpaved','compacted','fine_gravel','gravel','ground','dirt','earth','mud','sand','grass','pebblestone']);
const PAVED = new Set(['paved','asphalt','concrete','concrete:lanes','concrete:plates','paving_stones','sett','cobblestone','metal','wood']);
const rad = (n) => n * Math.PI / 180;
function distancePointSegmentMeters(point, a, b) {
  const lat0=rad(point[1]), scaleX=111320*Math.cos(lat0), scaleY=110574;
  let pointLon=point[0],endLon=b[0];while(pointLon-a[0]>180)pointLon-=360;while(pointLon-a[0]<-180)pointLon+=360;while(endLon-a[0]>180)endLon-=360;while(endLon-a[0]<-180)endLon+=360;
  const p=[(pointLon-a[0])*scaleX,(point[1]-a[1])*scaleY], q=[(endLon-a[0])*scaleX,(b[1]-a[1])*scaleY];
  const d=q[0]*q[0]+q[1]*q[1], t=d?Math.max(0,Math.min(1,(p[0]*q[0]+p[1]*q[1])/d)):0;
  return Math.hypot(p[0]-t*q[0],p[1]-t*q[1]);
}
const lineParts=(geometry)=>geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:[];
function validLine(coords) { return Array.isArray(coords)&&coords.length>=2&&coords.every((p)=>Array.isArray(p)&&p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90); }
function lengthMeters(a,b) { const lat=rad((a[1]+b[1])/2);let dlon=b[0]-a[0];while(dlon>180)dlon-=360;while(dlon< -180)dlon+=360;return Math.hypot(dlon*111320*Math.cos(lat),(b[1]-a[1])*110574); }
function edgeClass(edge) {
  const t=edge.tags??{}, highway=String(t.highway??'').toLowerCase(), surface=String(t.surface??'').toLowerCase(), tracktype=String(t.tracktype??'').toLowerCase();
  const confirmed=(edge.evidence??[]).some((e)=>e.question==='physical_existence'&&e.outcome==='confirmed'&&e.qualified===true&&e.reference);
  if (confirmed && PATH.has(highway) && (UNSEALED.has(surface)||/^grade[3-5]$/.test(tracktype))) return 'OFFROAD_CONFIRMED';
  if (ROAD.has(highway)) return UNSEALED.has(surface) ? 'UNSEALED_ROAD' : 'ROAD';
  if (highway==='track' || highway==='service') {
    if (PAVED.has(surface)) return 'ROAD';
    if (UNSEALED.has(surface) || /^grade[1-2]$/.test(tracktype)) return 'UNSEALED_ROAD';
    if (/^grade[3-5]$/.test(tracktype)) return 'PROBABLE_OFFROAD';
    return 'UNKNOWN';
  }
  if (PATH.has(highway)) return UNSEALED.has(surface)||/^grade[3-5]$/.test(tracktype) ? 'PROBABLE_OFFROAD' : 'UNKNOWN';
  return 'UNKNOWN';
}
const NETWORK_CELL_DEGREES=0.002;
function buildNetworkIndex(edges) {
  const grid=new Map(),longSegments=[];
  for(const edge of edges) {
    const classification=edgeClass(edge);
    for(const part of lineParts(edge.geometry))if(validLine(part))for(let i=1;i<part.length;i++) {
      const a=part[i-1],b=part[i],segment={edge,classification,a,b};
      const x0=Math.floor(Math.min(a[0],b[0])/NETWORK_CELL_DEGREES),x1=Math.floor(Math.max(a[0],b[0])/NETWORK_CELL_DEGREES);
      const y0=Math.floor(Math.min(a[1],b[1])/NETWORK_CELL_DEGREES),y1=Math.floor(Math.max(a[1],b[1])/NETWORK_CELL_DEGREES);
      if((x1-x0+1)*(y1-y0+1)>1000){longSegments.push(segment);continue;}
      for(let x=x0-1;x<=x1+1;x++)for(let y=y0-1;y<=y1+1;y++){const key=`${x}:${y}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(segment);}
    }
  }
  return {grid,longSegments};
}
function classifyPoint(point,index,options) {
  const cx=Math.floor(point[0]/NETWORK_CELL_DEGREES),cy=Math.floor(point[1]/NETWORK_CELL_DEGREES),segments=new Set(index.longSegments);
  for(let x=cx-1;x<=cx+1;x++)for(let y=cy-1;y<=cy+1;y++)for(const segment of index.grid.get(`${x}:${y}`)??[])segments.add(segment);
  const nearestByEdge=new Map();
  for(const segment of segments) {
    const d=distancePointSegmentMeters(point,segment.a,segment.b);if(d>options.maxSnapMeters)continue;
    const old=nearestByEdge.get(segment.edge.edge_id);if(!old||d<old.d)nearestByEdge.set(segment.edge.edge_id,{edge_id:segment.edge.edge_id,classification:segment.classification,d,edge:segment.edge});
  }
  const hits=[...nearestByEdge.values()];
  hits.sort((a,b)=>a.d-b.d||String(a.edge_id).localeCompare(String(b.edge_id)));
  if(!hits.length) return {classification:'UNKNOWN',evidence:[{rule:'no-network-match-within-threshold',threshold_m:options.maxSnapMeters}]};
  if(hits.length>1 && hits[1].d-hits[0].d<=options.ambiguityMarginMeters && hits[1].classification!==hits[0].classification)
    return {classification:'UNKNOWN',evidence:[{rule:'competing-parallel-network-edges',edge_ids:[hits[0].edge_id,hits[1].edge_id],distances_m:[hits[0].d,hits[1].d]}]};
  return {classification:hits[0].classification,evidence:[{rule:'nearest-network-edge',edge_id:hits[0].edge_id,distance_m:Number(hits[0].d.toFixed(2)),network_class:hits[0].classification,
    network_evidence:hits[0].edge.evidence??[]}]};
}
function interpolate(a,b,t) { const n=Math.min(a.length,b.length),lon=(()=>{let v=b[0];while(v-a[0]>180)v-=360;while(v-a[0]<-180)v+=360;return v;})();return Array.from({length:n},(_,i)=>i===0?((a[0]+(lon-a[0])*t+540)%360)-180:a[i]+(b[i]-a[i])*t); }
function mergeShortRoadCrossings(runs, coords, maxMeters) {
  for(let i=1;i<runs.length-1;i++) {
    const run=runs[i];
    if(run.classification!=='ROAD'||!['PROBABLE_OFFROAD','OFFROAD_CONFIRMED'].includes(runs[i-1].classification)||runs[i-1].classification!==runs[i+1].classification) continue;
    let distance=0;
    if(run.start>0) distance+=lengthMeters(coords[run.start-1],coords[run.start])/2;
    for(let k=run.start;k<run.end;k++) distance+=lengthMeters(coords[k],coords[k+1]);
    if(run.end<coords.length-1) distance+=lengthMeters(coords[run.end],coords[run.end+1])/2;
    if(distance<=maxMeters) { runs[i-1].end=runs[i+1].end; runs[i-1].evidence.push({rule:'short-road-crossing-preserved',distance_m:Number(distance.toFixed(1)),crossing_class:'ROAD'}); runs.splice(i,2); i--; }
  }
  return runs;
}
function runsFor(coords, labels, crossingMeters, maxTransitionGapMeters) {
  const runs=[];
  for(let i=0;i<labels.length;i++) { const classification=labels[i].classification;
    if(!runs.length||runs.at(-1).classification!==classification) runs.push({classification,start:i,end:i,evidence:[]}); else runs.at(-1).end=i;
    runs.at(-1).evidence.push(...labels[i].evidence);
  }
  const compact=mergeShortRoadCrossings(runs,coords,crossingMeters),withGaps=[];
  for(let i=0;i<compact.length;i++) {
    const current=compact[i];withGaps.push(current);
    const next=compact[i+1];if(!next)continue;
    const left=current.end,right=next.start,gapMeters=lengthMeters(coords[left],coords[right]);
    if(right===left+1&&gapMeters>maxTransitionGapMeters) {
      current.gap_after=true;next.gap_before=true;
      withGaps.push({classification:'UNKNOWN',start:left,end:right,explicit_geometry:{type:'LineString',coordinates:[coords[left],coords[right]]},
        evidence:[{rule:'transition-gap-too-long-to-place-boundary',gap_m:Number(gapMeters.toFixed(1)),maximum_boundary_gap_m:maxTransitionGapMeters}]});
    }
  }
  return withGaps;
}
function runGeometry(coords, run) {
  if(run.explicit_geometry)return run.explicit_geometry;
  const output=[];
  if(run.gap_before)output.push(coords[run.start]);
  else if(run.start>0) output.push(interpolate(coords[run.start-1],coords[run.start],0.5)); else output.push(coords[run.start]);
  for(let i=run.start;i<=run.end;i++) if(!output.length||output.at(-1)!==coords[i]) output.push(coords[i]);
  if(run.gap_after)output.push(coords[run.end]);
  else if(run.end<coords.length-1) output.push(interpolate(coords[run.end],coords[run.end+1],0.5));
  if(output.length===1) output.push(coords[Math.min(run.start+1,coords.length-1)]);
  return {type:'LineString',coordinates:output};
}
const createHash=(value)=>crypto.createHash('sha256').update(value).digest('hex');

export function segmentRouteObservation(observation, networkEdges, { maxSnapMeters=8, ambiguityMarginMeters=4, shortRoadCrossingMeters=45, maxTransitionGapMeters=50, pipelineVersion=SEGMENTATION_VERSION, jurisdictions=[] }={}) {
  if(!observation?.observation_id) throw new Error('route observation requires stable observation_id');
  if(!Array.isArray(networkEdges)) throw new Error('networkEdges must be an explicit array');
  for(const key of ['maxSnapMeters','ambiguityMarginMeters','shortRoadCrossingMeters','maxTransitionGapMeters']) if(!Number.isFinite({maxSnapMeters,ambiguityMarginMeters,shortRoadCrossingMeters,maxTransitionGapMeters}[key])||{maxSnapMeters,ambiguityMarginMeters,shortRoadCrossingMeters,maxTransitionGapMeters}[key]<0) throw new Error('segmentation distances must be finite non-negative metres');
  const parts=lineParts(observation.geometry);
  if(!parts.length||parts.some((part)=>!validLine(part))) throw new Error('observation has no usable source line geometry');
  const networkIndex=buildNetworkIndex(networkEdges);
  const segments=[]; let ordinal=0;
  for(let componentIndex=0;componentIndex<parts.length;componentIndex++) {
    const coords=parts[componentIndex],labels=coords.map((point)=>classifyPoint(point,networkIndex,{maxSnapMeters,ambiguityMarginMeters}));
    const runs=runsFor(coords,labels,shortRoadCrossingMeters,maxTransitionGapMeters);
    for(const run of runs) {
      const geometry=runGeometry(coords,run), className=run.classification;
      const segment_id=`seg-${createHash(JSON.stringify([observation.observation_id,componentIndex,run.start,run.end,className,pipelineVersion])).slice(0,24)}`;
      const candidateEligible=['PROBABLE_OFFROAD','OFFROAD_CONFIRMED'].includes(className)&&!(run.start===run.end&&(run.gap_before||run.gap_after));
      const jurisdiction_relations=assignJurisdictions(geometry,jurisdictions);
      segments.push({segment_id,observation_id:observation.observation_id,ordinal:ordinal++,component_index:componentIndex,
        vertex_start:run.start,vertex_end:run.end,classification:className,confidence:className==='UNKNOWN'?null:0.8,
        geometry,evidence:[...run.evidence,{rule:'transition-boundaries',method:'midpoint-for-short-adjacent-class-changes; long gaps retained as UNKNOWN'}],pipeline_version:pipelineVersion,candidate_eligible:candidateEligible,
        jurisdiction_ids:jurisdiction_relations.map((relation)=>relation.jurisdiction_id),jurisdiction_relations,
        segment_language:observation.source_language??null});
    }
  }
  return {observation_id:observation.observation_id,source_geometry:observation.geometry,segments,
    candidates:segments.filter((segment)=>segment.candidate_eligible)};
}
