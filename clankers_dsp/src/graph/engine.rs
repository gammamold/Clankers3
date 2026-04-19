/// SynthGraph — the graph-based synth engine.
///
/// Manages polyphonic voices, topological sort, and parameter dispatch.
/// Constructed once from JSON; topology is immutable after creation.

use super::node::{NodeType, param_descs};
use super::voice::GraphVoice;
use super::parse::parse_graph_json;

/// A single connection between two node slots.
#[derive(Clone)]
pub struct Connection {
    pub src_node: usize,
    pub src_slot: usize,
    pub dst_node: usize,
    pub dst_slot: usize,
}

/// Parameter metadata exposed to JS.
pub struct ParamInfo {
    pub index: usize,
    pub node_id: String,
    pub name: String,
    pub min: f32,
    pub max: f32,
    pub default: f32,
}

pub struct SynthGraph {
    // Topology (immutable after construction)
    n_nodes: usize,
    node_types: Vec<NodeType>,
    node_ids: Vec<String>,
    exec_order: Vec<usize>,
    connections: Vec<Connection>,

    // Parameter layout
    param_offsets: Vec<usize>,  // param_offsets[node_i] = start index into params
    param_info: Vec<ParamInfo>,
    params: Vec<f32>,           // flat param array

    // Voices
    voices: Vec<GraphVoice>,
    next_voice: usize,
}

impl SynthGraph {
    /// Construct a new graph engine from JSON.
    pub fn new(graph_json: &str, num_voices: u8) -> Result<Self, String> {
        let parsed = parse_graph_json(graph_json)?;

        let n = parsed.nodes.len();
        let mut node_types = Vec::with_capacity(n);
        let mut node_ids = Vec::with_capacity(n);

        // Build node type list + id map
        for pn in &parsed.nodes {
            node_types.push(pn.node_type);
            node_ids.push(pn.id.clone());
        }

        // Validate: exactly one Output node
        let output_count = node_types.iter().filter(|t| **t == NodeType::Output).count();
        if output_count == 0 {
            return Err("Graph must have exactly one 'output' node".into());
        }
        if output_count > 1 {
            return Err("Graph must have exactly one 'output' node, found multiple".into());
        }

        // Build id → index map
        let id_to_idx = |id: &str| -> Result<usize, String> {
            node_ids.iter().position(|x| x == id)
                .ok_or_else(|| format!("Unknown node id: '{}'", id))
        };

        // Resolve connections
        let mut connections = Vec::new();
        for pc in &parsed.connections {
            let src = id_to_idx(&pc.from_id)?;
            let dst = id_to_idx(&pc.to_id)?;
            connections.push(Connection {
                src_node: src,
                src_slot: pc.from_slot,
                dst_node: dst,
                dst_slot: pc.to_slot,
            });
        }

        // Topological sort (Kahn's algorithm)
        let exec_order = topo_sort(n, &connections)?;

        // Build parameter layout
        let mut param_offsets = Vec::with_capacity(n);
        let mut params = Vec::new();
        let mut param_info = Vec::new();
        for (i, nt) in node_types.iter().enumerate() {
            param_offsets.push(params.len());
            let descs = param_descs(*nt);
            for pd in descs {
                let idx = params.len();
                param_info.push(ParamInfo {
                    index: idx,
                    node_id: node_ids[i].clone(),
                    name: pd.name.to_string(),
                    min: pd.min,
                    max: pd.max,
                    default: pd.default,
                });
                params.push(pd.default);
            }
        }

        // Apply initial params from JSON
        for pn in &parsed.nodes {
            let ni = id_to_idx(&pn.id)?;
            let off = param_offsets[ni];
            let descs = param_descs(pn.node_type);
            for (pname, pval) in &pn.params {
                if let Some(pi) = descs.iter().position(|d| d.name == pname) {
                    params[off + pi] = *pval;
                }
            }
        }

        // Create voices
        let nv = (num_voices as usize).max(1).min(16);
        let voices: Vec<GraphVoice> = (0..nv).map(|_| GraphVoice::new(&node_types)).collect();

        Ok(SynthGraph {
            n_nodes: n,
            node_types,
            node_ids,
            exec_order,
            connections,
            param_offsets,
            param_info,
            params,
            voices,
            next_voice: 0,
        })
    }

    /// Set a parameter by flat index.
    pub fn set_param(&mut self, param_index: usize, value: f32) {
        if param_index < self.params.len() {
            self.params[param_index] = value;
        }
    }

    /// Trigger a note — allocates a voice with round-robin stealing.
    pub fn trigger(&mut self, midi_note: u8, velocity: f32, hold_samples: u32) {
        // Find a free voice first
        let free = self.voices.iter().position(|v| !v.is_active());
        let vi = free.unwrap_or_else(|| {
            // Round-robin steal
            let i = self.next_voice;
            self.next_voice = (self.next_voice + 1) % self.voices.len();
            i
        });
        if free.is_some() {
            self.next_voice = (vi + 1) % self.voices.len();
        }
        self.voices[vi].trigger(midi_note, velocity, hold_samples as usize, &self.params, &self.param_offsets);
    }

    /// Process n_samples of audio. Returns interleaved stereo [L0, R0, L1, R1, ...].
    pub fn process_stereo(&mut self, n_samples: usize) -> Vec<f32> {
        let mut out = vec![0.0f32; n_samples * 2];

        for i in 0..n_samples {
            let mut sum_l = 0.0f32;
            let mut sum_r = 0.0f32;

            for voice in self.voices.iter_mut() {
                if voice.is_active() {
                    let (l, r) = voice.tick(
                        &self.exec_order,
                        &self.connections,
                        &self.params,
                        &self.param_offsets,
                    );
                    sum_l += l;
                    sum_r += r;
                }
            }

            // Soft clip to prevent harsh digital overs
            out[i * 2]     = sum_l.tanh();
            out[i * 2 + 1] = sum_r.tanh();
        }

        out
    }

    /// Return JSON string describing all parameters.
    pub fn param_info_json(&self) -> String {
        let mut s = String::from("[");
        for (i, pi) in self.param_info.iter().enumerate() {
            if i > 0 { s.push(','); }
            s.push_str(&format!(
                r#"{{"index":{},"node":"{}","param":"{}","min":{},"max":{},"default":{}}}"#,
                pi.index, pi.node_id, pi.name, pi.min, pi.max, pi.default
            ));
        }
        s.push(']');
        s
    }

    pub fn param_count(&self) -> usize {
        self.params.len()
    }

    /// Zero-alloc stereo render into caller-owned L/R buffers. Buffers must
    /// be the same length; that length sets `n_samples`. Overwrites (not mixes).
    pub fn process_stereo_lr(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len().min(out_r.len());
        for i in 0..n {
            let mut sum_l = 0.0f32;
            let mut sum_r = 0.0f32;
            for voice in self.voices.iter_mut() {
                if voice.is_active() {
                    let (l, r) = voice.tick(
                        &self.exec_order,
                        &self.connections,
                        &self.params,
                        &self.param_offsets,
                    );
                    sum_l += l;
                    sum_r += r;
                }
            }
            out_l[i] = sum_l.tanh();
            out_r[i] = sum_r.tanh();
        }
    }
}

// ── GraphFx — continuous audio FX processor ──────────────────────────────────

/// A graph-based FX processor. Unlike SynthGraph, this has no voices — it
/// processes audio continuously through a single copy of the node graph.
/// External audio enters via an "input" node and exits via the "output" node.
pub struct GraphFx {
    nodes: Vec<super::node::DspNode>,
    signals: Vec<f32>,          // node_i * MAX_SLOTS + slot_j
    exec_order: Vec<usize>,
    connections: Vec<Connection>,
    param_offsets: Vec<usize>,
    param_info: Vec<ParamInfo>,
    params: Vec<f32>,
    input_node: Option<usize>,  // index of the Input node
    output_node: usize,         // index of the Output node
}

impl GraphFx {
    /// Construct from the same JSON format as SynthGraph.
    /// The graph MUST contain exactly one "input" node and one "output" node.
    pub fn new(graph_json: &str) -> Result<Self, String> {
        let parsed = parse_graph_json(graph_json)?;

        let n = parsed.nodes.len();
        let mut node_types = Vec::with_capacity(n);
        let mut node_ids = Vec::with_capacity(n);

        for pn in &parsed.nodes {
            node_types.push(pn.node_type);
            node_ids.push(pn.id.clone());
        }

        // Validate: exactly one Output, exactly one Input
        let output_idx = node_types.iter().position(|t| *t == NodeType::Output)
            .ok_or("FX graph must have an 'output' node")?;
        if node_types.iter().filter(|t| **t == NodeType::Output).count() > 1 {
            return Err("FX graph must have exactly one 'output' node".into());
        }
        let input_idx = node_types.iter().position(|t| *t == NodeType::Input);

        let id_to_idx = |id: &str| -> Result<usize, String> {
            node_ids.iter().position(|x| x == id)
                .ok_or_else(|| format!("Unknown node id: '{}'", id))
        };

        // Resolve connections
        let mut connections = Vec::new();
        for pc in &parsed.connections {
            let src = id_to_idx(&pc.from_id)?;
            let dst = id_to_idx(&pc.to_id)?;
            connections.push(Connection {
                src_node: src, src_slot: pc.from_slot,
                dst_node: dst, dst_slot: pc.to_slot,
            });
        }

        let exec_order = topo_sort(n, &connections)?;

        // Build parameter layout
        let mut param_offsets = Vec::with_capacity(n);
        let mut params = Vec::new();
        let mut param_info = Vec::new();
        for (i, nt) in node_types.iter().enumerate() {
            param_offsets.push(params.len());
            for pd in param_descs(*nt) {
                let idx = params.len();
                param_info.push(ParamInfo {
                    index: idx,
                    node_id: node_ids[i].clone(),
                    name: pd.name.to_string(),
                    min: pd.min, max: pd.max, default: pd.default,
                });
                params.push(pd.default);
            }
        }

        // Apply initial params from JSON
        for pn in &parsed.nodes {
            let ni = id_to_idx(&pn.id)?;
            let off = param_offsets[ni];
            let descs = param_descs(pn.node_type);
            for (pname, pval) in &pn.params {
                if let Some(pi) = descs.iter().position(|d| d.name == pname) {
                    params[off + pi] = *pval;
                }
            }
        }

        let nodes = node_types.iter().map(|nt| super::node::DspNode::new(*nt)).collect();
        let signals = vec![0.0; n * super::node::MAX_SLOTS];

        Ok(GraphFx {
            nodes, signals, exec_order, connections,
            param_offsets, param_info, params,
            input_node: input_idx,
            output_node: output_idx,
        })
    }

    pub fn set_param(&mut self, param_index: usize, value: f32) {
        if param_index < self.params.len() {
            self.params[param_index] = value;
        }
    }

    /// Process interleaved stereo input → interleaved stereo output.
    /// `input`: [L0, R0, L1, R1, ...] — `n_samples * 2` floats.
    /// Returns same-size interleaved stereo output.
    pub fn process_stereo(&mut self, input: &[f32], n_samples: usize) -> Vec<f32> {
        let max_slots = super::node::MAX_SLOTS;
        let mut out = vec![0.0f32; n_samples * 2];

        for i in 0..n_samples {
            let in_l = input.get(i * 2).copied().unwrap_or(0.0);
            let in_r = input.get(i * 2 + 1).copied().unwrap_or(0.0);

            // Clear signal buffer
            self.signals.fill(0.0);

            // Inject external audio into the Input node's signal buffer
            if let Some(inp_idx) = self.input_node {
                self.signals[inp_idx * max_slots]     = in_l;
                self.signals[inp_idx * max_slots + 1] = in_r;
            }

            // Process nodes in topological order
            for &ni in &self.exec_order {
                let mut inputs = [0.0f32; super::node::MAX_SLOTS];
                for conn in &self.connections {
                    if conn.dst_node == ni {
                        inputs[conn.dst_slot] += self.signals[conn.src_node * max_slots + conn.src_slot];
                    }
                }

                // For the Input node, also merge the external audio into inputs
                // (it was written to signals above, connections will carry it)
                if Some(ni) == self.input_node {
                    // External audio is already in signals[inp*MAX_SLOTS+0/1].
                    // The Input node tick reads from inputs[], so inject there.
                    inputs[0] += in_l;
                    inputs[1] += in_r;
                }

                let p_off = self.param_offsets[ni];
                let p_end = if ni + 1 < self.param_offsets.len() {
                    self.param_offsets[ni + 1]
                } else {
                    self.params.len()
                };

                let outputs = self.nodes[ni].tick(&inputs, &self.params[p_off..p_end], 440.0, 1.0);

                for s in 0..max_slots {
                    self.signals[ni * max_slots + s] = outputs[s];
                }
            }

            // Read output from the Output node
            let oi = self.output_node;
            out[i * 2]     = self.signals[oi * max_slots];
            out[i * 2 + 1] = self.signals[oi * max_slots + 1];
        }

        out
    }

    pub fn param_info_json(&self) -> String {
        let mut s = String::from("[");
        for (i, pi) in self.param_info.iter().enumerate() {
            if i > 0 { s.push(','); }
            s.push_str(&format!(
                r#"{{"index":{},"node":"{}","param":"{}","min":{},"max":{},"default":{}}}"#,
                pi.index, pi.node_id, pi.name, pi.min, pi.max, pi.default
            ));
        }
        s.push(']');
        s
    }

    pub fn param_count(&self) -> usize {
        self.params.len()
    }

    /// Zero-alloc stereo process into caller-owned L/R buffers. All three
    /// buffers must be the same length; that length sets `n_samples`.
    /// Overwrites outputs (not mixes).
    pub fn process_stereo_lr(
        &mut self,
        in_l:  &[f32],
        in_r:  &[f32],
        out_l: &mut [f32],
        out_r: &mut [f32],
    ) {
        let max_slots = super::node::MAX_SLOTS;
        let n = out_l.len().min(out_r.len()).min(in_l.len()).min(in_r.len());

        for i in 0..n {
            let xl = in_l[i];
            let xr = in_r[i];

            self.signals.fill(0.0);
            if let Some(inp_idx) = self.input_node {
                self.signals[inp_idx * max_slots]     = xl;
                self.signals[inp_idx * max_slots + 1] = xr;
            }

            for &ni in &self.exec_order {
                let mut inputs = [0.0f32; super::node::MAX_SLOTS];
                for conn in &self.connections {
                    if conn.dst_node == ni {
                        inputs[conn.dst_slot] += self.signals[conn.src_node * max_slots + conn.src_slot];
                    }
                }
                if Some(ni) == self.input_node {
                    inputs[0] += xl;
                    inputs[1] += xr;
                }

                let p_off = self.param_offsets[ni];
                let p_end = if ni + 1 < self.param_offsets.len() {
                    self.param_offsets[ni + 1]
                } else {
                    self.params.len()
                };

                let outputs = self.nodes[ni].tick(&inputs, &self.params[p_off..p_end], 440.0, 1.0);
                for s in 0..max_slots {
                    self.signals[ni * max_slots + s] = outputs[s];
                }
            }

            let oi = self.output_node;
            out_l[i] = self.signals[oi * max_slots];
            out_r[i] = self.signals[oi * max_slots + 1];
        }
    }
}

// ── Topological sort (Kahn's algorithm) ─────────────────────────────────────

fn topo_sort(n: usize, connections: &[Connection]) -> Result<Vec<usize>, String> {
    let mut in_degree = vec![0usize; n];
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); n];

    for c in connections {
        in_degree[c.dst_node] += 1;
        adjacency[c.src_node].push(c.dst_node);
    }

    // Seed queue with nodes that have no incoming connections
    let mut queue: Vec<usize> = (0..n).filter(|i| in_degree[*i] == 0).collect();
    let mut order = Vec::with_capacity(n);

    while let Some(node) = queue.pop() {
        order.push(node);
        for &next in &adjacency[node] {
            in_degree[next] -= 1;
            if in_degree[next] == 0 {
                queue.push(next);
            }
        }
    }

    if order.len() != n {
        return Err(format!(
            "Graph has a cycle — topological sort visited {}/{} nodes",
            order.len(), n
        ));
    }

    Ok(order)
}
