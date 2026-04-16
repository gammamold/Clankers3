/// Minimal JSON parser for graph definitions.
///
/// Parses the graph JSON schema into typed Rust structures without external deps.
/// Uses a simple recursive-descent approach over the JSON string.

use super::node::NodeType;

/// Parsed node from JSON.
pub struct ParsedNode {
    pub id: String,
    pub node_type: NodeType,
    pub params: Vec<(String, f32)>, // (param_name, value) pairs
}

/// Result of parsing the full graph JSON.
pub struct ParsedGraph {
    pub name: String,
    pub num_voices: u8,
    pub replaces: String,
    pub nodes: Vec<ParsedNode>,
    pub connections: Vec<ParsedConnection>,
}

pub struct ParsedConnection {
    pub from_id: String,
    pub from_slot: usize,
    pub to_id: String,
    pub to_slot: usize,
    pub to_named_slot: Option<String>, // e.g. "amp" for Output
}

/// Parse the graph JSON string into a ParsedGraph.
pub fn parse_graph_json(s: &str) -> Result<ParsedGraph, String> {
    let s = s.trim();
    if !s.starts_with('{') || !s.ends_with('}') {
        return Err("Graph JSON must be an object".into());
    }
    let inner = &s[1..s.len()-1];

    let mut name = String::from("untitled");
    let mut num_voices: u8 = 4;
    let mut replaces = String::from("poly_fm");
    let mut nodes = Vec::new();
    let mut connections = Vec::new();

    // Find top-level keys
    let mut pos = 0;
    let bytes = inner.as_bytes();

    while pos < bytes.len() {
        // Skip whitespace
        while pos < bytes.len() && is_ws(bytes[pos]) { pos += 1; }
        if pos >= bytes.len() { break; }

        // Expect key
        if bytes[pos] == b',' { pos += 1; continue; }
        let key = read_string(inner, &mut pos)?;
        skip_colon(inner, &mut pos)?;

        match key.as_str() {
            "name" => { name = read_string(inner, &mut pos)?; }
            "num_voices" => { num_voices = read_number(inner, &mut pos)? as u8; }
            "replaces" => { replaces = read_string(inner, &mut pos)?; }
            "type" => { let _ = read_string(inner, &mut pos)?; } // skip, always wasm_graph
            "nodes" => { nodes = parse_nodes_array(inner, &mut pos)?; }
            "connections" => { connections = parse_connections_array(inner, &mut pos)?; }
            _ => { skip_value(inner, &mut pos)?; }
        }
    }

    if nodes.is_empty() {
        return Err("Graph must have at least one node".into());
    }

    Ok(ParsedGraph { name, num_voices, replaces, nodes, connections })
}

fn parse_node_type(s: &str) -> Result<NodeType, String> {
    match s {
        "oscillator" | "osc" => Ok(NodeType::Oscillator),
        "envelope" | "env"   => Ok(NodeType::Envelope),
        "tpt_ladder" | "filter" | "lpf" => Ok(NodeType::TptLadder),
        "noise" => Ok(NodeType::Noise),
        "delay" => Ok(NodeType::Delay),
        "reverb" | "rev" => Ok(NodeType::Reverb),
        "gain" | "vca" => Ok(NodeType::Gain),
        "mixer" | "mix" => Ok(NodeType::Mixer),
        "output" | "out" => Ok(NodeType::Output),
        other => Err(format!("Unknown node type: '{}'", other)),
    }
}

// ── Array parsers ───────────────────────────────────────────────────────────

fn parse_nodes_array(s: &str, pos: &mut usize) -> Result<Vec<ParsedNode>, String> {
    let bytes = s.as_bytes();
    skip_ws(bytes, pos);
    if *pos >= bytes.len() || bytes[*pos] != b'[' {
        return Err("Expected '[' for nodes array".into());
    }
    *pos += 1;
    let mut nodes = Vec::new();

    loop {
        skip_ws(bytes, pos);
        if *pos >= bytes.len() { break; }
        if bytes[*pos] == b']' { *pos += 1; break; }
        if bytes[*pos] == b',' { *pos += 1; continue; }
        nodes.push(parse_node_object(s, pos)?);
    }
    Ok(nodes)
}

fn parse_node_object(s: &str, pos: &mut usize) -> Result<ParsedNode, String> {
    let bytes = s.as_bytes();
    skip_ws(bytes, pos);
    if *pos >= bytes.len() || bytes[*pos] != b'{' {
        return Err("Expected '{' for node object".into());
    }
    *pos += 1;

    let mut id = String::new();
    let mut node_type_str = String::new();
    let mut params = Vec::new();

    loop {
        skip_ws(bytes, pos);
        if *pos >= bytes.len() { break; }
        if bytes[*pos] == b'}' { *pos += 1; break; }
        if bytes[*pos] == b',' { *pos += 1; continue; }

        let key = read_string(s, pos)?;
        skip_colon(s, pos)?;

        match key.as_str() {
            "id" => { id = read_string(s, pos)?; }
            "type" => { node_type_str = read_string(s, pos)?; }
            "params" => { params = parse_params_object(s, pos)?; }
            _ => { skip_value(s, pos)?; }
        }
    }

    if id.is_empty() {
        return Err("Node missing 'id' field".into());
    }
    let node_type = parse_node_type(&node_type_str)?;

    Ok(ParsedNode { id, node_type, params })
}

fn parse_params_object(s: &str, pos: &mut usize) -> Result<Vec<(String, f32)>, String> {
    let bytes = s.as_bytes();
    skip_ws(bytes, pos);
    if *pos >= bytes.len() || bytes[*pos] != b'{' {
        return Err("Expected '{' for params object".into());
    }
    *pos += 1;

    let mut params = Vec::new();
    loop {
        skip_ws(bytes, pos);
        if *pos >= bytes.len() { break; }
        if bytes[*pos] == b'}' { *pos += 1; break; }
        if bytes[*pos] == b',' { *pos += 1; continue; }

        let key = read_string(s, pos)?;
        skip_colon(s, pos)?;
        let val = read_number(s, pos)?;
        params.push((key, val));
    }
    Ok(params)
}

fn parse_connections_array(s: &str, pos: &mut usize) -> Result<Vec<ParsedConnection>, String> {
    let bytes = s.as_bytes();
    skip_ws(bytes, pos);
    if *pos >= bytes.len() || bytes[*pos] != b'[' {
        return Err("Expected '[' for connections array".into());
    }
    *pos += 1;
    let mut conns = Vec::new();

    loop {
        skip_ws(bytes, pos);
        if *pos >= bytes.len() { break; }
        if bytes[*pos] == b']' { *pos += 1; break; }
        if bytes[*pos] == b',' { *pos += 1; continue; }
        conns.push(parse_connection_object(s, pos)?);
    }
    Ok(conns)
}

fn parse_connection_object(s: &str, pos: &mut usize) -> Result<ParsedConnection, String> {
    let bytes = s.as_bytes();
    skip_ws(bytes, pos);
    if *pos >= bytes.len() || bytes[*pos] != b'{' {
        return Err("Expected '{' for connection object".into());
    }
    *pos += 1;

    let mut from_str = String::new();
    let mut to_str = String::new();

    loop {
        skip_ws(bytes, pos);
        if *pos >= bytes.len() { break; }
        if bytes[*pos] == b'}' { *pos += 1; break; }
        if bytes[*pos] == b',' { *pos += 1; continue; }

        let key = read_string(s, pos)?;
        skip_colon(s, pos)?;
        let val = read_string(s, pos)?;
        match key.as_str() {
            "from" => from_str = val,
            "to"   => to_str = val,
            _ => {}
        }
    }

    let (from_id, from_slot) = parse_port(&from_str)?;
    let (to_id, to_slot, to_named) = parse_port_with_name(&to_str)?;

    Ok(ParsedConnection {
        from_id, from_slot,
        to_id, to_slot,
        to_named_slot: to_named,
    })
}

/// Parse "node_id:slot" into (id, slot_number).
fn parse_port(s: &str) -> Result<(String, usize), String> {
    if let Some((id, slot_str)) = s.split_once(':') {
        let slot = slot_str.parse::<usize>().unwrap_or(0);
        Ok((id.to_string(), slot))
    } else {
        Ok((s.to_string(), 0))
    }
}

/// Parse "node_id:slot_or_name" — name like "amp" maps to slot 2 on Output.
fn parse_port_with_name(s: &str) -> Result<(String, usize, Option<String>), String> {
    if let Some((id, slot_str)) = s.split_once(':') {
        if let Ok(n) = slot_str.parse::<usize>() {
            Ok((id.to_string(), n, None))
        } else {
            // Named slot — resolve to index
            let slot_idx = match slot_str {
                "amp" => 2,   // Output amp modulation slot
                "fm"  => 1,   // Oscillator FM input
                "mod" => 1,   // Filter cutoff modulation
                _ => 0,
            };
            Ok((id.to_string(), slot_idx, Some(slot_str.to_string())))
        }
    } else {
        Ok((s.to_string(), 0, None))
    }
}

// ── Low-level JSON primitives ───────────────────────────────────────────────

fn is_ws(b: u8) -> bool {
    b == b' ' || b == b'\n' || b == b'\r' || b == b'\t'
}

fn skip_ws(bytes: &[u8], pos: &mut usize) {
    while *pos < bytes.len() && is_ws(bytes[*pos]) { *pos += 1; }
}

fn skip_colon(s: &str, pos: &mut usize) -> Result<(), String> {
    let bytes = s.as_bytes();
    skip_ws(bytes, pos);
    if *pos < bytes.len() && bytes[*pos] == b':' {
        *pos += 1;
        Ok(())
    } else {
        Err("Expected ':'".into())
    }
}

fn read_string(s: &str, pos: &mut usize) -> Result<String, String> {
    let bytes = s.as_bytes();
    skip_ws(bytes, pos);
    if *pos >= bytes.len() || bytes[*pos] != b'"' {
        return Err(format!("Expected '\"' at position {}", *pos));
    }
    *pos += 1;
    let start = *pos;
    while *pos < bytes.len() && bytes[*pos] != b'"' {
        if bytes[*pos] == b'\\' { *pos += 1; } // skip escaped char
        *pos += 1;
    }
    let end = *pos;
    if *pos < bytes.len() { *pos += 1; } // skip closing quote
    Ok(s[start..end].to_string())
}

fn read_number(s: &str, pos: &mut usize) -> Result<f32, String> {
    let bytes = s.as_bytes();
    skip_ws(bytes, pos);
    let start = *pos;
    // Accept negative, digits, dot
    if *pos < bytes.len() && bytes[*pos] == b'-' { *pos += 1; }
    while *pos < bytes.len() && (bytes[*pos].is_ascii_digit() || bytes[*pos] == b'.') {
        *pos += 1;
    }
    if start == *pos {
        return Err(format!("Expected number at position {}", start));
    }
    s[start..*pos].parse::<f32>().map_err(|e| format!("Bad number: {}", e))
}

fn skip_value(s: &str, pos: &mut usize) -> Result<(), String> {
    let bytes = s.as_bytes();
    skip_ws(bytes, pos);
    if *pos >= bytes.len() { return Ok(()); }

    match bytes[*pos] {
        b'"' => { let _ = read_string(s, pos)?; }
        b'{' => { skip_balanced(bytes, pos, b'{', b'}'); }
        b'[' => { skip_balanced(bytes, pos, b'[', b']'); }
        b't' | b'f' | b'n' => {
            // true, false, null
            while *pos < bytes.len() && bytes[*pos].is_ascii_alphabetic() { *pos += 1; }
        }
        _ => { let _ = read_number(s, pos)?; }
    }
    Ok(())
}

fn skip_balanced(bytes: &[u8], pos: &mut usize, open: u8, close: u8) {
    let mut depth = 0;
    let mut in_string = false;
    while *pos < bytes.len() {
        let b = bytes[*pos];
        if in_string {
            if b == b'\\' { *pos += 1; }
            else if b == b'"' { in_string = false; }
        } else {
            if b == b'"' { in_string = true; }
            else if b == open { depth += 1; }
            else if b == close { depth -= 1; if depth == 0 { *pos += 1; return; } }
        }
        *pos += 1;
    }
}
