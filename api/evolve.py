# api/evolve.py -- Lightweight evolve() for the web API
#
# Extracted from conductor/conductor.py so the web API doesn't pull in
# audio agent imports (agents.voice, agents.bassline, etc.) that only
# exist in the full CLI pipeline.

import json
import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
import llm_clients
from chatroom.chatroom import _extract_sheet_json, _SHEET_FORMAT

# Canonical tension curve per section name.
_SECTION_TENSION: dict[str, float] = {
    "verse1":       0.30,
    "instrumental": 0.45,
    "verse2":       0.52,
    "bridge":       0.75,
    "verse3":       0.85,
    "outro":        0.20,
}

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


def evolve(sheet: dict, next_section: str, synth_context: str = "", client=None) -> dict:
    """Generate the next 128-step ClankerBoy loop for next_section. BPM is locked."""
    if client is None:
        client = llm_clients.get_client(config.BAND["Claude"])
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
