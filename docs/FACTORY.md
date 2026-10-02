# Unattended map factory (A17)

The factory keeps building, validating and promoting regional basemaps without a Claude session. It runs as systemd **user** services on the A17 (`RTT`, ASUS TUF Gaming A17).
- The deterministic pipeline (`scripts/pipeline`) and the rules in `scripts/factory/rules.mjs` are authoritative.
- A small local model may advise on failures the rules can't classify, within strict limits.

## Pieces

| Piece | What it does |
|---|---|
| `rtt-factory.service` | The worker (`scripts/factory/worker.mjs`). It runs one queued job at a time from the **runner checkout** `$FACTORY_DIR/runner/repo`. It restarts on any exit, after 30 s, and blocks sleep while it is up through a `systemd-inhibit` child. The worker is the unit's main process, so a stop's SIGTERM reaches it first. |
| `rtt-factory-schedule.timer` | Runs daily at 03:15 and catches up after downtime. It enqueues `verify` daily and `repro` on Sundays for each enabled region (`config/factory.yaml`). |
| `rtt-mapwatch-report.timer` | Writes `$FACTORY_DIR/reports/latest.{json,md}` every hour. |
| `rtt-ollama.service` | Local AI runtime: localhost only, GPU-only, cgroup memory capped. Optional; the factory works without it. |
| `factoryctl` (`scripts/factory/factoryctl.mjs`) | Dashboard and control. |

The runner checkout is a git worktree pinned to a commit. The worker never runs your working copy, so edits in progress can't leak into unattended builds. To change what the factory runs, commit and then run `factoryctl deploy`. Deploy checks out the commit, runs the factory and hygiene tests there, reinstalls the units and restarts the worker. The worker stops (RED) if the runner's tracked files are modified.

## Daily use

```sh
make dashboard                       # = node scripts/factory/factoryctl.mjs status [--json]
node scripts/factory/factoryctl.mjs enqueue build uk
node scripts/factory/factoryctl.mjs list
node scripts/factory/factoryctl.mjs approve <job>   # AMBER: approve and run
node scripts/factory/factoryctl.mjs retry <job>     # held: run again with a fresh retry budget
node scripts/factory/factoryctl.mjs cancel <job>
node scripts/factory/factoryctl.mjs clear-red       # after fixing a RED cause
journalctl --user -u rtt-factory -f                 # worker log
```

The dashboard shows:
- worker state, heartbeat and restarts
- RED/AMBER status
- the current region, job, pipeline step, Planetiler stage and elapsed time
- the queue, including held jobs and their reasons
- free disk, and whether the next job passes the disk guard
- CPU, NVMe and GPU temperatures, RAM and swap
- the AI mode
- the last failure with its decision

## Job types

| Type | Command (in the runner) | Notes |
|---|---|---|
| `build` | `scripts/pipeline <r>` | Snapshot → tiles → style → all tests → promote. It promotes only if every test passes. |
| `verify` | unit + render tests against `current` | Checks the promoted build in place. |
| `repro` | `scripts/check-repro.mjs <r>` | Rebuilds in scratch with half the threads and requires byte-identical output. |
| `refresh` | `fetch-region --refresh`, then `pipeline` | Always AMBER: held until approved. The new lock lands in the runner, to be committed by a human. |

## Autonomy rules

**GREEN — the worker acts alone, within budgets:**
- run queued jobs for regions enabled in `config/factory.yaml`, from pinned snapshots
- validate, and promote when all tests pass
- run scheduled verify/repro jobs
- wait, without failing, while CPU > 85 °C, NVMe > 65 °C or the machine is on battery
- apply approved remediations (`rules.mjs` → `REMEDIATIONS`):

| Failure class | Remediation | Budget per job |
|---|---|---|
| interrupted (signal, restart, reboot, crash) | `resume` | 3 |
| network (DNS, connection, 5xx) | `retry-after-backoff` (5 min, then 30 min) | 2 |
| oom | `retry-reduced-threads` (halves threads; build ID unaffected) | 1 |
| disk-full | `clean-scratch` (stale factory scratch only), then re-check the disk guard | 1 |
| render-timeout (browser wait timed out) | `retry-render-tests` | 1 |

There is also an overall limit of 4 automatic remediations per job; after that the job is held. No remediation edits code, config, styles or goldens, or commits anything (enforced by test).

**AMBER — the job is held; a human decides (`approve`, `retry` or `cancel`):**
- test failures: schema, attribution, repo or screenshot. Goldens are never updated automatically.
- failures the rules can't classify (`unknown`)
- a used-up retry budget
- the disk guard failing even after cleaning scratch
- a region not enabled in `config/factory.yaml`
- any `refresh`, i.e. a new OSM snapshot

**RED — the whole queue stops until `factoryctl clear-red`:**
- an integrity failure: a pinned snapshot, ancillary file, tool or output fails its checksum. Never retried; it may be corruption or tampering.
- a refused job: a full-planet build, by name (`planet`, `world`), source URL, or a snapshot over 20 GB. **Full-planet builds are refused outright.**
- the runner checkout modified outside `factoryctl deploy`

## Disk guard

A job starts only if free space ≥ snapshot (if not already on disk) + expected scratch + expected output + margin.
- **Expected sizes:** the region's last manifest × 1.25, or the snapshot size × 5.5 for scratch and × 0.85 for output when there is no earlier build.
- **Margin:** the larger of 25 GB and 5 % of the filesystem.

If the check fails, the worker deletes stale scratch (no live owner and nothing written for 15 minutes) and checks again. If it still fails, the job is held with the exact figures.

## Checkpointing and resume

- Jobs are JSON files in `$FACTORY_DIR/queue/{pending,running,held,done,cancelled}`, written atomically with fsync and rename.
- On start, the worker treats any job left in `running/` as interrupted and resumes it under the `resume` budget.
- The pipeline is the checkpoint:
  - pinned inputs are re-verified rather than re-downloaded
  - an existing build ID is reused, so a finished build is not rebuilt
  - assets, style, tests and promotion re-run
- Planetiler has no internal checkpoint. A build cut off mid-run restarts that region's Planetiler run, about 10 minutes for the UK. The partial attempt is preserved in `logs/failures/`.
- Graceful stop (`systemctl --user stop`, shutdown): the worker sends SIGTERM to the job's process group, records the interruption, requeues the job, and exits. Anything left after 120 s is killed.

## Local AI helper

Model: **qwen2.5-coder:3b** (Q4_K_M, 1.9 GB), pinned by digest in `config/ai.lock`. Ollama v0.35.0 is installed from the pinned tarball by `scripts/fetch-ai`.

- **Role:** it is consulted only for failures the rules classify as `unknown`. It returns `{class, remediation, summary}` under a JSON schema whose remediation enum is `AI_SELECTABLE`: `resume`, `retry-after-backoff`, `retry-reduced-threads`, `retry-render-tests` or `hold`.
- **Limits:** a job may use at most one AI-chosen remediation; after that it is held. The model can't run commands, edit files, override RED/AMBER outcomes, or pick `clean-scratch` or `stop-queue`.
- **GPU-only:** before each call, the helper requires free VRAM ≥ model size + 700 MB, at least 2 GB of system RAM available, and no more than 2 GB of swap in use. After loading, it checks that Ollama placed 100 % of the model on the GPU. Otherwise it unloads the model and the worker continues **rules-only**.
- **RAM cap:** the service has `MemoryHigh=1.5G`, `MemoryMax=2.5G` and no swap. CPU and IO weight are 20, and it runs at nice 10.

Benchmark (16 labelled failures in `tests/fixtures/ai-eval.json`; `scripts/factory/ai-bench.mjs`; GTX 1650, 4 GB):

| Model (Q4_K_M) | Condition | Accuracy | Unknown cases right | VRAM peak | Service RAM | Tokens/s |
|---|---|---|---|---|---|---|
| qwen2.5-coder:1.5b | idle, first prompt | 7/16 | 2/6 | 1.2 GB | 1.5 GB* | 10.2 |
| qwen3:1.7b | idle, first prompt | 8/16 | 2/6 | 1.6 GB | 1.5 GB* | 9.6 |
| llama3.2:3b | idle, first prompt | 10/16 | 3/6 | 2.4 GB | 1.5 GB* | 6.1 |
| qwen2.5-coder:3b | idle, first prompt | 9/16 | 4/6 | 2.2 GB | 1.5 GB* | 6.3 |
| llama3.2:3b | UK Planetiler running, final prompt | 10/16 | 3/6 | 2.4 GB | 1.5 GB* | 6.0 |
| **qwen2.5-coder:3b** | UK Planetiler running, final prompt | **13/16** | **5/6** | 2.2 GB | 1.5 GB* | 6.1 |

\* Mostly reclaimable page cache from the memory-mapped model file. Anonymous memory is about 0.3 GB. Every model was 100 % in VRAM.

**Known issue:** the GTX 1650 is stuck at 300 MHz because the NVIDIA driver reads an implausible 170 W power draw against a 60 W cap ("SW Power Cap"). This is why tokens/s are about 6 instead of the 40+ the card should give. A diagnosis takes about 20–60 s, which is acceptable for its occasional use. Fixing it needs root (for example `nvidia-powerd`, clock limits or the driver) and is left to the owner.

## Install / operate

```sh
scripts/fetch-ai                       # Ollama runtime + pinned model (optional)
node scripts/factory/factoryctl.mjs deploy      # runner worktree at HEAD, tests, units
systemctl --user enable --now rtt-ollama.service rtt-factory.service \
  rtt-factory-schedule.timer rtt-mapwatch-report.timer
sudo loginctl enable-linger $USER      # start at boot without logging in (needs a terminal)
```

## Restart/resume tests (2026-10-02)

| Test | What was done | Result |
|---|---|---|
| A: normal operation | Enqueued `build monaco`. Fired the schedule service, which enqueued `verify monaco` and `verify uk`. | All three done unattended in 4m41s. Disk-guard figures were logged before each job. |
| B: power loss | `systemctl --user kill --signal=SIGKILL rtt-factory` during UK Planetiler `osm_pass2`. Every process in the unit died at once. | systemd restarted the worker after 30 s. The job was recovered as `interrupted` → `resume` (GREEN), and attempt 2 finished byte-identical (`a1a1c57c…`). No Java process was orphaned. |
| C: graceful stop/restart | `systemctl --user restart rtt-factory` during UK `osm_pass2`. | The first run exposed a bug: `systemd-inhibit` as `ExecStart` swallowed SIGTERM, so stops became hard kills. After the fix, the worker received SIGTERM, signalled the job's process group, recorded the interruption and requeued the job within 0.2 s. The new worker resumed it straight away; result byte-identical. `build-region` saved the partial attempt to `logs/failures/`. |
| Regression | `build monaco` and `build uk` run through the factory. | Builds reused (`97b3e038`, `c9f7aa62`); 41 unit tests each, plus 8 and 22 render tests; promoted. |
| Real reboot | Pending. It needs `loginctl enable-linger`, so that the user manager starts at boot without a login. | Not yet run. |
