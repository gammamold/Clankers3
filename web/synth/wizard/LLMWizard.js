/**
 * LLMWizard — provider-agnostic chat UI.
 * Shows a conversation interface, calls the LLM, and fires onComplete(state)
 * when the LLM outputs a SYNTH_JSON block.
 */
import { callLLM, extractSynthJSON, extractSynthGraphJSON, MODELS } from './SynthAgent.js';

// Per-provider metadata that drives the UI copy, placeholder, key validation,
// and "get an API key" link. Keep in sync with api/llm.js detectProvider().
const PROVIDERS = {
  anthropic: {
    name:        'Claude',
    company:     'Anthropic',
    placeholder: 'sk-ant-...',
    keyUrl:      'https://console.anthropic.com/settings/keys',
    keyHint:     'Key must start with sk-',
    validate:    v => v.startsWith('sk-'),
  },
  openai: {
    name:        'GPT',
    company:     'OpenAI',
    placeholder: 'sk-...',
    keyUrl:      'https://platform.openai.com/api-keys',
    keyHint:     'Key must start with sk-',
    validate:    v => v.startsWith('sk-'),
  },
  google: {
    name:        'Gemini',
    company:     'Google',
    placeholder: 'Gemini API key',
    keyUrl:      'https://aistudio.google.com/app/apikey',
    keyHint:     'Enter a Gemini API key',
    validate:    v => v.length > 0,
  },
  minimax: {
    name:        'MiniMax',
    company:     'MiniMax',
    placeholder: 'MiniMax API key',
    keyUrl:      'https://www.minimax.io/platform',
    keyHint:     'Enter a MiniMax API key',
    validate:    v => v.length > 0,
  },
};

// Mirror of detectProvider() in api/llm.js, for client-side UI decisions.
function providerOf(model) {
  const m = (model || '').toLowerCase();
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
  if (m.startsWith('gemini')) return 'google';
  if (m.startsWith('minimax')) return 'minimax';
  return 'anthropic';
}

const infoFor  = model => PROVIDERS[providerOf(model)] || PROVIDERS.anthropic;
const keyStore = provider => `clankers_api_key_${provider}`;

// Visible model options, in display order. Label is shown in the dropdowns.
const MODEL_OPTIONS = [
  [MODELS.haiku,     'Haiku',         'Haiku — fast & cheap'],
  [MODELS.sonnet,    'Sonnet',        'Sonnet — smarter designs'],
  [MODELS.minimax25, 'MiniMax M2.5',  'MiniMax M2.5 — open-weight alt'],
  [MODELS.minimax27, 'MiniMax M2.7',  'MiniMax M2.7 — newer open-weight'],
];

export class LLMWizard {
  constructor(onComplete, prefill = null) {
    this.onComplete = onComplete;
    this._prefill   = prefill;
    this._messages  = [];
    this._model     = sessionStorage.getItem('clankers_model') || MODELS.haiku;
    this._apiKey    = sessionStorage.getItem(keyStore(providerOf(this._model))) || '';
    this.el         = null;
    this._inputEl   = null;
    this._feedEl    = null;
    this._sendBtn   = null;
    this._thinking  = false;
  }

  render(container) {
    container.innerHTML = '';

    if (!this._apiKey) {
      this._renderKeySetup(container);
    } else {
      this._renderChat(container);
      // Auto-open with a greeting
      this._greet();
    }
  }

  // ── API Key Setup ──────────────────────────────────────────────────────
  _renderKeySetup(container) {
    const wrap = document.createElement('div');
    wrap.className = 'llm-key-setup';
    wrap.innerHTML = `
      <div class="key-setup-inner">
        <div class="key-logo">⬡</div>
        <h2 class="key-title"></h2>
        <p class="key-desc"></p>
        <input type="password" class="key-input" autocomplete="off"/>
        <div class="key-model-row">
          <label class="key-model-label">Model</label>
          <select class="key-model-select"></select>
        </div>
        <button class="key-btn">Connect</button>
        <a class="key-link" target="_blank">Get an API key →</a>
      </div>
    `;
    container.appendChild(wrap);

    const titleEl = wrap.querySelector('.key-title');
    const descEl  = wrap.querySelector('.key-desc');
    const input   = wrap.querySelector('.key-input');
    const modelSel = wrap.querySelector('.key-model-select');
    const btn     = wrap.querySelector('.key-btn');
    const linkEl  = wrap.querySelector('.key-link');

    // Populate the model dropdown from MODEL_OPTIONS.
    for (const [val, , longLabel] of MODEL_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = longLabel;
      modelSel.appendChild(opt);
    }

    // Apply copy/placeholder/link for the currently-selected model's provider,
    // and restore any key the user has already entered for that provider.
    const applyProviderCopy = () => {
      const p = infoFor(this._model);
      titleEl.textContent = `Connect to ${p.name}`;
      descEl.textContent  = `The Synth Designer uses the ${p.name} API to understand your requests and build instruments. Enter your ${p.company} API key to get started.`;
      input.placeholder   = p.placeholder;
      linkEl.href         = p.keyUrl;
      input.value         = sessionStorage.getItem(keyStore(providerOf(this._model))) || '';
      input.style.borderColor = '';
    };

    modelSel.value = this._model;
    applyProviderCopy();
    modelSel.addEventListener('change', () => {
      this._model = modelSel.value;
      sessionStorage.setItem('clankers_model', this._model);
      applyProviderCopy();
    });

    // Error label below the button
    const errEl = document.createElement('div');
    errEl.style.cssText = 'font-size:10px;color:#e63946;font-family:monospace;text-align:center;min-height:14px;';
    btn.insertAdjacentElement('afterend', errEl);

    const connect = async () => {
      const val = input.value.trim();
      const p   = infoFor(this._model);
      errEl.textContent = '';
      if (!val || !p.validate(val)) {
        input.style.borderColor = '#e63946';
        errEl.textContent = p.keyHint;
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      try {
        // Quick reachability check before switching to chat view
        const probe = await fetch('/api/llm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: val, model: this._model, max_tokens: 1,
                                 messages: [{ role: 'user', content: 'hi' }] }),
        });
        if (probe.status === 401) throw new Error('Invalid API key (401)');
        if (!probe.ok && probe.status !== 400) throw new Error(`Server error ${probe.status}`);
        // All good — open chat
        this._apiKey = val;
        sessionStorage.setItem(keyStore(providerOf(this._model)), val);
        this._renderChat(container);
        this._greet();
      } catch (err) {
        errEl.textContent = 'Error: ' + err.message;
        btn.disabled = false;
        btn.textContent = 'Connect';
      }
    };

    btn.addEventListener('click', connect);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
  }

  // ── Chat UI ────────────────────────────────────────────────────────────
  _renderChat(container) {
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'llm-chat-wrap';

    const header = document.createElement('div');
    header.className = 'chat-header';
    header.innerHTML = `
      <span class="chat-logo">⬡</span>
      <span class="chat-title">SYNTH DESIGNER</span>
      <span class="chat-sub"></span>
      <select class="chat-model-select" title="Switch model"></select>
      <button class="chat-key-reset" title="Change API key">⚙</button>
    `;
    const subEl        = header.querySelector('.chat-sub');
    const chatModelSel = header.querySelector('.chat-model-select');
    subEl.textContent  = `Powered by ${infoFor(this._model).name}`;
    for (const [val, shortLabel] of MODEL_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = shortLabel;
      if (val === this._model) opt.selected = true;
      chatModelSel.appendChild(opt);
    }
    chatModelSel.addEventListener('change', () => {
      const newModel = chatModelSel.value;
      const prevProvider = providerOf(this._model);
      const newProvider  = providerOf(newModel);
      this._model = newModel;
      sessionStorage.setItem('clankers_model', this._model);
      subEl.textContent = `Powered by ${infoFor(this._model).name}`;
      if (prevProvider !== newProvider) {
        // Switching providers — use this provider's saved key, or prompt for one.
        const nextKey = sessionStorage.getItem(keyStore(newProvider));
        if (nextKey) {
          this._apiKey = nextKey;
        } else {
          this._apiKey = '';
          this._messages = [];
          this._renderKeySetup(container);
        }
      }
    });

    header.querySelector('.chat-key-reset').addEventListener('click', () => {
      sessionStorage.removeItem(keyStore(providerOf(this._model)));
      this._apiKey = '';
      this._messages = [];
      this._renderKeySetup(container);
    });

    this._feedEl = document.createElement('div');
    this._feedEl.className = 'chat-feed';

    const inputRow = document.createElement('div');
    inputRow.className = 'chat-input-row';

    this._inputEl = document.createElement('textarea');
    this._inputEl.className   = 'chat-textarea';
    this._inputEl.placeholder = 'Describe your synth… e.g. "I want a dark acid bass with a resonant filter"';
    this._inputEl.rows = 2;
    this._inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });

    this._sendBtn = document.createElement('button');
    this._sendBtn.className   = 'chat-send-btn';
    this._sendBtn.textContent = '▶';
    this._sendBtn.addEventListener('click', () => this._send());

    inputRow.appendChild(this._inputEl);
    inputRow.appendChild(this._sendBtn);

    wrap.appendChild(header);
    wrap.appendChild(this._feedEl);
    wrap.appendChild(inputRow);
    container.appendChild(wrap);

    this.el = wrap;
  }

  async _greet() {
    if (this._prefill) {
      this._addMessage('user', this._prefill);
    }
    await this._llmTurn(this._prefill || null);
  }

  async _send() {
    const text = this._inputEl?.value.trim();
    if (!text || this._thinking) return;
    this._inputEl.value = '';
    this._addMessage('user', text);
    await this._llmTurn(text);
  }

  async _llmTurn(userText) {
    if (userText) {
      this._messages.push({ role: 'user', content: userText });
    } else {
      // Initial greeting — prime with a user message
      this._messages.push({ role: 'user', content: 'Hello, I want to build a synth.' });
    }

    this._setThinking(true);

    try {
      const reply = await callLLM(this._apiKey, this._messages, this._model);
      this._messages.push({ role: 'assistant', content: reply });

      // Check if JSON was returned — try graph format first, then legacy
      const graphState = extractSynthGraphJSON(reply);
      const synthState = graphState || extractSynthJSON(reply);

      // Show the message (strip JSON blocks from display)
      const displayText = reply
        .replace(/<SYNTH_GRAPH>[\s\S]*?<\/SYNTH_GRAPH>/g, '')
        .replace(/<SYNTH_JSON>[\s\S]*?<\/SYNTH_JSON>/g, '')
        .trim();
      if (displayText) this._addMessage('assistant', displayText);

      if (synthState) {
        this._addBuildCard(synthState);
      }
    } catch (err) {
      this._addMessage('error', `Error: ${err.message}`);
      if (err.message.includes('401') || err.message.includes('API key')) {
        sessionStorage.removeItem(keyStore(providerOf(this._model)));
      }
    } finally {
      this._setThinking(false);
    }
  }

  _addMessage(role, text) {
    const el = document.createElement('div');
    el.className = `chat-msg chat-msg--${role}`;

    if (role === 'assistant') {
      // Simple markdown: bold, code blocks
      el.innerHTML = this._renderMarkdown(text);
    } else {
      el.textContent = text;
    }

    this._feedEl.appendChild(el);
    this._feedEl.scrollTop = this._feedEl.scrollHeight;
  }

  _addBuildCard(state) {
    const el = document.createElement('div');
    el.className = 'chat-build-card';

    const isGraph = state.type === 'wasm_graph';
    const voices  = isGraph ? (state.num_voices || 4) : (state.voice?.polyphony || 1);
    const typeLabel = isGraph ? 'WASM graph' : state.type;
    const nodeCount = isGraph ? `${state.nodes?.length || 0} nodes` : '';
    const info   = `${typeLabel} · ${voices} voice${voices > 1 ? 's' : ''}${nodeCount ? ' · ' + nodeCount : ''}`;

    el.innerHTML = `
      <div class="build-card-icon">⬡</div>
      <div class="build-card-text">
        <strong class="build-card-name">${state.name}</strong><br>
        <span class="build-card-info">${info}</span>
      </div>
      <div class="build-card-actions">
        <button class="build-load-btn">▶ LOAD INTO SLOT</button>
        <button class="build-forge-btn">↓ DOWNLOAD JSON</button>
      </div>
    `;

    // LOAD → fires onComplete to put the synth into the slot and open the editor
    el.querySelector('.build-load-btn').addEventListener('click', () => {
      el.querySelector('.build-card-actions').innerHTML = '<span style="color:#ffe000;font-size:10px;font-family:monospace;">Loading…</span>';
      this.onComplete(state);
    });

    // FORGE → download the json immediately without leaving the wizard
    el.querySelector('.build-forge-btn').addEventListener('click', () => {
      const json = JSON.stringify(state, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), {
        href: url,
        download: (state.name || 'synth').replace(/\s+/g, '_').toLowerCase() + '.json',
      });
      a.click();
      URL.revokeObjectURL(url);
    });

    this._feedEl.appendChild(el);
    this._feedEl.scrollTop = this._feedEl.scrollHeight;
  }

  _setThinking(on) {
    this._thinking = on;
    if (this._sendBtn) this._sendBtn.disabled = on;
    if (this._inputEl) this._inputEl.disabled = on;

    const existing = this._feedEl?.querySelector('.chat-thinking');
    if (on && !existing) {
      const el = document.createElement('div');
      el.className = 'chat-thinking';
      el.innerHTML = '<span></span><span></span><span></span>';
      this._feedEl.appendChild(el);
      this._feedEl.scrollTop = this._feedEl.scrollHeight;
    } else if (!on && existing) {
      existing.remove();
    }
  }

  _renderMarkdown(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }
}
