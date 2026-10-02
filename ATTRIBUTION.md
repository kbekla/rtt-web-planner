# Attribution and licensing

Every map built by this pipeline must show this credit, visibly, in the corner of the map. It must not be collapsed behind a button.

```html
<a href="https://www.openmaptiles.org/">&copy; OpenMapTiles</a>
<a href="https://www.openstreetmap.org/copyright">&copy; OpenStreetMap contributors</a>
```

The credit is embedded in the PMTiles metadata and in the style source. The viewer renders it with `AttributionControl({ compact: false })`. `tests/attribution` and `tests/render` enforce all three.

## Data in the basemap tiles

| Source | Licence | Notes |
|---|---|---|
| OpenStreetMap, via Geofabrik extracts | **ODbL 1.0**. Credit "© OpenStreetMap contributors" with a link to https://www.openstreetmap.org/copyright | The tiles are a Produced Work. Each build's manifest records the exact snapshot (sha256 and replication timestamp) for provenance. |
| Water polygons from osmdata.openstreetmap.de | ODbL 1.0 (derived from OSM) | Covered by the OSM credit. |
| Lake centerlines (osm-lakelines) | ODbL 1.0 (derived from OSM) | Covered by the OSM credit. |
| Natural Earth | Public domain | Low-zoom boundaries and land cover. No credit required. |
| OpenMapTiles schema 3.16 | **CC-BY 4.0** | The tile schema. It requires the visible "© OpenMapTiles" credit linking to https://www.openmaptiles.org/. |

## Style and assets

| Component | Licence | Notes |
|---|---|---|
| OSM Bright GL style v1.11 (scaffold only) | Code BSD-3-Clause; design CC-BY 4.0. © MapTiler.com & OpenMapTiles contributors, © 2014 Mapbox (Mapbox Open Styles, BSD) | Vendored in `styles/vendor/osm-bright/` with its LICENSE.md. The design credit must be reasonably accessible, e.g. on an "about/credits" page. Planned to be replaced by the RT&T-owned design. |
| Scaffold icons | As shipped in OSM Bright (see its LICENSE.md) | Built into `rtt-basemap` sprites by spreet. |
| Noto Sans (Regular, Bold, Italic) glyphs | SIL Open Font License 1.1 | From the openmaptiles/fonts v2.0 release, served from our own origin. |

## Software (not distributed with tiles)

| Component | Licence |
|---|---|
| MapLibre GL JS | BSD-3-Clause |
| pmtiles (JS library and go-pmtiles CLI) | BSD-3-Clause |
| Planetiler and its OpenMapTiles profile | Apache-2.0 / BSD-3-Clause |
| spreet | MIT |
| `@mapbox/*` helper packages used by MapLibre (point-geometry, vector-tile, tiny-sdf, unitbezier, jsonlint-lines-primitives) | BSD/ISC. These are open-source libraries, not Mapbox services. |

## RT&T proprietary trail and lane data

- RT&T trail and lane data is published as a **separate** source and tileset with its own attribution. It is never merged into the OSM tiles.
- It must be **independently sourced and carry provenance**. Proprietary geometry or attributes must not be derived from OSM: no tracing, no snapping, no copying of tags.
- Any feature that is OSM-derived must be kept isolated, flagged (`osm_derived: true` plus a provenance reference), and held for licensing review before release. Data derived from OSM may fall under ODbL share-alike.
