# Rust-resident first presented XFB evidence

This development-only mode proves one narrow boundary: Rust issued renderer work through the
frozen resident worker, the renderer produced its first GPU-completed presented XFB, the page
captured renderer-owned RGBA before returning the triggering opaque receipt, and the enclosing
Rust run accepted that receipt without fault. It does not interpret pixels or certify visual
correctness, compatibility, or playability.

Probe evidence uses the isolated `resident_machine_fidelity_server.py` wrapper. It preserves the
existing corpus host's raw-range behavior and adds only an fsync'd, hash-chained checkpoint
endpoint. Select exactly one corpus title so the host fully verifies only that opaque container
before listening.

Locked development sources are selected only by their exact allowlisted URL pathname. The page's
opaque query string is available to the page but never participates in source lookup; fragments,
unknown paths, absolute-form targets, and alternate-path query values are rejected.

## Production schema-v3 capture

The checked-in `resident_machine_fidelity_evidence_lock_legacy_fixture.json` and commands below are
test-only inputs for the historical feature-probe diagnostic path; they are never production
authority. Production capture uses a separately supplied
`lazuli-resident-renderer-fidelity-evidence-lock-v3` instead. A v3 lock is
per title and per run: it binds a UUID, the exact schema-4 manifest bytes/release ID/source commit,
all eight release execution descriptors, the exact corpus image and disc identity, the capture
sources, policies, and the default-off renderer contract. It explicitly requires
`defaultHookImports: 0` and `checkpointProbeEvents: 0`.

Before navigation, run the same lock verifier with the v3-only arguments `--lock-sha256`,
`--release`, `--run-id`, `--game-key`, `--adapter`, `--worker`, and `--frontend`, in addition to the
five artifact paths shown below. The verifier checks the raw lock digest, raw manifest digest,
release identity, corpus/image/run authority, every locked source, the five served artifact aliases,
and raw bytes for all eight content-addressed execution roles. It also compiles the production
renderer Wasm, requires exactly 329 imports, rejects any renderer-probe import, and rejects a probe
call in the packaged renderer glue. The glue must contain exactly one `.wasm` dependency target,
expressed by `new URL(..., import.meta.url)`, and it must equal the locked renderer-Wasm release URL.
Unknown, missing, or substituted inputs fail before navigation.

Start `resident_machine_fidelity_server.py` with the same v3 lock plus the exact packaged
`--adapter`, `--worker`, and `--frontend` paths. The server snapshots every locked harness source
before listening and has no production workspace fallback. It verifies and serves all eight release
assets at their descriptor URLs, so the packaged Worker loads the packaged adapter, and the
packaged renderer glue loads its content-addressed renderer Wasm. The page instantiates the Worker
at the exact URL in `lock.runPolicy.workerUrl`.

V3 journals preserve the durable `pre-submit -> submit-returned -> receipt-resolved` state machine
and require every receipt to resolve, but they reject every `renderer-probe-event`; the client
summary and report capability boundary must both state zero events. V2 continues to require at
least one probe event. These evidence modes are intentionally not interchangeable.

The immutable lock SHA-256 is
`f7cedfdb31c848ccb5779c54cf910573eeed85f31d43b89968f412c0b282be96`. Verify every bound
artifact/source plus the exact Wasm module/field/kind hook import before starting the host:

```sh
workspace_root="${LAZULI_WORKSPACE_ROOT:-$PWD}"
artifact_root="${LAZULI_ARTIFACT_ROOT:?set LAZULI_ARTIFACT_ROOT to the frozen artifact directory}"
capture_root="${LAZULI_CAPTURE_ROOT:-${TMPDIR:-/tmp}/lazuli-wario-render-probe}"

node tools/resident_machine_fidelity_lock.mjs \
  --lock "$workspace_root/tools/resident_machine_fidelity_evidence_lock_legacy_fixture.json" \
  --workspace "$workspace_root" \
  --core "$artifact_root/browser_machine.wasm" \
  --dispatcher "$artifact_root/resident_dispatcher.wasm" \
  --coordinator "$artifact_root/core_run_coordinator.wasm" \
  --renderer-js "$artifact_root/browser_renderer.js" \
  --renderer-wasm "$artifact_root/browser_renderer_bg.wasm"
```

The expected verifier result is lock SHA `f7cedfdb…82be96`, host identity
`11198973…92f3f6`, 21 verified files, and selected game `warioware-usa`.

```sh
python3 tools/resident_machine_fidelity_server.py \
  --evidence-lock "$workspace_root/tools/resident_machine_fidelity_evidence_lock_legacy_fixture.json" \
  --checkpoint-log "$capture_root/checkpoints.jsonl" \
  --checkpoint-body-cap 4096 \
  --checkpoint-record-cap 65535 \
  --checkpoint-probe-event-cap 32768 \
  --root "$workspace_root" \
  --corpus "$workspace_root/tools/compatibility/games/corpus.json" \
  --games "$workspace_root/games" \
  --game warioware-usa \
  --core "$artifact_root/browser_machine.wasm" \
  --dispatcher "$artifact_root/resident_dispatcher.wasm" \
  --coordinator "$artifact_root/core_run_coordinator.wasm" \
  --renderer-js "$artifact_root/browser_renderer.js" \
  --renderer-wasm "$artifact_root/browser_renderer_bg.wasm" \
  --bind 127.0.0.1 \
  --port 8787
```

Open this fixed-cap representative run in Chrome:

```text
http://127.0.0.1:8787/tools/resident_machine_first_frame.html?game=warioware-usa&instructionCap=100000000&executedCycleCap=250000000&sliceCycleCap=1000000&blockCap=16384&hostCallCap=65535&coldInstallCap=65535&bootReadCap=8192&bootTimeoutMs=180000&sliceTimeoutMs=180000&runTimeoutMs=600000&zeroProgressSliceCap=4096&checkpointTimeoutMs=10000&checkpointRecordCap=65535&probeEventCap=32768
```

Use a dedicated Chrome process/profile and arm
`tools/resident_machine_fidelity_watchdog.py` before navigating. Record an absolute start and
deadline exactly 600,000 ms apart, pass the dedicated browser PID and server PID, and wait until
the watchdog state is durably `armed-before-navigation`. The watchdog is a separate OS process;
at the deadline it verifies PID identity, SIGKILLs only the dedicated Chrome process, confirms its
exit, and leaves the journal server alive. Thus a blocked page main thread, DOM, or CDP target
cannot extend the run. The fixed setup is:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$capture_root/chrome-profile" \
  --remote-debugging-port=9229 \
  --no-first-run --no-default-browser-check about:blank

python3 tools/resident_machine_fidelity_watchdog.py \
  --state "$capture_root/watchdog.json" \
  --start-unix-ms <recorded-before-navigation-ms> \
  --deadline-unix-ms <start-plus-exactly-600000-ms> \
  --browser-pid <dedicated-chrome-pid> \
  --server-pid <fidelity-server-pid> \
  --expected-url '<exact URL above>' \
  --browser-identity-fragment "$capture_root/chrome-profile" \
  --server-identity-fragment 'resident_machine_fidelity_server.py'
```

Navigate only after the armed state is present. After the watchdog confirms browser termination,
copy/validate the journal while the server remains alive; then stop the server with SIGINT so its
`finally` path closes and fsyncs the journal. Never SIGKILL the server at the wall deadline.

The page installs the renderer's exact default-off, total/nonthrowing six-u32 hook,
`globalThis.__lazuliResidentRenderProbe`. JavaScript persists the six words unchanged and never
maps stage or work IDs to behavior. A dedicated checkpoint Worker remains able to POST and await
disk acknowledgements while the page main thread is inside renderer Wasm.

For every opaque request, the relay owns and hashes the request and then preserves this durable
ordering:

1. await an fsync'd `pre-submit` record;
2. call `submit_resident_render` without awaiting it;
3. immediately await an fsync'd `submit-returned` record containing `returnedPromise: true` and
   the immediate presented-XFB boolean, but no receipt fields;
4. await the returned Promise, own and hash its receipt, then await an fsync'd `receipt-resolved`
   record; and
5. continue the existing first-XFB capture and canonical receipt relay.

Probe events may occur on either side of `submit-returned` while the same submission remains open.
The durable presence or absence of `submit-returned` distinguishes a synchronous method stall from
a method that returned. If no later receipt checkpoint exists, the diagnostic says the receipt was
`not-yet-observed`; it does not claim when the Promise internally settled while the fsync was in
flight. The server enforces exact request identity, monotonic client
sequence, `pre-submit -> probe* -> submit-returned -> probe* -> receipt-resolved` ordering, the
65,535-record cap, the independent 32,768-probe-event run cap, the frozen Rust limit of 402 opaque
probe events per submission, and an exclusive JSONL hash chain with flush/fsync per record.

The complete first-frame report authenticates that prefix with this exact capture order:
`opaque-request-copied-and-hashed -> pre-submit-durable ->
submit-resident-render-returned -> submit-returned-durable ->
submit-resident-render-resolved -> receipt-resolved-durable ->
first-presented-xfb-transition`. Renderer diagnostics, drain/health/readback, hashing, receipt
relay, and enclosing Rust acceptance follow in their already-frozen order. The report validator
rejects any missing, substituted, or reordered stage.

The transition is defined narrowly as `has_presented_xfb() === false` immediately before the call
and `true` by Promise resolution. The evidence also preserves the immediate after-return boolean;
it does not imply that presentation happened only after the method returned. The first such
transition is then captured inside the renderer relay. After the receipt resolves and before it is
posted to the worker, the page:

1. snapshots renderer diagnostics;
2. drains the renderer and checks health;
3. reads `read_presented_xfb_rgba()` and checks health again;
4. snapshots renderer diagnostics again;
5. hashes the raw renderer-owned RGBA and opaque receipt; and
6. posts the untouched receipt to the worker.

The evidence becomes complete only after the enclosing `resident-run-result` returns cleanly and
its adapter diagnostics cover the triggering render-call ordinal. The runner records all exact
instruction, executed-cycle, wall, host-call, cold-install, boot-read, and zero-progress bounds.
Any cap, timeout, Rust stop, receipt rejection, second first-transition capture, transport fault,
or renderer fault produces failed evidence.

Every adapter diagnostic now carries one opaque `MachineEvidenceV1` envelope. The Rust ABI is
exactly 816 bytes (204 little-endian u32 words); browser JavaScript copies and canonical-base64
encodes those bytes but does not interpret any word. The offline decoder mirrors the complete Rust
canonical-shape predicate, preserves every u64 as a `BigInt` internally and a decimal string in
JSON, and emits only the diagnostic allowlist. Scheduler PC and address-space generation are
offline diagnostics only: the page never reads them or uses them as policy. The output omits boot
identity, SI packet contents, RAM contents, host descriptors, and title-specific interpretation.

For locked Wario publication, the validator privately binds the committed identity to `GZWE01`,
revision 0, disc 0, CISO, and logical image length 1,459,978,240 bytes. That logical length is not
the 889,225,792-byte physical CISO container length. Complete evidence requires canonical ready
and terminal snapshots from one machine epoch, monotonic Rust-owned cumulative families, exact
run and adapter joins, a healthy presented XFB/VI chronology, balanced renderer barriers, and no
terminal/device/DI/GX failure evidence. A failure after a successful boot must still carry a
canonical available terminal snapshot. A typed setup/pre-core failure may have none, but it is
never publishable; an `available: false` envelope is likewise rejected as a diagnostic conclusion.

Decode a terminal report (or a standalone envelope for offline diagnosis) with:

```sh
node tools/resident_machine_evidence_v1.mjs report.json
```

Capture `globalThis.__residentFirstFrameEvidence` or `#result`, then validate it with:

```sh
node tools/resident_machine_first_frame_report.mjs --require-complete report.json
```

The checkpoint journal is independently usable when the page never yields. Validate and summarize
the hash chain with:

```sh
node tools/resident_machine_fidelity_checkpoint_report.mjs \
  --evidence-lock "$workspace_root/tools/resident_machine_fidelity_evidence_lock_legacy_fixture.json" \
  "$capture_root/checkpoints.jsonl"
```

Use `--require-resolved` only when a fully resolved receipt is expected. Without that flag, the
summary reports one of `submit-method-did-not-return`,
`submit-returned-receipt-not-yet-observed`, or `all-receipts-resolved` from durable ordering alone.

No complete frame result is accepted by the diagnostic validator alone. A complete result must be
joined to the same immutable lock and journal:

```sh
node tools/resident_machine_fidelity_combined_report.mjs \
  --evidence-lock "$workspace_root/tools/resident_machine_fidelity_evidence_lock_legacy_fixture.json" \
  --journal "$capture_root/checkpoints.jsonl" \
  --report "$capture_root/first-frame-report.json"
```

This combined gate requires a nonzero probe stream, exact policy/artifacts, journal/client totals,
the captured request and receipt identities, the false-before-call to true-by-resolution
transition, RGBA/receipt hashes, and enclosing Rust receipt acceptance. The old non-probe
first-frame validator remains independently frozen and is not an authority for this probe run.

The validator anchors the exact frozen corpus, title identity, core/dispatcher/coordinator,
renderer artifacts, capture ordering, diagnostic deltas, raw-range accounting, and client/core
render totals. It never decodes request or receipt bytes and never classifies pixel content.
