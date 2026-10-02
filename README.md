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
| Tiles | `scripts/build-region.mjs <r>` | `output/<r>/<build-id>/{<r>.pmtiles, manifest.json, build.log, status.json, telemetry.jsonl}` |
| Glyphs and sprites | `scripts/build-assets` | `assets/glyphs/`, `assets/sprites/` |
| Style | `scripts/build-style.mjs <r>`: vendored scaffold + `styles/rtt/overlay.json` | `assets/styles/<r>/style.json` |
| Tests | `tests/{repo,schema,attribution}` (node:test) and `tests/render` (Playwright) | |
| Promote | `scripts/promote-region` | `output/<r>/current -> <build-id>` |

`scripts/pipeline <r>` (`make region`) runs every step in order. It promotes the build only if all tests pass.

**Build ID.** The build ID is a hash of the tile-producing inputs only: the region name, the snapshot sha256, the ancillary hashes, the pinned Planetiler jar, the Java version and the Planetiler output arguments (`maxzoom`, `planetiler.args`). `scripts/lib/build-id.mjs` lists the inputs and `manifest.json` records them under `build_id_inputs`. Test probes, views, `bbox`, `planetiler.heap` and the thread count are not part of the ID, so editing a test never forces a rebuild. Every region-config key must be classified in `build-id.mjs`, and an unclassified key fails the build. The output is byte-identical for identical inputs; `make repro` checks this with a different thread count.

## Monitoring: mapwatch and telemetry

During Planetiler, `build-region` samples the host every 5 s and writes the samples to `telemetry.jsonl` next to the build. It records:
- CPU, NVMe and iGPU temperatures
- iGPU load and VRAM
- the NVIDIA dGPU, queried only when it is already awake
- RAM and swap
- the scratch-directory size

The peaks, the means and the sampler's own cost go into `manifest.json` under `stats.telemetry`.

`scripts/mapwatch.mjs` is a read-only monitor for the factory. It only writes its own reports, and it uses no network or AI/API. It reads the following:
- each build's `status.json`, `manifest.json`, `build.log` and `telemetry.jsonl`
- `state/pipeline-<r>.json`
- `logs/failures/`

A failed or interrupted build or pipeline is copied to `logs/failures/` before a retry can overwrite it. A "running" record whose process has gone is reported as `aborted`.

```sh
make status             # Markdown summary (or: node scripts/mapwatch.mjs status --json)
make watch              # follow running builds, printing stage changes, until idle
make report             # $FACTORY_DIR/reports/latest.{json,md} plus a timestamped copy
```

Unattended operation (systemd queue, GREEN/AMBER/RED rules, disk guard, local AI helper) is described in [docs/FACTORY.md](docs/FACTORY.md).

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
docs/STYLE-BACKLOG.md  open style issues from the visual reviews
docs/FACTORY.md        unattended factory: queue, systemd, autonomy rules, AI helper
```

See [ATTRIBUTION.md](ATTRIBUTION.md) for licensing. The OSM and OpenMapTiles credit must be visible on every map.
