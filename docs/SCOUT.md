# RT&T Scout — Milestone 1 foundation

Scout is a private trail discovery and investigation queue. It collects and preserves observations, matches candidates against the RT&T master when supplied, records evidence and open questions, and prepares review items. It does not build maps, decide legal access from route popularity, import to the canonical master, or publish data. The existing deterministic trail factory remains the sole validation and promotion authority.

## Data and decisions

Each candidate has a stable hash-derived `candidate_id`, version and timestamps, unchanged source observations, geometry and its hash, master-match result, qualified evidence references, three independent states, confidence/review notes, corridor relationships, issues, and lifecycle/review state. `schema/scout-candidate.schema.json` describes the persisted record. Raw source geometry is copied without snapping or simplification. Any future transform must preserve the original and name the transform and version.

The states are deliberately independent:

| Question | Values | Meaning |
|---|---|---|
| Physical existence | `unknown`, `probable`, `confirmed`, `disproved` | Evidence that a physical lane/path/track exists. |
| Motorcycle access | `unknown`, `probable`, `confirmed`, `prohibited` | Evidence about motorcycle-specific access. Route use or a source label never supplies legal evidence by itself. |
| Routability | `unknown`, `yes`, `no` | Whether the routing engine can enter, traverse and exit the geometry. |

Source evidence metadata and route hints are kept as descriptive observation data. They do not affect state until a separate evidence-review step marks an evidence record `qualified`. Contradictory qualified evidence is retained and marked `contradictory`; it queues review. Unknown access is never changed to permission by matching, routability, names, AI, or community-route use.

## Sources, matching and review

Collectors implement `collect(cursor)` and return observations plus a cursor/check time. `FakeAdapter` is the only included adapter. A source observation can have or omit geometry, source ID, name, provenance, hints and evidence. Hints are discovery-only. Source failures are recorded per adapter and do not stop another adapter's queue.

Matching is deterministic and read-only. Byte-equivalent geometry is `EXACT_EXISTING`. Other geometries receive line-distance and sampled overlap scores. High overlap and close shape can be `LIKELY_EXISTING`; partial shared length is `PARTIAL_OVERLAP`; nearby without overlap is `POSSIBLE_PARALLEL`; competing matches are `AMBIGUOUS`; no close match is `NEW_CANDIDATE`. Proximity alone never establishes identity. Thresholds are in `config/scout.yaml`; uncertain outcomes stay reviewable. The matching API accepts master features but this worker does not load or change a canonical master.

Corridor clustering groups candidate IDs when shape distance and overlap meet policy. It does not combine candidate records; every observation and evidence reference stays independently recoverable. Review items persist a reason, relevant match/evidence/state fields and recommended action. A no-geometry hint is retained and queued rather than dropped.

## Worker, state and control

`scripts/scout/core.mjs` provides an atomic JSON queue under `$FACTORY_DIR/scout/`, deterministic job IDs for duplicate prevention, pending/running/held/done states, bounded exponential retry delay, and recovery of interrupted running jobs. Candidate and review files, source cursors, worker heartbeat and last activity are in the same private root. `scoutctl` currently supports status, list, show and explicit synthetic fixture enqueue. `worker.mjs --once` processes queued local observations only. There is no scheduler, crawler, import command, `factoryctl` authority, or active systemd unit.

The service file is a dormant deployment template with low CPU/IO weights and filesystem protections. It is not installed or enabled. Scout cannot approve factory jobs, clear factory RED, deploy code, promote a master, or publish trails. A future Control Centre can read the private status and queue JSON without gaining these authorities.

## AI boundary

The `consultAI(provider, request)` interface is optional and disabled by default. It applies a timeout, validates a small advisory response, and bounds its fields. Disabled, unavailable, timed-out, provider-error, malformed or quota-failed calls leave deterministic processing available. AI output cannot set the three evidence states or change a match. Fake providers support tests. Production escalation policy, credentials and consultation audit records are future work. The future strong-model/Astra escalation should be limited to policy-triggered ambiguity or integrity cases and should record provider/model, reason, candidate and evidence references, response, action and usage when available. Cross-model consultation was not needed for this foundation.

## Host cooperation and thermal policy

The host classifier consumes a provider-neutral snapshot compatible with `scripts/lib/telemetry.mjs`: factory state, Planetiler, other heavy lease, local AI, RAM/swap/load, CPU/iGPU/dGPU/NVMe temperatures, disk/scratch, and throttle/clock data as available. `scripts/scout/resources.mjs` reuses current telemetry and adds read-only systemd, process, Ollama, lease-file and disk probes. Current telemetry reads CPU and NVMe temperature, AMD iGPU temperature/load/VRAM, NVIDIA temperature/utilisation/VRAM only while runtime power management says active, RAM/swap and load. Missing sensors remain unknown. Clock degradation and throttle flags are not yet populated by the existing sampler.

One boot-aware heavy-work lease is planned for large Scout jobs and local inference. Its owner, PID, boot ID and acquisition time are visible in private state. Work must yield to a factory build or another lease. Systemd resource controls are set to low priority in the dormant unit. No concurrency or thermal decision consumes NVIDIA's reported power draw.

Initial configurable hold points in `config/scout.yaml` are WARM CPU 85°C / NVMe 65°C, HOT CPU 90°C / NVMe 72°C / GPU 85°C, and CRITICAL CPU 98°C / NVMe 80°C. They are conservative provisional values copied from current factory start/hold context where available, not claimed as measured successful-build limits. Before activation, compare telemetry from successful A17 builds and adjust centrally. The governor uses 5°C recovery margin and six cool samples at ten-second intervals; HOT pauses heavy work and CRITICAL maps to RED/hold. It never shuts down the OS. The known GTX 1650 bug reports about 170W despite a 50–60W configured limit and SW Power Cap; that power field is ignored. Temperature, utilisation, clocks and real throttle indicators are the relevant corroborating signals.

## Notifications and privacy

`NotificationCenter` writes durable notification/digest state, supports EMAIL and SMS provider slots, dedupe keys, cooldown, severity escalation and one recovery event. Delivery exceptions are recorded per channel and swallowed so Scout continues. INFO can be batched; AMBER needs review or indicates degraded safe operation; RED means integrity or safety hold. Test providers require no credentials. Message adapters should send only brief summaries and private review IDs.

All evidence, provenance, candidates, cursors and review records live under `$FACTORY_DIR/scout/`, outside web-served repository paths. Public trail projection stays governed by the Phase 3c whitelist (`rtt_id`, `name`, `kind`, `access` plus geometry). Scout does not add fields to that contract or write to the 14,315-feature canonical master. Repository fixtures use synthetic identities only.

## Milestone 1 scope and limits

Milestone 1 supplies data contracts, deterministic normalization/matching/clustering, review persistence, replaceable AI and notification interfaces, queue/worker foundations, a resource-state abstraction, thermal hysteresis and a dormant service boundary. It contains no live internet source, real trail data, production credentials, canonical import, publication, automatic deployment, or shutdown policy. The system is safe to leave dormant while the pinned live map factory continues operating because no unit is activated and no shared factory or canonical paths are modified.

Recommended Milestone 2: validate this dormant foundation on the A17 with fake queues and read-only telemetry/status adapters, compare thermal thresholds to known successful builds, then propose a separately reviewed integration plan for the private canonical master matcher and Control Centre. Keep live source adapters and import approval as distinct later decisions.
