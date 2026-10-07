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

NVDB corridor grouping commits complete sequence batches and their cursor in
the same SQLite transaction. The worker yields to the Node event loop between
committed batches so process signals and factory-priority requests can be
observed. Progress output includes coarse timings for sequence-page lookup,
source-row reads, JSON parsing, derivation/writes, and commits; these timings
help distinguish query overhead from the deterministic topology work without
changing identity rules. Cursor pagination uses a separate range-seek query
after the first page; an optional-cursor `OR` in the indexed `DISTINCT` query
can force repeated scans from the beginning. After an unclean process exit, restart only after
SQLite WAL recovery and the shared admission layer have established that the
old owner is stale; the stage resumes from its last committed sequence.
The Norway OSM corridor builder reads the run's explicit pre-freeze TET
exclusion marker and omits discovery-hint joins and prior-reference lineage.
Its source support and queue state therefore come only from the pinned NVDB
and OSM snapshots.

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

### Phase 1 NVDB scope correction (2026-10-07)

The pinned `vegnett/api/v4/veglenkesekvenser` artifact is a road-network
skeleton, not the NVDB road-object/property catalogue. Direct inspection of
the frozen 3,104,901-link artifact found approximately 326,281.5 km of network,
but zero populated `vegkategori`, `trafikantgruppe`, road reference, road name,
or surface attributes in the normalized links. Its raw `typeVeg` class and
official geometry/topology can support network identity and physical network
presence; they do not establish asphalt/gravel, road ownership, or motorcycle
access. Missing fields remain missing. Do not infer a gravel road from a
`Traktorveg`/forest-road label, and do not infer motorcycle permission from
any road-link class.

The Phase 1 `514,859 candidate pieces` count is an adapter-selection count, not
a lane count. Its reported type breakdown was 209,682 `Gang- og sykkelveg`
pieces (~12,576.8 km), 149,366 `Fortau` (~7,312.1 km), 139,755 `Gangveg`
(~4,945.4 km), 5,553 `Sti` (~1,485.9 km), 5,691 `Traktorveg` (~1,273.5 km),
3,999 `Sykkelveg` (~255.1 km), and 813 `Gågate` (~28.2 km). The full-link
snapshot separately reports 2,259,612 `Enkel bilveg` links (~284,627.2 km),
5,691 `Traktorveg` links (~1,286.9 km), and 5,553 `Sti` links (~1,511.4 km).
The route/candidate-piece and full-link lengths are distinct measurements and
must not be mixed. Pedestrian/cycle/footway objects remain private network
context/catalogue evidence and must not inflate rider-facing lane counts.
Ordinary `Enkel bilveg` remains ordinary navigation context, including when
the road-system category is private. Explicit tractor/forest/other engineered
non-standard road types may become `SCOUT_RESEARCH_REQUIRED` private leads;
they are `NOT_PROJECTED` to GREEN or ORANGE until separate evidence supports
that product decision. The all-network snapshot remains available for road
matching and context.

The Phase 1 freeze and its original counts/checksum are immutable. This
correction changes the code and interpretation for a separately versioned
future run; it does not rewrite old discovery rows, frozen Phase 2 data, or the
one-time benchmark. In particular, no Phase 2 output or benchmark statistic
has been retuned using TET.

### Official NVDB road-object enrichment candidates

NVDB Les V4 exposes a separate data catalogue and road-object API. Object
records have IDs/versions, validity period, properties and network
`stedfesting`; the Uberiket API offers ordered NDJSON streams with a resumable
`start` cursor and object-change events. The stream example's
`stedfesting[].id` is not assumed to be `veglenkesekvensid`: an adapter must
validate the current object-type location schema and map its linear reference
to the pinned network sequence/positions before joining. Proximity alone is
not a join. The source object snapshot is additive and append-only; it cannot
rewrite the Phase 1 link artifact.

Scout now records these official object types as **disabled candidates**, not
active data sources:

| NVDB type | ID | What the documented semantics can contribute | What it cannot decide alone | State |
|---|---:|---|---|---|
| `Vegdekke` | 241 | Surface/material evidence, when a current code value and linear join are validated | Motorcycle access; absence is not gravel | Held for current catalogue/value-map and coverage validation |
| `Trafikkreguleringer` | 856 | A restriction claim for motor traffic or pedestrians/cyclists; documented optional time-range and free-text exception note | Motorcycle prohibition from ambiguous text, or permission from absence | Held for code, vehicle applicability, direction/extent and time validation |
| `Vegstengning` | 485 | A periodic/dated road-closure candidate | Permanent restriction or motorcycle applicability by guess | Held for current date/cause and vehicle semantics |
| `Vegsperring` | 607 | Physical road-block evidence; route-dataset schema includes type/function, network-link references and conditional closed-time attributes | Legal prohibition or permission from barrier presence | Held for current type, linked road IDs and schedule interpretation |
| `Vegbom` | 23 | Physical gate/maintenance inventory | Whether it is currently closed; the type is recorded whether normally open or closed, so it cannot alone establish route closure | Context-only; held for any state-feed/road association |
| `Gjennomkjøring forbudt` | 913 | A no-through-traffic restriction candidate; published NVDB product specification describes vehicle applicability, direction, weekday and a motorcycle-exception field, plus a linked end object | A corridor-wide stop unless the paired extent, direction, schedule and current values are resolved | Held for current catalogue, relation completeness and applicability validation |

The official NVDB catalogue portal showed version `2.46_1039` when checked on
2026-10-07. That is a research observation, not a version to hard-code: each
acquisition must fetch the then-current version, per-type definition, code
lists, and checksums. The object API is public, but public access is not a substitute for the
current NVDB catalogue definition, licensing record, code list, update
semantics, and interpretation review. The existing NVDB source records NLOD
1.0 and its dataset-level attribution; the object adapter must pin those
terms/attribution with each acquired object-type definition. No object data
has been downloaded or ingested in this correction. No restrictions have been
inferred and motorcycle access remains UNKNOWN absent separately qualified
evidence.

Any future acquisition is a separate heavy-work stage under the shared A17
lease, with one type per checkpoint stream. It must pin the parent link
snapshot checksum, current catalogue version and type-definition SHA-256;
store each raw page/object batch and its checksum with the stream cursor in
one durable transaction; yield before a request and after a committed batch;
verify the partial artifact on restart; and append normalized evidence in a
separate layer. Only after a successful validated join may surface objects
support physical surface, or restriction objects support legal/temporal
claims. A failed or unavailable type stays held and does not block independent
types. The registry's planning function therefore returns `REVIEW_REQUIRED`
and will not acquire objects by itself.

Official references used for these semantics and API mechanics:

- [NVDB Les V4 data catalogue](https://nvdb-docs.atlas.vegvesen.no/nvdbapil/v4/Datakatalog/) and its [type-definition endpoint pattern](https://nvdbapiles.atlas.vegvesen.no/datakatalog/api/v1/vegobjekttyper/)
- [NVDB Les V4 road-object API](https://nvdb-docs.atlas.vegvesen.no/nvdbapil/v4/Vegobjekter/)
- [NVDB Les V4 Uberiket streaming and events](https://nvdb-docs.atlas.vegvesen.no/nvdbapil/v4/Uberiket/)
- [NVDB product specification: `Vegdekke` 241](https://tfprod1.sintef.no/datakatalog/eksport/produktspesifikasjon-2.42/241.pdf)
- [NVDB Rutedatasett 2.0 object semantics](https://dokument.geonorge.no/produktspesifikasjoner/nvdb-rutedatasett/Versjon%202.0/Rutedatasett.html)
- [Current NVDB Datakatalog portal and object-type list](https://datakatalogen.atlas.vegvesen.no/)
- [NVDB product specification: `Vegbom` 23](https://tfprod1.sintef.no/datakatalog/eksport/produktspesifikasjon/23.pdf)
- [Statens vegvesen data delivery/object list](https://www.vegvesen.no/fag/teknologi/nasjonal-vegdatabank/registrere-data-i-nvdb/objektliste/)

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
attached to this run, motorcycle access and routability remain UNKNOWN. A
credible, independently researched lane may project to ORANGE; an NVDB road
type or road-network match by itself is not enough to make a road a rider
lane. Ordinary roads remain ordinary roads, and neither RED nor GREEN is
manufactured.

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
