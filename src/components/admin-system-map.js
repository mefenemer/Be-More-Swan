// src/components/admin-system-map.js — the System Map on Admin → Systems & connections
// (docs/system-map-plan.md, Phases 2–3).
//
// Be More Swan in the middle, every external system around it grouped by what it does, a line to
// each coloured by its health, AI models listed under their provider. A strip of totals on top
// (spend in GBP, tasks, systems down). Click a system → a drawer with its version, cost, models,
// monthly bills (add / end / delete), better options (a dated web check + decisions it respects) and
// links. Below the map, "Ask about systems": the chat
// (admin-systems-chat.ts) reads the same data and its cards send exactly the requests this page's
// own bill form sends to admin-system-map.ts.
//
// Vanilla, one IIFE (memory frontend-is-vanilla). Styles are scoped under .sm- and injected once, so
// the page doesn't depend on Tailwind having seen these class names. Every value printed goes
// through esc().
//
//   AdminSystemMap.load(mountEl)

(function () {
  'use strict';

  const API = '/.netlify/functions/admin-system-map';
  const CHAT_API = '/.netlify/functions/admin-systems-chat';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Which side of the hub each registry category sits on, and the group it joins.
  const GROUPS = [
    { key: 'ai', label: 'AI models', side: 'left', test: (c) => c === 'AI' },
    { key: 'media', label: 'Media & storage', side: 'left', test: (c) => c === 'Media' || c === 'Storage' },
    { key: 'data', label: 'Data & security', side: 'right', test: (c) => c === 'Database' || c === 'Security' },
    { key: 'email', label: 'Email', side: 'right', test: (c) => c === 'Email' },
    { key: 'billing', label: 'Billing', side: 'right', test: (c) => c === 'Billing' },
    { key: 'search', label: 'Search & lead data', side: 'right', test: (c) => c === 'Search' },
    { key: 'hosting', label: 'Hosting & config', side: 'right', test: (c) => /Hosting|DNS|Config/.test(c) },
    { key: 'connectors', label: 'Customer connectors', side: 'bottom', test: (c) => c.startsWith('Connector') },
  ];
  const groupOf = (s) => GROUPS.find((g) => g.test(String(s.category || ''))) || GROUPS.find((g) => g.key === 'hosting');

  const state = { mount: null, data: null, open: null, hideUnused: true, chat: { turns: [], busy: false }, ro: null, lastFocus: null };

  // ── Formatting ──────────────────────────────────────────────────────────────────────────────
  const gbp = (n) => {
    const v = Number(n) || 0;
    if (v === 0) return '£0';
    if (v < 0.01) return '<£0.01';
    return '£' + v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const num = (n) => (Number(n) || 0).toLocaleString('en-GB');
  const day = (iso) => {
    if (!iso) return '';
    const d = new Date(String(iso).replace(' ', 'T').slice(0, 19) + (String(iso).length <= 10 ? 'T00:00:00' : ''));
    return Number.isNaN(+d) ? String(iso).slice(0, 10) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const healthOf = (s) => {
    if (s.configured === false) return { cls: 'off', label: 'Not configured' };
    if (s.health === 'ok') return { cls: 'ok', label: 'Up' };
    if (s.health === 'error') return { cls: 'err', label: 'Down' };
    return { cls: 'na', label: s.configured === null ? 'Console-managed' : 'Configured · no live check' };
  };
  // Role keys → the assistant names admins know (from master_assistants, sent with the map).
  const roleName = (k) => (state.data?.roleNames || {})[k] || k;
  const roleList = (keys) => (keys || []).map(roleName).join(', ');
  const versionText = (s) => {
    const v = s.version || {};
    return [v.api, v.sdk].filter(Boolean).join(' · ');
  };

  // ── Styles (once) ───────────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sm-styles')) return;
    const st = document.createElement('style');
    st.id = 'sm-styles';
    st.textContent = `
      .sm-root{--sm-ok:#059669;--sm-err:#dc2626;--sm-na:#64748b;--sm-off:#cbd5e1;--sm-line:#e5e7eb;--sm-ink:#111827;--sm-sub:#6b7280;--sm-accent:#7c3aed;color:var(--sm-ink);font-size:14px}
      .sm-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
      .sm-tile{background:#fff;border:1px solid var(--sm-line);border-radius:12px;padding:12px 14px}
      .sm-tile b{display:block;font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:2px}
      .sm-tile span{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--sm-sub)}
      .sm-tile small{display:block;font-size:11px;color:var(--sm-sub);margin-top:2px}
      .sm-tile.err b{color:var(--sm-err)}
      .sm-note{border-radius:12px;padding:10px 14px;margin-bottom:12px;font-size:13px}
      .sm-note.warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e}
      .sm-note.bad{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}
      .sm-note.info{background:#f9fafb;border:1px solid var(--sm-line);color:var(--sm-sub)}
      .sm-toolbar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:10px}
      .sm-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--sm-sub)}
      .sm-legend i{display:inline-block;width:18px;height:0;border-top:3px solid;vertical-align:middle;margin-right:5px}
      .sm-map{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 170px minmax(0,1fr);gap:56px;align-items:start;padding:8px 0}
      .sm-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
      .sm-col{display:flex;flex-direction:column;gap:14px;position:relative;z-index:1;min-width:0}
      .sm-hubwrap{align-self:center;z-index:1}
      .sm-hub{background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;border-radius:18px;padding:18px 14px;text-align:center;box-shadow:0 8px 24px rgba(79,70,229,.25)}
      .sm-hub b{display:block;font-size:16px}
      .sm-hub small{display:block;opacity:.85;font-size:11px;margin-top:4px}
      .sm-group{background:#f9fafb;border:1px solid var(--sm-line);border-radius:14px;padding:10px}
      .sm-group h4{margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--sm-sub)}
      .sm-nodes{display:flex;flex-direction:column;gap:6px}
      .sm-node{display:block;width:100%;min-width:0;text-align:left;background:#fff;border:1px solid var(--sm-line);border-radius:10px;padding:8px 10px;cursor:pointer;font:inherit;color:inherit}
      .sm-node:hover{border-color:#c4b5fd}
      .sm-node:focus-visible{outline:2px solid var(--sm-accent);outline-offset:2px}
      .sm-node.sel{border-color:var(--sm-accent);box-shadow:0 0 0 2px rgba(124,58,237,.18)}
      .sm-nrow{display:flex;align-items:center;gap:8px;justify-content:space-between}
      .sm-name{font-weight:700;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .sm-cost{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--sm-ink);white-space:nowrap}
      .sm-ver{font-size:11px;color:var(--sm-sub);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .sm-dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block}
      .sm-dot.ok{background:var(--sm-ok)}.sm-dot.err{background:var(--sm-err)}.sm-dot.na{background:#fff;border:2px solid var(--sm-na);width:7px;height:7px}.sm-dot.off{background:var(--sm-off)}
      .sm-models{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
      .sm-chip{font-size:11px;background:#f3f4f6;border-radius:999px;padding:2px 8px;color:#374151;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
      .sm-chip em{font-style:normal;color:var(--sm-sub);margin-left:4px}
      .sm-conn{grid-column:1 / -1}
      .sm-conn .sm-nodes{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px}
      .sm-drawer-bg{position:fixed;inset:0;background:rgba(17,24,39,.3);z-index:10000}
      .sm-drawer{position:fixed;top:0;right:0;bottom:0;width:min(460px,100vw);background:#fff;z-index:10001;box-shadow:-8px 0 30px rgba(0,0,0,.12);display:flex;flex-direction:column}
      .sm-dhead{padding:16px 18px;border-bottom:1px solid var(--sm-line);display:flex;gap:10px;align-items:flex-start;justify-content:space-between}
      .sm-dhead h3{margin:0;font-size:17px;font-weight:800}
      .sm-dbody{padding:4px 18px 24px;overflow-y:auto;flex:1}
      .sm-sec{padding:14px 0;border-bottom:1px solid #f3f4f6}
      .sm-sec h5{margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--sm-sub)}
      .sm-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px}
      .sm-kv dt{color:var(--sm-sub)}.sm-kv dd{margin:0;font-variant-numeric:tabular-nums}
      .sm-tbl{width:100%;border-collapse:collapse;font-size:12px}
      .sm-tbl th{text-align:left;color:var(--sm-sub);font-weight:700;padding:4px 6px 4px 0;border-bottom:1px solid var(--sm-line)}
      .sm-tbl td{padding:6px 6px 6px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;font-variant-numeric:tabular-nums}
      .sm-tbl td.r,.sm-tbl th.r{text-align:right}
      .sm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--sm-sub);word-break:break-all}
      .sm-btn{font:inherit;font-size:12px;font-weight:700;border-radius:8px;padding:6px 10px;border:1px solid var(--sm-line);background:#fff;cursor:pointer;color:var(--sm-ink)}
      .sm-btn:hover{background:#f9fafb}.sm-btn[disabled]{opacity:.5;cursor:default}
      .sm-btn.pri{background:var(--sm-accent);border-color:var(--sm-accent);color:#fff}
      .sm-btn.pri:hover{background:#6d28d9}
      .sm-btn.danger{color:var(--sm-err)}
      .sm-link{color:var(--sm-accent);font-weight:700;font-size:12px;text-decoration:none}
      .sm-form{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
      .sm-form label{font-size:11px;font-weight:700;color:var(--sm-sub);display:flex;flex-direction:column;gap:3px}
      .sm-form input,.sm-form select{font:inherit;font-size:13px;border:1px solid #d1d5db;border-radius:8px;padding:6px 8px;color:var(--sm-ink);background:#fff}
      .sm-form .full{grid-column:1 / -1}
      .sm-err{color:var(--sm-err);font-size:12px;margin-top:6px}
      .sm-verdict{display:inline-block;font-size:12px;font-weight:700;border-radius:999px;padding:2px 10px;background:#f3f4f6;color:#374151}
      .sm-verdict.ok{background:#ecfdf5;color:#047857}.sm-verdict.warn{background:#fffbeb;color:#b45309}.sm-verdict.bad{background:#fef2f2;color:#b91c1c}
      .sm-alt{border:1px solid var(--sm-line);border-radius:10px;padding:10px;margin-top:8px}
      .sm-decisions{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
      .sm-decisions li{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;font-size:13px;background:#f9fafb;border-radius:8px;padding:6px 8px}
      .sm-chat{margin-top:22px;background:#fff;border:1px solid var(--sm-line);border-radius:14px;padding:14px}
      .sm-chat h3{margin:0 0 4px;font-size:15px;font-weight:800}
      .sm-log{display:flex;flex-direction:column;gap:10px;max-height:420px;overflow-y:auto;margin:10px 0}
      .sm-msg-u{align-self:flex-end;max-width:85%;background:#f3f4f6;border-radius:14px;padding:8px 12px;white-space:pre-wrap}
      .sm-msg-a{max-width:92%;display:flex;flex-direction:column;gap:6px}
      .sm-msg-a > div:first-child{background:#fff;border:1px solid var(--sm-line);border-radius:14px;padding:8px 12px;white-space:pre-wrap}
      .sm-card{border:1px solid var(--sm-line);border-radius:12px;padding:10px;background:#f9fafb}
      .sm-starters{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
      .sm-ask{display:flex;gap:8px}
      .sm-ask textarea{flex:1;font:inherit;font-size:13px;border:1px solid #d1d5db;border-radius:10px;padding:8px 10px;resize:vertical;min-height:40px}
      @media (max-width: 900px){
        .sm-map{grid-template-columns:minmax(0,1fr);gap:14px}
        .sm-svg{display:none}
        .sm-hubwrap{position:static;order:-1}
        .sm-conn{grid-column:auto}
      }
    `;
    document.head.appendChild(st);
  }

  // ── Loading ─────────────────────────────────────────────────────────────────────────────────
  async function load(mount) {
    injectStyles();
    state.mount = mount || state.mount;
    if (!state.mount) return;
    state.mount.classList.add('sm-root');
    if (!state.data) state.mount.innerHTML = '<p style="color:#9ca3af">Loading the system map… (health checks take a few seconds)</p>';
    try {
      const res = await fetch(API, { credentials: 'same-origin' });
      const d = await res.json().catch(() => ({}));
      if (res.status === 403) { state.mount.innerHTML = '<p style="color:#dc2626">Super admin access required.</p>'; return; }
      if (!res.ok) throw new Error(d.error || 'failed');
      state.data = d;
    } catch {
      state.mount.innerHTML = '<p style="color:#dc2626">Could not load the system map. Please try again.</p>';
      return;
    }
    const envLabel = document.getElementById('systems-env-label');
    if (envLabel) envLabel.textContent = `the ${state.data.environment}`;
    render();
    if (state.open) openDrawer(state.open, { keepFocus: true });
  }

  // ── Map ─────────────────────────────────────────────────────────────────────────────────────
  function nodeHtml(s) {
    const h = healthOf(s);
    const models = (s.models || []).filter((m) => m.callsAll > 0 || (m.chosenFor || []).length).slice(0, 6);
    const cost = s.spend && (s.spend.total30Gbp > 0 || s.spend.totalAllGbp > 0) ? `<span class="sm-cost" title="Last 30 days">${esc(gbp(s.spend.total30Gbp))}</span>` : '';
    const ver = versionText(s);
    return `<button type="button" class="sm-node${state.open === s.key ? ' sel' : ''}" data-key="${esc(s.key)}" data-health="${h.cls}" aria-label="${esc(s.name)}: ${esc(h.label)}">
      <div class="sm-nrow"><span class="sm-nrow" style="gap:7px;min-width:0"><span class="sm-dot ${h.cls}" title="${esc(h.label)}"></span><span class="sm-name">${esc(s.name)}</span></span>${cost}</div>
      ${ver ? `<div class="sm-ver">${esc(ver)}</div>` : ''}
      ${s.review && (s.review.verdict === 'consider' || s.review.verdict === 'switch') ? `<div class="sm-models"><span class="sm-verdict ${s.review.verdict === 'switch' ? 'bad' : 'warn'}" style="font-size:10px">${s.review.verdict === 'switch' ? 'Better option found' : 'Worth a look'}</span></div>` : ''}
      ${models.length ? `<div class="sm-models">${models.map((m) => `<span class="sm-chip">${esc(m.model)}${m.spend30Gbp > 0 ? `<em>${esc(gbp(m.spend30Gbp))}</em>` : ''}</span>`).join('')}</div>` : ''}
    </button>`;
  }

  function groupHtml(g, items) {
    if (!items.length) return '';
    const cls = g.side === 'bottom' ? 'sm-group sm-conn' : 'sm-group';
    return `<section class="${cls}" data-group="${g.key}"><h4>${esc(g.label)} · ${items.length}</h4><div class="sm-nodes">${items.map(nodeHtml).join('')}</div></section>`;
  }

  function render() {
    const draft = state.mount.querySelector('#sm-ask-input')?.value || '';
    const d = state.data;
    const t = d.totals || {};
    const r = d.readiness || {};
    const systems = d.systems || [];
    const visible = systems.filter((s) => !(state.hideUnused && s.tier === 'connector' && s.configured === false));
    const by = (side) => GROUPS.filter((g) => g.side === side).map((g) => groupHtml(g, visible.filter((s) => groupOf(s) === g))).join('');

    const notes = [];
    if (r.launchReady === false) {
      notes.push(`<div class="sm-note bad"><b>Not launch-ready in ${esc(d.environment)}.</b> ${r.missingCritical?.length ? `Missing: ${esc(r.missingCritical.join(', '))}. ` : ''}${r.unreachableCritical?.length ? `Down: ${esc(r.unreachableCritical.join(', '))}.` : ''}</div>`);
    }
    if ((d.unmappedModels || []).length) {
      notes.push(`<div class="sm-note warn">${(d.unmappedModels || []).length} logged model(s) don't belong to a system on the map yet: ${esc(d.unmappedModels.map((m) => m.model).join(', '))}. Their cost is still in the totals.</div>`);
    }
    if (d.runtime?.pinnedMatches === false) {
      notes.push(`<div class="sm-note warn">Functions run on Node ${esc(d.runtime.node)}, not the pinned NODE_VERSION ${esc(d.runtime.pinned)}.</div>`);
    }

    state.mount.innerHTML = `
      <div class="sm-strip">
        <div class="sm-tile"><span>Spend · 30 days</span><b>${esc(gbp(t.spend30Gbp))}</b><small>variable + monthly bills</small></div>
        <div class="sm-tile"><span>Spend · all time</span><b>${esc(gbp(t.spendAllGbp))}</b><small>${t.spendSince ? `since ${esc(day(t.spendSince))}` : 'nothing logged yet'}</small></div>
        <div class="sm-tile"><span>Tasks · 30 days</span><b>${esc(num(t.tasks30))}</b><small>${t.costPerTask30Gbp != null ? `${esc(gbp(t.costPerTask30Gbp))} per task` : 'no tasks yet'}</small></div>
        <div class="sm-tile"><span>Tasks · all time</span><b>${esc(num(t.tasksAll))}</b><small>${t.tasksSince ? `since ${esc(day(t.tasksSince))}` : ''}</small></div>
        <div class="sm-tile${t.systemsDown ? ' err' : ''}"><span>Systems down</span><b>${esc(num(t.systemsDown))}</b><small>${t.notConfigured ? `${esc(t.notConfigured)} not configured` : 'all configured'}</small></div>
      </div>
      ${notes.join('')}
      <div class="sm-toolbar">
        <div class="sm-legend" aria-label="Legend">
          <span><i style="border-color:var(--sm-ok)"></i>Up</span>
          <span><i style="border-color:var(--sm-err)"></i>Down</span>
          <span><i style="border-color:var(--sm-na);border-top-style:dashed"></i>Configured, no live check</span>
          <span><i style="border-color:var(--sm-off);border-top-style:dotted"></i>Not configured</span>
        </div>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <label style="font-size:12px;color:var(--sm-sub);display:flex;gap:6px;align-items:center"><input type="checkbox" id="sm-hide-unused" ${state.hideUnused ? 'checked' : ''}> Hide connectors not set up here</label>
          <button type="button" class="sm-btn" id="sm-check-all"${systems.some(inProgress) ? ' disabled' : ''} title="Search the web for better tools for every paid system (about 16 checks, a few minutes)">${systems.some(inProgress) ? 'Checking for better options…' : 'Check all for better options'}</button>
        </div>
      </div>
      <div class="sm-map" id="sm-map">
        <svg class="sm-svg" id="sm-svg" aria-hidden="true"></svg>
        <div class="sm-col" data-side="left">${by('left')}</div>
        <div class="sm-hubwrap"><div class="sm-hub" id="sm-hub"><b>Be More Swan</b><small>${esc(d.environment)} · ${esc(systems.length)} systems</small><small>£ at ${esc(d.fx?.usdToGbp)} per $${d.fx?.fromConfig ? '' : ' (default rate)'}</small></div></div>
        <div class="sm-col" data-side="right">${by('right')}</div>
        ${by('bottom')}
      </div>
      <p style="font-size:12px;color:var(--sm-sub);margin-top:8px">Costs are in GBP, converted from USD at the COGS report's rate. "All time" starts at the first logged cost for each system. Health and keys are for this deployment only — check the other environment from its own admin portal.</p>
      ${chatHtml()}`;

    state.mount.querySelectorAll('.sm-node').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.key)));
    state.mount.querySelector('#sm-hide-unused').addEventListener('change', (e) => { state.hideUnused = e.target.checked; render(); });
    state.mount.querySelector('#sm-check-all').addEventListener('click', async (e) => {
      const yes = window.confirmModal
        ? await window.confirmModal('Check every paid system for better options now? About 16 web-search checks on Opus 5.5 — a few pounds in all, logged to the costs above. It also runs by itself on the 2nd of each month.', { title: 'Check all for better options', confirmLabel: 'Check all', tone: 'primary' })
        : window.confirm('Check every paid system for better options now?');
      if (!yes) return;
      e.target.disabled = true;
      if (await post({ action: 'check_now', systemKeys: 'all' }, null)) { window.showToast?.('Checking every paid system — results appear over the next few minutes.'); load(); }
      else e.target.disabled = false;
    });
    schedulePoll();
    wireChat();
    if (draft) { const inp = state.mount.querySelector('#sm-ask-input'); if (inp) inp.value = draft; }
    requestAnimationFrame(drawLines);
    if (!state.ro && 'ResizeObserver' in window) {
      state.ro = new ResizeObserver(() => requestAnimationFrame(drawLines));
    }
    if (state.ro) { state.ro.disconnect(); const m = document.getElementById('sm-map'); if (m) state.ro.observe(m); }
  }

  // One curve from the hub to each node; the connectors get one curve to their group.
  function drawLines() {
    const map = document.getElementById('sm-map');
    const svg = document.getElementById('sm-svg');
    const hub = document.getElementById('sm-hub');
    if (!map || !svg || !hub || getComputedStyle(svg).display === 'none') return;
    const box = map.getBoundingClientRect();
    const hb = hub.getBoundingClientRect();
    const colour = { ok: 'var(--sm-ok)', err: 'var(--sm-err)', na: 'var(--sm-na)', off: 'var(--sm-off)' };
    const dash = { na: '6 5', off: '2 5' };
    const paths = [];
    const hubY = hb.top + hb.height / 2 - box.top;
    map.querySelectorAll('.sm-col .sm-node').forEach((n) => {
      const nb = n.getBoundingClientRect();
      const left = nb.right < hb.left;
      const x1 = (left ? hb.left : hb.right) - box.left;
      const x2 = (left ? nb.right : nb.left) - box.left;
      const y2 = nb.top + nb.height / 2 - box.top;
      const mx = (x1 + x2) / 2;
      const h = n.dataset.health;
      paths.push(`<path d="M${x1},${hubY} C${mx},${hubY} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${colour[h] || colour.na}" stroke-width="${h === 'err' ? 2.5 : 1.5}"${dash[h] ? ` stroke-dasharray="${dash[h]}"` : ''} opacity="${h === 'off' ? 0.8 : 0.65}"/>`);
    });
    const conn = map.querySelector('.sm-conn');
    if (conn) {
      const cb = conn.getBoundingClientRect();
      const x = hb.left + hb.width / 2 - box.left;
      paths.push(`<path d="M${x},${hb.bottom - box.top} L${x},${cb.top - box.top}" fill="none" stroke="var(--sm-na)" stroke-width="1.5" stroke-dasharray="6 5" opacity=".6"/>`);
    }
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    svg.innerHTML = paths.join('');
  }

  // ── Drawer ──────────────────────────────────────────────────────────────────────────────────
  function closeDrawer() {
    document.getElementById('sm-drawer-bg')?.remove();
    document.getElementById('sm-drawer')?.remove();
    document.removeEventListener('keydown', onKey);
    state.release?.(); state.release = null;
    const key = state.open;
    state.open = null;
    state.mount?.querySelectorAll('.sm-node.sel').forEach((n) => n.classList.remove('sel'));
    // Back to the system's node: only a node opens the drawer, and after a save the map re-rendered (the
    // original element is gone). Safari never focuses a clicked button, so activeElement can't be trusted.
    const back = state.mount?.querySelector(`.sm-node[data-key="${CSS.escape(key || '')}"]`) || (state.lastFocus?.isConnected ? state.lastFocus : null);
    back?.focus?.();
  }
  // Escape closes the drawer — unless a confirm/prompt dialog is open over it (that Escape is the dialog's).
  function onKey(e) { if (e.key === 'Escape' && !document.getElementById('aura-confirm-modal')) closeDrawer(); }

  function drawerHtml(s) {
    const h = healthOf(s);
    const sp = s.spend || {};
    const v = s.version || {};
    const t = state.data.totals || {};
    const share = t.tasks30 > 0 && sp.total30Gbp > 0 ? gbp(sp.total30Gbp / t.tasks30) : null;
    const today = new Date().toISOString().slice(0, 10);
    const models = s.models || [];
    const bills = s.fixedCosts || [];
    return `
      <div class="sm-dhead">
        <div style="min-width:0"><h3 id="sm-dtitle">${esc(s.name)}</h3><p style="margin:2px 0 0;font-size:12px;color:var(--sm-sub)">${esc(s.category)} · ${esc(s.tier)}</p></div>
        <button type="button" class="sm-btn" id="sm-close" aria-label="Close">✕</button>
      </div>
      <div class="sm-dbody">
        <div class="sm-sec">
          <h5>Status</h5>
          <dl class="sm-kv">
            <dt>Health</dt><dd><span class="sm-dot ${h.cls}"></span> ${esc(h.label)}</dd>
            <dt>Keys</dt><dd>${s.configured === null ? 'Managed in the console' : s.configured ? `Set${s.maskedHint ? ` <span class="sm-mono">${esc(s.maskedHint)}</span>` : ''}` : 'Missing in this environment'}</dd>
            ${v.api ? `<dt>API</dt><dd>${esc(v.api)}</dd>` : ''}
            ${v.sdk ? `<dt>Client</dt><dd>${esc(v.sdk)}</dd>` : ''}
          </dl>
          <p style="font-size:13px;color:#374151;margin:10px 0 0">${esc(s.purpose)}</p>
        </div>
        <div class="sm-sec">
          <h5>Cost (GBP)</h5>
          <table class="sm-tbl"><thead><tr><th></th><th class="r">30 days</th><th class="r">All time</th></tr></thead><tbody>
            <tr><td>Usage</td><td class="r">${esc(gbp(sp.variable30Gbp))}</td><td class="r">${esc(gbp(sp.variableAllGbp))}</td></tr>
            <tr><td>Monthly bills</td><td class="r">${esc(gbp(sp.fixed30Gbp))}</td><td class="r">${esc(gbp(sp.fixedAllGbp))}</td></tr>
            <tr><td><b>Total</b></td><td class="r"><b>${esc(gbp(sp.total30Gbp))}</b></td><td class="r"><b>${esc(gbp(sp.totalAllGbp))}</b></td></tr>
          </tbody></table>
          <p style="font-size:12px;color:var(--sm-sub);margin:8px 0 0">${sp.since ? `All time = since ${esc(day(sp.since))}.` : 'No cost logged for this system yet.'}${sp.calls30 ? ` ${esc(num(sp.calls30))} paid calls in 30 days.` : ''}${share ? ` About ${esc(share)} for every task customers used.` : ''}</p>
        </div>
        ${models.length ? `<div class="sm-sec">
          <h5>Models</h5>
          <table class="sm-tbl"><thead><tr><th>Model</th><th>Used by (30 days)</th><th class="r">30 days</th><th class="r">All time</th></tr></thead><tbody>
            ${models.map((m) => `<tr>
              <td><span class="sm-mono" style="color:#111827">${esc(m.model)}</span>${m.chosenFor?.length ? `<br><small style="color:var(--sm-sub)">Chosen for ${esc(roleList(m.chosenFor))}</small>` : ''}</td>
              <td>${m.roles30?.length ? esc(roleList(m.roles30)) : '<span style="color:var(--sm-sub)">—</span>'}<br><small style="color:var(--sm-sub)">${esc(num(m.calls30))} calls</small></td>
              <td class="r">${esc(gbp(m.spend30Gbp))}</td><td class="r">${esc(gbp(m.spendAllGbp))}</td></tr>`).join('')}
          </tbody></table>
        </div>` : ''}
        <div class="sm-sec">
          <h5>Monthly bills</h5>
          ${bills.length ? `<table class="sm-tbl"><tbody>${bills.map((b) => `<tr>
              <td><b>${esc(b.label || 'Monthly bill')}</b><br><small style="color:var(--sm-sub)">${esc(b.currency)} ${esc(Number(b.amountMonthly).toFixed(2))}/month · ${esc(day(b.startedOn))} – ${b.endedOn ? esc(day(b.endedOn)) : 'now'}</small>${b.note ? `<br><small style="color:var(--sm-sub)">${esc(b.note)}</small>` : ''}</td>
              <td class="r" style="white-space:nowrap">${b.endedOn ? '' : `<button type="button" class="sm-btn" data-end="${esc(b.id)}">End</button> `}<button type="button" class="sm-btn danger" data-del="${esc(b.id)}">Delete</button></td>
            </tr>`).join('')}</tbody></table>` : '<p style="font-size:13px;color:var(--sm-sub);margin:0">No monthly bill entered. Add one for a subscription no API call shows.</p>'}
          <form class="sm-form" id="sm-bill-form">
            <label class="full">What it's for<input name="label" maxlength="80" placeholder="e.g. Pro plan"></label>
            <label>Per month<input name="amountMonthly" type="number" step="0.01" min="0" required></label>
            <label>Currency<select name="currency"><option>GBP</option><option>USD</option><option>EUR</option></select></label>
            <label>Started<input name="startedOn" type="date" required value="${today}"></label>
            <label>Ended (blank = still paying)<input name="endedOn" type="date"></label>
            <label class="full">Note<input name="note" maxlength="500"></label>
            <div class="full"><button type="submit" class="sm-btn pri">Add monthly bill</button><div class="sm-err" id="sm-bill-err" role="alert"></div></div>
          </form>
        </div>
        ${betterHtml(s)}
        <div class="sm-sec" style="border-bottom:0">
          <h5>Settings</h5>
          ${s.envVars?.length ? `<p class="sm-mono" style="margin:0 0 8px">${esc(s.envVars.join(' · '))}</p>` : ''}
          <a class="sm-link" href="${esc(s.consoleUrl)}" target="_blank" rel="noopener noreferrer">Open the ${esc(s.name)} console ↗</a>
          ${s.envVars?.length ? ` &nbsp; <a class="sm-link" href="https://app.netlify.com" target="_blank" rel="noopener noreferrer" style="color:var(--sm-sub)">Netlify environment variables ↗</a>` : ''}
        </div>
      </div>`;
  }

  // ── Better options (Phase 3) ────────────────────────────────────────────────────────────────
  const VERDICT = {
    keep: { label: 'Keep — nothing clearly better', cls: 'ok' },
    consider: { label: 'Worth a look', cls: 'warn' },
    switch: { label: 'Better option found', cls: 'bad' },
  };
  const inProgress = (s) => s.reviewAttempt && (s.reviewAttempt.state === 'queued' || s.reviewAttempt.state === 'running');
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };

  function betterHtml(s) {
    const r = s.review;
    const a = s.reviewAttempt;
    const decisions = s.decisions || [];
    if (!s.reviewable) {
      return `<div class="sm-sec"><h5>Better options</h5><p style="font-size:13px;color:var(--sm-sub);margin:0">Not checked. This is ${s.tier === 'connector' ? 'a connector your customers choose' : 'our own configuration, not a product we buy'}.</p></div>`;
    }
    const v = r && VERDICT[r.verdict];
    const attemptLine = !a ? ''
      : inProgress(s) ? `<p class="sm-note info" style="margin:8px 0 0">Checking now (started ${esc(day(a.createdAt))}). This takes a minute or two; the page refreshes itself.</p>`
      : `<p class="sm-note warn" style="margin:8px 0 0">The last check ${a.state === 'stalled' ? 'stopped before it finished' : 'failed'}${a.error ? `: ${esc(a.error)}` : '.'}</p>`;
    const alts = r ? (Array.isArray(r.alternatives) ? r.alternatives : []) : [];
    return `<div class="sm-sec" id="sm-better">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h5 style="margin:0">Better options</h5>
        <button type="button" class="sm-btn" id="sm-check-now"${inProgress(s) ? ' disabled' : ''}>${r ? 'Check again' : 'Check now'}</button></div>
      ${r ? `
        <p style="margin:10px 0 4px"><span class="sm-verdict ${v ? v.cls : ''}">${esc(v ? v.label : r.verdict)}</span>
          <small style="color:var(--sm-sub);margin-left:6px">Checked ${esc(day(r.finishedAt || r.createdAt))}${r.trigger === 'monthly' ? ' (monthly check)' : ''}</small></p>
        <p style="font-size:13px;color:#374151;margin:6px 0 0;white-space:pre-wrap">${esc(r.summary)}</p>
        ${alts.map((x, i) => `<div class="sm-alt">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
              <b style="font-size:13px">${x.url ? `<a class="sm-link" style="font-size:13px" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.name)} ↗</a>` : esc(x.name)}</b>
              <button type="button" class="sm-btn" data-notforus="${i}" title="Record that we decided against this, so later checks don't suggest it again">Not for us</button>
            </div>
            <div style="margin-top:4px">${(x.betterFor || []).map((b) => `<span class="sm-chip">Better ${esc(b)}</span>`).join(' ')} <span class="sm-chip">Switching: ${esc(x.switchingEffort)}</span></div>
            ${x.detail ? `<p style="font-size:12px;color:#374151;margin:6px 0 0">${esc(x.detail)}</p>` : ''}
            ${x.priceNote ? `<p style="font-size:12px;color:var(--sm-sub);margin:4px 0 0">${esc(x.priceNote)}</p>` : ''}
          </div>`).join('')}
        ${r.sources?.length ? `<p style="font-size:11px;color:var(--sm-sub);margin:8px 0 0">Sources: ${r.sources.map((u) => `<a class="sm-link" style="font-size:11px;font-weight:600" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(u))}</a>`).join(', ')}</p>` : ''}
        <p style="font-size:11px;color:var(--sm-sub);margin:6px 0 0">${r.searchCount > 0
          ? `An opinion from ${esc(r.searchCount)} web search${r.searchCount === 1 ? '' : 'es'} on that date, not advice. Prices change: check them before you switch.`
          : 'No web search was run for this check, so it is a general opinion, not checked against today\'s prices. Check again for a searched one.'}</p>`
      : `<p style="font-size:13px;color:var(--sm-sub);margin:8px 0 0">Not checked yet. A check searches the web for tools that beat this one on quality, features or price, given what we use it for and spend. It runs on the 2nd of each month, or now.</p>`}
      ${attemptLine}
      <h5 style="margin:14px 0 6px">Decisions already taken</h5>
      <p style="font-size:12px;color:var(--sm-sub);margin:0 0 6px">The check respects these and won't suggest what you turned down.</p>
      ${decisions.length ? `<ul class="sm-decisions">${decisions.map((d) => `<li><span>${esc(d.decision)} <small style="color:var(--sm-sub)">${esc(day(d.createdAt))}</small></span><button type="button" class="sm-btn" data-retire="${esc(d.id)}" title="No longer holds — later checks may suggest it again">Remove</button></li>`).join('')}</ul>` : '<p style="font-size:13px;color:var(--sm-sub);margin:0">None recorded.</p>'}
      <form class="sm-ask" id="sm-decision-form" style="margin-top:8px"><textarea name="decision" rows="1" maxlength="500" placeholder="e.g. We stay on Stripe for Connect payouts" aria-label="Add a decision"></textarea><button type="submit" class="sm-btn">Add</button></form>
      <div class="sm-err" id="sm-better-err" role="alert"></div>
    </div>`;
  }

  function wireBetter(dr, s) {
    const err = dr.querySelector('#sm-better-err');
    dr.querySelector('#sm-check-now')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      if (await post({ action: 'check_now', systemKeys: [s.key] }, err)) { window.showToast?.(`Checking ${s.name} — about two minutes.`); load(); }
      else e.target.disabled = false;
    });
    dr.querySelector('#sm-decision-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const decision = e.target.decision.value.trim();
      if (!decision) return;
      if (await post({ action: 'add_decision', systemKey: s.key, decision }, err)) { window.showToast?.('Decision recorded.'); load(); }
    });
    dr.querySelectorAll('[data-retire]').forEach((b) => b.addEventListener('click', async () => {
      if (await post({ action: 'retire_decision', id: Number(b.dataset.retire) }, err)) { window.showToast?.('Decision removed.'); load(); }
    }));
    dr.querySelectorAll('[data-notforus]').forEach((b) => b.addEventListener('click', async () => {
      const alt = (s.review?.alternatives || [])[Number(b.dataset.notforus)];
      if (!alt) return;
      const why = window.promptModal
        ? await window.promptModal(`Why not <b>${esc(alt.name)}</b>? Later checks will respect this.`, { title: 'Not for us', placeholder: 'e.g. quality was worse in our trial', confirmLabel: 'Record decision' })
        : window.prompt(`Why not ${alt.name}?`);
      if (why === null || why === undefined) return;
      const decision = `Turned down ${alt.name}${String(why).trim() ? `: ${String(why).trim()}` : ''}`.slice(0, 500);
      if (await post({ action: 'add_decision', systemKey: s.key, decision }, err)) { window.showToast?.('Decision recorded.'); load(); }
    }));
  }

  // While a check runs, refresh every 20 s — only while the map is on screen.
  function schedulePoll() {
    clearTimeout(state.poll);
    if (!(state.data?.systems || []).some(inProgress)) return;
    state.poll = setTimeout(() => {
      const map = document.getElementById('sm-map');
      if (map && map.offsetParent !== null) load();
    }, 20_000);
  }

  function openDrawer(key, opts = {}) {
    const s = (state.data?.systems || []).find((x) => x.key === key);
    if (!s) return;
    if (!opts.keepFocus) state.lastFocus = document.activeElement;
    document.getElementById('sm-drawer-bg')?.remove();
    document.getElementById('sm-drawer')?.remove();
    state.open = key;
    state.mount.querySelectorAll('.sm-node').forEach((n) => n.classList.toggle('sel', n.dataset.key === key));
    const bg = document.createElement('div');
    bg.id = 'sm-drawer-bg'; bg.className = 'sm-drawer-bg';
    bg.addEventListener('click', closeDrawer);
    const dr = document.createElement('aside');
    dr.id = 'sm-drawer'; dr.className = 'sm-drawer sm-root';
    dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-modal', 'true'); dr.setAttribute('aria-labelledby', 'sm-dtitle');
    dr.innerHTML = drawerHtml(s);
    document.body.appendChild(bg);
    document.body.appendChild(dr);
    document.addEventListener('keydown', onKey);
    dr.querySelector('#sm-close').addEventListener('click', closeDrawer);
    state.release?.();
    state.release = window.holdDialogFocus ? window.holdDialogFocus(dr, opts.keepFocus ? null : dr.querySelector('#sm-close')) : null;
    if (!window.holdDialogFocus && !opts.keepFocus) dr.querySelector('#sm-close').focus();

    wireBetter(dr, s);
    dr.querySelector('#sm-bill-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      const ok = await post({ action: 'add_fixed', systemKey: key, label: f.get('label'), amountMonthly: Number(f.get('amountMonthly')), currency: f.get('currency'), startedOn: f.get('startedOn'), endedOn: f.get('endedOn') || null, note: f.get('note') }, dr.querySelector('#sm-bill-err'));
      btn.disabled = false;
      if (ok) { window.showToast?.('Monthly bill added.'); load(); }
    });
    dr.querySelectorAll('[data-end]').forEach((b) => b.addEventListener('click', async () => {
      const endedOn = await askDate('Last day paid', new Date().toISOString().slice(0, 10));
      if (!endedOn) return;
      if (await post({ action: 'end_fixed', id: Number(b.dataset.end), endedOn }, dr.querySelector('#sm-bill-err'))) { window.showToast?.('Bill ended.'); load(); }
    }));
    dr.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const msg = 'Delete this bill? It comes out of every total, past ones included. To stop paying, use End instead.';
      const yes = window.confirmModal
        ? await window.confirmModal(msg, { title: 'Delete monthly bill', confirmLabel: 'Delete', tone: 'destructive' })
        : window.confirm(msg);
      if (!yes) return;
      if (await post({ action: 'delete_fixed', id: Number(b.dataset.del) }, dr.querySelector('#sm-bill-err'))) { window.showToast?.('Bill deleted.'); load(); }
    }));
  }

  async function askDate(label, def) {
    const v = window.promptModal
      ? await window.promptModal(esc(label), { title: 'End monthly bill', inputType: 'date', value: def, required: true, confirmLabel: 'End bill' })
      : window.prompt(label, def);
    return v ? String(v).trim() : null;
  }

  async function post(body, errEl) {
    if (errEl) errEl.textContent = '';
    try {
      const res = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Request failed (HTTP ${res.status}).`);
      return true;
    } catch (e) {
      if (errEl) errEl.textContent = e.message; else window.showToast?.(e.message, { icon: '⚠️' });
      return false;
    }
  }

  // ── Chat ────────────────────────────────────────────────────────────────────────────────────
  const STARTERS = ['What costs the most this month?', 'Is anything down or not set up?', 'Where could we save money or get better quality?', 'Add our Netlify Pro bill: $19 a month since 1 Sep 2026'];

  function chatHtml() {
    const c = state.chat;
    const turns = c.turns.map((t, i) => {
      if (t.role === 'user') return `<div class="sm-msg-u">${esc(t.content)}</div>`;
      const cards = (t.cards || []).map((k, j) => {
        const foot = k.state === 'done' ? '<span style="font-size:12px;font-weight:700;color:var(--sm-ok)">✓ Done</span>'
          : k.state === 'dismissed' ? '<span style="font-size:12px;color:var(--sm-sub)">Dismissed</span>'
          : `<button type="button" class="sm-btn ${k.kind === 'delete_fixed' ? 'danger' : 'pri'}" data-confirm="${i}:${j}"${k.state === 'busy' ? ' disabled' : ''}>${k.state === 'busy' ? 'Working…' : 'Confirm'}</button> <button type="button" class="sm-btn" data-dismiss="${i}:${j}">Dismiss</button>`;
        return `<div class="sm-card"><b style="font-size:13px">${esc(k.title)}</b><p style="font-size:12px;color:#4b5563;margin:2px 0 0">${esc(k.summary)}</p>${k.error ? `<p class="sm-err">${esc(k.error)}</p>` : ''}<div style="margin-top:8px">${foot}</div></div>`;
      }).join('');
      return `<div class="sm-msg-a"><div>${esc(t.content)}</div>${cards}</div>`;
    }).join('');
    return `<section class="sm-chat" aria-labelledby="sm-chat-h">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h3 id="sm-chat-h">Ask about systems</h3>${c.turns.length ? '<button type="button" class="sm-btn" id="sm-chat-clear">Clear</button>' : ''}</div>
      <p style="font-size:12px;color:var(--sm-sub);margin:0">Reads the same map as above. It can add, end or delete a monthly bill, and you confirm each change.</p>
      ${c.turns.length ? '' : `<div class="sm-starters">${STARTERS.map((s) => `<button type="button" class="sm-btn" data-starter="${esc(s)}">${esc(s)}</button>`).join('')}</div>`}
      <div class="sm-log" id="sm-log" aria-live="polite">${turns}${c.busy ? '<p style="font-size:12px;color:var(--sm-sub)">Looking…</p>' : ''}</div>
      <form class="sm-ask" id="sm-ask"><textarea id="sm-ask-input" rows="1" placeholder="Ask about any system, cost or model…" aria-label="Ask about systems"></textarea><button type="submit" class="sm-btn pri"${c.busy ? ' disabled' : ''}>Ask</button></form>
    </section>`;
  }

  function rerenderChat() {
    const old = state.mount.querySelector('.sm-chat');
    if (!old) return;
    const draft = state.mount.querySelector('#sm-ask-input')?.value || '';
    old.outerHTML = chatHtml();
    wireChat();
    const input = state.mount.querySelector('#sm-ask-input');
    if (input) input.value = draft;
    const log = state.mount.querySelector('#sm-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function wireChat() {
    const root = state.mount.querySelector('.sm-chat');
    if (!root) return;
    root.querySelector('#sm-ask').addEventListener('submit', (e) => { e.preventDefault(); send(root.querySelector('#sm-ask-input').value); });
    root.querySelector('#sm-ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e.target.value); } });
    root.querySelector('#sm-chat-clear')?.addEventListener('click', () => { state.chat.turns = []; rerenderChat(); });
    root.querySelectorAll('[data-starter]').forEach((b) => b.addEventListener('click', () => send(b.dataset.starter)));
    root.querySelectorAll('[data-confirm]').forEach((b) => b.addEventListener('click', () => { const [i, j] = b.dataset.confirm.split(':').map(Number); confirmCard(i, j); }));
    root.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', () => {
      const [i, j] = b.dataset.dismiss.split(':').map(Number);
      const k = state.chat.turns[i]?.cards?.[j];
      if (k && k.state === 'open') { k.state = 'dismissed'; rerenderChat(); }
    }));
  }

  async function send(text) {
    text = String(text || '').trim();
    const c = state.chat;
    if (!text || c.busy) return;
    c.turns.push({ role: 'user', content: text });
    c.busy = true;
    rerenderChat();
    const input = state.mount.querySelector('#sm-ask-input');
    if (input) input.value = '';
    try {
      const res = await fetch(CHAT_API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: c.turns.map((t) => ({ role: t.role, content: t.content })) }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Request failed (HTTP ${res.status}).`);
      c.turns.push({ role: 'assistant', content: d.reply, cards: (d.cards || []).map((k) => ({ ...k, state: 'open' })) });
    } catch (e) {
      c.turns.pop();
      window.showToast?.(e.message, { icon: '⚠️' });
      c.busy = false; rerenderChat();
      const inp = state.mount.querySelector('#sm-ask-input'); if (inp) inp.value = text;
      return;
    }
    c.busy = false;
    rerenderChat();
  }

  async function confirmCard(i, j) {
    const k = state.chat.turns[i]?.cards?.[j];
    if (!k || k.state !== 'open') return;
    k.state = 'busy'; k.error = null; rerenderChat();
    try {
      const res = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(k.request) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Request failed (HTTP ${res.status}).`);
      k.state = 'done';
      window.showToast?.('Done.');
      load();
    } catch (e) {
      k.state = 'open'; k.error = e.message; rerenderChat();
    }
  }

  window.AdminSystemMap = { load };
})();
