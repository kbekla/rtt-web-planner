# Scout Europe Phase 1 independent benchmark

## Gate

Phase 1 is an independent public-source discovery/classification pass followed by one post-completion comparison with the private TET corpus. The discovery run must have `reference_run_id = NULL`; the discovery API and CLI reject reference-run inputs. The benchmark command refuses any run that is not `COMPLETE` or that was created with a reference. No TET geometry, bounds, candidate count, route metadata or evidence may be read by the discovery stage.

The only currently identified jurisdiction in the registered A17 Scout real-source store is Belgium (`BE`), from the explicitly registered `tet-belgium-private-discovery` source. This workload scope is read from source/run jurisdiction metadata, not geometry. The prior Belgium OSM discovery run has a TET reference and is a legacy comparison-assisted run; it is not a valid Phase 1 baseline and remains unchanged.

Every public-data source must independently be registered and approved for private processing. Europe source-catalogue entries are disabled leads until dataset, authority, licence and use are verified. The already-pinned Belgium Geofabrik/OSM snapshot is the only existing full-country public network currently approved in the registered store. OSM can support physical/network discovery, not legal access. No other country is in scope.

## Operations

Create an independent run without any TET option:

```sh
npm run scout:geo -- discover create \
  --run-id be-phase1-independent-<version> \
  --snapshot-id <approved-pinned-Belgium-snapshot> \
  --country-code BE --region-id BE \
  --approved-by Karl --approval-scope "Belgium independent public-source Phase 1 benchmark"
```

Run only when live shared factory admission is freshly VERIFIED and the host governor permits it:

```sh
npm run scout:geo -- discover process --run-id be-phase1-independent-<version>
```

Only after status is `COMPLETE`, run the final comparison:

```sh
npm run scout:geo -- europe benchmark \
  --independent-run-id be-phase1-independent-<version> \
  --reference-run-id <registered-private-TET-reference-run>
```

The output is atomically written mode 0600 under the private Scout store's `benchmarks/` directory. It contains source cross-references and must remain on the private SSD. Phase 1 never starts Phase 2 automatically. The report records `phase2_release: NOT_APPROVED`; Scout must stop after the report and wait for Karl's explicit approval.

## Measurement semantics and limits

The present benchmark matches exact registered OSM way-part identities cited by the independently processed reference features. A TET feature with all cited OSM parts selected is `exact`; a subset is `partial`; no shared part is `unmatched`. `parallel` and `ambiguous` stay `null` until a separately validated post-run geometry adjudicator exists; null means not measured, not zero. Missing public way-part support is reported conservatively and never repaired from TET.

Physical-character agreement compares the existing private reference segmentation label with independently discovered physical classification only. TET is not an expected legal/access state. The report therefore leaves GREEN/RED/temporary agreement and authoritative upgrades/downgrades not comparable unless a separate, approved current RT&T/authoritative state corpus exists. OSM-only credible candidates with no access evidence resolve to ORANGE; OSM tags do not establish permission or prohibition. No ORANGE item asks Karl to decide foreign road law.

This benchmark is not a canonical comparison, legal audit, routing test, or publication step. `NOT_COMPARED` remains distinct from `NEW`. Ordinary public-road segments stay ordinary roads rather than Scout lanes. Private source provenance and benchmark links never enter mobile/public artefacts; required dataset acknowledgements remain separate and general.

## Phase 2 release gate

After the Phase 1 report, stop. Do not launch wider discovery, even within the represented jurisdiction set, until Karl explicitly approves that report. Approval scope is limited to the jurisdictions represented by the A17 benchmark set; England, Wales and Isle of Man stay excluded, and Scotland remains separate. Phase 2 must use verified public/authoritative sources without TET as a discovery, routing or legal source, and must preserve source/licence gates and private provenance. No such Phase 2 job is started by the benchmark command.
