// src/i18n.js
// US-I18N-1.1: Client-side i18n utility for public pages.
//
// Usage:
//   <script src="/src/i18n.js"></script>
//   Elements: <span data-i18n="nav.pricing"></span>
//   Attrs:    <input data-i18n-placeholder="common.submit">
//             <button data-i18n-title="common.close">
//   Page meta: <title data-i18n-title-key="pricing.title">
//              <meta name="description" data-i18n-meta-key="pricing.subtitle">
//
// Call window.i18n.apply() after dynamic content is injected.

(function () {
  const SUPPORTED = ['en', 'fr', 'de', 'es', 'pt'];
  const FALLBACK = 'en';
  const STORAGE_KEY = 'aura_lang';

  // Cache of loaded locale data
  const _cache = {};

  // Active translations object
  let _t = {};
  let _lang = FALLBACK;

  function detectBrowserLang() {
    const nav = navigator.language || navigator.userLanguage || '';
    const code = nav.slice(0, 2).toLowerCase();
    return SUPPORTED.includes(code) ? code : null;
  }

  function getStoredLang() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }

  function storeLang(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
  }

  function resolveLang() {
    const stored = getStoredLang();
    if (stored && SUPPORTED.includes(stored)) return stored;
    const browser = detectBrowserLang();
    if (browser) return browser;
    return FALLBACK;
  }

  async function loadLocale(lang) {
    if (_cache[lang]) return _cache[lang];
    try {
      const res = await fetch(`/locales/${lang}.json`);
      if (!res.ok) throw new Error('not found');
      const data = await res.json();
      _cache[lang] = data;
      return data;
    } catch {
      if (lang !== FALLBACK) return loadLocale(FALLBACK);
      return {};
    }
  }

  // Resolve a dotted key like "nav.pricing" from translations object
  function resolve(key) {
    if (!key) return '';
    const parts = key.split('.');
    let obj = _t;
    for (const p of parts) {
      if (obj == null || typeof obj !== 'object') return key;
      obj = obj[p];
    }
    // Fallback: if value is missing, try English cache
    if (obj == null && _lang !== FALLBACK && _cache[FALLBACK]) {
      let fb = _cache[FALLBACK];
      for (const p of parts) {
        if (fb == null || typeof fb !== 'object') return key;
        fb = fb[p];
      }
      return fb != null ? String(fb) : key;
    }
    return obj != null ? String(obj) : key;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Runtime machine translation (#1). For the authenticated app, most UI is NOT
  // hand-tagged with data-i18n keys, so after the dictionary pass we machine-translate
  // any remaining visible text via /translate (Claude-backed, server-cached). Public
  // marketing pages keep the curated dictionary; there /translate returns 401 and the MT
  // layer disables itself for the session. Opt out of MT with data-no-i18n on a subtree.
  // ─────────────────────────────────────────────────────────────────────────
  const MT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'NOSCRIPT', 'OPTION']);
  const MT_ATTRS = ['placeholder', 'title', 'aria-label'];
  const _mtCache = {};                 // { lang: Map(source → translation) }
  const _mtOriginalText = new WeakMap(); // textNode → original English nodeValue
  let _mtDisabled = false;             // set true after a 401 (unauthenticated page)
  const hasLetters = (s) => /\p{L}/u.test(s);

  function mtCacheFor(lang) {
    if (!_mtCache[lang]) {
      _mtCache[lang] = new Map();
      try {
        const raw = localStorage.getItem('ui_tr_' + lang);
        if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) _mtCache[lang].set(k, v);
      } catch {}
    }
    return _mtCache[lang];
  }
  function mtSaveCache(lang) {
    try {
      const entries = Array.from(_mtCache[lang].entries()).slice(-2000);
      localStorage.setItem('ui_tr_' + lang, JSON.stringify(Object.fromEntries(entries)));
    } catch {}
  }

  async function mtTranslate(lang, sources) {
    const out = [];
    for (let i = 0; i < sources.length; i += 180) {
      const chunk = sources.slice(i, i + 180);
      try {
        const res = await fetch('/.netlify/functions/translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lang, strings: chunk }),
        });
        if (res.status === 401) { _mtDisabled = true; return null; }
        if (!res.ok) throw new Error('translate failed');
        const data = await res.json();
        (data.translations || chunk).forEach(t => out.push(t));
      } catch { chunk.forEach(s => out.push(s)); }
    }
    return out;
  }

  async function machineTranslate(root) {
    if (_mtDisabled || !SUPPORTED.includes(_lang)) return;
    const scope = root && root.nodeType === 1 ? root : document.body;
    if (!scope) return;

    // Switching back to English → restore every node/attr we previously translated.
    if (_lang === FALLBACK) {
      const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
      let tn; while ((tn = w.nextNode())) {
        if (_mtOriginalText.has(tn)) tn.nodeValue = _mtOriginalText.get(tn);
      }
      scope.querySelectorAll && scope.querySelectorAll('[placeholder],[title],[aria-label]').forEach(el => {
        MT_ATTRS.forEach(a => {
          const key = 'i18nEn' + a.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
          if (el.dataset[key] !== undefined) el.setAttribute(a, el.dataset[key]);
        });
      });
      return;
    }

    const cache = mtCacheFor(_lang);

    // Collect text nodes (working from each node's stored English original).
    const parts = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || MT_SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest('[data-no-i18n]') || p.hasAttribute('data-i18n')) return NodeFilter.FILTER_REJECT;
        const original = _mtOriginalText.get(n) ?? n.nodeValue;
        if (!original || !original.trim() || !hasLetters(original)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n; while ((n = walker.nextNode())) {
      const original = _mtOriginalText.get(n) ?? n.nodeValue;
      if (!_mtOriginalText.has(n)) _mtOriginalText.set(n, original);
      const lead = original.match(/^\s*/)[0], trail = original.match(/\s*$/)[0], core = original.trim();
      parts.push({ n, lead, trail, core });
    }

    // Collect translatable attributes (store original in dataset once).
    const attrEls = [];
    scope.querySelectorAll('[placeholder],[title],[aria-label]').forEach(el => {
      if (el.closest('[data-no-i18n]')) return;
      attrEls.push(el);
    });

    // Gather unique strings that aren't cached yet.
    const need = new Set();
    parts.forEach(p => { if (!cache.has(p.core)) need.add(p.core); });
    attrEls.forEach(el => MT_ATTRS.forEach(a => {
      const key = 'i18nEn' + a.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
      const original = el.dataset[key] ?? el.getAttribute(a);
      if (original && original.trim() && hasLetters(original) && !cache.has(original.trim())) need.add(original.trim());
    }));

    if (need.size) {
      const sources = Array.from(need);
      const translated = await mtTranslate(_lang, sources);
      if (translated === null) return; // disabled mid-flight (401)
      sources.forEach((s, i) => cache.set(s, translated[i] ?? s));
      mtSaveCache(_lang);
    }

    // Swap text nodes.
    parts.forEach(({ n, lead, trail, core }) => {
      const t = cache.get(core);
      if (t && t !== core) n.nodeValue = lead + t + trail;
    });
    // Swap attributes (remember the English original so language switches re-translate).
    attrEls.forEach(el => MT_ATTRS.forEach(a => {
      const key = 'i18nEn' + a.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
      if (el.dataset[key] === undefined) {
        const cur = el.getAttribute(a);
        if (cur && cur.trim()) el.dataset[key] = cur;
      }
      const original = el.dataset[key];
      if (!original) return;
      const t = cache.get(original.trim());
      if (t && t !== original.trim()) el.setAttribute(a, t);
    }));
  }

  // Apply translations to all data-i18n elements in a container
  function apply(root) {
    root = root || document;

    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = resolve(key);
      if (val !== key) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.value = val;
        } else {
          el.textContent = val;
        }
      }
    });

    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const val = resolve(el.getAttribute('data-i18n-placeholder'));
      if (val) el.placeholder = val;
    });

    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      const val = resolve(el.getAttribute('data-i18n-title'));
      if (val) el.title = val;
    });

    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      const val = resolve(el.getAttribute('data-i18n-html'));
      if (val !== el.getAttribute('data-i18n-html')) el.innerHTML = val;
    });

    // Page title
    const titleKeyEl = document.querySelector('[data-i18n-title-key]');
    if (titleKeyEl) {
      const val = resolve(titleKeyEl.getAttribute('data-i18n-title-key'));
      if (val) document.title = val + ' | Be More Swan';
    }

    // Meta description
    const metaEl = document.querySelector('meta[data-i18n-meta-key]');
    if (metaEl) {
      const val = resolve(metaEl.getAttribute('data-i18n-meta-key'));
      if (val) metaEl.setAttribute('content', val);
    }

    // Runtime machine-translation pass for everything not covered by the dictionary.
    // Fire-and-forget (async) so it never blocks the dictionary render.
    machineTranslate(root === document ? document.body : root);
  }

  // Inject hreflang link tags (SC4)
  function injectHreflang() {
    const base = window.location.origin + window.location.pathname;
    SUPPORTED.forEach(lang => {
      const existing = document.querySelector(`link[hreflang="${lang}"]`);
      if (!existing) {
        const link = document.createElement('link');
        link.rel = 'alternate';
        link.hreflang = lang;
        link.href = base + `?lang=${lang}`;
        document.head.appendChild(link);
      }
    });
    // x-default
    if (!document.querySelector('link[hreflang="x-default"]')) {
      const def = document.createElement('link');
      def.rel = 'alternate';
      def.hreflang = 'x-default';
      def.href = base;
      document.head.appendChild(def);
    }
  }

  // Public: switch to a language and re-render
  async function setLang(lang) {
    if (!SUPPORTED.includes(lang)) return;
    _lang = lang;
    storeLang(lang);
    _t = await loadLocale(lang);
    document.documentElement.lang = lang;
    apply();
    // Update selector if present
    document.querySelectorAll('.i18n-lang-selector').forEach(sel => { sel.value = lang; });
    // Dispatch event so page-specific scripts can react
    window.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang } }));
  }

  // Public: get a translation value
  function t(key) { return resolve(key); }

  // Bootstrap on DOMContentLoaded
  async function init() {
    // Allow ?lang= query param to override
    const urlLang = new URLSearchParams(window.location.search).get('lang');
    const targetLang = (urlLang && SUPPORTED.includes(urlLang)) ? urlLang : resolveLang();
    _lang = targetLang;
    if (urlLang && SUPPORTED.includes(urlLang)) storeLang(urlLang);

    _t = await loadLocale(_lang);
    document.documentElement.lang = _lang;
    apply();
    injectHreflang();
  }

  // Expose global API
  window.i18n = { init, setLang, t, apply, SUPPORTED, resolveLang };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
