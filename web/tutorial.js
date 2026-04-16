// tutorial.js — Interactive tutorial engine for Clankers 3.
// Phase A: engine + first 6 steps (welcome → chat → send).
// Communicates with index.html's module-scoped state via window._tutorialBridge.

// ────────────────────────────────────────────────────────────────────────────
// CSS — injected into <head> at init
// ────────────────────────────────────────────────────────────────────────────
const TUT_CSS = `
#btn-tutorial {
  position: fixed;
  bottom: 1.5rem;
  left: 4.5rem;
  z-index: 550;
  background: #00121a;
  border: 1px solid #004060;
  color: #00d4ff;
  font-family: monospace;
  font-size: .65rem;
  padding: .3rem .55rem;
  cursor: pointer;
  border-radius: 3px;
  opacity: .7;
  letter-spacing: .08em;
}
#btn-tutorial:hover {
  opacity: 1;
  border-color: #00d4ff;
}

#tut-spotlight {
  position: fixed;
  inset: 0;
  z-index: 700;
  pointer-events: none;
  background: transparent;
  display: none;
}
#tut-spotlight.on {
  display: block;
}
#tut-spotlight::before {
  content: '';
  position: absolute;
  left: var(--sx, 50%);
  top: var(--sy, 50%);
  width: var(--sw, 0px);
  height: var(--sh, 0px);
  border-radius: 4px;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.78);
  transition: left .2s ease, top .2s ease, width .2s ease, height .2s ease;
}
#tut-spotlight.no-target::before {
  left: 0; top: 0; width: 100vw; height: 100vh;
  border-radius: 0;
  box-shadow: none;
  background: rgba(0, 0, 0, 0.5);
}

#tut-panel {
  position: fixed;
  z-index: 710;
  width: 300px;
  background: #0a0f14;
  border: 1px solid #00d4ff;
  border-radius: 5px;
  padding: 1rem;
  font-family: monospace;
  color: #ccc;
  box-shadow: 0 0 20px rgba(0, 212, 255, 0.15);
  pointer-events: all;
  transition: top .2s ease, left .2s ease;
  display: none;
  box-sizing: border-box;
}
#tut-panel.on { display: block; }

.tut-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: .4rem;
  gap: .5rem;
}
.tut-top-right {
  display: inline-flex;
  align-items: baseline;
  gap: .5rem;
}
.tut-chapter {
  font-size: .6rem;
  letter-spacing: .15em;
  color: #00d4ff;
}
.tut-progress {
  font-size: .62rem;
  color: #444;
}
.tut-lang {
  font-size: .58rem;
  color: #333;
  letter-spacing: .05em;
}
.tut-lang-btn {
  background: none;
  border: none;
  padding: 0 .15rem;
  font-family: monospace;
  font-size: .6rem;
  color: #555;
  cursor: pointer;
  letter-spacing: .08em;
}
.tut-lang-btn:hover { color: #888; }
.tut-lang-btn.tut-lang-active {
  color: #00d4ff;
  text-decoration: underline;
}
.tut-lang-sep { color: #2a2a2a; }
.tut-title {
  font-size: .95rem;
  color: #00d4ff;
  letter-spacing: .1em;
  margin-bottom: .6rem;
}
.tut-body {
  font-size: .78rem;
  line-height: 1.5;
  color: #aaa;
  margin-bottom: .6rem;
}
.tut-hint {
  font-size: .7rem;
  color: #5a8;
  font-style: italic;
  margin-bottom: .8rem;
}
.tut-footer {
  display: flex;
  gap: .4rem;
  justify-content: flex-end;
  border-top: 1px solid #1a2a3a;
  padding-top: .6rem;
  margin-top: .4rem;
}
.tut-btn {
  font-family: monospace;
  font-size: .7rem;
  padding: .3rem .65rem;
  border-radius: 3px;
  cursor: pointer;
  background: #0e1a22;
  border: 1px solid #004060;
  color: #00d4ff;
  letter-spacing: .08em;
}
.tut-btn:hover {
  background: #001a28;
  border-color: #00d4ff;
}
#tut-btn-skip {
  border-color: #333;
  color: #555;
  background: transparent;
}
#tut-btn-skip:hover { color: #888; border-color: #666; }

#tut-btn-prev:disabled {
  opacity: .3;
  cursor: default;
  pointer-events: none;
}
#tut-btn-next[data-waiting='true'] {
  opacity: .4;
  cursor: default;
  pointer-events: none;
  border-style: dashed;
}
#tut-btn-next[data-waiting='true']::after {
  content: var(--do-it, ' (do it)');
  font-size: .58rem;
  color: #555;
}
`;

// ────────────────────────────────────────────────────────────────────────────
// STEPS — Phase A has steps 1–6. More added in later phases.
// ────────────────────────────────────────────────────────────────────────────
const STEPS = [
  // 1
  {
    chapter: 'WELCOME',
    title: 'WELCOME TO CLANKERS 3',
    body: 'This tour walks through every part of the system — your AI band, each instrument, the song builder, and how to export. By the end you\'ll have a complete song. Click NEXT to start.',
    screen: null,
    target: null,
    nextOn: 'button',
  },
  // 2
  {
    chapter: 'GETTING STARTED',
    title: 'THE CHAT SCREEN',
    body: 'Every session starts here. The band lives in chat — they compose patterns, respond to your ideas, and generate your song based on what you ask for.',
    screen: 'chat',
    target: '#chat-logo',
    nextOn: 'button',
  },
  // 3
  {
    chapter: null,
    title: 'DESCRIBE YOUR TRACK',
    body: 'Type a description and the band will generate your first pattern. We\'ve dropped in a suggestion — edit it or keep it as-is.',
    screen: null,
    target: '#chat-input',
    demo: () => {
      const inp = document.getElementById('chat-input');
      if (inp && !inp.value) inp.value = 'dark acid techno at 130 BPM';
    },
    nextOn: 'button',
    hint: '← try editing this before sending',
  },
  // 4
  {
    chapter: null,
    title: 'HIT SEND',
    body: 'Send your description to the band. They\'ll generate and load the first pattern automatically. Click SEND to continue.',
    screen: null,
    target: '#chat-send',
    nextOn: 'action:#chat-send',
  },
  // 5
  {
    chapter: 'INSTRUMENTS',
    title: 'YOUR DASHBOARD',
    body: 'This is the main screen. Each ASCII face is an instrument in your band. Click one to enter its room and edit its sound.',
    screen: 'main',
    target: '#faces-row',
    nextOn: 'button',
    hint: '← click any face to open its room (or hit NEXT for a tour)',
  },
  // 6
  {
    chapter: null,
    title: 'MEET THE BAND',
    body: 'Six instruments: DRUMS (classic drum machine), BASS FM, POLY FM (west-coast synthesis), POLY SYNTH (pads), ORGAN (Rhodes), and VODER. Each has its own knobs, sequencer lane, and personality — we\'ll visit them next.',
    screen: 'main',
    target: '#faces-row',
    nextOn: 'button',
  },

  // ── DRUMS ──────────────────────────────────────────────────────────
  // 7
  {
    chapter: 'DRUMS',
    title: 'THE DRUMS ROOM',
    body: 'Inspired by classic drum machines — analog-modeled kick, snare, hats, toms, and claps. Let\'s step inside.',
    screen: null,
    target: null,
    demo: (bridge) => bridge && bridge.openRoom('drum'),
    nextOn: 'button',
  },
  // 8
  {
    chapter: null,
    title: 'DRUM PROFILES',
    body: 'Three drum machine personalities: 808 (deep sub kick, brushed hats), 909 (punchy kick, snappy snare), and 606 (compact, nimble). Each one changes the entire drum character at once.',
    screen: null,
    target: '.drum-profile-row',
    nextOn: 'button',
    hint: '← click a profile to switch',
  },
  // 9
  {
    chapter: null,
    title: 'DRUM KNOBS',
    body: 'Global controls shape every drum hit — pitch, decay, filter. Drag a knob to reshape the kit in real time. The band\'s pattern drives the voices; these knobs sculpt the sound.',
    screen: null,
    target: '#drum-knobs',
    nextOn: 'button',
    hint: '← drag vertically on a knob',
  },
  // 10
  {
    chapter: null,
    title: 'HIT PLAY',
    body: 'Start the sequencer and hear your drums. Press PLAY to continue the tour.',
    screen: null,
    target: '#room-play',
    nextOn: 'action:#room-play',
  },

  // ── BASS ───────────────────────────────────────────────────────────
  // 11
  {
    chapter: 'BASS',
    title: 'BASS FM',
    body: 'A 2-operator FM bass synthesizer. From pure sine subs to metallic FM growls — FM bass covers a lot of sonic ground.',
    screen: null,
    target: null,
    demo: (bridge) => bridge && bridge.openRoom('bass'),
    nextOn: 'button',
  },
  // 12
  {
    chapter: null,
    title: 'FM INDEX',
    body: 'The FM Index knob controls how much the modulator operator bends the carrier. Low values = clean sine bass. High values = metallic, gnarly FM distortion.',
    screen: null,
    target: '#bass-knobs',
    nextOn: 'button',
    hint: '← try cranking it up',
  },
  // 13
  {
    chapter: null,
    title: 'FILTER CUTOFF',
    body: 'A Moog-style ladder filter sits after the FM oscillator. Sweep it open and closed to change the brightness and presence of the bass line.',
    screen: null,
    target: '#bass-knobs',
    nextOn: 'button',
  },

  // ── POLY FM ────────────────────────────────────────────────────────
  // 14
  {
    chapter: 'POLY FM',
    title: 'POLY FM',
    body: 'Inspired by west-coast synthesis — waveshaping over filtering. Bright, angular, complex tones with an organic motion all their own.',
    screen: null,
    target: null,
    demo: (bridge) => bridge && bridge.openRoom('buchla'),
    nextOn: 'button',
  },
  // 15
  {
    chapter: null,
    title: 'WAVEFOLD AMOUNT',
    body: 'The wavefolder folds the waveform back on itself, creating new harmonics without any filter. From subtle shimmer to crushed digital chaos.',
    screen: null,
    target: '#buchla-knobs',
    nextOn: 'button',
    hint: '← push the fold amount',
  },
  // 16
  {
    chapter: null,
    title: 'FILTER MODULATION',
    body: 'An LFO sweeps through the filter in sync with the sequencer tempo. Adjust depth and rate for rhythmic filter movement — the signature west-coast texture.',
    screen: null,
    target: '#buchla-knobs',
    nextOn: 'button',
  },

  // ── RHODES ─────────────────────────────────────────────────────────
  // 17
  {
    chapter: 'RHODES',
    title: 'ORGAN (RHODES)',
    body: 'A physical-model electric piano with tine resonance, spring reverb, and rotary speaker simulation. Lush, warm, atmospheric — the backbone of many arrangements.',
    screen: null,
    target: null,
    demo: (bridge) => bridge && bridge.openRoom('rhodes'),
    nextOn: 'button',
  },
  // 18
  {
    chapter: null,
    title: 'BRIGHTNESS · TREMOLO · CHORUS',
    body: 'Brightness adjusts tine hardness. Tremolo adds organic amplitude sway. Chorus widens the stereo image. Together they create that classic electric piano wash.',
    screen: null,
    target: '#rhodes-knobs',
    nextOn: 'button',
    hint: '← dial in a sound',
  },

  // ── PADS ───────────────────────────────────────────────────────────
  // 19
  {
    chapter: 'PADS',
    title: 'POLY SYNTH (PADS)',
    body: 'A polyphonic subtractive synthesizer built for atmospheric textures and chord pads. Long release times turn notes into sustained, evolving washes.',
    screen: null,
    target: null,
    demo: (bridge) => bridge && bridge.openRoom('pads'),
    nextOn: 'button',
  },
  // 20
  {
    chapter: null,
    title: 'REVERB · SIZE & WET',
    body: 'These two knobs together create space — from a small room to an infinite cathedral. High size + high wet = shimmering, endless sustain.',
    screen: null,
    target: '#pads-knobs',
    nextOn: 'button',
    hint: '← turn reverb size all the way up',
  },

  // ── SONG BUILDER ───────────────────────────────────────────────────
  // 21
  {
    chapter: 'SONG BUILDER',
    title: 'THE SONG BUILDER',
    body: 'Patterns can be chained into a full arrangement. The Song Builder is where you compose the structure — intro, verse, chorus, bridge, outro — using the pattern bank and arrangement grid.',
    screen: 'song',
    target: null,
    nextOn: 'button',
  },
  // 22
  {
    chapter: null,
    title: 'PATTERN BANK',
    body: 'Each slot (P1–P8) stores a full song pattern. Click a slot to select it. As the band EVOLVES your song through sections, new patterns fill out the bank.',
    screen: null,
    target: '#song-pat-bank',
    nextOn: 'button',
    hint: '← click a pattern slot to activate it',
  },
  // 23
  {
    chapter: null,
    title: 'ARRANGEMENT GRID',
    body: 'Click arrangement slots to build a sequence of patterns. Drag patterns into any order to define the full song structure from start to finish.',
    screen: null,
    target: '#song-arr-grid',
    demo: () => {
      // Make sure the arrangement grid is visible — click SONG mode if needed
      const btnSong = document.getElementById('song-btn-song');
      if (btnSong && !btnSong.classList.contains('mode-active')) btnSong.click();
    },
    nextOn: 'button',
  },
  // 24
  {
    chapter: null,
    title: 'PLAY YOUR SONG',
    body: 'Hit play in SONG mode to hear your arrangement from start to finish. The grid will light up as each pattern plays. Click PLAY to continue.',
    screen: null,
    target: '#song-play-btn',
    nextOn: 'action:#song-play-btn',
  },

  // ── EVOLVE ─────────────────────────────────────────────────────────
  // 25
  {
    chapter: 'EVOLVE',
    title: 'EVOLVE YOUR SONG',
    body: 'EVOLVE sends the current pattern to the band with a new structural directive — they mutate it into a new section (verse 2, bridge, outro) and store it in the next pattern slot. If you don\'t see EVOLVE below, go back and SEND a chat message first — it unlocks once a session exists.',
    screen: null,
    target: '#btn-evolve',
    demo: (bridge) => {
      if (bridge && bridge.openChatOverlay) bridge.openChatOverlay();
    },
    nextOn: 'button',
  },
  // 26
  {
    chapter: null,
    title: 'TRIGGER AN EVOLUTION',
    body: 'Pick a section from the dropdown (verse 2, bridge, outro…) then click EVOLVE. The band will generate a variation and store it in the next pattern slot — a new piece of your song.',
    screen: null,
    target: '#btn-evolve',
    demo: (bridge) => {
      if (bridge && bridge.openChatOverlay) bridge.openChatOverlay();
    },
    nextOn: 'action:#btn-evolve',
    hint: '← select a section and click EVOLVE →',
  },

  // ── AI AUTO ────────────────────────────────────────────────────────
  // 27
  {
    chapter: 'AI AUTO',
    title: 'AI AUTO MODE',
    body: 'AI AUTO enables live parameter automation. The AI continuously adjusts knob values in response to the music playing — breathing movement into the arrangement. Click ◈ AI AUTO to activate it.',
    screen: null,
    target: '#btn-ai-auto',
    demo: (bridge) => {
      if (bridge && bridge.openChatOverlay) bridge.openChatOverlay();
    },
    nextOn: 'action:#btn-ai-auto',
    hint: '← click ◈ AI AUTO to turn it on',
  },

  // ── DONE ───────────────────────────────────────────────────────────
  // 28
  {
    chapter: 'DONE',
    title: 'YOUR SONG IS READY',
    body: 'You\'ve walked through every part of Clankers 3. To export your final mix, open any instrument room and click ⬇ WAV — this renders an offline mix file directly to your downloads. Now go make something weird.',
    screen: null,
    target: null,
    nextOn: 'button',
  },
];

// ────────────────────────────────────────────────────────────────────────────
// i18n — Spanish overrides keyed by step index (1-based). Missing keys fall
// back to the English text in STEPS above.
// ────────────────────────────────────────────────────────────────────────────
const STEPS_ES = {
  1: {
    chapter: 'BIENVENIDO',
    title: 'BIENVENIDO A CLANKERS 3',
    body: 'Este recorrido te muestra cada parte del sistema — tu banda de IA, cada instrumento, el constructor de canciones y cómo exportar. Al final tendrás una canción completa. Haz clic en SIGUIENTE para empezar.',
  },
  2: {
    chapter: 'COMENZANDO',
    title: 'LA PANTALLA DE CHAT',
    body: 'Cada sesión empieza aquí. La banda vive en el chat — componen patrones, responden a tus ideas y generan tu canción según lo que pidas.',
  },
  3: {
    title: 'DESCRIBE TU PISTA',
    body: 'Escribe una descripción y la banda generará tu primer patrón. Pusimos una sugerencia — edítala o déjala como está.',
    hint: '← prueba editando antes de enviar',
  },
  4: {
    title: 'DALE A ENVIAR',
    body: 'Manda tu descripción a la banda. Ellos generarán y cargarán el primer patrón automáticamente. Haz clic en SEND para continuar.',
  },
  5: {
    chapter: 'INSTRUMENTOS',
    title: 'TU PANEL',
    body: 'Esta es la pantalla principal. Cada cara ASCII es un instrumento de tu banda. Haz clic en uno para entrar a su sala y editar su sonido.',
    hint: '← haz clic en una cara para abrir su sala (o SIGUIENTE para un recorrido)',
  },
  6: {
    title: 'CONOCE A LA BANDA',
    body: 'Seis instrumentos: DRUMS (caja de ritmos clásica), BASS FM, POLY FM (síntesis west-coast), POLY SYNTH (pads), ORGAN (Rhodes) y VODER. Cada uno tiene sus propias perillas, pista de secuenciador y personalidad — los visitaremos ahora.',
  },
  7: {
    chapter: 'BATERÍA',
    title: 'LA SALA DE BATERÍA',
    body: 'Inspirada en cajas de ritmos clásicas — bombo, caja, hi-hats, toms y palmas modelados en analógico. Entremos.',
  },
  8: {
    title: 'PERFILES DE BATERÍA',
    body: 'Tres personalidades de caja de ritmos: 808 (bombo sub profundo, hats cepillados), 909 (bombo con golpe, caja nítida) y 606 (compacto, ágil). Cada una cambia todo el carácter de la batería a la vez.',
    hint: '← haz clic en un perfil para cambiar',
  },
  9: {
    title: 'PERILLAS DE BATERÍA',
    body: 'Los controles globales dan forma a cada golpe — tono, decaimiento, filtro. Arrastra una perilla para reconfigurar el kit en tiempo real. El patrón de la banda mueve las voces; estas perillas esculpen el sonido.',
    hint: '← arrastra verticalmente sobre una perilla',
  },
  10: {
    title: 'DALE A PLAY',
    body: 'Inicia el secuenciador y escucha tu batería. Pulsa PLAY para continuar el tour.',
  },
  11: {
    chapter: 'BAJO',
    title: 'BASS FM',
    body: 'Un sintetizador de bajo FM de 2 operadores. Desde subs sinusoidales puros hasta gruñidos FM metálicos — el bajo FM cubre mucho territorio sonoro.',
  },
  12: {
    title: 'ÍNDICE FM',
    body: 'La perilla FM Index controla cuánto el operador modulador dobla la portadora. Valores bajos = bajo sinusoidal limpio. Valores altos = distorsión FM metálica y áspera.',
    hint: '← prueba subiéndola al máximo',
  },
  13: {
    title: 'CORTE DEL FILTRO',
    body: 'Un filtro escalera estilo Moog se sitúa después del oscilador FM. Ábrelo y ciérralo para cambiar el brillo y la presencia de la línea de bajo.',
  },
  14: {
    chapter: 'POLY FM',
    title: 'POLY FM',
    body: 'Inspirado en la síntesis west-coast — wavefolding sobre filtrado. Tonos brillantes, angulares y complejos, con un movimiento orgánico único.',
  },
  15: {
    title: 'CANTIDAD DE WAVEFOLD',
    body: 'El wavefolder dobla la forma de onda sobre sí misma, creando nuevos armónicos sin filtro alguno. Desde brillo sutil hasta caos digital aplastado.',
    hint: '← empuja la cantidad de fold',
  },
  16: {
    title: 'MODULACIÓN DE FILTRO',
    body: 'Un LFO barre el filtro en sincronía con el tempo del secuenciador. Ajusta profundidad y velocidad para un movimiento rítmico del filtro — la textura west-coast por excelencia.',
  },
  17: {
    chapter: 'RHODES',
    title: 'ORGAN (RHODES)',
    body: 'Un piano eléctrico con modelo físico, con resonancia de varillas, reverb de muelles y simulación de altavoz rotatorio. Exuberante, cálido, atmosférico — la columna vertebral de muchos arreglos.',
  },
  18: {
    title: 'BRILLO · TRÉMOLO · CHORUS',
    body: 'Brillo ajusta la dureza de las varillas. Trémolo añade un vaivén orgánico de amplitud. Chorus ensancha la imagen estéreo. Juntos crean ese lavado clásico de piano eléctrico.',
    hint: '← afina un sonido',
  },
  19: {
    chapter: 'PADS',
    title: 'POLY SYNTH (PADS)',
    body: 'Un sintetizador sustractivo polifónico creado para texturas atmosféricas y pads de acordes. Los tiempos largos de release convierten las notas en lavados sostenidos y evolutivos.',
  },
  20: {
    title: 'REVERB · TAMAÑO Y WET',
    body: 'Estas dos perillas juntas crean espacio — desde una pequeña sala hasta una catedral infinita. Tamaño alto + wet alto = sustain brillante e infinito.',
    hint: '← sube el tamaño del reverb al máximo',
  },
  21: {
    chapter: 'CONSTRUCTOR',
    title: 'EL CONSTRUCTOR DE CANCIÓN',
    body: 'Los patrones pueden encadenarse en un arreglo completo. El Song Builder es donde compones la estructura — intro, verso, coro, puente, outro — usando el banco de patrones y la cuadrícula de arreglo.',
  },
  22: {
    title: 'BANCO DE PATRONES',
    body: 'Cada slot (P1–P8) guarda un patrón completo. Haz clic en un slot para seleccionarlo. A medida que la banda EVOLUCIONA tu canción por secciones, nuevos patrones llenan el banco.',
    hint: '← haz clic en un slot de patrón para activarlo',
  },
  23: {
    title: 'CUADRÍCULA DE ARREGLO',
    body: 'Haz clic en los slots de arreglo para construir una secuencia de patrones. Arrastra patrones en cualquier orden para definir la estructura completa de la canción.',
  },
  24: {
    title: 'REPRODUCE TU CANCIÓN',
    body: 'Dale a play en modo SONG para escuchar tu arreglo de principio a fin. La cuadrícula se iluminará mientras cada patrón se reproduce. Haz clic en PLAY para continuar.',
  },
  25: {
    chapter: 'EVOLUCIONAR',
    title: 'EVOLUCIONA TU CANCIÓN',
    body: 'EVOLVE envía el patrón actual a la banda con una nueva directiva estructural — lo mutan en una nueva sección (verso 2, puente, outro) y lo guardan en el siguiente slot. Si no ves EVOLVE abajo, vuelve y envía un mensaje de chat primero — se desbloquea cuando existe una sesión.',
  },
  26: {
    title: 'DISPARA UNA EVOLUCIÓN',
    body: 'Elige una sección del menú (verso 2, puente, outro…) y haz clic en EVOLVE. La banda generará una variación y la guardará en el siguiente slot — una nueva pieza de tu canción.',
    hint: '← selecciona una sección y haz clic en EVOLVE →',
  },
  27: {
    chapter: 'AI AUTO',
    title: 'MODO AI AUTO',
    body: 'AI AUTO activa la automatización en vivo de parámetros. La IA ajusta continuamente los valores de las perillas según la música que suena — dando movimiento al arreglo. Haz clic en ◈ AI AUTO para activarlo.',
    hint: '← haz clic en ◈ AI AUTO para encenderlo',
  },
  28: {
    chapter: 'LISTO',
    title: 'TU CANCIÓN ESTÁ LISTA',
    body: 'Has recorrido cada parte de Clankers 3. Para exportar tu mezcla final, abre cualquier sala de instrumento y haz clic en ⬇ WAV — esto renderiza un archivo de mezcla offline directo a tus descargas. Ahora ve y haz algo raro.',
  },
};

const UI_STRINGS = {
  en: { prev: '← PREV', next: 'NEXT →', skip: 'SKIP', finish: 'FINISH', doIt: ' (do it)' },
  es: { prev: '← ANT',  next: 'SIG →', skip: 'SALTAR', finish: 'FIN', doIt: ' (hazlo)' },
};

// Language state — persisted to localStorage, defaults to ES if browser is Spanish.
let _lang = (function () {
  try {
    const saved = localStorage.getItem('tut_lang');
    if (saved === 'en' || saved === 'es') return saved;
  } catch (e) { /* localStorage may be unavailable */ }
  return (navigator.language || '').toLowerCase().startsWith('es') ? 'es' : 'en';
})();

function setLang(lang) {
  if (lang !== 'en' && lang !== 'es') return;
  _lang = lang;
  try { localStorage.setItem('tut_lang', lang); } catch (e) { /* noop */ }
}

// Returns the localized field of a step (title, body, hint, chapter).
function tStep(stepIdx1based, field) {
  const enVal = STEPS[stepIdx1based - 1]?.[field];
  if (_lang === 'es') {
    const esVal = STEPS_ES[stepIdx1based]?.[field];
    if (esVal !== undefined) return esVal;
  }
  return enVal;
}

function tUI(key) {
  return UI_STRINGS[_lang]?.[key] ?? UI_STRINGS.en[key];
}

// ────────────────────────────────────────────────────────────────────────────
// Bridge helper
// ────────────────────────────────────────────────────────────────────────────
function getBridge() {
  return window._tutorialBridge || null;
}

// ────────────────────────────────────────────────────────────────────────────
// Spotlight
// ────────────────────────────────────────────────────────────────────────────
class Spotlight {
  constructor() {
    this._el = document.createElement('div');
    this._el.id = 'tut-spotlight';
    document.body.appendChild(this._el);
  }
  show() { this._el.classList.add('on'); }
  hide() { this._el.classList.remove('on'); this._el.classList.remove('no-target'); }
  pointRect(rect) {
    if (!rect) { this.clear(); return; }
    this._el.classList.remove('no-target');
    const PAD = 6;
    this._el.style.setProperty('--sx', (rect.left - PAD) + 'px');
    this._el.style.setProperty('--sy', (rect.top - PAD) + 'px');
    this._el.style.setProperty('--sw', (rect.width + PAD * 2) + 'px');
    this._el.style.setProperty('--sh', (rect.height + PAD * 2) + 'px');
  }
  // No spotlight target: dim the whole screen uniformly
  clear() {
    this._el.classList.add('no-target');
    this._el.style.setProperty('--sw', '0px');
    this._el.style.setProperty('--sh', '0px');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// TutorialPanel
// ────────────────────────────────────────────────────────────────────────────
class TutorialPanel {
  constructor({ onNext, onPrev, onSkip, onLangChange }) {
    const el = document.createElement('div');
    el.id = 'tut-panel';
    el.innerHTML = `
      <div class="tut-top">
        <span class="tut-chapter" id="tut-chapter"></span>
        <span class="tut-top-right">
          <span class="tut-lang">
            <button class="tut-lang-btn" data-lang="en">EN</button>
            <span class="tut-lang-sep">|</span>
            <button class="tut-lang-btn" data-lang="es">ES</button>
          </span>
          <span class="tut-progress" id="tut-progress"></span>
        </span>
      </div>
      <div class="tut-title" id="tut-title"></div>
      <div class="tut-body" id="tut-body"></div>
      <div class="tut-hint" id="tut-hint" style="display:none"></div>
      <div class="tut-footer">
        <button class="tut-btn" id="tut-btn-prev"></button>
        <button class="tut-btn" id="tut-btn-skip"></button>
        <button class="tut-btn" id="tut-btn-next"></button>
      </div>
    `;
    document.body.appendChild(el);
    this._el = el;
    this._chapterEl = el.querySelector('#tut-chapter');
    this._progressEl = el.querySelector('#tut-progress');
    this._titleEl = el.querySelector('#tut-title');
    this._bodyEl = el.querySelector('#tut-body');
    this._hintEl = el.querySelector('#tut-hint');
    this._btnPrev = el.querySelector('#tut-btn-prev');
    this._btnNext = el.querySelector('#tut-btn-next');
    this._btnSkip = el.querySelector('#tut-btn-skip');
    this._langBtns = el.querySelectorAll('.tut-lang-btn');
    this._btnPrev.addEventListener('click', onPrev);
    this._btnNext.addEventListener('click', onNext);
    this._btnSkip.addEventListener('click', onSkip);
    this._langBtns.forEach(b => {
      b.addEventListener('click', () => {
        const lang = b.getAttribute('data-lang');
        if (lang && lang !== _lang) {
          setLang(lang);
          this._updateLangActive();
          if (typeof onLangChange === 'function') onLangChange();
        }
      });
    });
    this._updateLangActive();
  }
  show() { this._el.classList.add('on'); }
  hide() { this._el.classList.remove('on'); }

  _updateLangActive() {
    this._langBtns.forEach(b => {
      const active = b.getAttribute('data-lang') === _lang;
      b.classList.toggle('tut-lang-active', active);
    });
  }

  // idx is 1-based.
  render(idx, total, isLast) {
    this._chapterEl.textContent = tStep(idx, 'chapter') || '';
    this._progressEl.textContent = `${idx} / ${total}`;
    this._titleEl.textContent = tStep(idx, 'title') || '';
    this._bodyEl.textContent = tStep(idx, 'body') || '';
    const hint = tStep(idx, 'hint');
    if (hint) {
      this._hintEl.textContent = hint;
      this._hintEl.style.display = '';
    } else {
      this._hintEl.style.display = 'none';
    }
    this._btnPrev.disabled = (idx <= 1);
    this._btnPrev.textContent = tUI('prev');
    this._btnSkip.textContent = tUI('skip');
    this._btnNext.textContent = isLast ? tUI('finish') : tUI('next');
    this._updateLangActive();
  }

  setNextWaiting(waiting) {
    this._btnNext.setAttribute('data-waiting', waiting ? 'true' : 'false');
    // Update the (do it) suffix via CSS ::after using a CSS custom property
    this._btnNext.style.setProperty('--do-it', `"${tUI('doIt')}"`);
  }

  position(targetRect) {
    const PANEL_W = 300;
    // Force a reflow-ready measurement by temporarily positioning offscreen
    this._el.style.left = '-9999px';
    this._el.style.top = '0px';
    const panelH = this._el.offsetHeight || 220;
    const GAP = 16;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const candidates = [];
    if (targetRect) {
      // Below
      candidates.push({
        top: targetRect.bottom + GAP,
        left: targetRect.left + targetRect.width / 2 - PANEL_W / 2,
      });
      // Above
      candidates.push({
        top: targetRect.top - panelH - GAP,
        left: targetRect.left + targetRect.width / 2 - PANEL_W / 2,
      });
      // Right
      candidates.push({
        top: targetRect.top,
        left: targetRect.right + GAP,
      });
      // Left
      candidates.push({
        top: targetRect.top,
        left: targetRect.left - PANEL_W - GAP,
      });
    }
    // Fallback: viewport center
    candidates.push({
      top: vh / 2 - panelH / 2,
      left: vw / 2 - PANEL_W / 2,
    });

    for (const pos of candidates) {
      const clamped = {
        top: Math.max(8, Math.min(pos.top, vh - panelH - 8)),
        left: Math.max(8, Math.min(pos.left, vw - PANEL_W - 8)),
      };
      if (targetRect) {
        const panelRect = {
          left: clamped.left, top: clamped.top,
          right: clamped.left + PANEL_W, bottom: clamped.top + panelH,
        };
        const overlaps = !(
          panelRect.right < targetRect.left - 4 ||
          panelRect.left > targetRect.right + 4 ||
          panelRect.bottom < targetRect.top - 4 ||
          panelRect.top > targetRect.bottom + 4
        );
        if (overlaps) continue;
      }
      this._el.style.top = clamped.top + 'px';
      this._el.style.left = clamped.left + 'px';
      return;
    }

    // All positions overlap — center fallback
    const last = candidates[candidates.length - 1];
    this._el.style.top = Math.max(8, last.top) + 'px';
    this._el.style.left = Math.max(8, last.left) + 'px';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tutorial orchestrator
// ────────────────────────────────────────────────────────────────────────────
class Tutorial {
  constructor() {
    this._stepIdx = 0;
    this._active = false;
    this._actionCleanup = null;
    this._spotlight = null;
    this._panel = null;
  }

  _init() {
    if (this._spotlight) return;
    this._spotlight = new Spotlight();
    this._panel = new TutorialPanel({
      onNext: () => this.next(),
      onPrev: () => this.prev(),
      onSkip: () => this.skip(),
      onLangChange: () => this._rerender(),
    });
  }

  // Re-render the current step's copy without re-running demos or re-navigating.
  _rerender() {
    if (!this._active) return;
    const idx = this._stepIdx + 1;
    const total = STEPS.length;
    const isLast = (this._stepIdx === STEPS.length - 1);
    this._panel.render(idx, total, isLast);
    // Keep the action-waiting state in sync so the NEW language's (do it) shows
    const step = STEPS[this._stepIdx];
    const waiting = typeof step.nextOn === 'string' && step.nextOn.startsWith('action:');
    this._panel.setNextWaiting(waiting);
  }

  start() {
    this._init();
    this._active = true;
    this._stepIdx = 0;
    this._spotlight.show();
    this._panel.show();
    this._applyStep(STEPS[0]);
  }

  skip() {
    this._cleanupActionListener();
    this._active = false;
    if (this._spotlight) this._spotlight.hide();
    if (this._panel) this._panel.hide();
  }

  next() {
    if (this._stepIdx >= STEPS.length - 1) {
      this.skip();
      return;
    }
    this._stepIdx++;
    this._applyStep(STEPS[this._stepIdx]);
  }

  prev() {
    if (this._stepIdx <= 0) return;
    this._stepIdx--;
    this._applyStep(STEPS[this._stepIdx]);
  }

  _cleanupActionListener() {
    if (this._actionCleanup) {
      this._actionCleanup();
      this._actionCleanup = null;
    }
  }

  _applyStep(step) {
    this._cleanupActionListener();
    const bridge = getBridge();

    // 1. Screen navigation
    if (step.screen && bridge) {
      bridge.showScreen(step.screen);
    }

    // 2. Demo side-effects (may mutate DOM via openRoom etc.)
    if (typeof step.demo === 'function') {
      try { step.demo(bridge); } catch (e) { console.warn('[tutorial] demo failed', e); }
    }

    // 3. Let DOM settle, then spotlight + position panel
    setTimeout(() => {
      const rect = step.target ? this._getTargetRect(step.target) : null;
      if (rect) this._spotlight.pointRect(rect);
      else this._spotlight.clear();

      const isLast = (this._stepIdx === STEPS.length - 1);
      this._panel.render(this._stepIdx + 1, STEPS.length, isLast);
      this._panel.position(rect);
    }, 60);

    // 4. Action listener for auto-advance
    if (typeof step.nextOn === 'string' && step.nextOn.startsWith('action:')) {
      const selector = step.nextOn.slice(7);
      const ac = new AbortController();
      document.addEventListener('click', (e) => {
        if (e.target && e.target.closest(selector)) {
          // Advance after the user's click finishes processing
          setTimeout(() => {
            if (this._active) this.next();
          }, 80);
        }
      }, { capture: true, signal: ac.signal });
      this._actionCleanup = () => ac.abort();
      this._panel.setNextWaiting(true);
    } else {
      this._panel.setNextWaiting(false);
    }
  }

  _getTargetRect(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return r;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Init
// ────────────────────────────────────────────────────────────────────────────
function injectCSS() {
  const style = document.createElement('style');
  style.id = 'tut-styles';
  style.textContent = TUT_CSS;
  document.head.appendChild(style);
}

function boot() {
  if (document.getElementById('tut-styles')) return; // already booted
  injectCSS();

  const btn = document.getElementById('btn-tutorial');
  if (!btn) {
    console.warn('[tutorial] #btn-tutorial not found — tour disabled');
    return;
  }

  const tutorial = new Tutorial();

  btn.addEventListener('click', () => {
    if (!window._tutorialBridge) {
      // Bridge not ready — retry briefly
      const originalLabel = btn.textContent;
      btn.textContent = '...';
      let tries = 0;
      const retry = setInterval(() => {
        tries++;
        if (window._tutorialBridge) {
          clearInterval(retry);
          btn.textContent = originalLabel;
          tutorial.start();
        } else if (tries > 30) {
          clearInterval(retry);
          btn.textContent = originalLabel;
          console.warn('[tutorial] bridge never became ready');
        }
      }, 100);
      return;
    }
    tutorial.start();
  });

  // Expose for debugging
  window._tutorial = tutorial;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
