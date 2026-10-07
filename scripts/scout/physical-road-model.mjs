import crypto from 'node:crypto';

const PAVED=new Set(['paved','asphalt','concrete','concrete:plates','paving_stones','sett','cobblestone','metal','wood']);
const GRAVEL=new Set(['gravel','fine_gravel','compacted','pebblestone']);
const UNSEALED=new Set(['unpaved','ground','dirt','earth','mud','sand','grass','snow','ice','woodchips']);
const ORDINARY_HIGHWAY=new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','unclassified','residential','living_street','road']);
const label=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase();

/** NVDB typeVeg is a network-object class, not an access or surface verdict. */
export function classifyNvdbNetworkRole(typeVeg){
  const type=label(typeVeg);
  if(type==='enkel bilveg')return 'ORDINARY_ROAD';
  if(type==='traktorveg')return 'ENGINEERED_ROAD_RESEARCH_CONTEXT';
  if(/^(gang- og sykkelveg|fortau|gangveg|sti|sykkelveg|gågate)$/.test(type))return 'NON_MOTOR_NETWORK_CONTEXT';
  return 'UNCLASSIFIED_NETWORK_CONTEXT';
}

/** Physical/network description only. It never makes an access or product decision. */
export function classifyPhysicalRoad(tags={},source='OSM'){
  const highway=label(tags.highway),surface=label(tags.surface),tracktype=label(tags.tracktype),typeVeg=label(tags['nvdb:type_veg']);
  const nvdbRole=source==='NVDB'?classifyNvdbNetworkRole(typeVeg):null;
  const ordinary=source==='NVDB'?nvdbRole==='ORDINARY_ROAD':ORDINARY_HIGHWAY.has(highway);
  let physical_character='ENGINEERED_ROAD_UNKNOWN_SURFACE';
  if(PAVED.has(surface))physical_character='PAVED_ROAD';
  else if(GRAVEL.has(surface)||/^grade[12]$/.test(tracktype))physical_character='GRAVEL_ROAD';
  else if(UNSEALED.has(surface)||/^grade[3-5]$/.test(tracktype))physical_character='UNSEALED_ROAD';
  else if(source==='NVDB'&&nvdbRole==='NON_MOTOR_NETWORK_CONTEXT')physical_character='NON_MOTOR_NETWORK_FEATURE';
  else if(source==='NVDB'&&typeVeg==='traktorveg')physical_character='OTHER_ENGINEERED_ROAD';
  else if(source==='NVDB'&&/skogsbilveg|skogveg|fjellveg|terrengveg|kjerreveg/.test(typeVeg))physical_character='ENGINEERED_ROAD_UNKNOWN_SURFACE';
  else if(/fjell|mountain road/.test(typeVeg))physical_character='MOUNTAIN_ROAD';
  else if(highway==='track')physical_character='OTHER_ENGINEERED_ROAD';
  else if(['path','footway','bridleway','cycleway'].includes(highway))physical_character='NON_CAR_PATH';
  const network_role=source==='NVDB'?nvdbRole:(ordinary?'ORDINARY_ROAD':'POTENTIAL_SPECIAL_ROUTE');
  return {source,physical_character,network_role,
    ordinary_navigation:ordinary,access:'UNKNOWN',routability:'UNKNOWN',
    product_projection:source==='NVDB'&&network_role!=='ORDINARY_ROAD'?'NOT_PROJECTED':undefined,
    basis:source==='NVDB'?['NVDB:typeVeg/network geometry only; Phase 1 road-link snapshot has no populated surface/access attributes']:
      ['OSM highway/surface/tracktype physical tags; tags do not establish legal access']};
}

const lines=geometry=>geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:[];
const pointDistance=(a,b)=>{const lat=(a[1]+b[1])*Math.PI/360,x=(a[0]-b[0])*111320*Math.cos(lat),y=(a[1]-b[1])*110574;return Math.hypot(x,y);};
const geometryEnds=g=>lines(g).filter(x=>x.length>1).flatMap(x=>[x[0],x.at(-1)]);
const nameKeys=tags=>[tags.ref,tags.name,tags['nvdb:road_reference'],tags['nvdb:road_name'],tags['nvdb:vegnummer']].map(label).filter(Boolean);
const matchesIdentity=(a,b)=>{const ak=new Set(nameKeys(a));return nameKeys(b).some(x=>ak.has(x));};
function segments(line){return line.slice(1).map((b,i)=>({a:line[i],b,index:i}));}
function local(point,origin){const lat=(point[1]+origin[1])*Math.PI/360;return [(point[0]-origin[0])*111320*Math.cos(lat),(point[1]-origin[1])*110574];}
function project(point,segment){const p=local(point,point),a=local(segment.a,point),b=local(segment.b,point),dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)):0;return {distance:Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy),t};}
function directedAlignment(a,b,maxDistance){
  const targetSegments=segments(b),sourceSegments=segments(a);if(!targetSegments.length||!sourceSegments.length)return null;
  const targetLengths=targetSegments.map(s=>pointDistance(s.a,s.b)),targetOffsets=[];let targetLength=0;
  for(const length of targetLengths){targetOffsets.push(targetLength);targetLength+=length;}
  const sourceLength=sourceSegments.reduce((n,s)=>n+pointDistance(s.a,s.b),0),count=Math.max(2,Math.min(500,Math.ceil(sourceLength/20))),distances=[],progress=[],headings=[];
  let walked=0,si=0;const sourceLengths=sourceSegments.map(s=>pointDistance(s.a,s.b));
  for(let k=0;k<count;k++){
    const at=sourceLength*(k+.5)/count;while(si<sourceSegments.length-1&&walked+sourceLengths[si]<at){walked+=sourceLengths[si++];}
    const seg=sourceSegments[si],len=sourceLengths[si]||1,t=Math.max(0,Math.min(1,(at-walked)/len)),point=[seg.a[0]+(seg.b[0]-seg.a[0])*t,seg.a[1]+(seg.b[1]-seg.a[1])*t];
    let best={distance:Infinity,progress:0,angle:180};
    for(let j=0;j<targetSegments.length;j++){
      const target=targetSegments[j],hit=project(point,target);if(hit.distance>=best.distance)continue;
      const ah=Math.atan2((seg.b[0]-seg.a[0])*Math.cos(point[1]*Math.PI/180),seg.b[1]-seg.a[1]),bh=Math.atan2((target.b[0]-target.a[0])*Math.cos(point[1]*Math.PI/180),target.b[1]-target.a[1]);
      let angle=Math.abs(ah-bh)*180/Math.PI;angle=Math.min(angle%180,180-angle%180);
      let along=targetOffsets[j]+hit.t*targetLengths[j];
      best={distance:hit.distance,progress:along,angle};
    }
    distances.push(best.distance);progress.push(best.progress);headings.push(best.angle);
  }
  const supported=distances.filter(x=>x<=maxDistance).length,monotonic=(xs)=>{let violations=0;for(let i=1;i<xs.length;i++)if(xs[i]+10<xs[i-1])violations++;return violations<=Math.max(1,Math.floor(xs.length*.02));};
  return {coverage:supported/count,p50:[...distances].sort((x,y)=>x-y)[Math.floor((distances.length-1)*.5)],
    p95:[...distances].sort((x,y)=>x-y)[Math.floor((distances.length-1)*.95)],max_distance:Math.max(...distances),
    heading_p95:[...headings].sort((x,y)=>x-y)[Math.floor((headings.length-1)*.95)],ordered:monotonic(progress)||monotonic([...progress].reverse()),
    sample_count:count};
}

/** Conservative network identity relationship. Caller supplies all spatially nearby competitors. */
export function comparePhysicalNetworkEdges(left,right,{competitors=[],leftNodeDegree={},rightNodeDegree={},maxDistanceM=8}={}){
  const al=lines(left?.geometry),bl=lines(right?.geometry);if(al.length!==1||bl.length!==1)return {relationship:'AMBIGUOUS_IDENTITY',reason:'multipart correspondence is not resolved'};
  const a=al[0],b=bl[0];const forward=directedAlignment(a,b,maxDistanceM),reverse=directedAlignment([...a].reverse(),b,maxDistanceM),ab=!reverse||forward.coverage>=reverse.coverage?forward:reverse;
  const baForward=directedAlignment(b,a,maxDistanceM),baReverse=directedAlignment([...b].reverse(),a,maxDistanceM),ba=!baReverse||baForward.coverage>=baReverse.coverage?baForward:baReverse;
  if(!ab||!ba||!ab.ordered||!ba.ordered||ab.heading_p95>20||ba.heading_p95>20)return {relationship:'NO_RELATION',reason:'ordered direction-compatible coverage is insufficient'};
  const endsA=geometryEnds(left.geometry),endsB=geometryEnds(right.geometry),endpoint=endsA.length===2&&endsB.length===2?Math.min(Math.max(pointDistance(endsA[0],endsB[0]),pointDistance(endsA[1],endsB[1])),Math.max(pointDistance(endsA[0],endsB[1]),pointDistance(endsA[1],endsB[0]))):Infinity;
  const identity=matchesIdentity(left.tags??{},right.tags??{});
  const leftNodes=[left.start_node,left.end_node].filter(Boolean),rightNodes=[right.start_node,right.end_node].filter(Boolean);
  const sharedNodes=leftNodes.filter(node=>rightNodes.includes(node));
  const topology=sharedNodes.length>0;
  const junctionSupport=sharedNodes.some(node=>leftNodeDegree[node]!=null&&leftNodeDegree[node]===rightNodeDegree[node]);
  const competitor=competitors.some(other=>{if(other.edge_id===right.edge_id)return false;const otherLines=lines(other.geometry);if(otherLines.length!==1)return false;
    const score=directedAlignment(a,otherLines[0],maxDistanceM);
    // A second similarly supported edge means geometric correspondence cannot
    // safely choose one alignment, including a nearby parallel road/track.
    return score&&score.coverage>=Math.min(ab.coverage,.8)&&Math.abs(score.p95-ab.p95)<=5;
  });
  let relationship='NO_RELATION',reason='geometry/topology does not support a physical identity';
  if(competitor){relationship='AMBIGUOUS_IDENTITY';reason='a competing parallel/crossing candidate has indistinguishable ordered support';}
  else if(identity&&ab.coverage>=.98&&ba.coverage>=.98&&ab.p95<=2&&ba.p95<=2&&endpoint<=5){relationship='EXACT_CORRIDOR_SUPPORT';reason='matching route identity, reciprocal ordered geometry and endpoint continuity';}
  else if((identity||junctionSupport)&&ab.coverage>=.85&&ba.coverage>=.85&&ab.p95<=maxDistanceM&&ba.p95<=maxDistanceM&&endpoint<=20){relationship='STRONG_CORRIDOR_SUPPORT';reason='reciprocal ordered geometry plus independent identity/topology context';}
  else if(ab.coverage>=.2||ba.coverage>=.2){relationship=topology?'PARTIAL_CORRIDOR_SUPPORT':'AMBIGUOUS_IDENTITY';reason=topology?'source-topology anchored partial ordered geometry':'geometric overlap lacks independent topology/route identity';}
  return {relationship,reason,coverage_left:Number(ab.coverage.toFixed(4)),coverage_right:Number(ba.coverage.toFixed(4)),p95_left_m:Number(ab.p95.toFixed(2)),p95_right_m:Number(ba.p95.toFixed(2)),endpoint_gap_m:Number(endpoint.toFixed(2)),route_identity_match:identity,shared_node:topology,junction_support:Boolean(junctionSupport),proximity_is_sufficient:false};
}

/**
 * Form derived NVDB sequence hypotheses from explicit sequence positions and
 * port-node identity. Original links remain untouched observations. A geometric
 * endpoint check is a corruption/consistency guard; it cannot create a link.
 */
export function buildNvdbSequenceCorridors(edges,{endpointGuardM=3}={}){
  const bySequence=new Map();
  for(const edge of edges){
    const topology=edge.evidence?.[0]?.topology??{};
    if(!topology.sequence_id||!Number.isFinite(topology.start_position)||!Number.isFinite(topology.end_position))continue;
    const rows=bySequence.get(topology.sequence_id)??[];rows.push({edge,topology});bySequence.set(topology.sequence_id,rows);
  }
  const result=[];
  for(const [sequenceId,rows] of bySequence){
    const outgoing=new Map(),incoming=new Map(),startsAt=new Map(),conflicted=new Set();
    for(const row of rows){const key=`${row.topology.start_position}\0${row.topology.start_node??''}`,list=startsAt.get(key)??[];list.push(row);startsAt.set(key,list);}
    for(const from of rows){
      if(!from.topology.end_node)continue;
      const continuations=startsAt.get(`${from.topology.end_position}\0${from.topology.end_node}`)??[];
      for(const to of continuations){
      if(from===to)continue;
      const a=geometryEnds(from.edge.geometry),b=geometryEnds(to.edge.geometry);if(a.length!==2||b.length!==2)continue;
      const gap=pointDistance(a[1],b[0]);if(gap>endpointGuardM){conflicted.add(from);conflicted.add(to);continue;}
      outgoing.set(from,(outgoing.get(from)??[]).concat([{to,gap}]));incoming.set(to,(incoming.get(to)??[]).concat([from]));
      }
    }
    const visited=new Set();
    const emit=(members,ambiguous=false)=>{
      const first=members[0],last=members.at(-1),identity=members.map(x=>`${x.topology.link_number}:${x.topology.segment_number}`).join(',');
      result.push({source_sequence_id:sequenceId,member_edge_ids:members.map(x=>x.edge.edge_id),
        corridor_id:`nvdb-corridor-${crypto.createHash('sha256').update(`${sequenceId}\0${identity}`).digest('hex').slice(0,24)}`,
        identity_state:ambiguous?'AMBIGUOUS_IDENTITY':'TOPOLOGY_BACKED',physical_character:'MULTI_LINK_NETWORK_SEQUENCE',
        geometry:{type:'MultiLineString',coordinates:members.flatMap(x=>lines(x.edge.geometry))},
        start_node:first.topology.start_node,end_node:last.topology.end_node,
        support:{identity:'veglenkesekvensid + ordered start/sluttposisjon + matching NVDB port node IDs',
          endpoint_guard_m:endpointGuardM,maximum_observed_endpoint_gap_m:Math.max(0,...members.slice(1).map((x,i)=>pointDistance(geometryEnds(members[i].edge.geometry)[1],geometryEnds(x.edge.geometry)[0]))),
          geometry_was_merged:false,legal_access:'UNKNOWN',routability:'UNKNOWN'}});
    };
    const starts=rows.filter(row=>(incoming.get(row)??[]).length!==1).sort((a,b)=>a.topology.start_position-b.topology.start_position||a.topology.link_number-b.topology.link_number);
    for(const start of starts){
      if(visited.has(start))continue;const members=[start];visited.add(start);let current=start,ambiguous=(incoming.get(start)??[]).length>1||conflicted.has(start);
      while(true){const next=outgoing.get(current)??[];if(next.length!==1){ambiguous||=next.length>1;break;}
        const target=next[0].to;if((incoming.get(target)??[]).length!==1){ambiguous=true;break;}
        if(visited.has(target)){ambiguous=true;break;}members.push(target);visited.add(target);current=target;
      }
      emit(members,ambiguous);
    }
    for(const row of rows)if(!visited.has(row))emit([row],true);
  }
  return result;
}
