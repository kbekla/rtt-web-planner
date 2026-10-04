// Pinned, source-registry-driven regional network acquisition. Only explicitly
// registered provider URLs and private-use licences can be downloaded.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';

const GEOFABRIK_HOST='download.geofabrik.de';
export function resolveNetworkExtract(source,{allowChecksumCalculation=false}={}) {
  if(!source?.roles?.routing_network||source.reuse?.private_processing!==true)throw new Error('network source is not registered for private routing-network processing');
  const x=source.network_extract;
  const calculated=allowChecksumCalculation&&x?.checksum_policy==='calculate-after-download';
  if(!x||x.provider!=='geofabrik'||!x.url||!x.version||!x.snapshot_id||(!/^([a-f0-9]{64})$/i.test(x.sha256??'')&&!calculated))
    throw new Error('network source needs a pinned provider, version, snapshot ID and expected SHA-256');
  let url;try{url=new URL(x.url);}catch{throw new Error('network extract URL is invalid');}
  if(url.protocol!=='https:'||url.hostname!==GEOFABRIK_HOST||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('.osm.pbf')||/latest/i.test(url.pathname))
    throw new Error('Geofabrik extract must be a version-pinned HTTPS PBF on the registered provider host');
  if(!source.coverage.countries.includes(x.country_code)||!/^[A-Z]{2}$/.test(x.country_code??''))throw new Error('network extract country is outside registered source coverage');
  if(!source.licence?.name||!source.licence?.version||!source.attribution)throw new Error('network extract licence and attribution must be explicit');
  return {...x,url:url.href,sha256:x.sha256?.toLowerCase()??null,licence:{...source.licence,attribution:source.attribution},coverage:{countries:[x.country_code],regions:source.coverage.regions}};
}
const fileSha256=async(file)=>{const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');};
async function appendResponse(response,file,{start,progress,shouldYield}) {
  const flags=start?'a':'w',out=createWriteStream(file,{flags,mode:0o600});let bytes=start,yielded=false;
  try {
    for await(const chunk of Readable.fromWeb(response.body)){
      if(shouldYield()){yielded=true;break;}
      await new Promise((resolve,reject)=>out.write(chunk,error=>error?reject(error):resolve()));bytes+=chunk.length;
      if(await progress?.({bytes})) {yielded=true;break;}
    }
  } finally {await new Promise(resolve=>out.end(resolve));}
  return {bytes,yielded};
}
export async function acquireNetworkSnapshot(store,{sourceId,snapshotId,dataRoot,fetchImpl=fetch,progress=async()=>false,shouldYield=()=>false,calculateChecksum=false}={}) {
  const source=store.getSource(sourceId);if(!source)throw new Error(`unregistered network source '${sourceId}'`);
  if(!store.sourceApproval(sourceId))throw new Error('network acquisition requires an explicit active source approval');
  const extract=resolveNetworkExtract(source,{allowChecksumCalculation:calculateChecksum});if(snapshotId!==extract.snapshot_id)throw new Error('requested snapshot ID does not match the pinned source registry entry');
  const root=path.resolve(dataRoot),privateRoot=fs.realpathSync(store.root);
  if(root!==privateRoot&&!root.startsWith(privateRoot+path.sep))throw new Error('network data root must be inside the private Scout root');
  fs.mkdirSync(root,{recursive:true,mode:0o700});if(fs.lstatSync(root).isSymbolicLink()||!fs.realpathSync(root).startsWith(privateRoot+path.sep))throw new Error('network data directory cannot escape the private Scout root');
  const dest=path.join(root,`${snapshotId}.osm.pbf`),part=`${dest}.part`;
  const pinned=store.getNetworkSnapshot(snapshotId),artifact=store.getNetworkArtifact(snapshotId);
  const pinCalculated=(checksum)=>{
    if(extract.sha256)return;
    if(!calculateChecksum||source.network_extract.checksum_policy!=='calculate-after-download')throw new Error('network SHA-256 cannot be derived without explicit provider checksum policy');
    const definition={...source};for(const key of ['revision','health','last_retrieval','last_successful_processing','next_due'])delete definition[key];
    definition.network_extract={...definition.network_extract,sha256:checksum,checksum_policy:'calculated-after-download'};store.registerSource(definition);
  };
  if(artifact){
    const artifactPath=path.resolve(artifact.local_path);if(fs.lstatSync(artifactPath).isSymbolicLink()||!fs.statSync(artifactPath).isFile())throw new Error('registered network artifact is no longer a regular private file');
    const real=fs.realpathSync(artifactPath);if(real===privateRoot||!real.startsWith(privateRoot+path.sep))throw new Error('registered network artifact escaped the private Scout root');const digest=await fileSha256(real);
    if((!extract.sha256||digest===extract.sha256)&&digest===artifact.sha256&&fs.statSync(real).size===artifact.byte_size){pinCalculated(digest);return {status:'REUSED',snapshot_id:snapshotId,path:real,sha256:digest,bytes:artifact.byte_size};}
    throw new Error('registered network artifact checksum/size mismatch; refusing reuse');
  }
  if(pinned&&pinned.checksum!==extract.sha256)throw new Error('registered snapshot checksum conflicts with pinned source registry');
  // Recover the narrow crash window after fsync+rename but before SQLite pins
  // the artifact; never redownload a complete file without first verifying it.
  if(!artifact&&fs.existsSync(dest)){
    if(fs.lstatSync(dest).isSymbolicLink()||!fs.statSync(dest).isFile())throw new Error('unregistered network destination is not a regular private file');
    const digest=await fileSha256(dest),bytes=fs.statSync(dest).size;if(extract.sha256&&digest!==extract.sha256)throw new Error('unregistered network destination failed pinned checksum validation');
    if(pinned&&pinned.checksum!==digest)throw new Error('unregistered network destination conflicts with pinned snapshot checksum');
    pinCalculated(digest);if(!pinned)store.recordNetworkSnapshot({snapshot_id:snapshotId,source_id:sourceId,version:extract.version,checksum:digest,licence:extract.licence,coverage:extract.coverage});
    store.recordNetworkArtifact({snapshot_id:snapshotId,provider:extract.provider,source_url:extract.url,local_path:dest,byte_size:bytes,sha256:digest,last_modified:extract.last_modified});
    return {status:'RECOVERED',snapshot_id:snapshotId,path:dest,sha256:digest,bytes};
  }
  let existing=0;if(fs.existsSync(part)){if(fs.lstatSync(part).isSymbolicLink()||!fs.statSync(part).isFile())throw new Error('partial network download is not a regular private file');existing=fs.statSync(part).size;}
  const headers={};if(existing)headers.Range=`bytes=${existing}-`;
  const response=await fetchImpl(extract.url,{headers,redirect:'error'});
  if(existing&&response.status===200)existing=0;
  else if(existing&&response.status!==206)throw new Error(`network provider refused safe range resume (HTTP ${response.status})`);
  else if(!existing&&response.status!==200)throw new Error(`network provider returned HTTP ${response.status}`);
  if(existing){const contentRange=response.headers.get('content-range');if(!new RegExp(`^bytes ${existing}-\\d+/(?:\\d+|\\*)$`).test(contentRange??''))throw new Error('network provider returned an invalid Content-Range for resume');}
  if(response.url){const final=new URL(response.url);if(final.protocol!=='https:'||final.hostname!==GEOFABRIK_HOST)throw new Error('network provider redirected outside its registered origin');}
  const received=await appendResponse(response,part,{start:existing,progress,shouldYield});
  if(received.yielded){const fd=fs.openSync(part,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return {status:'YIELDED',snapshot_id:snapshotId,bytes:received.bytes,partial_path:part};}
  const checksum=await fileSha256(part);
  if(extract.sha256&&checksum!==extract.sha256)throw new Error(`network extract SHA-256 mismatch for pinned version '${extract.version}'`);
  const fd=fs.openSync(part,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(part,dest);fs.chmodSync(dest,0o600);
  pinCalculated(checksum);
  if(!pinned)store.recordNetworkSnapshot({snapshot_id:snapshotId,source_id:sourceId,version:extract.version,checksum,
    licence:extract.licence,coverage:extract.coverage});
  store.recordNetworkArtifact({snapshot_id:snapshotId,provider:extract.provider,source_url:extract.url,local_path:dest,byte_size:received.bytes,sha256:checksum,
    etag:response.headers.get('etag'),last_modified:response.headers.get('last-modified')});
  return {status:'COMPLETE',snapshot_id:snapshotId,path:dest,sha256:checksum,bytes:received.bytes,reused:false};
}
export async function importNetworkArtifact(store,{snapshotId,batchSize=1000,shouldYield=()=>false,osmium='osmium',spawnImpl=spawn}={}) {
  const snapshot=store.getNetworkSnapshot(snapshotId);if(!snapshot)throw new Error('network import needs a registered pinned snapshot');
  const artifact=store.getNetworkArtifact(snapshotId);if(!artifact)throw new Error('network import requires a verified registered source artifact');
  const file=path.resolve(artifact.local_path);if(fs.realpathSync(file)!==file||fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())throw new Error('network import artifact must be a private regular file');
  if(!file.endsWith('.osm.pbf'))throw new Error('registered network artifact must be an OSM PBF');
  const digest=await fileSha256(file);if(digest!==artifact.sha256||digest!==snapshot.checksum)throw new Error('network artifact failed checksum verification before import');
  const {importOsmGeoJsonSeq}=await import('./osm-network-import.mjs');
  const checkpoint=store.networkImportCheckpoint(snapshotId),skipped=checkpoint?.records_seen??0;
  if(checkpoint?.status==='COMPLETE'&&checkpoint.edges_written===store.networkEdgeCount(snapshotId))return {seen:checkpoint.records_seen,written:0,yielded:false,status:'REUSED',resumed_from:checkpoint.records_seen,edges_total:checkpoint.edges_written};
  const child=spawnImpl(osmium,['export','-f','geojsonseq','--add-unique-id=type_id','-o','-',file],{stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{if(stderr.length<8192)stderr+=chunk.toString('utf8').slice(0,8192-stderr.length);});
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  // Resume at a complete record boundary; the importer retains stable OSM IDs,
  // so a crash between an edge batch and its checkpoint safely replays/upserts it.
  try {
    const result=await importOsmGeoJsonSeq(store,{stream:child.stdout,snapshotId,batchSize,skipRecords:skipped,onBatch:async({seen})=>{
      store.setNetworkImportCheckpoint(snapshotId,{source_url:artifact.source_url,records_seen:seen,edges_written:store.networkEdgeCount(snapshotId),status:'RUNNING'});
      return shouldYield();
    }});
    if(result.yielded)child.kill('SIGTERM');
    const exit=await closed;
    if(!result.yielded&&(exit.code!==0||exit.signal))throw new Error(`osmium PBF export failed${stderr?`: ${stderr.trim().slice(0,500)}`:''}`);
    const status=result.yielded?'YIELDED':'COMPLETE';
    store.setNetworkImportCheckpoint(snapshotId,{source_url:artifact.source_url,records_seen:result.seen,edges_written:store.networkEdgeCount(snapshotId),status});
    return {...result,status,resumed_from:skipped,edges_total:store.networkEdgeCount(snapshotId)};
  }catch(error){if(child.exitCode===null)child.kill('SIGTERM');await closed.catch(()=>{});throw error;}
}
