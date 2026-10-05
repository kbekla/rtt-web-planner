import crypto from 'node:crypto';
import { recordSourceFailure, recordSourceFetch, sourcePollDecision } from './watchkeeper.mjs';
import { SPW_ROAD_SERVICE, spwServiceMetadataVersion } from './spw-network.mjs';

const SOURCE_ID = 'spw-wallonia-regional-road-network';
const METADATA_URL = `${SPW_ROAD_SERVICE}?f=pjson`;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

/** Polls only the public SPW ArcGIS service descriptor; this does not download road geometry. */
export async function pollSpwServiceMetadata(store, { fetchImpl = globalThis.fetch, now = new Date(), timeoutMs = 8000, maxBytes = 1024 * 1024 } = {}) {
  const source = store.getSource(SOURCE_ID);
  if (!source || source.url !== SPW_ROAD_SERVICE) return { state: 'REVIEW_REQUIRED', reason: 'the canonical SPW source definition is not registered' };
  const approval = store.sourceApproval(SOURCE_ID);
  const prior = store.db.prepare('SELECT * FROM source_watch_state WHERE source_id=?').get(SOURCE_ID);
  const due = sourcePollDecision(source, prior ? { last_success_at: prior.last_success_at, next_due_at: prior.next_due_at } : null, now, { approved: Boolean(approval) });
  if (!due.due) return due;
  try {
    const response = await fetchImpl(METADATA_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', 'user-agent': 'RTT-Scout/1.0 source-metadata-poll' } });
    if (!response.ok) throw Object.assign(new Error('SPW metadata request failed'), { code: `HTTP_${response.status}` });
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error('SPW metadata response exceeded the bounded size'), { code: 'RESPONSE_TOO_LARGE' });
    let metadata;
    try { metadata = JSON.parse(text); } catch { throw Object.assign(new Error('SPW metadata was not valid JSON'), { code: 'INVALID_JSON' }); }
    const descriptor = spwServiceMetadataVersion(metadata);
    const result = recordSourceFetch(store, { sourceId: SOURCE_ID, version: descriptor.version, sha256: sha256(text), retrievedAt: now.toISOString(),
      payloadReference: `spw-service-metadata:${descriptor.service_version ?? 'unknown'}` });
    return { ...result, state: 'RECORDED', version: descriptor.version, service_version: descriptor.service_version, layers: descriptor.layers, bytes: Buffer.byteLength(text), scope: 'SERVICE_DESCRIPTOR_ONLY' };
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code ?? '') ? error.code : 'SPW_METADATA_UNAVAILABLE';
    const failure = recordSourceFailure(store, { sourceId: SOURCE_ID, errorCode: code, failedAt: now.toISOString() });
    return { ...failure, state: failure.state, error_code: code, scope: 'SERVICE_DESCRIPTOR_ONLY' };
  }
}
