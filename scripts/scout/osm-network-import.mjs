import { createInterface } from 'node:readline';

// Imports a bounded OSM export produced from a pinned regional PBF. The source
// snapshot and ODbL/provenance record must already be registered by the caller.
// Replaying the stream after interruption is safe because OSM way IDs are stable
// edge keys and geostore batches use idempotent upserts.
export async function importOsmGeoJsonSeq(store, { stream, snapshotId, batchSize = 1000, onBatch = async () => false } = {}) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new Error('a readable GeoJSON text sequence is required');
  if (!snapshotId || !store.getNetworkSnapshot(snapshotId)) throw new Error('an explicitly registered network snapshot is required');
  const snapshot = store.getNetworkSnapshot(snapshotId), source = store.getSource(snapshot.source_id);
  if (!source?.roles?.routing_network || !source.reuse?.private_processing) throw new Error('registered source is not approved for private routing-network processing');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error('batchSize must be 1-5000');

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
    let feature;
    try { feature = JSON.parse(record); } catch { throw new Error(`invalid GeoJSON sequence record ${seen + 1}`); }
    seen++;
    if (feature?.type !== 'Feature') throw new Error(`GeoJSON sequence record ${seen} is not a Feature`);
    const properties = feature.properties ?? {};
    const kind = properties['@type'] ?? properties.type;
    const objectId = properties['@id'] ?? properties.id ?? feature.id;
    if (kind && kind !== 'way') continue;
    if (!/^[1-9]\d*$/.test(String(objectId ?? ''))) throw new Error(`GeoJSON sequence record ${seen} has no stable OSM object ID`);
    const tags = Object.fromEntries(Object.entries(properties).filter(([key]) => !key.startsWith('@') && key !== 'id' && key !== 'type'));
    if (typeof tags.highway !== 'string' || !tags.highway) continue;
    if (!feature.geometry || !['LineString', 'MultiLineString'].includes(feature.geometry.type)) continue;
    batch.push({ edge_id: `osm:way:${objectId}`, geometry: feature.geometry, tags,
      evidence: [], jurisdiction_ids: [] });
    if (batch.length >= batchSize && await flush()) return { seen, written, yielded: true };
  }
  if (!yielded) await flush();
  return { seen, written, yielded: false };
}
