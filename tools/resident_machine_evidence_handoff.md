# Rust-resident browser evidence handoff

Date: 2026-08-17. This is development evidence only; nothing here was deployed.

## Seven-game bounded CPU residency

The test-only historical Chrome 151 fixture in
[`resident_machine_corpus_full_report_legacy_fixture.json`](resident_machine_corpus_full_report_legacy_fixture.json)
records all seven SHA-bound CISO entries from the checked-in compatibility corpus. It is retained
for validator regression coverage and is not current production evidence.

- Report SHA-256: `e1e59d5e890f7e3b81e68d1e6d5646eb25d1450ae65d10110336f6931ad7b159`
- Trusted lock SHA-256: `0f7ef8fab80c8458ceae3edea70ecf60d303de97732a0c7c4a42cdf8ecbbd695`
- Corpus SHA-256: `43597e441ab8c38adb18beed8ac34895a8496cac8ac2112ef4cb27c7504f4fc6`
- Rust boot reads: 180; HTTP ranges: 187 = seven size probes + 180 boot reads + zero DI reads.
- Warmup plus measurement: 6,228,017 instructions, 11,827,246 cycles, 56 Rust outcomes,
  and 10,534 cold installs.
- Stops, host/cold caps, timeouts, zero-progress slices, invalid ranges, precondition failures,
  renderer failures, DI reads, render calls, and input samples: all zero.

Reproduce the historical validation only by naming both legacy fixtures explicitly:

```sh
node tools/resident_machine_corpus_report.mjs \
  --require-complete \
  --require-all \
  --lock tools/resident_machine_corpus_evidence_lock_legacy_fixture.json \
  tools/resident_machine_corpus_full_report_legacy_fixture.json
```

The hardened validator rejects empty publication, corpus/artifact/transport rewrites, policy and
arithmetic contradictions, counter regression, typoed CLI flags, incomplete failure evidence,
post-isolation execution, and nonterminal failure with `continueOnFailure=false`.

Safe claim: in this trusted-local run, every selected image reached Rust boot commit and crossed
the configured 250,000-instruction warmup and 500,000-instruction measurement targets with
positive Rust-reported cycles and no observed boundary fault. This is not a compatibility,
gameplay, visual, or input-causality pass, and the v1 report does not cryptographically bind the
runner/adapter/Worker JavaScript sources.

## First renderer-owned presented-XFB attempt

The fixed WarioWare attempt did **not** produce first-frame evidence. Its immutable bounds were
100,000,000 instructions, 250,000,000 executed cycles, and 600 seconds of wall time. The page main
thread stopped yielding; the external deadline elapsed with no final page report, renderer-owned
RGBA, opaque receipt, or Rust receipt acceptance. Termination was late-enforced and is recorded
without accepting any post-deadline outcome in
[`resident_machine_first_frame_warioware_external_timeout_report.json`](resident_machine_first_frame_warioware_external_timeout_report.json).

The only final observable state was 24 exact physical reads / 2,618,766 bytes with zero invalid or
precondition failures, matching one size probe plus the independently validated 23-read Wario boot
pattern. Instructions, cycles, cold installs, host calls, render calls, and renderer diagnostics are
unobservable and remain null.

Static audit found no literal infinite renderer loop. The highest-risk boundary is the synchronous
prefix of `submit_resident_render`: request copy and double parse, exact geometry preparation,
per-draw resource/binding creation, synchronous pipeline creation, primitive-expanded command
encoding, and queue submission all occur before the first returned Promise can yield the page.
Legal 32 MiB / 65,536-draw inputs make this finite path operationally unbounded. The next proof
should use a default-off Rust renderer stage probe and feature-only elapsed/work caps at draw,
pipeline, primitive, and queue-submit boundaries; JavaScript should record only Rust-authored
numeric stages and opaque request identity, never packet or guest semantics.

## Verification

```sh
node --test \
  tools/resident_machine_corpus_report.test.mjs \
  tools/resident_machine_first_frame_report.test.mjs
node --check tools/resident_machine_corpus.mjs
node --check tools/resident_machine_first_frame.mjs
```

At handoff these suites contain 17 passing tests. The Chrome tab and local evidence server from the
first-frame attempt were both stopped, and the server port had no remaining listener.
