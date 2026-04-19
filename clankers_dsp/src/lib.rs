//! Clankers DSP core — pure-Rust audio engines (drums, bass, buchla, rhodes,
//! pads, voder, synth graph, graph fx) plus shared building blocks (filters,
//! envelopes, oscillators, etc.).
//!
//! Two build modes:
//!   - Default (`wasm` feature, on): compiles the `wasm` module with
//!     `wasm-bindgen` wrappers — this is what `wasm-pack` emits for the web app.
//!   - `--no-default-features`: skips `wasm-bindgen`/`js-sys` and exposes the
//!     pure engines directly for native consumers (e.g. a JUCE desktop app
//!     linking the `cdylib`/`staticlib`).

pub mod bass;
pub mod biquad;
pub mod buchla;
pub mod chorus;
pub mod delay;
pub mod drums;
pub mod envelope;
pub mod graph;
pub mod lpg;
pub mod moog_ladder;
pub mod ms20_filter;
pub mod oscillator;
pub mod pads;
pub mod reverb;
pub mod rhodes;
pub mod rng;
pub mod tpt_ladder;
pub mod vactrol;
pub mod voder;
pub mod wavefolder;

#[cfg(feature = "wasm")]
mod wasm;
