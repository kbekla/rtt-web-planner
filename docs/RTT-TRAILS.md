# RT&T trail layer: data contract and build

This layer holds RT&T's proprietary trail and lane network. It is built into its own archive, `rtt-trails.pmtiles` (layer `rtt_trails`), and is never merged into the OpenStreetMap basemap.

**Status (Phase 3a, 2026-10-03):** the contract and the deterministic pipeline are proven on a **synthetic fixture only**. No real RT&T data has been imported yet. Real data enters only through the contract below.

## The contract

| Piece | File | Role |
|---|---|---|
| Schema | `schema/rtt-trails.schema.json` (v1) | Which fields exist and what values they may take. `scripts/rtt/validate.mjs` reads its enums and patterns, so there is one source of truth. |
| Source registry | `config/rtt/sources.yaml` | Which data sources may enter, under what licence and attribution, with which capture methods. |
| Validator | `scripts/rtt/validate.mjs` | Applies both, and sorts the input into errors, quarantine and accepted. |
| Planetiler profile | `config/rtt/rtt-trails.planetiler.yml` | What goes into the tiles. |
| Build | `scripts/rtt/build-trails.mjs` | Validate → canonicalise → content-addressed build → verify → manifest. |

### Feature fields (schema v1)

Every feature is a GeoJSON `LineString` or `MultiLineString` (WGS84) with exactly these properties. Any other property is an error, so stray OSM tags can't slip in.

| Field | Rule |
|---|---|
| `rtt_id` | Required. `rtt-trail-` plus 12 hex digits. Assigned once when the feature first enters RT&T. It is opaque: never derived from geometry or from any OSM id, never reused, and **unchanged by edits**. |
| `kind` | Required. `trail`, `bridleway`, `byway`, `cycle_lane`, `shared_lane` or `connector`. |
| `status` | Required. `open`, `closed`, `seasonal` or `proposed`. |
| `surface` | Optional. `paved`, `gravel`, `compacted`, `dirt`, `grass`, `boardwalk`, `mixed` or `unknown`. |
| `name` | Optional, at most 120 characters. |
| `version` | Required integer ≥ 1. Bumped on every edit. |
| `provenance.source` | Required. A key in `config/rtt/sources.yaml`. |
| `provenance.method` | Required. `field_survey`, `gps_trace`, `rtt_digitised`, `licensed_import` or `synthetic`. |
| `provenance.captured` | Required. `YYYY-MM-DD`. |
| `provenance.osm_derived` | Required and explicit (`true`/`false`). True if any part was traced, snapped or copied from OpenStreetMap. |
| `provenance.notes` | Optional, at most 500 characters. |

Geometry rules: every line has ≥ 2 finite points, lies within the WGS84 / Web Mercator range, and is at least 1 m long.

### What happens to each feature

| Outcome | When | Effect |
|---|---|---|
| **Error**: the whole input is rejected and nothing is built | schema violation, duplicate `rtt_id`, invalid geometry, not a FeatureCollection | `build-trails` exits non-zero with no output |
| **Quarantine**: held for licensing review, never built, never silently dropped | `osm_derived: true`; source missing from the registry; source not approved; source marked OSM-derived; method not allowed for the source | listed with reasons and provenance in the build's `quarantine.json` |
| **Accepted** | everything else | built into `rtt_trails` |

Approving a source is a human licensing decision. Set `approved: true` with `approved_by` (who and when) in `config/rtt/sources.yaml`. An OSM-derived source can never be approved; a test enforces this.

## Build

```sh
make rtt-validate RTT_INPUT=path/to/trails.geojson   # report only
make rtt-build    RTT_INPUT=path/to/trails.geojson   # $FACTORY_DIR/output/rtt-trails/<build-id>/
make test-rtt                                        # contract, build, reproducibility, diff, separation
```

The output directory contains `rtt-trails.pmtiles`, `manifest.json`, `quarantine.json` and `build.log`.
- **Build ID:** a hash of the canonical accepted features, the schema, the source registry, the Planetiler profile, the pinned `planetiler.jar`, the Java version and the output arguments.
- **Canonical features:** sorted by `rtt_id` with sorted keys and provenance stripped. So input order and thread count don't change the bytes.
- **Manifest:** records the accepted IDs, the quarantine count, the sources used (with licence and attribution) and `contains_synthetic`.
- **Tiles:** z0–16, because z16 is Planetiler's maximum. Viewers overzoom for z17+. Lines are kept at every zoom (`min_size: 0`), so the archive's tile range always matches its header. When trails become visible is a style decision (Phase 3b). Tiles carry only `rtt_id`, `kind`, `status`, `surface`, `name` and `version`. Provenance stays in the source data and the manifest.

## What the tests prove (`tests/rtt/`)

- Schema, enum, unknown-property, provenance-field and geometry rules. A duplicate `rtt_id` rejects the input.
- Every quarantine reason works, and quarantined features never appear in any tile.
- **Reproducible:** byte-identical PMTiles across thread counts and with shuffled input order.
- **Stable diff:** moving one vertex of one feature and bumping its version changes only that `rtt_id` in the decoded tiles. Every other feature is identical in every tile from z0 to z16.
- **Separation:** the promoted Monaco and UK OSM archives contain no `rtt_trails` layer and no `rtt_id` in any tile around the fixture area. The RT&T archive carries no OpenStreetMap or OpenMapTiles credit.

## Not done yet (Phase 3b and later)

- **Viewer:**
  - the separate style source, with `promoteId: "rtt_id"` and feature-state highlighting
  - trail styling and minzoom
  - render goldens
- **Integer MVT feature IDs:** the custom YAML profile doesn't set them. Highlighting will use `promoteId` on the string `rtt_id`.
- **Pipeline:**
  - a factory job type and promotion (`output/rtt-trails/current`)
  - adding the trail tests to the pipeline
- **Real data:** importing real RT&T trail data, through this contract, once its sources are entered and approved in the registry.
