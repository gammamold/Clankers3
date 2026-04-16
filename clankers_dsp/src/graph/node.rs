/// DspNode — enum wrapping existing DSP primitives for graph-based synthesis.
///
/// Each variant wraps a battle-tested module from the crate.
/// Per-sample dispatch via match — no trait objects, no heap allocation in hot loop.

use crate::oscillator::{Oscillator, Waveform};
use crate::envelope::Envelope;
use crate::tpt_ladder::TptLadder;
use crate::rng::Rng;
use crate::delay::DelayLine;
use crate::reverb::Reverb;

const SR: f32 = 44100.0;

/// Maximum input/output slots per node.
pub const MAX_SLOTS: usize = 4;

// ── Waveform index mapping ──────────────────────────────────────────────────

fn waveform_from_index(i: u8) -> Waveform {
    match i {
        0 => Waveform::Sine,
        1 => Waveform::Saw,
        2 => Waveform::Square,
        3 => Waveform::Triangle,
        4 => Waveform::Pulse,
        _ => Waveform::Sine,
    }
}

// ── Node type identifiers ───────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum NodeType {
    Oscillator,
    Envelope,
    TptLadder,
    Noise,
    Delay,
    Reverb,
    Gain,
    Mixer,
    Output,
}

// ── Parameter descriptors ───────────────────────────────────────────────────

/// Describes a single tweakable parameter.
#[derive(Clone)]
pub struct ParamDesc {
    pub name: &'static str,
    pub min: f32,
    pub max: f32,
    pub default: f32,
}

/// Return the parameter descriptors for a node type.
pub fn param_descs(nt: NodeType) -> &'static [ParamDesc] {
    match nt {
        NodeType::Oscillator => &[
            ParamDesc { name: "waveform",    min: 0.0, max: 4.0, default: 0.0 },
            ParamDesc { name: "octave",      min: -3.0, max: 3.0, default: 0.0 },
            ParamDesc { name: "detune",      min: -100.0, max: 100.0, default: 0.0 },
            ParamDesc { name: "level",       min: 0.0, max: 1.0, default: 1.0 },
            ParamDesc { name: "fm_depth",    min: 0.0, max: 8000.0, default: 0.0 },
            ParamDesc { name: "pulse_width", min: 0.05, max: 0.95, default: 0.5 },
        ],
        NodeType::Envelope => &[
            ParamDesc { name: "attack",  min: 0.001, max: 8.0, default: 0.01 },
            ParamDesc { name: "decay",   min: 0.001, max: 8.0, default: 0.3 },
            ParamDesc { name: "sustain", min: 0.0, max: 1.0, default: 0.0 },
            ParamDesc { name: "release", min: 0.01, max: 15.0, default: 0.1 },
        ],
        NodeType::TptLadder => &[
            ParamDesc { name: "cutoff",    min: 20.0, max: 20000.0, default: 2000.0 },
            ParamDesc { name: "resonance", min: 0.0, max: 1.0, default: 0.0 },
            ParamDesc { name: "drive",     min: 1.0, max: 10.0, default: 1.0 },
        ],
        NodeType::Noise => &[], // no params — just outputs white noise
        NodeType::Delay => &[
            ParamDesc { name: "time",     min: 0.01, max: 2.0, default: 0.3 },
            ParamDesc { name: "feedback", min: 0.0, max: 0.95, default: 0.4 },
            ParamDesc { name: "mix",      min: 0.0, max: 1.0, default: 0.3 },
        ],
        NodeType::Reverb => &[
            ParamDesc { name: "room_size", min: 0.0, max: 1.0, default: 0.5 },
            ParamDesc { name: "damp",      min: 0.0, max: 1.0, default: 0.5 },
            ParamDesc { name: "mix",       min: 0.0, max: 1.0, default: 0.3 },
        ],
        NodeType::Gain => &[
            ParamDesc { name: "level", min: 0.0, max: 4.0, default: 1.0 },
        ],
        NodeType::Mixer => &[
            ParamDesc { name: "gain", min: 0.0, max: 4.0, default: 1.0 },
        ],
        NodeType::Output => &[
            ParamDesc { name: "gain", min: 0.0, max: 2.0, default: 0.7 },
        ],
    }
}

// ── DspNode enum ────────────────────────────────────────────────────────────

pub enum DspNode {
    Oscillator(Oscillator),
    Envelope(Envelope),
    TptLadder(TptLadder),
    Noise(Rng),
    Delay(DelayLine),
    Reverb(Reverb),
    Gain,
    Mixer,
    Output,
}

impl DspNode {
    /// Create a new node of the given type.
    pub fn new(nt: NodeType) -> Self {
        match nt {
            NodeType::Oscillator => DspNode::Oscillator(Oscillator::new(SR)),
            NodeType::Envelope   => DspNode::Envelope(Envelope::new(SR)),
            NodeType::TptLadder  => DspNode::TptLadder(TptLadder::new(SR)),
            NodeType::Noise      => DspNode::Noise(Rng::new(0xbeef_cafe)),
            NodeType::Delay      => DspNode::Delay(DelayLine::new(SR)),
            NodeType::Reverb     => DspNode::Reverb(Reverb::new(SR)),
            NodeType::Gain       => DspNode::Gain,
            NodeType::Mixer      => DspNode::Mixer,
            NodeType::Output     => DspNode::Output,
        }
    }

    /// Reset internal state (called on voice trigger).
    pub fn reset(&mut self) {
        match self {
            DspNode::Oscillator(o)  => o.reset(),
            DspNode::Envelope(e)    => { *e = Envelope::new(SR); }
            DspNode::TptLadder(f)   => f.reset(),
            DspNode::Noise(_)       => {}
            DspNode::Delay(d)       => d.reset(),
            DspNode::Reverb(_)      => { /* reverb keeps tail across notes */ }
            DspNode::Gain           => {}
            DspNode::Mixer          => {}
            DspNode::Output         => {}
        }
    }

    /// Process one sample.
    ///
    /// `inputs`:     collected input signals for this node (up to MAX_SLOTS)
    /// `params`:     parameter values for this node (indexed by param slot)
    /// `voice_freq`: voice base frequency in Hz (from MIDI note)
    /// `voice_vel`:  voice velocity 0..1
    ///
    /// Returns up to MAX_SLOTS output values (usually just slot 0).
    pub fn tick(
        &mut self,
        inputs: &[f32; MAX_SLOTS],
        params: &[f32],
        voice_freq: f32,
        _voice_vel: f32,
    ) -> [f32; MAX_SLOTS] {
        let mut out = [0.0f32; MAX_SLOTS];

        match self {
            DspNode::Oscillator(osc) => {
                let waveform   = waveform_from_index(params.get(0).copied().unwrap_or(0.0) as u8);
                let octave     = params.get(1).copied().unwrap_or(0.0);
                let detune     = params.get(2).copied().unwrap_or(0.0);
                let level      = params.get(3).copied().unwrap_or(1.0);
                let fm_depth   = params.get(4).copied().unwrap_or(0.0);
                let pw         = params.get(5).copied().unwrap_or(0.5);

                // Base frequency: voice_freq shifted by octave + detune
                let freq = voice_freq * 2.0f32.powf(octave + detune / 1200.0);

                // FM: input slot 1 provides audio-rate frequency modulation
                let fm_mod = inputs[1] * fm_depth;
                let final_freq = (freq + fm_mod).clamp(0.1, 20000.0);

                osc.pulse_width = pw;
                out[0] = osc.next(final_freq, waveform) * level;
            }

            DspNode::Envelope(env) => {
                // Params are set externally via set_adsr before each voice trigger.
                // Just tick and output the level.
                out[0] = env.process();
            }

            DspNode::TptLadder(filt) => {
                let cutoff    = params.get(0).copied().unwrap_or(2000.0);
                let resonance = params.get(1).copied().unwrap_or(0.0);
                let drive     = params.get(2).copied().unwrap_or(1.0);

                // Input slot 0: audio signal
                // Input slot 1: cutoff modulation (additive Hz from envelope/LFO)
                let mod_cutoff = (cutoff + inputs[1]).clamp(20.0, 20000.0);
                out[0] = filt.process(inputs[0], mod_cutoff, resonance, drive);
            }

            DspNode::Noise(rng) => {
                out[0] = rng.next_f32();
            }

            DspNode::Delay(dl) => {
                let time     = params.get(0).copied().unwrap_or(0.3);
                let feedback = params.get(1).copied().unwrap_or(0.4);
                let mix      = params.get(2).copied().unwrap_or(0.3);
                out[0] = dl.process(inputs[0], time, feedback, mix);
            }

            DspNode::Reverb(rev) => {
                let room = params.get(0).copied().unwrap_or(0.5);
                let damp = params.get(1).copied().unwrap_or(0.5);
                let mix  = params.get(2).copied().unwrap_or(0.3);
                let wet = rev.process_mono(inputs[0], room, damp);
                out[0] = inputs[0] * (1.0 - mix) + wet * mix;
            }

            DspNode::Gain => {
                let level = params.get(0).copied().unwrap_or(1.0);
                // Input slot 0: audio signal
                // Input slot 1: gain modulation (e.g. from envelope — multiplied)
                let mod_gain = if inputs[1] != 0.0 { inputs[1] } else { 1.0 };
                out[0] = inputs[0] * level * mod_gain;
            }

            DspNode::Mixer => {
                let gain = params.get(0).copied().unwrap_or(1.0);
                // Sum all input slots
                let sum = inputs[0] + inputs[1] + inputs[2] + inputs[3];
                out[0] = sum * gain;
            }

            DspNode::Output => {
                let gain = params.get(0).copied().unwrap_or(0.7);
                // Input slot 0: audio L (or mono)
                // Input slot 1: audio R (or copy of L if unconnected)
                // Input slot 2: amp modulation (e.g. envelope — multiplied)
                let amp = if inputs[2] != 0.0 { inputs[2] } else { 1.0 };
                out[0] = inputs[0] * gain * amp; // L
                out[1] = if inputs[1] != 0.0 { inputs[1] * gain * amp } else { out[0] }; // R
            }
        }

        out
    }

    pub fn node_type(&self) -> NodeType {
        match self {
            DspNode::Oscillator(_) => NodeType::Oscillator,
            DspNode::Envelope(_)   => NodeType::Envelope,
            DspNode::TptLadder(_)  => NodeType::TptLadder,
            DspNode::Noise(_)      => NodeType::Noise,
            DspNode::Delay(_)      => NodeType::Delay,
            DspNode::Reverb(_)     => NodeType::Reverb,
            DspNode::Gain          => NodeType::Gain,
            DspNode::Mixer         => NodeType::Mixer,
            DspNode::Output        => NodeType::Output,
        }
    }
}
