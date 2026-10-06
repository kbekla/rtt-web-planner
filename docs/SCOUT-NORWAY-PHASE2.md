# RT&T Scout — Norway Phase 2

This is the owner-authorized, private Norway Phase 2 workflow. It uses the
checksum-pinned Statens vegvesen NVDB bundle and a separately pinned Geofabrik
Norway OSM extract. The workflow does not load any route corpus during
independent discovery. The N.gpx benchmark file is inaccessible to the
operator until the Phase 2 freeze has been written and verified.

All processing remains on the private SSD, uses the shared A17 heavy-work
admission lease, yields to factory intent, and writes no canonical or public
map data. Stop and resume by re-running the same stage command; stage cursors
are stored in the private Scout database. Never run two Norway stages at once.

## Independent Phase 2 workflow

Run these commands from the Scout worktree on the A17:

```sh
npm run scout:norway-phase2 -- prepare
npm run scout:norway-phase2 -- import-nvdb
npm run scout:norway-phase2 -- acquire-osm
npm run scout:norway-phase2 -- import-osm
npm run scout:norway-phase2 -- create-runs
npm run scout:norway-phase2 -- discover --run-id norway-phase2-20261006-nvdb
npm run scout:norway-phase2 -- discover --run-id norway-phase2-20261006-osm
npm run scout:norway-phase2 -- nvdb-corridors
npm run scout:norway-phase2 -- osm-corridors
npm run scout:norway-phase2 -- reconcile
npm run scout:norway-phase2 -- status
```

Each heavy command first checks host admission and acquires the deployed
machine-wide lease. `BLOCKED_SHARED_ADMISSION` means wait and rerun later. A
yielded job preserves its checkpoint. `prepare` reuses the exact NVDB raw
response artifact whose Phase 1 SHA-256 is
`2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1`; it
does not reopen the Phase 1 Scout database or touch TET data. Geofabrik resolves
the current Norway extract to a dated URL before download, hashes the downloaded
PBF, and pins that artifact before import. OSM attribution is retained as a
dataset-level acknowledgement, not per-corridor public provenance.

When every independent stage is complete, commit the exact code state and
freeze it using that commit SHA:

```sh
git rev-parse HEAD
npm run scout:norway-phase2 -- freeze --commit <40-character-commit-sha>
npm run scout:norway-phase2 -- status
```

The freeze records the code SHA, both source checksums, run/stage completion,
database SHA-256 and product projection. The frozen SQLite database is
read-only for all subsequent benchmark work. If any database bytes change,
benchmarking fails closed.

## One-time post-freeze benchmark

Only after `phase2-frozen.json` exists and its database checksum verifies may
the single authorized comparison be run:

```sh
npm run scout:norway-phase2 -- benchmark --tet-file /home/karl/Downloads/N.gpx
```

The tool stores private per-feature checkpoints and a single completion
report. Re-running a completed benchmark is refused. An interrupted benchmark
can resume only against the same frozen database and same comparison-file
checksum. TET contributes no discovery, physical-character, legal-access or
routing evidence, and cannot change frozen Phase 2 output.

## Physical and product semantics

The checked NVDB Les V4 response has `veglenkesekvensid`, ordered
`veglenkenummer`/`segmentnummer` link records, `startposisjon`/
`sluttposisjon`, and `startport`/`sluttport`; each sequence's `porter` map
connects port IDs to node IDs. The normalizer also preserves link type,
`typeVeg`, traffic-group/detail fields, road-system reference, names, geometry
quality/capture metadata, dates, original WKT, and the complete source record.
The API's segment example exposes start/end node IDs and positions directly.
These are source topology and linear-reference identities, not independent
proof of road access or motorcycle permission. Sequence membership and
matching port-node IDs lead corridor grouping; endpoint geometry is only an
integrity guard. Missing positions stay null rather than being coerced to zero.
NVDB identity and topology are retained per original road-link observation.
Derived NVDB
corridors group only ordered sequence continuations with matching topology;
the original link geometries remain separate. OSM way/node IDs, tags, version,
geometry, licence and snapshot checksum are preserved independently.

After the freeze, the benchmark samples each comparison line at approximately
20 m intervals and queries both complete independently imported networks via
the spatial index. An edge is considered physical support only within the
configured 12 m geometric envelope and 25 degree alignment envelope. Every
aligned edge in that envelope competes; Scout does not simply pick the
nearest. Distinct plausible footpoints more than 1.5 m apart are AMBIGUOUS.
Length-weighted `reconstructed_km` counts unambiguous support only;
`ambiguous_km` and `unresolved_km` are reported separately. This evaluates
physical network correspondence, not Scout off-road candidate labels.

Paved/gravel/unsealed/forest/mountain/other engineered physical character is
separate from ordinary-navigation versus potential-special-route role. Surface
never establishes legal access. NVDB or OSM agreement can strengthen physical
existence only. With no qualifying Norwegian lane-access or restriction data
attached to this run, motorcycle access and routability remain UNKNOWN;
credible special routes project to ORANGE, ordinary roads remain ordinary
roads, and neither RED nor GREEN is manufactured.

## Norway access-source research and limits

Official Norwegian material reviewed for the jurisdiction model includes the
Road Act's distinction between public and private roads, the Outdoor
Recreation Act's rule that a private-road owner may prohibit motor-vehicle
traffic (including by signs or a barrier), and the Motor Traffic Act's scope
for motor traffic on uncultivated land. The latter includes roads not built
for ordinary cars and roads not cleared for car traffic in winter; motor
traffic off-road is generally prohibited except for specified purposes and
permissions. A mapped gravel or forest road is therefore not, by itself,
enough to decide motorcycle access. The agency's API documentation describes
the road graph's sequence/port/node and positional semantics and an event
endpoint for changes to segmented sequences; that endpoint could support
future Watchkeeper refresh but is not activated in this calibration run.
These laws and API events are jurisdiction/data context, not a validated
machine-readable, corridor-level motorcycle-access/status feed. They do not
resolve access on a particular link. Relevant official references:

- [Road Act, chapter VII](https://lovdata.no/dokument/NL/lov/1963-06-21-23/kapvii)
- [Outdoor Recreation Act, English text](https://www.regjeringen.no/en/documents/outdoor-recreation-act/id172932/)
- [Motor traffic in uncultivated land and watercourses Act](https://lovdata.no/dokument/NLE/lov/1977-06-10-82)
- [NVDB dataset catalogue](https://dataut.vegvesen.no/nb/dataset/nasjonal-vegdatabank)
- [Static traffic information in NVDB](https://dataut.vegvesen.no/en/dataset/trafikkinformasjon-i-nvdb)
- [NVDB Les V4 road-network documentation](https://nvdb-docs.atlas.vegvesen.no/nvdbapil/v4/Vegnett/)
- [NVDB Les V4 road-network change events](https://nvdb-docs.atlas.vegvesen.no/nvdbapil/v4/Endringer/)
- [Miljødirektoratet: driving on bare ground and roads classified as uncultivated land](https://www.miljodirektoratet.no/ansvarsomrader/friluftsliv/motorferdsel-i-utmark/regler-for-motorferdsel-i-utmark/kjore-pa-barmark/)
- [Miljødirektoratet: motor traffic on private roads](https://www.miljodirektoratet.no/ansvarsomrader/friluftsliv/friluftsliv-og-allemannsretten/ofte-stilte-sporsmal-om-allemannsretten/)

NVDB is an authoritative road-network source under NLOD 1.0. Its presence or
private/public road category is not treated as permission for motorcycles.
Statens vegvesen also publishes “Static traffic information in NVDB” under
NLOD, with public API resources and a continuously updated catalogue entry;
its listed contents include traffic signs, regulations and diversion routes.
This is a promising authoritative restriction-source family, but this run
does not ingest it: the catalogue entry alone does not establish the specific
sign/object semantics, direction and extent of effect, vehicle applicability,
effective dates, or reliable corridor linkage needed for deterministic RED
or temporary-closure decisions. Those fields must be validated against the
NVDB data catalogue and product specification per object type before an
adapter is enabled. Consequently no machine-read restriction is activated
here, and motorcycle access remains UNKNOWN absent separately qualified
corridor evidence. Source automation/reuse is not inferred solely from a
catalogue listing; the source is held for adapter-level semantic validation.

## Frozen Phase 1 baseline

The Phase 1 run `no-phase1-nvdb-20261006` remains the immutable baseline:
NVDB SHA-256 `2dbca12351f15cffcdc79a0c08a6c2a768bc8434ebb34f1e155c6120f77d46d1`,
3,104,901 edges examined, 514,859 candidate pieces, 17 benchmark features,
zero exact/partial identity matches, all 17 with ambiguous candidate-edge
support, and 505,228 independent candidate pieces outside those comparisons.
Route-processing comparison was 7,137.013 km ROAD and 1,695.940 km UNKNOWN;
UNKNOWN reasons were no network match 988.746 km, competing network classes
469.111 km, insufficient tags 126.684 km, and interval support uncertainty
111.398 km. The 0/17 score means identity was unresolved, not that the route
was absent. Phase 2 reports must not rewrite these Phase 1 figures.
