/**
 * src/components/video-recorder.js
 *
 * Film yourself in the browser and hand back the file — the Video Producer's "Record a video"
 * (docs/video-producer-manual-controls-plan.md §4.2, 2026-11-10). The recording then goes into the
 * library like any upload (FootageReader.upload) and on through "Use my own footage".
 *
 *   window.VideoRecorder.open({ onDone: (file|null) => {}, shape?: '9:16' | '1:1' | '16:9', script?: string })  — script fills the teleprompter
 *   window.VideoRecorder.supported()
 *
 * A sibling of audio-recorder.js: captures only, never stores. MP4 where the browser can make it
 * (Safari, recent Chrome), WebM otherwise — both are in content-upload-url's allow-list, and the footage
 * reader measures a WebM that reports no length (footage-reader.js openVideo).
 */
(function () {
  'use strict';

  const MAX_SECONDS = 300;   // the footage limit (5 minutes)
  const CANDIDATE_TYPES = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', ''];

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
  const extFor = (mime) => (/mp4/.test(mime) ? 'mp4' : 'webm');
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function open(opts) {
    const onDone = (opts && opts.onDone) || function () {};
    if (!supported()) {
      window.showToast?.('Recording isn’t available in this browser. Film it on your phone and add the video instead.', { icon: '⚠️', duration: 6000 });
      onDone(null);
      return;
    }
    const shape = (opts && opts.shape) || '9:16';
    const portrait = shape === '9:16';
    const ratio = shape === '16:9' ? '16 / 9' : shape === '1:1' ? '1 / 1' : '9 / 16';

    const back = document.createElement('div');
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', 'Record a video');
    back.style.cssText = 'position:fixed;inset:0;z-index:120;background:rgba(17,24,39,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;';
    back.innerHTML = `
      <div style="background:#fff;border-radius:16px;max-width:${portrait ? 360 : 560}px;width:100%;padding:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-height:calc(100vh - 32px);overflow:auto;">
        <p style="font-size:15px;font-weight:800;color:#111827;margin:0 0 2px;">Record a video</p>
        <p data-hint style="font-size:12px;color:#6b7280;margin:0 0 12px;">Your browser will ask for your camera and microphone.</p>
        <div style="position:relative;width:100%;aspect-ratio:${ratio};max-height:60vh;background:#111827;border-radius:12px;overflow:hidden;">
          <video data-live muted playsinline autoplay style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);"></video>
          <video data-play playsinline controls style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;background:#000;"></video>
          <div data-prompter aria-hidden="true" style="position:absolute;left:0;right:0;top:0;height:42%;overflow:hidden;background:linear-gradient(rgba(0,0,0,.72),rgba(0,0,0,.4));display:none;pointer-events:none;">
            <div data-prompter-text style="padding:30px 14px 10px;color:#fff;font-size:${portrait ? 19 : 22}px;line-height:1.45;font-weight:700;white-space:pre-wrap;will-change:transform;text-align:center;"></div>
          </div>
          <span data-time style="position:absolute;top:8px;left:8px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;font-weight:700;border-radius:6px;padding:2px 6px;font-variant-numeric:tabular-nums;">0:00</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:12px;">
          <button data-rec type="button" aria-label="Start recording" style="width:60px;height:60px;border-radius:50%;border:none;background:#e11d48;cursor:pointer;display:flex;align-items:center;justify-content:center;">
            <span data-recicon style="display:block;width:20px;height:20px;border-radius:50%;background:#fff;"></span>
          </button>
        </div>
        <p data-status style="text-align:center;font-size:11px;font-weight:700;color:#6b7280;margin:6px 0 0;text-transform:uppercase;letter-spacing:.06em;">Starting the camera…</p>
        <details data-prompter-box style="margin-top:10px;font-size:12px;color:#374151;"${opts && opts.script ? ' open' : ''}>
          <summary style="cursor:pointer;font-weight:700;">Teleprompter</summary>
          <label for="vr-script" style="display:block;margin:6px 0 2px;color:#6b7280;">What you’ll say. It scrolls over the camera while you record, near the lens, and isn’t in the video.</label>
          <textarea id="vr-script" data-script rows="4" maxlength="5000" style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:6px 8px;font:inherit;font-size:13px;"></textarea>
          <label style="display:flex;align-items:center;gap:8px;margin-top:4px;color:#6b7280;">Speed
            <input data-speed type="range" min="80" max="220" step="10" value="140" style="flex:1;">
            <span data-speed-label style="font-variant-numeric:tabular-nums;white-space:nowrap;">140 words a minute</span></label>
        </details>
        <p style="font-size:11px;color:#9ca3af;margin:8px 0 0;">Hold your phone or camera ${portrait ? 'upright' : 'sideways'} for a ${shape} video. Up to 5 minutes.</p>
        <div style="display:flex;gap:8px;margin-top:14px;">
          <button data-cancel type="button" style="flex:1;padding:10px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;font-size:13px;font-weight:700;color:#6b7280;cursor:pointer;">Cancel</button>
          <button data-again type="button" style="flex:1;padding:10px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;font-size:13px;font-weight:700;color:#374151;cursor:pointer;display:none;">Record again</button>
          <button data-use type="button" disabled style="flex:1;padding:10px;border-radius:10px;border:none;background:#059669;color:#fff;font-size:13px;font-weight:700;cursor:pointer;opacity:.5;">Use this</button>
        </div>
      </div>`;
    document.body.appendChild(back);

    const q = (s) => back.querySelector(s);
    const live = q('[data-live]'), play = q('[data-play]'), timeEl = q('[data-time]'), statusEl = q('[data-status]'), hintEl = q('[data-hint]');
    const recBtn = q('[data-rec]'), recIcon = q('[data-recicon]'), useBtn = q('[data-use]'), againBtn = q('[data-again]');
    let stream = null, recorder = null, chunks = [], startedAt = 0, timer = null, blob = null, objectUrl = null;

    // ── Teleprompter: the script over the live picture, scrolling at a chosen pace while recording.
    // It's page text over the preview, not part of the camera stream, so it is never in the video.
    const prompter = q('[data-prompter]'), prompterText = q('[data-prompter-text]'), scriptEl = q('[data-script]'), speedEl = q('[data-speed]'), speedLabel = q('[data-speed-label]');
    let scrollY = 0, rafId = 0, lastT = 0;
    if (opts && typeof opts.script === 'string') scriptEl.value = opts.script.slice(0, 5000);
    const prompterOn = () => !!scriptEl.value.trim() && live.style.display !== 'none';
    const paintPrompter = () => {
      prompterText.textContent = scriptEl.value;
      prompter.style.display = prompterOn() ? 'block' : 'none';
      prompterText.style.transform = `translateY(${-scrollY}px)`;
    };
    const stopScroll = () => { if (rafId) cancelAnimationFrame(rafId); rafId = 0; };
    const startScroll = () => {
      stopScroll();
      if (!prompterOn()) return;
      lastT = performance.now();
      const words = scriptEl.value.trim().split(/\s+/).length || 1;
      const step = (t) => {
        const dt = (t - lastT) / 1000; lastT = t;
        // The whole text passes in the time it takes to say it at the chosen pace.
        const seconds = (words / Number(speedEl.value || 140)) * 60;
        const travel = Math.max(1, prompterText.scrollHeight - prompter.clientHeight * 0.4);
        scrollY = Math.min(travel, scrollY + (travel / seconds) * dt);
        prompterText.style.transform = `translateY(${-scrollY}px)`;
        if (scrollY < travel) rafId = requestAnimationFrame(step);
      };
      rafId = requestAnimationFrame(step);
    };
    scriptEl.addEventListener('input', () => { scrollY = 0; paintPrompter(); });
    speedEl.addEventListener('input', () => { speedLabel.textContent = `${speedEl.value} words a minute`; });
    paintPrompter();   // a script passed in shows over the preview from the start

    const stopTracks = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
    const cleanup = () => {
      stopScroll();
      if (timer) clearInterval(timer);
      if (recorder && recorder.state === 'recording') { try { recorder.stop(); } catch { /* stopping */ } }
      stopTracks();   // releases the camera light
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      document.removeEventListener('keydown', onKey);
    };
    const close = (result) => { cleanup(); back.remove(); onDone(result); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', onKey);

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: portrait ? 1080 : 1920 }, height: { ideal: portrait ? 1920 : 1080 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch {
        hintEl.textContent = 'Camera or microphone blocked. Allow them in your browser’s address bar, then try again.';
        hintEl.style.color = '#dc2626';
        statusEl.textContent = 'No camera';
        recBtn.disabled = true; recBtn.style.opacity = '.4';
        return;
      }
      live.srcObject = stream;
      live.style.display = 'block'; play.style.display = 'none';
      scrollY = 0; paintPrompter();
      statusEl.textContent = 'Ready';
      hintEl.textContent = 'Press the red button to start, and again to stop.';
    };

    const stop = () => {
      if (!recorder || recorder.state !== 'recording') return;
      recorder.stop();
      if (timer) clearInterval(timer);
      recIcon.style.borderRadius = '50%'; recIcon.style.width = recIcon.style.height = '20px';
      recBtn.setAttribute('aria-label', 'Start recording');
      statusEl.textContent = 'Recorded — play it back';
    };
    const start = () => {
      if (!stream) return;
      const mime = pickMimeType();
      chunks = [];
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        blob = new Blob(chunks, { type: recorder.mimeType || mime || 'video/webm' });
        stopTracks();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(blob);
        play.src = objectUrl;
        live.style.display = 'none'; play.style.display = 'block';
        stopScroll(); paintPrompter();
        recBtn.style.display = 'none'; againBtn.style.display = 'block';
        useBtn.disabled = false; useBtn.style.opacity = '1';
      };
      recorder.start(1000);
      startedAt = Date.now();
      scrollY = 0; paintPrompter(); startScroll();
      statusEl.textContent = 'Recording';
      recIcon.style.borderRadius = '3px'; recIcon.style.width = recIcon.style.height = '18px';
      recBtn.setAttribute('aria-label', 'Stop recording');
      timer = setInterval(() => {
        const s = (Date.now() - startedAt) / 1000;
        timeEl.textContent = fmtTime(s);
        if (s >= MAX_SECONDS) { stop(); statusEl.textContent = `Stopped at ${fmtTime(MAX_SECONDS)}`; }
      }, 200);
    };

    recBtn.addEventListener('click', () => { if (recorder && recorder.state === 'recording') stop(); else start(); });
    againBtn.addEventListener('click', () => {
      blob = null; useBtn.disabled = true; useBtn.style.opacity = '.5';
      againBtn.style.display = 'none'; recBtn.style.display = 'flex'; timeEl.textContent = '0:00';
      play.removeAttribute('src'); play.load();
      startCamera();
    });
    q('[data-cancel]').addEventListener('click', () => close(null));
    useBtn.addEventListener('click', () => {
      if (!blob) return;
      const name = `My video ${new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.${extFor(blob.type)}`;
      close(new File([blob], name.replace(/[:/]/g, '.'), { type: blob.type.split(';')[0] || 'video/webm' }));
    });
    startCamera();
  }

  window.VideoRecorder = { open, supported };
})();
