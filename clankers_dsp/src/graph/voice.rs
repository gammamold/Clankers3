/// GraphVoice — one polyphonic voice holding a full copy of the DSP graph.
///
/// Each voice has its own node instances (oscillators, filters, envelopes, etc.)
/// so they maintain independent state. The topology (exec_order, connections) and
/// params are shared across voices and passed in at tick time.

use super::node::{DspNode, NodeType, MAX_SLOTS};
use super::engine::Connection;

pub struct GraphVoice {
    pub nodes: Vec<DspNode>,
    /// Per-node output signals: node_i * MAX_SLOTS + slot_j
    pub signals: Vec<f32>,
    pub freq: f32,
    pub velocity: f32,
    pub active: bool,
    pub hold_remaining: usize,
    pub released: bool,
    /// Indices of Envelope nodes (for auto note_on / note_off)
    envelope_indices: Vec<usize>,
}

impl GraphVoice {
    /// Create a voice from a list of node types (the graph template).
    pub fn new(node_types: &[NodeType]) -> Self {
        let n = node_types.len();
        let envelope_indices: Vec<usize> = node_types.iter().enumerate()
            .filter(|(_, nt)| **nt == NodeType::Envelope)
            .map(|(i, _)| i)
            .collect();
        GraphVoice {
            nodes: node_types.iter().map(|nt| DspNode::new(*nt)).collect(),
            signals: vec![0.0; n * MAX_SLOTS],
            freq: 440.0,
            velocity: 1.0,
            active: false,
            hold_remaining: 0,
            released: false,
            envelope_indices,
        }
    }

    /// Trigger a note — resets nodes, sets freq, gates envelopes.
    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: usize, params: &[f32], param_offsets: &[usize]) {
        self.freq = 440.0 * 2.0f32.powf((midi_note as f32 - 69.0) / 12.0);
        self.velocity = velocity;
        self.active = true;
        self.released = false;
        self.hold_remaining = hold_samples;

        // Reset all nodes
        for node in self.nodes.iter_mut() {
            node.reset();
        }
        // Clear signal buffer
        self.signals.fill(0.0);

        // Configure envelopes from params and trigger note_on
        for &ei in &self.envelope_indices {
            if let DspNode::Envelope(env) = &mut self.nodes[ei] {
                let off = param_offsets[ei];
                let attack  = params.get(off).copied().unwrap_or(0.01);
                let decay   = params.get(off + 1).copied().unwrap_or(0.3);
                let sustain = params.get(off + 2).copied().unwrap_or(0.0);
                let release = params.get(off + 3).copied().unwrap_or(0.1);
                env.set_adsr(attack, decay, sustain, release);
                env.note_on();
            }
        }
    }

    /// Release held envelopes (note off).
    pub fn release(&mut self) {
        if self.released { return; }
        self.released = true;
        for &ei in &self.envelope_indices {
            if let DspNode::Envelope(env) = &mut self.nodes[ei] {
                env.note_off();
            }
        }
    }

    /// Process one sample through the graph. Returns (L, R).
    pub fn tick(
        &mut self,
        exec_order: &[usize],
        connections: &[Connection],
        params: &[f32],
        param_offsets: &[usize],
    ) -> (f32, f32) {
        if !self.active { return (0.0, 0.0); }

        // Handle hold duration → auto-release
        if self.hold_remaining > 0 {
            self.hold_remaining -= 1;
            if self.hold_remaining == 0 && !self.released {
                self.release();
            }
        }

        // Clear signal buffer for this tick
        self.signals.fill(0.0);

        // Process nodes in topological order
        for &ni in exec_order {
            // Gather inputs from connections
            let mut inputs = [0.0f32; MAX_SLOTS];
            for conn in connections {
                if conn.dst_node == ni {
                    let src_val = self.signals[conn.src_node * MAX_SLOTS + conn.src_slot];
                    inputs[conn.dst_slot] += src_val;
                }
            }

            // Get params slice for this node
            let p_off = param_offsets[ni];
            let p_end = if ni + 1 < param_offsets.len() {
                param_offsets[ni + 1]
            } else {
                params.len()
            };
            let node_params = &params[p_off..p_end];

            // Tick the node
            let outputs = self.nodes[ni].tick(&inputs, node_params, self.freq, self.velocity);

            // Write outputs to signal buffer
            for s in 0..MAX_SLOTS {
                self.signals[ni * MAX_SLOTS + s] = outputs[s];
            }
        }

        // Check if voice is still active (any envelope still running?)
        if self.released {
            let any_env_active = self.envelope_indices.iter().any(|&ei| {
                if let DspNode::Envelope(env) = &self.nodes[ei] {
                    env.is_active()
                } else {
                    false
                }
            });
            if !any_env_active {
                self.active = false;
            }
        }

        // Find output node and return its L/R
        for (i, node) in self.nodes.iter().enumerate() {
            if node.node_type() == NodeType::Output {
                let l = self.signals[i * MAX_SLOTS];
                let r = self.signals[i * MAX_SLOTS + 1];
                return (l * self.velocity, r * self.velocity);
            }
        }

        (0.0, 0.0)
    }

    pub fn is_active(&self) -> bool {
        self.active
    }
}
