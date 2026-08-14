/**
 * src/components/canva-browser.js
 *
 * Canva connector, US2/US3 — the design picker shared by the Social Media Manager's Create Post
 * sheet and the Blog Writer's Blog Studio.
 *
 * Browse or search the org's Canva designs, descend folders, multi-select, and import the
 * selection into the Content Library (content_assets, provider 'canva'). Imported assets then
 * flow through each host's existing library grid — this module never touches the host's UI, it
 * just reports the new asset ids back through onImported.
 *
 * Public API (attached to window):
 *   CanvaBrowser.open({ assetType, multiple, onImported })
 *     assetType   'image' | 'any'    — 'image' hides video designs (blog feature images)
 *     multiple    boolean            — default true; false auto-imports on a single pick
 *     onImported  fn(assetIds[])     — fires once, after import completes with ≥1 asset
 *
 * Three Canva API facts drive the design here, all of them non-negotiable:
 *   - Thumbnail URLs die after ~15 minutes, so a page left open on a second monitor shows broken
 *     images. Each page is stamped with its fetch time and silently re-fetched on focus once
 *     stale. Nothing thumbnail-related is ever persisted.
 *   - Pagination is continuation-token based — no page numbers, no total count. Hence "Load more"
 *     rather than a pager, and selection state (_selected) lives outside the rendered grid so it
 *     survives re-render and spans pages.
 *   - There is no parent-chain API, so breadcrumbs are assembled from the descent stack (_path).
 *     This works only because a folder can only be reached by descending into it — which is also
 *     why deep-linking to a folder isn't offered.
 *
 * Backend: canva-browse (proxy — the access token never reaches this file), canva-import,
 * canva-import-status.
 */
(function () {
  'use strict';

  var ROOT_FOLDER = 'root';
  // Canva thumbnails expire at ~15 min; refresh a little early rather than show a broken grid.
  var THUMB_STALE_MS = 12 * 60 * 1000;
  var POLL_INTERVAL_MS = 2500;
  var POLL_MAX_TRIES = 150;          // ~6 min, comfortably past a normal export
  var MAX_SELECTION = 20;            // matches canva-import's server-side cap

  var _open = false;
  var _opts = {};
  var _items = [];                   // items on screen (grows as pages load)
  var _selected = new Map();         // designId → { id, title, designType } — survives re-render
  var _path = [];                    // descent stack: [{ id, name }] — the breadcrumb
  var _continuation = null;
  var _fetchedAt = 0;
  var _loading = false;
  var _query = '';
  var _importing = false;
  var _searchTimer = null;

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function el(id) { return document.getElementById(id); }

  // ── Markup ─────────────────────────────────────────────────────────────────
  function ensureMounted() {
    if (el('canva-browser-backdrop')) return;
    var html =
      '<div id="canva-browser-backdrop" class="hidden fixed inset-0 z-[80] bg-gray-900/60 backdrop-blur-sm"></div>' +
      '<div id="canva-browser-modal" class="hidden fixed inset-0 z-[81] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="canva-browser-title">' +
      '  <div class="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">' +
      '    <div class="flex items-center justify-between px-5 pt-5 pb-3">' +
      '      <div class="flex items-center gap-2.5 min-w-0">' +
      '        <span class="w-9 h-9 rounded-xl bg-teal-100 text-teal-700 flex items-center justify-center text-lg shrink-0">🎨</span>' +
      '        <div class="min-w-0">' +
      '          <h2 id="canva-browser-title" class="text-base font-extrabold text-gray-900 leading-tight">Your Canva designs</h2>' +
      '          <p class="text-xs text-gray-500 mt-0.5">Pick designs to add to your Content Library.</p>' +
      '        </div>' +
      '      </div>' +
      '      <button type="button" id="canva-browser-close" aria-label="Close" class="text-gray-400 hover:text-gray-600 cursor-pointer">' +
      '        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>' +
      '      </button>' +
      '    </div>' +
      '    <div class="px-5 pb-3 flex flex-col gap-2.5">' +
      '      <input id="canva-browser-search" type="search" placeholder="Search all your designs…" autocomplete="off"' +
      '             class="w-full text-sm border border-gray-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-400">' +
      '      <nav id="canva-browser-crumbs" class="flex items-center gap-1 text-xs font-semibold text-gray-500 flex-wrap"></nav>' +
      '    </div>' +
      '    <div id="canva-browser-body" class="px-5 pb-2 overflow-y-auto grow min-h-[240px]"></div>' +
      '    <div class="px-5 py-4 border-t border-gray-100 flex items-center gap-3">' +
      '      <p id="canva-browser-count" class="text-xs font-semibold text-gray-500"></p>' +
      '      <div class="ml-auto flex items-center gap-2">' +
      '        <button type="button" id="canva-browser-cancel" class="px-3.5 py-2 text-xs font-bold rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition cursor-pointer">Cancel</button>' +
      '        <button type="button" id="canva-browser-import" disabled' +
      '                class="px-4 py-2 text-xs font-bold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 transition cursor-pointer disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed">Import</button>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    var host = document.createElement('div');
    host.innerHTML = html;
    while (host.firstChild) document.body.appendChild(host.firstChild);

    el('canva-browser-close').addEventListener('click', close);
    el('canva-browser-cancel').addEventListener('click', close);
    el('canva-browser-backdrop').addEventListener('click', close);
    el('canva-browser-import').addEventListener('click', runImport);
    el('canva-browser-search').addEventListener('input', onSearchInput);
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('focus', onWindowFocus);
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && _open && !_importing) close();
  }

  // Thumbnails expire at ~15 min. Coming back to a tab that has been open longer than that would
  // otherwise show a grid of broken images, so quietly reload the current view instead.
  function onWindowFocus() {
    if (!_open || _loading || _importing) return;
    if (Date.now() - _fetchedAt < THUMB_STALE_MS) return;
    reload();
  }

  function onSearchInput(e) {
    var next = e.target.value.trim();
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(function () {
      if (next === _query) return;
      _query = next;
      // Searching is global (Canva has no in-folder search), so leaving the folder is honest:
      // showing results "inside" a folder they don't belong to would be a lie.
      _path = [];
      reload();
    }, 300);
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  function currentFolderId() {
    return _path.length ? _path[_path.length - 1].id : ROOT_FOLDER;
  }

  function reload() {
    _items = [];
    _continuation = null;
    loadPage();
  }

  function loadPage() {
    if (_loading) return;
    _loading = true;
    render();

    var params = new URLSearchParams();
    if (_query) {
      params.set('resource', 'designs');
      params.set('query', _query);
    } else {
      params.set('resource', 'folder');
      params.set('folderId', currentFolderId());
    }
    if (_continuation) params.set('continuation', _continuation);

    fetch('/.netlify/functions/canva-browse?' + params.toString())
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .then(function (r) {
        _loading = false;
        if (!r.ok) {
          // not_connected / expired aren't failures — they're a state with an obvious next step.
          if (r.data && (r.data.code === 'not_connected' || r.data.code === 'expired')) {
            renderNotConnected(r.data.code);
            return;
          }
          renderError((r.data && r.data.error) || 'Could not load your Canva designs.');
          return;
        }
        var incoming = (r.data.items || []).filter(keepItem);
        _items = _items.concat(incoming);
        _continuation = r.data.continuation || null;
        _fetchedAt = r.data.fetchedAt || Date.now();
        render();
      })
      .catch(function () {
        _loading = false;
        renderError('Could not reach Canva — check your connection and try again.');
      });
  }

  // A blog feature image can't be an mp4, so hide video designs when the host asked for images.
  function keepItem(item) {
    if (!item) return false;
    if (item.kind === 'folder') return !_query;   // folders are meaningless in search results
    if (item.kind === 'asset') return true;       // never importable, but shown greyed out
    if (_opts.assetType !== 'image') return true;
    return !/video|animation|reel|short/i.test(String(item.designType || ''));
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    renderCrumbs();
    renderBody();
    renderFooter();
  }

  function renderCrumbs() {
    var nav = el('canva-browser-crumbs');
    if (!nav) return;
    if (_query) {
      nav.innerHTML = '<span class="text-gray-400">Search results across all your designs</span>';
      return;
    }
    var parts = ['<button type="button" data-depth="0" class="canva-crumb hover:text-emerald-700 cursor-pointer">Home</button>'];
    _path.forEach(function (folder, i) {
      parts.push('<span class="text-gray-300">›</span>');
      var isLast = i === _path.length - 1;
      parts.push(isLast
        ? '<span class="text-gray-700">' + esc(folder.name) + '</span>'
        : '<button type="button" data-depth="' + (i + 1) + '" class="canva-crumb hover:text-emerald-700 cursor-pointer">' + esc(folder.name) + '</button>');
    });
    nav.innerHTML = parts.join(' ');
    Array.prototype.forEach.call(nav.querySelectorAll('.canva-crumb'), function (btn) {
      btn.addEventListener('click', function () {
        _path = _path.slice(0, Number(btn.dataset.depth));
        reload();
      });
    });
  }

  function renderBody() {
    var body = el('canva-browser-body');
    if (!body) return;

    if (!_items.length && _loading) {
      body.innerHTML = '<p class="text-sm text-gray-400 text-center py-12">Loading your designs…</p>';
      return;
    }
    if (!_items.length) {
      body.innerHTML = _query
        ? '<p class="text-sm text-gray-400 text-center py-12">No designs match “' + esc(_query) + '”.</p>'
        : '<p class="text-sm text-gray-400 text-center py-12">Nothing here yet.</p>';
      return;
    }

    var cells = _items.map(function (item) {
      if (item.kind === 'folder') return folderCell(item);
      return item.kind === 'asset' ? assetCell(item) : designCell(item);
    });
    var more = _continuation
      ? '<div class="col-span-full pt-2 pb-1 text-center">' +
        '  <button type="button" id="canva-browser-more" class="px-4 py-2 text-xs font-bold rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition cursor-pointer">' +
        (_loading ? 'Loading…' : 'Load more') + '</button></div>'
      : '';
    body.innerHTML = '<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 pb-2">' + cells.join('') + more + '</div>';

    Array.prototype.forEach.call(body.querySelectorAll('.canva-folder'), function (btn) {
      btn.addEventListener('click', function () {
        _path.push({ id: btn.dataset.folderId, name: btn.dataset.folderName });
        reload();
      });
    });
    Array.prototype.forEach.call(body.querySelectorAll('.canva-design'), function (btn) {
      btn.addEventListener('click', function () { toggleSelect(btn.dataset.designId); });
    });
    var moreBtn = el('canva-browser-more');
    if (moreBtn) moreBtn.addEventListener('click', function () { if (!_loading) loadPage(); });
  }

  function folderCell(item) {
    return '<button type="button" class="canva-folder flex items-center gap-2 p-3 rounded-xl border border-gray-200 hover:border-emerald-400 hover:bg-emerald-50 transition cursor-pointer text-left"' +
      ' data-folder-id="' + esc(item.id) + '" data-folder-name="' + esc(item.name) + '">' +
      '  <svg class="w-5 h-5 text-gray-400 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>' +
      '  <span class="text-xs font-bold text-gray-700 truncate">' + esc(item.name) + '</span>' +
      '</button>';
  }

  function designCell(item) {
    var isSelected = _selected.has(String(item.id));
    // page_count is null on design types Canva doesn't report it for — absent is not 1, so only
    // badge a count we actually know.
    var pages = (typeof item.pageCount === 'number' && item.pageCount > 1)
      ? '<span class="absolute top-1.5 left-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-gray-900/75 text-white">' + item.pageCount + ' pages</span>'
      : '';
    var tick = isSelected
      ? '<span class="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-emerald-700 text-white flex items-center justify-center text-[11px] font-bold">✓</span>'
      : '';
    var thumb = item.thumbnailUrl
      ? '<img src="' + esc(item.thumbnailUrl) + '" alt="' + esc(item.name) + '" class="w-full h-full object-cover" loading="lazy">'
      : '<div class="w-full h-full flex items-center justify-center text-gray-300 text-xl">🎨</div>';
    return '<button type="button" class="canva-design group text-left cursor-pointer" data-design-id="' + esc(item.id) + '">' +
      '  <span class="relative block aspect-square rounded-xl overflow-hidden border-2 ' + (isSelected ? 'border-emerald-600' : 'border-transparent group-hover:border-emerald-400') + ' bg-gray-100 transition">' +
      thumb + pages + tick +
      '  </span>' +
      '  <span class="block text-[11px] font-semibold text-gray-600 truncate mt-1">' + esc(item.name) + '</span>' +
      '</button>';
  }

  // Uploaded images can't be imported (Canva exports designs only — see canva-browse.ts toItem).
  // Shown greyed out rather than dropped, so a file the user can see in Canva doesn't vanish here
  // with no explanation.
  function assetCell(item) {
    var thumb = item.thumbnailUrl
      ? '<img src="' + esc(item.thumbnailUrl) + '" alt="' + esc(item.name) + '" class="w-full h-full object-cover opacity-40" loading="lazy">'
      : '<div class="w-full h-full flex items-center justify-center text-gray-300 text-xl">🖼️</div>';
    return '<div class="text-left cursor-not-allowed" title="Only Canva designs can be imported — this is an uploaded image, not a design.">' +
      '  <span class="relative block aspect-square rounded-xl overflow-hidden border-2 border-transparent bg-gray-100">' +
      thumb +
      '    <span class="absolute inset-x-1.5 bottom-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-gray-900/75 text-white text-center">Designs only</span>' +
      '  </span>' +
      '  <span class="block text-[11px] font-semibold text-gray-400 truncate mt-1">' + esc(item.name) + '</span>' +
      '</div>';
  }

  function renderFooter() {
    var count = el('canva-browser-count');
    var importBtn = el('canva-browser-import');
    if (!count || !importBtn) return;
    var n = _selected.size;
    if (_importing) {
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      return;
    }
    importBtn.disabled = n === 0;
    importBtn.textContent = n > 1 ? 'Import ' + n + ' designs' : 'Import';
    count.textContent = n ? n + ' selected' : '';
  }

  function renderNotConnected(code) {
    var body = el('canva-browser-body');
    if (!body) return;
    var line = code === 'expired'
      ? 'Your Canva connection has expired.'
      : 'Canva isn’t connected yet.';
    body.innerHTML =
      '<div class="text-center py-12 px-6">' +
      '  <div class="w-12 h-12 rounded-2xl bg-teal-100 text-teal-700 flex items-center justify-center text-xl mx-auto">🎨</div>' +
      '  <p class="text-sm font-bold text-gray-900 mt-3">' + esc(line) + '</p>' +
      '  <p class="text-xs text-gray-500 mt-1 max-w-xs mx-auto">Connect it once and your designs become available here and in your Content Library.</p>' +
      '  <a href="/integrations.html" class="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-lg transition cursor-pointer">' +
      (code === 'expired' ? 'Reconnect Canva' : 'Connect Canva') + '</a>' +
      '</div>';
    var count = el('canva-browser-count');
    var importBtn = el('canva-browser-import');
    if (count) count.textContent = '';
    if (importBtn) importBtn.disabled = true;
  }

  function renderError(message) {
    var body = el('canva-browser-body');
    if (body) body.innerHTML = '<p class="text-sm text-red-500 text-center py-12">' + esc(message) + '</p>';
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  function toggleSelect(designId) {
    var id = String(designId);
    if (_selected.has(id)) {
      _selected.delete(id);
    } else {
      if (_opts.multiple === false) _selected.clear();
      if (_selected.size >= MAX_SELECTION) {
        window.showToast?.('You can import up to ' + MAX_SELECTION + ' designs at a time.', { icon: '⚠️' });
        return;
      }
      var item = _items.find(function (i) { return String(i.id) === id; });
      // Assets have no cell that calls this, but a selected asset would queue an import that is
      // certain to 404 — so refuse here too rather than rely on the render staying correct.
      if (!item || item.kind === 'asset') return;
      _selected.set(id, { id: id, title: item.name, designType: item.designType || '' });
    }
    renderBody();
    renderFooter();
  }

  // ── Import ─────────────────────────────────────────────────────────────────
  function runImport() {
    if (_importing || !_selected.size) return;
    _importing = true;
    renderFooter();

    var designs = Array.from(_selected.values()).map(function (d) {
      return { id: d.id, title: d.title, designType: d.designType };
    });

    fetch('/.netlify/functions/canva-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ designs: designs }),
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (r) {
        if (!r.ok) throw new Error((r.data && r.data.error) || 'Could not start the import.');
        var jobIds = (r.data.jobs || []).map(function (j) { return j.jobId; });
        if (!jobIds.length) throw new Error('Could not start the import.');
        showProgress(0, jobIds.length);
        pollJobs(jobIds, 0);
      })
      .catch(function (err) {
        _importing = false;
        renderError(err.message || 'Could not start the import.');
        renderFooter();
      });
  }

  function showProgress(done, total) {
    var body = el('canva-browser-body');
    if (!body) return;
    var pct = total ? Math.round((done / total) * 100) : 0;
    body.innerHTML =
      '<div class="text-center py-12 px-6">' +
      '  <p class="text-sm font-bold text-gray-900">Importing your designs…</p>' +
      '  <p class="text-xs text-gray-500 mt-1">' + done + ' of ' + total + ' done. Multi-page designs take a little longer.</p>' +
      '  <div class="w-full max-w-xs mx-auto h-2 bg-gray-100 rounded-full overflow-hidden mt-4">' +
      '    <div class="h-full bg-emerald-700 transition-all" style="width:' + pct + '%"></div>' +
      '  </div>' +
      '</div>';
  }

  function pollJobs(jobIds, tries) {
    if (tries > POLL_MAX_TRIES) {
      _importing = false;
      renderError('The import is taking longer than expected — check your Content Library shortly.');
      renderFooter();
      return;
    }
    fetch('/.netlify/functions/canva-import-status?jobIds=' + encodeURIComponent(jobIds.join(',')))
      .then(function (res) { return res.ok ? res.json() : { jobs: [] }; })
      .then(function (data) {
        var jobs = data.jobs || [];
        var settled = jobs.filter(function (j) { return j.status === 'completed' || j.status === 'failed'; });
        showProgress(settled.length, jobIds.length);
        if (settled.length < jobIds.length) {
          setTimeout(function () { pollJobs(jobIds, tries + 1); }, POLL_INTERVAL_MS);
          return;
        }
        finishImport(jobs);
      })
      .catch(function () {
        setTimeout(function () { pollJobs(jobIds, tries + 1); }, POLL_INTERVAL_MS);
      });
  }

  function finishImport(jobs) {
    _importing = false;
    var assetIds = [];
    jobs.forEach(function (j) {
      if (j.status === 'completed') assetIds = assetIds.concat(j.assetIds || []);
    });
    var failed = jobs.filter(function (j) { return j.status === 'failed'; });

    // A partial success is still a success — hand back what landed and name what didn't, rather
    // than discarding good imports because one design failed.
    if (!assetIds.length) {
      var reason = (failed[0] && failed[0].errorMessage) || 'None of the designs could be imported.';
      renderError(reason);
      renderFooter();
      return;
    }
    if (failed.length && window.showToast) {
      window.showToast(failed.length + ' design' + (failed.length > 1 ? 's' : '') + ' could not be imported.');
    }

    var cb = _opts.onImported;
    close();
    if (typeof cb === 'function') cb(assetIds);
  }

  // ── Open / close ───────────────────────────────────────────────────────────
  function open(options) {
    ensureMounted();
    _opts = options || {};
    _open = true;
    _items = [];
    _selected = new Map();
    _path = [];
    _continuation = null;
    _query = '';
    _importing = false;
    _loading = false;

    var search = el('canva-browser-search');
    if (search) search.value = '';
    el('canva-browser-backdrop').classList.remove('hidden');
    el('canva-browser-modal').classList.remove('hidden');
    loadPage();
  }

  function close() {
    _open = false;
    _importing = false;
    var backdrop = el('canva-browser-backdrop');
    var modal = el('canva-browser-modal');
    if (backdrop) backdrop.classList.add('hidden');
    if (modal) modal.classList.add('hidden');
  }

  window.CanvaBrowser = { open: open, close: close };
})();
