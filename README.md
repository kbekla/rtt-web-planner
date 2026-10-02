# rtt-web-planner: RT&T self-hosted map pipeline

This pipeline turns OpenStreetMap extracts into OpenMapTiles-schema vector tiles. Planetiler builds the tiles and writes them to PMTiles, and MapLibre GL JS renders them. There are no paid services and no Mapbox runtime. Valhalla routing is out of scope and untouched.

- **Repo:** code, config, styles, schema, tests and docs only.
- **Data and outputs:** everything large lives in `$FACTORY_DIR` (default `~/rtt-map-factory`) and is never committed. A pre-commit hook and `tests/repo` enforce this.

## Quick start

```sh
make setup              # npm deps, headless Chromium, git hooks, pinned tools
make region R=monaco    # snapshot -> PMTiles -> style -> all tests -> promote
make serve              # http://127.0.0.1:8080/viewer/?region=monaco
make repro R=monaco     # rebuild from pinned inputs; must be byte-identical
```

## How a build works

| Step | Script | Output |
|---|---|---|
| Pinned tools | `scripts/fetch-tools` reads `tools.lock` (sha256-verified) | `$FACTORY_DIR/tools/` |
| OSM snapshot | `scripts/fetch-region.mjs <r>`; `--refresh` pins a new one | `sources/osm/<r>/<date>-<sha12>.osm.pbf`, locked in `config/regions/<r>.lock.json` |
| Ancillary inputs | pinned in `config/ancillary.lock` | `sources/ancillary/` |
| Tiles | `scripts/build-region.mjs <r>` | `output/<r>/<build-id>/{<r>.pmtiles, manifest.json, build.log}` |
| Glyphs and sprites | `scripts/build-assets` | `assets/glyphs/`, `assets/sprites/` |
| Style | `scripts/build-style.mjs <r>`: vendored scaffold + `styles/rtt/overlay.json` | `assets/styles/<r>/style.json` |
| Tests | `tests/{repo,schema,attribution}` (node:test) and `tests/render` (Playwright) | |
| Promote | `scripts/promote-region` | `output/<r>/current -> <build-id>` |

`scripts/pipeline <r>` (`make region`) runs every step in order. It promotes the build only if all tests pass.

**Build ID.** The build ID is a hash of the region config, the snapshot sha256, the ancillary hashes, `tools.lock`, the Java version and the Planetiler output arguments. Identical inputs therefore always produce the same ID. The output is byte-identical too: `make repro` checks this with a different thread count. The git commit and thread count are recorded in `manifest.json` but are not part of the ID, because they don't affect the output.

## Adding a region

1. Copy `config/regions/monaco.yaml` and set:
   - the source URLs, `bbox` and `planetiler.heap`
   - `required_layers`
   - tile `probes` (expected layers and classes at known places)
   - render `views`
2. Run `make region R=<name>`. The first run downloads and pins the snapshot. Commit the new `.lock.json`.
3. Review the new screenshots under `test-results/`. Accept them with `make goldens R=<name>`, then commit them.

No pipeline code changes should be needed. If a change is needed, it must be made generically and re-tested on the existing regions.

## Layout

```
config/       pipeline.env, ancillary.lock, regions/<r>.yaml + <r>.lock.json
schema/       OpenMapTiles 3.16 field schema (generated) + cited overrides
scripts/      pipeline steps (see above)
styles/       vendor/osm-bright (pristine, checksummed scaffold), rtt/ (RT&T overlay + icons)
viewer/       local MapLibre + pmtiles viewer
tests/        repo hygiene, schema, attribution, render (+ golden screenshots)
docs/PLAN.md  phased plan and acceptance criteria
```

See [ATTRIBUTION.md](ATTRIBUTION.md) for licensing. The OSM and OpenMapTiles credit must be visible on every map.
