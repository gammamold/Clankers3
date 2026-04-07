# llm_menu.py -- The Clankers 3
# Interactive startup menu: choose LLM provider, model, and API key.
# Call ask_llm_config() before starting the pipeline; it patches the
# config module in-place so all downstream code picks up the selection.

import sys
import getpass

import config

# ── Provider catalogue ─────────────────────────────────────────────────────

_PROVIDERS = [
    {
        "label":    "Anthropic  (Claude)",
        "key":      "anthropic",
        "models": [
            "claude-opus-4-6",
            "claude-sonnet-4-6",
            "claude-haiku-4-5-20251001",
        ],
        "default_model_attr": "CLAUDE_MODEL",
        "api_key_attr":       "ANTHROPIC_API_KEY",
        "band_key":           "anthropic",
    },
    {
        "label":    "Google     (Gemini)",
        "key":      "google",
        "models": [
            "gemini-2.5-pro",
            "gemini-2.0-flash",
            "gemini-1.5-pro",
        ],
        "default_model_attr": "GEMINI_MODEL",
        "api_key_attr":       "GEMINI_API_KEY",
        "band_key":           "google",
    },
    {
        "label":    "OpenAI     (ChatGPT)",
        "key":      "openai",
        "models": [
            "gpt-4o",
            "gpt-4o-mini",
            "o1",
            "o3-mini",
        ],
        "default_model_attr": "CHATGPT_MODEL",
        "api_key_attr":       "OPENAI_API_KEY",
        "band_key":           "openai",
    },
]


# ── Helpers ────────────────────────────────────────────────────────────────

def _mask(key: str) -> str:
    """Return a partially masked API key for display."""
    if not key:
        return "(not set)"
    visible = key[:8] if len(key) > 12 else key[:4]
    return visible + "..." + key[-4:]


def _prompt_int(prompt: str, lo: int, hi: int) -> int:
    """Ask for an integer in [lo, hi], loop until valid."""
    while True:
        raw = input(prompt).strip()
        if raw.isdigit():
            val = int(raw)
            if lo <= val <= hi:
                return val
        print(f"  Please enter a number between {lo} and {hi}.")


def _divider():
    print("─" * 56)


# ── Public entry point ─────────────────────────────────────────────────────

def ask_llm_config() -> None:
    """
    Interactive menu: choose provider → model → API key.
    Patches the config module in-place; all downstream imports
    (llm_clients, chatroom, conductor) will see the updated values.
    """
    print()
    _divider()
    print("  THE CLANKERS 3  —  LLM Configuration")
    _divider()

    # ── Step 1: provider ──────────────────────────────────────────────────
    print("\n  Select LLM provider:\n")
    for i, p in enumerate(_PROVIDERS, 1):
        current_key = getattr(config, p["api_key_attr"], "")
        status = _mask(current_key) if current_key else "(no key)"
        print(f"    {i}) {p['label']}   [{status}]")
    print()

    provider_idx = _prompt_int("  Choice [1-3]: ", 1, len(_PROVIDERS)) - 1
    provider = _PROVIDERS[provider_idx]

    # ── Step 2: model ─────────────────────────────────────────────────────
    current_model = getattr(config, provider["default_model_attr"], "")
    print(f"\n  Select model for {provider['label']}:\n")
    models = provider["models"]

    # Show current model at the top of the list if it's not already there
    display_models = list(models)
    if current_model and current_model not in display_models:
        display_models.insert(0, current_model)

    for i, m in enumerate(display_models, 1):
        marker = " *" if m == current_model else "  "
        print(f"   {marker}{i}) {m}")
    print()

    model_idx = _prompt_int(f"  Choice [1-{len(display_models)}]: ", 1, len(display_models)) - 1
    chosen_model = display_models[model_idx]

    # ── Step 3: API key ───────────────────────────────────────────────────
    current_key = getattr(config, provider["api_key_attr"], "")
    masked = _mask(current_key)
    print(f"\n  API key for {provider['label']}")
    print(f"  Current: {masked}")
    print("  (Press Enter to keep current key, or paste a new one)\n")

    try:
        new_key = getpass.getpass("  API key: ").strip()
    except (EOFError, OSError):
        # Non-interactive environment (pipes, tests): skip key prompt
        new_key = ""

    chosen_key = new_key if new_key else current_key

    if not chosen_key:
        print("\n  WARNING: No API key provided. The pipeline will likely fail.")

    # ── Patch config in-place ─────────────────────────────────────────────
    band_provider = provider["band_key"]

    # Update the chosen provider's key and model
    setattr(config, provider["api_key_attr"], chosen_key)
    setattr(config, provider["default_model_attr"], chosen_model)

    # Point all BAND members to the chosen provider so every chatroom
    # persona and conductor call uses the same LLM.
    for band_member in config.BAND:
        config.BAND[band_member] = band_provider

    # ── Summary ───────────────────────────────────────────────────────────
    print()
    _divider()
    print(f"  Provider : {provider['label']}")
    print(f"  Model    : {chosen_model}")
    print(f"  API key  : {_mask(chosen_key)}")
    _divider()
    print()
