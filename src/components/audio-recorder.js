/**
 * src/components/audio-recorder.js
 *
 * Record a voice note in the browser and hand back the bytes.
 *
 *   window.AudioRecorder.open({ onDone: (file|null) => {} })   // modal recorder
 *   window.AudioRecorder.supported()                            // boolean
 *
 * A plain IIFE on window, like image-overlay-editor.js, because workspace.html is a static page
 * with no bundler. It captures ONLY — storing the result is the caller's job (gpUploadContentAsset),
 * so this module never touches R2, the DB, or a post.
 *
 * NOT to be confused with voice-feedback.js, which uses the Web Speech API to turn speech into TEXT
 * for dictating feedback. This is the opposite: it keeps the audio and throws away the words.
 *
 * ── Format ──────────────────────────────────────────────────────────────────────────────────────
 * MediaRecorder's output format is browser-chosen, not ours: Chrome/Firefox give webm/opus, Safari
 * gives mp4/aac. Both are in content-upload-url's allow-list and both are decodable by Remotion's
 * renderer, so we take whatever the browser offers rather than forcing a type it may not support —
 * asking Safari for audio/webm yields a silently empty recording.
 */
(function () {
  'use strict';

  const MAX_SECONDS = 300;          // 5 min — far past any social voice note, and a guard against a
                                    // forgotten open mic filling memory.
  // Ordered by preference; the first the browser admits to supporting wins. Left empty as the final
  // fallback, which lets MediaRecorder pick entirely for itself.
  const CANDIDATE_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', ''];

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function pickMimeType() {
    for (const t of CANDIDATE_TYPES) {
      if (!t) return '';
      if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  function extFor(mime) {
    if (/mp4|aac/.test(mime)) return 'm4a';
    if (/ogg/.test(mime)) return 'ogg';
    return 'webm';
  }

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function open(opts) {
    const onDone = (opts && opts.onDone) || function () {};

    if (!supported()) {
      window.showToast?.('Recording isn’t available in this browser. You can still upload an audio file instead.', { icon: '⚠️', duration: 6000 });
      onDone(null);
      return;
    }

    // ── UI ────────────────────────────────────────────────────────────────────
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:120;background:rgba(17,24,39,.7);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;';
    back.innerHTML = `
      <div style="background:#fff;border-radius:16px;max-width:380px;width:100%;padding:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <p style="font-size:15px;font-weight:800;color:#111827;margin:0 0 2px;">Record a voice note</p>
        <p data-hint style="font-size:12px;color:#9ca3af;margin:0 0 16px;">Your browser will ask for microphone access.</p>
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;">
          <div data-meter style="width:100%;height:44px;border-radius:10px;background:#f3f4f6;overflow:hidden;display:flex;align-items:flex-end;gap:2px;padding:4px;box-sizing:border-box;"></div>
          <p data-time style="font-size:22px;font-weight:800;color:#111827;margin:2px 0;font-variant-numeric:tabular-nums;">0:00</p>
          <button data-rec type="button" style="width:64px;height:64px;border-radius:50%;border:none;background:#e11d48;cursor:pointer;display:flex;align-items:center;justify-content:center;">
            <span data-recicon style="display:block;width:22px;height:22px;border-radius:50%;background:#fff;"></span>
          </button>
          <p data-status style="font-size:11px;font-weight:700;color:#6b7280;margin:0;text-transform:uppercase;letter-spacing:.06em;">Ready</p>
        </div>
        <audio data-play controls style="width:100%;margin-top:14px;display:none;"></audio>
        <div style="display:flex;gap:8px;margin-top:16px;">
          <button data-cancel type="button" style="flex:1;padding:10px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;font-size:13px;font-weight:700;color:#6b7280;cursor:pointer;">Cancel</button>
          <button data-use type="button" disabled style="flex:1;padding:10px;border-radius:10px;border:none;background:#059669;color:#fff;font-size:13px;font-weight:700;cursor:pointer;opacity:.5;">Use this</button>
        </div>
      </div>`;
    document.body.appendChild(back);

    const q = (s) => back.querySelector(s);
    const meter = q('[data-meter]');
    const timeEl = q('[data-time]');
    const statusEl = q('[data-status]');
    const hintEl = q('[data-hint]');
    const recBtn = q('[data-rec]');
    const recIcon = q('[data-recicon]');
    const player = q('[data-play]');
    const useBtn = q('[data-use]');

    // 24 bars, oldest → newest, so the meter reads as a moving waveform rather than a single level.
    const bars = [];
    for (let i = 0; i < 24; i++) {
      const b = document.createElement('span');
      b.style.cssText = 'flex:1;background:#d1d5db;border-radius:2px;height:2px;transition:height .08s linear;';
      meter.appendChild(b);
      bars.push(b);
    }

    let stream = null, recorder = null, chunks = [], startedAt = 0, raf = null, timer = null;
    let audioCtx = null, analyser = null, blob = null, objectUrl = null;

    const cleanup = () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
      if (recorder && recorder.state === 'recording') { try { recorder.stop(); } catch { /* already stopping */ } }
      if (stream) stream.getTracks().forEach(t => t.stop());   // releases the mic indicator
      if (audioCtx && audioCtx.state !== 'closed') audioCtx.close().catch(() => {});
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    const close = (result) => { cleanup(); back.remove(); onDone(result); };

    const drawLevel = () => {
      if (!analyser) return;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);
      // Peak deviation from the 128 midpoint — cheap, and responsive enough to show speech.
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
      const h = Math.max(2, Math.min(36, (peak / 128) * 60));
      for (let i = 0; i < bars.length - 1; i++) bars[i].style.height = bars[i + 1].style.height;
      bars[bars.length - 1].style.height = h + 'px';
      raf = requestAnimationFrame(drawLevel);
    };

    const stop = () => {
      if (!recorder || recorder.state !== 'recording') return;
      recorder.stop();
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
      recIcon.style.borderRadius = '50%';
      recIcon.style.width = recIcon.style.height = '22px';
      statusEl.textContent = 'Recorded';
      recBtn.style.background = '#e11d48';
    };

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        // Denied or no device. Say what to do rather than just failing — the permission prompt only
        // appears once, so a user who dismissed it has no obvious way back.
        hintEl.textContent = 'Microphone blocked. Allow it in your browser’s address bar, then try again.';
        hintEl.style.color = '#dc2626';
        statusEl.textContent = 'No microphone';
        return;
      }
      hintEl.textContent = 'Speak — press the button again to stop.';
      hintEl.style.color = '#9ca3af';

      // Live level meter. Purely cosmetic, so any failure here must not stop the recording.
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        audioCtx.createMediaStreamSource(stream).connect(analyser);
        drawLevel();
      } catch { analyser = null; }

      const mime = pickMimeType();
      chunks = [];
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        // Use the recorder's OWN type, not the requested one — the browser may have substituted.
        blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(blob);
        player.src = objectUrl;
        player.style.display = 'block';
        useBtn.disabled = false;
        useBtn.style.opacity = '1';
      };
      recorder.start();

      startedAt = Date.now();
      statusEl.textContent = 'Recording';
      recBtn.style.background = '#374151';
      recIcon.style.borderRadius = '3px';
      recIcon.style.width = recIcon.style.height = '18px';
      timer = setInterval(() => {
        const s = (Date.now() - startedAt) / 1000;
        timeEl.textContent = fmtTime(s);
        if (s >= MAX_SECONDS) { stop(); statusEl.textContent = `Stopped at ${fmtTime(MAX_SECONDS)}`; }
      }, 200);
    };

    recBtn.addEventListener('click', () => {
      if (recorder && recorder.state === 'recording') stop(); else start();
    });
    q('[data-cancel]').addEventListener('click', () => close(null));
    useBtn.addEventListener('click', () => {
      if (!blob) return;
      const ext = extFor(blob.type);
      const name = `Voice note ${new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.${ext}`;
      close(new File([blob], name, { type: blob.type }));
    });
    back.addEventListener('click', (e) => { if (e.target === back) close(null); });
  }

  window.AudioRecorder = { open, supported };
})();
