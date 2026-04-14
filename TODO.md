# Clankers3 Web — TODO

---

## Vercel / LLM API (`api/`)

- [x] **Add `/api/llm` proxy route** — Vercel serverless function proxying to Anthropic (and OpenAI) API. Synth Lab wizard works on Vercel. (`api/llm.js`)
- [x] **Band chat as Vercel serverless functions** — `api/band/session-new.js`, `api/band/chat.js`, `api/band/sheet-evolve.js`; stateless design (client owns the sheet).
- [x] **Multi-provider support** — Anthropic and OpenAI supported in all LLM calls; provider auto-detected from model name or explicit field.
- [x] **Settings overlay uses sessionStorage** — API key/model/provider stored client-side; no Python backend required for config. Key verified against `/api/llm` proxy on save.
- [x] **COEP/COOP headers in `vercel.json`** — `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` added for SharedArrayBuffer / WASM audio worklet support.
- [x] **Remove hardcoded `localhost:8000`** — frontend API URL now reads `window.BAND_API_URL || ''`; band requests go to `/api/band/*`.
- [x] **Google / Gemini provider** — `api/llm.js:80-125` implements `proxyGoogle()` converting Anthropic-style body to Gemini `generateContent`; routed at `api/llm.js:131`.
- [ ] **Authentication** — no auth on any endpoint. Anyone with the URL can call the band functions (though they need their own API key in the request body).
- [ ] **Session persistence** — `api/band/*.js` are fully stateless; no server-side session history. History is sent by the client (last 4 turns). Long sessions lose older context.

---

## DSP / WASM (`clankers_dsp/`)

- [x] **Voder (formant synth) in WASM** — `clankers_dsp/src/voder.rs` (478 lines) ports the formant synth to Rust with 25 phonemes, parallel resonators, and vibrato; exported via WASM worklet; test page at `web/voder-test.html`.
- [ ] **Granular / Clouds sampler** — referenced in WEBPLAN (HybridSynth), not implemented in Rust or the browser.
- [x] **Rhodes worklet registration** — confirm the rhodes worklet is registered and routed in `sequencer.js` (t:3 track type).
- [ ] **Rebuild WASM** — run `wasm-pack build --release --target web` in `clankers_dsp/` and commit updated `web/wasm/` binaries whenever Rust source changes.

---

## Sequencer (`web/sequencer.js`)

- [x] **Swing** — grid is straight 16th notes; no swing offset implemented.
- [x] **Portamento / slide** — `track.s` slide flag compiled into events (`web/sequencer.js:367,388`), forwarded as `slideSamples` through `WasmInstrumentAdapter` (`web/synth/core/InstrumentAdapter.js`); bass worklet routes to new `ClankersBass::trigger_slide` which glides pitch on the previously-sounding voice (`clankers_dsp/src/bass.rs` `slide_to`, `trigger_slide`), preserving phases/envelopes for TB-303/SH-101 legato.
- [x] **Accent** — `track.a` boosts velocity ×1.3 (clamped) through `_sendTrigger` to every worklet, and additionally boosts CC74 cutoff +20 for bass/buchla at compile time (`web/sequencer.js:366-400`) for authentic acid character.
- [x] **Loop point control** — currently loops the full sheet; no way to set a shorter loop region.
- [x] **STOP cleans up** — verify that stopping also silences any held notes in all worklets.

---

## Synth Lab (`web/synth-lab.js`, `web/synth/`)

- [x] **`/api/llm` backend** — Vercel serverless function exists; LLMWizard works on Vercel.
- [ ] **Preset save to server** — patches only persist to `localStorage`. No server-side save/load.
- [ ] **Arpeggiator** — not implemented in `SynthVoice.js`.
- [ ] **Full MIDI learn** — `PianoKeys.js` has partial MIDI support; no full MIDI CC learn for knobs.
- [ ] **Patch browser UI** — no way to browse/search saved presets; just 5 numbered slots.
- [ ] **Polyphony mode** — `SynthVoice` voice pool exists (`MAX_POLY=5` in `web/synth/core/InstrumentAdapter.js:16`) but each slot is still triggered monophonically per step; no chord/multi-note dispatch.

---

## Mobile / Touch (`web/index.html`)

- [x] **Synth Lab screen mobile layout** — sidebar collapses to horizontal scrolling strip; editor fills remaining height; `@media (max-width:640px)` added.
- [x] **Keyboard (piano keys) on mobile** — keys wider (34px white / 21px black); touch events wired in `PianoKeys.js` with multi-touch + slide support; `touch-action:none` on knobs.
- [ ] **Mixer screen mobile layout** — horizontal scroll added but the channel strips may still be too small to use on phone.
- [ ] **Piano roll touch edit** — `touchend` proxies `_onClick` but dragging notes (resize/move) is not touch-aware.
- [ ] **Landscape mode** — no layout adjustments for landscape phone orientation.
- [ ] **Delete old mobile remote branch** — `origin/claude/plan-mobile-optimization-58Hwj` is now merged and stale.

---

## UI / UX

- [x] **Step visualizer** — the playhead/step highlight during playback; exists in HTML but wiring to sequencer tick is unclear.
- [x] **LLM config overlay accessible on all screens** — `#btn-settings` is fixed-position (`web/index.html:3113`) and visible on main/room/synth-lab; intentionally hidden on piano-roll (`web/index.html:3397`).
- [ ] **Keyboard shortcut help** — no overlay or tooltip listing shortcuts (Space = play/stop, etc.).
- [~] **Error states** — HTTP errors from LLM/band calls surface as chat text (`web/index.html:6122-6166`) and audio errors append "⚠ Audio error" (`web/index.html:5314-5317`); no toast/modal/visual indicator and no WASM-load error path.
- [ ] **Loading indicator** — no spinner or progress while WASM initialises or session is being created.

---

## Infrastructure / Deployment

- [ ] **Update `WEBPLAN.md`** — still says `Status: Planning — no implementation yet`. Rewrite to reflect current architecture.
- [ ] **`clankers3-web` local repo** — created at `C:\Users\gamma\clankers3-web\` but not pushed to GitHub (gh auth was not set up). Either push it or delete it.
- [ ] **Delete stale Claude branches** on GitHub:
  - `claude/improve-music-composition-w71Zv`
  - `claude/add-llm-selection-menu-Oqq2Y`
  - `claude/clankers3-setup-8Wwqw`
  - `claude/deploy-clankers-vercel-Q5ozw`
  - `claude/hay-chat-integration-bSrf2`
  - `claude/plan-mobile-optimization-58Hwj` (merged)

---

## Modular Plug/Unplug Synth Architecture

> Full plan: `.claude/plans/wobbly-wibbling-squid.md`
>
> Currently the WASM instruments and Synth Lab are two parallel systems with separate dispatch paths in the sequencer. The goal is a unified slot system where any slot can hold either type, instruments can be swapped at runtime, and custom patches live in a persistent library.

### Phase 1 — `InstrumentAdapter` abstraction
- [x] **Create `web/synth/core/InstrumentAdapter.js`** — base class with `connect()`, `disconnect()`, `scheduleNote()`, `setParams()`, `stop()`, `getState()`
- [x] **`WasmInstrumentAdapter`** — wraps `AudioWorkletNode`, forwards `scheduleNote()` as `port.postMessage({type:'trigger',...})`
- [x] **`WebAudioInstrumentAdapter`** — wraps `SynthVoice` pool + `JSONBridge`, forwards `scheduleNote()` via setTimeout scheduling; exposes `noteOn()`/`noteOff()` for piano UI
- [x] **`SynthVoice.js` minor** — lifecycle handled via adapter's `connect()`/`disconnect()` (pool build/destroy)

### Phase 2 — `InstrumentRegistry`
- [x] **Create `web/synth/core/InstrumentRegistry.js`** — catalog with `register()`, `unregister()`, `get()`, `list(role?)`, `save()`/`restore()` to localStorage
- [x] Register 5 built-in WASM instruments at startup with `builtIn: true`
- [x] Modify SynthLab `loadPatch()` to auto-register created patches in the registry
- [x] Persist custom instruments to `localStorage['clankers_instrument_library']`

### Phase 3 — Slot manager + sequencer unification
- [x] **Refactor `web/synth-lab.js`** — slots hold `WebAudioInstrumentAdapter` instances; add `plug(slotIndex, id)`, `unplug(slotIndex)`, `swap(slotIndex, id)`
- [x] **Refactor `web/sequencer.js`** — replaced dual dispatch (`_ports` + `synthLab.scheduleNote`) with single `_sendTrigger()` through `_adapters`; removed `synthOverrides` mechanism; added `setAdapter(type, adapter)` / `getAdapter(type)` / `getDefaultAdapter(type)`
- [~] **Modify `web/render.js`** — `web/render.js:194-206` instantiates a Sequencer against an OfflineAudioContext and calls `_sendTrigger()`, but only WASM worklet nodes are wired; Synth Lab `WebAudioInstrumentAdapter`s are **not** plugged in via `seq.setAdapter(...)`, so custom patches still won't render offline.

### Phase 4 — Library UI
- [x] Slot cards showing current instrument with ⇄ SWAP and ⏏ UNPLUG buttons
- [x] Library browser panel, filterable by role (bass / lead / pad / keys / drums / poly_fm)
- [x] LLM wizard output auto-registered in library via `loadPatch()`
- [x] Slot assignments persist to localStorage across reloads
- [x] **Any slot can replace WASM drums** — removed FM-drums bias from slot 4; all 5 slots now show DRUMS option in assignment dropdown; `DRUM_VOICE_TO_NOTE` maps voice IDs to pitched MIDI notes for WebAudio adapters

---

## MIDI Output (`web/midi-output.js`, `web/sequencer.js`, `web/index.html`)

> Full plan: `.claude/plans/cozy-sniffing-aho.md`
>
> Add MIDI output so each instrument can send note data to external hardware/software via the Web MIDI API, with per-instrument MIDI channel selection (1–16 or off) and a global output device picker.

- [x] **Create `web/midi-output.js`** — `MidiOutput` class: `init()`, `getOutputs()`, `setOutput(portId)`, `setChannel(instrType, ch)`, `scheduleNote(instrType, note, velocity, audioTime, ctx, durationMs)`; includes drum voiceId→MIDI-note mapping
- [x] **`web/sequencer.js`** — add `this.midiOut = null`; call `this.midiOut?.scheduleNote(...)` in `_sendTrigger` for every instrument type (drum, bass, buchla, pads, rhodes, synth0-4)
- [x] **`web/index.html` — "REACH THE OUTSIDE" panel** — fixed-position button + collapsible panel with MIDI device selector and per-instrument channel dropdowns (all 10 instruments including 5 Synth Lab slots); drums default to ch 10
- [x] **`web/index.html` — compact MIDI port selector** — added to `#seq-controls` as quick-access device picker
- [x] **`web/index.html` — per-instrument channel selectors** — `<select class="midi-ch-sel">` in each `inst-hdr`; synced bidirectionally with RTO panel selectors
- [x] **`web/index.html` — wire manual pads** — `triggerBass`, `triggerBuchla`, `triggerRhodes`, `triggerChord` also call `midiOut.scheduleNote(...)`
- [x] **`web/index.html` — `getSeq()`** — assign `seq.midiOut = midiOut` when sequencer is created

---

## Testing

---

## Song Builder & External Hardware Integration

- [x] **Song Builder button global** — moved `#btn-song-screen` from `#screen-main` to fixed-position floating button visible on main/room/synth-lab screens (matches synth-lab/reach-outside pattern)
- [x] **Pattern preview in Song Builder** — clicking arrangement grid slot selects that pattern; PREVIEW button plays selected pattern in loop mode; restores song mode on stop
- [x] **MIDI Input** — `web/midi-input.js` (`MidiInput` class); UI in Reach the Outside panel with device selector + route-to dropdown; routes NoteOn/NoteOff to current or selected instrument via existing trigger functions
- [x] **MIDI Clock output** — extended `MidiOutput` with `startClock(bpm)`/`stopClock()`/`setClockBpm(bpm)`; sends 0xFA/0xF8/0xFC; toggle in Reach the Outside panel; sequencer calls on start/stop
- [x] **CV/Gate modular sync** — `web/modular-sync.js` (`ModularSync` class); ConstantSourceNode → per-instrument GainNode gates + clock pulses via `gain.setValueAtTime()`; stereo output (L=clock, R=triggers); route via DC-coupled audio interface (Expert Sleepers, MOTU, etc.)
- [x] **CV/Gate UI** — clock enable + division selector (1/16, 1/8, 1/4, 1/1) + per-instrument gate checkboxes in Reach the Outside panel

---

## Testing

- [ ] **E2E test: Vercel band flow** — deploy to Vercel → enter API key → POST `/api/band/session-new` with brief → load sheet into sequencer → play → verify audio.
- [ ] **Unit tests for DSP** — Rust unit tests for each synth engine (kick, snare, bass FM, etc.).
- [ ] **Sequencer timing test** — verify lookahead scheduler fires notes within ±2ms.
