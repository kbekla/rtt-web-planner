// Local MapLibre viewer for RT&T basemap builds.
//   /viewer/?region=monaco#zoom/lat/lon
// Exposes window.__rtt for the render tests (errors, missing images, idle state).
import * as maplibregl from '/vendor/maplibre-gl/maplibre-gl.mjs';

const params = new URLSearchParams(location.search);
const region = params.get('region') || 'monaco';

const state = { region, errors: [], missingImages: [], ready: false };
window.__rtt = state;

const protocol = new pmtiles.Protocol({ metadata: true });
maplibregl.addProtocol('pmtiles', protocol.tile);

// The style uses root-relative URLs; MapLibre needs absolute ones.
const abs = (u) => new URL(u, location.origin).href.replace(/%7B/g, '{').replace(/%7D/g, '}');
const style = await (await fetch(`/assets/styles/${region}/style.json`)).json();
style.glyphs = abs(style.glyphs);
style.sprite = abs(style.sprite);
for (const source of Object.values(style.sources)) {
  if (source.url?.startsWith('pmtiles://')) source.url = `pmtiles://${abs(source.url.slice('pmtiles://'.length))}`;
}

// RT&T trail layer (?trails=1): a separate source and style fragment, merged in at
// load time so the basemap style itself never contains RT&T data.
const trails = params.get('trails') === '1';
if (trails) {
  const frag = await (await fetch('/assets/styles/rtt-trails.json')).json();
  style.sources[frag.source_id] = { ...frag.source, url: `pmtiles://${abs(frag.source.url.slice('pmtiles://'.length))}` };
  style.layers.push(...frag.layers);
}

// Default view: the archive's own center, unless the URL hash sets one.
const archive = new pmtiles.PMTiles(abs(`/tiles/${region}.pmtiles`));
protocol.add(archive);
const header = await archive.getHeader();

const map = new maplibregl.Map({
  container: 'map',
  style,
  hash: true,
  center: [header.centerLon, header.centerLat],
  zoom: header.centerZoom,
  attributionControl: false,
  // Overzoom z14 basemap tiles for close-in detail.
  maxZoom: 19,
});
// OSM attribution must be visible without interaction, at every screen size.
map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

map.on('error', (e) => state.errors.push(String(e.error?.message ?? e.error ?? e)));
map.on('styleimagemissing', (e) => state.missingImages.push(e.id));
map.on('idle', () => { state.ready = true; });
map.on('movestart', () => { state.ready = false; });
window.__map = map;

// Trail selection: feature-state keyed by the stable rtt_id (promoteId).
if (trails) {
  const TRAIL = { source: 'rtt-trails', sourceLayer: 'rtt_trails' };
  const lineLayers = ['rtt-trails-line', 'rtt-trails-line-proposed'];
  let selected = null;
  state.selectTrail = (id) => {
    if (selected) map.setFeatureState({ ...TRAIL, id: selected }, { selected: false });
    selected = id ?? null;
    if (selected) map.setFeatureState({ ...TRAIL, id: selected }, { selected: true });
    return selected;
  };
  state.trailState = (id) => map.getFeatureState({ ...TRAIL, id });
  // Rendered trails: [{ id, rtt_id, kind, status }] for tests and inspection.
  state.renderedTrails = () => map.queryRenderedFeatures({ layers: lineLayers })
    .map((f) => ({ id: f.id, rtt_id: f.properties.rtt_id, kind: f.properties.kind, status: f.properties.status }));
  map.on('click', (e) => {
    const hit = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: lineLayers })[0];
    state.selectTrail(hit ? hit.id : null);
  });
  for (const l of lineLayers) {
    map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
  }
}
