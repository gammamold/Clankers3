import { TEMPLATES } from '../templates/subtractive.js';

/**
 * Wizard — conversational guide that selects and pre-configures a synth template.
 * Returns a state object ready to load into JSONBridge.
 */
export class Wizard {
  constructor(onComplete) {
    this.onComplete = onComplete;
    this._answers = {};
    this._step = 0;
    this._steps = [
      {
        id: 'role',
        question: "What role will this instrument play in your track?",
        options: [
          { label: 'Bass line',    value: 'bass',       hint: 'Deep, punchy, low end' },
          { label: 'Lead melody',  value: 'lead',       hint: 'Bright, cutting, melodic' },
          { label: 'Pad / Chords', value: 'pad',        hint: 'Wide, atmospheric, evolving' },
          { label: 'Custom start', value: 'subtractive',hint: 'Neutral — you shape it' },
        ],
      },
      {
        id: 'character',
        question: "How would you describe the character?",
        options: [
          { label: 'Warm & smooth',  value: 'warm' },
          { label: 'Bright & sharp', value: 'bright' },
          { label: 'Dark & heavy',   value: 'dark' },
          { label: 'Gritty & raw',   value: 'gritty' },
        ],
      },
      {
        id: 'movement',
        question: "Should the sound evolve over time?",
        options: [
          { label: 'Yes — filter movement',    value: 'filter' },
          { label: 'Yes — subtle vibrato/mod', value: 'lfo' },
          { label: 'Both',                     value: 'both' },
          { label: 'No — keep it static',      value: 'none' },
        ],
      },
      {
        id: 'space',
        question: "How much space should it occupy?",
        options: [
          { label: 'Dry & tight',    value: 'dry' },
          { label: 'Some reverb',    value: 'reverb' },
          { label: 'Echo & delay',   value: 'delay' },
          { label: 'Big & washed',   value: 'wash' },
        ],
      },
      {
        id: 'name',
        question: "Give your instrument a name:",
        type: 'text',
        placeholder: 'e.g. Dark Crawler',
      },
    ];
  }

  get currentStep() {
    return this._steps[this._step];
  }

  get progress() {
    return this._step / this._steps.length;
  }

  answer(value) {
    const step = this._steps[this._step];
    this._answers[step.id] = value;
    this._step++;
    if (this._step >= this._steps.length) {
      this.onComplete(this._buildState());
    }
  }

  _buildState() {
    const { role, character, movement, space, name } = this._answers;
    const base = JSON.parse(JSON.stringify(TEMPLATES[role] || TEMPLATES.subtractive));

    base.name = name || 'My Synth';
    base.id   = 'user_' + Date.now();

    // Character adjustments — cutoffs kept LOW so filter is always audible
    if (character === 'warm') {
      base.modules.vcf.cutoff = Math.min(base.modules.vcf.cutoff * 1.5, 400);
      base.modules.vcf.resonance = 3;
      base.modules.vco.waveform = 'sine';
    } else if (character === 'bright') {
      base.modules.vcf.cutoff = Math.min(base.modules.vcf.cutoff * 2, 600);
      base.modules.vcf.resonance = 6;
      base.modules.vco.waveform = 'sawtooth';
    } else if (character === 'dark') {
      base.modules.vcf.cutoff = Math.max(base.modules.vcf.cutoff * 0.6, 80);
      base.modules.vcf.resonance = 10;
      base.modules.vco.waveform = 'sawtooth';
    } else if (character === 'gritty') {
      base.modules.vcf.cutoff = Math.min(base.modules.vcf.cutoff * 1.2, 350);
      base.modules.vcf.resonance = 5;
      const hasDist = base.modules.effects.some(e => e.type === 'distortion');
      if (!hasDist) base.modules.effects.unshift({ type: 'distortion', drive: 0.4, tone: 2500 });
    }

    // Movement
    if (movement === 'filter' || movement === 'both') {
      base.modules.adsr_filter.amount = Math.max(base.modules.adsr_filter.amount, 0.6);
    }
    if (movement === 'lfo' || movement === 'both') {
      base.modules.lfo.enabled = true;
    }

    // Space
    const hasFx = t => base.modules.effects.some(e => e.type === t);
    if (space === 'reverb' || space === 'wash') {
      if (!hasFx('reverb')) base.modules.effects.push({ type: 'reverb', size: space === 'wash' ? 0.8 : 0.4, wet: space === 'wash' ? 0.5 : 0.25 });
    }
    if (space === 'delay' || space === 'wash') {
      if (!hasFx('delay')) base.modules.effects.push({ type: 'delay', time: 0.375, feedback: 0.35, wet: 0.3 });
    }

    return base;
  }
}
