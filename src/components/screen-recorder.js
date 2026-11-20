/**
 * src/components/screen-recorder.js
 *
 * Record the screen in the browser and hand back the file: the Video Producer's "Record my screen"
 * (docs/video-producer-screen-walkthrough-plan.md Phase 3, §11.7). The recording then goes into the library
 * like any upload (FootageReader.upload), is read once (FootageReader.prepare), and is used as a walkthrough
 * screen under an AI presenter, or as footage in its own sound ("Use my own footage").
 *
 *   window.ScreenRecorder.open({ onDone: (file|null, { durationS, withVoice }) => {}, mic?: boolean, name?: string })
 *   window.ScreenRecorder.supported()          → true on a computer whose browser can share the screen
 *   window.ScreenRecorder.unsupportedReason()  → the words to show where it can't (phones, tablets, old browsers)
 *
 * Decisions (plan §8): desktop only (D-W5: phone browsers can't share the screen; they can still upload a
 * recording); the screen's own sound OFF by default with a "Keep the screen's sound" tick (D-W6); up to
 * 10 minutes (D-W2, = MAX_FOOTAGE_S in src/lib/footage.ts) and under the 500 MB footage limit.
 * The microphone is optional: on for a recording narrated in the owner's own voice, off for a screen an
 * AI presenter talks over. Captures only, never stores. MP4 where the browser can make it, WebM otherwise.
 */
(function () {
  'use strict';

  const MAX_SECONDS = 600;                      // = MAX_FOOTAGE_S (10 minutes)
  const MAX_BYTES = 480 * 1024 * 1024;          // stops short of the 500 MB footage limit
  const VIDEO_BPS = 2500000;                    // ~190 MB for 10 minutes of 1080p screen
  const WITH_SOUND = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const NO_SOUND = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

  /** Phones and tablets (iPadOS reports a Mac, but with touch points). */
  function isHandheld() {
    const ua = navigator.userAgent || '';
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  }
  function supported() {
    return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function' && window.MediaRecorder) && !isHandheld();
  }
  function unsupportedReason() {
    if (supported()) return '';
    return isHandheld()
      ? 'Recording your screen works on a computer, in Chrome, Edge, Firefox or Safari. On a phone or tablet, use its own screen recorder, then add the video.'
      : 'This browser can’t record your screen. Use Chrome, Edge, Firefox or Safari on a computer, or record with another app and add the video.';
  }
  /** Only Chrome and Edge hand over a shared tab's or screen's sound; Firefox and Safari share the picture only. */
  function canShareSound() {
    return /Chrome\/|Edg\//.test(navigator.userAgent || '') && !/Firefox\//.test(navigator.userAgent || '');
  }
  function pickMimeType(withSound) {
    for (const t of withSound ? WITH_SOUND : NO_SOUND) {
      if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }
  const extFor = (mime) => (/mp4/.test(mime) ? 'mp4' : 'webm');
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const defaultName = () => `Screen recording ${new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  /** A file name from what the owner typed: no path or odd characters, at most 80 characters. */
  const safeName = (s) => (String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || defaultName().replace(/:/g, '.'));

  function open(opts) {
    const o = opts || {};
    const onDone = typeof o.onDone === 'function' ? o.onDone : function () {};
    if (!supported()) {
      window.showToast?.(unsupportedReason(), { icon: '⚠️', duration: 7000 });
      onDone(null);
      return;
    }

    const back = document.createElement('div');
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', 'Record my screen');
    back.setAttribute('data-screen-recorder', '');
    back.style.cssText = 'position:fixed;inset:0;z-index:120;background:rgba(17,24,39,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;';
    back.innerHTML = `
      <div style="background:#fff;border-radius:16px;max-width:600px;width:100%;padding:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-height:calc(100vh - 32px);overflow:auto;">
        <p style="font-size:15px;font-weight:800;color:#111827;margin:0 0 2px;">Record my screen</p>
        <p data-hint style="font-size:12px;color:#6b7280;margin:0 0 10px;">Press “Choose what to share”. Your browser asks which window, tab or screen to record, and recording starts straight away.</p>
        <div data-privacy style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:8px 10px;font-size:12px;color:#78350f;margin:0 0 10px;">
          <strong>Only share the window or tab you need.</strong> Everything in it is recorded, so close emails, customer details and passwords first, and turn on Do Not Disturb so notifications don’t pop up. You watch it back before it’s saved, and it’s saved only to your own My Content.
        </div>
        <div style="position:relative;width:100%;aspect-ratio:16 / 9;background:#111827;border-radius:12px;overflow:hidden;">
          <video data-live muted playsinline autoplay style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;"></video>
          <video data-play playsinline controls style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;background:#000;"></video>
          <p data-empty style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;margin:0;color:#9ca3af;font-size:13px;text-align:center;padding:0 16px;">Your screen shows here while it records.</p>
          <span data-time style="position:absolute;top:8px;left:8px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;font-weight:700;border-radius:6px;padding:2px 6px;font-variant-numeric:tabular-nums;">0:00</span>
        </div>
        <div data-choices style="display:grid;gap:4px;margin-top:10px;font-size:13px;color:#374151;">
          <label style="display:flex;align-items:flex-start;gap:6px;"><input type="checkbox" data-mic${o.mic ? ' checked' : ''} style="margin-top:3px;"> <span>Record my voice too <span style="color:#6b7280;font-size:12px;">— from your microphone, to talk viewers through it yourself</span></span></label>
          <label data-sound-row style="display:${canShareSound() ? 'flex' : 'none'};align-items:flex-start;gap:6px;"><input type="checkbox" data-sound style="margin-top:3px;"> <span>Keep the screen’s sound <span style="color:#6b7280;font-size:12px;">— only for a demo with sound; it also records notification sounds</span></span></label>
          <label style="display:block;margin-top:4px;"><span style="display:block;font-size:12px;font-weight:700;color:#4b5563;margin-bottom:2px;">What’s in this recording?</span>
            <input data-name maxlength="80" style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:6px 8px;font:inherit;font-size:13px;" placeholder="e.g. Booking a class in our app"></label>
          <span style="font-size:11px;color:#6b7280;">The name helps your Video Producer choose which part to show when. Up to 10 minutes.</span>
        </div>
        <p data-status role="status" style="text-align:center;font-size:11px;font-weight:700;color:#6b7280;margin:10px 0 0;text-transform:uppercase;letter-spacing:.06em;">Ready</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">
          <button data-cancel type="button" style="flex:1;padding:10px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;font-size:13px;font-weight:700;color:#6b7280;cursor:pointer;">Cancel</button>
          <button data-start type="button" style="flex:1.4;padding:10px;border-radius:10px;border:none;background:#e11d48;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">● Choose what to share</button>
          <button data-stop type="button" style="flex:1.4;padding:10px;border-radius:10px;border:none;background:#111827;color:#fff;font-size:13px;font-weight:700;cursor:pointer;display:none;">■ Stop recording</button>
          <button data-again type="button" style="flex:1;padding:10px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;font-size:13px;font-weight:700;color:#374151;cursor:pointer;display:none;">Record again</button>
          <button data-use type="button" style="flex:1;padding:10px;border-radius:10px;border:none;background:#059669;color:#fff;font-size:13px;font-weight:700;cursor:pointer;display:none;">Use this</button>
        </div>
      </div>`;
    document.body.appendChild(back);

    const q = (s) => back.querySelector(s);
    const live = q('[data-live]'), play = q('[data-play]'), empty = q('[data-empty]'), timeEl = q('[data-time]');
    const statusEl = q('[data-status]'), hintEl = q('[data-hint]'), micEl = q('[data-mic]'), soundEl = q('[data-sound]'), nameEl = q('[data-name]');
    const startBtn = q('[data-start]'), stopBtn = q('[data-stop]'), againBtn = q('[data-again]'), useBtn = q('[data-use]');
    nameEl.value = typeof o.name === 'string' ? o.name.slice(0, 80) : '';
    let display = null, mic = null, audioCtx = null, recorder = null, chunks = [], bytes = 0;
    let startedAt = 0, durationS = 0, timer = null, blob = null, objectUrl = null, withVoice = false, closed = false;

    const show = (el, on, how) => { el.style.display = on ? (how || 'block') : 'none'; };
    const say = (text, bad) => { hintEl.textContent = text; hintEl.style.color = bad ? '#dc2626' : '#6b7280'; };
    const stopTracks = () => {
      [display, mic].forEach((s) => { if (s) s.getTracks().forEach((t) => t.stop()); });   // ends the browser's "sharing" bar
      display = null; mic = null;
      if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    };
    const cleanup = () => {
      closed = true;
      if (timer) clearInterval(timer);
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* stopping */ } }
      stopTracks();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      document.removeEventListener('keydown', onKey);
    };
    const close = (file) => { cleanup(); back.remove(); onDone(file, file ? { durationS: Math.round(durationS * 10) / 10, withVoice } : undefined); };
    const onKey = (e) => { if (e.key === 'Escape' && !(recorder && recorder.state === 'recording')) { e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', onKey);

    /** One sound track for the recorder: the mic, the screen's sound, both mixed, or none. */
    function soundTrack() {
      const screenSound = display.getAudioTracks()[0] || null;
      const voice = mic ? mic.getAudioTracks()[0] : null;
      if (!screenSound || !voice) return screenSound || voice;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return voice;   // a voice beats notification sounds
      audioCtx = new Ctx();
      audioCtx.resume().catch(() => {});   // made after awaits: never left suspended (review of #792)
      const out = audioCtx.createMediaStreamDestination();
      audioCtx.createMediaStreamSource(new MediaStream([screenSound])).connect(out);
      audioCtx.createMediaStreamSource(new MediaStream([voice])).connect(out);
      return out.stream.getAudioTracks()[0];
    }

    const stop = () => {
      if (!recorder || recorder.state !== 'recording') return;
      durationS = (Date.now() - startedAt) / 1000;
      recorder.stop();
      if (timer) clearInterval(timer);
      statusEl.textContent = 'Recorded — watch it back';
    };

    async function start() {
      say('Choose what to share in your browser’s window…');
      startBtn.disabled = true;
      const keepSound = soundEl.checked;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: keepSound,
          // Chrome: leave this tab out of the list (it would record the recorder) and let them switch what's shared.
          selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: keepSound ? 'include' : 'exclude',
        });
      } catch (err) {
        stopTracks();
        say(err && err.name === 'NotAllowedError' ? 'Nothing was shared, so nothing was recorded. Press “Choose what to share” to try again.' : 'Your screen couldn’t be shared. Check your browser lets this site share the screen, then try again.', true);
        startBtn.disabled = false;
        return;
      }
      // The microphone after the screen: browsers only open the share picker straight from the click.
      try {
        if (micEl.checked) mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        stopTracks();
        say('Your microphone is blocked. Allow it in your browser’s address bar, or untick “Record my voice too”.', true);
        startBtn.disabled = false;
        return;
      }
      if (closed) { stopTracks(); return; }
      try {
        begin(keepSound);
      } catch {
        // e.g. "Stop sharing" pressed while the microphone prompt was open: the share has already ended.
        if (timer) clearInterval(timer);
        recorder = null;
        stopTracks();
        show(live, false); show(empty, true); show(stopBtn, false); show(startBtn, true);
        q('[data-choices]').querySelectorAll('input').forEach((i) => { i.disabled = false; });
        statusEl.textContent = 'Ready';
        say('The recording couldn’t start (was the sharing stopped?). Press “Choose what to share” to try again.', true);
        startBtn.disabled = false;
      }
    }

    /** Record what was shared. Throws when it can't start; start() tidies up. */
    function begin(keepSound) {
      const video = display.getVideoTracks()[0];
      if (!video || video.readyState === 'ended') throw new Error('share ended');
      if (!keepSound) display.getAudioTracks().forEach((t) => { t.stop(); display.removeTrack(t); });
      const sound = soundTrack();
      withVoice = !!mic;
      const stream = new MediaStream(sound ? [video, sound] : [video]);
      const mime = pickMimeType(!!sound);
      const cfg = { videoBitsPerSecond: VIDEO_BPS, ...(sound ? { audioBitsPerSecond: 128000 } : {}), ...(mime ? { mimeType: mime } : {}) };
      try { recorder = new MediaRecorder(stream, cfg); } catch { recorder = new MediaRecorder(stream); }
      chunks = []; bytes = 0;
      recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        chunks.push(e.data); bytes += e.data.size;
        if (bytes >= MAX_BYTES) { stop(); statusEl.textContent = 'Stopped: the recording reached the size limit'; }
      };
      recorder.onerror = () => { stop(); };
      recorder.onstop = () => {
        // The recorder can stop by itself (every track ended) before stop() runs: tidy the timer here too.
        if (timer) { clearInterval(timer); timer = null; }
        if (statusEl.textContent === 'Recording') statusEl.textContent = 'Recorded — watch it back';
        if (!durationS) durationS = (Date.now() - startedAt) / 1000;
        blob = new Blob(chunks, { type: recorder.mimeType || mime || 'video/webm' });
        stopTracks();
        if (closed) return;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(blob);
        play.src = objectUrl;
        show(live, false); show(play, true); show(empty, false);
        show(stopBtn, false); show(againBtn, true); show(useBtn, true);
        say(withVoice ? 'Watch it back. “Use this” saves it to My Content.' : 'Watch it back (it has no sound). “Use this” saves it to My Content.');
      };
      // The browser's own "Stop sharing" button ends the recording too.
      video.addEventListener('ended', stop);
      live.srcObject = new MediaStream([video]);
      show(live, true); show(empty, false); show(play, false);
      q('[data-choices]').querySelectorAll('input').forEach((i) => { if (i !== nameEl) i.disabled = true; });
      recorder.start(1000);
      startedAt = Date.now(); durationS = 0;
      show(startBtn, false); show(stopBtn, true);
      startBtn.disabled = false;
      statusEl.textContent = 'Recording';
      say('Recording. Press “Stop recording” here, or “Stop sharing” in your browser, when you’re done.');
      timer = setInterval(() => {
        if (!recorder || recorder.state !== 'recording') return;
        const s = (Date.now() - startedAt) / 1000;
        timeEl.textContent = fmtTime(s);
        if (s >= MAX_SECONDS) { stop(); statusEl.textContent = `Stopped at ${fmtTime(MAX_SECONDS)}, the longest a recording can be`; }
      }, 250);
    }

    startBtn.addEventListener('click', () => { start(); });
    stopBtn.addEventListener('click', stop);
    againBtn.addEventListener('click', () => {
      blob = null; durationS = 0; timeEl.textContent = '0:00';
      play.removeAttribute('src'); play.load();
      show(play, false); show(empty, true); show(againBtn, false); show(useBtn, false); show(startBtn, true);
      q('[data-choices]').querySelectorAll('input').forEach((i) => { i.disabled = false; });
      statusEl.textContent = 'Ready';
      say('Press “Choose what to share” to record again.');
    });
    q('[data-cancel]').addEventListener('click', () => close(null));
    useBtn.addEventListener('click', () => {
      if (!blob) return;
      const type = (blob.type || 'video/webm').split(';')[0];
      close(new File([blob], `${safeName(nameEl.value || defaultName())}.${extFor(type)}`, { type }));
    });
  }

  window.ScreenRecorder = { open, supported, unsupportedReason };
})();
