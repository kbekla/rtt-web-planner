# RT&T trail layer: data contract and build

This layer holds RT&T's proprietary trail and lane network. It is built into its own archive, `rtt-trails.pmtiles` (layer `rtt_trails`), and is never merged into the OpenStreetMap basemap.

**Status (Phases 3a and 3b, 2026-10-03):** the contract, the deterministic pipeline, the viewer integration and the factory job are proven on a **synthetic fixture only**. No real RT&T data has been imported yet. Real data enters only through the contract below.

## Privacy rule (Phase 3c)

The **published** trail map carries rider-facing data only:

| Published field | Meaning |
|---|---|
| `rtt_id` | stable RT&T identifier |
| `name` | lane name |
| `kind` | legal classification |
| `status` | access status |
| geometry | the line itself |

Everything else stays in the **private master**, which is local to RT&T and is never published, served, uploaded or committed. That covers:
- provenance
- source names, URLs and registry IDs
- council dataset references and GRM/TrailVidz references
- verification method, research notes and evidence
- confidence methodology
- licence and reuse notes

| | Published | Private master (local only) |
|---|---|---|
| Tiles | `rtt-trails.pmtiles` with the 4 fields above + geometry | — |
| Build output | `output/rtt-trails/<id>/`: archive + public `manifest.json` (build ID, hash, `rtt_id` list) | `private/rtt-trails/<id>/`: `build-record.json` (inputs, sources, counts), `quarantine.json`, `build.log` |
| Source registry | — | `$FACTORY_DIR/private/rtt/sources.yaml` (or `RTT_PRIVATE_SOURCES`). The repo's `config/rtt/sources.yaml` holds synthetic test sources only. |
| Master data / staging | — | `$FACTORY_DIR/private/…`, `$FACTORY_DIR/staging/…` |

How it's enforced:
- **Every build runs the publish guard** (`scripts/rtt/publish-check.mjs`). It decodes every tile and scans the archive metadata and the public manifest. The build fails, and its public output is deleted, if any of these turns up:
  - a tile field outside the four above
  - any key or text that looks like provenance or research (source, licence, method, evidence, verification, confidence, council, PRoW, GRM, TrailVidz, TET, URLs, …)
- **Tests** (`tests/rtt/privacy.test.mjs`) also check:
  - the installed trail style
  - that only synthetic sources are in the repo
  - that nothing under `private/` or `staging/` is tracked by git
  - that the server returns 404 for private and staging paths, including traversal attempts

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
| **Quarantine**: held for licensing review, never built, never silently dropped | `osm_derived: true`; source missing from the registry; source not approved; source marked OSM-derived; method not allowed for the source | listed with reasons and provenance in the build's **private** `quarantine.json` |
| **Accepted** | everything else | built into `rtt_trails` |

Approving a source is a human licensing decision. Set `approved: true` with `approved_by` (who and when) in `config/rtt/sources.yaml`. An OSM-derived source can never be approved; a test enforces this.

## Build

```sh
make rtt-validate RTT_INPUT=path/to/trails.geojson   # report only
make rtt-build    RTT_INPUT=path/to/trails.geojson   # $FACTORY_DIR/output/rtt-trails/<build-id>/
make test-rtt                                        # contract, build, reproducibility, diff, separation
```

The public output directory contains only `rtt-trails.pmtiles` and a rider-facing `manifest.json`. The private directory `$FACTORY_DIR/private/rtt-trails/<build-id>/` holds `build-record.json`, `quarantine.json` and `build.log`.
- **Build ID:** a hash of the canonical accepted features, the schema, the source registry, the Planetiler profile, the pinned `planetiler.jar`, the Java version and the output arguments.
- **Canonical features:** sorted by `rtt_id` with sorted keys and provenance stripped. So input order and thread count don't change the bytes.
- **Manifest:** records the accepted IDs, the quarantine count, the sources used (with licence and attribution) and `contains_synthetic`.
- **Tiles:** z0–16, because z16 is Planetiler's maximum. Viewers overzoom for z17+. Lines are kept at every zoom (`min_size: 0`), so the archive's tile range always matches its header. When trails become visible is a style decision (Phase 3b). Tiles carry only `rtt_id`, `name`, `kind` and `status` (the privacy rule). `surface`, `version` and provenance stay in the private master.

## What the tests prove (`tests/rtt/`)

- Schema, enum, unknown-property, provenance-field and geometry rules. A duplicate `rtt_id` rejects the input.
- Every quarantine reason works, and quarantined features never appear in any tile.
- **Reproducible:** byte-identical PMTiles across thread counts and with shuffled input order.
- **Stable diff:** moving one vertex of one feature and bumping its version changes only that `rtt_id` in the decoded tiles. Every other feature is identical in every tile from z0 to z16.
- **Separation:** the promoted Monaco and UK OSM archives contain no `rtt_trails` layer and no `rtt_id` in any tile around the fixture area. The RT&T archive carries no OpenStreetMap or OpenMapTiles credit.

## Viewer (Phase 3b)

- **Style:** `styles/rtt/trails.json` is a separate style fragment: source `rtt-trails` (`pmtiles:///tiles/rtt-trails.pmtiles`) with RT&T-only attribution and `promoteId: { rtt_trails: "rtt_id" }`. `scripts/rtt/build-trail-style.mjs` validates it and installs it at `$FACTORY_DIR/assets/styles/rtt-trails.json`.
  - **Layers:** `rtt-trails-selected` (feature-state halo), `-casing`, `-line` (colour by `kind`, opacity by `status`), `-line-proposed` (dashed), and `-label` (names from z14).
  - **Visibility:** trails show from z11 and are overzoomed beyond z16.
- **Viewer:** `/viewer/?region=monaco&trails=1` merges the fragment into the basemap style at load time. The basemap `style.json` never contains RT&T data, and without `trails=1` nothing changes.
  - **Selection:** clicking a trail selects it with feature-state keyed by `rtt_id`.
  - **Test hooks:** `window.__rtt.selectTrail(id)`, `trailState(id)` and `renderedTrails()`.
- **Server:** `scripts/serve.mjs` serves `/tiles/rtt-trails.pmtiles` from `output/rtt-trails/<RTT_TRAILS_BUILD_ID|current>`.
- **Render tests:** `tests/render/trails.spec.mjs` (opt-in with `RTT_TRAILS=1`; `make test-rtt-render`). It checks:
  - exactly the build's accepted IDs render (read from its manifest), with `feature.id == rtt_id`
  - quarantined IDs never render
  - selection is set and cleared
  - both attributions show
  - no external requests
  - reference screenshots (reviewed) for the overview, labelled detail and selected states, on desktop and mobile. These are defined for the synthetic fixture only.

## Pipeline and factory (Phase 3b)

`scripts/rtt/pipeline-trails [input]` runs validate → build → style → `tests/rtt` → trail render tests → `promote-region rtt-trails <id>`. It promotes only if every step passes, records its steps for mapwatch, and preserves failures like the region pipelines. The factory runs it as a `trails` job (see [FACTORY.md](FACTORY.md)), using `trails.input` from `config/factory.yaml`, which is the synthetic fixture for now.

## Not done yet

- **Integer MVT feature IDs:** the custom YAML profile doesn't set them. Highlighting uses `promoteId` on the string `rtt_id`.
- **Real data:** importing real RT&T trail data, through this contract, once its sources are entered and approved in the registry.
