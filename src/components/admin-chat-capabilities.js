// src/components/admin-chat-capabilities.js — Admin ▸ Assistants ▸ Chat capabilities (feature request #17).
//
// What every assistant's chat knows, reads, can do, can't do and must follow — the SAME six sections in
// the same order for every assistant, so they can be compared and nothing is missing:
//   1. Expertise   2. What it reads   3. What it can see and change   4. What it can do
//   5. What it can't do   6. Rules it follows
// The data comes from admin-assistants.ts ?chatCapabilities=1, which builds it from the chat code
// (src/config/chat-capabilities.generated.ts) plus the words in src/utils/assistant-chat-capabilities.ts.
// tests/assistant-chat-capabilities.test.ts fails when the two drift apart.
//
// Vanilla, one IIFE (memory frontend-is-vanilla). Styles scoped under .cc- and injected once. Every
// value printed goes through esc().
//
//   AdminChatCaps.load(mountEl)               the whole page
//   AdminChatCaps.renderRole(roleKey, el)     one assistant (the drawer's "Chat capabilities" tab)

(function () {
  'use strict';

  const API = '/.netlify/functions/admin-assistants?chatCapabilities=1';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = { live: ['Live', 'cc-st-live'], beta: ['Beta', 'cc-st-beta'], coming_soon: ['Coming soon', 'cc-st-soon'], hidden: ['Hidden', 'cc-st-off'], retired: ['Retired', 'cc-st-off'] };
  const LEVEL_CLASS = { Expert: 'cc-lv-expert', Specialist: 'cc-lv-spec', General: 'cc-lv-gen' };

  const state = { data: null, loading: null, filter: 'live', q: '', mount: null };

  function injectStyles() {
    if (document.getElementById('cc-styles')) return;
    const css = `
.cc-box{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:16px}
.cc-muted{color:#6b7280}.cc-small{font-size:12px}.cc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#9ca3af}
.cc-pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700;white-space:nowrap}
.cc-st-live{background:#dcfce7;color:#166534}.cc-st-beta{background:#ede9fe;color:#5b21b6}.cc-st-soon{background:#fef3c7;color:#92400e}.cc-st-off{background:#f3f4f6;color:#6b7280}
.cc-lv-expert{background:#fce7f3;color:#9d174d}.cc-lv-spec{background:#e0f2fe;color:#075985}.cc-lv-gen{background:#f3f4f6;color:#4b5563}
.cc-warn{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:12px;padding:10px 12px;font-size:13px}
.cc-chips{display:flex;flex-wrap:wrap;gap:6px}
.cc-chip{border:1px solid #e5e7eb;border-radius:999px;padding:4px 12px;font-size:13px;font-weight:600;background:#fff;cursor:pointer}
.cc-chip[aria-pressed="true"]{background:#111827;color:#fff;border-color:#111827}
.cc-table{width:100%;border-collapse:collapse;font-size:13px}
.cc-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;padding:8px 10px;border-bottom:1px solid #e5e7eb;white-space:nowrap}
.cc-table td{padding:8px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top}
.cc-table tr.cc-row{cursor:pointer}.cc-table tr.cc-row:hover td{background:#f9fafb}
.cc-num{text-align:right;font-variant-numeric:tabular-nums}
.cc-role{border:1px solid #e5e7eb;border-radius:16px;background:#fff;margin-top:12px}
.cc-role>summary{list-style:none;cursor:pointer;padding:14px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.cc-role>summary::-webkit-details-marker{display:none}
.cc-role>summary::before{content:'▸';color:#9ca3af;transition:transform .15s}.cc-role[open]>summary::before{transform:rotate(90deg)}
.cc-role-body{padding:0 16px 16px}
.cc-sec{border-top:1px solid #f3f4f6;padding-top:12px;margin-top:12px}
.cc-sec h4{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#374151;margin:0 0 8px}
.cc-sec h5{font-size:12px;font-weight:700;color:#6b7280;margin:10px 0 4px}
.cc-list{margin:0;padding:0;list-style:none}
.cc-list li{padding:4px 0;font-size:13px;line-height:1.45;border-bottom:1px dashed #f3f4f6}
.cc-list li:last-child{border-bottom:0}
.cc-list b{font-weight:600;color:#111827}
.cc-when{font-size:11px;color:#92400e;background:#fffbeb;border-radius:6px;padding:0 6px;margin-left:4px}
.cc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:4px 16px}
.cc-no li::before{content:'✕ ';color:#dc2626;font-weight:700}
.cc-yes li::before{content:'✓ ';color:#16a34a;font-weight:700}
@media (max-width:640px){.cc-hide-sm{display:none}}
`;
    const el = document.createElement('style');
    el.id = 'cc-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  async function fetchData(force) {
    if (state.data && !force) return state.data;
    if (!state.loading || force) {
      state.loading = fetch(API, { credentials: 'same-origin' }).then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        state.data = body;
        return body;
      }).finally(() => { state.loading = null; });
    }
    return state.loading;
  }

  const statusPill = (s) => { const [l, c] = STATUS[s] || [s, 'cc-st-off']; return `<span class="cc-pill ${c}">${esc(l)}</span>`; };
  const levelPill = (lv) => `<span class="cc-pill ${LEVEL_CLASS[lv] || 'cc-lv-gen'}">${esc(lv)}</span>`;

  function itemLi(i) {
    return `<li><b>${esc(i.label)}</b>${i.when ? `<span class="cc-when">${esc(i.when)}</span>` : ''}${i.sees ? ` — ${esc(i.sees)}` : ''}${i.source && i.source !== 'its role instructions' ? ` <span class="cc-mono">${esc(i.source)}</span>` : ''}</li>`;
  }
  const list = (items, cls) => (items.length ? `<ul class="cc-list ${cls || ''}">${items.join('')}</ul>` : '<p class="cc-small cc-muted">None.</p>');

  /** The six sections for one assistant. Same order, same headings, every time. */
  function roleBody(r, data) {
    const c = r.caps;
    const exp = c.expertise;
    const warn = !c.described ? '<p class="cc-warn">⚠️ No words for this assistant yet in src/utils/assistant-chat-capabilities.ts (ROLE_PROFILES): its field, skills, can\'t-dos and own rules are missing below. Everything else is read from the code.</p>' : '';
    return `${warn}
      <div class="cc-sec"><h4>1 · Expertise</h4>
        <p style="font-size:13px">${levelPill(exp.level)} <b>${esc(exp.field)}</b></p>
        <p class="cc-small cc-muted" style="margin-top:4px">${esc(exp.levelMeans)}</p>
        ${exp.craft.length ? `<h5>Craft standards in its prompts</h5>${list(exp.craft.map((k) => `<li><b>${esc(k.title)}</b> — used by ${esc(k.usedBy)} <span class="cc-mono">${esc(k.source)}</span></li>`))}` : ''}
      </div>
      <div class="cc-sec"><h4>2 · What it reads <span class="cc-muted" style="text-transform:none;font-weight:600;letter-spacing:0">— read again for every message, never from memory</span></h4>
        <h5>Its own data</h5>${list(c.reads.ownData.map(itemLi))}
        <h5>Shared with every assistant</h5>${list(c.reads.everyAssistant.map(itemLi))}
        ${c.reads.sometimes.length ? `<h5>Only sometimes</h5>${list(c.reads.sometimes.map(itemLi))}` : ''}
      </div>
      <div class="cc-sec"><h4>3 · What it can see and change</h4>
        <p class="cc-small cc-muted" style="margin-bottom:6px">Each change is a card the user confirms; nothing changes from the chat alone.</p>
        ${list(c.controls.map(itemLi))}
      </div>
      <div class="cc-sec"><h4>4 · What it can do</h4>
        ${c.canDo.skills.length ? `<h5>In conversation</h5>${list(c.canDo.skills.map((s) => `<li>${esc(s)}</li>`), 'cc-yes')}` : ''}
        <h5>Cards it can offer (${c.canDo.cards.length})</h5>
        ${c.canDo.cards.length ? `<ul class="cc-list cc-grid cc-yes">${c.canDo.cards.map((k) => `<li>${esc(k.label)} <span class="cc-mono">${esc(k.type)}</span></li>`).join('')}</ul>` : '<p class="cc-small cc-muted">None: it replies in words only.</p>'}
      </div>
      <div class="cc-sec"><h4>5 · What it can't do</h4>
        ${list(c.cannot.map((s) => `<li>${esc(s)}</li>`), 'cc-no')}
        ${c.doesNotRead.length ? `<h5>Data it does not read (so it must not claim to know it)</h5><ul class="cc-list cc-grid cc-no">${c.doesNotRead.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="cc-sec"><h4>6 · Rules it follows</h4>${list(c.rules.map(itemLi))}</div>
      <p class="cc-small cc-muted" style="margin-top:12px">Chat model: <b>${esc(r.chatModel || `${data.chatDefaultModel || 'code default'} (code default)`)}</b>${c.reply.maxTokens ? ` · reply limit ${esc(c.reply.maxTokens)} tokens` : ''} · role key <span class="cc-mono">${esc(r.roleKey)}</span></p>`;
  }

  function freshnessBox(d) {
    const f = d.freshness;
    const warns = [];
    if (d.undescribedLive.length) warns.push(`⚠️ Live or beta with no words yet: ${d.undescribedLive.map(esc).join(', ')}.`);
    if (d.routesNotInCatalogue.length) warns.push(`Chat routes in the code with no catalogue row: ${d.routesNotInCatalogue.map(esc).join(', ')}.`);
    return `<div class="cc-box">
      <p style="font-size:14px;font-weight:700;margin-bottom:6px">How this list stays true</p>
      <ul class="cc-list cc-yes">
        <li><b>Read from the code, not typed in.</b> Each assistant's routes, data switches, prompt blocks and cards come from the chat code itself (${esc(f.routes)} chat routes, ${esc(f.promptBlocks)} shared prompt blocks, ${esc(f.routeFlags)} data switches, ${esc(f.cards)} card types).</li>
        <li><b>A test blocks drift.</b> <span class="cc-mono">${esc(f.test)}</span> fails the build when the chat code gains a route, data source, prompt block or card that this page does not describe, or when this page describes one the code no longer has.</li>
        <li><b>Data is never stale inside a chat.</b> Everything under "What it reads" is read again from the database for every message.</li>
        <li>This page describes the deployed code${f.commit ? ` at commit <span class="cc-mono">${esc(String(f.commit).slice(0, 8))}</span>` : ''}.</li>
      </ul>
      ${warns.length ? `<p class="cc-warn" style="margin-top:10px">${warns.join('<br>')}</p>` : ''}
      <p class="cc-small cc-muted" style="margin-top:10px"><b>Levels.</b> ${Object.entries(d.levels).map(([k, v]) => `${levelPill(k)} ${esc(v)}`).join(' &nbsp; ')}</p>
    </div>`;
  }

  function visibleRoles(d) {
    const q = state.q.trim().toLowerCase();
    return d.roles.filter((r) => (state.filter === 'all' || (state.filter === 'live' ? (r.status === 'live' || r.status === 'beta') : !(r.status === 'live' || r.status === 'beta')))
      && (!q || r.name.toLowerCase().includes(q) || r.roleKey.includes(q)));
  }

  function paint() {
    const d = state.data;
    const m = state.mount;
    if (!d || !m) return;
    const roles = visibleRoles(d);
    const chip = (k, label) => `<button type="button" class="cc-chip" data-cc-filter="${k}" aria-pressed="${state.filter === k}">${esc(label)}</button>`;
    m.innerHTML = `
      ${freshnessBox(d)}
      <div class="cc-box" style="margin-top:12px">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px">
          <div class="cc-chips">${chip('live', 'Live & beta')}${chip('other', 'Not live')}${chip('all', 'All')}</div>
          <input type="search" data-cc-search placeholder="Search name or role key" value="${esc(state.q)}" style="margin-left:auto;border:1px solid #e5e7eb;border-radius:8px;padding:6px 10px;font-size:13px;min-width:0;width:220px;max-width:100%">
        </div>
        <div style="overflow-x:auto"><table class="cc-table">
          <thead><tr><th>Assistant</th><th>Expertise</th><th class="cc-num">Own data</th><th class="cc-num">Can change</th><th class="cc-num">Cards</th><th class="cc-num">Can't do</th><th class="cc-num cc-hide-sm">Doesn't read</th></tr></thead>
          <tbody>${roles.map((r) => `<tr class="cc-row" data-cc-jump="${esc(r.roleKey)}">
            <td><b>${esc(r.name)}</b> ${statusPill(r.status)}${r.caps.described ? '' : ' <span class="cc-pill cc-st-soon">no words</span>'}</td>
            <td>${levelPill(r.caps.expertise.level)}</td>
            <td class="cc-num">${r.caps.reads.ownData.length}</td>
            <td class="cc-num">${r.caps.controls.length}</td>
            <td class="cc-num">${r.caps.canDo.cards.length}</td>
            <td class="cc-num">${r.caps.cannot.length}</td>
            <td class="cc-num cc-hide-sm">${r.caps.doesNotRead.length}</td></tr>`).join('') || '<tr><td colspan="7" class="cc-muted">No assistants match.</td></tr>'}</tbody>
        </table></div>
      </div>
      ${roles.map((r) => `<details class="cc-role" id="cc-role-${esc(r.roleKey)}">
        <summary><b style="font-size:15px">${esc(r.name)}</b> ${statusPill(r.status)} ${levelPill(r.caps.expertise.level)}
          <span class="cc-small cc-muted">${esc(r.caps.expertise.field)}${r.hiredCount ? ` · ${esc(r.hiredCount)} hired` : ''}</span></summary>
        <div class="cc-role-body">${roleBody(r, d)}</div></details>`).join('')}`;
  }

  // Bound once, to the document (memory never-bind-handlers-from-a-render-path).
  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener('click', (e) => {
      const f = e.target.closest('[data-cc-filter]');
      if (f) { state.filter = f.dataset.ccFilter; paint(); return; }
      const j = e.target.closest('[data-cc-jump]');
      if (j) {
        const det = document.getElementById(`cc-role-${j.dataset.ccJump}`);
        if (det) { det.open = true; det.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      }
    });
    document.addEventListener('input', (e) => {
      if (!e.target.matches('[data-cc-search]')) return;
      state.q = e.target.value;
      const pos = e.target.selectionStart;
      paint();
      const box = state.mount && state.mount.querySelector('[data-cc-search]');
      if (box) { box.focus(); try { box.setSelectionRange(pos, pos); } catch { /* not a text input */ } }
    });
  }

  async function load(mount) {
    injectStyles();
    bind();
    state.mount = mount;
    mount.innerHTML = '<p class="cc-muted" style="padding:24px;text-align:center">Loading…</p>';
    try {
      await fetchData(true);
      paint();
    } catch (err) {
      mount.innerHTML = `<p class="cc-warn">Could not load chat capabilities: ${esc(err.message)}</p>`;
    }
  }

  async function renderRole(roleKey, el) {
    injectStyles();
    el.innerHTML = '<p class="cc-muted cc-small">Loading…</p>';
    try {
      const d = await fetchData(false);
      const r = d.roles.find((x) => x.roleKey === roleKey);
      if (!r) { el.innerHTML = '<p class="cc-small cc-muted">This role has no catalogue row.</p>'; return; }
      el.innerHTML = `<p class="cc-small cc-muted" style="margin-bottom:4px">What this assistant's chat knows, reads, can and can't do, read from the code. All assistants side by side: Assistants ▸ Chat capabilities.</p>${roleBody(r, d)}`;
    } catch (err) {
      el.innerHTML = `<p class="cc-warn">Could not load chat capabilities: ${esc(err.message)}</p>`;
    }
  }

  window.AdminChatCaps = { load, renderRole };
})();
