# RT&T Self-Hosted Map Build: Plan

Status: **Approved 2026-10-02.** Phases 0–2 are implemented and validated (Phase 2 results below), followed by a factory-hardening pass. Phase 3 waits for an explicit go-ahead.

## 0. Decisions recorded at approval (these override anything below)
1. RT&T trail and lane data must be independently sourced and carry provenance. Nothing proprietary may be derived from OSM. Any OSM-derived feature is isolated and flagged for licensing review.
   *Decision (A), confirmed 2026-10-02:* RT&T's proprietary trail and lane geometry is intended to be independently sourced with provenance, not traced or derived from OSM. If any existing geometry is later found to have been traced, snapped or otherwise derived from OSM, it must not be silently included in the proprietary dataset. It is isolated and flagged for licensing review.
2. "No Mapbox" means no Mapbox SDK, mapbox-gl runtime, APIs, tokens, hosted tiles/styles or network services. `@mapbox/*` open-source helpers are allowed where MapLibre requires them; `tests/repo` holds the allow-list.
3. Contrasting region: **Colorado** before any full-US attempt.
4. Schema: **OpenMapTiles**. OSM Bright is a scaffold only. The production style becomes an RT&T-owned design, with all glyphs, sprites and assets self-hosted.
5. Basemap max zoom is z14 with MapLibre overzoom. The RT&T trail/lane layer targets **z16–17** where useful.
6. The RT&T layer is built with **Planetiler**, using a custom YAML/Java profile. Tippecanoe is added only on a demonstrated need. This supersedes "tippecanoe" in sections 2 and 5.
7. Tool, schema and style versions and checksums are pinned.

Implementation notes that refine the original plan:
- **Build ID inputs.** The build ID excludes the git commit and the thread count. Neither affects the output; both are recorded in the manifest. Including the commit would make every docs change look like a new build.
- **Schema strictness.** The OpenMapTiles YAML `values` lists are not exhaustive, because some classes are produced in SQL. Additions live in `schema/openmaptiles-3.16.0.overrides.json`, and each one carries an upstream source citation.

---

## 1. Inspection findings

### Repo `~/Projects/rtt-web-planner`
- `main` has **no commits** and no files. Remote `origin` (github.com/kbekla/rtt-web-planner) is also empty.
- Nothing to keep and nothing to remove. We start with a clean layout (section 3).

### Workspace `~/rtt-map-factory`
| Path | Contents | Verdict |
|---|---|---|
| `tools/planetiler.jar` | 93 MB, sha256 `f310bd04…7e4d`. Fetched from `releases/latest`, which is v0.10.2 today. | **Keep.** Pin it by sha256 in `tools.lock` so a future "latest" can't swap it silently. |
| `tools/data/sources/*` | 1.4 GB of Planetiler auxiliary inputs: `water-polygons-split-3857.zip` (931 MB), `natural_earth_vector.sqlite.zip` (434 MB), `lake_centerline.shp.zip` (81 MB), `monaco.osm.pbf`. | **Keep, but move.** They landed under `tools/` because Planetiler was run from that directory and its default is `./data/sources`. Move them to `sources/ancillary/` and always pass `--download_dir` explicitly. Record their hashes because water polygons change daily. |
| `tools/data/tile_weights.tsv.gz`, `tools/data/tmp/` | Planetiler side files and an empty tmp dir | Move the weights file; delete tmp. |
| `output/monaco.pmtiles` | 420 KB. PMTiles v3, MVT, gzip, z0–14, 246 addressed tiles | A valid smoke artifact. Keep it as a fast CI-style fixture. |
| `data/ logs/ scratch/ sources/` | empty | Reuse them under the layout in section 3. |

### Build box
12 cores, 14 GB RAM, 425 GB free on NVMe. Java 21.0.12, osmium 1.19, GDAL 3.12.2, Node 22.22, Docker 29.8.
**Missing:** the `pmtiles` CLI (go-pmtiles v1.31.2), needed for `verify`, `show` and `extract`. There is also no style, glyphs or sprites yet.

### Upstream facts (checked with HEAD requests, nothing downloaded)
- Geofabrik `europe/united-kingdom-latest.osm.pbf`: **2.26 GB**, dated 2026-09-30. There is a matching `.md5`.
- Geofabrik `north-america/us/colorado-latest.osm.pbf`: 383 MB. The full-US URL returned a 502 at check time, which looks transient. Its size is about 11 GB (unverified).
- Latest releases: Planetiler v0.10.2, go-pmtiles v1.31.2, MapLibre GL JS v6.11.2, osm-bright-gl-style v1.11.

---

## 2. Key decisions (recommended; please confirm or override)

1. **Tile schema: OpenMapTiles, built by Planetiler's built-in profile.** It is already proven by the Monaco test. It is the most mature schema with ready-made open styles, and it includes `path`/`track` classes, which matter for trails.
   *Alternative:* Protomaps Basemaps schema (also Planetiler-based and PMTiles-native). It gives simpler styling but has fewer off-the-shelf styles. Switching later means restyling, not re-plumbing.
2. **Base style: a vendored copy of OSM Bright GL v1.11**, pinned to a commit with its LICENSE kept. A build step rewrites `sources`, `glyphs` and `sprite` to local URLs, so the vendored file is never hand-edited. Any RT&T-specific styling goes into a separate overlay file that is merged at build time.
3. **Glyphs and sprites are self-hosted.** Glyphs come from `openmaptiles/fonts` (Noto Sans, OFL) and are prebuilt into PBF ranges. Sprites are built from the style's SVGs with `spreet`, which is open-source and pinned.
4. **Viewer:** MapLibre GL JS (pinned) plus the `pmtiles` JS protocol, served by a static server that supports HTTP Range. There are no tokens and no `mapbox://` URLs.
5. **Tool pinning:** `tools.lock` records the version, URL and sha256 for planetiler.jar, the pmtiles CLI and spreet. `scripts/fetch-tools` installs them into `~/rtt-map-factory/tools/` and refuses on a hash mismatch. Java runs on the host. Docker is optional, not required.
6. **Input pinning:** every OSM extract is stored as `sources/osm/<region>/<YYYY-MM-DD>-<sha256[:12]>.osm.pbf`, with its replication timestamp read via `osmium fileinfo`. A build always runs from a **snapshot**, never from `-latest` directly. "Refresh" is an explicit separate command.
7. **RT&T trails/lanes:** a separate PMTiles file (`rtt-trails.pmtiles`) and a separate style source.
   - Built with **tippecanoe**, which writes PMTiles natively.
   - Stable IDs: the integer MVT feature `id` plus a string `rtt_id` property; the style uses `promoteId: "rtt_id"`.
   - Never merged into the OSM tileset, so the licences stay separable.
8. **Valhalla is untouched.** Optional later idea, not part of this plan: Valhalla could build from the same pinned PBF snapshot so the basemap and routing graph agree.

### Points that need your input
- **(A) ODbL exposure of RT&T data.** *(Answered 2026-10-02: see section 0, item 1.)* If any RT&T trail or lane geometry was *derived from OSM* (traced or snapped from it), it is likely a Derivative Database under ODbL share-alike, which conflicts with "proprietary". If it was surveyed or digitised independently, it is fine. This needs a yes/no from you, and legal advice if the answer is unclear.
- **(B) Meaning of "no Mapbox runtime dependency."** I propose it means: no Mapbox services, tokens, `mapbox://` URLs, `api.mapbox.com` calls, or `mapbox-gl` ≥ v2. BSD-licensed utility packages under the `@mapbox/` npm scope are allowed, because MapLibre itself depends on some of them (`@mapbox/vector-tile`, `point-geometry`, …). The acceptance test enforces exactly that definition.
- **(C) Contrasting region.** I recommend **Colorado first** (383 MB). It differs from the UK in TIGER-derived roads, dense `highway=track`/`path` coverage, mountains, and US admin and ref tagging, and it builds in minutes. Full US would follow. Full US at about 11 GB on 14 GB RAM should work with `--storage=mmap`, but expect several hours and about 100 GB of temp disk.
- **(D) Max zoom.** z14 with overzoom is the OpenMapTiles norm. Trail detail is still readable at z15–17 through overzoom.

---

## 3. Proposed repo structure

```
rtt-web-planner/
├── README.md
├── ATTRIBUTION.md            # every data source, licence, required credit string
├── Makefile                  # thin wrapper: `make region R=uk`, `make test R=uk`, `make serve`
├── tools.lock                # pinned tool versions + sha256
├── .gitignore                # *.pbf *.pmtiles *.mbtiles data/ out/ node_modules/ …
├── config/
│   ├── pipeline.env          # FACTORY_DIR=~/rtt-map-factory, heap sizes, threads
│   └── regions/
│       ├── monaco.yaml       # smoke fixture
│       ├── uk.yaml           # source URL, md5 URL, bbox, maxzoom, test probes
│       └── colorado.yaml
├── scripts/
│   ├── fetch-tools           # installs/verifies pinned tools into $FACTORY_DIR/tools
│   ├── fetch-region          # downloads + checksums + snapshots an extract
│   ├── build-region          # snapshot → Planetiler → PMTiles → manifest
│   ├── build-style           # vendored style + overlay → dist style.json (local URLs)
│   ├── build-assets          # glyphs + sprites
│   └── build-rtt-layer       # proprietary GeoJSON/GPKG → rtt-trails.pmtiles
├── styles/
│   ├── vendor/osm-bright/    # pinned upstream copy + LICENSE (read-only)
│   └── rtt/overlay.json      # RT&T layer styling + attribution
├── schema/
│   ├── openmaptiles-layers.json   # expected layers/fields (OMT 3.15) for validation
│   └── rtt-trails.schema.json     # contract for proprietary layer (rtt_id etc.)
├── viewer/                   # Vite + MapLibre + pmtiles protocol (dev/test viewer)
├── tests/
│   ├── schema/               # Node: decode sampled tiles, check layers/fields/probes
│   ├── render/               # Playwright: render fixed views, network audit, screenshots
│   ├── attribution/
│   └── fixtures/             # tiny GeoJSON for RT&T layer; golden screenshots (small PNGs)
└── docs/
    ├── PLAN.md               # this file
    └── ARCHITECTURE.md
```

**Factory layout** (`~/rtt-map-factory`, never committed):
```
tools/                 pinned binaries (planetiler.jar, pmtiles, spreet)
sources/osm/<region>/  dated, hashed PBF snapshots
sources/ancillary/     water polygons, natural earth, lake centerlines (hashed)
assets/                built glyphs + sprites
output/<region>/<build-id>/  <region>.pmtiles, manifest.json, build.log
output/<region>/current -> <build-id>   (symlink; only moved after tests pass)
scratch/               Planetiler tmp (--tmpdir), wiped per build
logs/
```

---

## 4. Build architecture

```
config/regions/uk.yaml ─┐
tools.lock ─────────────┤
                        ▼
fetch-region ─► sources/osm/uk/2026-09-30-<hash>.osm.pbf  (md5 checked, osmium fileinfo)
                        ▼
build-region ─► java -Xmx${HEAP} -jar planetiler.jar
                 --osm_path=<snapshot> --download_dir=sources/ancillary
                 --tmpdir=scratch/<id> --storage=mmap --output=…/uk.pmtiles
                 (no --download flag in normal builds: ancillary inputs must already exist)
                        ▼
              pmtiles verify + pmtiles show → manifest.json
                        ▼
build-style + build-assets ─► dist/style.json, glyphs/, sprites/
                        ▼
tests (schema, attribution, render, network audit, reproducibility)
                        ▼
              promote: output/uk/current → <build-id>
```

The **build ID** is a hash of: region config, PBF snapshot sha256, ancillary sha256s, tools.lock and the git commit. `manifest.json` records all of these plus timings and the PMTiles header summary. Any build can be audited or reproduced from its manifest.

**Scaling to more regions** means adding `config/regions/<name>.yaml` and nothing else. Later, a planet build becomes one more region, and per-region files can then be cut from it with `pmtiles extract` instead of being built separately.

**Resource estimate, UK:** 2.26 GB PBF. Expect roughly 15–30 min on this box with `-Xmx8g --storage=mmap`, about 20–30 GB of scratch, and a PMTiles output of roughly 1.2–1.8 GB. These are estimates that Phase 2 will measure.

---

## 5. Phased plan with acceptance tests

Each phase ends with its tests passing and a commit. Nothing is called "done" just because tiles render.

### Phase 0: Skeleton and hygiene (no downloads)
- Create the repo layout, `.gitignore`, README, ATTRIBUTION.md, tools.lock and `fetch-tools`.
- Install the pmtiles CLI and spreet. Move ancillary files into `sources/ancillary/` and hash them.

**Acceptance**
- [ ] `git ls-files` contains no file over 5 MB and no `*.pbf`, `*.pmtiles` or `*.mbtiles`. A pre-commit hook enforces this.
- [ ] `scripts/fetch-tools` is idempotent. A tampered binary fails the sha256 check.
- [ ] `pmtiles verify ~/rtt-map-factory/output/monaco.pmtiles` passes.

### Phase 1: End-to-end pipeline on Monaco (seconds per run)
- Write `build-region`, the manifest, `build-style`, `build-assets` and the viewer.
- Write all test suites against Monaco, so the harness is proven before any big download.

**Acceptance**
- [ ] `make region R=monaco` → PMTiles + manifest, one command, starting from an empty `output/`.
- [ ] **Integrity:** `pmtiles verify` passes. The header says MVT, z0–14, and its bounds lie inside the region bbox.
- [ ] **Schema:** every expected OMT layer is present in sampled tiles. Each sampled feature's properties are a subset of the documented fields with correct types. There are no unknown layers.
- [ ] **Attribution:**
  - PMTiles metadata `attribution` contains "© OpenStreetMap contributors" linking to `openstreetmap.org/copyright`, plus "© OpenMapTiles".
  - `style.json` source attribution matches.
  - The viewer shows it visibly with `compact: false` at desktop and mobile widths. A Playwright check confirms this.
- [ ] **No Mapbox:**
  - Grepping `dist/` and `viewer/` finds no `mapbox://`, `api.mapbox.com`, `access_token` or `mapbox-gl` dependency.
  - Playwright network audit: **zero requests to non-localhost hosts** while loading and panning the fixed views.
- [ ] **Render:**
  - Fixed views reach `idle` with no console errors, no missing-glyph or sprite-image warnings, and no 404s.
  - Screenshots match the goldens within a tolerance.
- [ ] **Reproducibility:** two builds with the same inputs produce the same build ID and the same PMTiles sha256. If Planetiler turns out not to be byte-deterministic, the fallback is per-tile hash equality via a `pmtiles`-based tile hash dump. Whichever holds gets documented, and I'll report it honestly.

### Phase 2: UK — first real milestone (needs your go-ahead to download 2.26 GB)
- Add `config/regions/uk.yaml` with probes:
  - central London z14 (buildings, housenumbers, POIs)
  - Edinburgh (place labels)
  - Snowdonia and the Lake District (paths, peaks, contours absent as expected)
  - Belfast (NI included)
  - Shetland (islands and water polygons)
  - the Thames estuary (coastline correctness)
- `make region R=uk && make test R=uk`.

**Acceptance:** all of the Phase 1 checks on UK data, plus:
- [ ] The snapshot md5 matches Geofabrik's `.md5`. The manifest records the replication timestamp.
- [ ] Every probe tile contains its expected layers and feature classes. For example, the Snowdonia z14 tile contains `transportation` with `class=path`, and `mountain_peak` contains Snowdon.
- [ ] No ocean flooding or missing land at the coastline probes, checked with screenshots.
- [ ] Recorded runtime, peak RSS and output size, with no OOM.
- [ ] A second UK build from the same snapshot reproduces (same criterion as Phase 1).
- [ ] `make serve` + a browser: a manual sign-off pass over 10 named views (listed in the test file).

#### Phase 2 results (2026-10-02)
Build `uk/7b3dd56c0e4d3b65`, promoted. Snapshot `2026-09-30-faaf4961d753.osm.pbf` (2,263,969,331 bytes; md5 matched Geofabrik; replication 2026-09-30T20:22:42Z, seq 1042).

| Measure | Value |
|---|---|
| Download + verify | 3 min |
| Planetiler build | 10 min 23 s (12 threads, `-Xmx6g`); about 10.5 min at 6 threads (`make repro`, including hashing) |
| Whole pipeline (build, style, all tests) | 11 min 21 s |
| Peak RSS (Java process) | 7.5 GB and 8.4 GB for the two measured 12-thread builds, on a 14 GB box. Up to ~0.9 GB of swap was used. No OOM. |
| Peak scratch disk | 11.0 GB, freed after the build |
| Disk kept | snapshot 2.26 GB; output 1.64 GB per build |
| PMTiles | 1,637,564,936 bytes, z0–14, sha256 `a1a1c57c…3a0ad` |
| Reproducibility | Three builds are byte-identical: two at 12 threads with different build IDs (only test probes changed), and one at 6 threads (`make repro`). |

- [x] Snapshot md5 matches Geofabrik's `.md5`. The manifest records the replication timestamp.
- [x] All Phase 1 checks pass on UK: integrity, header and bounds, schema across 15,690 sampled tiles, attribution, no Mapbox, zero external requests, and rendering on desktop and mobile.
- [x] 12 probe tiles pass:
  - London: 3 probes covering buildings, housenumbers, POIs, the Thames as `river`, and the city label.
  - Edinburgh: city label.
  - Snowdon: `path`, plus the peak "Yr Wyddfa".
  - Scafell Pike: `path`, plus the peak "Scafell Pike".
  - Belfast: 2 probes.
  - Shetland: 2 probes with `ocean`.
  - Thames estuary: 2 probes with `ocean`.
- [x] No ocean flooding or missing land at the coastline views: Thames estuary, Shetland, Land's End, Edinburgh/Forth.
- [x] Visual review of the 10 named views in `config/regions/uk.yaml`. The accepted renders are the goldens. Issues found are listed below.

Schema findings. Each override cites upstream OMT 3.16 in `schema/openmaptiles-3.16.0.overrides.json`.
- `boundary.disputed_name` is free text taken from the OSM relation name, for example `Louth/Down`. The YAML list is only Asian examples.
- `landuse.class` is an open set. It is `COALESCE(landuse, amenity, leisure, …)`, so a polygon admitted by `amenity=school` but tagged `landuse=education` gets class `education`. The UK shows 11 such classes.

Visual review findings. These are all style or scaffold issues, not data issues, and belong to the RT&T style work. They are tracked as S1–S6 in [STYLE-BACKLOG.md](STYLE-BACKLOG.md).
1. **No mountain peaks are drawn.** OSM Bright has no `mountain_peak` layer. The data is present, for example Yr Wyddfa 1085 m and Scafell Pike 978 m.
2. **Footpaths are very faint.** `highway-path` is a thin, light dash, so upland trail networks (Snowdon, Lake District) nearly disappear. Path names only appear from z15.5.
3. **Unstyled landuse classes.** Only residential, commercial, industrial, cemetery, hospital, school and railway are styled. `education`, `university`, `college`, `park`, `religious` and others fall back to the background colour.
4. **Admin boundaries are drawn along the coast.** County and unitary boundaries follow the low-water line and are not tagged `maritime`, so a heavy dashed line traces much of the coastline and out across mudflats (Thames estuary, Land's End, Forth).
5. **Areas outside the extract are blank land.** The Republic of Ireland and the Isle of Man appear as empty land at low zoom, which is expected for a UK-only extract.
6. **Generic POI icons.** POIs with no class-specific icon show as black dots (`circle_11` fallback), which is noticeable at high zoom.

#### Factory hardening (2026-10-02, between Phases 2 and 3)
- **Build identity, scheme 2.** The build ID hashes only the tile-producing inputs (`scripts/lib/build-id.mjs`):
  - region name, snapshot, ancillary inputs
  - the Planetiler jar and Java version
  - output arguments

  Probes, views, `bbox`, `required_layers`, heap and thread count are excluded. Unclassified config keys fail the build. `tests/repo/build-id.test.mjs` checks that each test-only edit keeps the ID and each tile input changes it. The scheme-2 rebuilds are byte-identical to the scheme-1 builds:
  - Monaco `97b3e038…`: sha256 `26bf9453…`
  - UK `c9f7aa62…`: sha256 `a1a1c57c…`

  A view edit in `uk.yaml` reused the UK build with no Planetiler run.
- **Telemetry.** Planetiler runs are sampled every 5 s into `telemetry.jsonl`. Peaks and means go into `manifest.json` under `stats.telemetry`. UK peaks:
  - CPU 76.0 °C (mean 68.7), NVMe 54.9 °C (mean 42.8)
  - iGPU 55 °C / 12 % / 488 MB, dGPU 51 °C / 1 % / 88 MB
  - system RAM 9.9 GB, swap 1.05 GB, scratch 11.0 GB, load 13.7

  Over the 9 min 21 s build, the sampler used 11.5 s of CPU time across 114 samples, about 0.2 % of the 12-core machine. This build was faster than the two Phase 2 builds.
- **mapwatch** (`scripts/mapwatch.mjs`, `make status|watch|report`). A read-only monitor with JSON and Markdown output. It shows the stage and status of builds and pipelines, detects aborted processes, and shows log tails. Failed and interrupted attempts are preserved in `logs/failures/`. `tests/repo/mapwatch.test.mjs` runs it against a fixture factory and verifies it changes nothing outside `reports/`.
- **Retired:** the first UK build `580ed65ae762167c`. It was byte-identical to the promoted build and had no unique evidence. Its manifest and log are kept in `logs/retired-builds/`.

#### Unattended factory (2026-10-02)
The A17 can now run unattended: a systemd user-service job queue, GREEN/AMBER/RED autonomy rules, a disk guard, a planet refusal, a dashboard (`make dashboard`) and an optional GPU-only local AI helper (qwen2.5-coder:3b on Ollama). See [FACTORY.md](FACTORY.md) for the design, rules, benchmark and restart/resume tests. Simulated crash, graceful restart and a real reboot mid-UK-build all resume correctly and produce byte-identical output. The reboot test found two cleanup defects, both fixed and re-verified. No full-planet build has been or will be started; it is refused by policy.

### Phase 3: RT&T proprietary layer (needs decision A)
- Lock `schema/rtt-trails.schema.json`, covering `rtt_id`, `kind`, `surface`, `status`, `version` and so on.
- Build from a fixture GeoJSON and add it as a separate source in the style.

**Acceptance**
- [ ] Every input feature has a unique, non-empty `rtt_id`. The build fails on duplicates or missing IDs.
- [ ] Rebuilding after editing one feature changes only that feature. All other `rtt_id`s and geometries are unchanged, checked by diffing a tile-decode.
- [ ] `queryRenderedFeatures` in the viewer returns `rtt_id`, and feature-state highlighting works through `promoteId`.
- [ ] The RT&T source carries its own attribution string. The OSM tileset contains zero RT&T features.

### Phase 4: Contrasting region (Colorado, then full US)
- Add a config file only. **Pass criterion: no pipeline code changes required.** Any change that is needed gets made generically and re-tested on UK.

**Acceptance**
- [ ] The same suite passes on Colorado, with probes covering Denver, the Rocky Mountain NP trails, interstate shields and refs, and county and state boundaries.
- [ ] UK re-run still passes. That is the regression check.
- [ ] Full US is a separate go/no-go after Colorado, based on the measured UK and Colorado resource numbers.

### Phase 5: Hardening (later)
- A refresh workflow (new snapshot → build → test → promote → keep N previous builds).
- A production serving recommendation: PMTiles on static/object storage or Caddy with Range support.
- A planet feasibility estimate.
- A Valhalla snapshot-alignment note.

---

## 6. Explicitly out of scope
- Any change to Valhalla or to the RT&T mobile app repo.
- Planet builds, hosting/CDN setup, contour lines and hillshade. Terrain can be a later open-data phase.

## 7. Next action after review
Phase 0 and Phase 1 need no large downloads, so I can start them immediately on approval. Phase 2 starts only after you confirm the UK download.
