# clankers_dsp — FFI surface for native consumers

This document exists so a fresh Claude Code session (or a new human) working
on a native consumer — e.g. the `ClankersDesktop` JUCE app — has everything
needed without reading through prior conversations.

## What this crate is

Pure-Rust DSP core for the Clankers project. Eight engines:

- `drums` — 808/909/606 drum machine, 7 voices
- `bass` — FM bass with TPT ladder filter, 8 voices
- `buchla` — 259/292-style LPG percussion, 8 voices
- `rhodes` — FM tine EP with chorus/tremolo, stereo
- `pads` — HybridSynth pads w/ Moog ladder + chorus + reverb, stereo
- `voder` — parallel-formant vocal synth, 4 voices (this is the "sing" engine)
- `graph::engine::SynthGraph` — LLM-designed modular synth
- `graph::engine::GraphFx` — LLM-designed FX processor

Also exposes the DSP building blocks (`biquad`, `moog_ladder`, `tpt_ladder`,
`ms20_filter`, `oscillator`, `envelope`, `reverb`, `chorus`, `delay`, `lpg`,
`vactrol`, `wavefolder`, `rng`) as `pub mod`s.

## Two build modes

### Web (default)
```
wasm-pack build --target web --out-dir ../web/wasm
```
Produces `web/wasm/clankers_dsp*.{wasm,js,d.ts}`. Uses the `wasm` cargo
feature (on by default) which pulls in `wasm-bindgen` + `js-sys` and
compiles `src/wasm.rs` — the `#[wasm_bindgen]` wrappers that give JS the
`ClankersDrums`, `ClankersBass`, ... classes.

### Native (for JUCE etc.)
```
cargo build --release --no-default-features
```
- Skips `wasm-bindgen` entirely.
- Emits `staticlib`, `cdylib`, and `rlib` simultaneously (see
  `crate-type` in `Cargo.toml`).
- On Windows: `target/release/clankers_dsp.lib`,
  `clankers_dsp.dll`, `clankers_dsp.dll.lib`.
- On macOS: `libclankers_dsp.a`, `libclankers_dsp.dylib`.
- On Linux: `libclankers_dsp.a`, `libclankers_dsp.so`.

Native builds automatically compile `src/ffi.rs` (gated on
`#[cfg(not(target_arch = "wasm32"))]`) which exports the C ABI.

## C ABI

Header: [`include/clankers_dsp.h`](include/clankers_dsp.h).

All functions follow a flat, opaque-handle pattern:

```c
ClankersDrums* drums = clankers_drums_new(0xd3ad);
clankers_drums_set_profile(drums, 1);        // 909
clankers_drums_trigger(drums, 0, 1.0f);      // kick
float buf[512];
clankers_drums_process(drums, buf, 512);     // mono, 44.1kHz
clankers_drums_free(drums);
```

**Current status: only `drums` has a C ABI wrapper as proof-of-concept.**
The other engines are reachable from Rust (`clankers_dsp::bass::BassEngine`
etc.) but need wrapper functions before C/C++ can call them. Adding a new
engine's C ABI is mechanical — see `src/ffi.rs` for the pattern.

### Conventions to follow when extending

- **One `extern "C"` function per Rust method.** Name pattern:
  `clankers_<engine>_<method>`.
- **First arg is always `*mut ClankersXxx`** (or `*const` for read-only).
- **CC-JSON param bundles** (used by Bass/Buchla/Rhodes/Pads/Voder) should
  take `const char*` for the JSON string — the Rust side already has
  `parse_*_params` helpers in `src/wasm.rs`; promote them to `pub(crate)`
  in a shared module so `ffi.rs` can reuse them.
- **Stereo `process` functions** take two float buffers (`left`, `right`)
  rather than an interleaved buffer — cheaper for JUCE which has separate
  channel buffers anyway. (The WASM side interleaves because JS typed
  arrays are easier that way; don't copy that choice for the C ABI.)
- **Constructors never return NULL.** `Box::into_raw(Box::new(...))` is
  infallible.
- **`_free(NULL)` is a no-op.** Match the pattern in `clankers_drums_free`.
- **No allocation in `_process`.** All buffers are caller-owned.

## What native consumers should know

- **Sample rate is hardcoded to 44_100 Hz.** There's no per-engine SR
  config yet. If JUCE is running at 48 kHz you'll get +8.8% pitch until
  this is added. Adding it means threading an `f32 sample_rate` through
  each engine's `new()` — not done yet because the web app only uses
  44.1k.
- **No MIDI.** The engines take `midi_note: u8` and `velocity: f32`
  directly; there's no byte-stream MIDI parser. JUCE's `MidiBuffer`
  unpacks into exactly these fields, so it's trivial to wire up.
- **Single-threaded per instance.** No internal locking. Call audio-rate
  methods (`trigger`, `process`) from the audio thread; control-rate
  methods (`set_*`) from another thread need external sync.
- **CC-JSON strings are cheap to parse** (simple hand-rolled parser in
  `parse_cc_map`), but still — don't call `set_params` in the audio
  callback. Parse once on the control thread, hold decoded params, feed
  them in by value.

## JSON schemas (shared with the web app)

The web app persists sheets, Synth Lab patches, and songs as JSON.
Both apps should read/write identical shapes so projects travel.

- **Sheet** (composition): see `web/sheet.js` — steps/tracks/notes, plus
  per-track instrument params.
- **Synth Lab patch** (graph): see `web/synth/` — JSON graph consumed by
  `SynthGraph::new(graph_json, num_voices)`.
- **Song**: arrangement of pattern-bank slots.
- **Project file** (`.clank`): container bundling sheets, patches, and
  arrangement. Examples at the repo root: `clankers_demo.clank`,
  `clankers_project.clank`.

None of these schemas are formally versioned yet. When the JUCE app
starts reading/writing them, introduce a `"version": 1` field and
a schema fixture directory under `clankers_dsp/schemas/` so both apps
test-load the same files.

## What's *not* here yet

These live in the web app and need to be reimplemented in the JUCE app
(or extracted into a shared location):

- **Sequencer** — `web/sequencer.js` is a Web Audio lookahead scheduler.
  JUCE wants a sample-accurate audio-callback voice pool. Different
  model; the `Sheet` data structure is the shared contract.
- **Grapheme-to-phoneme for Voder lyrics** — `web/synth/voder-g2p.js`.
  Small (~KB of rules). Either port to Rust inside this crate, or port
  to C++ inside the JUCE app. Porting to Rust here is better: both apps
  stay in sync.
- **LLM proxy** — `api/llm.js` (Vercel serverless, multi-provider:
  Anthropic/OpenAI/Gemini/MiniMax). JUCE app replaces this with direct
  libcurl/cpr calls.
- **Project persistence** — currently `localStorage`; desktop needs
  JSON files on disk.

## Reference: key paths

```
clankers_dsp/
├── Cargo.toml              # features: default=["wasm"], wasm optional deps
├── include/clankers_dsp.h  # C header (hand-written to match src/ffi.rs)
├── src/
│   ├── lib.rs              # pub mod declarations + cfg'd wasm/ffi
│   ├── wasm.rs             # wasm-bindgen wrappers (feature="wasm")
│   ├── ffi.rs              # C ABI (cfg'd off for wasm32 target)
│   ├── drums.rs bass.rs buchla.rs rhodes.rs pads.rs voder.rs
│   ├── graph/              # SynthGraph + GraphFx
│   └── biquad.rs moog_ladder.rs tpt_ladder.rs ms20_filter.rs ...
└── build.sh                # wasm-pack wrapper for web build
```
