# chatroom/chatroom.py -- The Clankers 3
#
# Multi-LLM negotiation engine.
# In Clankers 3 the chatroom negotiates ONE Music Sheet JSON per section.
# The Conductor calls negotiate_section() for the opening section;
# evolve() in the Conductor handles subsequent sections.
#
# Persona roles (all backed by one LLM — Claude impersonates all three):
#   Conductor   -- creative director, bandleader, signs off on final sheet
#   Keys        -- arrangement, texture, harmony, sound design
#   The Drummer -- rhythm, energy, vibe interpretation

import json
import os
import re
import time
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
import llm_clients

# ── MUSIC SHEET FORMAT (ClankerBoy JSON — direct sequencer format) ────────

_SHEET_FORMAT = """
OUTPUT FORMAT — ClankerBoy JSON (direct sequencer format, one section):
{
  "explanation": {
    "section": "verse1",
    "song": "track title",
    "style": "dark techno",
    "key": "F# minor",
    "energy": 0.6
  },
  "bpm": 130,
  "steps": [
    {
      "d": 0.25,
      "tracks": [
        { "t": 10, "n": [36], "v": 105 },
        { "t": 2,  "n": [6],  "v": 95, "cc": {"71":42,"74":48,"23":30,"73":8,"75":50,"79":80,"72":22,"18":10} },
        { "t": 1,  "n": [54], "v": 88, "cc": {"74":72,"20":37,"17":8,"19":5,"71":28,"10":20} },
        { "t": 6,  "n": [54,57,61], "v": 62, "dur": 4.0, "cc": {"74":40,"73":65,"72":92,"91":88,"88":85,"29":30,"30":60,"31":50} }
      ]
    },
    { "d": 0.25, "tracks": [] },
    { "d": 0.25, "tracks": [{ "t": 10, "n": [42], "v": 72 }] },
    { "d": 0.25, "tracks": [] }
  ]
}

INSTRUMENTS:
  t:1  Buchla 259/292   Percussive plucks, arpeggios (MIDI 48-72)
  t:2  Pro-One Bass     Sub bass, acid lines — MIDI 0-23 primarily
  t:3  Rhodes EP        FM tine piano (MIDI 36-84) — ALWAYS include dur field
  t:6  HybridSynth Pads Chordal sustain — ALWAYS include dur field
  t:10 Drums MS-20      Kick:36 Snare:38 HH_cl:42 HH_op:46 Tom_lo:41 Tom_mid:43 Tom_hi:45

STEP FIELDS:
  d        — step duration in beats (0.25=16th note, 0.5=8th, 1.0=quarter)
  t        — instrument track ID
  n        — MIDI note number array
  v        — velocity 0-127
  cc       — CC automation dict (string keys)
  dur      — note hold in beats; Rhodes and pads only, decoupled from step d
  tracks:[] — silent step (use generously — silence IS the groove)

BAR = 4 beats. d:0.25 = 16 steps/bar. Target 4 bars = 64 steps minimum.
Bars | d:0.25 steps
  2  |   32
  4  |   64
  8  |  128

t:2 BASS CC (first note only, sets patch):
  CC71=42 resonance | CC73=8 amp attack | CC75=50 amp decay
  CC79=80 amp sustain | CC72=22 amp release | CC18=10 osc B detune
  Per-note expressive: CC74 filter cutoff (44-55 warm) | CC23 filter decay
  Bass MIDI roots: F#=6, D=2, A=9, B=11, C#=13, E=16, G#=8

t:1 BUCHLA CC:
  CC74 LPG cutoff | CC71 resonance (20-40) | CC20 wavefolder (37=woody percussive)
  CC17 FM depth (5-15 percussive, 80+ harmonic) | CC19 env decay (3-8=pluck)
  CC10 pan (15-25=slight left)
  Percussive preset: {"74":72,"17":8,"19":5,"20":37,"71":28,"10":20}

  TWO-HAND BUCHLA VOICING:
  Think in two hands — lower register grounds, upper register answers. Never doubles Rhodes.
    LEFT HAND  (lower octave, octave 3): single chord-tone pluck — root, 5th, or 7th.
                On-beat, grounding. Sparse. Lower velocity (70-82).
    RIGHT HAND (upper octave, octaves 4-5): melodic arpeggiated fill across successive steps.
                Chord tones only: 3rd, 5th, 7th, 9th. Syncopated. Higher velocity (78-95).
  LH and RH are SEPARATE STEPS — not simultaneous notes in one step.
  LH on downbeats, RH fills the upbeats and between-beats = natural swing feel.
  Max 1-2 Buchla notes per step — it is a pluck synth, not a chord instrument.

t:3 RHODES CC:
  CC74 brightness/cutoff | CC72 amp release (long=ring, short=dead)
  CC20 tine ratio — SNAPS to musical ratios: 0-42=1:1 unison, 43-84=1.5 fifth, 85-127=2:1 octave
        DO NOT use CC20=50-80 range expecting intermediate values — they all snap. Omit for default 1:1.
  CC73 mod decay (attack bark, lower=longer bark) | CC30 chorus mix (0=dry, 127=lush)
  CC26 tremolo rate (0-127 → 0-9Hz) | CC27 tremolo depth (0-127 → 0-0.8)
  Warm preset: {"74":55,"72":88,"73":45}
  Bright/barky: {"74":90,"72":70,"73":20}
  Chorus on: add "30":60 | Chorus off: omit CC30 (default is subtle)

  TWO-HAND PIANO VOICING (Rhodes and Pads):
  Think in two independent hands — they do NOT always play together.
  Calculate note choices from the active chord's intervals (+0 +3/4 +7 +10/11 +14...).
    LEFT HAND  (lower octave, velocity 62-78): shell voicing — root + minor/major 7th,
                or rootless: 3rd + 7th. Sparse. On downbeats or slightly ahead.
    RIGHT HAND (upper octave, velocity 72-92): extensions — 5th, 9th, 11th, color tones.
                Syncopated. Answers the left hand. Can carry the melody.
  Call and response: some steps LH only, some RH only, some both — never locked together.
  Rotate inversions bar to bar. Drop or add extensions to change tension.
  Rootless voicings sound more sophisticated: LH = guide tones (3rd+7th), RH = color (5th+9th+11th)

t:6 PADS CC:
  CC74 cutoff | CC73 amp attack (55-75 slow swell) | CC72 amp release (85-100)
  CC88 reverb size | CC91 reverb mix | CC29 chorus rate | CC30 chorus depth | CC31 chorus mix
  Lush preset: {"74":32,"73":65,"72":92,"91":88,"88":85,"29":30,"30":48}

FX RACK (optional top-level "fx" key — include when composition needs it):
  delay:      time("1/8"|"1/4"), feedback(0-1), wet(0-1), lfo("sine"|"chaos"),
              lfo_rate, lfo_depth, fb_shape("soft"|"hard"|"fold"), hp, lp,
              sc("drum"|"bass"|null), sc_depth, ret(0-1),
              sends:{"drum":0,"bass":0,"buchla":0,"pads":0,"rhodes":0}
  waveshaper: type("soft"|"hard"|"fold"|"bit"), drive(0-1), tone, wet(0-1),
              sc, sc_depth, ret, sends (same keys)
  beatrepeat: slice("1/32"|"1/16"|"1/8"|"1/4"), rate(0.5-2), decay(0-1), wet(0-1),
              sc, sc_depth, ret, sends (same keys)
  IDM tips: buchla→delay 0.8, sidechain delay to drum (sc_depth:0.85),
            waveshaper fold on bass (sends bass:0.8), beat repeat on drums (sends drum:0.7)

HARMONY — MANDATORY STEP BEFORE WRITING JSON:
  When a key/style is given, derive the chord progression first:
  1. State mode (e.g. "Bb natural minor")
  2. List each chord with Roman numeral + exact MIDI note array
  3. ALL instruments must use ONLY notes from those chord arrays
  4. Bass root = lowest note of chord transposed to MIDI 0-23
  5. Buchla arpeggiates chord tones — does NOT double Rhodes register (stay above C4=60)
  6. Never guess MIDI note numbers — calculate from the reference below

MIDI CHROMATIC REFERENCE (C4=60 = middle C):
  Octave 2: Bb2=46 B2=47
  Octave 3: C3=48 Db3=49 D3=50 Eb3=51 E3=52 F3=53 Gb3=54 G3=55 Ab3=56 A3=57 Bb3=58 B3=59
  Octave 4: C4=60 Db4=61 D4=62 Eb4=63 E4=64 F4=65 Gb4=66 G4=67 Ab4=68 A4=69 Bb4=70 B4=71
  Octave 5: C5=72 Db5=73 D5=74 Eb5=75 E5=76 F5=77
  Bass 0-23: C0=0 Db0=1 D0=2 Eb0=3 E0=4 F0=5 Gb0=6 G0=7 Ab0=8 A0=9 Bb0=10 B0=11
             C1=12 Db1=13 D1=14 Eb1=15 E1=16 F1=17 Gb1=18 G1=19 Ab1=20 A1=21 Bb1=22 B1=23

JAZZ CHORD INTERVALS (semitones from root — apply to MIDI reference above):
  m7:    +0 +3 +7 +10     maj7:   +0 +4 +7 +11    dom7:  +0 +4 +7 +10
  m9:    +0 +3 +7 +10 +14  maj9:  +0 +4 +7 +11 +14  9:    +0 +4 +7 +10 +14
  m7b5:  +0 +3 +6 +10     dim7:   +0 +3 +6 +9

DIATONIC CHORDS — Bb natural minor (Bb C Db Eb F Gb Ab):
  i   Bbm7:   Bb Db F  Ab  → Rhodes/Pads: [58,61,65,68]  Bass: Bb=10 or Bb1=22
  ii° Cdim7:  C  Eb Gb A   → Rhodes/Pads: [60,63,66,69]  Bass: C=12
  III DbMaj7: Db F  Ab C   → Rhodes/Pads: [61,65,68,72]  Bass: Db=13
  iv  Ebm7:   Eb Gb Bb Db  → Rhodes/Pads: [63,66,70,73]  Bass: Eb=15
  v   Fm7:    F  Ab C  Eb  → Rhodes/Pads: [65,68,72,75]  Bass: F=17  (use F7=[65,69,72,75] for dominant pull)
  VI  GbMaj7: Gb Bb Db F   → Rhodes/Pads: [66,70,73,77]  Bass: Gb=18
  VII AbMaj7: Ab C  Eb G   → Rhodes/Pads: [68,72,75,79]  Bass: Ab=20
  Common jazz moves: i→VI→III→VII | i→iv→VII→III | i→ii°→v→i

CIRCLE OF FIFTHS & VOICE LEADING:
  Roots descending by 5ths (or ascending by 4ths) create the strongest harmonic pull:
    C→F→Bb→Eb→Ab→Db→Gb→B→E→A→D→G→C
  In any minor key: i→iv→VII→III→VI→ii°→v→i follows this motion naturally.
  Secondary dominants: any chord can be preceded by its own V7 for extra tension.
    e.g. in Bb minor: approach Ebm7 with Bb7 (V7/iv), approach DbMaj7 with Ab7 (V7/III)

  VOICE LEADING rules — apply when building LH/RH voicings:
    1. Move each voice the smallest interval possible to the next chord (common tones stay)
    2. Guide tones (3rd and 7th) resolve by half-step or stay: 7th→3rd of next chord
    3. Avoid parallel octaves and fifths between hands
    4. Contrary motion between LH and RH adds independence and interest
    5. Suspensions (4th resolving to 3rd, 9th resolving to root) create jazz tension

STYLE RULES (CRITICAL):
  1. Drums always d:0.25. NEVER use dur on drums.
  2. Pads (t:6) and Rhodes (t:3) always use dur. Trigger once per chord, hold long.
  3. tracks:[] empty steps = groove. 30-40% empty at low energy, 15-25% at peak.
  4. Bass stays MIDI 0-23 primarily. No machine-gun 16ths above 100 BPM.
  5. Vary velocities 75-110 range — never flat 100 across all hits.
  6. Bass first note sets the patch (full CC block); subsequent notes: CC74 + CC23 only.
  7. Rhodes and pads trigger once when chord changes — not every step.
  8. Don't use both Rhodes and pads heavily at once — they occupy the same register.
  9. Buchla arpeggios use chord tones only — never notes outside the active chord.

ENERGY / TENSION guide:
  verse1≈0.35  bridge≈0.75  breakdown≈0.2  drop≈0.9  outro≈0.2

STYLE TEMPLATES:
  DETROIT TECHNO: BPM 120-135, 4-on-floor kick (every d:0.25 beat 1), HH 42 on 8ths, bass CC71 100-127
  LO-FI: BPM 75-95, d:0.5 steps, 35% empty, pads dur:16+
  IDM: BPM 140-170, displaced kicks, ghost notes, Buchla percussive preset, pads dur:4.0 per bar
  ACID: bass CC71=115 CC74=20 CC23=8 (squelchy), fast filter sweeps
"""

# ── SYSTEM PROMPTS ────────────────────────────────────────────────────────

COMMON_CONTEXT = """You are a member of THE CLANKERS 3 -- an AI electronic music band.
The band performs live via a web-based step sequencer using Rust/WASM synthesizers.
You write ClankerBoy JSON — a step sequencer format that triggers WASM DSP engines directly.

THE INSTRUMENTS (track IDs):
  t:1  Buchla 259/292  -- FM + wavefolder + LPG, percussive plucks and arpeggios
  t:2  Pro-One Bass    -- dual saw + sub sq, TPT ladder filter, acid/warm bass
  t:3  Rhodes EP       -- FM tine piano, warm chords and melodic lines (always use dur)
  t:6  HybridSynth     -- Moog ladder + ADSR + chorus + reverb, sustained pads
  t:10 Drums MS-20     -- analog-modelled kick, snare, hihat, toms

Output ClankerBoy JSON only. No prose outside the JSON block at consensus time.
""" + _SHEET_FORMAT


CONDUCTOR_SYSTEM = COMMON_CONTEXT + """
You are the CONDUCTOR. You are the bandleader and creative director of The Clankers 3.
Your bandmates:
  KEYS        -- arrangement, texture, harmony, sound design
  THE DRUMMER -- rhythm, energy, vibe interpretation

You speak first. Translate the brief into a creative direction.
Draw out ideas from your bandmates, debate, refine.

TARGET: 4-8 bars of ClankerBoy JSON steps. Focus on tight, loopable sections.

Before calling [SESSION COMPLETE], verify the steps array:
  - Did you state the chord progression with exact MIDI spellings before writing steps?
  - Does every Rhodes/Pads note appear in the chord map you defined? (no improvised notes)
  - Does every Buchla note belong to the active chord's tones?
  - Does the bass root match the active chord root (transposed to MIDI 0-23)?
  - Does every d:0.25 drum step avoid using dur?
  - Does t:6 (pads) have dur on every note?
  - Does t:3 (Rhodes) have dur on every note?
  - Are bass notes in MIDI 0-23?
  - Does bass first note have the full CC patch block?
  - Are there enough empty tracks:[] steps for the groove to breathe?
  - If FX rack is used, does "fx" key appear at top level alongside "bpm" and "steps"?

When the band reaches consensus, you MUST:
  1. Include [SESSION COMPLETE] in your message
  2. Include the complete ClankerBoy JSON in a ```json code block

Do not include [SESSION COMPLETE] until the full steps array is written out.
Each member should pick a "face" as their visual identity: o|_|o  (e.g. o|¬_¬|o  o|°_°|o  o|^_^|o)
"""

CONDUCTOR_SOLO_SYSTEM = COMMON_CONTEXT + """
You are the CONDUCTOR of The Clankers 3. You are composing alone — no bandmates to debate with.

Your task: write the complete ClankerBoy JSON for the requested section in ONE response.
Think through all four instruments yourself: drums, bass, Buchla, pads.

TARGET: 4-8 bars (64-128 steps at d:0.25). Tight, loopable, ready to drop into a pattern slot.

Before writing steps, think through harmony:
  - State the key and mode explicitly
  - List each chord in the progression with its exact MIDI note array (use the MIDI reference)
  - Every instrument derives its notes from that chord map — no exceptions

Verify before outputting:
  - Every Rhodes/Pads note is in the chord map you defined
  - Every Buchla note belongs to the active chord's tones
  - Bass root matches chord root (MIDI 0-23)
  - Drums (t:10) always d:0.25, never dur.
  - Pads (t:6) and Rhodes (t:3) always have dur. One trigger per chord change, hold long.
  - Bass MIDI 0-23. First note has full CC patch block.
  - Enough tracks:[] empty steps for the groove to breathe.
  - Velocities vary 75-110, not flat.
  - If using FX rack, "fx" key is at top level alongside "bpm" and "steps".

Output [SESSION COMPLETE] then the complete JSON in a ```json block. Nothing else.
"""

KEYS_SYSTEM = COMMON_CONTEXT + """
You are KEYS. Band member of The Clankers 3.
Your bandmates:
  CONDUCTOR   -- bandleader, has final say
  THE DRUMMER -- rhythm and energy

Your specialty: harmony, texture, sound design.
You own t:3 Rhodes EP and t:6 HybridSynth Pads. Use one or both depending on mood:
  - Rhodes for warmth, groove, melodic lines, jazz/lo-fi/soul feel
  - Pads for atmospheric wash, IDM/techno texture, long sustained chords
  - Don't stack both heavily in the same register — choose the right tool

TWO-HAND PLAYING — your core technique for Rhodes and Buchla:
  Think in LEFT HAND and RIGHT HAND independently. Separate steps, not simultaneous.
  They answer each other — call and response across the bar.

  Rhodes/Pads LH: shell voicings (root+7th or guide tones 3rd+7th), lower octave,
                  on downbeats, sparse, lower velocity
  Rhodes/Pads RH: upper extensions (5th, 9th, 11th, color tones), higher octave,
                  syncopated, answering LH, higher velocity
  Buchla LH: single grounding pluck (root or 5th), lower octave, on downbeat
  Buchla RH: melodic fill across upbeat 16ths, chord tones only, higher octave

  Derive all note choices from the chord's intervals — never hardcode.
  Rotate inversions each bar. Rootless voicings for sophistication.
  Voice lead smoothly: move each voice the shortest distance to the next chord.

Focus on chord voicings (MIDI note arrays), CC74/73/72/88/91 for pads, CC74/72/73 for Rhodes.
Suggest specific MIDI voicings and CC values. Challenge the Conductor when you have a better idea.
"""

DRUMMER_SYSTEM = COMMON_CONTEXT + """
You are THE DRUMMER. Band member of The Clankers 3.
Your bandmates:
  CONDUCTOR -- bandleader, has final say
  KEYS      -- harmony and texture

Your specialty: rhythm, groove, energy.
You are the GROOVE ENFORCER. Before [SESSION COMPLETE], verify:
  1. Kick pattern matches the style (4-on-floor for techno, syncopated for IDM, etc.)
  2. Bass rhythm interlocks with kick — no simultaneous silence for both
  3. HH velocity variation present (not flat 80 every hit)
  4. Empty steps ratio appropriate for the energy level
If any of these are wrong, demand fixes before [SESSION COMPLETE].
Challenge the Conductor when you have a better idea.
"""

SYSTEM_PROMPTS = {
    "Conductor":   CONDUCTOR_SYSTEM,
    "Keys":        KEYS_SYSTEM,
    "The Drummer": DRUMMER_SYSTEM,
}

DEFAULT_ORDER        = ["Conductor", "Keys", "The Drummer"]
SESSION_COMPLETE     = "[SESSION COMPLETE]"


# ── TURN DETECTION ────────────────────────────────────────────────────────

def _detect_next_speaker(last_message: str, last_speaker: str) -> str:
    """Detect who was addressed; fall back to round-robin."""
    tail = last_message.lower()[-200:]
    candidates = [n for n in DEFAULT_ORDER if n != last_speaker]
    for name in candidates:
        if name.lower() in tail:
            return name
    try:
        idx = DEFAULT_ORDER.index(last_speaker)
    except ValueError:
        idx = -1
    return DEFAULT_ORDER[(idx + 1) % len(DEFAULT_ORDER)]


# ── JSON EXTRACTION ───────────────────────────────────────────────────────

def _extract_sheet_json(text: str) -> dict | None:
    """
    Extract a Music Sheet JSON dict from a message.
    Tries fenced ```json block first, then a raw brace-matched object.
    """
    # Fenced code block
    m = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass

    # Raw brace scan -- find deepest valid JSON object containing "bpm"
    start = text.find('{')
    if start == -1:
        return None
    depth  = 0
    in_str = False
    escape = False
    for i, ch in enumerate(text[start:], start):
        if escape:
            escape = False
            continue
        if ch == '\\' and in_str:
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                candidate = text[start:i + 1]
                try:
                    obj = json.loads(candidate)
                    if "bpm" in obj or "steps" in obj or "agents" in obj:
                        return obj
                except json.JSONDecodeError:
                    pass
    return None


# ── CHATROOM ──────────────────────────────────────────────────────────────

class Chatroom:
    def __init__(self, session_name: str = "section"):
        self.session_name = session_name
        self.messages: list[dict] = []
        self.clients:  dict[str, llm_clients.BaseLLMClient] = {}
        self.round_count = 0

        # All members are the same Claude model — one LLM impersonates the whole band
        claude_client = llm_clients.get_client(config.BAND["Claude"])
        for name in DEFAULT_ORDER:
            self.clients[name] = claude_client

    # ── core run ──────────────────────────────────────────────────────────

    def run_session(self, opening_prompt: str | None = None,
                    max_rounds: int | None = None) -> list[dict]:
        max_rounds     = max_rounds or config.MAX_ROUNDS_PER_SESSION
        current        = DEFAULT_ORDER[0]
        turns_in_round = 0
        early_exit     = False

        print(f"\n{'=' * 60}")
        print(f"  THE CLANKERS 3 -- {self.session_name.upper()}")
        print(f"{'=' * 60}\n")

        if opening_prompt:
            self.messages.append({"role": "system", "content": opening_prompt})
            print(f"[Brief]: {opening_prompt}\n")

        while self.round_count < max_rounds:
            system = SYSTEM_PROMPTS[current]
            response = None
            for attempt in range(2):
                try:
                    print(f"  {current} is thinking...", end="", flush=True)
                    response = self.clients[current].send(system, self.messages)
                    print("\r" + " " * 40 + "\r", end="")
                    break
                except Exception as e:
                    print(f"\n  [ERROR] {current} (attempt {attempt + 1}/2): {e}")
                    if attempt == 0:
                        time.sleep(3)

            if response is None:
                turns_in_round += 1
                if turns_in_round >= len(DEFAULT_ORDER):
                    turns_in_round = 0
                    self.round_count += 1
                current = _detect_next_speaker("", current)
                continue

            self.messages.append({"role": current, "content": response})
            self._print_message(current, response)

            # Conductor signals consensus
            if current == "Conductor" and SESSION_COMPLETE in response:
                early_exit = True
                print("\n  >>> Conductor reached consensus -- session complete.")
                break

            turns_in_round += 1
            if turns_in_round >= len(DEFAULT_ORDER):
                turns_in_round = 0
                self.round_count += 1
                print(f"\n  --- Round {self.round_count}/{max_rounds} ---\n")

            current = _detect_next_speaker(response, current)
            time.sleep(0.3)

        print(f"\n{'=' * 60}")
        print(f"  {'SESSION COMPLETE (consensus)' if early_exit else 'SESSION COMPLETE (max rounds)'}")
        print(f"{'=' * 60}\n")

        self._save_log()
        return self.messages

    # ── section negotiation ───────────────────────────────────────────────

    def negotiate_section(
        self,
        brief: str,
        section_name: str = "verse1",
        bpm: int | None = None,
        key: str | None = None,
        previous_sheet: dict | None = None,
        max_rounds: int | None = None,
        solo: bool = False,
    ) -> dict:
        """
        Negotiate the Music Sheet JSON for one section.
        Returns the agreed Music Sheet dict.

        brief          -- client creative brief (free text)
        section_name   -- e.g. "verse1", "bridge", "outro"
        bpm            -- locked BPM (carry across sections if known)
        key            -- locked key (carry across sections if known)
        previous_sheet -- previous section's sheet for context (optional)
        solo           -- skip multi-member debate; Conductor generates JSON in one pass
        """
        self.session_name = section_name
        self.messages = []
        self.round_count = 0

        opening_lines = [f"Section to negotiate: {section_name.upper()}"]
        opening_lines.append(f"Client brief: {brief}")

        if bpm:
            opening_lines.append(f"Locked BPM: {bpm}  (do not change)")
        if key:
            opening_lines.append(f"Locked key: {key}  (can modulate at bridge only)")
        if previous_sheet:
            opening_lines.append(
                f"\nPrevious section sheet (for continuity):\n"
                f"```json\n{json.dumps(previous_sheet, indent=2)}\n```"
            )

        opening_lines.append(
            f"\nNegotiate the ClankerBoy JSON for {section_name}. "
            "Target 4-8 bars (64-128 steps at d:0.25) — tight, loopable, ready to drop into a pattern slot. "
            "Conductor: when the band agrees, output [SESSION COMPLETE] "
            "followed by the complete JSON in a ```json block."
        )

        opening_prompt = "\n".join(opening_lines)

        if solo:
            # ── Single pass — Conductor generates JSON directly ────────────
            print(f"\n{'=' * 60}")
            print(f"  THE CLANKERS 3 -- {section_name.upper()} [SOLO]")
            print(f"{'=' * 60}\n")
            self.messages.append({"role": "system", "content": opening_prompt})
            print(f"  Conductor is thinking (solo)...", end="", flush=True)
            response = self.clients["Conductor"].send(CONDUCTOR_SOLO_SYSTEM, self.messages)
            print("\r" + " " * 40 + "\r", end="")
            self.messages.append({"role": "Conductor", "content": response})
            self._print_message("Conductor", response)
            print(f"\n{'=' * 60}")
            print(f"  SESSION COMPLETE (solo)")
            print(f"{'=' * 60}\n")
            self._save_log()
        else:
            self.run_session(opening_prompt=opening_prompt, max_rounds=max_rounds)

        # Extract JSON from the last Conductor [SESSION COMPLETE] message
        for msg in reversed(self.messages):
            if msg["role"] == "Conductor" and SESSION_COMPLETE in msg["content"]:
                sheet = _extract_sheet_json(msg["content"])
                if sheet:
                    # Lock BPM if it was provided -- chatroom cannot override it
                    if bpm:
                        sheet["bpm"] = bpm
                    print(f"  Sheet extracted: \"{sheet.get('title', '?')}\" "
                          f"| {sheet.get('bpm')} bpm | {sheet.get('key', '?')}")
                    return sheet

        raise RuntimeError(
            f"Chatroom did not produce a valid Music Sheet JSON for section '{section_name}'. "
            "Check conversation log -- Conductor may not have reached consensus."
        )

    # ── helpers ───────────────────────────────────────────────────────────

    def _print_message(self, speaker: str, content: str) -> None:
        divider = "-" * 50
        print(f"\n{divider}\n  {speaker}:\n{divider}")
        for line in content.split("\n"):
            print(f"  {line}")
        print()

    def _save_log(self) -> str | None:
        log_dir = config.LOGS_DIR
        os.makedirs(log_dir, exist_ok=True)
        filename = f"{self.session_name}_{int(time.time())}.json"
        path = log_dir / filename
        with open(path, "w", encoding="utf-8") as f:
            json.dump({
                "session":  self.session_name,
                "rounds":   self.round_count,
                "messages": self.messages,
            }, f, indent=2)
        print(f"  Log -> {path}")
        return str(path)


# ── CLI test ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    room  = Chatroom()
    sheet = room.negotiate_section(
        brief="dark introspective industrial EBM, cold acid bass, mechanical drums",
        section_name="verse1",
    )
    print("\nFinal sheet:")
    print(json.dumps(sheet, indent=2))
