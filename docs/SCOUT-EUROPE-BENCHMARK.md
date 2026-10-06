# Scout Europe Phase 1 independent benchmark

## Gate

Phase 1 is an independent public-source discovery/classification pass followed by one post-completion comparison with the private TET corpus. The discovery run must have `reference_run_id = NULL`; the discovery API and CLI reject reference-run inputs. The benchmark command refuses any run that is not `COMPLETE` or that was created with a reference. No TET geometry, bounds, candidate count, route metadata or evidence may be read by the discovery stage.

The current blind benchmark is Norway (`NO`). Its independent run uses only the explicitly registered and approved Statens vegvesen NVDB road-link API snapshot. The Norway scope and viewport come from NVDB country coverage and imported NVDB network extent, never from the TET file. The Norway TET file is not opened, hashed, parsed, used for bounds, or matched until the independent NVDB run is `COMPLETE`. Existing Belgium state is separate and is not used to target Norway discovery. The approved Norway work is a specific blind-benchmark authorization, not approval for wider European discovery.

Every public-data source must independently be registered and approved for private processing. Europe source-catalogue entries are disabled leads until dataset, authority, licence and use are verified. Norway uses the official NVDB API only; OSM is explicitly prohibited as fallback or gap-filler. NVDB road-link presence supports physical/network research, not motorcycle access. Access remains unknown/ORANGE without suitable independent legal evidence, and routability remains unknown unless separately validated. No other country is in scope.

## Operations

For Norway, register and approve the official source in the private Norway Phase 1 store, acquire and import a countrywide NVDB snapshot, then create an independent run without any TET option:

```sh
npm run scout:geo -- source register-nvdb-no
npm run scout:geo -- source approve --source-id no-nvdb-vegkart --by Karl --scope "Norway Phase 1 independent public-source benchmark; NVDB only; no OSM or TET before completion"
npm run scout:geo -- network acquire --source-id no-nvdb-vegkart --snapshot-id <pinned-Norway-NVDB-snapshot>
npm run scout:geo -- network import --snapshot-id <pinned-Norway-NVDB-snapshot>
```

The V4 adapter stores the exact paginated API response bundle, retrieval timestamps, and SHA-256. NVDB is live and does not promise a transactionally consistent point-in-time snapshot; the bundle is identified as a live retrieval window. It normalizes official link geometry into Scout's private network-edge store. NVDB publishes compound EPSG:5973 coordinates (ETRS89 / UTM 33N with NN2000 height); the adapter transforms horizontal coordinates with pinned Proj4js extended Transverse Mercator parameters and retains the original WKT privately. It omits source height from 2D navigation geometry rather than mislabelling NN2000 as ellipsoidal height. The numerical projection tests cover western/eastern/high-latitude Norway coordinates to centimetre-level transform tolerance; this is not a claim of centimetre-level datum accuracy. Required NLOD attribution is retained at dataset acknowledgement level, separate from per-lane provenance. This adapter does not enable NVDB restrictions.

```sh
npm run scout:geo -- discover create \
  --run-id no-phase1-nvdb-<version> \
  --snapshot-id <pinned-Norway-NVDB-snapshot> \
  --country-code NO --region-id NO \
  --approved-by Karl --approval-scope "Norway Phase 1 independent public-source benchmark; NVDB only; no OSM or TET before completion"
```

```sh
npm run scout:geo -- discover create \
  --run-id be-phase1-independent-<version> \
  --snapshot-id <approved-pinned-Belgium-snapshot> \
  --country-code BE --region-id BE \
  --approved-by Karl --approval-scope "Belgium independent public-source Phase 1 benchmark"
```

Run only when live shared factory admission is freshly VERIFIED and the host governor permits it:

```sh
npm run scout:geo -- discover process --run-id no-phase1-nvdb-<version>
```

Only after status is `COMPLETE`, run the final comparison:

```sh
npm run scout:geo -- europe benchmark \
  --independent-run-id no-phase1-nvdb-<version> \
  --reference-run-id <registered-private-Norway-TET-reference-run>
```

The output is atomically written mode 0600 under the private Scout store's `benchmarks/` directory. It contains source cross-references and must remain on the private SSD. Phase 1 never starts Phase 2 automatically. The report records `phase2_release: NOT_APPROVED`; Scout must stop after the report and wait for Karl's explicit approval.

## Measurement semantics and limits

The benchmark denominator is the explicitly imported TET route features which contain any non-ROAD section under Scout's post-completion route segmentation. Road-only features are reported separately and excluded from corridor rediscovery. Confirmed exact/partial rediscovery requires shared registered-network edge-part identity between the independently selected NVDB/OSM candidates and those non-ROAD route sections. Competing network edges that contain a selected candidate are reported as `ambiguous`, never promoted to a confirmed match. `parallel` remains `null` until a separately validated parallel-geometry adjudicator exists. Misses receive conservative source-coverage or geometry-failure reasons; TET never repairs or guides the independent result. Route class/distance and UNKNOWN-reason summaries are reported separately so the route feature is not mistaken for a single trail.

Physical-character agreement compares the existing private reference segmentation label with independently discovered physical classification only. TET is not an expected legal/access state. The report therefore leaves GREEN/RED/temporary agreement and authoritative upgrades/downgrades not comparable unless a separate, approved current RT&T/authoritative state corpus exists. NVDB road links provide network/existence evidence only; this adapter does not use NVDB as restriction or motorcycle-access evidence. Unknown access remains ORANGE. No ORANGE item asks Karl to decide foreign road law.

This benchmark is not a canonical comparison, legal audit, routing test, or publication step. `NOT_COMPARED` remains distinct from `NEW`. Ordinary public-road segments stay ordinary roads rather than Scout lanes. Private source provenance and benchmark links never enter mobile/public artefacts; required dataset acknowledgements remain separate and general.

## Phase 2 release gate

After the Phase 1 report, stop. Do not launch wider discovery, even within the represented jurisdiction set, until Karl explicitly approves that report. Approval scope is limited to the jurisdictions represented by the A17 benchmark set; England, Wales and Isle of Man stay excluded, and Scotland remains separate. Phase 2 must use verified public/authoritative sources without TET as a discovery, routing or legal source, and must preserve source/licence gates and private provenance. No such Phase 2 job is started by the benchmark command.
