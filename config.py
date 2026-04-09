# config.py -- The Clankers 3
# Tries to inherit API keys + LLM settings from the_Clankers (sibling project).
# Falls back to empty defaults if the sibling project is not found.
# The LLM selection menu (llm_menu.py) overwrites these at runtime.

import importlib.util
from pathlib import Path

# ── Try to load sibling config ─────────────────────────────────────────────

_SIBLING = Path(__file__).resolve().parent.parent / "the_Clankers" / "config.py"

_orig = None
if _SIBLING.exists():
    try:
        _spec = importlib.util.spec_from_file_location("_clankers1_config", _SIBLING)
        _orig = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_orig)
    except Exception:
        _orig = None

def _get(attr, default=None):
    return getattr(_orig, attr, default) if _orig else default

# ── API keys ───────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = _get("ANTHROPIC_API_KEY", "")
GEMINI_API_KEY    = _get("GEMINI_API_KEY",    "")
OPENAI_API_KEY    = _get("OPENAI_API_KEY",    "")

# ── Model names ────────────────────────────────────────────────────────────
CLAUDE_MODEL  = _get("CLAUDE_MODEL",  "claude-sonnet-4-6")
GEMINI_MODEL  = _get("GEMINI_MODEL",  "gemini-2.0-flash")
CHATGPT_MODEL = _get("CHATGPT_MODEL", "gpt-4o")

# ── Band mapping: persona -> provider key used by llm_clients.get_client() ─
# All three personas default to Claude. The LLM menu can redirect them all
# to a single chosen provider at startup.
BAND = _get("BAND", {
    "Claude":  "anthropic",
    "Gemini":  "google",
    "ChatGPT": "openai",
})

# ── Rate limits (requests per minute) ─────────────────────────────────────
GEMINI_TIMEOUT_MS = _get("GEMINI_TIMEOUT_MS", 120_000)
GEMINI_RPM        = _get("GEMINI_RPM",  140)
CLAUDE_RPM        = _get("CLAUDE_RPM",  200)
CHATGPT_RPM       = _get("CHATGPT_RPM", 200)

# ── Chatroom settings ──────────────────────────────────────────────────────
MAX_ROUNDS_PER_SESSION = 6

# ── VST paths ──────────────────────────────────────────────────────────────
# Set any value to None to fall back to numpy synthesis for that agent.
VST_PATHS: dict[str, str | None] = {
    "bass_sh101":   r"C:\Program Files\Common Files\VST3\bassYnth Pro-One.vst3",
    "drums":        r"C:\Program Files\Common Files\VST3\Antigravity Drums.vst3",
    "harmony_lead": r"C:\Program Files\Common Files\VST3\Buchla Systems.vst3",
    "harmony_pad":  r"C:\Program Files\Common Files\VST3\HybridSynth.vst3",
    "voder":        None,   # pure formant synthesis -- no VST
    "voice":        None,   # sample-based -- no VST
}

# ── Paths ──────────────────────────────────────────────────────────────────
_ROOT       = Path(__file__).resolve().parent
OUTPUT_DIR  = _ROOT / "output"
SAMPLES_DIR = _ROOT / "samples"
LOGS_DIR    = OUTPUT_DIR / "logs"
