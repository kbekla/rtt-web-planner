// Deterministic, dependency-free parsers for explicit private route files.
// GPX/KML use a bounded XML tokenizer which rejects DTD/entity declarations.
const local = (name) => name.split(':').at(-1).toLowerCase();
function xmlText(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][\w.-]*);|&/gi, (all, entity) => {
    if (!entity) throw new Error('invalid XML entity reference');
    if (entity[0] === '#') { const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error('invalid XML character reference');
      return String.fromCodePoint(n); }
    const result = ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase()];
    if (result === undefined) throw new Error('unsupported XML entity reference');
    return result;
  });
}
function parseAttrs(raw) {
  const attrs = {}, re = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g; let match;
  while ((match = re.exec(raw))) attrs[local(match[1])] = xmlText(match[3]);
  const rest = raw.replace(re, '').trim();
  if (rest) throw new Error('malformed XML attributes');
  return attrs;
}
function xmlEvents(xml, { open, text, close }) {
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml)) throw new Error('XML DTD/entity declarations are forbidden');
  const stack = []; let i = 0;
  while (i < xml.length) {
    if (xml[i] !== '<') { const end = xml.indexOf('<', i); const stop = end < 0 ? xml.length : end; if (stack.length) text(stack.at(-1).local, xmlText(xml.slice(i, stop)), stack); i = stop; continue; }
    if (xml.startsWith('<!--', i)) { const end = xml.indexOf('-->', i + 4); if (end < 0) throw new Error('unterminated XML comment'); i = end + 3; continue; }
    if (xml.startsWith('<![CDATA[', i)) { const end = xml.indexOf(']]>', i + 9); if (end < 0) throw new Error('unterminated CDATA'); if (stack.length) text(stack.at(-1).local, xml.slice(i + 9, end), stack); i = end + 3; continue; }
    if (xml.startsWith('<?', i)) { const end = xml.indexOf('?>', i + 2); if (end < 0) throw new Error('unterminated XML instruction'); i = end + 2; continue; }
    let end = i + 1, quote = null;
    for (; end < xml.length; end++) { const c = xml[end]; if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break; }
    if (end >= xml.length || quote) throw new Error('unterminated XML tag');
    const raw = xml.slice(i + 1, end).trim(); i = end + 1;
    if (raw.startsWith('!')) throw new Error('unsupported XML declaration');
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim(); const entry = stack.pop();
      if (!entry || entry.name !== name) throw new Error('mismatched XML closing tag');
      close(entry.local, entry, stack); continue;
    }
    const selfClose = raw.endsWith('/'), content = selfClose ? raw.slice(0, -1).trim() : raw;
    const name = /^([A-Za-z_:][\w:.-]*)/.exec(content)?.[1]; if (!name) throw new Error('invalid XML tag');
    const attrs = parseAttrs(content.slice(name.length));
    const entry = { name, local: local(name), attrs }; stack.push(entry); open(entry.local, entry, stack);
    if (selfClose) { stack.pop(); close(entry.local, entry, stack); }
  }
  if (stack.length) throw new Error('unclosed XML element');
}
function point(attrs) {
  const lon = Number(attrs.lon), lat = Number(attrs.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new Error('GPX point has invalid WGS84 coordinates');
  return { coord: [lon, lat], elevation: null, time: null };
}
function checkLine(coords) {
  if (!Array.isArray(coords) || coords.length < 2) throw new Error('route part must contain at least two points');
  for (const p of coords) if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) throw new Error('route has invalid WGS84 coordinates');
  return { type: 'LineString', coordinates: coords };
}

export function parseGpx(xml, { sourceLanguage = null } = {}) {
  const parts = []; let track = null, route = null, component = null, currentPoint = null, trkNo = 0, rteNo = 0;
  const textField = (tag, entry, stack, value) => {
    if (tag === 'name') {
      const parent = [...stack].reverse().find((n) => n.local === 'trk' || n.local === 'rte');
      if (parent?._record) parent._record.name = (parent._record.name ?? '') + value;
    } else if (['ele','time'].includes(tag) && currentPoint) currentPoint[tag] = (currentPoint[tag] ?? '') + value;
  };
  xmlEvents(xml, {
    open(tag, entry, stack) {
      if (tag === 'trk') { track = { name: '', index: ++trkNo, segment: 0 }; entry._record = track; }
      if (tag === 'rte') { route = { name: '', index: ++rteNo }; entry._record = route; component = { points: [], key: `route-${rteNo}` }; }
      if (tag === 'trkseg' && track) component = { points: [], key: `track-${track.index}-segment-${++track.segment}` };
      if ((tag === 'trkpt' && track && component) || (tag === 'rtept' && route && component)) currentPoint = point(entry.attrs);
    },
    text(tag, value, stack) { textField(tag, stack.at(-1), stack.slice(0, -1), value); },
    close(tag, entry) {
      if ((tag === 'trkpt' || tag === 'rtept') && currentPoint && component) {
        if (currentPoint.ele !== undefined && currentPoint.ele !== null) { const e = Number(currentPoint.ele); if (Number.isFinite(e)) { currentPoint.coord.push(e); currentPoint.elevation = e; } }
        if (typeof currentPoint.time === 'string') currentPoint.time = currentPoint.time.trim() || null;
        component.points.push(currentPoint); currentPoint = null;
      }
      if (tag === 'trkseg' && track && component) {
        if (component.points.length >= 2) parts.push({ part_key: component.key, name: track.name.trim() || null,
          geometry: checkLine(component.points.map((p) => p.coord)), metadata: { elevations_m: component.points.map((p) => p.elevation), times: component.points.map((p) => p.time), source_language: sourceLanguage } });
        component = null;
      }
      if (tag === 'rte' && route && component) {
        if (component.points.length >= 2) parts.push({ part_key: component.key, name: route.name.trim() || null,
          geometry: checkLine(component.points.map((p) => p.coord)), metadata: { elevations_m: component.points.map((p) => p.elevation), times: component.points.map((p) => p.time), source_language: sourceLanguage } });
        component = null; route = null;
      }
      if (tag === 'trk') track = null;
    },
  });
  if (!parts.length) throw new Error('GPX contained no usable track segments or routes');
  return { format: 'gpx', parts, source_language: sourceLanguage };
}

export function parseKml(xml, { sourceLanguage = null } = {}) {
  const parts = []; let placemark = null, line = null, placemarkNo = 0;
  xmlEvents(xml, {
    open(tag, entry) {
      if (tag === 'placemark') placemark = { index: ++placemarkNo, name: null, lines: [] };
      if (tag === 'linestring' && placemark) line = { coordinateText: '' };
    },
    text(tag, value) {
      if (!placemark) return;
      if (tag === 'name') placemark.name = (placemark.name ?? '') + value;
      if (tag === 'coordinates' && line) line.coordinateText += value;
    },
    close(tag) {
      if (tag === 'linestring' && line && placemark) {
        const coords = line.coordinateText.trim().split(/\s+/).filter(Boolean).map((v) => v.split(',').map(Number));
        placemark.lines.push(checkLine(coords)); line = null;
      }
      if (tag === 'placemark' && placemark) {
        placemark.lines.forEach((geometry, i) => parts.push({ part_key: `placemark-${placemark.index}-line-${i + 1}`,
          name: placemark.name?.trim() || null, geometry, metadata: { source_language: sourceLanguage } }));
        placemark = null;
      }
    },
  });
  if (!parts.length) throw new Error('KML contained no usable LineString placemarks');
  return { format: 'kml', parts, source_language: sourceLanguage };
}

export function parseGeoJson(text, { sourceLanguage = null } = {}) {
  const data = JSON.parse(text), features = data?.type === 'FeatureCollection' ? data.features : data?.type === 'Feature' ? [data] : [];
  if (!Array.isArray(features)) throw new Error('GeoJSON FeatureCollection.features must be an array');
  const parts = [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i]; if (feature?.type !== 'Feature') continue;
    const geometry = feature.geometry, properties = feature.properties ?? {};
    const lines = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
    lines.forEach((coords, j) => parts.push({ part_key: `feature-${feature.id ?? i}-line-${j + 1}`,
      name: typeof properties.name === 'string' ? properties.name : null, geometry: checkLine(coords),
      metadata: { feature_id: feature.id ?? null, properties: structuredClone(properties), source_language: sourceLanguage } }));
  }
  if (!parts.length) throw new Error('GeoJSON contained no usable LineString or MultiLineString features');
  return { format: 'geojson', parts, source_language: sourceLanguage };
}

export function parseRouteFile(format, text, options = {}) {
  switch (String(format).toLowerCase()) {
    case 'gpx': return parseGpx(text, options);
    case 'kml': return parseKml(text, options);
    case 'geojson': case 'json': return parseGeoJson(text, options);
    default: throw new Error(`unsupported route format '${format}'`);
  }
}
