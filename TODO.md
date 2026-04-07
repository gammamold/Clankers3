# Clankers3 Web — TODO

---

## Backend (`api/`)

- [ ] **Add `/api/llm` proxy route** — `LLMWizard.js` POSTs here for Claude patch generation but the endpoint doesn't exist in `main.py`. Without it, the Synth Lab wizard is broken.
- [ ] **Session persistence** — sessions are currently an in-memory dict; they vanish on server restart. Add SQLite or a simple file-based store.
- [ ] **Authentication** — no auth on any endpoint. Anyone with the URL can read/write sessions.
- [ ] **`/session/load` endpoint** — defined in WEBPLAN but not implemented; needed to reload a saved composition.
- [ ] **Sheet diff on `/chat` response** — the backend returns a full updated sheet; the frontend should diff it and only push changed params to worklets instead of reloading everything.

---

## DSP / WASM (`clankers_dsp/`)

- [ ] **Voder (formant synth) in WASM** — still Python-only. Port `agents/voder/` DSP to Rust so it can run in the browser.
- [ ] **Granular / Clouds sampler** — referenced in WEBPLAN (HybridSynth), not implemented in Rust or the browser.
- [ ] **Rhodes worklet registration** — confirm the rhodes worklet is registered and routed in `sequencer.js` (t:3 track type).
- [ ] **Rebuild WASM** — run `wasm-pack build --release --target web` in `clankers_dsp/` and commit updated `web/wasm/` binaries whenever Rust source changes.

---

## Sequencer (`web/sequencer.js`)

- [ ] **Swing** — grid is straight 16th notes; no swing offset implemented.
- [ ] **Portamento / slide** — bass SH-101 slide flag in sheet not wired to worklet.
- [ ] **Accent** — velocity boost for accented steps not propagated to worklets.
- [ ] **Loop point control** — currently loops the full sheet; no way to set a shorter loop region.
- [ ] **STOP cleans up** — verify that stopping also silences any held notes in all worklets.

---

## Synth Lab (`web/synth-lab.js`, `web/synth/`)

- [ ] **`/api/llm` backend needed** — see Backend section above. LLMWizard currently calls it directly.
- [ ] **Preset save to server** — patches only persist to `localStorage`. No server-side save/load.
- [ ] **Arpeggiator** — not implemented in `SynthVoice.js`.
- [ ] **Full MIDI learn** — `PianoKeys.js` has partial MIDI support; no full MIDI CC learn for knobs.
- [ ] **Patch browser UI** — no way to browse/search saved presets; just 5 numbered slots.
- [ ] **Polyphony mode** — `SynthVoice` is monophonic per slot; no chord support.

---

## Mobile / Touch (`web/index.html`)

- [ ] **Synth Lab screen mobile layout** — not covered in the mobile branch; `#screen-synth-lab` has no `@media` rules.
- [ ] **Mixer screen mobile layout** — horizontal scroll added but the channel strips may still be too small to use on phone.
- [ ] **Piano roll touch edit** — `touchend` proxies `_onClick` but dragging notes (resize/move) is not touch-aware.
- [ ] **Keyboard (piano keys) on mobile** — keys are too narrow for finger tapping on small screens.
- [ ] **Landscape mode** — no layout adjustments for landscape phone orientation.
- [ ] **Delete old mobile remote branch** — `origin/claude/plan-mobile-optimization-58Hwj` is now merged and stale.

---

## UI / UX

- [ ] **Step visualizer** — the playhead/step highlight during playback; exists in HTML but wiring to sequencer tick is unclear.
- [ ] **LLM config overlay accessible on all screens** — `#btn-settings` is fixed-position but may be hidden on some screens.
- [ ] **Keyboard shortcut help** — no overlay or tooltip listing shortcuts (Space = play/stop, etc.).
- [ ] **Error states** — no user-facing feedback when API is unreachable or WASM fails to load.
- [ ] **Loading indicator** — no spinner or progress while WASM initialises or session is being created.

---

## Infrastructure / Deployment

- [ ] **Update `WEBPLAN.md`** — still says `Status: Planning — no implementation yet`. Rewrite to reflect current architecture.
- [ ] **Vercel deployment** — `vercel.json` exists but environment variables (API keys, backend URL) are not documented. FastAPI needs separate hosting (Render, Railway, Fly.io, etc.).
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
- [ ] **Create `web/synth/core/InstrumentAdapter.js`** — base class with `connect()`, `disconnect()`, `scheduleNote()`, `setParams()`, `stop()`, `getState()`
- [ ] **`WasmInstrumentAdapter`** — wraps `AudioWorkletNode`, forwards `scheduleNote()` as `port.postMessage({type:'trigger',...})`, handles worklet ready handshake
- [ ] **`WebAudioInstrumentAdapter`** — wraps `SynthVoice` + `JSONBridge`, forwards `scheduleNote()` via setTimeout scheduling
- [ ] **`SynthVoice.js` minor** — ensure clean `connect()`/`disconnect()` lifecycle

### Phase 2 — `InstrumentRegistry`
- [ ] **Create `web/synth/core/InstrumentRegistry.js`** — catalog with `register()`, `unregister()`, `get()`, `list(role?)`, `save()`/`restore()` to localStorage
- [ ] Register 5 built-in WASM instruments at startup with `builtIn: true`
- [ ] Modify SynthLab forge to auto-register created patches in the registry
- [ ] Persist custom instruments to `localStorage['clankers_instrument_library']`

### Phase 3 — Slot manager + sequencer unification
- [ ] **Refactor `web/synth-lab.js`** — slots hold `InstrumentAdapter` instances; add `plug(slotIndex, id)`, `unplug(slotIndex)`, `swap(slotIndex, id)`
- [ ] **Refactor `web/sequencer.js`** — replace dual dispatch (`_ports` + `synthLab.scheduleNote`) with single `_sendTrigger()` through slot adapters; remove `synthOverrides` mechanism
- [ ] **Modify `web/render.js`** — use adapter `connect(offlineCtx)` for offline rendering with custom instruments

### Phase 4 — Library UI
- [ ] Slot cards showing current instrument with swap/unplug buttons
- [ ] Library browser panel, filterable by role (bass / lead / pad / keys / drums)
- [ ] LLM wizard output auto-registered in library
- [ ] Slot assignments persist to localStorage across reloads

---

## Testing

- [ ] **E2E test: full session flow** — start FastAPI → `POST /session/new` with brief → load returned sheet into sequencer → play → verify audio.
- [ ] **Unit tests for DSP** — Rust unit tests for each synth engine (kick, snare, bass FM, etc.).
- [ ] **API integration tests** — `pytest` tests for all FastAPI routes with a real in-memory session.
- [ ] **Sequencer timing test** — verify lookahead scheduler fires notes within ±2ms.
