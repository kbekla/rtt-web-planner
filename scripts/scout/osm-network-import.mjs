import { createInterface } from 'node:readline';

// Imports a bounded OSM export produced from a pinned regional PBF. The source
// snapshot and ODbL/provenance record must already be registered by the caller.
// Replaying the stream after interruption is safe because OSM way IDs are stable
// edge keys and geostore batches use idempotent upserts.
export async function importOsmGeoJsonSeq(store, { stream, snapshotId, batchSize = 1000, skipRecords = 0, onBatch = async () => false } = {}) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new Error('a readable GeoJSON text sequence is required');
  if (!snapshotId || !store.getNetworkSnapshot(snapshotId)) throw new Error('an explicitly registered network snapshot is required');
  const snapshot = store.getNetworkSnapshot(snapshotId), source = store.getSource(snapshot.source_id);
  if (!source?.roles?.routing_network || !source.reuse?.private_processing) throw new Error('registered source is not approved for private routing-network processing');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error('batchSize must be 1-5000');
  if (!Number.isSafeInteger(skipRecords) || skipRecords < 0) throw new Error('skipRecords must be a nonnegative record checkpoint');

  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let batch = [], seen = 0, written = 0, yielded = false;
  const flush = async () => {
    if (!batch.length) return false;
    const current = batch; batch = [];
    store.saveNetworkEdges(snapshotId, current);
    written += current.length;
    yielded = Boolean(await onBatch({ seen, written }));
    return yielded;
  };
  for await (const line of reader) {
    const record = line.trim().replace(/^\u001e/, '');
    if (!record) continue;
    seen++;
    if(seen<=skipRecords)continue;
    let feature;
    try { feature = JSON.parse(record); } catch { throw new Error(`invalid GeoJSON sequence record ${seen}`); }
    if (feature?.type !== 'Feature') throw new Error(`GeoJSON sequence record ${seen} is not a Feature`);
    const properties = feature.properties ?? {};
    const prefixedId=typeof feature.id==='string'?feature.id.match(/^([nwra])([1-9]\d*)$/):null;
    const inferredKind=prefixedId?({n:'node',w:'way',r:'relation',a:'area'}[prefixedId[1]]):null;
    const kind = properties['@type'] ?? properties.type ?? inferredKind;
    const explicitId = properties['@id'] ?? properties.id;
    // osmium versions/exports represent a way identity as either the numeric
    // @id, the typed string "way/123", or the GeoJSON type_id "w123". Prefer
    // the typed GeoJSON ID when present; accept the documented typed form too.
    const typedPropertyId = typeof explicitId === 'string'
      ? explicitId.match(/^(?:way\/|w)([1-9]\d*)$/)?.[1]
      : null;
    const objectId = prefixedId?.[2] ?? typedPropertyId ?? explicitId ?? feature.id;
    if (kind && kind !== 'way') continue;
    const stableWayId = /^[1-9]\d*$/.test(String(objectId ?? '')) ? String(objectId) : null;
    const tags = Object.fromEntries(Object.entries(properties).filter(([key]) => !key.startsWith('@') && key !== 'id' && key !== 'type'));
    if (typeof tags.highway !== 'string' || !tags.highway) continue;
    if (!feature.geometry || !['LineString', 'MultiLineString'].includes(feature.geometry.type)) continue;
    if (!stableWayId) {
      const safe = value => typeof value === 'string' ? value.slice(0, 48) : typeof value;
      throw new Error(`GeoJSON sequence record ${seen} has no stable OSM way ID (feature.id=${safe(feature.id)}, @type=${safe(properties['@type'])}, type=${safe(properties.type)}, @id=${safe(properties['@id'])}, id=${safe(properties.id)})`);
    }
    batch.push({ edge_id: `osm:way:${stableWayId}`, geometry: feature.geometry, tags,
      evidence: [], jurisdiction_ids: [] });
    if (batch.length >= batchSize && await flush()) return { seen, written, yielded: true };
  }
  if (!yielded) yielded = await flush();
  return { seen, written, yielded };
}
