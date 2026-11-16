/**
 * src/components/search-trends-view.js — the workspace's tracked Google search terms
 * (docs/google-trends-plan.md Phase 2). ONE renderer for Business Information ▸ What people search
 * (mode 'manage': add, approve, remove, suggest) and Blog setup (mode 'blog': read, "Write about this").
 * Both talk to netlify/functions/search-trends.ts, the same server action as the chat cards.
 *
 * Every value from the server is escaped; related searches are strangers' text.
 * Wording rule (plan §7): relative interest, "usually peaks in…", never search counts.
 *
 *   window.SearchTrendsView.mount(el, { mode: 'manage' | 'blog' })
 */
(function () {
  if (window.SearchTrendsView) return;

  var API = '/.netlify/functions/search-trends';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var STYLE_ID = 'stv-styles';
  var CSS = ''
    + '.stv-row{padding:12px 0;border-top:1px solid #f3f4f6;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}'
    + '.stv-row:first-child{border-top:0}'
    + '.stv-main{flex:1 1 260px;min-width:0}'
    + '.stv-term{font-weight:700;color:#111827;font-size:14px;word-break:break-word}'
    + '.stv-region{font-weight:400;color:#6b7280;font-size:12px;margin-left:6px}'
    + '.stv-line{font-size:13px;color:#4b5563;margin-top:2px;word-break:break-word}'
    + '.stv-pill{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:1px 8px;margin-left:6px;vertical-align:1px}'
    + '.stv-up{background:#ecfdf5;color:#047857}.stv-down{background:#fef2f2;color:#b91c1c}.stv-wait{background:#fffbeb;color:#92400e}.stv-flat{background:#f3f4f6;color:#4b5563}'
    + '.stv-spark{flex:0 0 auto;width:132px;height:36px}'
    + '.stv-qs{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px}'
    + '.stv-q{font-size:12px;border:1px solid #e5e7eb;border-radius:999px;padding:2px 10px;background:#fff;color:#374151;max-width:100%;overflow-wrap:anywhere;text-align:left}'
    + 'button.stv-q{cursor:pointer}button.stv-q:hover{border-color:#10b981;color:#047857}'
    + '.stv-actions{display:flex;gap:6px;flex:0 0 auto}'
    + '.stv-btn{font-size:12px;font-weight:700;border:1px solid #d1d5db;border-radius:8px;padding:6px 10px;background:#fff;color:#374151;min-height:36px}'
    + '.stv-btn:disabled{opacity:.5}.stv-btn-primary{background:#047857;border-color:#047857;color:#fff}'
    + '.stv-add{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}'
    + '.stv-add input{flex:1 1 200px;min-width:0;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:14px;min-height:40px}'
    + '.stv-add select{border:1px solid #d1d5db;border-radius:8px;padding:8px;font-size:14px;min-height:40px;background:#fff}'
    + '.stv-note{font-size:12px;color:#6b7280;margin-top:10px}'
    + '.stv-sub{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin:16px 0 4px}';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s);
  }
  function monthList(ms) {
    var names = ms.slice().sort(function (a, b) { return a - b; });
    if (names.indexOf(12) >= 0 && names.indexOf(1) >= 0) names = names.filter(function (m) { return m >= 7; }).concat(names.filter(function (m) { return m < 7; }));
    names = names.map(function (m) { return MONTHS[m - 1]; });
    return names.length <= 1 ? (names[0] || '') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  /** A 12-month sparkline. Gaps (null weeks) break the line rather than dropping to zero. */
  function sparkline(series) {
    var pts = (series || []).map(function (p) { return typeof p.v === 'number' ? p.v : null; });
    if (pts.length < 2) return '';
    var w = 132, h = 36, n = pts.length, d = '', pen = false;
    pts.forEach(function (v, i) {
      if (v == null) { pen = false; return; }
      var x = (i / (n - 1)) * (w - 2) + 1, y = h - 2 - (v / 100) * (h - 4);
      d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      pen = true;
    });
    return '<svg class="stv-spark" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Interest over the past 12 months">'
      + '<path d="' + d + '" fill="none" stroke="#059669" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }

  function summary(t) {
    if (!t.approved) return 'Suggested — approve it to start tracking.';
    if (t.status === 'pending') return 'First data arrives within a day.';
    if (t.status === 'not_enough_data') return 'Not enough searches in this region to chart.';
    if (t.status === 'error' && !(t.series || []).length) return 'Could not be fetched yet — we’ll try again.';
    var s = t.peakMonths && t.peakMonths.length ? 'Usually busiest in ' + monthList(t.peakMonths) + '.' : 'Searched about evenly all year.';
    if (t.nextPeak && t.peakMonths.length) {
      s += t.nextPeak.monthsAway === 0 ? ' That’s now.' : t.nextPeak.monthsAway === 1 ? ' Next busy spell starts next month.' : ' Next busy spell in about ' + t.nextPeak.monthsAway + ' months.';
    }
    return s;
  }
  function pill(t) {
    if (!t.approved) return '<span class="stv-pill stv-wait">Needs your OK</span>';
    if (t.direction === 'rising') return '<span class="stv-pill stv-up">↑ Rising</span>';
    if (t.direction === 'falling') return '<span class="stv-pill stv-down">↓ Falling</span>';
    if (t.direction === 'steady') return '<span class="stv-pill stv-flat">Steady</span>';
    return '';
  }

  function mount(el, opts) {
    injectStyles();
    // Mounting the same element again (Blog setup reloads its search section) only reloads: listeners
    // are attached once per element, or every click would fire twice.
    if (el._stv) { el._stv.reload(); return el._stv; }
    opts = opts || {};
    var mode = opts.mode === 'blog' ? 'blog' : 'manage';
    var state = { trends: [], regions: [], defaultRegion: 'GB', max: 20, error: null, loading: true };

    function call(body) {
      return fetch(API, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { credentials: 'same-origin' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'That didn’t work — please try again.'); return d; }); });
    }

    function queries(t) {
      var qs = (t.risingQueries || []).map(function (q) { return { text: q.query, rising: true }; })
        .concat((t.topQueries || []).map(function (q) { return { text: q, rising: false }; }));
      var seen = {};
      qs = qs.filter(function (q) { var k = q.text.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; }).slice(0, 6);
      if (!qs.length) return '';
      return '<div class="stv-qs">' + qs.map(function (q) {
        var label = (q.rising ? '↑ ' : '') + esc(q.text);
        return mode === 'blog'
          ? '<button type="button" class="stv-q" data-stv-write="' + esc(q.text) + '" data-stv-term="' + esc(t.term) + '" title="Write about this">' + label + ' ✎</button>'
          : '<span class="stv-q">' + label + '</span>';
      }).join('') + '</div>';
    }

    function row(t) {
      var actions = '';
      if (mode === 'manage') {
        actions = '<div class="stv-actions">'
          + (!t.approved ? '<button type="button" class="stv-btn stv-btn-primary" data-stv-approve="' + t.termId + '">Approve</button>' : '')
          + '<button type="button" class="stv-btn" data-stv-remove="' + t.termId + '" aria-label="Remove ' + esc(t.term) + '">Remove</button></div>';
      }
      return '<div class="stv-row"><div class="stv-main">'
        + '<div class="stv-term">' + esc(t.term) + '<span class="stv-region">' + esc(t.locationName) + '</span>' + pill(t) + '</div>'
        + '<div class="stv-line">' + esc(summary(t)) + '</div>'
        + (t.approved ? queries(t) : '')
        + '</div>' + (t.approved && t.status !== 'not_enough_data' ? sparkline(t.series) : '') + actions + '</div>';
    }

    function render() {
      if (state.loading) { el.innerHTML = '<p class="stv-line">Loading…</p>'; return; }
      if (state.error && !state.trends.length) { el.innerHTML = '<p class="stv-line" role="alert">' + esc(state.error) + '</p>'; return; }
      var approved = state.trends.filter(function (t) { return t.approved; });
      var suggested = state.trends.filter(function (t) { return !t.approved; });
      var html = '';
      if (mode === 'blog') {
        var shown = approved.filter(function (t) { return t.status === 'ok'; });
        html = shown.length ? shown.map(row).join('')
          : '<p class="stv-line">' + (approved.length ? 'Your search terms’ first data arrives within a day.' : 'You aren’t tracking any search terms yet.') + '</p>';
        html += '<p class="stv-note">Click a search to ask your Blog Writer for a post on it. Interest is relative (100 = the busiest week of the past year), never a number of searches. '
          + '<a href="#" data-stv-manage class="text-emerald-700 underline">Choose your search terms</a></p>';
      } else {
        if (suggested.length) {
          html += '<div class="stv-sub">Suggested for you</div>' + suggested.map(row).join('')
            + '<div style="margin-top:8px"><button type="button" class="stv-btn stv-btn-primary" data-stv-approve-all>Approve all ' + suggested.length + '</button></div>';
        }
        if (approved.length) html += '<div class="stv-sub">Tracking</div>' + approved.map(row).join('');
        if (!state.trends.length) html += '<p class="stv-line">You aren’t tracking any search terms yet. Let us suggest some from your business details, or add your own.</p>';
        var full = state.trends.length >= state.max;
        html += '<form class="stv-add" data-stv-add>'
          + '<input name="term" maxlength="80" placeholder="e.g. boiler service" aria-label="Search term" ' + (full ? 'disabled' : '') + '>'
          + '<select name="region" aria-label="Region">' + state.regions.map(function (r) { return '<option value="' + esc(r.iso) + '"' + (r.iso === state.defaultRegion ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join('') + '</select>'
          + '<button type="submit" class="stv-btn stv-btn-primary" ' + (full ? 'disabled' : '') + '>Add</button>'
          + '<button type="button" class="stv-btn" data-stv-suggest ' + (full ? 'disabled' : '') + '>Suggest terms for me</button></form>'
          + '<p class="stv-note">' + state.trends.length + ' of ' + state.max + '. Broad words your customers type work best (“dog grooming”, not your business name). '
          + 'Data comes from Google Trends and is refreshed weekly: interest is relative (100 = the busiest week of the past year), never a number of searches.</p>';
        if (state.error) html += '<p class="stv-line" role="alert" style="color:#b91c1c">' + esc(state.error) + '</p>';
      }
      el.innerHTML = html;
    }

    function act(body, btn) {
      if (btn) btn.disabled = true;
      state.error = null;
      return call(body).then(function (d) {
        state.trends = d.trends || state.trends;
        if (d.message) window.showToast && window.showToast(d.message, { icon: '✅' });
        if (d.added) window.showToast && window.showToast(d.added.length ? 'Suggested ' + d.added.length + ' terms — approve the ones that fit.' : 'Nothing new to suggest.', { icon: '💡' });
        render();
      }).catch(function (err) { state.error = err.message; render(); });
    }

    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-stv-approve],[data-stv-remove],[data-stv-approve-all],[data-stv-suggest],[data-stv-write],[data-stv-manage]');
      if (!b) return;
      if (b.hasAttribute('data-stv-manage')) {
        e.preventDefault();
        window._bizinfoInitialTab = 'searchterms';
        if (window.closeBlogStudio) try { window.closeBlogStudio(); } catch (_) { /* not open */ }
        if (window.loadView) window.loadView('assets');
        return;
      }
      if (b.hasAttribute('data-stv-write')) {
        var q = b.getAttribute('data-stv-write'), term = b.getAttribute('data-stv-term');
        var draft = 'Write a blog post that answers the Google search "' + q + '" (related to "' + term + '"), for my customers.';
        if (!window.openAssistantChat || !window.resolveBlogWriter) { window.showToast && window.showToast('Open your Blog Writer’s chat and ask: ' + draft); return; }
        window.resolveBlogWriter().then(function (a) {
          if (!a) { window.showToast && window.showToast('Add a Blog Writer first, then ask it to write about this.', { icon: '⚠️' }); return; }
          window.openAssistantChat({ assistantId: a.id, draft: draft });
        });
        return;
      }
      if (b.hasAttribute('data-stv-approve-all')) return act({ action: 'approve_all' }, b);
      if (b.hasAttribute('data-stv-suggest')) { b.textContent = 'Thinking…'; return act({ action: 'suggest' }, b); }
      if (b.hasAttribute('data-stv-approve')) return act({ action: 'approve', termId: Number(b.getAttribute('data-stv-approve')) }, b);
      if (b.hasAttribute('data-stv-remove')) return act({ action: 'remove', termId: Number(b.getAttribute('data-stv-remove')) }, b);
    });
    el.addEventListener('submit', function (e) {
      var f = e.target.closest('[data-stv-add]');
      if (!f) return;
      e.preventDefault();
      var term = (f.term.value || '').trim();
      if (!term) return;
      act({ action: 'add', term: term, region: f.region.value }, f.querySelector('[type=submit]'));
    });

    function load() {
      state.loading = true; render();
      return call().then(function (d) {
        state.trends = d.trends || []; state.regions = d.regions || []; state.defaultRegion = d.defaultRegion || 'GB'; state.max = d.max || 20;
      }).catch(function (err) { state.error = err.message; }).then(function () { state.loading = false; render(); });
    }
    load();
    el._stv = { reload: load };
    return el._stv;
  }

  window.SearchTrendsView = { mount: mount, sparkline: sparkline, summary: summary, monthList: monthList };
})();
