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
| `rtt-ollama.service` | Local AI runtime: localhost only, cgroup memory capped. GPU-only while a job runs; may use the CPU when the factory is idle. Optional; the factory works without it. |
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
| `trails` (target `rtt-trails`) | `scripts/rtt/pipeline-trails <trails.input>` | The RT&T trail layer: validate, build its own PMTiles, install the trail style, trail tests, trail render tests over Monaco, promote `output/rtt-trails/current`. Gated by `trails.enabled`; scheduled weekly on Sundays. See [RTT-TRAILS.md](RTT-TRAILS.md). |

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
- **Hybrid placement** (`ai.modes` in `config/factory.yaml`):
  - **While a job runs (busy): GPU only.** The helper requires free VRAM ≥ model size + 700 MB, at least 2 GB of system RAM available, and no more than 2 GB of swap in use. After loading, it checks that Ollama placed 100 % of the model on the GPU. Otherwise it unloads the model and the worker continues **rules-only**. It never takes CPU or RAM from Planetiler.
  - **When the factory is idle: the whole machine, fastest first** (default `[cpu, gpu]`). The worker asks the AI only after a job's processes have exited, so in practice every diagnosis runs in idle mode. CPU mode requires at least 6 GB of RAM available, swap within limits, and a 1-minute load ≤ 4, so a build started outside the factory keeps it off the CPU. It raises the `rtt-ollama` memory cap to 6 GB for that call only, then always unloads the model and restores the exact previous cap.
  - Any caller that doesn't say it is idle gets the busy (GPU-only) behaviour.
  - Measured on the same diagnosis (`make test-ai`): **CPU 12.9 tok/s, 17 s; GPU 6 tok/s, 56 s.** If the GPU is ever fixed, put `gpu` first in `modes.idle`.
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

**Known issue:** the GTX 1650 is stuck at 300 MHz because NVIDIA's power management reads an implausible ~172 W draw against a 60 W cap ("SW Power Cap"), so GPU inference runs at about 6 tok/s instead of the 40+ the card should give. The hardware is fine: it worked under Windows 11 days before this install. Tested on 2026-10-02/03, with no improvement from any of:
- drivers 595 and 580, open and proprietary modules, GSP on and off
- runtime power management, platform profiles, an EC power drain
- nouveau/NVK: 4 tok/s; nouveau also runs NVIDIA's GSP firmware

Details and the bug report are in `~/gpu-debug/FINDINGS.md`. The hybrid mode works around it by using the CPU when idle.

## Worker lock

`state/worker.pid` records the worker's pid and the boot it started in. A lock only blocks startup if it is from the current boot **and** that pid is still running `factory/worker.mjs`. A pid reused after a reboot can no longer stall the factory, which happened once on 2026-10-02. At startup the worker also removes temp files left by killed writers.

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
| Real reboot | Linger on. A UK repro was queued, and the machine was rebooted by hand during Planetiler `osm_pass2` (nodes 86 %, 3.7 GB scratch). | See below. |

### Real reboot (2026-10-02 18:01)

- **Shutdown.** systemd sent SIGTERM. The worker recorded attempt 1 as `interrupted` → `resume` (GREEN, rules) and requeued the job at 18:01:05.
- **Boot.** Linger started the user manager. The order was:

  | Time | Event |
  |---|---|
  | 18:01:26.210 | `user@1000.service` starts (session 1, `Class=manager`, `Service=systemd-user`) |
  | 18:01:26.379 | GDM auto-login opens session 2 |
  | 18:01:26.528 | `rtt-factory` and `rtt-ollama` start |
  | 18:01:27 | attempt 2 starts |

  This machine has GDM auto-login enabled (`AutomaticLogin=karl`), so it never shows a login screen. The factory is started by linger, through the manager session that exists before the auto-login session. A remote reboot behaves the same way.
- **Processes.** After boot the factory cgroup held only the new worker, its inhibitor, and attempt 2's `check-repro` → `build-region` → `java`. Nothing was orphaned.
- **Result.** Attempt 2 finished at 18:11:56: **IDENTICAL**, sha256 `a1a1c57c…3a0ad`, the same as the promoted UK build.
- **Ollama.** Came back at boot with CUDA on the GTX 1650. The pinned model digest verified, and readiness was `ai` (fits in VRAM, 9.4 GB RAM available, no swap).
- **Queue and timers.** The 8 earlier done jobs were intact. The schedule timer (03:15) and the hourly report timer were still scheduled; the report ran at 18:00.
- **Status.** Dashboard and mapwatch GREEN after the run.

**Two defects found, and fixed in `bf28436`:**
1. **Stop cleanup was cut short.** On stop, the worker exited as soon as the job's leader process died. systemd then SIGKILLed `build-region` while it was deleting its scratch and writing its failure record, so the shutdown left 4.4 GB of scratch and no record. The worker now waits for the whole job process group to exit, up to 90 % of the stop timeout.
2. **The startup sweep skipped pre-reboot scratch.** It had been written less than 15 minutes earlier. `cleanScratch` now treats a directory as stale immediately if its owning pid is dead or it was last written before this boot. After deploying the fix, the startup sweep removed the 4.4 GB.

**Fix verified (test D, 18:16).** `systemctl --user restart` during UK `osm_pass2` with 3.4 GB of scratch:
- The worker waited for the job's process group to exit (0.6 s).
- `build-region` deleted its scratch and wrote its failure record (`interrupted by SIGTERM`, stage `planetiler`).
- The job was requeued, resumed, and finished IDENTICAL (`a1a1c57c…`), with the scratch directory empty at the end.
