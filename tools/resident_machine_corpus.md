# Rust-resident corpus evidence runner

This development-only runner boots each selected local corpus image through the frozen
`web/resident-machine-worker.mjs` and records bounded CPU-residency evidence. It does not certify
visual correctness, playability, or compatibility milestones, and it is not part of release or
deployment.

The host verifies each selected container's full SHA-256, freezes its filesystem identity, and
serves only exact immutable HTTP byte ranges. The browser-facing manifest contains only the game
key, priority, byte length, SHA-256, and range URL. Container formats, executable structure, CPU
state, and device policy remain outside JavaScript.

## Full seven-game command

Use frozen artifacts whose hashes have passed `tools/resident_machine_adapter_contract.mjs`:

```sh
workspace_root="${LAZULI_WORKSPACE_ROOT:-$PWD}"
python3 tools/resident_machine_corpus_server.py \
  --root "$workspace_root" \
  --corpus "$workspace_root/tools/compatibility/games/corpus.json" \
  --games "$workspace_root/games" \
  --core /path/to/frozen/browser_machine.wasm \
  --dispatcher /path/to/frozen/resident_dispatcher.wasm \
  --coordinator /path/to/frozen/core_run_coordinator.wasm \
  --renderer-js /path/to/frozen/browser_renderer.js \
  --renderer-wasm /path/to/frozen/browser_renderer_bg.wasm \
  --bind 127.0.0.1 \
  --port 8787
```

With no `--game`, the server selects all seven manifest entries in priority order and verifies
every full image hash before listening. Repeat `--game <key>` to run an ordered subset.

## Release-bound production performance evidence

The command above and checked-in v1 lock are legacy diagnostic inputs. They cannot satisfy the
production fidelity gate. Controlled-performance publication requires a supplied
`lazuli-resident-corpus-evidence-lock-v2` whose run UUID selects the exact seven-title order and
whose raw schema-4 authority binds core, dispatcher, coordinator, adapter, Worker, frontend,
renderer JavaScript, and renderer Wasm descriptors.

Start the corpus server with `--execution-authority <raw-v2-lock>`, `--adapter <packaged-adapter>`,
`--worker <packaged-worker>`, and `--frontend <packaged-frontend>`, plus the five artifact arguments
above. Before listening, the server verifies and snapshots the exact locked HTML, page module,
report validator, and server source. Production requests have no workspace fallback. It verifies
all eight raw packaged roles and serves each at its exact release URL in addition to the five
artifact aliases. This is required because the packaged Worker imports the packaged adapter and
the packaged renderer JavaScript names the content-addressed renderer Wasm URL.

The page fetches the raw lock, requires its exact corpus/game/artifact/policy authority, and creates
each Worker at `lock.runPolicy.workerUrl`. Its final report includes the raw lock schema, SHA-256,
and run UUID. Publication validation requires that external lock, its independently authenticated
raw digest, `requireComplete`, and `requireAll`. Changing any locked source or packaged role either
fails before listening, produces a precondition failure for a frozen file, or requires a new lock
and release; old report bytes cannot be relabeled.

Open the emitted local URL in Chrome with a bounded corpus policy:

```text
http://127.0.0.1:8787/?warmupInstructions=1000000&measureInstructions=5000000&coldInstallCap=65535&hostCallCap=65535&bootTimeoutMs=180000&sliceTimeoutMs=180000&windowTimeoutMs=300000&zeroProgressSliceCap=4096&continueOnFailure=1
```

The page creates a fresh production worker for each title. Before every title it calls
`WebGpuRenderer.reset()` and `reset_diagnostics()`, then relays the four exact render fields and
opaque receipt bytes. It publishes the final JSON in `#result` and
`globalThis.__residentCorpusEvidence`.

Validate a captured report with:

```sh
node tools/resident_machine_corpus_report.mjs \
  --require-complete \
  --require-all \
  --lock /path/to/release-bound-corpus-lock.json \
  report.json
```

Publication validation has no implicit lock: `--require-complete` and `--require-all` require an
explicit, separately authenticated `--lock`. A deliberate artifact rebuild requires a new lock; a
report cannot rewrite its own trusted corpus or release identity. The checked-in
`resident_machine_corpus_evidence_lock_legacy_fixture.json` is test-only historical v1 data and is
not production authority.

## Report schema

The executable schema is `lazuli-rust-resident-corpus-evidence-v1`. Its important invariants are:

- `corpus.selectedGameKeys` fixes selection and order; complete evidence must contain exactly the
  same ordered game keys. `--require-all` additionally requires the exact nonempty seven-game
  order from the external lock.
- Every complete warmup and measurement window reaches its instruction target and has zero
  host-call-cap, cold-install-cap, worker-timeout, zero-progress-cap, and Rust-stop boundaries.
- Window labels and targets must match policy, cycles must be positive and remain within the
  slice-scaled cap, slices must equal Rust outcomes, detail counts and overshoot must reconcile,
  rates must recompute, and boot/window wall times must remain within their declared limits.
- A worker request has an explicit per-slice wall bound, each window has an overall wall bound,
  and consecutive zero-instruction slices have a separate cap. Each request is clamped to the
  remaining absolute window time and the deadline is checked again after the response.
- Cap or timeout failures retain a labeled partial window but never present its counters as a
  complete measurement. Adapter caps explicitly mark the active Rust counters unobservable.
- On a title failure, the Worker is terminated before terminal snapshots, already-issued renderer
  relays must settle, and a late queued renderer message is ignored. If renderer isolation cannot
  be re-established, the corpus stops before starting another title.
- Per-title totals preserve boot reads, DI reads, cold installs, render calls, renderer failures,
  range/precondition faults, and all outcome-detail counts.
- Host transport reads must equal one immutable-size probe plus Rust boot reads plus Rust DI reads.
- Renderer relay calls must equal the core's resident render-call total.
- Capability-boundary fields require zero browser semantic arguments, JavaScript dispatch-table
  writes, container parsers, and input samples.

The corpus source SHA and each opaque container SHA/size provide an unambiguous offline join to
the checked-in compatibility manifest without sending disc identifier, revision, format, or
milestone semantics into the browser execution boundary.

Legacy v1 is still trusted-local evidence, not a signed provenance envelope: the captured v1 JSON does
not itself hash the runner, adapter, worker, server, or HTML source that produced it. Those sources
remain reviewable beside the report, but the safe claim is bounded boot plus early CPU residency,
not cryptographic certification of the entire thin-JavaScript boundary.

## Representative smoke

The checked-in `resident_machine_corpus_smoke_report_legacy_fixture.json` uses
`luigis-mansion-usa` with a 250,000-instruction warmup target and a 500,000-instruction measurement
target. It is a test-only historical Chrome 151 fixture, not current production evidence or a
cross-title throughput ranking.
