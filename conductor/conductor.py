# conductor/conductor.py -- The Clankers 3
#
# Full pipeline:
#   run_track(brief, arc, out_dir)
#     1. Chatroom negotiates verse1 -> Music Sheet JSON
#     2. For each subsequent section: evolve() mutates the sheet
#     3. run_session() fires all agents in parallel (DawDreamer or numpy)
#     4. mixer.mix_section() balances + EQs each section
#     5. mixer.stitch_and_master() concatenates + compresses -> full_track.wav

import io
import os
import re
import sys
import json
import copy
import threading
import numpy as np
from pathlib import Path
from pydub import AudioSegment
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
import llm_clients
from chatroom.chatroom import Chatroom, _extract_sheet_json, _SHEET_FORMAT

# ── Agent imports ─────────────────────────────────────────────────────────

from agents.voice.voice_agent    import run as run_voice
from agents.bassline.bass_sh101  import run as run_sh101

try:
    from agents.drums.drums_agent   import run as run_drums
    HAS_DRUMS = True
except ImportError:
    HAS_DRUMS = False

try:
    from agents.harmony.harmony_agent import run as run_harmony
    HAS_HARMONY = True
except ImportError:
    HAS_HARMONY = False

try:
    from agents.voder.voder_agent   import run as run_voder
    HAS_VODER = True
except ImportError:
    HAS_VODER = False

# ── Per-thread stdout router ──────────────────────────────────────────────
# Agent threads write to their own log file; main/worker thread reaches GUI.

_tls = threading.local()


class _AgentStream(io.TextIOBase):
    def __init__(self, default_stream):
        self._default = default_stream

    def write(self, s: str) -> int:
        dest = getattr(_tls, "stream", None) or self._default
        dest.write(s)
        return len(s)

    def flush(self):
        dest = getattr(_tls, "stream", None) or self._default
        try:
            dest.flush()
        except Exception:
            pass


# ── Arc ───────────────────────────────────────────────────────────────────

DEFAULT_ARC = ["verse1", "instrumental", "verse2", "bridge", "verse3", "outro"]

# All stem names that can appear in a run_session() result
ALL_STEMS = ["sampler", "bass_sh101", "drums", "buchla", "hybrid", "voder"]

# Canonical tension curve per section name.
_SECTION_TENSION: dict[str, float] = {
    "verse1":       0.30,
    "instrumental": 0.45,
    "verse2":       0.52,
    "bridge":       0.75,
    "verse3":       0.85,
    "outro":        0.20,
}

# ── EVOLVE ────────────────────────────────────────────────────────────────

_EVOLVE_SYSTEM = (
    "You are the CONDUCTOR of The Clankers 3, evolving a live session to its next section.\n"
    "You receive the previous section's ClankerBoy JSON sheet and a target section name.\n"
    "Generate a new 8-bar (128 steps at d:0.25) ClankerBoy JSON sheet for the target section.\n\n"
    "EVOLUTION RULES:\n"
    "  - BPM is LOCKED — copy it exactly from the previous sheet, never change it.\n"
    "  - Key is LOCKED — only allowed to shift at 'bridge'.\n"
    "  - Preserve the core motifs and chord identity from the previous section.\n"
    "    Transform them for the new energy level — don't invent a new song.\n"
    "  - Target exactly 128 steps (8 bars × 16 steps/bar at d:0.25).\n\n"
    "Section arc guidance:\n"
    "  verse1:       energy 0.30-0.40 — establish core groove, introduce main motif\n"
    "  instrumental: energy 0.40-0.50 — no vocals focus, instruments step forward, bass/buchla develop\n"
    "  verse2:       energy 0.50-0.60 — motif returns with added density and upper extensions\n"
    "  bridge:       energy 0.60-0.75 — harmonic departure, hard contrast, key may shift\n"
    "  verse3:       energy 0.75-0.90 — climax, all instruments fully active, peak density\n"
    "  outro:        energy 0.15-0.25 — dissolution, motif callbacks, thin the texture bar by bar\n\n"
    + _SHEET_FORMAT
    + "\nOutput [SESSION COMPLETE] then the complete JSON in a ```json block. Nothing else."
)


def evolve(sheet: dict, next_section: str, synth_context: str = "") -> dict:
    """Generate the next 128-step ClankerBoy loop for next_section using Claude. BPM is locked."""
    client  = llm_clients.get_client(config.BAND["Claude"])
    tension = _SECTION_TENSION.get(next_section, 0.5)

    prompt = (
        f"Previous section sheet:\n{json.dumps(sheet, indent=2)}\n\n"
        f"Target section: {next_section.upper()}\n"
        f"Target energy/tension: {tension}\n"
        f"BPM={sheet.get('bpm', 120)} — locked.\n\n"
        + (synth_context + "\n\n" if synth_context else "")
        + "Generate 8 bars (128 steps at d:0.25) of ClankerBoy JSON for this section. "
        "Evolve the motifs, density, and orchestration to match the arc guidance above. "
        "Output [SESSION COMPLETE] then the complete JSON in a ```json block."
    )

    try:
        response = client.send(
            _EVOLVE_SYSTEM,
            [{"role": "system", "content": prompt}],
        )
        evolved = _extract_sheet_json(response)
        if evolved:
            evolved["bpm"]     = sheet["bpm"]   # enforce BPM lock
            evolved["tension"] = tension
            print(
                f"  Evolved -> {next_section} | bpm={evolved['bpm']} "
                f"tension={tension} | {len(evolved.get('steps', []))} steps"
            )
            return evolved
        print(f"  [evolve] no JSON found in response -- keeping current sheet")
    except Exception as e:
        print(f"  [evolve error] {e} -- keeping current sheet")

    fallback = copy.deepcopy(sheet)
    fallback["tension"] = tension
    return fallback


# ── SESSION RUNNER ────────────────────────────────────────────────────────

def run_session(
    sheet:         dict,
    out_dir:       str = "output",
    section_label: str = "",
    disable:       list[str] | None = None,
) -> dict[str, AudioSegment]:
    """
    Fire all active agents in parallel.
    Each agent: reads the shared Music Sheet -> LLM sequence call -> synthesize audio.
    Returns { agent_name: AudioSegment }.
    """
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    prefix   = f"{section_label}_" if section_label else ""
    agents   = sheet.get("agents", {})
    disabled = set(disable or [])
    ant_key  = config.ANTHROPIC_API_KEY

    tasks: dict[str, callable] = {}

    if "sampler" not in disabled and agents.get("sampler", {}).get("active"):
        _p = str(Path(out_dir) / f"{prefix}voice.wav")
        tasks["sampler"] = lambda p=_p: run_voice(sheet, output_path=p)

    if "bass_sh101" not in disabled and agents.get("bass_sh101", {}).get("active"):
        _p = str(Path(out_dir) / f"{prefix}bass_sh101.wav")
        tasks["bass_sh101"] = lambda p=_p: run_sh101(
            sheet, output_path=p, api_key=ant_key,
            vst_path=config.VST_PATHS.get("bass_sh101"))

    if "drums" not in disabled and HAS_DRUMS and agents.get("drums", {}).get("active"):
        _p = str(Path(out_dir) / f"{prefix}drums.wav")
        tasks["drums"] = lambda p=_p: run_drums(
            sheet, output_path=p, api_key=ant_key,
            vst_path=config.VST_PATHS.get("drums"))

    # "harmony" disables both sub-tracks; "buchla"/"hybrid" disable individually.
    # Only run the harmony agent if at least one sub-track is still active.
    _harmony_active = (
        HAS_HARMONY
        and agents.get("harmony", {}).get("active")
        and "harmony" not in disabled
        and not ("buchla" in disabled and "hybrid" in disabled)
    )
    if _harmony_active:
        # base path: agent derives _buchla.wav and _hybrid.wav from it
        _p = str(Path(out_dir) / f"{prefix}harmony.wav")
        tasks["harmony"] = lambda p=_p: run_harmony(
            sheet, output_path=p, api_key=ant_key,
            vst_path=config.VST_PATHS.get("harmony_lead"),
            vst_path_pad=config.VST_PATHS.get("harmony_pad"))

    if "voder" not in disabled and HAS_VODER and agents.get("voder", {}).get("active"):
        _p = str(Path(out_dir) / f"{prefix}voder.wav")
        tasks["voder"] = lambda p=_p: run_voder(
            sheet, output_path=p, api_key=ant_key)

    if not tasks:
        return {}

    # Route agent thread output to per-agent log files
    gui_out    = sys.stdout
    old_stdout = sys.stdout
    sys.stdout = _AgentStream(gui_out)
    gui_out.write(f"  agents -> {', '.join(tasks.keys())}\n")

    def _wrap(name: str, fn):
        log_path = Path(out_dir) / f"{name}.log"
        def _run():
            gui_out.write(f"  [start] {name}\n")
            with open(log_path, "w", encoding="utf-8") as lf:
                _tls.stream = lf
                try:
                    return fn()
                finally:
                    _tls.stream = None
        return _run

    results: dict[str, AudioSegment] = {}

    try:
        with ThreadPoolExecutor(max_workers=len(tasks)) as pool:
            future_to_name = {pool.submit(_wrap(n, fn)): n for n, fn in tasks.items()}
            for future in as_completed(future_to_name):
                name = future_to_name[future]
                try:
                    audio = future.result()
                    if audio is None:
                        gui_out.write(f"  [empty] {name}\n")
                    elif name == "harmony" and isinstance(audio, dict):
                        # harmony_agent returns {"buchla": seg, "hybrid": seg}
                        # Honour individual sub-track disable flags
                        for sub_name, sub_audio in audio.items():
                            if sub_name in disabled:
                                gui_out.write(f"  [skip]  {sub_name:<12} (disabled)\n")
                            elif sub_audio:
                                results[sub_name] = sub_audio
                                gui_out.write(f"  [done]  {sub_name:<12} {len(sub_audio)/1000:.1f}s\n")
                    elif audio:
                        results[name] = audio
                        gui_out.write(f"  [done]  {name:<12} {len(audio)/1000:.1f}s\n")
                    else:
                        gui_out.write(f"  [empty] {name}\n")
                except Exception as exc:
                    gui_out.write(f"  [error] {name}: {exc}\n")
    finally:
        sys.stdout = old_stdout

    return results


# ── FULL TRACK ────────────────────────────────────────────────────────────

def run_track(
    brief:      str,
    arc:        list[str] | None = None,
    out_dir:    str | Path = "output",
    disable:    list[str] | None = None,
    single_llm: bool = False,
) -> AudioSegment | None:
    """
    Full pipeline:
      1. Chatroom negotiates verse1 -> initial Music Sheet
      2. For each section: evolve() then run_session()
      3. mixer.mix_section() per section
      4. mixer.stitch_and_master() -> full_track.wav
    """
    from mixer.mixer import mix_section, stitch_and_master, stitch_stem

    arc     = arc or DEFAULT_ARC
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n{'=' * 62}")
    print(f"  THE CLANKERS 3 -- FULL TRACK")
    print(f"  Brief : {brief}")
    print(f"  Arc   : {' -> '.join(arc)}")
    print(f"{'=' * 62}\n")

    # ── Step 1: chatroom negotiates the opening section ────────────────
    print("Step 1: Chatroom negotiating opening section...\n")
    room  = Chatroom(session_name=arc[0])
    sheet = room.negotiate_section(brief=brief, section_name=arc[0], solo=single_llm)

    # Inject canonical tension for the opening section if chatroom didn't set it
    if "tension" not in sheet:
        sheet["tension"] = _SECTION_TENSION.get(arc[0], 0.35)

    # Save initial sheet
    with open(out_dir / "sheet_initial.json", "w") as f:
        json.dump(sheet, f, indent=2)

    sections: list[AudioSegment] = []

    # Per-stem section lists (all stems, padded with silence when inactive)
    stem_sections:  dict[str, list] = {name: [] for name in ALL_STEMS}
    stem_had_audio: dict[str, bool] = {name: False for name in ALL_STEMS}

    # ── Step 2-4: walk the arc ─────────────────────────────────────────
    for i, section in enumerate(arc):
        import time as _t; _t.sleep(0.05)   # yield for GUI

        if i > 0:
            print(f"\n  Evolving -> {section.upper()}...")
            sheet = evolve(sheet, section)
            with open(out_dir / f"sheet_{section}.json", "w") as f:
                json.dump(sheet, f, indent=2)

        print(f"\n-- {section.upper()} " + "-" * 44)
        tracks = run_session(sheet, out_dir=str(out_dir), section_label=section,
                             disable=disable)

        if not tracks:
            print(f"  [skip] no active agents produced audio for {section}")
            continue

        mixed = mix_section(tracks, sheet)
        if mixed:
            path = out_dir / f"{section}_mix.wav"
            mixed.export(str(path), format="wav")
            print(f"  Mix -> {path}  ({len(mixed)/1000:.1f}s)")
            sections.append(mixed)

            # Collect per-stem audio; pad with silence if agent was silent this section
            section_dur_ms = len(mixed)
            for stem_name in ALL_STEMS:
                if stem_name in tracks:
                    stem_sections[stem_name].append(tracks[stem_name])
                    stem_had_audio[stem_name] = True
                else:
                    stem_sections[stem_name].append(
                        AudioSegment.silent(duration=section_dur_ms, frame_rate=44100)
                    )

    if not sections:
        print("No audio produced.")
        return None

    # ── Step 5a: export individual stems (time-aligned, no master compression)
    stems_dir = out_dir / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)
    print("\n  Exporting stems...")
    exported_stems = []
    for stem_name in ALL_STEMS:
        if not stem_had_audio.get(stem_name):
            continue   # agent never produced audio -- skip
        segs = stem_sections[stem_name]
        if not segs:
            continue
        try:
            full_stem = stitch_stem(segs)
            stem_path = stems_dir / f"{stem_name}.wav"
            full_stem.export(str(stem_path), format="wav")
            print(f"  Stem -> {stem_name}.wav  ({len(full_stem)/1000:.1f}s)")
            exported_stems.append(stem_name)
        except Exception as e:
            print(f"  [stem error] {stem_name}: {e}")
    if exported_stems:
        print(f"  Stems dir: {stems_dir}")

    # ── Step 5b: stitch + master ────────────────────────────────────────
    print("\n  Assembling + mastering full track...")
    full_track = stitch_and_master(sections)

    track_path = out_dir / "full_track.wav"
    full_track.export(str(track_path), format="wav")
    print(f"\n{'=' * 62}")
    print(f"  DONE: {track_path}  ({len(full_track)/1000:.1f}s)")
    print(f"{'=' * 62}\n")
    return full_track


# ── SOLO COMPANION ────────────────────────────────────────────────────────

def run_solo(
    brief:   str,
    agent:   str,
    section: str = "verse1",
    out_dir: str | Path = "output",
) -> AudioSegment | None:
    """
    Run a single companion in isolation.
    Negotiates a music sheet for the brief, then activates only the target agent.

    Example:
        run_solo("dreamy buchla melodies, slow evolving", "harmony")
        run_solo("heavy kick, sparse snare", "drums")
    """
    from mixer.mixer import mix_section

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n{'=' * 62}")
    print(f"  THE CLANKERS 3 — SOLO: {agent.upper()}")
    print(f"  Brief  : {brief}")
    print(f"  Section: {section}")
    print(f"{'=' * 62}\n")

    # Negotiate a full music sheet, then isolate the target agent
    print("Negotiating music sheet...\n")
    room  = Chatroom(session_name=section)
    sheet = room.negotiate_section(brief=brief, section_name=section)

    agents_block = sheet.setdefault("agents", {})
    for name in list(agents_block.keys()):
        agents_block[name]["active"] = (name == agent)
    if agent not in agents_block:
        agents_block[agent] = {"active": True}

    with open(out_dir / f"sheet_solo_{agent}.json", "w") as f:
        json.dump(sheet, f, indent=2)

    print(f"\n-- SOLO: {agent.upper()} " + "-" * 40)
    tracks = run_session(sheet, out_dir=str(out_dir), section_label=f"solo_{agent}")

    if not tracks:
        print(f"  [solo] no audio produced for {agent}")
        return None

    mixed = mix_section(tracks, sheet)
    if mixed:
        path = out_dir / f"solo_{agent}.wav"
        mixed.export(str(path), format="wav")
        print(f"\n  DONE: {path}  ({len(mixed)/1000:.1f}s)")
        print(f"{'=' * 62}\n")
        return mixed

    return None


# ── CLI ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="The Clankers 3 -- Conductor")
    parser.add_argument("brief", nargs="?",
                        default="dark industrial EBM, cold acid bass, mechanical drums")
    parser.add_argument("--arc", nargs="+", default=None,
                        help=f"Section arc (default: {' '.join(DEFAULT_ARC)})")
    parser.add_argument("--out", default="output")
    parser.add_argument("--disable", nargs="+", default=None)
    args = parser.parse_args()

    run_track(brief=args.brief, arc=args.arc, out_dir=args.out, disable=args.disable)
