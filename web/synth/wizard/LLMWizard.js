/**
 * LLMWizard — chat UI powered by Claude.
 * Shows a conversation interface, calls the LLM, and fires onComplete(state)
 * when the LLM outputs a SYNTH_JSON block.
 */
import { callLLM, extractSynthJSON, MODELS } from './SynthAgent.js';

export class LLMWizard {
  constructor(onComplete) {
    this.onComplete = onComplete;
    this._messages  = [];
    this._apiKey    = sessionStorage.getItem('clankers_api_key') || '';
    this._model     = sessionStorage.getItem('clankers_model') || MODELS.haiku;
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
        <h2 class="key-title">Connect to Claude</h2>
        <p class="key-desc">The Synth Designer uses the Claude API to understand your requests and build instruments. Enter your Anthropic API key to get started.</p>
        <input type="password" class="key-input" placeholder="sk-ant-..." autocomplete="off"/>
        <div class="key-model-row">
          <label class="key-model-label">Model</label>
          <select class="key-model-select">
            <option value="${MODELS.haiku}">Haiku — fast &amp; cheap</option>
            <option value="${MODELS.sonnet}">Sonnet — smarter designs</option>
          </select>
        </div>
        <button class="key-btn">Connect</button>
        <a class="key-link" href="https://console.anthropic.com/settings/keys" target="_blank">Get an API key →</a>
      </div>
    `;
    container.appendChild(wrap);

    const input    = wrap.querySelector('.key-input');
    const modelSel = wrap.querySelector('.key-model-select');
    const btn      = wrap.querySelector('.key-btn');

    // Restore saved model selection
    modelSel.value = this._model;
    modelSel.addEventListener('change', () => {
      this._model = modelSel.value;
      sessionStorage.setItem('clankers_model', this._model);
    });

    // Error label below the button
    const errEl = document.createElement('div');
    errEl.style.cssText = 'font-size:10px;color:#e63946;font-family:monospace;text-align:center;min-height:14px;';
    btn.insertAdjacentElement('afterend', errEl);

    const connect = async () => {
      const val = input.value.trim();
      errEl.textContent = '';
      if (!val.startsWith('sk-')) {
        input.style.borderColor = '#e63946';
        errEl.textContent = 'Key must start with sk-';
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
        sessionStorage.setItem('clankers_api_key', val);
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
      <span class="chat-sub">Powered by Claude</span>
      <select class="chat-model-select" title="Switch model"></select>
      <button class="chat-key-reset" title="Change API key">⚙</button>
    `;
    const chatModelSel = header.querySelector('.chat-model-select');
    [
      [MODELS.haiku,  'Haiku'],
      [MODELS.sonnet, 'Sonnet'],
    ].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = label;
      if (val === this._model) opt.selected = true;
      chatModelSel.appendChild(opt);
    });
    chatModelSel.addEventListener('change', () => {
      this._model = chatModelSel.value;
      sessionStorage.setItem('clankers_model', this._model);
    });

    header.querySelector('.chat-key-reset').addEventListener('click', () => {
      sessionStorage.removeItem('clankers_api_key');
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
    await this._llmTurn(null); // null = no user message, just trigger greeting
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

      // Check if JSON was returned
      const synthState = extractSynthJSON(reply);

      // Show the message (strip the JSON block from display)
      const displayText = reply.replace(/<SYNTH_JSON>[\s\S]*?<\/SYNTH_JSON>/g, '').trim();
      if (displayText) this._addMessage('assistant', displayText);

      if (synthState) {
        this._addBuildCard(synthState);
      }
    } catch (err) {
      this._addMessage('error', `Error: ${err.message}`);
      if (err.message.includes('401') || err.message.includes('API key')) {
        sessionStorage.removeItem('clankers_api_key');
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

    const voices = state.voice?.polyphony || 1;
    const info   = `${state.type} · ${voices} voice${voices > 1 ? 's' : ''}`;

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
