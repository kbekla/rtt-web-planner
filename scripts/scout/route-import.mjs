// Explicit-file ingestion only. It never scans home directories or performs
// network access; callers must select a registered source and one local file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../lib/common.mjs';
import { parseRouteFile } from './route-parsers.mjs';

export const ROUTE_PARSER_VERSION = 'route-parser-1';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const stable = (value) => JSON.stringify(canonical(value));

function checkRelativeName(value) {
  const name = String(value ?? '');
  if (!name || name.length > 240 || name.startsWith('/') || name.split(/[\\/]/).some((p) => p === '..' || p === '.')) throw new Error('relative source filename is unsafe');
  return name.replaceAll('\\', '/');
}
function sourceExtension(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.gpx') return 'gpx'; if (ext === '.kml') return 'kml'; if (ext === '.geojson' || ext === '.json') return 'geojson';
  throw new Error(`unsupported route file extension '${ext || '(none)'}'`);
}
function readSelectedFile(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('selected file is not regular or exceeds configured size limit');
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size) throw new Error('selected file changed during read');
    return bytes;
  } catch (error) { if (error.message?.includes('selected file')) throw error; throw new Error('cannot safely open selected route file'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function persistRaw(rawRoot, sourceId, ext, bytes, checksum) {
  const root=path.resolve(rawRoot);fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(fs.lstatSync(root).isSymbolicLink()||!fs.statSync(root).isDirectory())throw new Error('private raw root must be a real directory, not a symlink');
  const privateRoot=fs.realpathSync(root),repository=fs.realpathSync(REPO);
  if(privateRoot===repository||privateRoot.startsWith(repository+path.sep))throw new Error('Scout raw source storage must remain outside the repository/public tree');
  fs.chmodSync(root,0o700);
  const dir = path.join(root, sourceId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if(fs.lstatSync(dir).isSymbolicLink()||!fs.statSync(dir).isDirectory())throw new Error('private source storage must be a real directory, not a symlink');
  fs.chmodSync(dir,0o700);
  const target = path.join(dir, `${checksum}.${ext}`);
  if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw new Error('content-addressed raw source cannot be a symlink');
  if (fs.existsSync(target)) {
    if (hash(fs.readFileSync(target)) !== checksum) throw new Error('content-addressed raw source hash mismatch');
    return target;
  }
  const temp = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, target); }
  catch (error) { fs.rmSync(temp, { force: true }); if (!fs.existsSync(target)) throw error; }
  const dirFd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  return target;
}

export function ingestRouteFile(store, { inputFile, sourceId, relativeName = path.basename(inputFile ?? ''), rawRoot,
  maxBytes = 16 * 1024 * 1024, sourceLanguage = null, observedAt = new Date().toISOString() } = {}) {
  if (!inputFile || !sourceId || !rawRoot) throw new Error('explicit inputFile, sourceId and private rawRoot are required');
  const source = store.getSource(sourceId);
  if (!source) throw new Error(`source '${sourceId}' is not registered`);
  if (!source.reuse.private_processing) throw new Error('source registry does not authorize private processing');
  const relative = checkRelativeName(relativeName), format = sourceExtension(inputFile);
  if (!source.expected_formats.map((x) => x.toLowerCase()).includes(format)) throw new Error(`source does not declare ${format} format`);
  const bytes = readSelectedFile(inputFile, maxBytes), checksum = hash(bytes);
  const parserVersion = `${ROUTE_PARSER_VERSION}+${source.adapter_version}`;
  const rawPath = persistRaw(rawRoot, sourceId, format, bytes, checksum);
  const registered = store.recordFile({ source_id: sourceId, relative_name: relative, sha256: checksum, parser_version: parserVersion,
    format, raw_path: rawPath, byte_size: bytes.length, imported_at: observedAt });
  if (registered.duplicate) return { file_id: registered.file_id, version: registered.version, checksum, duplicate: true,
    observations: store.observationsForFile(registered.file_id) };
  const parsed = parseRouteFile(format, bytes.toString('utf8'), { sourceLanguage });
  const observations = parsed.parts.map((part) => {
    const identity = [sourceId, checksum, parserVersion, part.part_key];
    const observationId = `obs-${hash(Buffer.from(stable(identity))).slice(0, 24)}`;
    const geometryJson = JSON.stringify(part.geometry);
    return { observation_id: observationId, source_part: part.part_key, source_name: part.name,
      source_language: sourceLanguage, geometry: part.geometry,
      geometry_sha256: hash(Buffer.from(geometryJson)), metadata: { ...part.metadata, parser_version: parserVersion,
        source_id: sourceId, source_file_id: registered.file_id, source_file_sha256: checksum, raw_source_ref: rawPath,
        source_version: registered.version, observed_at: observedAt } };
  });
  store.completeFileImport(registered.file_id, observations);
  return { file_id: registered.file_id, version: registered.version, checksum, format, duplicate: false, observations };
}

/** Inspect only the one operator-selected file; this does not persist or scan anything. */
export function inspectRouteFile(inputFile, { maxBytes = 16 * 1024 * 1024, sourceLanguage = null } = {}) {
  if (!inputFile) throw new Error('an explicitly selected route file is required');
  const format = sourceExtension(inputFile), bytes = readSelectedFile(inputFile, maxBytes);
  const parsed = parseRouteFile(format, bytes.toString('utf8'), { sourceLanguage });
  const points = parsed.parts.flatMap((part) => part.geometry.type === 'LineString'
    ? part.geometry.coordinates : part.geometry.coordinates.flat());
  if (!points.length) throw new Error('selected route file contains no usable coordinates');
  let south=Infinity,north=-Infinity;
  const longitudes = points.map(([lon,lat]) => {south=Math.min(south,lat);north=Math.max(north,lat);return ((lon + 180) % 360 + 360) % 360;}).sort((a,b)=>a-b);
  let largestGap=-1,gapAfter=0;for(let i=0;i<longitudes.length;i++){const next=i===longitudes.length-1?longitudes[0]+360:longitudes[i+1],gap=next-longitudes[i];if(gap>largestGap){largestGap=gap;gapAfter=i;}}
  const start=longitudes[(gapAfter+1)%longitudes.length],end=longitudes[gapAfter]+(gapAfter===longitudes.length-1?0:longitudes[gapAfter]<start?360:0);
  const longitude=(v)=>{const shifted=((v+180)%360+360)%360-180;return shifted===-180&&v>0?180:shifted;};
  return { format, byte_size: bytes.length, checksum: hash(bytes), bounds: [longitude(start-180),
    south, longitude(end-180), north],
  observation_count: parsed.parts.length, point_count: points.length, geometries: parsed.parts.map((part) => part.geometry) };
}
