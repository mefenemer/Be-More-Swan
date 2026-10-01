/**
 * subscribe.js — the sign-up form renderer. ONE copy, three surfaces:
 *
 *   1. EMBED, on a customer's own website:
 *        <div id="bms-subscribe"></div>
 *        <script async src="https://bemoreswan.com/subscribe.js" data-bms-form="aud_ab12…"></script>
 *   2. HOSTED, the page we serve at /f/<slug> and /s/<key> (audience-public.ts inlines the definition
 *      and loads this file with data-bms-hosted).
 *   3. PREVIEW, inside the form builder and the chat card: window.BmsForm.render(def, host, { preview: true }).
 *
 * The definition it draws is the PUBLIC subset of src/utils/form-definition.ts (publicDefinition):
 * content, fields, consent, style tokens. It has already passed normaliseFormDefinition on the
 * server — but a preview draws UNSAVED edits, so every style token is re-checked here as well. These
 * values become CSS on somebody else's website; nothing reaches a <style> block that is not a hex
 * colour or a value from a fixed list.
 *
 * Shadow DOM so the host site's CSS and ours can never collide. No dependencies.
 *
 * ⚠️ ES5-flavoured on purpose (var, function, no template literals, no arrow functions). This runs on
 * other people's websites, including ones that still transpile or proxy scripts through old tooling;
 * a syntax error here is a broken page a customer will blame on their own site.
 */
(function () {
  'use strict';

  var HEX = /^#[0-9a-f]{6}$/i;
  var FONTS = {
    inherit: 'inherit',
    system: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
    serif: 'Georgia,"Times New Roman",Times,serif',
    rounded: 'ui-rounded,"SF Pro Rounded","Nunito","Segoe UI",sans-serif',
    mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
  };
  var RADII = { none: '0', small: '.5rem', large: '1rem' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function hex(v, d) { return typeof v === 'string' && HEX.test(v) ? v : d; }
  function pick(map, v, d) { return Object.prototype.hasOwnProperty.call(map, v) ? map[v] : map[d]; }

  /** A logo is only ever drawn from our own origin (the media proxy) — never an arbitrary URL. */
  function safeLogo(url, apiBase) {
    if (typeof url !== 'string' || !url) return '';
    if (url.charAt(0) === '/' && url.charAt(1) !== '/') return (apiBase || '') + url;
    if (apiBase && url.indexOf(apiBase + '/') === 0) return url;
    return '';
  }

  function styleSheet(st, surface) {
    var accent = hex(st.accent, '#059669');
    var bg = hex(st.background, '#ffffff');
    var text = hex(st.text, '#111827');
    var font = pick(FONTS, st.font, 'system');
    if (font === 'inherit' && surface === 'hosted') font = FONTS.system;   // nothing to inherit on our page
    var radius = pick(RADII, st.radius, 'small');
    var card = surface !== 'embed';
    return '' +
      ':host{all:initial;display:block}' +
      '.bms-w{font-family:' + font + ';color:' + text + ';max-width:' + (card ? '28rem' : '36rem') + ';line-height:1.5;' +
        (card ? 'background:' + bg + ';border-radius:calc(' + radius + ' * 2);box-shadow:0 4px 24px rgba(0,0,0,.08);padding:2rem;margin:0 auto;' : '') + '}' +
      '.bms-logo{display:block;max-height:3rem;max-width:12rem;margin:0 0 1rem}' +
      '.bms-h{font-size:1.3rem;font-weight:700;margin:0 0 .25rem}' +
      '.bms-who{font-size:.8rem;opacity:.65;margin:0 0 .75rem}' +
      '.bms-intro{font-size:.95rem;margin:0 0 1.1rem;white-space:pre-line;opacity:.85}' +
      '.bms-f{display:block}.bms-f.bms-inline{display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap}' +
      '.bms-f.bms-inline .bms-q{flex:1;min-width:14rem;margin-bottom:0}' +
      '.bms-q{margin:0 0 .85rem;border:0;padding:0;min-width:0}' +
      '.bms-l{display:block;font-size:.8125rem;font-weight:600;margin:0 0 .3rem}' +
      '.bms-req{color:#b91c1c}' +
      '.bms-help{display:block;font-size:.75rem;opacity:.7;margin:.25rem 0 0}' +
      '.bms-i{display:block;width:100%;box-sizing:border-box;font-size:.9375rem;padding:.6rem .7rem;border:1px solid #d1d5db;' +
        'border-radius:' + radius + ';background:#fff;color:#111827;font-family:inherit}' +
      'textarea.bms-i{min-height:5.5rem;resize:vertical}' +
      '.bms-i:focus{outline:2px solid ' + accent + ';outline-offset:1px;border-color:' + accent + '}' +
      '.bms-opt{display:flex;align-items:flex-start;gap:.5rem;font-size:.9rem;margin:.25rem 0;cursor:pointer}' +
      '.bms-opt input{margin-top:.2rem;accent-color:' + accent + '}' +
      '.bms-b{cursor:pointer;font-family:inherit;font-size:.9375rem;font-weight:700;color:#fff;background:' + accent + ';' +
        'border:none;border-radius:' + radius + ';padding:.7rem 1.15rem;' + (card ? 'width:100%;' : '') + '}' +
      '.bms-b[disabled]{opacity:.6;cursor:not-allowed}' +
      '.bms-c{font-size:.75rem;opacity:.7;margin:.75rem 0 0}' +
      '.bms-m{font-size:.875rem;margin:.75rem 0 0}.bms-m:empty{display:none}' +
      '.bms-ok{color:#065f46}.bms-err{color:#b91c1c}' +
      '.bms-foot{text-align:center;font-size:.7rem;opacity:.5;margin:1.25rem 0 0}' +
      /* The honeypot. Off-screen rather than display:none — some bots skip hidden fields but fill
         everything else, and a field that is not rendered at all catches nobody. */
      '.bms-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;overflow:hidden}';
  }

  function fieldHtml(f) {
    var id = 'bms-' + esc(f.id);
    var req = f.required ? ' <span class="bms-req" aria-hidden="true">*</span>' : '';
    var help = f.help ? '<span class="bms-help" id="' + id + '-h">' + esc(f.help) + '</span>' : '';
    var desc = f.help ? ' aria-describedby="' + id + '-h"' : '';
    var opts = f.options || [];
    var i, h;

    if (f.type === 'radio' || (f.type === 'checkbox' && opts.length > 1)) {
      h = '<fieldset class="bms-q" data-q="' + esc(f.id) + '"' + desc + '><legend class="bms-l">' + esc(f.label) + req + '</legend>';
      for (i = 0; i < opts.length; i++) {
        h += '<label class="bms-opt"><input type="' + (f.type === 'radio' ? 'radio' : 'checkbox') + '" name="' + esc(f.id) + '" value="' + esc(opts[i].value) + '"> <span>' + esc(opts[i].label) + '</span></label>';
      }
      return h + help + '</fieldset>';
    }
    if (f.type === 'checkbox') {
      return '<div class="bms-q" data-q="' + esc(f.id) + '"><label class="bms-opt"><input type="checkbox" name="' + esc(f.id) + '" value="' + esc(opts[0] ? opts[0].value : 'yes') + '"' + desc + '> <span>' + esc(f.label) + req + '</span></label>' + help + '</div>';
    }
    h = '<div class="bms-q" data-q="' + esc(f.id) + '"><label class="bms-l" for="' + id + '">' + esc(f.label) + req + '</label>';
    if (f.type === 'select') {
      h += '<select class="bms-i" id="' + id + '" name="' + esc(f.id) + '"' + desc + (f.required ? ' required' : '') + '><option value="">' + esc(f.placeholder || 'Choose…') + '</option>';
      for (i = 0; i < opts.length; i++) h += '<option value="' + esc(opts[i].value) + '">' + esc(opts[i].label) + '</option>';
      h += '</select>';
    } else if (f.type === 'textarea') {
      h += '<textarea class="bms-i" id="' + id + '" name="' + esc(f.id) + '" placeholder="' + esc(f.placeholder) + '"' + desc + (f.required ? ' required' : '') + '></textarea>';
    } else {
      var type = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text';
      var auto = f.type === 'email' ? ' autocomplete="email"' : f.type === 'phone' ? ' autocomplete="tel"' : '';
      h += '<input class="bms-i" id="' + id + '" name="' + esc(f.id) + '" type="' + type + '" placeholder="' + esc(f.placeholder) + '"' + auto + desc + (f.required ? ' required' : '') + '>';
    }
    return h + help + '</div>';
  }

  function collect(shadow, fields) {
    var answers = {};
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var els = shadow.querySelectorAll('[name="' + f.id.replace(/"/g, '') + '"]');
      if (f.type === 'checkbox') {
        var vals = [];
        for (var j = 0; j < els.length; j++) if (els[j].checked) vals.push(els[j].value);
        answers[f.id] = vals;
      } else if (f.type === 'radio') {
        for (var k = 0; k < els.length; k++) if (els[k].checked) answers[f.id] = els[k].value;
      } else if (els[0]) {
        answers[f.id] = els[0].value;
      }
    }
    return answers;
  }

  /**
   * Draw a form.
   * @param def   the public definition
   * @param host  the element to render into (gets a shadow root)
   * @param opts  { surface: 'embed'|'hosted'|'preview', key, slug, apiBase, preview }
   */
  function render(def, host, opts) {
    opts = opts || {};
    var surface = opts.surface || 'embed';
    var content = def.content || {};
    var st = def.style || {};
    var fields = (def.fields && def.fields.length) ? def.fields : [{ id: 'f_email', type: 'email', label: 'Email', required: true, options: [] }];
    var consent = def.consent || {};
    var inline = st.layout === 'inline' && fields.length === 1;
    var showHeader = surface !== 'embed' || content.headline || content.intro;
    // A preview (the form builder, on our own page) may pass a library thumbnail for a logo that has
    // not been saved yet. Never honoured outside preview mode — a live form only draws our own path.
    var logo = opts.preview && opts.previewLogoUrl ? String(opts.previewLogoUrl) : safeLogo(st.logoUrl, opts.apiBase);

    var shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    var qs = '';
    for (var i = 0; i < fields.length; i++) qs += fieldHtml(fields[i]);

    shadow.innerHTML =
      '<style>' + styleSheet(st, surface === 'preview' ? (opts.previewAs || 'hosted') : surface) + '</style>' +
      '<div class="bms-w">' +
        (showHeader ? (
          (logo ? '<img class="bms-logo" src="' + esc(logo) + '" alt="' + esc(def.senderName || '') + '">' : '') +
          (content.headline ? '<p class="bms-h">' + esc(content.headline) + '</p>' : '') +
          (surface !== 'embed' && def.senderName ? '<p class="bms-who">from ' + esc(def.senderName) + '</p>' : '') +
          (content.intro ? '<p class="bms-intro">' + esc(content.intro) + '</p>' : '')
        ) : '') +
        '<form class="bms-f' + (inline ? ' bms-inline' : '') + '" novalidate>' +
          qs +
          (consent.requireCheckbox
            ? '<div class="bms-q"><label class="bms-opt"><input type="checkbox" name="bms-consent" required> <span class="bms-c" style="margin:0">' + esc(consent.text) + '</span></label></div>'
            : '') +
          '<div class="bms-hp" aria-hidden="true"><label>Leave this field empty<input name="bms-website" type="text" tabindex="-1" autocomplete="off"></label></div>' +
          '<button class="bms-b" type="submit">' + esc(content.buttonLabel || 'Subscribe') + '</button>' +
        '</form>' +
        (consent.requireCheckbox ? '' : '<p class="bms-c">' + esc(consent.text || '') + '</p>') +
        '<p class="bms-m" role="status" aria-live="polite"></p>' +
        (surface === 'hosted' ? '<p class="bms-foot">Powered by Be More Swan</p>' : '') +
      '</div>';

    var shownAt = Date.now();
    var form = shadow.querySelector('form');
    var button = shadow.querySelector('.bms-b');
    var msg = shadow.querySelector('.bms-m');

    function say(text, ok) { msg.textContent = text; msg.className = 'bms-m ' + (ok ? 'bms-ok' : 'bms-err'); }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      say('', true);
      var answers = collect(shadow, fields);

      // Client-side checks are a courtesy for the visitor. The server checks everything again
      // against the stored definition and is the only one that counts.
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i], v = answers[f.id];
        var empty = v == null || v === '' || (v.length === 0 && typeof v !== 'string');
        if (f.required && empty) { say('Please answer "' + f.label + '".', false); return; }
        if (f.type === 'email' && (!v || String(v).indexOf('@') < 0)) { say('Please enter a valid email address.', false); return; }
      }
      var consentBox = shadow.querySelector('[name="bms-consent"]');
      if (consentBox && !consentBox.checked) { say('Please tick the box to agree before signing up.', false); return; }

      if (opts.preview) { say(content.successMessage || 'Thanks — you are subscribed.', true); return; }

      var tz = '';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (tzErr) { tz = ''; }
      var payload = {
        key: opts.key || undefined,
        slug: opts.slug || undefined,
        answers: answers,
        hp: (shadow.querySelector('[name="bms-website"]') || {}).value || '',
        ms: Date.now() - shownAt,
        url: location.href,
        timezone: tz,
        surface: surface === 'hosted' ? 'hosted' : 'embed'
      };

      button.disabled = true;
      var previous = button.textContent;
      button.textContent = 'Please wait…';
      fetch((opts.apiBase || '') + '/api/audience/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data || {} }; });
      }).then(function (out) {
        button.disabled = false;
        button.textContent = previous;
        if (!out.ok) {
          // The server's message is written for a visitor, so it is shown verbatim — except the
          // origin error, which is the site owner's problem and means nothing to the visitor.
          say(out.data.code === 'origin_not_allowed'
            ? 'This sign-up form is not set up for this website yet.'
            : (out.data.error || 'Something went wrong. Please try again.'), false);
          return;
        }
        form.style.display = 'none';
        say(out.data.message || 'Thanks — please check your inbox.', true);
        // Only ever a URL the server handed back (validated http(s)) — never one read from this
        // page, which would make the snippet an open redirect.
        if (out.data.redirectUrl) setTimeout(function () { location.href = out.data.redirectUrl; }, 1200);
      }).catch(function (err) {
        button.disabled = false;
        button.textContent = previous;
        say('We could not reach the sign-up service. Please try again.', false);
        if (window.console) console.error('[bms-subscribe]', err);
      });
    });
  }

  window.BmsForm = { render: render };

  // ── Boot ───────────────────────────────────────────────────────────────────
  var script = document.currentScript;
  if (!script) return;
  var apiBase = '';
  try { apiBase = new URL(script.src).origin; } catch (e) { apiBase = ''; }

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  // The hosted page: the definition is inlined by the server, so there is nothing to fetch.
  if (script.getAttribute('data-bms-hosted') !== null) {
    ready(function () {
      var node = document.getElementById('bms-def');
      var host = document.getElementById('bms-form');
      if (!node || !host) return;
      var def;
      try { def = JSON.parse(node.textContent || '{}'); } catch (e) { return; }
      render(def, host, {
        surface: 'hosted', apiBase: '',
        key: script.getAttribute('data-bms-key') || undefined,
        slug: script.getAttribute('data-bms-slug') || undefined
      });
    });
    return;
  }

  // The embed.
  var key = script.getAttribute('data-bms-form');
  if (!key) return;   // loaded as a library (builder / chat preview) — window.BmsForm is the API
  var mountSel = script.getAttribute('data-bms-mount') || '#bms-subscribe';
  ready(function () {
    var host = document.querySelector(mountSel);
    if (!host) {
      // Named loudly: the most common install mistake is a snippet pasted without its mount div,
      // and a silent no-op looks identical to "the form is broken".
      console.error('[bms-subscribe] no element matches ' + mountSel + ' — add <div id="bms-subscribe"></div> where the form should appear');
      return;
    }
    fetch(apiBase + '/api/audience/form/' + encodeURIComponent(key))
      .then(function (res) { if (!res.ok) throw new Error('form ' + res.status); return res.json(); })
      .then(function (cfg) { render(cfg.definition || cfg, host, { surface: 'embed', key: key, apiBase: apiBase }); })
      .catch(function (err) { console.error('[bms-subscribe] could not load the form', err); });
  });
})();
