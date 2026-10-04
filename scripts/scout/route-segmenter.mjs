import crypto from 'node:crypto';
import { assignJurisdictions } from './jurisdictions.mjs';

// Interval matcher v2 preserves uncertain boundary intervals rather than
// labelling a whole sparse GPX chord UNKNOWN. It never changes source geometry.
export const SEGMENTATION_VERSION = 'network-segmenter-2';
export const SEGMENT_CLASSES = Object.freeze(['ROAD','UNSEALED_ROAD','PROBABLE_OFFROAD','OFFROAD_CONFIRMED','UNKNOWN']);
export class ScoutYieldRequested extends Error {
  constructor() { super('shared factory admission requested Scout yield'); this.name='ScoutYieldRequested'; this.code='SCOUT_YIELD_REQUESTED'; }
}
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
export function lengthMeters(a,b) { const lat=rad((a[1]+b[1])/2);let dlon=b[0]-a[0];while(dlon>180)dlon-=360;while(dlon< -180)dlon+=360;return Math.hypot(dlon*111320*Math.cos(lat),(b[1]-a[1])*110574); }
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
function buildNetworkIndex(edges, shouldYield=()=>false) {
  const grid=new Map(),longSegments=[];
  let visited=0;
  for(const edge of edges) {
    if((visited++&255)===0&&shouldYield())throw new ScoutYieldRequested();
    const classification=edgeClass(edge);
    for(const [partIndex,part] of lineParts(edge.geometry).entries())if(validLine(part))for(let i=1;i<part.length;i++) {
      const segment={edge,classification,partIndex,edge_part_id:`${edge.edge_id}#part:${partIndex}`,a:part[i-1],b:part[i]};
      const x0=Math.floor(Math.min(segment.a[0],segment.b[0])/NETWORK_CELL_DEGREES),x1=Math.floor(Math.max(segment.a[0],segment.b[0])/NETWORK_CELL_DEGREES);
      const y0=Math.floor(Math.min(segment.a[1],segment.b[1])/NETWORK_CELL_DEGREES),y1=Math.floor(Math.max(segment.a[1],segment.b[1])/NETWORK_CELL_DEGREES);
      if((x1-x0+1)*(y1-y0+1)>1000){longSegments.push(segment);continue;}
      for(let x=x0-1;x<=x1+1;x++)for(let y=y0-1;y<=y1+1;y++){const key=`${x}:${y}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(segment);}
    }
  }
  return {grid,longSegments};
}
function nearbySegments(point,index) {
  const cx=Math.floor(point[0]/NETWORK_CELL_DEGREES),cy=Math.floor(point[1]/NETWORK_CELL_DEGREES),segments=new Set(index.longSegments);
  for(let x=cx-1;x<=cx+1;x++)for(let y=cy-1;y<=cy+1;y++)for(const segment of index.grid.get(`${x}:${y}`)??[])segments.add(segment);
  return segments;
}

function classifyInterval(a,b,index,{maxSnapMeters,ambiguityMarginMeters}) {
  const length=lengthMeters(a,b),half=length/2,mid=[(a[0]+b[0])/2,(a[1]+b[1])/2],nearby=new Map();
  for(const segment of nearbySegments(mid,index)) {
    const d=distancePointSegmentMeters(mid,segment.a,segment.b);
    if(d>maxSnapMeters+half+ambiguityMarginMeters)continue;
    const old=nearby.get(segment.edge_part_id);
    if(!old||d<old.distance_m)nearby.set(segment.edge_part_id,{edge_id:segment.edge.edge_id,edge_part_id:segment.edge_part_id,classification:segment.classification,distance_m:d,edge:segment.edge});
  }
  const possible=[...nearby.values()].filter((x)=>x.distance_m-half<=maxSnapMeters+ambiguityMarginMeters).sort((x,y)=>x.distance_m-y.distance_m||x.edge_id.localeCompare(y.edge_id));
  const supported=possible.filter((x)=>x.distance_m+half+ambiguityMarginMeters<=maxSnapMeters);
  const supportClasses=new Set(supported.map((x)=>x.classification));
  if(supportClasses.size===1) {
    const classification=[...supportClasses][0];
    const competitors=possible.filter((x)=>x.classification!==classification);
    if(competitors.length) return {classification:'UNKNOWN',reason:'competing_network_classes',evidence:{rule:'interval-network-ambiguity',reason:'competing_network_classes',edge_ids:[...new Set([...supported,...competitors].map((x)=>x.edge_id))].sort(),edge_part_ids:[...new Set([...supported,...competitors].map((x)=>x.edge_part_id))].sort(),distances_m:[...supported,...competitors].slice(0,6).map((x)=>Number(x.distance_m.toFixed(2))),interval_m:Number(length.toFixed(2)),snap_m:maxSnapMeters}};
    const best=supported[0],upper=best.distance_m+half+ambiguityMarginMeters,clearance=Math.max(0,maxSnapMeters-upper);
    return {classification,reason:null,confidence:maxSnapMeters?clearance/maxSnapMeters:0,evidence:{rule:'interval-network-support',edge_id:best.edge_id,edge_part_id:best.edge_part_id,network_class:classification,
      midpoint_distance_m:Number(best.distance_m.toFixed(2)),maximum_distance_bound_m:Number(upper.toFixed(2)),snap_m:maxSnapMeters,clearance_m:Number(clearance.toFixed(2))}};
  }
  if(supportClasses.size>1)return {classification:'UNKNOWN',reason:'competing_network_classes',evidence:{rule:'interval-network-ambiguity',reason:'competing_network_classes',edge_ids:supported.map((x)=>x.edge_id).sort(),edge_part_ids:supported.map((x)=>x.edge_part_id).sort(),distances_m:supported.slice(0,6).map((x)=>Number(x.distance_m.toFixed(2))),interval_m:Number(length.toFixed(2)),snap_m:maxSnapMeters}};
  if(possible.length) {
    const classes=new Set(possible.map((x)=>x.classification));
    if(classes.size>1)return {classification:'UNKNOWN',reason:'competing_network_classes',evidence:{rule:'interval-network-ambiguity',reason:'competing_network_classes',edge_ids:possible.slice(0,8).map((x)=>x.edge_id).sort(),edge_part_ids:possible.slice(0,8).map((x)=>x.edge_part_id).sort(),distances_m:possible.slice(0,6).map((x)=>Number(x.distance_m.toFixed(2))),interval_m:Number(length.toFixed(2)),snap_m:maxSnapMeters}};
    if(classes.has('UNKNOWN'))return {classification:'UNKNOWN',reason:'network_tags_insufficient',evidence:{rule:'interval-network-ambiguity',reason:'network_tags_insufficient',edge_ids:possible.map((x)=>x.edge_id).sort(),edge_part_ids:possible.map((x)=>x.edge_part_id).sort(),distances_m:possible.slice(0,6).map((x)=>Number(x.distance_m.toFixed(2))),interval_m:Number(length.toFixed(2)),snap_m:maxSnapMeters}};
    return {classification:'UNKNOWN',reason:'interval_support_uncertain',evidence:{rule:'interval-network-ambiguity',reason:'interval_support_uncertain',edge_ids:possible.map((x)=>x.edge_id).sort(),edge_part_ids:possible.map((x)=>x.edge_part_id).sort(),distances_m:possible.slice(0,6).map((x)=>Number(x.distance_m.toFixed(2))),interval_m:Number(length.toFixed(2)),snap_m:maxSnapMeters}};
  }
  return {classification:'UNKNOWN',reason:'no_network_match',evidence:{rule:'no-network-match-within-threshold',threshold_m:maxSnapMeters,interval_m:Number(length.toFixed(2))}};
}

function interpolate(a,b,t) { const n=Math.min(a.length,b.length),lon=(()=>{let v=b[0];while(v-a[0]>180)v-=360;while(v-a[0]<-180)v+=360;return v;})();return Array.from({length:n},(_,i)=>i===0?((a[0]+(lon-a[0])*t+540)%360)-180:a[i]+(b[i]-a[i])*t); }
const createHash=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const evidenceKey=(e)=>`${e.reason??e.network_class}:${(e.edge_part_ids??e.edge_ids??[e.edge_part_id??e.edge_id??'']).join(',')}`;
function compactEvidence(intervals) {
  const output=[];
  for(const interval of intervals) {
    const e={...interval.evidence,chainage_start_m:Number(interval.chainage_start_m.toFixed(2)),chainage_end_m:Number(interval.chainage_end_m.toFixed(2)),
      source_leg_start:interval.source_leg_index,source_leg_end:interval.source_leg_index,fraction_start:Number(interval.fraction_start.toFixed(6)),fraction_end:Number(interval.fraction_end.toFixed(6))};
    const prev=output.at(-1);
    if(prev&&prev.rule===e.rule&&evidenceKey(prev)===evidenceKey(e)&&Math.abs(prev.chainage_end_m-e.chainage_start_m)<0.02) {
      prev.chainage_end_m=e.chainage_end_m;prev.source_leg_end=e.source_leg_end;prev.fraction_end=e.fraction_end;
      if(e.maximum_distance_bound_m!=null)prev.maximum_distance_bound_m=Math.max(prev.maximum_distance_bound_m??0,e.maximum_distance_bound_m);
      if(e.clearance_m!=null)prev.clearance_m=Math.min(prev.clearance_m??1,e.clearance_m);
      if(e.interval_m!=null)prev.interval_count=(prev.interval_count??1)+1;
      continue;
    }
    if(e.interval_m!=null)e.interval_count=1;
    output.push(e);
  }
  return output;
}

function buildRuns(intervals) {
  const runs=[];
  for(const interval of intervals) {
    const key=interval.classification==='UNKNOWN'?`${interval.classification}:${interval.reason}`:interval.classification;
    let run=runs.at(-1);
    if(!run||run.key!==key) {
      run={key,classification:interval.classification,reason:interval.reason,start:interval.start,end:interval.end,coordinates:[interval.start,interval.end],intervals:[interval],length_m:interval.length_m,
        confidence:interval.confidence??null,edge_ids:new Set(interval.evidence.edge_id?[interval.evidence.edge_id]:[])};
      runs.push(run);
    } else {
      run.end=interval.end;run.coordinates.push(interval.end);run.intervals.push(interval);run.length_m+=interval.length_m;
      if(interval.confidence!=null)run.confidence=run.confidence==null?interval.confidence:Math.min(run.confidence,interval.confidence);
      if(interval.evidence.edge_id)run.edge_ids.add(interval.evidence.edge_id);
    }
  }
  return runs;
}

export function segmentRouteObservation(observation, networkEdges, {
  maxSnapMeters=8, ambiguityMarginMeters=0.25, initialSampleSpacingMeters=10, minimumAmbiguityResolutionMeters=1.5,
  maxDerivedIntervals=500000, pipelineVersion=SEGMENTATION_VERSION, jurisdictions=[], shouldYield=()=>false
}={}) {
  if(!observation?.observation_id) throw new Error('route observation requires stable observation_id');
  if(!Array.isArray(networkEdges)) throw new Error('networkEdges must be an explicit array');
  const settings={maxSnapMeters,ambiguityMarginMeters,initialSampleSpacingMeters,minimumAmbiguityResolutionMeters,maxDerivedIntervals};
  for(const [key,value] of Object.entries(settings))if(!Number.isFinite(value)||value<0)throw new Error(`${key} must be finite and non-negative`);
  if(initialSampleSpacingMeters<=0||minimumAmbiguityResolutionMeters<=0||maxDerivedIntervals<1)throw new Error('sampling spacing and interval budget must be positive');
  const parts=lineParts(observation.geometry);
  if(!parts.length||parts.some((part)=>!validLine(part))) throw new Error('observation has no usable source line geometry');
  if(typeof shouldYield!=='function')throw new Error('shouldYield must be a function');
  const networkIndex=buildNetworkIndex(networkEdges,shouldYield),segments=[];let ordinal=0,totalIntervals=0;
  for(let componentIndex=0;componentIndex<parts.length;componentIndex++) {
    const coords=parts[componentIndex],intervals=[];let chainage=0;
    for(let legIndex=0;legIndex<coords.length-1;legIndex++) {
      const a=coords[legIndex],b=coords[legIndex+1],legLength=lengthMeters(a,b);if(legLength===0)continue;
      const count=Math.max(1,Math.ceil(legLength/initialSampleSpacingMeters));
      for(let cell=0;cell<count;cell++) {
        const recurse=(f0,f1,depth=0)=>{
          if(++totalIntervals>maxDerivedIntervals)throw new Error('route interval matching exceeded configured safety budget; defer or split at original component boundaries');
          if((totalIntervals&1023)===0&&shouldYield())throw new ScoutYieldRequested();
          const start=interpolate(a,b,f0),end=interpolate(a,b,f1),length=legLength*(f1-f0);
          const result=classifyInterval(start,end,networkIndex,{maxSnapMeters,ambiguityMarginMeters});
          if(result.classification==='UNKNOWN'&&['competing_network_classes','interval_support_uncertain'].includes(result.reason)&&length>minimumAmbiguityResolutionMeters&&depth<20) {
            const mid=(f0+f1)/2;recurse(f0,mid,depth+1);recurse(mid,f1,depth+1);return;
          }
          const interval={classification:result.classification,reason:result.reason,start,end,length_m:length,confidence:result.confidence??null,evidence:result.evidence,
            source_leg_index:legIndex,fraction_start:f0,fraction_end:f1,chainage_start_m:chainage+legLength*f0,chainage_end_m:chainage+legLength*f1};
          intervals.push(interval);
        };
        recurse(cell/count,(cell+1)/count);
      }
      chainage+=legLength;
    }
    const runs=buildRuns(intervals);
    for(let runIndex=0;runIndex<runs.length;runIndex++) {
      const run=runs[runIndex],geometry={type:'LineString',coordinates:run.coordinates};
      const segment_id=`seg-${createHash(JSON.stringify([observation.observation_id,componentIndex,runIndex,run.reason,run.coordinates[0],run.coordinates.at(-1),pipelineVersion])).slice(0,24)}`;
      const candidateEligible=['PROBABLE_OFFROAD','OFFROAD_CONFIRMED'].includes(run.classification);
      const jurisdiction_relations=assignJurisdictions(geometry,jurisdictions);
      segments.push({segment_id,observation_id:observation.observation_id,ordinal:ordinal++,component_index:componentIndex,classification:run.classification,
        confidence:run.confidence==null?null:Number(run.confidence.toFixed(3)),length_m:Number(run.length_m.toFixed(2)),chainage_start_m:Number(run.intervals[0].chainage_start_m.toFixed(2)),
        chainage_end_m:Number(run.intervals.at(-1).chainage_end_m.toFixed(2)),unknown_reason:run.reason,geometry,evidence:[...compactEvidence(run.intervals),
          {rule:'transition-boundaries',method:'certified subinterval endpoints along original GPX polyline; ambiguous intervals remain UNKNOWN',
            initial_spacing_m:initialSampleSpacingMeters,ambiguity_resolution_m:minimumAmbiguityResolutionMeters,snap_m:maxSnapMeters,ambiguity_margin_m:ambiguityMarginMeters}],
        pipeline_version:pipelineVersion,candidate_eligible:candidateEligible,jurisdiction_ids:jurisdiction_relations.map((x)=>x.jurisdiction_id),jurisdiction_relations,
        segment_language:observation.source_language??null});
    }
  }
  const candidates=segments.filter((segment)=>segment.candidate_eligible);
  return {observation_id:observation.observation_id,source_geometry:observation.geometry,segments,candidates,
    total_distance_m:Number(segments.reduce((s,x)=>s+x.length_m,0).toFixed(2)),interval_count:totalIntervals,
    continuity_hypotheses:buildContinuityHypotheses(segments)};
}

function buildContinuityHypotheses(segments) {
  const groups=[];
  for(const componentIndex of [...new Set(segments.map((s)=>s.component_index))]) {
    const component=segments.filter((s)=>s.component_index===componentIndex).sort((a,b)=>a.ordinal-b.ordinal);
    for(let i=0;i<component.length;i++) {
      const first=component[i];if(!first.candidate_eligible||first.classification!=='PROBABLE_OFFROAD')continue;
      let j=i+1;while(j<component.length&&component[j].classification==='UNKNOWN')j++;
      if(j>=component.length||component[j].classification!=='PROBABLE_OFFROAD')continue;
    const gap=component.slice(i+1,j),left=new Set(first.evidence.filter((e)=>e.rule==='interval-network-support').map((e)=>e.edge_part_id)),right=new Set(component[j].evidence.filter((e)=>e.rule==='interval-network-support').map((e)=>e.edge_part_id));
      const shared=[...left].filter((id)=>right.has(id)).sort();
      const supportedThroughGap=shared.filter((id)=>gap.length&&gap.every((s)=>s.evidence.filter((e)=>e.rule==='interval-network-ambiguity').length>0&&s.evidence.filter((e)=>e.rule==='interval-network-ambiguity').every((e)=>(e.edge_part_ids??[]).includes(id))));
      if(!supportedThroughGap.length)continue;
      groups.push({component_index:componentIndex, candidate_segment_ids:[first.segment_id,component[j].segment_id],connector_segment_ids:gap.map((s)=>s.segment_id),
        shared_network_edge_ids:supportedThroughGap,connector_length_m:Number(gap.reduce((n,s)=>n+s.length_m,0).toFixed(2)),
        hypothesis:'SAME_OSM_WAY_WITH_AMBIGUOUS_CONNECTOR',destructive_merge:false,geometry_gap_filled:false,
        evidence:{rule:'same-versioned-OSM-way-supports-both-candidate-runs-and-every-ambiguous-connector',
          connector_reasons:[...new Set(gap.map((s)=>s.unknown_reason))].sort()}});
    }
  }
  return groups;
}
