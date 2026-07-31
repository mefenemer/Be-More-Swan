/**
 * US-SMM-2.5.1: Mobile Voice Feedback on Post Drafts
 *
 * Renders a microphone button for voice feedback during post review.
 * Uses the Web Speech API for transcription (browser-native, ~0ms latency).
 * Falls back to text input if microphone is unavailable or user chooses.
 *
 * Usage:
 *   const vf = new VoiceFeedback({
 *     postId: 123,
 *     assistantId: 45,
 *     container: document.getElementById('voice-feedback-root'),
 *     onFeedbackApplied: ({ postSpecific, rules, revisionJobId }) => { ... }
 *   });
 *   vf.render();
 */

export class VoiceFeedback {
    constructor({ postId, assistantId, container, onFeedbackApplied }) {
        this.postId      = postId;
        this.assistantId = assistantId;
        this.container   = container;
        this.onFeedbackApplied = onFeedbackApplied || (() => {});

        this._recognition  = null;
        this._recording    = false;
        this._transcript   = '';
        this._timerEl      = null;
        this._timerStart   = null;
        this._timerRaf     = null;
    }

    // ── Public ──────────────────────────────────────────────────────────────

    render() {
        this.container.innerHTML = `
<div class="vf-root" style="display:flex;flex-direction:column;gap:12px;align-items:center;">
  <!-- Microphone button -->
  <div class="vf-mic-row" style="display:flex;align-items:center;gap:12px;">
    <button id="vf-mic-btn" aria-label="Start voice feedback"
      style="width:56px;height:56px;border-radius:50%;border:none;background:#6366f1;color:#fff;
             font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;
             box-shadow:0 2px 8px rgba(0,0,0,.2);transition:transform .1s;">
      🎤
    </button>
    <button id="vf-text-btn" aria-label="Type instead"
      style="font-size:13px;color:#6366f1;background:none;border:none;cursor:pointer;text-decoration:underline;">
      Type instead
    </button>
  </div>

  <!-- Timer shown while recording -->
  <div id="vf-timer" style="display:none;font-size:13px;color:#e11d48;font-weight:600;">⏺ 0:00</div>

  <!-- Waveform animation -->
  <div id="vf-wave" style="display:none;gap:3px;align-items:flex-end;height:24px;">
    ${[1,2,3,4,5].map(() => `<span style="display:inline-block;width:4px;border-radius:2px;background:#6366f1;
      animation:vf-bounce .6s ease-in-out infinite alternate;height:${8+Math.random()*12}px;
      animation-delay:${Math.random()*0.4}s;"></span>`).join('')}
  </div>

  <!-- Transcript review panel (hidden until recording stops) -->
  <div id="vf-transcript-panel" style="display:none;width:100%;max-width:480px;">
    <p style="font-size:13px;color:#6b7280;margin:0 0 4px;">Transcription — check before continuing:</p>
    <textarea id="vf-transcript-text"
      style="width:100%;min-height:80px;border:1px solid #d1d5db;border-radius:8px;padding:8px;
             font-size:14px;resize:vertical;box-sizing:border-box;"></textarea>
    <div style="display:flex;gap:8px;margin-top:8px;">
      <button id="vf-rerecord-btn"
        style="flex:1;padding:8px;border:1px solid #d1d5db;border-radius:8px;background:#fff;
               font-size:13px;cursor:pointer;">
        Re-record
      </button>
      <button id="vf-classify-btn"
        style="flex:1;padding:8px;border:none;border-radius:8px;background:#6366f1;color:#fff;
               font-size:13px;cursor:pointer;font-weight:600;">
        Analyse feedback →
      </button>
    </div>
  </div>

  <!-- Summary card (hidden until classification done) -->
  <div id="vf-summary-panel" style="display:none;width:100%;max-width:480px;"></div>

  <!-- Text fallback panel -->
  <div id="vf-text-panel" style="display:none;width:100%;max-width:480px;">
    <p style="font-size:13px;color:#6b7280;margin:0 0 4px;">Type your feedback:</p>
    <textarea id="vf-text-input"
      style="width:100%;min-height:80px;border:1px solid #d1d5db;border-radius:8px;padding:8px;
             font-size:14px;resize:vertical;box-sizing:border-box;"
      placeholder="What is wrong with this post? Any standing rules for future posts?"></textarea>
    <button id="vf-text-classify-btn"
      style="margin-top:8px;width:100%;padding:10px;border:none;border-radius:8px;
             background:#6366f1;color:#fff;font-size:14px;cursor:pointer;font-weight:600;">
      Analyse feedback →
    </button>
  </div>

  <!-- Status message -->
  <p id="vf-status" style="font-size:13px;color:#6b7280;text-align:center;margin:0;"></p>
</div>
<style>
@keyframes vf-bounce { from { transform: scaleY(0.4); } to { transform: scaleY(1); } }
#vf-mic-btn.recording { background:#e11d48; animation: vf-pulse 1.2s ease-in-out infinite; }
@keyframes vf-pulse { 0%,100% { box-shadow:0 0 0 0 rgba(225,29,72,.4); } 50% { box-shadow:0 0 0 12px rgba(225,29,72,0); } }
</style>`;

        this._bindEvents();
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _bindEvents() {
        const micBtn       = this.container.querySelector('#vf-mic-btn');
        const textBtn      = this.container.querySelector('#vf-text-btn');
        const rerecordBtn  = this.container.querySelector('#vf-rerecord-btn');
        const classifyBtn  = this.container.querySelector('#vf-classify-btn');
        const textClassify = this.container.querySelector('#vf-text-classify-btn');

        micBtn.addEventListener('click', () => this._toggleRecording());
        textBtn.addEventListener('click', () => this._showTextFallback());
        rerecordBtn.addEventListener('click', () => this._resetToMic());
        classifyBtn.addEventListener('click', () => this._classify(
            this.container.querySelector('#vf-transcript-text').value
        ));
        textClassify.addEventListener('click', () => this._classify(
            this.container.querySelector('#vf-text-input').value
        ));
    }

    _toggleRecording() {
        if (this._recording) {
            this._stopRecording();
        } else {
            this._startRecording();
        }
    }

    _startRecording() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            this._setStatus('⚠️ Voice recording is not supported in this browser. Please type your feedback instead.');
            this._showTextFallback();
            return;
        }

        // Check mic permission
        navigator.mediaDevices?.getUserMedia({ audio: true }).catch(() => {
            this._setStatus('Microphone access is needed for voice feedback. Tap to open settings.');
            // Show settings link
            const status = this.container.querySelector('#vf-status');
            status.innerHTML = `Microphone access is needed for voice feedback.
              <a href="#" onclick="navigator.permissions&&navigator.permissions.query({name:'microphone'}).then(()=>window.open('about:blank','_self'))">
              Tap to open settings</a>.
              <br><small style="color:#9ca3af;">Voice feedback lets you speak your thoughts while on the go — your assistant will transcribe and act on them automatically.</small>`;
        });

        this._recognition = new SpeechRecognition();
        this._recognition.continuous    = true;
        this._recognition.interimResults = true;
        this._recognition.lang           = 'en-GB';
        this._recognition.maxAlternatives = 1;

        let finalTranscript = '';
        this._recognition.onresult = (e) => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript + ' ';
                else interim += e.results[i][0].transcript;
            }
            this._transcript = finalTranscript + interim;
        };

        this._recognition.onerror = (e) => {
            if (e.error === 'not-allowed') {
                this._setStatus('Microphone permission denied. Please enable microphone access in your browser settings, or type instead.');
                this._showTextFallback();
            }
            this._stopRecording();
        };

        // Auto-stop after 60 seconds
        this._autoStopTimeout = setTimeout(() => this._stopRecording(), 60_000);

        this._recognition.start();
        this._recording = true;

        const micBtn = this.container.querySelector('#vf-mic-btn');
        micBtn.classList.add('recording');
        micBtn.setAttribute('aria-label', 'Stop recording');
        micBtn.textContent = '⏹';

        this._show('#vf-wave');
        this._show('#vf-timer');
        this._timerStart = Date.now();
        this._tickTimer();
        this._setStatus('Recording… tap the button or wait 60 seconds to stop.');
    }

    _stopRecording() {
        if (!this._recording) return;
        this._recording = false;
        clearTimeout(this._autoStopTimeout);
        cancelAnimationFrame(this._timerRaf);

        if (this._recognition) {
            try { this._recognition.stop(); } catch {}
        }

        const micBtn = this.container.querySelector('#vf-mic-btn');
        micBtn.classList.remove('recording');
        micBtn.setAttribute('aria-label', 'Start voice feedback');
        micBtn.textContent = '🎤';

        this._hide('#vf-wave');
        this._hide('#vf-timer');

        const t = (this._transcript || '').trim();
        if (!t) {
            this._setStatus('No speech detected. Try again or type your feedback.');
            return;
        }

        this.container.querySelector('#vf-transcript-text').value = t;
        this._show('#vf-transcript-panel');
        this._setStatus('Review the transcription above, then click "Analyse feedback".');
    }

    _tickTimer() {
        const elapsed = Math.floor((Date.now() - this._timerStart) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = String(elapsed % 60).padStart(2, '0');
        const el = this.container.querySelector('#vf-timer');
        if (el) el.textContent = `⏺ ${m}:${s}`;
        this._timerRaf = requestAnimationFrame(() => this._tickTimer());
    }

    async _classify(transcript) {
        transcript = (transcript || '').trim();
        if (!transcript) {
            this._setStatus('Please enter or record some feedback first.');
            return;
        }

        this._setStatus('Analysing feedback…');
        this._hide('#vf-transcript-panel');
        this._hide('#vf-text-panel');

        try {
            const res = await fetch('/.netlify/functions/classify-voice-feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transcript,
                    postId:      this.postId,
                    assistantId: this.assistantId,
                }),
                credentials: 'include',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { items } = await res.json();
            this._renderSummaryCard(items, transcript);
        } catch (err) {
            this._setStatus('Failed to analyse feedback. Please try again.');
            this._show('#vf-transcript-panel');
        }
    }

    _renderSummaryCard(items, rawTranscript) {
        const panel = this.container.querySelector('#vf-summary-panel');
        if (!items?.length) {
            panel.innerHTML = `<p style="color:#6b7280;font-size:13px;">Could not extract individual feedback items. Please try rephrasing.</p>`;
            this._show('#vf-summary-panel');
            return;
        }

        const labelMap = {
            post_specific:    { label: 'This post only', color: '#3b82f6' },
            overarching_rule: { label: 'Standing rule (all posts)', color: '#8b5cf6' },
            ambiguous:        { label: 'Unclear — please clarify', color: '#f59e0b' },
        };

        const itemsHtml = items.map((item, i) => {
            const { label, color } = labelMap[item.classification] || labelMap.ambiguous;
            const isAmbiguous = item.classification === 'ambiguous';
            return `
<div data-idx="${i}" class="vf-item"
  style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;background:#fff;margin-bottom:8px;">
  <p style="font-size:14px;margin:0 0 6px;color:#111827;">${this._esc(item.text)}</p>
  <span style="font-size:11px;background:${color}22;color:${color};border-radius:4px;padding:2px 8px;font-weight:600;">
    ${label}${item.platform ? ` · ${item.platform}` : ''}
  </span>
  ${isAmbiguous ? `
    <p style="font-size:12px;color:#f59e0b;margin:8px 0 4px;">❓ ${this._esc(item.clarificationQuestion || 'Is this for this post only or all future posts?')}</p>
    <div style="display:flex;gap:6px;margin-top:4px;">
      <button data-idx="${i}" data-resolve="post_specific"
        style="flex:1;padding:6px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;cursor:pointer;background:#fff;">
        This post only
      </button>
      <button data-idx="${i}" data-resolve="overarching_rule"
        style="flex:1;padding:6px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;cursor:pointer;background:#fff;">
        Standing rule
      </button>
    </div>` : ''}
</div>`;
        }).join('');

        panel.innerHTML = `
<p style="font-size:13px;color:#6b7280;margin:0 0 8px;">Review how I've interpreted your feedback:</p>
${itemsHtml}
<button id="vf-confirm-btn"
  style="width:100%;padding:12px;border:none;border-radius:8px;background:#16a34a;color:#fff;
         font-size:14px;font-weight:600;cursor:pointer;margin-top:4px;">
  ✓ Confirm all & apply
</button>`;

        this._show('#vf-summary-panel');
        this._setStatus('');

        // Store items on the element for confirm handler
        panel._items = items;

        // Ambiguous resolution buttons
        panel.querySelectorAll('[data-resolve]').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.dataset.idx);
                panel._items[idx].classification = btn.dataset.resolve;
                // Re-render
                this._renderSummaryCard(panel._items, rawTranscript);
            });
        });

        // Confirm all
        panel.querySelector('#vf-confirm-btn').addEventListener('click', async () => {
            const unresolved = panel._items.filter(i => i.classification === 'ambiguous');
            if (unresolved.length) {
                this._setStatus('Please resolve all unclear items before confirming.');
                return;
            }
            await this._applyFeedback(panel._items);
        });
    }

    async _applyFeedback(items) {
        this._setStatus('Applying feedback…');

        const postSpecific = items.filter(i => i.classification === 'post_specific').map(i => i.text).join('\n');
        const rules        = items.filter(i => i.classification === 'overarching_rule');

        // The rewrite is generated asynchronously, so there is no post id to hand back here — only
        // the id of the job that will produce it. The revised draft arrives in the Review Queue on
        // its own, and reject-post's 'post_revised' notification announces it.
        let revisionJobId = null;

        // Apply post-specific feedback as a rejection
        if (postSpecific) {
            try {
                const res = await fetch('/.netlify/functions/reject-post', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        postId:       this.postId,
                        feedbackText: postSpecific,
                        applyAsRule:  false,
                        voiceFeedback: true,
                    }),
                    credentials: 'include',
                });
                if (res.ok) {
                    const data = await res.json();
                    revisionJobId = data.revisionJobId || null;
                }
            } catch {}
        }

        // Save overarching rules
        const savedRules = [];
        for (const rule of rules) {
            try {
                const res = await fetch('/.netlify/functions/content-rules', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        assistantId: this.assistantId,
                        ruleText:    rule.text,
                        platform:    rule.platform || null,
                        note:        'Added via voice feedback',
                    }),
                    credentials: 'include',
                });
                if (res.ok) savedRules.push(rule);
            } catch {}
        }

        const parts = [];
        if (postSpecific) parts.push("I'm rewriting the post with your feedback");
        if (savedRules.length) parts.push(`saved ${savedRules.length} new rule${savedRules.length > 1 ? 's' : ''} to your Content Rules Library`);

        this._setStatus(`✓ Got it. ${parts.join(' and ')}.`);
        this._hide('#vf-summary-panel');

        this.onFeedbackApplied({ postSpecific: !!postSpecific, rules: savedRules, revisionJobId });
    }

    _showTextFallback() {
        this._hide('#vf-transcript-panel');
        this._hide('#vf-summary-panel');
        this._show('#vf-text-panel');
        this._setStatus('Type your feedback below. The assistant will classify it the same way as voice feedback.');
    }

    _resetToMic() {
        this._transcript = '';
        this._hide('#vf-transcript-panel');
        this._hide('#vf-summary-panel');
        this._setStatus('');
    }

    _show(sel) {
        const el = this.container.querySelector(sel);
        if (el) el.style.display = sel.includes('wave') ? 'flex' : 'block';
    }

    _hide(sel) {
        const el = this.container.querySelector(sel);
        if (el) el.style.display = 'none';
    }

    _setStatus(msg) {
        const el = this.container.querySelector('#vf-status');
        if (el) el.textContent = msg;
    }

    _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
}
