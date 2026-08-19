/**
 * subscribe.js — the embeddable audience sign-up form.
 *
 * Drop-in embed for a customer's own website:
 *   <script async src="https://bemoreswan.com/subscribe.js"
 *           data-bms-form="aud_ab12…" data-bms-mount="#bms-subscribe"></script>
 *
 * Sibling of widget.js (the blog embed) and built to the same rules: Shadow DOM so the customer's
 * CSS and ours can never collide, no dependencies, and the API origin resolved from the script's
 * own src so it works on any host. The difference is that this one WRITES — it is the only place an
 * anonymous visitor can put data into a tenant's audience — so the server owns every check
 * (see netlify/functions/audience-public.ts) and this file's job is to be honest about the result.
 *
 * ⚠️ ES5-flavoured on purpose (var, function, no template literals). This runs on other people's
 * websites, including ones that still transpile or proxy scripts through old tooling; a syntax
 * error here is a broken page a customer will blame on their own site.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var key = script.getAttribute('data-bms-form');
  var mountSel = script.getAttribute('data-bms-mount') || '#bms-subscribe';
  if (!key) { console.error('[bms-subscribe] missing data-bms-form'); return; }

  var apiBase;
  try { apiBase = new URL(script.src).origin; } catch (e) { apiBase = ''; }
  var API = apiBase + '/api/audience';

  // When the form appeared. The server rejects submissions faster than a human can type, so this
  // has to be the moment of RENDER, not of page load.
  var shownAt = 0;

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var FIELD_LABELS = {
    email: 'Email address',
    first_name: 'First name',
    last_name: 'Last name',
    company: 'Company'
  };
  var FIELD_KEYS = { first_name: 'firstName', last_name: 'lastName', company: 'company', email: 'email' };

  function render(host, cfg) {
    var accent = (cfg.theme && cfg.theme.accent) || '#059669';
    var inline = cfg.theme && cfg.theme.layout === 'inline';
    var buttonLabel = (cfg.theme && cfg.theme.buttonLabel) || 'Subscribe';
    var fields = (cfg.fields && cfg.fields.length ? cfg.fields : ['email']);

    var shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });

    var inputsHtml = '';
    for (var i = 0; i < fields.length; i++) {
      var f = String(fields[i]);
      if (!FIELD_LABELS[f]) continue;
      inputsHtml +=
        '<label class="bms-l" for="bms-' + esc(f) + '">' + esc(FIELD_LABELS[f]) + '</label>' +
        '<input class="bms-i" id="bms-' + esc(f) + '" name="' + esc(f) + '"' +
        ' type="' + (f === 'email' ? 'email' : 'text') + '"' +
        (f === 'email' ? ' required autocomplete="email"' : '') + '>';
    }

    shadow.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.bms-w{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#111827;max-width:32rem}' +
      '.bms-f{display:' + (inline ? 'flex' : 'block') + ';gap:.5rem;align-items:flex-end;flex-wrap:wrap}' +
      '.bms-l{display:block;font-size:.8125rem;font-weight:600;margin:0 0 .25rem;color:#374151}' +
      '.bms-i{display:block;width:100%;box-sizing:border-box;font-size:.9375rem;padding:.6rem .7rem;margin:0 0 .75rem;' +
        'border:1px solid #d1d5db;border-radius:.5rem;background:#fff;color:#111827;font-family:inherit}' +
      '.bms-i:focus{outline:2px solid ' + accent + ';outline-offset:1px}' +
      '.bms-b{cursor:pointer;font-family:inherit;font-size:.9375rem;font-weight:700;color:#fff;background:' + accent + ';' +
        'border:none;border-radius:.5rem;padding:.65rem 1.1rem}' +
      '.bms-b[disabled]{opacity:.6;cursor:not-allowed}' +
      '.bms-c{font-size:.75rem;color:#6b7280;line-height:1.5;margin:.5rem 0 0}' +
      '.bms-m{font-size:.875rem;line-height:1.5;margin:.75rem 0 0}' +
      '.bms-ok{color:#065f46}.bms-err{color:#b91c1c}' +
      /* The honeypot. Off-screen rather than display:none — some bots skip hidden fields but fill
         everything else, and a field that is not rendered at all catches nobody. */
      '.bms-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;overflow:hidden}' +
      '</style>' +
      '<div class="bms-w">' +
        '<form class="bms-f" novalidate>' +
          '<div style="flex:1;min-width:14rem">' + inputsHtml + '</div>' +
          '<div class="bms-hp" aria-hidden="true">' +
            '<label for="bms-website">Leave this field empty</label>' +
            '<input id="bms-website" name="website" type="text" tabindex="-1" autocomplete="off">' +
          '</div>' +
          '<button class="bms-b" type="submit">' + esc(buttonLabel) + '</button>' +
        '</form>' +
        '<p class="bms-c">' + esc(cfg.consentText || '') + '</p>' +
        '<p class="bms-m" role="status" aria-live="polite"></p>' +
      '</div>';

    shownAt = Date.now();

    var form = shadow.querySelector('form');
    var button = shadow.querySelector('.bms-b');
    var msg = shadow.querySelector('.bms-m');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.textContent = '';
      msg.className = 'bms-m';

      var payload = {
        key: key,
        hp: (shadow.getElementById('bms-website') || {}).value || '',
        ms: Date.now() - shownAt,
        url: location.href
      };
      for (var i = 0; i < fields.length; i++) {
        var f = String(fields[i]);
        var el = shadow.getElementById('bms-' + f);
        if (el && FIELD_KEYS[f]) payload[FIELD_KEYS[f]] = el.value;
      }

      if (!payload.email || payload.email.indexOf('@') < 0) {
        msg.textContent = 'Please enter a valid email address.';
        msg.className = 'bms-m bms-err';
        return;
      }

      button.disabled = true;
      var previous = button.textContent;
      button.textContent = 'Please wait…';

      fetch(API + '/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data || {} }; });
      }).then(function (out) {
        button.disabled = false;
        button.textContent = previous;
        if (!out.ok) {
          // The server's message is written for a visitor, so show it verbatim rather than
          // inventing our own. The one exception is the origin error, which is the site owner's
          // problem and means nothing to the person trying to subscribe.
          msg.textContent = out.data.code === 'origin_not_allowed'
            ? 'This sign-up form is not set up for this website yet.'
            : (out.data.error || 'Something went wrong. Please try again.');
          msg.className = 'bms-m bms-err';
          return;
        }
        form.style.display = 'none';
        msg.textContent = out.data.message || 'Thanks — please check your inbox.';
        msg.className = 'bms-m bms-ok';
        // Only ever a URL the server handed back (validated http(s) — see validateRedirectUrl).
        // Never a value read from this page, which would make the snippet an open redirect.
        if (out.data.redirectUrl) {
          setTimeout(function () { location.href = out.data.redirectUrl; }, 1200);
        }
      }).catch(function (err) {
        button.disabled = false;
        button.textContent = previous;
        msg.textContent = 'We could not reach the sign-up service. Please try again.';
        msg.className = 'bms-m bms-err';
        console.error('[bms-subscribe]', err);
      });
    });
  }

  ready(function () {
    var host = document.querySelector(mountSel);
    if (!host) {
      // Named loudly: the most common install mistake is a snippet pasted without its mount div,
      // and a silent no-op looks identical to "the form is broken".
      console.error('[bms-subscribe] no element matches ' + mountSel + ' — add <div id="bms-subscribe"></div> where the form should appear');
      return;
    }
    fetch(API + '/form/' + encodeURIComponent(key))
      .then(function (res) {
        if (!res.ok) throw new Error('form ' + res.status);
        return res.json();
      })
      .then(function (cfg) { render(host, cfg); })
      .catch(function (err) {
        console.error('[bms-subscribe] could not load the form config', err);
      });
  });
})();
