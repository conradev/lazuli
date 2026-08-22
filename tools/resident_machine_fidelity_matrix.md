# Rust-resident fidelity acceptance matrix

Date: 2026-08-22. Development design and evidence inventory only; nothing here is deployed.

## Evidence boundary

The repository contains executable legacy acceptance contracts and synthetic projector fixtures, but
it does **not** contain a tracked, authenticated seven-title retail IAB capture. The title rows below
therefore reconstruct acceptance predicates; they are not seven prior compatibility passes.

Evidence labels used here:

- **Contract**: executable acceptance policy in the legacy tools.
- **Synthetic**: fixture or unit-test data, not an observed retail checkpoint.
- **Raw run**: SHA-bound local execution evidence with the stated narrow scope.
- **Authenticated capture**: a durable retail capture bound to its artifacts, corpus, and receipts.
  No complete seven-title example is tracked today.

The test-only historical Chrome 151 fixture in
[`resident_machine_corpus_full_report_legacy_fixture.json`](resident_machine_corpus_full_report_legacy_fixture.json)
records bounded Rust CPU residency for all seven images. It is not current production authority;
it has zero render calls and zero input samples, so it is not milestone, rendering, or
input-causality evidence. The Wario first-XFB record in
[`resident_machine_first_frame_warioware_external_timeout_report.json`](resident_machine_first_frame_warioware_external_timeout_report.json)
is negative evidence: no renderer RGBA, resolved receipt, or Rust receipt acceptance was recovered.

## Frozen corpus and witness policy

The source contract is [`compatibility/games/corpus.json`](compatibility/games/corpus.json), SHA-256
`43597e441ab8c38adb18beed8ac34895a8496cac8ac2112ef4cb27c7504f4fc6`. It fixes title order,
disc ID/revision, CISO bytes/SHA, renderer `wgpu-webgpu`, `fallbacks: false`, 120 sustained VI fields,
and 64 viewport frames.

The historical witness mapping in
[`browser_game_compatibility_iab_capture.mjs`](browser_game_compatibility_iab_capture.mjs) is:

| Title | Witness | Host mask |
| --- | --- | ---: |
| WarioWare | `a` | `0x0100` |
| Luigi's Mansion | `left` | `0x0001` |
| The Wind Waker | `left` | `0x0001` |
| Super Smash Bros. Melee | `left` | `0x0001` |
| F-Zero GX | `left` | `0x0001` |
| Metroid Prime | `left` | `0x0001` |
| Rogue Leader | `left` | `0x0001` |

The old CDP action held the visible controller control for 80 ms. That is historical capture policy,
not a title projector predicate.

## Generic acceptance gate

Every title needs all of these layers. A title projector cannot substitute for a missing generic
gate.

### Identity and continuity

- Exact corpus key, disc ID/revision, image bytes, format, and SHA-256.
- Same worker, active release, and raw disc source across baseline, input, receipt, and post state.
- Running snapshot with positive cycles, dispatches, and instructions; no terminal error or DevTools
  exception.

### Device health

- Positive raw disk reads, SI polls, and VI fields; no disk-device or disk-request error.
- DI last error `0x00000000`, controller queue overflows zero, and unknown SI output commands zero.
- Critical storage faults, when present, must be Rust-resolved page/protection faults with balanced
  raise/return/resolve counts, no recurrence/nesting/pending state, and no unrecoverable vectors.
- DSP LLE evidence is valid and the first unsupported DTK record is null.

The executable source is
[`browser_game_compatibility_oracle.mjs`](browser_game_compatibility_oracle.mjs), especially its
device-health and critical-storage-fault gates.

### Renderer, GX, VI, and XFB health

- Renderer submissions posted and acknowledged exactly; no failure, in-flight operation, or result
  miss; high-water at most one; texture-copy barriers balanced.
- Positive GX bytes, drains, commands, primitives, XFB copies, and presented frames. Emergency
  drains, pending bytes, decoder errors, fallback counters, unsupported telemetry, exact-required
  rejections, and texture errors are zero. Decoder carry stays inside its authenticated bounds.
- WebGPU backend is exact, metrics scope is `current-worker`, pending operations are zero, operation
  high-water is at most one, and renderer health/copy/drain/present calls are positive.
- The renderer-owned selected XFB matches Rust VI address, copy generation, field row, pair epoch,
  and presentation serial. It is positive-sized `rgba8unorm`, `top-left-row-major-tight`, exactly
  `width * height * 4` bytes, with valid raw hashes and complete RGB population accounting.
- A first visible frame has `other > 0` and `unique >= 2`; visibility cannot regress afterward.
- Across the sustained window, cycles/dispatches/instructions advance strictly; all progress
  counters are monotonic; VI advances by at least 120, host presentation and presentation serial by
  at least 64, and GX/primitives/renderer/SI/XFB/DSP all advance. At least two selected-XFB RGB hashes
  occur.

These are generic raw renderer/device predicates. Pixel meaning and playability are not inferred.

### Input and presentation chronology

The common transcript contract is
[`browser_game_first_playable_transcript_core.mjs`](browser_game_first_playable_transcript_core.mjs):

- Exactly one host pulse is published on the reused worker. Publication source is `periodic` or
  `direct`; scheduled cycle is no later than observed cycle; both lie within the baseline/post
  window; poll index and applied sequence advance.
- The Rust title projector authenticates a matching guest receipt at or after host publication.
- A later VI presentation occurs at or after both host publication and guest receipt, advances the
  presentation serial, and has a different selected-XFB RGB hash from baseline.
- Acceptance mode is `guest-consumed`, not merely “host input was queued.”

## Per-title Rust projector matrix

Legacy addresses and layouts in the linked projector modules are migration inputs for Rust. They
must not be read or interpreted by the page, checkpoint Worker, or any new runtime JavaScript.

### 1. WarioWare, Inc.: Mega Party Game$!

- Identity: `GZWE01`, revision 0, 889,225,792 bytes, SHA
  `b8c33924afed0fec165afc3fe0d6e8dddfcdef53842fcae180560b3b904b4a81`.
- Corpus milestone: `live-microgame`.
- Rust oracle ID/version: `warioware-repellion-a-v2`.
- Legacy projector:
  [`browser_game_first_playable_warioware.mjs`](browser_game_first_playable_warioware.mjs).
- Required predicate: player 0 is running Repellion, exact microgame ID `0x63`, with no-card flow
  inactive and stable mapped runtime, player, and active ID across baseline, receipt, and post. The
  baseline has A released and result zero. The matching guest receipt holds A (`0x0100`) while the
  result remains zero; the later post state has A released and a nonzero result.
- Historical layout inputs include gameplay buttons at runtime `+0x4b160`, player-object pointer at
  runtime `+0x4b178`, and player-object result at object `+0x1230`.
- This is a `P_CAUSAL_DELTA` witness: the accepted record binds the A-held receipt to Repellion's
  subsequent A-release and zero-to-nonzero result transition before a later authenticated
  presentation.

### 2. Luigi's Mansion

- Identity: `GLME01`, revision 0, 199,262,784 bytes, SHA
  `a868fd4bcf4d304aae74fb32ddb067e605d64db35e035c248a630d05a7d8ac4f`.
- Corpus milestone: `controllable-foyer`.
- Rust oracle ID/version: `luigis-mansion-foyer-left-v1`.
- Legacy projector:
  [`browser_game_first_playable_luigi.mjs`](browser_game_first_playable_luigi.mjs).
- Required predicate: foyer room info `0x02000102`, live scene/game gates, expected player identity,
  positive health, open controls, stable player/pad/controller, and neutral baseline. Receipt has host
  left, guest held `0x01000001`, X at most `-0.5`, `abs(Y) <= 0.125`, and stick value/controller
  magnitude in `[0.5, 1.001]`. Baseline-to-post and latch-to-post position distance squared both
  exceed `1e-4`.
- This legacy oracle requires movement; a turning-only result is insufficient despite the corpus's
  broader wording.

### 3. The Legend of Zelda: The Wind Waker

- Identity: `GZLE01`, revision 0, 1,088,455,232 bytes, SHA
  `677726191ba8cc0829e9baa731c14eeff95ba399e1fe40a4f2473e7b8e0c80ac`.
- Corpus milestone: `controllable-outset-island`.
- Rust oracle ID/version: `wind-waker-outset-left-v1`.
- Legacy projector:
  [`browser_game_first_playable_wind_waker.mjs`](browser_game_first_playable_wind_waker.mjs).
- Required predicate: stage `sea`, room/stay/player room 44, player process `0x00a9`, expected player
  profile, no event/menu/pause gate, and neutral baseline. Receipt has host left, guest hold `0x8000`,
  X in `[-1.001, -0.5]`, `abs(Y) <= 0.125`, and stick value in `[0.5, 1.001]`. Baseline-to-post and
  latch-to-post planar distance squared both exceed `1e-4`.

### 4. Super Smash Bros. Melee, revision 2

- Identity: `GALE01`, revision 2, 1,449,165,376 bytes, SHA
  `b7de482eb955c8a96b6746dfa043b69ae7bf6c7c2a09ac382b9da126faa7055c`.
- Corpus milestone: `active-match`.
- Rust oracle ID/version: `melee-active-match-left-v1`.
- Legacy projector:
  [`browser_game_first_playable_melee.mjs`](browser_game_first_playable_melee.mjs).
- Required predicate: exact versus routing, live unpaused match, player-one slot, stocks and active
  opponent, stable fighter identity, and neutral Wait motion 14. Receipt has host left, pad/fighter
  bits `0x00040001`, raw X `-80`, normalized X `-1`, and Wait or locomotion motion 15–23. Match frame
  and joystick-direction count advance; post motion is 15–23; all three measured movements are
  leftward and exceed `1e-4`; self velocity X and terminal position delta X are negative.
- This implements the left-movement branch only, not the corpus's alternative attack branch.

### 5. F-Zero GX

- Identity: `GFZE01`, revision 0, 1,438,679,616 bytes, SHA
  `3d45ca0cdd5ed408c4dd417bc0a1691ef48b7d59fab123963bd9e934be6ee91e`.
- Corpus milestone: `active-race`.
- Rust oracle ID/version: `fzero-gx-active-race-steer-v1`.
- Legacy projector:
  [`browser_game_first_playable_fzero.mjs`](browser_game_first_playable_fzero.mjs).
- Required predicate: stable live-player racer identity, controller slot zero, input-disable mask
  `0x80` clear, AI/replay mask `0x04000000` clear, restore complete, crash/restore/breakdown gates
  clear, neutral baseline, and positive per-frame motion and velocity. Receipt has host left,
  steer-Y/strafe zero, steer-X in `[-1, -0.5]`, and duplicate steer-X exactly equal. Receipt/post
  frames advance and baseline-to-post plus latch-to-post movement exceed `1e-4`.

### 6. Metroid Prime, revision 2

- Identity: `GM8E01`, revision 2, 1,344,307,776 bytes, SHA
  `f168d1da2ab7055c1b7fa4976c69d93c17a59057dfca936871a6539958825ffd`.
- Corpus milestone: `controllable-frigate`.
- Rust oracle ID/version: `metroid-prime-frigate-left-turn-v1`.
- Legacy projector:
  [`browser_game_first_playable_metroid_prime.mjs`](browser_game_first_playable_metroid_prime.mjs).
- Required predicate: exact manager/player, world asset `0x158efe17`, area zero, active first-person
  camera, alive/unfrozen/input-enabled player, and orthonormal transform. Receipt has host left,
  left-X in `[-1, -0.5]`, other axes within `0.125`, triggers zero, buttons2 `0x20`, buttons3 zero or
  `0x02`, stable lifetime, and monotonic input/update frames. Post update follows receipt and the
  durable forward-vector delta exceeds `1e-6`.
- Position movement is not required; this is a turn witness.

### 7. Star Wars Rogue Squadron II: Rogue Leader

- Identity: `GSWE64`, revision 0, 1,400,930,880 bytes, SHA
  `f045960fc62aa885b05cb7eb725436cfbbb17221e38b0f7e8fadb8408e710686`.
- Corpus milestone: `active-flight`.
- Rust oracle ID/version: `rogue-leader-xwing-left-control-response-v1`.
- Legacy projector:
  [`browser_game_first_playable_rogue_leader.mjs`](browser_game_first_playable_rogue_leader.mjs).
- Required predicate: exact player manager/control path/X-Wing vtables, craft state zero, stable craft
  lifetime, and valid right-handed orthonormal transform. Receipt has host left, raw X in
  `[-128, -36]`, `abs(rawY) <= 16`, normalized axes equal `fround(raw / 72)`, coherent global axes,
  shaped X in `[-1.001, -0.5]`, and `abs(Y) <= 0.125`. A retained neutral baseline precedes the
  publication and either control-response field `+0x460` or `+0x464` changes by more than `0.0001`.
- The current post input may already be released. Craft position/orientation change is not required;
  the causal witness is the retained control-response transition.

## Proposed Rust-authenticated acceptance record

The title-specific record should be produced and accepted by Rust, then exposed to JavaScript only
as opaque canonical bytes. Its authenticated content should bind at least:

- corpus key, disc identity, image SHA-256, Rust oracle ID/version, and exact core artifact identity;
- baseline, host-publication, guest-receipt, and post cycles plus controller sequence;
- a versioned predicate bitmap whose bits correspond to the exact title row above;
- canonical hashes of the Rust-owned baseline, receipt, and post projections;
- generic device, GX, renderer, VI/XFB, sustained-window, and fault/cap summaries;
- the canonical renderer receipt identity and presentation after the guest receipt.

The dev page may publish input samples, relay opaque render requests/receipts, hash opaque bytes,
and persist checkpoints. It must not read guest memory, evaluate title addresses, parse packets,
interpret device state, or set a dispatch table. Fixture literals remain tests for the future Rust
projectors, not claimed retail observations.

## Production attestation contract

The production gate is
[`resident_machine_production_fidelity_gate.mjs`](resident_machine_production_fidelity_gate.mjs).
The conventional input name is `tools/resident_machine_production_fidelity_attestation.json`, but
that file must remain absent until all seven retail captures described below exist. It must not be
checked in: embedding an exact release ID/source commit in a later commit creates a Git/release
self-reference. The gate instead accepts a supplied immutable run artifact bound to the same source
SHA and release manifest, or an untracked permission-restricted local bundle for manual cutover. A
unit-test fixture is synthetic contract coverage; it is never a production attestation.

The attestation schema is `lazuli-resident-production-fidelity-attestation-v1`. It contains only
SHA-256/byte-count/path references to evidence stored beneath the attestation directory. Absolute
paths, `..`, symlink escapes, unknown keys, unavailable envelopes, and unreferenced bytes fail
closed. The gate takes the candidate manifest separately:

```sh
node tools/resident_machine_production_fidelity_gate.mjs \
  --attestation tools/resident_machine_production_fidelity_attestation.json \
  --release-manifest web/dist/release.json
```

The manifest must be a valid schema-4 release. Its raw JSON SHA-256, release ID, source commit,
resident ABI, and content-addressed core, dispatcher, coordinator, adapter, worker, frontend,
renderer glue, and renderer Wasm identities are bound into the attestation. The controlled
performance bundle contains and hashes those exact eight roles; a declaration alone is insufficient.

The controlled performance references are a complete seven-title fixed-instruction corpus report
and a release-bound `lazuli-resident-corpus-evidence-lock-v2`. They must pass
`validateResidentCorpusEvidence` with both `requireComplete` and `requireAll`, use the exact corpus
order, and identify the exact candidate executables. Before listening, the production corpus server
hashes and snapshots the exact page, runner, report validator, and server sources; it verifies all
eight packaged roles and serves their descriptor URLs. The page creates the Worker from the lock's
packaged Worker URL. Historical `e1e59d5...` CPU evidence and the checked-in v1 lock remain useful
negative/legacy evidence but cannot qualify a candidate release.

Each of the seven ordered run records binds one UUID and one candidate release to:

- one raw per-run `lazuli-resident-renderer-fidelity-evidence-lock-v3` reference and one raw durable
  checkpoint-journal reference whose byte counts and SHA-256 values are authenticated by the bundle;
- a complete existing `lazuli-rust-resident-first-visible-xfb-evidence-v1` report made with the
  candidate core, dispatcher, coordinator, and default-off production renderer bytes;
- the raw first-visible RGBA readback whose byte count and SHA-256 match that report;
- a later publication-safe 816-byte Rust `MachineEvidenceV1` snapshot from the same machine epoch;
- an Accepted 384-byte Rust `GFP1` record for the exact title projector; and
- raw RGBA readbacks for the Rust record's baseline and later `PresentationIdentity` values.

The gate recomputes RGBA byte length as `width * height * 4`, hashes the actual bytes, requires
opaque pixels, at least two RGB values, and at least one non-black/non-white value. These are
visibility checks only; JavaScript does not infer title semantics from pixels. Baseline and later
RGBA hashes must differ.

The v3 lock binds the raw schema-4 manifest and all eight release descriptors, exact run/title,
corpus/image/disc, capture sources, policies, and MachineEvidence ABI. Pre-navigation verification
hashes every source and raw execution file. The server serves source snapshots only, plus all eight
exact release URLs. V3 uses the production default-off renderer: the verifier requires its exact
total import count with no probe import/call, the server rejects injected probe events, and the
resolved journal and client summary must contain exactly zero probe events. The legacy v2 diagnostic
contract still requires a nonzero feature-probe stream.

The `GFP1` decoder requires Accepted status, no failure, the exact projector/disc/revision mapping,
the title's exact required/passed predicate bitmap, no failed predicate, a nonzero machine epoch,
nonzero projection and publication-packet hashes, and exact arm → host publication → guest receipt
→ post → later-presentation chronology. Baseline and later render sequence, presentation serial,
XFB generation, row, mode, parity, pair epoch, and dimensions are matched exactly to the raw frame
records. The later identity is also matched exactly to terminal `MachineEvidenceV1`. Terminal SI poll
index must be at or after the GFP guest-receipt poll. Observed cycle and received/applied sequences
remain monotone. Scheduled cycle is intentionally non-monotonic across later polls; scheduled,
observed, and source are required to match the GFP publication exactly only when the terminal poll is
the publication poll. The publication packet hash remains exact while the terminal applied sequence
is the GFP receipt sequence.

Finally, the first-frame and terminal machine snapshots must form one canonical monotone transition.
The terminal snapshot must retain publication health, positive retail disc/DSP/GX/VI/renderer
evidence, zero publication faults, at least 120 additional VI fields, at least 64 additional
presentations, and forward DSP, GX, XFB, renderer, and SI progress. No attestation should be written
until every one of these checks passes on all seven authenticated retail runs against the final
candidate package.
