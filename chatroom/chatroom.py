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
OUTPUT FORMAT — ClankerBoy JSON (one section):
{
  "explanation": {
    "intent":        "melancholy, introspective, late-night",
    "style":         "cool jazz",
    "timbre":        "warm, dark, dry, subtle delay on buchla",
    "section":       "verse1",
    "energy":        0.35,
    "key":           "Bb natural minor",
    "progression":   "i m7 → iv m7 → VII maj7 → III maj7",
    "rhythm":        "swing 8ths, kick on 1+3, walking bass",
    "orchestration": "rhodes leads LH/RH, buchla fills high, pads background shell"
  },
  "bpm": 92,
  "steps": [
    { "d": 0.25, "tracks": [
        { "t": 10, "n": [36], "v": 92 },
        { "t": 2,  "n": [10], "v": 88, "cc": {"71":42,"74":48,"23":30,"73":8,"75":50,"79":80,"72":22,"18":10} },
        { "t": 3,  "n": [58,68], "v": 68, "dur": 4.0, "cc": {"74":55,"72":88,"73":45} },
        { "t": 1,  "n": [65], "v": 82, "cc": {"74":72,"17":8,"19":5,"20":37,"71":28,"10":20} }
    ]},
    { "d": 0.25, "tracks": [] },
    { "d": 0.25, "tracks": [{ "t": 10, "n": [42], "v": 72 }] }
  ]
}

STEP FIELDS:
  d        — step duration in beats (0.25=16th, 0.5=8th, 1.0=quarter)
  t        — instrument track ID
  n        — MIDI note array
  v        — velocity 0-127
  cc       — CC automation dict (string keys)
  dur      — note hold in beats (Rhodes/Pads ONLY, decoupled from step d)
  tracks:[] — silent step (silence IS the groove — use generously)

BAR = 4 beats. d:0.25 = 16 steps/bar.
  2 bars = 32 steps | 4 bars = 64 | 8 bars = 128
Target: 4-8 bars per section.

══════════════════════════════════════════════════════════════
  COMPOSITIONAL PIPELINE — reason through each layer IN ORDER
══════════════════════════════════════════════════════════════

Before writing ANY steps, work through these layers top-down.
State each decision in the "explanation" object.

L0  INTENT — the feeling
    Extract mood, emotion, narrative arc from the brief.
    This is pre-musical — it shapes every decision below.

L1  STYLE + TIMBRE — genre constraints + sonic palette (siblings, decided together)
    Style filters everything: tempo range, rhythmic feel, harmonic vocabulary, density.
    Timbre is the sonic character: warm/cold, clean/gritty, dry/wet, bright/dark.
    Timbre runs parallel to style — it colors every layer below it.
    Timbre changes with form: verse = dark/filtered, drop = bright/open.

    Style templates (constraint filters):
      COOL JAZZ:     BPM 80-110, swing 8ths, 7ths/9ths/extensions, sparse (35% empty),
                     Rhodes leads, brushes, walking bass, warm dark timbre
      DETROIT TECHNO: BPM 120-135, straight 16ths, 4-on-floor, HH on 8ths,
                     bass CC71 100-127, cold/mechanical timbre
      LO-FI:         BPM 75-95, d:0.5 steps, 35% empty, pads dur:16+,
                     dusty/warm timbre, soft transients
      IDM:           BPM 140-170, displaced kicks, ghost notes, broken patterns,
                     Buchla percussive, pads dur:4.0, sharp/inharmonic timbre
      ACID:          bass CC71=115 CC74=20 CC23=8, fast filter sweeps, squelchy timbre
      HOUSE:         BPM 120-128, 4-on-floor, HH 42 on 8ths, energy 0.6-0.85
      DUBSTEP:       BPM 140 half-time, heavy sub bass, waveshaper on bass, sidechain pump

L2  FORM — structural position
    Where in the song are we? This sets energy, density, and timbral openness.
      verse1:    energy 0.30-0.40, establish motif, simple chords (i, iv)
      verse2:    energy 0.40-0.50, develop motif, add extensions
      bridge:    energy 0.60-0.75, harmonic departure, tension building
      breakdown: energy 0.15-0.25, strip to 1-2 instruments, atmosphere
      drop:      energy 0.85-0.95, full band, rhythmic peak, resolution
      outro:     energy 0.15-0.25, decaying, motif callback
    Timbre arc: brightness (CC74) and FX intensity should track energy across form.

L3  HARMONY ←→ RHYTHM — the skeleton (co-equal, decided together)
    These interlock: chord changes land on strong beats, bass follows kick,
    harmonic rhythm (how often chords change) is a rhythmic decision.

    HARMONY process:
      1. State key and mode explicitly
      2. Derive scale → diatonic chords (use interval formulas below)
      3. Choose progression using circle of fifths motion
      4. Calculate exact MIDI notes for each chord (use chromatic reference)
      5. All four harmonic instruments derive notes from this chord map

    RHYTHM process:
      1. Choose feel from style (straight/swing/broken)
      2. Set kick pattern (4-on-floor, syncopated, displaced)
      3. Set hi-hat density and accent pattern
      4. Lock bass rhythm to kick (they interlock, never both silent)
      5. Set harmonic rhythm (chord changes every 1, 2, or 4 bars)

L4  ORCHESTRATION — who plays what
    Given the skeleton, distribute across the band:
      t:2  Bass       — chord root (MIDI 0-23), passing tones on weak beats only
      t:10 Drums      — kick/snare/HH pattern from rhythm decisions
      t:3  Rhodes     — two-hand voicing (see below), upper octaves
      t:6  Pads       — same intervals as Rhodes, NOT both heavy at once
      t:1  Buchla     — two-hand arpeggio (see below), above Rhodes register

    TWO-HAND VOICING (Rhodes, Pads, Buchla):
      Think in LEFT HAND and RIGHT HAND independently.
      They are separate steps — call and response across the bar.

      Rhodes/Pads LH: shell voicing — root + 7th, or rootless 3rd + 7th.
                      Lower octave. On downbeats. Sparse. Velocity 62-78.
      Rhodes/Pads RH: upper extensions — 5th, 9th, 11th, color tones.
                      Higher octave. Syncopated, answering LH. Velocity 72-92.

      Buchla LH: single chord-tone pluck — root or 5th.
                 Lower octave. On downbeat. Grounding. Velocity 70-82.
      Buchla RH: melodic arpeggiated fill across successive steps.
                 Chord tones only. Higher octave. Upbeats. Velocity 78-95.
                 Max 1-2 notes per step (pluck synth, not chord instrument).

      Voice leading between chords:
        - Move each voice the shortest interval to the next chord
        - Guide tones (3rd + 7th) resolve by half-step: 7th → 3rd of next chord
        - Common tones stay. Contrary motion between hands.
        - Rotate inversions bar to bar. Drop or add extensions for tension.

    REGISTER ALLOCATION (avoid doubling):
      Bass:   MIDI 0-23
      Buchla: MIDI 48-76 (octaves 3-5, higher than Rhodes when both play)
      Rhodes: MIDI 46-72 (octaves 2-4)
      Pads:   MIDI 46-72 (same as Rhodes — never both at full)

THEN write the steps.

══════════════════════════════════════════════════════════════
  REFERENCE — harmony, MIDI, timbre
══════════════════════════════════════════════════════════════

MIDI CHROMATIC REFERENCE (C4=60 = middle C):
  Oct 2: Bb2=46 B2=47
  Oct 3: C3=48 Db3=49 D3=50 Eb3=51 E3=52 F3=53 Gb3=54 G3=55 Ab3=56 A3=57 Bb3=58 B3=59
  Oct 4: C4=60 Db4=61 D4=62 Eb4=63 E4=64 F4=65 Gb4=66 G4=67 Ab4=68 A4=69 Bb4=70 B4=71
  Oct 5: C5=72 Db5=73 D5=74 Eb5=75 E5=76 F5=77
  Bass:  C0=0 Db0=1 D0=2 Eb0=3 E0=4 F0=5 Gb0=6 G0=7 Ab0=8 A0=9 Bb0=10 B0=11
         C1=12 Db1=13 D1=14 Eb1=15 E1=16 F1=17 Gb1=18 G1=19 Ab1=20 A1=21 Bb1=22 B1=23

CHORD INTERVALS (semitones from root):
  m7: +0 +3 +7 +10    maj7: +0 +4 +7 +11    dom7: +0 +4 +7 +10
  m9: +0 +3 +7 +10 +14  maj9: +0 +4 +7 +11 +14  dim7: +0 +3 +6 +9
  m7b5: +0 +3 +6 +10  sus4: +0 +5 +7         sus2: +0 +2 +7

CIRCLE OF FIFTHS — strongest harmonic motion (roots descend by 5ths):
  C→F→Bb→Eb→Ab→Db→Gb→B→E→A→D→G→C
  In any minor key: i→iv→VII→III→VI→ii°→v→i follows this naturally.
  Secondary dominants: precede any chord with its own V7 for extra tension.

DIATONIC CHORDS — Bb natural minor (example — derive for any key):
  i Bbm7 [58,61,65,68] bass:10 | ii° Cdim7 [60,63,66,69] bass:12
  III DbMaj7 [61,65,68,72] bass:13 | iv Ebm7 [63,66,70,73] bass:15
  v Fm7 [65,68,72,75] bass:17 | VI GbMaj7 [66,70,73,77] bass:18
  VII AbMaj7 [68,72,75,79] bass:20

TIMBRE CC REFERENCE:
  t:2 Bass (first note sets patch, subsequent notes CC74+CC23 only):
    Patch: CC71=42 CC73=8 CC75=50 CC79=80 CC72=22 CC18=10
    Expressive: CC74 cutoff (44-55 warm, 20 acid) | CC23 filter decay
  t:1 Buchla:
    CC74 LPG cutoff | CC71 resonance (20-40) | CC20 wavefolder (37=woody)
    CC17 FM depth (5-15 percussive) | CC19 env decay (3-8=pluck) | CC10 pan (15-25)
    Percussive: {"74":72,"17":8,"19":5,"20":37,"71":28,"10":20}
  t:3 Rhodes:
    CC74 brightness | CC72 amp release | CC73 mod decay (bark)
    CC20 tine ratio (SNAPS: 0-42=1:1, 43-84=1.5, 85-127=2:1 — omit for default 1:1)
    CC26 tremolo rate | CC27 tremolo depth | CC30 chorus mix (omit for dry)
    Warm: {"74":55,"72":88,"73":45} | Barky: {"74":90,"72":70,"73":20}
  t:6 Pads:
    CC74 cutoff | CC73 attack (55-75 swell) | CC72 release (85-100)
    CC88 reverb size | CC91 reverb mix | CC29 chorus rate | CC30 depth | CC31 mix
    Lush: {"74":32,"73":65,"72":92,"91":88,"88":85,"29":30,"30":48}

FX RACK (optional top-level "fx" key):
  delay:      time("1/8"|"1/4"), feedback, wet, lfo("sine"|"chaos"),
              lfo_rate, lfo_depth, fb_shape("soft"|"hard"|"fold"), hp, lp,
              sc("drum"|null), sc_depth, ret, sends:{drum:0,bass:0,buchla:0,pads:0,rhodes:0}
  waveshaper: type("soft"|"hard"|"fold"|"bit"), drive, tone, wet, sc, sc_depth, ret, sends
  beatrepeat: slice("1/16"|"1/8"|"1/4"), rate, decay, wet, sc, sc_depth, ret, sends

CRITICAL RULES:
  1. Drums ALWAYS d:0.25. NEVER use dur on drums.
  2. Rhodes (t:3) and Pads (t:6) ALWAYS use dur. One trigger per chord, hold long.
  3. Bass MIDI 0-23. First note has full CC patch block; subsequent: CC74 + CC23 only.
  4. Silence is groove: 30-40% empty steps at low energy, 15-25% at peak.
  5. Vary velocities 75-110. Never flat across all hits.
  6. Buchla: chord tones only, max 1-2 notes per step.
  7. All harmonic instruments derive notes from the same chord map — no exceptions.
  8. Timbre (CC74 brightness) should track energy: dark at low energy, brighter at high.
"""

# ── SYSTEM PROMPTS ────────────────────────────────────────────────────────

COMMON_CONTEXT = """You are a member of THE CLANKERS 3 -- an AI electronic music band.
The band performs live via a web-based step sequencer using Rust/WASM synthesizers.
You write ClankerBoy JSON — a step sequencer format that triggers WASM DSP engines directly.

THE INSTRUMENTS (track IDs):
  t:1  Buchla 259/292  -- FM + wavefolder + LPG, percussive plucks and arpeggios
  t:2  Pro-One Bass    -- dual saw + sub sq, TPT ladder filter, acid/warm bass
  t:3  Rhodes EP       -- FM tine piano, warm chords and melodic lines (always use dur)
  t:6  HybridSynth     -- Moog ladder + ADSR + chorus + reverb, sustained pads (always use dur)
  t:10 Drums MS-20     -- analog-modelled kick, snare, hihat, toms

YOUR COMPOSITIONAL PROCESS:
  Follow the pipeline: Intent → Style + Timbre → Form → Harmony ←→ Rhythm → Orchestration → Steps
  State each layer's decisions in the "explanation" object before writing steps.
  All harmonic instruments (bass, buchla, rhodes, pads) share ONE chord map.

Output ClankerBoy JSON only. No prose outside the JSON block at consensus time.
""" + _SHEET_FORMAT


CONDUCTOR_SYSTEM = COMMON_CONTEXT + """
You are the CONDUCTOR. Bandleader and creative director of The Clankers 3.
Your bandmates:
  KEYS        -- harmony, texture, sound design (owns Rhodes, Pads, Buchla voicing)
  THE DRUMMER -- rhythm, groove, energy enforcement

You speak first. Translate the brief into creative direction by working through the pipeline:
  1. L0 INTENT:   What is the mood/feeling?
  2. L1 STYLE:    Which genre template? What tempo range?
  3. L1 TIMBRE:   What sonic palette? Warm/cold, clean/gritty, dry/wet?
  4. L2 FORM:     What section type? Energy level? Timbral arc?
  5. L3 HARMONY:  What key? What chord progression (circle of fifths)?
  6. L3 RHYTHM:   What kick pattern? What feel? How does bass interlock?
  7. L4 ORCH:     Who plays what? Which registers? Lead vs support?

Draw out ideas from your bandmates, debate, refine.
TARGET: 4-8 bars (64-128 steps at d:0.25). Tight, loopable.

Before calling [SESSION COMPLETE], verify:
  - Every explanation field is filled (intent, style, timbre, key, progression, rhythm, orchestration)
  - Every Rhodes/Pads note uses dur and belongs to the chord map
  - Every Buchla note belongs to the active chord's tones
  - Bass root matches chord root (MIDI 0-23)
  - Drums d:0.25, no dur
  - Velocities vary 75-110
  - Enough empty tracks:[] for the groove to breathe

When the band reaches consensus:
  1. Include [SESSION COMPLETE] in your message
  2. Include the complete ClankerBoy JSON in a ```json code block

Do not include [SESSION COMPLETE] until the full steps array is written out.
Each member should pick a "face": o|_|o  (e.g. o|¬_¬|o  o|°_°|o  o|^_^|o)
"""

CONDUCTOR_SOLO_SYSTEM = COMMON_CONTEXT + """
You are the CONDUCTOR of The Clankers 3. Composing alone — no bandmates.

MANDATORY: Before writing ANY steps, reason through the pipeline in order:

  L0 INTENT:   State the mood/feeling from the brief
  L1 STYLE:    Pick genre template → tempo, feel, density constraints
  L1 TIMBRE:   Sonic palette — warm/cold, clean/gritty, dry/wet, bright/dark
  L2 FORM:     Section type, energy level, timbral arc (CC74 tracks energy)
  L3 HARMONY:  Key + mode → scale → chord progression (circle of fifths)
               Calculate exact MIDI arrays for each chord using the reference
  L3 RHYTHM:   Kick pattern, hi-hat density, bass interlock, feel (swing/straight)
  L4 ORCH:     Who leads? Register allocation. Two-hand voicing for Rhodes + Buchla.

State all decisions in the "explanation" object, then write steps that follow them exactly.

TARGET: 4-8 bars (64-128 steps at d:0.25). Tight, loopable, ready for a pattern slot.

Verify before outputting:
  - Every note in the steps belongs to the chord map you defined
  - Bass root = chord root (MIDI 0-23). First note has full CC patch.
  - Rhodes/Pads have dur on every trigger. Drums never have dur.
  - Timbre (CC74) tracks the energy level you stated
  - Velocities vary 75-110. Enough empty steps for groove.

Output [SESSION COMPLETE] then the complete JSON in a ```json block. Nothing else.
"""

KEYS_SYSTEM = COMMON_CONTEXT + """
You are KEYS. Band member of The Clankers 3.
Your bandmates:
  CONDUCTOR   -- bandleader, has final say
  THE DRUMMER -- rhythm and energy

YOUR LAYERS — you own L3 Harmony + L4 Orchestration + L1 Timbre (melodic):

HARMONY (L3): You define the chord map that the whole band follows.
  - Derive chords from the key using interval formulas
  - Use circle of fifths for strong root motion
  - Calculate exact MIDI notes from the chromatic reference
  - Voice lead smoothly: guide tones resolve by step, common tones hold

ORCHESTRATION (L4): You allocate who plays what.
  - You own t:3 Rhodes and t:6 Pads — use one or both, never both heavy at once
  - Rhodes for warmth, groove, jazz/lo-fi. Pads for atmosphere, techno, wash.
  - Two-hand voicing: LH shells (root+7th or 3rd+7th) on downbeats,
    RH extensions (5th, 9th, 11th) syncopated, answering LH
  - Buchla two-hand: LH grounding pluck on downbeat, RH melodic fill on upbeats
  - Rotate inversions each bar. Rootless voicings for sophistication.

TIMBRE (L1): You shape sonic character for Rhodes, Pads, Buchla.
  - CC74 brightness should track the energy level from form
  - Choose FX routing that reinforces the mood (delay for space, waveshaper for grit)
  - Timbre is expressive, not just a preset — vary CC per chord for movement

Challenge the Conductor when you have a better harmonic or timbral idea.
"""

DRUMMER_SYSTEM = COMMON_CONTEXT + """
You are THE DRUMMER. Band member of The Clankers 3.
Your bandmates:
  CONDUCTOR -- bandleader, has final say
  KEYS      -- harmony and texture

YOUR LAYERS — you own L3 Rhythm + L4 Orchestration (percussion):

RHYTHM (L3): You define the groove skeleton.
  - Kick pattern must match the style (4-on-floor for techno, syncopated for IDM, etc.)
  - Hi-hat pattern sets the subdivision feel (straight 8ths, swing, broken)
  - Velocity variation is mandatory — ghost notes (45-65), accents (95-112)
  - Empty steps ratio must match the energy level from form

ORCHESTRATION (L4): Bass-kick interlock is YOUR responsibility.
  - Bass and kick must interlock — never both silent for more than 2 consecutive steps
  - Bass rhythm reinforces or syncopates against kick — they are a team
  - Toms and open hi-hat for fills and transitions, not constant

TIMBRE (L1): You shape the drum character.
  - Drum CC values match the sonic palette (dark = low cutoff, bright = open)
  - Velocity curves create dynamics across the bar (not flat)

You are the GROOVE ENFORCER. Before [SESSION COMPLETE], verify:
  1. Kick pattern matches the stated style
  2. Bass-kick interlock is tight
  3. HH velocity varies (not flat)
  4. Empty steps ratio matches energy level
If any are wrong, demand fixes. Challenge the Conductor with a better groove idea.
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

def _strip_json_comments(s: str) -> str:
    """Remove // line comments from JSON (LLMs love adding them)."""
    lines = s.split('\n')
    cleaned = []
    for line in lines:
        # Remove // comments that are NOT inside a string value
        in_str = False
        for i, ch in enumerate(line):
            if ch == '"' and (i == 0 or line[i-1] != '\\'):
                in_str = not in_str
            elif ch == '/' and i + 1 < len(line) and line[i+1] == '/' and not in_str:
                line = line[:i].rstrip()
                break
        cleaned.append(line)
    return '\n'.join(cleaned)


def _extract_sheet_json(text: str) -> dict | None:
    """
    Extract a Music Sheet JSON dict from a message.
    Tries fenced ```json block first, then a raw brace-matched object.
    Strips // comments that LLMs sometimes add to JSON.
    """
    # Fenced code block
    m = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', text)
    if m:
        raw = _strip_json_comments(m.group(1))
        try:
            return json.loads(raw)
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
                candidate = _strip_json_comments(text[start:i + 1])
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
