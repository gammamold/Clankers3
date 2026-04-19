//! Smoke test for the C ABI surface — drives the FFI the same way a C
//! caller would, proving the native path works end-to-end.
//!
//! Run with:
//!   cargo test --release --no-default-features --test ffi_smoke

#![cfg(not(target_arch = "wasm32"))]

use clankers_dsp::ffi::*;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

fn c(s: &str) -> CString { CString::new(s).unwrap() }

#[test]
fn drums_produces_audio() {
    unsafe {
        let d = clankers_drums_new(0xbeef, 44100.0);
        assert!(!d.is_null());
        clankers_drums_trigger(d, 0, 1.0);
        let mut buf = vec![0.0f32; 512];
        clankers_drums_process(d, buf.as_mut_ptr(), buf.len() as u32);
        assert!(buf.iter().any(|x| x.abs() > 1e-4), "drums should produce audio");
        clankers_drums_free(d);
    }
}

#[test]
fn bass_null_ccjson_preserves_params() {
    unsafe {
        let b = clankers_bass_new(1, 44100.0);
        let cc = c(r#"{"74":90}"#);
        clankers_bass_set_params(b, cc.as_ptr());
        // Empty/"{}" must NOT wipe stored params — plain note-on should still play.
        clankers_bass_trigger(b, 36, 1.0, 4410, std::ptr::null());
        let mut buf = vec![0.0f32; 512];
        clankers_bass_process(b, buf.as_mut_ptr(), buf.len() as u32);
        assert!(buf.iter().any(|x| x.abs() > 1e-4));
        clankers_bass_free(b);
    }
}

#[test]
fn graph_invalid_json_returns_null_with_error() {
    unsafe {
        let bad = c("not json at all");
        let g = clankers_graph_new(bad.as_ptr(), 4, 44100.0);
        assert!(g.is_null());
        let err = clankers_last_error();
        assert!(!err.is_null());
        let msg = CStr::from_ptr(err).to_string_lossy();
        assert!(!msg.is_empty(), "error message should be populated");
    }
}

#[test]
fn graph_missing_output_returns_null() {
    unsafe {
        // Valid JSON, but no output node → should fail validation
        let json = c(r#"{"nodes":[{"id":"o1","type":"oscillator"}],"connections":[]}"#);
        let g = clankers_graph_new(json.as_ptr(), 4, 44100.0);
        assert!(g.is_null());
        let err = clankers_last_error();
        assert!(!err.is_null());
        let msg = CStr::from_ptr(err).to_string_lossy();
        assert!(msg.contains("output"), "error should mention output node: {}", msg);
    }
}

#[test]
fn graph_minimal_produces_audio() {
    unsafe {
        // osc → output.amp
        let json = c(r#"{
            "nodes":[
                {"id":"osc1","type":"oscillator","params":{"freq":440.0,"amp":0.5}},
                {"id":"out","type":"output"}
            ],
            "connections":[
                {"from":"osc1:0","to":"out:0"}
            ]
        }"#);
        let g = clankers_graph_new(json.as_ptr(), 4, 44100.0);
        assert!(!g.is_null(), "graph_new failed: {}",
            CStr::from_ptr(clankers_last_error()).to_string_lossy());

        // last_error should be cleared on success
        let err_ptr: *const c_char = clankers_last_error();
        assert!(err_ptr.is_null(), "last_error should be null after success");

        let pc = clankers_graph_param_count(g);
        assert!(pc > 0, "expected params on the graph");

        let info = clankers_graph_param_info(g);
        assert!(!info.is_null());
        let info_str = CStr::from_ptr(info).to_string_lossy();
        assert!(info_str.starts_with('['), "param_info should be a JSON array");

        clankers_graph_trigger(g, 60, 1.0, 4410);
        let n = 512usize;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        clankers_graph_process(g, l.as_mut_ptr(), r.as_mut_ptr(), n as u32);
        assert!(
            l.iter().any(|x| x.abs() > 1e-5) || r.iter().any(|x| x.abs() > 1e-5),
            "graph should produce non-zero output after trigger"
        );

        clankers_graph_free(g);
    }
}

#[test]
fn engines_render_at_48k_and_after_set_sample_rate() {
    unsafe {
        // Construct each engine at 48k and render a buffer; expect non-zero output.
        let d = clankers_drums_new(0xbeef, 48000.0);
        clankers_drums_trigger(d, 0, 1.0);
        let mut buf = vec![0.0f32; 1024];
        clankers_drums_process(d, buf.as_mut_ptr(), buf.len() as u32);
        assert!(buf.iter().any(|x| x.abs() > 1e-4), "drums at 48k");
        // Switch SR live, re-trigger, render again.
        clankers_drums_set_sample_rate(d, 44100.0);
        clankers_drums_trigger(d, 0, 1.0);
        buf.fill(0.0);
        clankers_drums_process(d, buf.as_mut_ptr(), buf.len() as u32);
        assert!(buf.iter().any(|x| x.abs() > 1e-4), "drums after SR change");
        clankers_drums_free(d);

        let b = clankers_bass_new(1, 48000.0);
        let cc = c(r#"{"74":90}"#);
        clankers_bass_trigger(b, 36, 1.0, 4800, cc.as_ptr());
        let mut buf = vec![0.0f32; 1024];
        clankers_bass_process(b, buf.as_mut_ptr(), buf.len() as u32);
        assert!(buf.iter().any(|x| x.abs() > 1e-4), "bass at 48k");
        clankers_bass_free(b);

        // Graph: build at 48k, render, change to 96k, render again.
        let json = c(r#"{
            "nodes":[
                {"id":"osc1","type":"oscillator","params":{"freq":440.0,"amp":0.5}},
                {"id":"out","type":"output"}
            ],
            "connections":[{"from":"osc1:0","to":"out:0"}]
        }"#);
        let g = clankers_graph_new(json.as_ptr(), 4, 48000.0);
        assert!(!g.is_null());
        clankers_graph_trigger(g, 60, 1.0, 4800);
        let n = 512usize;
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        clankers_graph_process(g, l.as_mut_ptr(), r.as_mut_ptr(), n as u32);
        assert!(l.iter().any(|x| x.abs() > 1e-5), "graph at 48k");

        clankers_graph_set_sample_rate(g, 96000.0);
        clankers_graph_trigger(g, 60, 1.0, 9600);
        l.fill(0.0); r.fill(0.0);
        clankers_graph_process(g, l.as_mut_ptr(), r.as_mut_ptr(), n as u32);
        assert!(l.iter().any(|x| x.abs() > 1e-5), "graph after SR change to 96k");
        clankers_graph_free(g);
    }
}

#[test]
fn graphfx_passthrough() {
    unsafe {
        // input → output (pure passthrough)
        let json = c(r#"{
            "nodes":[
                {"id":"in","type":"input"},
                {"id":"out","type":"output"}
            ],
            "connections":[
                {"from":"in:0","to":"out:0"},
                {"from":"in:1","to":"out:1"}
            ]
        }"#);
        let fx = clankers_graphfx_new(json.as_ptr(), 44100.0);
        assert!(!fx.is_null(), "graphfx_new failed: {}",
            CStr::from_ptr(clankers_last_error()).to_string_lossy());

        let n = 64usize;
        let il: Vec<f32> = (0..n).map(|i| (i as f32 * 0.01).sin()).collect();
        let ir: Vec<f32> = (0..n).map(|i| (i as f32 * 0.02).sin()).collect();
        let mut ol = vec![0.0f32; n];
        let mut or_ = vec![0.0f32; n];
        clankers_graphfx_process(
            fx,
            il.as_ptr(), ir.as_ptr(),
            ol.as_mut_ptr(), or_.as_mut_ptr(),
            n as u32,
        );
        // Must produce *some* signal on the output.
        assert!(ol.iter().any(|x| x.abs() > 1e-6) || or_.iter().any(|x| x.abs() > 1e-6));
        clankers_graphfx_free(fx);
    }
}
