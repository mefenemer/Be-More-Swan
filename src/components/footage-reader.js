/**
 * src/components/footage-reader.js — the browser "watches" the owner's video for the Video Producer
 * (docs/video-producer-footage-and-ai-plan.md §4.2).
 *
 * No server function can open a video file, so this does it here, once per video:
 *   · measures its length and size
 *   · grabs a frame about every 2 seconds (at most 40, the rule in src/lib/footage.ts frameTimes),
 *     ~512 px JPEGs
 *   · decodes the sound and writes it as a 16 kHz mono WAV (~10 MB for five minutes), or nothing when
 *     the video is silent
 * then hands them to netlify/functions/footage.ts (the WAV goes straight to storage by a signed PUT).
 *
 *   window.FootageReader.prepare(assetId, source, { onProgress }) → Promise<void>
 *     source: a File (just uploaded — no download needed) or the video's URL (a library video). A URL
 *     is downloaded ONCE, with the cache skipped, and read from memory. Not straight into a <video>:
 *     the library's thumbnails load the SAME signed URL without CORS (the URL is kept stable so the
 *     browser caches it), and a CORS request then gets that cached copy with no CORS header — the
 *     video "couldn't be opened" on staging, 2026-11-09, although R2's CORS rules were right.
 *   window.FootageReader.upload(file) → Promise<{ id, name }>   a new video into the library (My Content)
 *
 * Nothing here spends. Reading a library video downloads it once into this tab.
 */
(function () {
  const MAX_FRAMES = 40;
  const FRAME_EVERY_S = 2;
  const MAX_S = 5 * 60;
  const MAX_BYTES = 500 * 1024 * 1024;
  const FRAME_PX = 512;
  const RATE = 16000;
  const API = '/.netlify/functions/footage';

  function frameTimes(durationS) {
    if (!(durationS > 0)) return [];
    const n = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(durationS / FRAME_EVERY_S)));
    const step = durationS / n;
    return Array.from({ length: n }, (_, i) => Math.round(Math.min(durationS - 0.05, step * i + step / 2) * 100) / 100);
  }

  const once = (el, ok, bad, ms) => new Promise((resolve, reject) => {
    let timer = null;
    const done = (fn, v) => { clearTimeout(timer); el.removeEventListener(ok, onOk); el.removeEventListener('error', onBad); fn(v); };
    const onOk = () => done(resolve);
    const onBad = () => done(reject, new Error(bad));
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onBad);
    timer = setTimeout(() => done(reject, new Error(bad)), ms || 20000);
  });

  async function openVideo(src) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.src = src;
    await once(v, 'loadedmetadata', 'That video couldn’t be opened in your browser. Try an MP4.', 30000);
    if (!Number.isFinite(v.duration)) {
      // Some WebM files report Infinity until the end is visited.
      v.currentTime = 1e9;
      await once(v, 'seeked', 'That video couldn’t be measured.', 30000).catch(() => {});
    }
    return v;
  }

  async function grabFrames(v, onProgress) {
    const times = frameTimes(v.duration);
    const scale = Math.min(1, FRAME_PX / Math.max(v.videoWidth || FRAME_PX, v.videoHeight || FRAME_PX));
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round((v.videoWidth || FRAME_PX) * scale));
    c.height = Math.max(2, Math.round((v.videoHeight || FRAME_PX) * scale));
    const g = c.getContext('2d');
    const frames = [];
    for (let i = 0; i < times.length; i++) {
      v.currentTime = times[i];
      await once(v, 'seeked', 'A frame couldn’t be read from that video.', 15000);
      g.drawImage(v, 0, 0, c.width, c.height);
      let data;
      try { data = c.toDataURL('image/jpeg', 0.6).split(',')[1]; } catch {
        throw new Error('Your browser wouldn’t let the video be read. Reload the page and try again.');
      }
      frames.push({ t: times[i], data });
      onProgress?.(`Looking at your video… ${Math.round(((i + 1) / times.length) * 70)}%`);
    }
    return frames;
  }

  /**
   * The sound: a 16 kHz mono 16-bit WAV (null when there's none worth reading) and its loudness every
   * 0.1 s (RMS × 1000) — the tightening safety net (src/lib/footage.ts restoreLoudGaps).
   */
  async function soundAsWav(source, durationS) {
    let buf;
    try {
      buf = source instanceof Blob ? await source.arrayBuffer() : await (await fetch(source, { mode: 'cors' })).arrayBuffer();
    } catch { return null; }
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) return null;
    let audio;
    try {
      const ctx = new Ctx(1, Math.max(1, Math.ceil(durationS * RATE)), RATE);
      audio = await new Promise((resolve, reject) => {
        const p = ctx.decodeAudioData(buf, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
    } catch { return null; }   // no sound track, or one the browser can't decode
    // decodeAudioData resamples to the context's rate; mix the channels down to one.
    const n = audio.length;
    const mono = new Float32Array(n);
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const d = audio.getChannelData(ch);
      for (let i = 0; i < n; i++) mono[i] += d[i] / audio.numberOfChannels;
    }
    const step = RATE / 10;
    const loudness = [];
    for (let s = 0; s < n; s += step) {
      let e = 0;
      const end = Math.min(n, s + step);
      for (let i = s; i < end; i++) e += mono[i] * mono[i];
      loudness.push(Math.min(1000, Math.round(Math.sqrt(e / Math.max(1, end - s)) * 1000)));
    }
    let sum = 0;
    for (let i = 0; i < n; i += 16) sum += mono[i] * mono[i];
    if (Math.sqrt(sum / Math.max(1, n / 16)) < 0.002) return { wav: null, loudness: [] };   // silence: nothing to transcribe
    const out = new DataView(new ArrayBuffer(44 + n * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, mono[i])) * 0x7fff, true);
    return { wav: new Blob([out.buffer], { type: 'audio/wav' }), loudness };
  }

  async function post(body) {
    const r = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.error || `That didn’t work (HTTP ${r.status}).`);
    return j;
  }

  /** A library video's bytes, fresh from storage (never the cached non-CORS copy). */
  async function download(url, onProgress) {
    onProgress?.('Fetching your video…');
    let r;
    try { r = await fetch(url, { mode: 'cors', cache: 'no-store', credentials: 'omit' }); } catch {
      throw new Error('Your video couldn’t be fetched. Check your connection and try again.');
    }
    if (!r.ok) throw new Error(`Your video couldn’t be fetched (HTTP ${r.status}). Reload the page and try again.`);
    const blob = await r.blob();
    if (blob.size > MAX_BYTES) throw new Error('That video is larger than 500 MB. Trim it first, or pick the part you want.');
    return blob;
  }

  async function prepare(assetId, source, opts) {
    const onProgress = opts && opts.onProgress;
    if (!source) throw new Error('That video couldn’t be found. Reload the page and try again.');
    if (!(source instanceof Blob)) source = await download(String(source), onProgress);
    if (source instanceof Blob && source.size > MAX_BYTES) throw new Error('That video is larger than 500 MB. Trim it first, or pick the part you want.');
    const src = source instanceof Blob ? URL.createObjectURL(source) : source;
    try {
      onProgress?.('Opening your video…');
      const v = await openVideo(src);
      const durationS = v.duration;
      if (!(durationS > 0.5)) throw new Error('That video is too short to use.');
      if (durationS > MAX_S + 1) throw new Error('That video is longer than 5 minutes. Trim it first, or pick the part you want.');
      const frames = await grabFrames(v, onProgress);
      const width = v.videoWidth || null, height = v.videoHeight || null;
      v.removeAttribute('src'); v.load();
      onProgress?.('Listening to your video… 80%');
      const { wav, loudness } = (await soundAsWav(source instanceof Blob ? source : src, durationS)) || { wav: null, loudness: [] };
      let audioKey = null;
      if (wav) {
        const { uploadUrl, key } = await post({ action: 'audio_url', assetId, size: wav.size });
        const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: wav });
        if (!put.ok) throw new Error('The sound couldn’t be saved. Please try again.');
        audioKey = key;
      }
      onProgress?.('Saving what it saw… 95%');
      await post({ action: 'prepare', assetId, durationS, width, height, frames, audioKey, loudness });
    } finally {
      if (source instanceof Blob) URL.revokeObjectURL(src);
    }
  }

  /** A new video into the library — the same path as My Content (content-upload-url → PUT → content-assets). */
  async function upload(file) {
    if (!file || !/^video\//.test(file.type)) throw new Error('That isn’t a video. Choose an MP4, MOV or WebM.');
    if (file.size > MAX_BYTES) throw new Error('That video is larger than 500 MB. Trim it first, or pick the part you want.');
    const r = await fetch('/.netlify/functions/content-upload-url', {
      credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, mimeType: file.type, fileSize: file.size }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Could not start the upload.');
    if (!j.mock) {
      const put = await fetch(j.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!put.ok) throw new Error('The upload failed. Please try again.');
    }
    // Measured here so the library knows its length straight away.
    let durationS = null, width = null, height = null;
    try {
      const url = URL.createObjectURL(file);
      const v = await openVideo(url);
      durationS = Number.isFinite(v.duration) ? v.duration : null; width = v.videoWidth || null; height = v.videoHeight || null;
      URL.revokeObjectURL(url);
    } catch { /* the server copes without */ }
    const c = await fetch('/.netlify/functions/content-assets', {
      credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, assetType: 'video', mimeType: file.type, fileSize: file.size, storageKey: j.storageKey, storageUrl: j.storageUrl, durationS, width, height }),
    });
    const d = await c.json().catch(() => ({}));
    if (!c.ok) throw new Error(d.error || 'The upload failed. Please try again.');
    if (d.rejected) throw new Error((d.asset && d.asset.rejectionReason) || 'That video was flagged and can’t be used.');
    return { id: d.asset.id, name: d.asset.name || file.name };
  }

  window.FootageReader = { prepare, upload, frameTimes };
})();
