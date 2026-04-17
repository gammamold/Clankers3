/**
 * voder-say.js — Prosody + scheduling for the Voder.
 *
 * Takes raw English text, converts it to a timed phoneme sequence with pitch and
 * amplitude contours, then dispatches a single trigger + set_phonemes_timed pair
 * to the voder worklet.  The utterance runs as ONE held note whose internal
 * phoneme queue drives the formants.
 *
 * Usage:
 *     import { sayText } from './synth/voder-say.js';
 *     await sayText(voderNode, audioCtx, "hello world", {
 *         midiNote: 57,    // A3
 *         wpm:       180,  // speech rate
 *         ccJson:    '{}', // voder CC parameters
 *     });
 */

import { PH, VOWELS, textToPhonemes } from './voder-g2p.js';

// ── Base phoneme durations (milliseconds) ─────────────────────────────────
// Used when the phoneme class isn't further modulated by stress or position.
const BASE_DUR_MS = {
    stopClosure: 55,    // SIL before B/D/G/P/T/K bursts
    stopBurst:   35,    // B/D/G/P/T/K themselves
    vowelShort:  100,   // unstressed vowel
    vowelLong:   185,   // stressed vowel (primary)
    fricative:   110,   // F/S/SH/TH/V/Z/ZH
    nasal:        80,   // M/N/NG
    approximant:  65,   // L/R/W/Y
    aspiration:   50,   // HH
    gap:         120,   // SIL between words
    sentenceGap: 230,   // SIL after . ? !
    commaGap:    170,   // SIL after , ;
};

const STOP_BURSTS   = new Set([PH.B, PH.D, PH.G, PH.P, PH.T, PH.K]);
const FRICATIVES    = new Set([PH.F, PH.S, PH.SH, PH.TH, PH.V, PH.Z, PH.ZH]);
const NASALS        = new Set([PH.M, PH.N, PH.NG]);
const APPROXIMANTS  = new Set([PH.L, PH.R, PH.W, PH.Y]);

function classOf(ph) {
    if (VOWELS.has(ph))       return 'vowel';
    if (STOP_BURSTS.has(ph))  return 'stopBurst';
    if (FRICATIVES.has(ph))   return 'fricative';
    if (NASALS.has(ph))       return 'nasal';
    if (APPROXIMANTS.has(ph)) return 'approximant';
    if (ph === PH.HH)         return 'aspiration';
    if (ph === PH.SIL)        return 'silence';
    return 'other';
}

/**
 * Build per-phoneme arrays (phonemes, durations_samps, pitch_mults, amp_mults)
 * from the tokenised text.  Caller multiplies durations by 1/rate before send.
 */
export function buildUtterance(text, opts = {}) {
    const {
        wpm          = 180,     // target words-per-minute (scales all durations)
        stressPitch  = 1.06,    // +1 semitone on stressed vowels
        endFall      = 0.91,    // −1.6 semitone on final vowel (sentence)
        endRise      = 1.10,    // +1.6 semitone on final vowel (question)
        stressAmp    = 1.15,    // +15% amp on stressed vowels
        rateScale    = 180 / wpm,  // 1.0 at 180 wpm, slower if wpm<180
    } = opts;

    const tokens = textToPhonemes(text);

    // Flatten tokens into phoneme list with (class, stressed, isFinal?) tags.
    // Detect sentence-final punctuation to set pitch contour.
    const entries = [];
    let lastSentenceEnd = -1;   // index of last phoneme before a . ? !
    let lastPunct = '';

    for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (tok.punct) {
            // emit silence; remember punctuation type
            const dur = /[.?!]/.test(tok.word) ? BASE_DUR_MS.sentenceGap
                      : /[,;:]/.test(tok.word) ? BASE_DUR_MS.commaGap
                      : BASE_DUR_MS.gap;
            entries.push({ ph: PH.SIL, cls: 'silence', stressed: false, durMs: dur, isLastVowel: false });
            lastSentenceEnd = entries.length - 1;
            lastPunct = tok.word;
            continue;
        }

        // Inter-word gap (skip at start and when previous token was already silence)
        if (entries.length && entries[entries.length - 1].cls !== 'silence') {
            entries.push({ ph: PH.SIL, cls: 'silence', stressed: false, durMs: BASE_DUR_MS.gap / 2, isLastVowel: false });
        }

        for (let k = 0; k < tok.phonemes.length; k++) {
            const ph       = tok.phonemes[k];
            const cls      = classOf(ph);
            const stressed = (k === tok.stressIdx);
            let   durMs;
            switch (cls) {
                case 'vowel':       durMs = stressed ? BASE_DUR_MS.vowelLong : BASE_DUR_MS.vowelShort; break;
                case 'stopBurst':   durMs = BASE_DUR_MS.stopBurst; break;
                case 'fricative':   durMs = BASE_DUR_MS.fricative; break;
                case 'nasal':       durMs = BASE_DUR_MS.nasal; break;
                case 'approximant': durMs = BASE_DUR_MS.approximant; break;
                case 'aspiration':  durMs = BASE_DUR_MS.aspiration; break;
                case 'silence':     durMs = BASE_DUR_MS.stopClosure; break;
                default:            durMs = 80;
            }
            entries.push({ ph, cls, stressed, durMs, isLastVowel: false });
        }
    }

    // Mark last vowel of the utterance (or before last sentence-final punct) for
    // terminal pitch movement.
    let terminalTarget = -1;
    if (lastSentenceEnd >= 0) {
        for (let i = lastSentenceEnd - 1; i >= 0; i--) {
            if (entries[i].cls === 'vowel') { terminalTarget = i; break; }
        }
    } else {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].cls === 'vowel') { terminalTarget = i; break; }
        }
    }
    if (terminalTarget >= 0) entries[terminalTarget].isLastVowel = true;
    const isQuestion = /\?/.test(lastPunct);

    // Now assemble the four parallel arrays.
    const SR = 44100;
    const phonemes  = [];
    const durations = [];
    const pitches   = [];
    const amps      = [];

    for (const e of entries) {
        const samps = Math.max(1, Math.round(e.durMs * rateScale * 0.001 * SR));
        let pitch = 1.0;
        let amp   = 1.0;
        if (e.cls === 'vowel') {
            if (e.stressed)    pitch *= stressPitch;
            if (e.isLastVowel) pitch *= isQuestion ? endRise : endFall;
            if (e.stressed)    amp   *= stressAmp;
        }
        phonemes.push(e.ph);
        durations.push(samps);
        pitches.push(pitch);
        amps.push(amp);
    }

    const totalSamps = durations.reduce((a, b) => a + b, 0);
    return { phonemes, durations, pitches, amps, totalSamps };
}

/**
 * Schedule an utterance on the voder worklet.
 *
 * @param {AudioWorkletNode} voderNode
 * @param {BaseAudioContext} audioCtx
 * @param {string}           text
 * @param {object}           [opts]
 * @param {number} [opts.midiNote=57]  base pitch (MIDI note)
 * @param {number} [opts.velocity=0.85]
 * @param {number} [opts.wpm=180]
 * @param {string} [opts.ccJson='{}']
 * @param {number} [opts.audioTime]    when to start (default: audioCtx.currentTime + 0.02)
 * @returns {{ durationSec: number, endTime: number, phonemes: number[] }}
 */
export function sayText(voderNode, audioCtx, text, opts = {}) {
    const {
        midiNote = 57,
        velocity = 0.85,
        wpm      = 180,
        ccJson   = '{}',
        audioTime = audioCtx.currentTime + 0.02,
    } = opts;

    const u = buildUtterance(text, { wpm });
    if (u.phonemes.length === 0) return { durationSec: 0, endTime: audioTime, phonemes: [] };

    // Single atomic trigger+schedule — the worklet installs the timed queue
    // on the same voice it just triggered, avoiding a race across messages.
    voderNode.port.postMessage({
        type:        'trigger',
        audioTime,
        midiNote,
        velocity,
        holdSamples: u.totalSamps,
        ccJson,
        timed: {
            phonemes:  u.phonemes,
            durations: u.durations,
            pitches:   u.pitches,
            amps:      u.amps,
        },
    });

    const durationSec = u.totalSamps / 44100;
    return { durationSec, endTime: audioTime + durationSec, phonemes: u.phonemes };
}
