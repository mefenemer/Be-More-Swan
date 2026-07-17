/**
 * src/components/speech-recognition.js
 *
 * Shared Web Speech API recogniser for the workspace mic buttons.
 *
 * DOM-agnostic on purpose: this owns the SpeechRecognition lifecycle only —
 * vendor lookup, flags, final/interim accumulation, the optional time limit,
 * and the try/catch around start()/stop(). Callers own their own button state,
 * status copy and unsupported-browser messaging, which differ per surface.
 *
 *   window.SwanSpeech.isSupported() -> boolean
 *   window.SwanSpeech.start(opts)   -> handle | null   (null = could not start)
 *
 * opts:
 *   lang            {string}   default 'en-GB'
 *   interimResults  {boolean}  default false
 *   continuous      {boolean}  default false
 *   maxAlternatives {number}   omitted when falsy (leaves the browser default)
 *   limitMs         {number}   auto-stop after this long; omit for no limit
 *   onTranscript    {fn}       ({ transcript, final, interim, chunk })
 *   onEnd           {fn}       ({ transcript }) — fires on natural end AND stop()
 *   onError         {fn}       (error, event)
 *
 * onTranscript payload: `chunk` is only the text finalised by THIS event, while
 * `final` accumulates every chunk so far and `transcript` is `final + interim`.
 * Append-style callers want `chunk`; replace-style callers want `transcript`.
 *
 * handle: { stop(), isActive() }
 */
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function isSupported() {
    return !!SR;
  }

  function start(opts) {
    const o = opts || {};
    if (!SR) return null;

    const rec = new SR();
    rec.lang = o.lang || 'en-GB';
    rec.interimResults = !!o.interimResults;
    rec.continuous = !!o.continuous;
    if (o.maxAlternatives) rec.maxAlternatives = o.maxAlternatives;

    let final = '';
    let stopped = false;
    let limitTimer = null;

    function clearLimit() {
      if (limitTimer) { clearTimeout(limitTimer); limitTimer = null; }
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      clearLimit();
      try { rec.stop(); } catch {}
    }

    rec.onresult = (e) => {
      let chunk = '', interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) chunk += t; else interim += t;
      }
      final += chunk;
      if (o.onTranscript) o.onTranscript({ transcript: final + interim, final, interim, chunk });
    };

    rec.onerror = (e) => {
      clearLimit();
      if (o.onError) o.onError((e && e.error) || 'unknown', e);
    };

    // Fires for a natural end, an error, and an explicit stop() alike, so it is
    // the single place callers can rely on to tear their own UI back down.
    rec.onend = () => {
      stopped = true;
      clearLimit();
      if (o.onEnd) o.onEnd({ transcript: final });
    };

    try {
      rec.start();
    } catch (err) {
      stopped = true;
      clearLimit();
      if (o.onError) o.onError('start-failed', err);
      return null;
    }

    if (o.limitMs) limitTimer = setTimeout(stop, o.limitMs);

    return { stop, isActive: () => !stopped };
  }

  window.SwanSpeech = { isSupported, start };
})();
