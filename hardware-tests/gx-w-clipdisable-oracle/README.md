# GX W / ClipDisable real-console oracle

This is an empirical GameCube/Wii fixture for the unresolved GX homogeneous
W-plane behavior. It renders a fixed 16×16 red-on-black triangle surface for
ten W configurations under every value of XF register `0x1005`
(`ClipDisable`, modes 0–7), copies the EFB to RGBA8, and records the raw pixels.

The fixture deliberately contains no expected hardware results. A capture only
becomes authority after it has run on a real console and the resulting binary
has been archived with console and toolchain provenance.

No emulator renderer code is used by the DOL.

## Fixed experiment

- Primitive: one `GX_TRIANGLES` triangle.
- Cull mode: `GX_CULL_NONE`.
- Viewport: `(0, 0, 16, 16, 0, 1)`.
- Scissor: `(0, 0, 16, 16)`.
- Scissor box offset: `(0, 0)`.
- Depth test/write: disabled.
- Blend and dither: disabled.
- Clear/draw colors: opaque black and opaque red.
- Copy: 16×16 `GX_TF_RGBA8`.
- Position matrix: identity.
- Perspective projection:

  ```text
  clip.x = view.x
  clip.y = view.y
  clip.z = 0.5 * view.z
  clip.w = -view.z
  ```

Each vertex source Z is created by flipping the requested W sign bit. This
preserves the requested `+0`/`-0` distinction through the CPU/FIFO input; the
capture tells us whether GX itself preserves or collapses it.

The cases cover a positive-W control, positive tiny W, `+0`, `-0`, negative
tiny W, one and multiple negative-W endpoints, uniform negative W, and a
negative/zero/positive triangle. Exact f32 clip-space bit patterns are in
[oracle-manifest.json](./oracle-manifest.json).

The W=0 endpoints deliberately use a nonzero Y coordinate. A homogeneous
`(0, 0, 0, 0)` endpoint makes the source triangle's face determinant zero and
would only measure degenerate rejection—the same limitation seen in the public
SMB2 FIFO capture. Nonzero XY necessarily engages an X/Y plane at W=0, but
keeps the primitive nondegenerate so the eight-mode pixel matrix can reveal the
actual interaction.

One caveat is fundamental, not an omission: a point with W < 0 cannot satisfy
both homogeneous X planes or both Y planes. Negative-W observations therefore
necessarily also exercise GX's polygon/trivial-rejection decisions. The
symmetric cases and complete eight-mode matrix make those interactions
observable instead of assuming them away.

## ClipDisable matrix

Every case runs with values 0 through 7:

- bit 0: disable clipping detection;
- bit 1: disable trivial rejection;
- bit 2: disable cpoly clipping acceleration.

The register is loaded directly through the GX FIFO immediately before the
draw. The clear uses mode 0. No viewport, scissor, cull, depth, TEV, or copy
state changes across measured draws.

## Outputs

The program maintains a fixed big-endian mailbox:

- logical address: `0x81700000`;
- MEM1 physical offset: `0x01700000`;
- magic: `GXW1`;
- size: 94,784 bytes;
- complete status: `2`.

Every one of the 80 entries contains:

- case and ClipDisable mode;
- all three requested nominal clip-space XYZW f32 bit patterns;
- FNV-1a-64 of row-major RGBA;
- red-coverage count and 16 row masks;
- unexpected-color count;
- all 256 row-major RGBA pixels.

At completion, the mailbox itself carries an aggregate FNV-1a-64 over the
fixed 80-entry region. It is flushed to MEM1, so a debugger or USB Gecko dump
can recover it.

If `fatInitDefault()` succeeds, the fixture also writes:

- `gx-w-clipdisable-oracle-v1.bin` — the exact mailbox;
- `gx-w-clipdisable-oracle-v1.jsonl` — compact per-observation signatures.

The FAT write is optional. It does not participate in rendering, and the fixed
mailbox remains the browser replay handoff when filesystem emulation is absent.

## Build

Install current devkitPPC, libogc, and libfat, then set `DEVKITPPC`.

GameCube:

```sh
make PLATFORM=gamecube
```

Wii:

```sh
make PLATFORM=wii
```

Outputs are:

```text
gx-w-clipdisable-oracle-gamecube.dol
gx-w-clipdisable-oracle-wii.dol
```

The Makefile reserves the mailbox with
`--section-start=.oracle_mailbox=0x81700000`; the program also lowers Arena 1's
high boundary before allocation.

This Lazuli checkout already has a Rust PowerPC target and ELF-to-DOL
conversion for `ipl-hle`, but that runtime does not initialize VI, GX, a GPU
FIFO, EFB copies, or console storage. Reusing it for this oracle would require
inventing those hardware sequences. The fixture therefore uses libogc's
established initialization/copy paths and only performs the experimental
ClipDisable write directly.

## Real-hardware capture

GameCube:

1. Build the GameCube DOL.
2. Copy it to an SD Gecko and launch it with Swiss.
3. Leave writable FAT storage mounted.
4. Wait for `complete: 80 observations`.
5. Press START to return, then archive both output files.

Wii:

1. Build the Wii DOL.
2. Launch it from the Homebrew Channel or with `wiiload`.
3. Leave writable SD storage mounted.
4. Wait for `complete: 80 observations`.
5. Press START on a connected GameCube controller, or power-cycle after the
   files have been written.

For each capture, record at least:

```text
console model and region
GameCube or Wii execution path
devkitPPC version
libogc version/commit
fixture source commit
SHA-256 of the DOL
SHA-256 of the .bin capture
```

Parse and verify a capture:

```sh
node tools/parse-mailbox.mjs --strict gx-w-clipdisable-oracle-v1.bin
```

Use `--pixels` to include all RGBA words in JSON output.

## Browser replay

Build Lazuli's compiler and generate a local-only standalone-DOL harness:

```sh
cargo build --release --target wasm32-unknown-unknown -p ppcwasmjit
cargo run --release -p ppcwasmjit --example browser_boot -- \
  target/gx-w-clipdisable-oracle-browser/index.html \
  target/wasm32-unknown-unknown/release/ppcwasmjit.wasm \
  hardware-tests/gx-w-clipdisable-oracle/gx-w-clipdisable-oracle-gamecube.dol
python3 -m http.server 8765 \
  --directory target/gx-w-clipdisable-oracle-browser
```

Open `http://127.0.0.1:8765/` in the in-app browser. This harness is strictly
local test output: do not add the DOL, its harness, or a game-specific route to
the repository's public web surface.

1. Run until the mailbox status at logical `0x81700028` is `2`.
2. Dump 94,784 bytes from logical `0x81700000` (or physical MEM1 offset
   `0x01700000`) with the debug harness.
3. Parse with `tools/parse-mailbox.mjs --strict`.
4. Compare the 80 verified hardware entries by `(caseId, clipDisable)`, using
   both the exact RGBA hash and pixels. A signature match without mailbox
   verification is not certification.

The exact comparator performs those checks and reports every differing pixel:

```sh
node tools/compare-mailboxes.mjs hardware.bin browser.bin
```

The parser also accepts a complete MEM1 dump and finds the validated `GXW1`
header automatically.

Run its host-only ABI/verification tests with:

```sh
node --test tools/parse-mailbox.test.mjs
```

## Provenance

The direct XF-load and RGBA8 EFB-readback approach follows the public Dolphin
hardware-test methodology, particularly Pokechu22's `gxtest/clipping.cpp`,
`gxtest/rasterization.cpp`, and `gxtest/util.cpp`:

- <https://github.com/Pokechu22/hwtests>
- <https://bugs.dolphin-emu.org/issues/13489>

Those tests establish useful guardband and clipping probes, but they do not
provide this fixture's complete negative/zero/positive W × ClipDisable pixel
matrix. This new capture is intended to fill that specific evidence gap.
