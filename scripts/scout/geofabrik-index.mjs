// Resolve an owner-selected ISO country to Geofabrik's official extract. The
// mutable "latest" URL is metadata-only: processing is pinned to a dated URL.
const INDEX_URL='https://download.geofabrik.de/index-v1-nogeom.json';
const BASE=new URL(INDEX_URL).origin;
const fail=(message)=>{const error=new Error(message);error.code='SCOUT_REVIEW_REQUIRED';throw error;};
async function checkedFetch(fetchImpl,url,init){
  let response;try{response=await fetchImpl(url,init);}catch{fail('Geofabrik metadata could not be reached; retry later or review provider availability.');}
  if(!response||!response.ok)fail(`Geofabrik metadata request failed (HTTP ${response?.status??'unknown'}).`);
  const final=new URL(response.url||url);if(final.origin!==BASE)fail('Geofabrik redirected outside the approved provider origin.');
  return response;
}
async function readIndex(response){
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>8*1024*1024)fail('Geofabrik country index exceeds the configured 8 MB metadata limit.');
  const body=await response.text();if(Buffer.byteLength(body)>8*1024*1024)fail('Geofabrik country index exceeds the configured 8 MB metadata limit.');
  try{return JSON.parse(body);}catch{fail('Geofabrik country index is not valid JSON; provider needs review.');}
}
function parseDate(value){const time=Date.parse(value??'');if(!Number.isFinite(time))fail('Geofabrik did not provide a valid last-modified date; no extract version was pinned.');return new Date(time);}
export async function resolveGeofabrikCountry({countryCode,regionName,fetchImpl=fetch}={}){
  if(!/^[A-Za-z]{2}$/.test(countryCode??''))fail('Country must be an ISO alpha-2 code.');
  const code=countryCode.toUpperCase(),indexResponse=await checkedFetch(fetchImpl,INDEX_URL,{redirect:'error'});
  const index=await readIndex(indexResponse);if(index?.type!=='FeatureCollection'||!Array.isArray(index.features))fail('Geofabrik index format is unsupported; provider needs review.');
  const matching=index.features.filter(f=>Array.isArray(f.properties?.['iso3166-1:alpha2'])&&f.properties['iso3166-1:alpha2'].includes(code));
  if(matching.length!==1)fail(matching.length?'Country maps to multiple Geofabrik extracts; choose an explicit supported region.':`No Geofabrik country extract is registered for ${code}.`);
  const feature=matching[0],properties=feature.properties,name=String(properties.name??'').trim();
  if(!name||String(regionName??'').trim().toLocaleLowerCase()!==name.toLocaleLowerCase())fail(`Region name does not uniquely confirm Geofabrik country '${name}'.`);
  const latestText=properties.urls?.pbf;if(typeof latestText!=='string')fail('Geofabrik index has no public PBF for this country.');
  const latest=new URL(latestText);if(latest.origin!==BASE||!latest.pathname.endsWith('-latest.osm.pbf'))fail('Geofabrik index returned an unsupported extract URL.');
  const latestResponse=await checkedFetch(fetchImpl,latest.href,{method:'HEAD',redirect:'error'});
  const modified=parseDate(latestResponse.headers.get('last-modified'));
  const year=modified.getUTCFullYear(),date=`${year}-${String(modified.getUTCMonth()+1).padStart(2,'0')}-${String(modified.getUTCDate()).padStart(2,'0')}`;
  const dated=`${String(year).slice(-2)}${date.slice(5,7)}${date.slice(8,10)}`;
  const versionedPath=latest.pathname.replace(/-latest\.osm\.pbf$/i,`-${dated}.osm.pbf`),versioned=new URL(versionedPath,BASE);
  const exactResponse=await checkedFetch(fetchImpl,versioned.href,{method:'HEAD',redirect:'error'});
  const latestBytes=Number(latestResponse.headers.get('content-length')),exactBytes=Number(exactResponse.headers.get('content-length'));
  if(!(latestBytes>0&&exactBytes>0&&latestBytes===exactBytes))fail('Geofabrik dated extract could not be verified against its current country extract; no snapshot was selected.');
  const snapshotId=`geofabrik-${code.toLowerCase()}-${date.replaceAll('-','')}`;
  return {provider:'geofabrik',provider_index_url:INDEX_URL,provider_region_id:properties.id,region_name:name,country_code:code,
    version:date,snapshot_id:snapshotId,url:versioned.href,latest_metadata_url:latest.href,
    byte_size:exactBytes,last_modified:exactResponse.headers.get('last-modified'),
    licence:{name:'Open Data Commons Open Database License',version:'1.0',url:'https://opendatacommons.org/licenses/odbl/1-0/'},
    attribution:'© OpenStreetMap contributors',attribution_url:'https://www.openstreetmap.org/copyright',
    coverage:{countries:[code],regions:[properties.id]}};
}

export function derivePrivateViewport(bounds,{fraction=0.1,minimumDegrees=0.02}={}){
  if(!Array.isArray(bounds)||bounds.length!==4||bounds.some(n=>!Number.isFinite(n)))fail('Selected route has no safe finite geographic bounds.');
  let [west,south,east,north]=bounds;if(south>north||south < -90||north>90||west < -180||west>180||east < -180||east>180)fail('Selected route bounds are invalid.');
  const wrapped=west>east,longitudeWidth=wrapped?(180-west)+(east+180):east-west,latHeight=north-south;
  const latPad=Math.max(minimumDegrees/2,latHeight*fraction),midLat=(south+north)/2;
  const lonPad=Math.max(minimumDegrees/2,longitudeWidth*fraction)/Math.max(0.1,Math.cos(midLat*Math.PI/180));
  south=Math.max(-90,south-latPad);north=Math.min(90,north+latPad);
  if(wrapped){west=west-lonPad;east=east+lonPad;if(west < -180)west+=360;if(east>180)east-=360;}
  else{west=Math.max(-180,west-lonPad);east=Math.min(180,east+lonPad);}
  return [Number(west.toFixed(6)),Number(south.toFixed(6)),Number(east.toFixed(6)),Number(north.toFixed(6))];
}
