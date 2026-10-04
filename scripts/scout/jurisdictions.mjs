// Jurisdiction assignment is spatial attribution only. It never interprets
// access law; evidence remains attached to each jurisdiction and its dates.
const rad=(v)=>v*Math.PI/180;
function unwrapLon(lon, around) { let value=lon; while(value-around>180)value-=360; while(value-around< -180)value+=360; return value; }
function onRing(point, ring) {
  const x=point[0],y=point[1]; let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const xi=unwrapLon(ring[i][0],x),xj=unwrapLon(ring[j][0],x),yi=ring[i][1],yj=ring[j][1];
    const crosses=((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi);
    if(crosses) inside=!inside;
  }
  return inside;
}
function polygonContains(point, polygon) { return polygon.length>0&&onRing(point,polygon[0])&&!polygon.slice(1).some((hole)=>onRing(point,hole)); }
export function jurisdictionContains(point, boundary) {
  if(!Array.isArray(point)||point.length<2||!Number.isFinite(point[0])||!Number.isFinite(point[1]))return false;
  const polygons=boundary?.type==='Polygon'?[boundary.coordinates]:boundary?.type==='MultiPolygon'?boundary.coordinates:[];
  return polygons.some((polygon)=>polygonContains(point,polygon));
}
function meters(a,b) { const lat=rad((a[1]+b[1])/2);return Math.hypot((unwrapLon(b[0],a[0])-a[0])*111320*Math.cos(lat),(b[1]-a[1])*110574); }
function interpolate(a,b,t) { const lon=unwrapLon(b[0],a[0]);return [((a[0]+(lon-a[0])*t+540)%360)-180,a[1]+(b[1]-a[1])*t]; }
function lines(geometry) { return geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:[]; }

export function assignJurisdictions(geometry, jurisdictions, { maxSampleMeters=500 }={}) {
  if(!Number.isFinite(maxSampleMeters)||maxSampleMeters<=0)throw new Error('maxSampleMeters must be positive');
  if(!Array.isArray(jurisdictions))throw new Error('jurisdictions must be an explicit versioned list');
  const totals=new Map(); let allLength=0;
  for(const line of lines(geometry)) {
    if(!Array.isArray(line)||line.length<2)continue;
    for(let i=1;i<line.length;i++) {
      const a=line[i-1],b=line[i],length=meters(a,b),steps=Math.max(1,Math.ceil(length/maxSampleMeters)); allLength+=length;
      for(let s=0;s<steps;s++) {
        const p=interpolate(a,b,(s+0.5)/steps), weight=length/steps;
        for(const j of jurisdictions) if(jurisdictionContains(p,j.boundary)) totals.set(j.jurisdiction_id,(totals.get(j.jurisdiction_id)??0)+weight);
      }
    }
  }
  return [...totals].sort(([a],[b])=>a.localeCompare(b)).map(([jurisdiction_id,length_m])=>{
    const j=jurisdictions.find((item)=>item.jurisdiction_id===jurisdiction_id);
    return {jurisdiction_id,country_code:j.country_code,admin1_code:j.admin1_code??null,admin2_code:j.admin2_code??null,
      boundary_version:j.version,relation:'INTERSECTS',coverage:allLength?Math.min(1,length_m/allLength):0,certainty:'BOUNDARY_DATA_MATCH'};
  });
}

export function segmentLegalScope(segment, jurisdictionRelations) {
  // A cross-border corridor retains one physical segment/candidate ID. This
  // helper only gives evidence consumers explicit jurisdiction scopes.
  return { segment_id:segment.segment_id, physical_identity:segment.segment_id,
    legal_scopes:jurisdictionRelations.map((relation)=>({jurisdiction_id:relation.jurisdiction_id,
      country_code:relation.country_code,admin1_code:relation.admin1_code,legal_state:'UNKNOWN'})) };
}
