# Scout operator workflow

## Normal Karl workflow: open the desktop app

On the A17, launch **RT&T Scout** from Ubuntu’s Applications view, then pin it with **Add to Favorites** if desired. The launcher opens the local operator in the browser. It uses the existing Scout database, source approvals, persistent region plans and processing pipeline; opening the app only reads status and does not start a job.

To prepare an approved regional batch, select exactly one route file, enter its country code/region and source identity, and explicitly answer each permission question. For a TET/community discovery file, choose **Private research: Yes**, **Redistribution: No**, **Derived/public use: No**, and **Legal-access evidence: No**. Scout derives the route checksum/bounds and resolves a dated Geofabrik extract. Review those details, then choose **Approve for private Scout processing**. Approval records only the permissions selected; it does not approve legal access, canonical import or publication.

The run appears in the same window. Choose **Process approved region** when ready. Processing can be closed and resumed because each stage is persisted. **Open Review** starts or reuses a loopback-only reviewer for a completed run. **Status**, **Details**, factory/admission state and pending notifications are available without starting heavy work. **Exit** closes the operator service while preserving jobs. A RED/AMBER dialog explains launch failures instead of leaving an empty terminal.

The installed desktop entry calls a stable user wrapper which verifies the expected `/home/karl/rtt-map-factory/worktrees/codex-scout` checkout and `codex/scout` branch. It never selects `/home/karl/rtt-map-factory/runner/repo`. The UI binds to `127.0.0.1`; it has no public listener. Scout processing still requires explicit plan approval and the shared factory-priority resource admission. To install or repair the per-user launcher, run `scripts/scout/install-launcher.sh` from the expected worktree; ordinary app launch does not require a terminal or root.

The advanced `scout-geoctl` and `npm run scout:geo` interfaces below remain available for diagnostics and administration. They use this same state and pipeline.

`scout-geoctl` is the supported private operator boundary for a source batch. It registers explicit source manifests, requires recorded approval before route import or regional network acquisition/import, pins all network material by version and SHA-256, persists resumable processing state, and opens a read-only loopback reviewer for a selected run. It does not scan directories or crawl arbitrary sites.

Set the two private roots in the calling environment. Both must be outside the repository/public tree and must not be symlinks:

```sh
export SCOUT_GEO_ROOT=/path/to/private/scout/state
export SCOUT_RAW_ROOT=/path/to/private/scout/raw
```

Use one manifest file per source. A route source describes its private-use authority and coverage; a network source additionally includes a pinned provider extract. The network registry is provider-neutral in its stored shape (`network_extract.provider` selects an adapter); the initial acquisition adapter is Geofabrik only. Example shape (replace every `synthetic-*` value with an explicitly approved real source and verify its licence/terms before registration):

```json
{
  "source_id": "synthetic-route-hints",
  "name": "Synthetic route hints",
  "type": "route-file",
  "organisation": "fixture",
  "expected_formats": ["gpx", "kml", "geojson"],
  "coverage": {"countries": ["ZZ"], "regions": ["ZZ-test"]},
  "jurisdiction_ids": ["ZZ-country"],
  "location": "explicit local file selection",
  "adapter_version": "route-import-v1",
  "licence": {"name": "synthetic fixture", "version": "1"},
  "reuse": {"private_processing": true, "redistribution": false, "derived_public_use": false},
  "roles": {"discovery_only": true, "physical_existence": false, "legal_access": false, "routing_network": false, "public_reuse": false, "jurisdiction_boundaries": false},
  "update": {"mechanism": "explicit operator import"},
  "attribution": "synthetic fixture",
  "rate_limits": {"requests_per_minute": 0}
}
```

A network manifest uses the same required registry fields, sets `roles.routing_network` and `reuse.private_processing`, and supplies `network_extract` with `provider`, exact HTTPS `url`, fixed `version`, stable `snapshot_id`, expected lowercase/uppercase SHA-256, and ISO `country_code`. The first adapter accepts only version-pinned `.osm.pbf` URLs on `download.geofabrik.de`; `latest` is refused. The source licence name/version and attribution must be explicit. A route hint is never legal access evidence, and OSM physical tags do not establish motorcycle permission.

## Normal sequence

1. Register the exact reviewed manifests and record operator approval with a scoped reason:

   ```sh
   npm run scout:geo -- source register --manifest /private/manifests/route.json
   npm run scout:geo -- source register --manifest /private/manifests/network.json
   npm run scout:geo -- source approve --source-id approved-route-id --by 'Karl' --scope 'Private Scout discovery for the specifically approved source file'
   npm run scout:geo -- source approve --source-id approved-network-id --by 'Karl' --scope 'Private regional network analysis for the pinned extract'
   ```

2. Import only the named file supplied by the operator. Import is checksum-aware and safe to repeat:

   ```sh
   npm run scout:geo -- import --source-id approved-route-id --file /explicit/path/selected.gpx
   ```

3. Acquire and import the registered network extract. The acquisition uses HTTPS range resume, validates the complete checksum before pinning the artifact, and stores it inside the private Scout root. Conversion uses `osmium`, record-boundary checkpoints, and the shared factory-priority heavy-work lease:

   ```sh
   npm run scout:geo -- network status
   npm run scout:geo -- network acquire --source-id approved-network-id --snapshot-id pinned-snapshot-id
   npm run scout:geo -- network import --snapshot-id pinned-snapshot-id
   npm run scout:geo -- network status --snapshot-id pinned-snapshot-id
   ```

   Retry a command after exit 75 or process interruption. Completed artifacts are checksum-verified and reused; completed OSM records are skipped on restart, while stable OSM IDs make a replay around the last checkpoint idempotent. A provider, checksum, permission, host-safety, or factory-admission uncertainty blocks rather than guessing.

4. Create one immutable regional run with its viewport and recorded approval scope, then process it:

   ```sh
   npm run scout:geo -- run create --run-id region-20261004-a --source-id approved-route-id --snapshot-id pinned-snapshot-id --country-code CC --region-id region-id --viewport west,south,east,north --approved-by Karl --approval-scope 'Private Scout discovery for the specifically approved source file' --title 'Region private Scout review'
   npm run scout:geo -- process --run-id region-20261004-a
   npm run scout:geo -- run status --run-id region-20261004-a
   ```

   Processing invokes the frozen classifier version recorded in the software, persists each observation state/checkpoint, and resumes completed observations without doing them again. A failed or yielded observation can be retried; no canonical master supplied means `NOT_COMPARED`, never `NEW`. The run records physical classification, unknown reasons, evidence, candidate state, and independent access/routability defaults.

5. Inspect and record a research-only review decision. Review decisions do not approve motorcycle access and never write canonical records:

   ```sh
   npm run scout:geo -- review list --run-id region-20261004-a
npm run scout:geo -- review decide --candidate-id candidate-id --decision NEEDS_MORE_EVIDENCE --reviewer Karl --reason 'Describe the open research question'
npm run scout:geo -- review serve --run-id region-20261004-a
npm run scout:geo -- notify retry
   ```

The reviewer binds to `127.0.0.1` only. It renders complete private source routes, derived segments, cited network edges and any canonical comparison as separate layers. It does not mount raw files. The decision options are `ACCEPT_FOR_RESEARCH`, `NEEDS_MORE_EVIDENCE`, `REJECT_FALSE_POSITIVE`, `AMBIGUOUS`, and `HOLD`; each stores reviewer, timestamp and reason. Acceptance is a research-queue decision only. The review AMBER is durably queued if the current shell has no configured email recipient; set `SCOUT_NOTIFICATION_EMAIL` only in the protected service/operator environment and run `notify retry`. Provider failures remain queued and store a sanitized error class rather than credential-bearing error text.

`status`, `network status`, `run status`, candidate review listing, and the reviewer do not acquire heavy-work admission. Network download/import and run processing do. Active stages check shared factory intent immediately and recheck host admission/resource/thermal telemetry at five-second intervals; an unsafe or unverifiable sample yields at the next processing checkpoint and records the specific hold reason. Factory intent causes Scout to checkpoint/yield and return exit 75. Resource admission remains fail-closed if the factory heartbeat or host telemetry is not verifiable. The normal operating workflow is sequential; do not start another regional heavy task while one is active.

## Belgium operator-path calibration

Belgium is the only real source batch used to validate this operator path. The private store already contains the explicitly approved source bytes, source manifest, Geofabrik snapshot and imported network edges. The source is not imported again. The general path creates a new immutable run over those existing observation and snapshot IDs, then runs ordinary `process --run-id` and `review serve --run-id` commands. Its output must reproduce the saved v2.2 calibration. This does not authorize another country, source, canonical comparison, or publication.

## What Karl must supply for a new region

- the exact route file(s) or their explicit private input manifest, and approval for private research use;
- source attribution and redistribution/derived-use permission or an explicit private-only restriction;
- the country/region identifiers, legal jurisdiction context, reviewer viewport, and approval scope;
- a permitted network provider/extract, pinned URL/version/SHA-256, coverage, licence and attribution. If the provider cannot publish a stable checksum or reuse terms are unclear, stop for review instead of downloading;
- later, only if a canonical comparison is wanted, an explicitly supplied authoritative canonical reference under the existing read-only integrity contract.

No email/SMS credentials are needed for processing commands. If the existing email provider is configured, an AMBER message may be sent once when a completed run has candidates awaiting research review; notification failure never changes processing. Raw source geometry and evidence remain private.
