/**
 * voder-g2p.js — English text → Voder phoneme sequences.
 *
 * Pipeline:
 *   1. Exception dictionary lookup (~250 common words, CMU-derived).
 *   2. Letter-to-sound rules as fallback (vowel digraphs, silent-e, common clusters).
 *   3. Map ARPA codes → Voder phoneme indices (affricates/diphthongs expand to pairs).
 *
 * Output: array of tokens { word, phonemes, stressIdx } where
 *   phonemes  — array of Voder indices (0-33, see phonemes.js)
 *   stressIdx — index into `phonemes` of the primary-stressed vowel, or -1
 */

export const PH = {
    AA: 0,  AE: 1,  AH: 2,  AO: 3,  EH: 4,  ER: 5,  EY: 6,  IH: 7,
    IY: 8,  OW: 9,  UH: 10, UW: 11,
    L:  12, R:  13, W:  14, Y:  15, M:  16, N:  17,
    F:  18, S:  19, SH: 20, TH: 21, V:  22, Z:  23, ZH: 24,
    SIL: 25, HH: 26, NG: 27, B: 28, D: 29, G: 30, P: 31, T: 32, K: 33,
};

// Vowel phonemes (used for stress detection and duration scaling)
export const VOWELS = new Set([
    PH.AA, PH.AE, PH.AH, PH.AO, PH.EH, PH.ER, PH.EY, PH.IH,
    PH.IY, PH.OW, PH.UH, PH.UW,
]);

// ARPAbet → Voder indices. Affricates/diphthongs/phones without dedicated
// Voder entries expand to pairs so the formant bank can interpolate them.
const ARPA_TO_VODER = {
    AA: [PH.AA], AE: [PH.AE], AH: [PH.AH], AO: [PH.AO], AW: [PH.AA, PH.UH],
    AX: [PH.AH], AY: [PH.AA, PH.IY], EH: [PH.EH], ER: [PH.ER], EY: [PH.EY],
    IH: [PH.IH], IX: [PH.IH], IY: [PH.IY], OW: [PH.OW], OY: [PH.AO, PH.IY],
    UH: [PH.UH], UW: [PH.UW], UX: [PH.UW],
    B:  [PH.SIL, PH.B], D:  [PH.SIL, PH.D], G:  [PH.SIL, PH.G],
    P:  [PH.SIL, PH.P], T:  [PH.SIL, PH.T], K:  [PH.SIL, PH.K],
    CH: [PH.SIL, PH.T, PH.SH], JH: [PH.SIL, PH.D, PH.ZH],
    DH: [PH.TH], DX: [PH.D], EL: [PH.AH, PH.L], EM: [PH.AH, PH.M], EN: [PH.AH, PH.N],
    F:  [PH.F], HH: [PH.HH], H:  [PH.HH],
    L:  [PH.L], M:  [PH.M], N:  [PH.N], NG: [PH.NG],
    R:  [PH.R], S:  [PH.S], SH: [PH.SH], TH: [PH.TH],
    V:  [PH.V], W:  [PH.W], WH: [PH.W], Y:  [PH.Y], Z:  [PH.Z], ZH: [PH.ZH],
};

const ARPA_VOWELS = new Set([
    'AA','AE','AH','AO','AW','AX','AY','EH','ER','EY','IH','IX','IY','OW','OY','UH','UW','UX',
]);

/**
 * Exception dictionary — ARPAbet strings with stress markers (0/1/2 on vowels).
 * Covers the 250 most common English words and several speech-demo favorites.
 * Format: "HH AH0 L OW1" for "hello".
 */
const DICT = {
    // pronouns / determiners / conjunctions
    'I':     'AY1',
    'A':     'AH0',
    'AN':    'AE1 N',
    'THE':   'DH AH0',
    'THIS':  'DH IH1 S',
    'THAT':  'DH AE1 T',
    'THESE': 'DH IY1 Z',
    'THOSE': 'DH OW1 Z',
    'MY':    'M AY1',
    'YOUR':  'Y UH1 R',
    'HIS':   'HH IH1 Z',
    'HER':   'HH ER1',
    'ITS':   'IH1 T S',
    'OUR':   'AW1 ER0',
    'THEIR': 'DH EH1 R',
    'ME':    'M IY1',
    'YOU':   'Y UW1',
    'HE':    'HH IY1',
    'SHE':   'SH IY1',
    'IT':    'IH1 T',
    'WE':    'W IY1',
    'THEY':  'DH EY1',
    'US':    'AH1 S',
    'THEM':  'DH EH1 M',
    'AND':   'AH0 N D',
    'OR':    'AO1 R',
    'BUT':   'B AH1 T',
    'IF':    'IH1 F',
    'WHEN':  'W EH1 N',
    'WHERE': 'W EH1 R',
    'WHAT':  'W AH1 T',
    'WHO':   'HH UW1',
    'WHY':   'W AY1',
    'HOW':   'HH AW1',
    'NOT':   'N AA1 T',
    'NO':    'N OW1',
    'YES':   'Y EH1 S',
    'TO':    'T UW1',
    'OF':    'AH1 V',
    'IN':    'IH1 N',
    'ON':    'AA1 N',
    'AT':    'AE1 T',
    'AS':    'AE1 Z',
    'IS':    'IH1 Z',
    'ARE':   'AA1 R',
    'WAS':   'W AH1 Z',
    'WERE':  'W ER1',
    'BE':    'B IY1',
    'BEEN':  'B IH1 N',
    'BEING': 'B IY1 IH0 NG',
    'HAVE':  'HH AE1 V',
    'HAS':   'HH AE1 Z',
    'HAD':   'HH AE1 D',
    'DO':    'D UW1',
    'DOES':  'D AH1 Z',
    'DID':   'D IH1 D',
    'FOR':   'F AO1 R',
    'FROM':  'F R AH1 M',
    'WITH':  'W IH1 TH',
    'BY':    'B AY1',
    'SO':    'S OW1',
    'SOME':  'S AH1 M',
    'ALL':   'AO1 L',
    'CAN':   'K AE1 N',
    'WILL':  'W IH1 L',
    'WOULD': 'W UH1 D',
    'SHOULD':'SH UH1 D',
    'COULD': 'K UH1 D',
    // speech-demo staples
    'HELLO': 'HH AH0 L OW1',
    'WORLD': 'W ER1 L D',
    'GOODBYE':'G UH2 D B AY1',
    'BYE':   'B AY1',
    'OK':    'OW2 K EY1',
    'OKAY':  'OW2 K EY1',
    'YEAH':  'Y EH1',
    'SURE':  'SH UH1 R',
    'THANK': 'TH AE1 NG K',
    'THANKS':'TH AE1 NG K S',
    'PLEASE':'P L IY1 Z',
    'SORRY': 'S AA1 R IY0',
    'NAME':  'N EY1 M',
    'HI':    'HH AY1',
    'HEY':   'HH EY1',
    'COOL':  'K UW1 L',
    'NICE':  'N AY1 S',
    'GOOD':  'G UH1 D',
    'BAD':   'B AE1 D',
    'GREAT': 'G R EY1 T',
    'TIME':  'T AY1 M',
    'DAY':   'D EY1',
    'NIGHT': 'N AY1 T',
    'MAN':   'M AE1 N',
    'WOMAN': 'W UH1 M AH0 N',
    'PEOPLE':'P IY1 P AH0 L',
    'HOUSE': 'HH AW1 S',
    'THING': 'TH IH1 NG',
    'LIFE':  'L AY1 F',
    'LOVE':  'L AH1 V',
    'HOME':  'HH OW1 M',
    'WORK':  'W ER1 K',
    'PLAY':  'P L EY1',
    'STOP':  'S T AA1 P',
    'START': 'S T AA1 R T',
    'COME':  'K AH1 M',
    'GO':    'G OW1',
    'GOT':   'G AA1 T',
    'GET':   'G EH1 T',
    'MAKE':  'M EY1 K',
    'TAKE':  'T EY1 K',
    'GIVE':  'G IH1 V',
    'WANT':  'W AA1 N T',
    'NEED':  'N IY1 D',
    'KNOW':  'N OW1',
    'THINK': 'TH IH1 NG K',
    'FEEL':  'F IY1 L',
    'SEE':   'S IY1',
    'LOOK':  'L UH1 K',
    'HEAR':  'HH IY1 R',
    'TRY':   'T R AY1',
    'HELP':  'HH EH1 L P',
    'MUSIC': 'M Y UW1 Z IH0 K',
    'SOUND': 'S AW1 N D',
    'VOICE': 'V OY1 S',
    'SPEAK': 'S P IY1 K',
    'SAY':   'S EY1',
    'TALK':  'T AO1 K',
    'WORD':  'W ER1 D',
    'WORDS': 'W ER1 D Z',
    'SONG':  'S AO1 NG',
    'MACHINE':'M AH0 SH IY1 N',
    'ROBOT': 'R OW1 B AA0 T',
    'COMPUTER':'K AH0 M P Y UW1 T ER0',
    'VODER': 'V OW1 D ER0',
    'CLANKER':'K L AE1 NG K ER0',
    'CLANKERS':'K L AE1 NG K ER0 Z',
    'SYNTH': 'S IH1 N TH',
    'FORMANT':'F AO1 R M AH0 N T',
    'ONE':   'W AH1 N',
    'TWO':   'T UW1',
    'THREE': 'TH R IY1',
    'FOUR':  'F AO1 R',
    'FIVE':  'F AY1 V',
    'SIX':   'S IH1 K S',
    'SEVEN': 'S EH1 V AH0 N',
    'EIGHT': 'EY1 T',
    'NINE':  'N AY1 N',
    'TEN':   'T EH1 N',
    'ZERO':  'Z IY1 R OW0',
    // common function words
    'ABOUT': 'AH0 B AW1 T',
    'AFTER': 'AE1 F T ER0',
    'AGAIN': 'AH0 G EH1 N',
    'BEFORE':'B IH0 F AO1 R',
    'EVERY': 'EH1 V R IY0',
    'ANOTHER':'AH0 N AH1 DH ER0',
    'BECAUSE':'B IH0 K AH1 Z',
    'WELL':  'W EH1 L',
    'VERY':  'V EH1 R IY0',
    'JUST':  'JH AH1 S T',
    'ONLY':  'OW1 N L IY0',
    'EVEN':  'IY1 V AH0 N',
    'ALSO':  'AO1 L S OW0',
    'MORE':  'M AO1 R',
    'MOST':  'M OW1 S T',
    'OTHER': 'AH1 DH ER0',
    'NEW':   'N UW1',
    'OLD':   'OW1 L D',
    'FIRST': 'F ER1 S T',
    'LAST':  'L AE1 S T',
    'NEXT':  'N EH1 K S T',
    'NOW':   'N AW1',
    'HERE':  'HH IY1 R',
    'THERE': 'DH EH1 R',
    'SAID':  'S EH1 D',
    'SAYS':  'S EH1 Z',
    'TELL':  'T EH1 L',
    'MAY':   'M EY1',
    'MIGHT': 'M AY1 T',
    'MUST':  'M AH1 S T',
    'LIKE':  'L AY1 K',
    'ONCE':  'W AH1 N S',
    'TWICE': 'T W AY1 S',
    'NEVER': 'N EH1 V ER0',
    'ALWAYS':'AO1 L W EY0 Z',
    'OVER':  'OW1 V ER0',
    'UNDER': 'AH1 N D ER0',
    'INTO':  'IH1 N T UW0',
    'AWAY':  'AH0 W EY1',
    'THROUGH':'TH R UW1',
    'BETWEEN':'B IH0 T W IY1 N',
    'WITHOUT':'W IH0 DH AW1 T',
    'EARTH': 'ER1 TH',
    'WATER': 'W AO1 T ER0',
    'FIRE':  'F AY1 ER0',
    'AIR':   'EH1 R',
    'SKY':   'S K AY1',
    'MOON':  'M UW1 N',
    'SUN':   'S AH1 N',
    'STAR':  'S T AA1 R',
    'OPEN':  'OW1 P AH0 N',
    'CLOSE': 'K L OW1 Z',
    'BIG':   'B IH1 G',
    'SMALL': 'S M AO1 L',
    'LONG':  'L AO1 NG',
    'SHORT': 'SH AO1 R T',
    'FAST':  'F AE1 S T',
    'SLOW':  'S L OW1',
    'LOUD':  'L AW1 D',
    'QUIET': 'K W AY1 AH0 T',
    'HIGH':  'HH AY1',
    'LOW':   'L OW1',
    'HOT':   'HH AA1 T',
    'COLD':  'K OW1 L D',
    'TRUE':  'T R UW1',
    'FALSE': 'F AO1 L S',
    'LEFT':  'L EH1 F T',
    'RIGHT': 'R AY1 T',
    'UP':    'AH1 P',
    'DOWN':  'D AW1 N',
    'WALK':  'W AO1 K',
    'RUN':   'R AH1 N',
    'SIT':   'S IH1 T',
    'STAND': 'S T AE1 N D',
    'SING':  'S IH1 NG',
    'DANCE': 'D AE1 N S',
    'READ':  'R IY1 D',
    'WRITE': 'R AY1 T',
    'CODE':  'K OW1 D',
    'TEST':  'T EH1 S T',
    'DREAM': 'D R IY1 M',
    'DATA':  'D EY1 T AH0',
    'ALPHA': 'AE1 L F AH0',
    'BETA':  'B EY1 T AH0',
    'DELTA': 'D EH1 L T AH0',
    'OMEGA': 'OW0 M EY1 G AH0',
};

/**
 * Letter-to-sound fallback for unknown words.
 * Returns an ARPA string (space-separated, with stress=1 on first vowel).
 */
function letterToSound(word) {
    const w = word.toUpperCase();
    const out = [];
    let i = 0;

    // Handle silent-e at end: "SAVE" → not "S AE V EH"
    const silentE = w.length >= 3
        && w.endsWith('E')
        && !'AEIOU'.includes(w[w.length - 2]);
    const core = silentE ? w.slice(0, -1) : w;

    while (i < core.length) {
        const c  = core[i];
        const c2 = core.slice(i, i + 2);
        const c3 = core.slice(i, i + 3);

        // Digraphs / trigraphs
        if (c3 === 'TCH')           { out.push('CH'); i += 3; continue; }
        if (c3 === 'IGH')           { out.push('AY1'); i += 3; continue; }
        if (c3 === 'EIGH')          { out.push('EY1'); i += 3; continue; }
        if (c2 === 'CH')            { out.push('CH'); i += 2; continue; }
        if (c2 === 'SH')            { out.push('SH'); i += 2; continue; }
        if (c2 === 'TH')            { out.push('TH'); i += 2; continue; }
        if (c2 === 'PH')            { out.push('F'); i += 2; continue; }
        if (c2 === 'WH')            { out.push('W'); i += 2; continue; }
        if (c2 === 'NG')            { out.push('NG'); i += 2; continue; }
        if (c2 === 'CK')            { out.push('K'); i += 2; continue; }
        if (c2 === 'QU')            { out.push('K'); out.push('W'); i += 2; continue; }
        if (c2 === 'OO')            { out.push('UW1'); i += 2; continue; }
        if (c2 === 'EE')            { out.push('IY1'); i += 2; continue; }
        if (c2 === 'EA')            { out.push('IY1'); i += 2; continue; }
        if (c2 === 'AI' || c2 === 'AY') { out.push('EY1'); i += 2; continue; }
        if (c2 === 'OA' || c2 === 'OW') { out.push('OW1'); i += 2; continue; }
        if (c2 === 'OU' || c2 === 'OW') { out.push('AW1'); i += 2; continue; }
        if (c2 === 'OI' || c2 === 'OY') { out.push('OY1'); i += 2; continue; }
        if (c2 === 'AU' || c2 === 'AW') { out.push('AO1'); i += 2; continue; }
        if (c2 === 'AR')            { out.push('AA1'); out.push('R'); i += 2; continue; }
        if (c2 === 'ER' || c2 === 'IR' || c2 === 'UR') {
                                      out.push('ER1'); i += 2; continue; }
        if (c2 === 'OR')            { out.push('AO1'); out.push('R'); i += 2; continue; }

        // Single letters
        switch (c) {
            case 'A': out.push(silentE && i === core.length - 1 ? 'EY1' : 'AE1'); break;
            case 'B': out.push('B'); break;
            case 'C':
                // soft C before E/I/Y → S, else K
                out.push('EIY'.includes(core[i + 1]) ? 'S' : 'K');
                break;
            case 'D': out.push('D'); break;
            case 'E': out.push(silentE && i === core.length - 1 ? 'IY1' : 'EH1'); break;
            case 'F': out.push('F'); break;
            case 'G':
                out.push('EIY'.includes(core[i + 1]) ? 'JH' : 'G');
                break;
            case 'H': out.push('HH'); break;
            case 'I': out.push(silentE && i === core.length - 1 ? 'AY1' : 'IH1'); break;
            case 'J': out.push('JH'); break;
            case 'K': out.push('K'); break;
            case 'L': out.push('L'); break;
            case 'M': out.push('M'); break;
            case 'N': out.push('N'); break;
            case 'O': out.push(silentE && i === core.length - 1 ? 'OW1' : 'AA1'); break;
            case 'P': out.push('P'); break;
            case 'Q': out.push('K'); break;
            case 'R': out.push('R'); break;
            case 'S': out.push('S'); break;
            case 'T': out.push('T'); break;
            case 'U': out.push(silentE && i === core.length - 1 ? 'UW1' : 'AH1'); break;
            case 'V': out.push('V'); break;
            case 'W': out.push('W'); break;
            case 'X': out.push('K'); out.push('S'); break;
            case 'Y':
                // vowel at end, consonant at start
                out.push(i === 0 ? 'Y' : (i === core.length - 1 ? 'IY1' : 'IH1'));
                break;
            case 'Z': out.push('Z'); break;
            default: break; // skip punctuation inside tokens
        }
        i += 1;
    }

    // Apply silent-E to previous vowel: "MAKE" → MEY K
    if (silentE) {
        for (let j = out.length - 1; j >= 0; j--) {
            const tok = out[j].replace(/[012]$/, '');
            if (ARPA_VOWELS.has(tok)) {
                if (tok === 'AE') out[j] = 'EY1';
                else if (tok === 'EH') out[j] = 'IY1';
                else if (tok === 'IH') out[j] = 'AY1';
                else if (tok === 'AA') out[j] = 'OW1';
                else if (tok === 'AH') out[j] = 'UW1';
                break;
            }
        }
    }

    // Force exactly one stressed vowel: the first vowel gets stress 1, others 0.
    let stressed = false;
    for (let j = 0; j < out.length; j++) {
        const bare = out[j].replace(/[012]$/, '');
        if (ARPA_VOWELS.has(bare)) {
            out[j] = bare + (stressed ? '0' : '1');
            stressed = true;
        }
    }

    return out.join(' ');
}

/**
 * Convert one ARPA word string → { phonemes, stressIdx }.
 */
function arpaToVoder(arpa) {
    const tokens = arpa.trim().split(/\s+/).filter(Boolean);
    const phonemes = [];
    let stressIdx = -1;

    for (const tok of tokens) {
        const m = tok.match(/^([A-Z]+)([012])?$/);
        if (!m) continue;
        const bare   = m[1];
        const stress = m[2] ? parseInt(m[2], 10) : -1;
        const seq    = ARPA_TO_VODER[bare];
        if (!seq) continue;

        // Stressed vowel index points to the FIRST vowel element of the expansion
        if (stress === 1 && stressIdx < 0) {
            for (let k = 0; k < seq.length; k++) {
                if (VOWELS.has(seq[k])) { stressIdx = phonemes.length + k; break; }
            }
        }
        phonemes.push(...seq);
    }

    // Fallback: if no stress marker was present, stress the first vowel we see.
    if (stressIdx < 0) {
        for (let i = 0; i < phonemes.length; i++) {
            if (VOWELS.has(phonemes[i])) { stressIdx = i; break; }
        }
    }

    return { phonemes, stressIdx };
}

/**
 * Main entry: text → array of { word, phonemes: number[], stressIdx: number }.
 * Punctuation is not emitted as phonemes but is retained in `word` so the
 * prosody layer can detect sentence-final falls.
 */
export function textToPhonemes(text) {
    const tokens = text.toUpperCase().match(/[A-Z']+|[.?!,;:]/g) ?? [];
    const out = [];
    for (const tok of tokens) {
        if (/[.?!,;:]/.test(tok)) {
            out.push({ word: tok, phonemes: [], stressIdx: -1, punct: true });
            continue;
        }
        const stripped = tok.replace(/'/g, '');   // drop apostrophes
        const arpa = DICT[tok] ?? DICT[stripped] ?? letterToSound(stripped);
        const { phonemes, stressIdx } = arpaToVoder(arpa);
        out.push({ word: tok, phonemes, stressIdx, punct: false });
    }
    return out;
}
