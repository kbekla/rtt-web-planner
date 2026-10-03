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

Collectors implement `collect(cursor)` and return observations plus a cursor/check time. `FakeAdapter` is the only included adapter. A source observation can have or omit geometry, source ID, name, provenance, hints and evidence. Hints are discovery-only. `SourceScheduler` enforces a minimum interval, persists cursors/check times, applies bounded exponential retry times and holds a source in AMBER after its retry budget. Source failures are recorded per adapter and do not stop another adapter's queue.

Matching is deterministic and read-only. Byte-equivalent geometry is `EXACT_EXISTING`. Other geometries receive line-distance and sampled overlap scores. High overlap and close shape can be `LIKELY_EXISTING`; partial shared length is `PARTIAL_OVERLAP`; nearby without overlap is `POSSIBLE_PARALLEL`; competing matches are `AMBIGUOUS`; no close match is `NEW_CANDIDATE`. Proximity alone never establishes identity. Thresholds are loaded from `config/scout.yaml`; uncertain outcomes stay reviewable. The matching API accepts master features but this worker does not load or change a canonical master, so it records `UNMATCHED` until a future controlled integration supplies that master.

Corridor clustering groups candidate IDs when shape distance and overlap meet policy. It does not combine candidate records; every observation and evidence reference stays independently recoverable. Review items persist a reason, relevant match/evidence/state fields and recommended action. A no-geometry hint is retained and queued rather than dropped.

## Worker, state and control

`scripts/scout/core.mjs` provides an atomic JSON queue under `$FACTORY_DIR/scout/`, deterministic job IDs for duplicate prevention, pending/running/held/done states, bounded exponential retry delay, and recovery of interrupted running jobs. Corrupt persisted queue data creates a durable RED sentinel that prevents restart loops from processing further work. Candidate and review files, source cursors, worker heartbeat and last activity are in the same private root. `scoutctl` currently supports status, list, show and explicit synthetic fixture enqueue. `worker.mjs --once` processes queued local observations only. Source scheduling is an explicit API boundary; no scheduler is activated. There is no crawler, import command, `factoryctl` authority, or active systemd unit.

The service file is a dormant deployment template with low CPU/IO weights and filesystem protections. Its `@SCOUT_DIR@` and `@FACTORY_DIR@` values must be supplied by a later reviewed installer; it does not point at the live runner and is not installed or enabled. Scout cannot approve factory jobs, clear factory RED, deploy code, promote a master, or publish trails. A future Control Centre can read the private status and queue JSON without gaining these authorities.

## AI boundary

The `consultAI(provider, request)` interface is optional and disabled by default. It applies a timeout, validates a small advisory response, and bounds its fields. Disabled, unavailable, timed-out, provider-error, malformed or quota-failed calls leave deterministic processing available. AI output cannot set the three evidence states or change a match. `consultAIAndRecord` stores bounded private consultation records with provider/model, reason, candidate/job and evidence references, response, action, uncertainty and usage when supplied. Fake providers support tests. Production escalation policy and credentials are future work. The future strong-model/Astra escalation should be limited to policy-triggered ambiguity or integrity cases. Cross-model consultation was used once during Milestone 1 to review geometry identity risk; its recommendation was adapted into conservative length-weighted matching and identity corroboration requirements.

## Host cooperation and thermal policy

The host classifier consumes a provider-neutral snapshot compatible with `scripts/lib/telemetry.mjs`: factory state, Planetiler, other heavy lease, local AI, RAM/swap/load, CPU/iGPU/dGPU/NVMe temperatures, disk/scratch, and throttle/clock data as available. `scripts/scout/resources.mjs` reuses current telemetry and adds read-only systemd, process, Ollama, lease-file and disk probes. On this A17, the current probe found the AMD `k10temp` Tctl CPU sensor, NVMe temperature, and AMD iGPU temperature/load/VRAM; the NVIDIA probe was unavailable during this read. Existing successful-build telemetry records both GPU sensors: the successful UK build peaked at CPU 76°C, NVMe 54.9°C, iGPU 55°C and dGPU 51°C; Monaco peaked at 51.4°C, 32.9°C, 40°C and 41°C respectively. The UK run also reached 13.7 load1 and 10.2 GB scratch, which reinforces that load is a configurable contention signal, not a standalone thermal trigger. Missing sensors remain unknown. Clock degradation and throttle flags are not yet populated by the existing sampler.

`HeavyWorkLease` provides the boot-aware shared lease primitive for large Scout jobs and local inference. Its owner, PID, process start identity, boot ID and acquisition time are visible in private state; stale owners are recoverable after reboot/PID reuse. No heavyweight Scout job or local AI is activated in Milestone 1. Work must yield to a factory build or another lease. Systemd resource controls are set to low priority in the dormant unit. No concurrency or thermal decision consumes NVIDIA's reported power draw.

Initial configurable hold points in `config/scout.yaml` are WARM CPU 85°C / NVMe 65°C, HOT CPU 90°C / NVMe 72°C / GPU 85°C, and CRITICAL CPU 98°C / NVMe 80°C. The observed successful UK build peaked 9°C below WARM CPU and 10.1°C below WARM NVMe, so the initial WARM points retain margin over the measured build. These remain conservative provisional values, not hardware vendor limits or a substitute for more build samples. The governor uses a 5°C recovery margin and six cool samples at ten-second intervals; HOT pauses heavy work and CRITICAL maps to RED/hold. It never shuts down the OS. The known GTX 1650 bug reports about 170W despite a 50–60W configured limit and SW Power Cap; that power field is ignored. Temperature, utilisation, clocks and real throttle indicators are the relevant corroborating signals.

## Notifications and privacy

`NotificationCenter` writes durable notification/digest state, supports EMAIL and SMS provider slots, dedupe keys, cooldown, severity escalation and one recovery event. Delivery exceptions are recorded per channel and swallowed so Scout continues. INFO can be batched; AMBER needs review or indicates degraded safe operation; RED means integrity or safety hold. Test providers require no credentials. Message adapters should send only brief summaries and private review IDs.

All evidence, provenance, candidates, cursors and review records live under `$FACTORY_DIR/scout/`, outside web-served repository paths. Public trail projection stays governed by the Phase 3c whitelist (`rtt_id`, `name`, `kind`, `access` plus geometry). Scout does not add fields to that contract or write to the 14,315-feature canonical master. Repository fixtures use synthetic identities only.

## Milestone 1 scope and limits

Milestone 1 supplies data contracts, deterministic normalization/matching/clustering, review persistence, replaceable AI and notification interfaces, queue/worker foundations, a resource-state abstraction, thermal hysteresis and a dormant service boundary. It contains no live internet source, real trail data, production credentials, canonical import, publication, automatic deployment, or shutdown policy. The system is safe to leave dormant while the pinned live map factory continues operating because no unit is activated and no shared factory or canonical paths are modified.

Recommended Milestone 2: validate this dormant foundation on the A17 with fake queues and read-only telemetry/status adapters, compare thermal thresholds to known successful builds, then propose a separately reviewed integration plan for the private canonical master matcher and Control Centre. Keep live source adapters and import approval as distinct later decisions.
