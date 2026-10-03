# Handoff: Phase 3c canonical-map migration (paused 2026-10-03)

**State: validated migration preserved, then stopped by the owner.**

| Action | Status |
|---|---|
| Access/routing contract changes | not made |
| `rtt-verified-master` approved | no |
| Tiles built | no |
| Anything registered | no |
| Anything promoted | no |
| `trails.input` | unchanged (synthetic fixture) |
| Published trail build | unchanged (synthetic `9948c69f`) |

The factory is GREEN, and the repo is clean.

## Commits (local, not pushed)
- **`58e337c`: trail contract v2.**
  - `kind` and `status` are optional and accept the canonical map's exact strings: BOAT, Restricted Byway, Bridleway, Footpath; none_recorded, restricted_tro, temporary_tro, closed_tro, review_required.
  - `provenance.method` adds `rtt_verified`.
  - A line part shorter than 1 m is a geometry *review* flag, not an error.
- **`538b350`:** `scripts/rtt/migrate-canonical.mjs` (the migration) and `scripts/rtt/migration-proof.mjs` (independent proof). Generic code; there's no data or source names in the repo.

## Private locations (local only; never commit, serve or publish)
Base folder: `~/rtt-map-factory/private/rtt/master/2026-09-25-4b3b29dc8b1c/`

| What | File |
|---|---|
| Private master (contract features) | `master.geojson` |
| Private sidecar: every feature's exact original attributes, legacy key, `private_audit`, research inputs, open issues | `master-private.jsonl` |
| Crosswalk, legacy key → `rtt_id` | `crosswalk.jsonl` |
| Proof | `MIGRATION-PROOF.md`, `proof.json` |
| Candidate registry entry (`approved: false`, **not** registered) | `candidate-sources.yaml` |
| Migration inputs and rules | `migration.json` |
| **ID salt** | `~/rtt-map-factory/private/rtt/id-salt` (mode 600) |

Staged input and reconstruction reports: `~/rtt-map-factory/staging/rtt-trails/2026-10-03-4b3b29dc8b1c/`. That folder holds `rtt_uk_current.geojson` (sha256 `4b3b29dc…`), `readiness-v2-features.jsonl`, `reconstruction-features.jsonl` and the review reports. The upstream clone is read-only, in `staging/rtt-trails/upstream/` (push disabled).

## Migration proof: all PASS
- **Counts:** 14,315 in, 14,315 out.
- **Identity:** preserved one to one, 14,315/14,315, all `rtt_id`s unique.
- **Geometry:** exact match on 14,315/14,315.
- **Classification and access:** 0 changes to legal classification (`kind`), 0 changes to access values.
- **Original attributes:** all preserved exactly in the private sidecar, 14,315/14,315.
- **Names:** 10,483 changed, all by the placeholder rule only ("Verified lane" omitted). No genuine names exist in the map.
- **Private audit:** present in the sidecar for 14,315/14,315.
- **Legacy and source data:** no audit or legacy keys in the contract records, and no legacy or source IDs in the public projection.
- **Public projection:** whitelist clean (fields `rtt_id`, `kind`, `access`).
- **No-upstream-record indicators:** 37, intact.
- **Validation** (0 errors either way; geometry review flags 3):

  | Run | Accepted | Quarantined |
  |---|---|---|
  | As-is | 0 | 14,315 (all because "source 'rtt-verified-master' is not approved") |
  | Simulated approval | 14,315 | 0 |

## The 11 open review issues (unchanged, flagged, not altered)

| Issue | Count |
|---|---|
| sub-1 m geometry review (non-routable until reviewed) | 3 |
| materially changed geometry vs upstream (shipped geometry preserved) | 1 |
| unknown origin (Build 11 additions, no upstream record) | 5 |
| uncertain source match (Build 11 additions) | 2 |

The `rtt_id` for each is listed in `MIGRATION-PROOF.md`.

## Access composition today (`migrate-canonical.mjs`)
Published `access` = the master `status` = `rtt_closure_override_status` if present, otherwise `closure_status`. Exact strings, absent if neither is set. (`tro_status` equals `closure_status` on every feature.)

## Outstanding requirement: routing and access constraints
The 4-field public representation (`rtt_id`, `name`, `kind`, `access`) does **not** yet carry these rider-relevant constraints. They're preserved exactly in the private sidecar, under `legacy_properties`:

| Constraint | Features |
|---|---|
| A motor-vehicle or access prohibition in `restriction_reasons` (`motor_vehicle_no`, `motor_vehicle_private`, `vehicle_no`, `motorcycle_no`, `access_no`, `access_private`) | **91** (`motor_vehicle_no` itself: **74**; any restriction reason: 96) |
| `rtt_through_route: false` (no through route) | **1,377** |
| `auto_route_eligible: false` | 58 |

**Requirement:** these must be preserved in the published map, without exposing provenance. That means rider-facing values only, never the evidence or source. The contract change (fold them into `access`, or add a whitelisted field) is an owner decision. It hasn't been made.

## ID salt: permanent
- `~/rtt-map-factory/private/rtt/id-salt` determines every `rtt_id`. **It must be permanent and never regenerated:** a new salt would silently change all 14,315 IDs.
- **Back it up securely and privately.**
- **Known gap:** `migrate-canonical.mjs` currently *creates* the salt if the file is missing. Before the next run, that must become a hard failure whenever a master or crosswalk already exists. (Not changed, per the stop instruction.)

## Rerun validation (no build, no registration, no promotion)
```sh
cd ~/Projects/rtt-web-planner
S=~/rtt-map-factory/staging/rtt-trails/2026-10-03-4b3b29dc8b1c
M=~/rtt-map-factory/private/rtt/master/2026-09-25-4b3b29dc8b1c

# Re-prove the existing migration (re-reads input and outputs, runs the validator twice):
node scripts/rtt/migration-proof.mjs --input $S/rtt_uk_current.geojson --master $M

# Validate the private master against the candidate (unapproved) registry:
RTT_PRIVATE_SOURCES=$M/candidate-sources.yaml node scripts/rtt/validate.mjs $M/master.geojson

# Contract, privacy and repo tests:
node --test 'tests/rtt/*.test.mjs'          # 25 tests
RTT_REGION=uk node --test 'tests/repo/*.test.mjs'   # 36 tests
```
Re-running the migration itself (only with the same salt present):
```sh
node scripts/rtt/migrate-canonical.mjs --input $S/rtt_uk_current.geojson \
  --readiness $S/readiness-v2-features.jsonl --reconstruction $S/reconstruction-features.jsonl \
  --out /tmp/rtt-migration-check     # compare with cmp against $M; must be byte-identical
```
