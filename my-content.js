// my-content.js — My Content Media Hub controller
// Wrapped in IIFE to avoid global scope collisions with other view controllers.
(function () {

// ── Section config ────────────────────────────────────────────────
const SECTIONS = [
    {
        key: 'pending',
        label: 'Pending',
        icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
        badge: 'bg-amber-100 text-amber-700 border-amber-200',
        dot: 'bg-amber-400',
        defaultExpanded: true,
        emptyMessage: 'No pending content. Upload images, videos, or links to get started.',
    },
    {
        key: 'scheduled',
        label: 'Scheduled',
        icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>`,
        badge: 'bg-blue-100 text-blue-700 border-blue-200',
        dot: 'bg-blue-500',
        defaultExpanded: true,
        emptyMessage: 'No content is currently scheduled. Assets move here when an assistant queues them for a post.',
    },
    {
        key: 'posted',
        label: 'Posted',
        icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
        badge: 'bg-emerald-100 text-emerald-700 border-emerald-200',
        dot: 'bg-emerald-500',
        defaultExpanded: false,
        emptyMessage: 'No published content yet.',
    },
    {
        key: 'rejected',
        label: 'Rejected',
        icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>`,
        badge: 'bg-red-100 text-red-700 border-red-200',
        dot: 'bg-red-500',
        defaultExpanded: false,
        emptyMessage: 'No rejected content.',
    },
];

// ── State ─────────────────────────────────────────────────────────
let _assets = { pending: [], scheduled: [], posted: [], rejected: [] };
let _pendingFile = null;
let _activeTab = 'file';
let _assetToDelete = null;
let _assetToDetach = null;
let _orgId = null;
let _pollTimer = null;         // auto-refresh timer for pending-asset transitions
let _scanningAssetId = null;   // ID of asset currently being scanned (shown with indicator)
let _deepLinkAssetId = null;   // one-shot: asset to scroll-to/highlight/open after first render

// ── Init ──────────────────────────────────────────────────────────
window.initMyContent = async function (param) {
    document.getElementById('btn-open-upload')?.addEventListener('click', _openUploadModal);
    document.getElementById('btn-confirm-delete')?.addEventListener('click', _doDelete);
    document.getElementById('btn-confirm-detach')?.addEventListener('click', _doDetach);
    // Deep-link target (e.g. from a "Your AI video is ready" notification carrying
    // metadata.assetId). Accepts { assetId } or a raw id. Focused after the first render.
    _deepLinkAssetId = param && typeof param === 'object' ? param.assetId : param;
    await _loadAssets();
    _startPollingIfNeeded();
    _mcRefreshHeaderCredits();
};

// Show the persistent AI-credit balance pill in the page header.
async function _mcRefreshHeaderCredits() {
    const pill = document.getElementById('mc-credit-pill');
    const count = document.getElementById('mc-credit-count');
    if (!pill || !count) return;
    try {
        const res = await fetch('/.netlify/functions/get-ai-credit-balance');
        if (!res.ok) return;
        const { balance } = await res.json();
        count.textContent = balance;
        pill.classList.remove('hidden');
        pill.classList.add('flex');
    } catch { /* leave hidden */ }
}

// ── Load & render ─────────────────────────────────────────────────
async function _loadAssets() {
    try {
        const res = await fetch('/.netlify/functions/content-assets');
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        _assets = { pending: [], scheduled: [], posted: [], rejected: [], ...data.assets };
        // Try to capture orgId from first asset
        for (const bucket of Object.values(data.assets)) {
            if (Array.isArray(bucket) && bucket.length > 0) {
                _orgId = bucket[0].organisationId;
                break;
            }
        }
    } catch (e) {
        console.warn('Could not load assets:', e);
    }
    _renderSections();
    _startPollingIfNeeded();
}

// ── Smart polling ─────────────────────────────────────────────────
// While there are recently-uploaded pending assets, poll every 12s so the UI
// picks up any status transitions (pending → scheduled, scheduled → posted, etc.)
// driven by the calendar/assistant layer without requiring a manual refresh.
function _startPollingIfNeeded() {
    clearTimeout(_pollTimer);
    const recentPending = (_assets.pending || []).filter(a => {
        const age = Date.now() - new Date(a.createdAt).getTime();
        return age < 10 * 60 * 1000; // younger than 10 minutes
    });
    const scheduledCount = (_assets.scheduled || []).length;
    // Poll while there are young pending assets or any scheduled ones (could publish soon)
    if (recentPending.length > 0 || scheduledCount > 0) {
        _pollTimer = setTimeout(async () => {
            await _loadAssets();
        }, 12_000);
    }
}

function _renderSections() {
    const container = document.getElementById('content-sections');
    if (!container) return;
    container.innerHTML = SECTIONS.map(sec => _sectionHTML(sec)).join('');
    // One-shot deep-link focus (consumed so subsequent poll re-renders don't re-trigger).
    if (_deepLinkAssetId != null) {
        const target = _deepLinkAssetId;
        _deepLinkAssetId = null;
        _focusDeepLinkAsset(target);
    }
}

// Scroll to, highlight, and (for visual assets) open the deep-linked asset. Expands
// the asset's collapsed section first so the row is actually visible.
function _focusDeepLinkAsset(assetId) {
    const id = Number(assetId);
    // Which section holds it? Expand that section if collapsed.
    const sectionKey = Object.keys(_assets).find(k => (_assets[k] || []).some(a => a.id === id));
    const asset = sectionKey ? _assets[sectionKey].find(a => a.id === id) : null;
    if (!asset) return;

    const body = document.getElementById(`section-body-${sectionKey}`);
    if (body && body.classList.contains('hidden')) window._mcToggleSection(sectionKey);

    // Defer to next frame so layout reflects the expanded section before scrolling.
    requestAnimationFrame(() => {
        const row = document.querySelector(`[data-asset-id="${id}"]`);
        if (row) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.style.transition = 'background-color 0.6s ease';
            row.style.backgroundColor = 'rgba(16,185,129,0.14)'; // emerald tint
            setTimeout(() => { row.style.backgroundColor = ''; }, 2600);
        }
        // For a video/image, open the viewer straight away — that's the whole point of the link.
        if (asset.assetType === 'video' || asset.assetType === 'image') {
            window._mcViewAsset(id);
        }
    });
}

function _sectionHTML(sec) {
    const items = _assets[sec.key] || [];
    const count = items.length;
    const expanded = sec.defaultExpanded;

    const rows = count === 0
        ? `<div class="px-6 py-8 text-center text-sm text-gray-400">${sec.emptyMessage}</div>`
        : items.map(a => _assetRow(a, sec)).join('');

    return `
    <div class="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <button type="button" data-section="${sec.key}"
        onclick="window._mcToggleSection('${sec.key}')"
        class="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition cursor-pointer">
        <div class="flex items-center gap-3">
          <span class="inline-flex items-center gap-1.5 text-sm font-bold px-2.5 py-1 rounded-full border ${sec.badge}">
            <span class="w-1.5 h-1.5 rounded-full ${sec.dot}"></span>
            ${sec.label}
          </span>
          <span class="text-sm text-gray-400 font-medium">${count} ${count === 1 ? 'item' : 'items'}</span>
        </div>
        <svg id="chevron-${sec.key}" class="w-5 h-5 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}"
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <div id="section-body-${sec.key}" class="${expanded ? '' : 'hidden'}">
        <div class="border-t border-gray-100 divide-y divide-gray-100">
          ${rows}
        </div>
      </div>
    </div>`;
}

function _assetRow(asset, sec) {
    const icon = _typeIcon(asset.assetType, asset.mimeType);
    const date = new Date(asset.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const fileSize = asset.fileSize ? _formatBytes(asset.fileSize) : '';
    const source = _sourceInfo(asset);

    // Actions depend on status
    let actions = '';
    if (asset.status === 'pending') {
        actions = `
          <button type="button" onclick="window._mcPromptDelete(${asset.id})"
            title="Delete"
            class="p-1.5 text-gray-400 hover:text-red-500 transition cursor-pointer rounded-lg hover:bg-red-50">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>`;
    } else if (asset.status === 'scheduled') {
        actions = `
          <button type="button" onclick="window._mcPromptDetach(${asset.id})"
            class="text-xs font-bold text-amber-600 hover:text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-3 py-1.5 rounded-lg transition cursor-pointer">
            Remove from Post
          </button>`;
    } else if (asset.status === 'posted') {
        actions = `<span class="text-xs text-gray-400">Auto-removed in ~${_daysUntilPurge(asset.retentionDeleteAfter)}</span>`;
    } else if (asset.status === 'rejected') {
        // Rejected assets: no actions (reason is read-only, per spec)
        actions = '';
    }

    // Rejection reason — uneditable, per Scenario 3 spec
    const rejectionBadge = asset.status === 'rejected' && asset.rejectionReason
        ? `<div class="flex items-start gap-1.5 mt-1.5 px-2.5 py-1.5 bg-red-50 border border-red-200 rounded-lg">
             <svg class="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
             <span class="text-xs text-red-700 font-medium leading-snug select-none">${_escHtml(asset.rejectionReason)}</span>
           </div>`
        : '';

    // Scheduled post context badge
    const scheduledBadge = asset.status === 'scheduled' && asset.scheduledPostId
        ? `<span class="text-[10px] text-blue-600 font-bold bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded-full">Post #${asset.scheduledPostId}</span>`
        : '';

    // A visual asset (image/video) with a resolved URL can be opened in the viewer
    // lightbox. The backend (content-assets.ts GET) presigns storageUrl for both images
    // and videos, or falls back to externalUrl — so AI-generated videos are viewable here.
    const viewUrl = (asset.assetType === 'image' || asset.assetType === 'video') && !asset.purgedAt
        ? (asset.storageUrl || asset.externalUrl || '')
        : '';
    const canView = !!viewUrl;

    // Play-triangle overlay so video tiles read as playable.
    const playOverlay = asset.assetType === 'video'
        ? `<span class="absolute inset-0 flex items-center justify-center pointer-events-none">
             <span class="w-6 h-6 rounded-full bg-black/50 flex items-center justify-center">
               <svg class="w-3 h-3 text-white" style="margin-left:2px" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 4.5v11l9-5.5-9-5.5z"/></svg>
             </span>
           </span>`
        : '';
    // Corner chip on the thumbnail so ownership/source reads at a glance, without
    // having to read the row text (the ask in issue #54).
    const sourceChip = source
        ? `<span title="${source.label}" class="absolute bottom-0 right-1 w-4 h-4 rounded-full ${source.chipClass} shadow flex items-center justify-center pointer-events-none">${source.icon}</span>`
        : '';
    const thumbInner = (asset.assetType === 'image' && asset.storageUrl)
        ? `<img src="${asset.storageUrl}" alt="" class="w-full h-full object-cover rounded-lg">${playOverlay}${sourceChip}`
        : (asset.assetType === 'video' && asset.storageUrl)
            ? `<video src="${asset.storageUrl}" class="w-full h-full object-cover rounded-lg" preload="metadata" muted playsinline></video>${playOverlay}${sourceChip}`
            : `<div class="w-full h-full flex items-center justify-center text-gray-400">${icon}</div>${playOverlay}${sourceChip}`;
    const tile = canView
        ? `<button type="button" onclick="window._mcViewAsset(${asset.id})" title="View"
             class="relative w-14 h-14 rounded-xl bg-gray-100 overflow-hidden shrink-0 border border-gray-200 cursor-pointer hover:ring-2 hover:ring-emerald-400 transition">${thumbInner}</button>`
        : `<div class="relative w-14 h-14 rounded-xl bg-gray-100 overflow-hidden shrink-0 border border-gray-200">${thumbInner}</div>`;

    // A "View" action for visual assets, shown alongside the status-specific actions.
    const viewBtn = canView
        ? `<button type="button" onclick="window._mcViewAsset(${asset.id})" title="View"
             class="p-1.5 text-gray-400 hover:text-emerald-600 transition cursor-pointer rounded-lg hover:bg-emerald-50">
             <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
           </button>`
        : '';

    return `
    <div class="flex items-center gap-4 px-5 py-4 group hover:bg-gray-50 transition" data-asset-id="${asset.id}">
      ${tile}
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <p class="text-sm font-bold text-gray-900 truncate">${_escHtml(asset.name)}</p>
          ${source ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${source.badgeClass}">${source.label}</span>` : ''}
          ${scheduledBadge}
        </div>
        <p class="text-xs text-gray-400 mt-0.5">${_typeLabel(asset.assetType)}${fileSize ? ' · ' + fileSize : ''} · ${date}</p>
        ${rejectionBadge}
      </div>
      <div class="shrink-0 flex items-center gap-2">${viewBtn}${actions}</div>
    </div>`;
}

// ── Asset viewer (lightbox) ───────────────────────────────────────
// Opens an image/video asset in the #modal-view-asset lightbox. Looks the asset up
// across all status groups so it works from any section.
window._mcViewAsset = function (id) {
    const asset = Object.values(_assets).flat().find(a => a.id === id);
    if (!asset) return;
    const url = asset.storageUrl || asset.externalUrl || '';
    const modal = document.getElementById('modal-view-asset');
    const vid = document.getElementById('view-asset-video');
    const img = document.getElementById('view-asset-image');
    const empty = document.getElementById('view-asset-empty');
    const dl = document.getElementById('view-asset-download');
    const nameEl = document.getElementById('view-asset-name');
    if (!modal) return;

    nameEl.textContent = asset.name || 'Preview';
    vid.classList.add('hidden'); img.classList.add('hidden'); empty.classList.add('hidden');
    vid.pause?.(); vid.removeAttribute('src'); img.removeAttribute('src');

    if (url && asset.assetType === 'video') {
        vid.src = url; vid.classList.remove('hidden');
    } else if (url && asset.assetType === 'image') {
        img.src = url; img.classList.remove('hidden');
    } else {
        empty.classList.remove('hidden');
    }

    if (url) { dl.href = url; dl.classList.remove('hidden'); }
    else { dl.classList.add('hidden'); }

    modal.classList.remove('hidden');
};

window._mcCloseViewer = function () {
    const modal = document.getElementById('modal-view-asset');
    const vid = document.getElementById('view-asset-video');
    if (vid) { vid.pause?.(); vid.removeAttribute('src'); }
    modal?.classList.add('hidden');
};

// ── Section toggle ────────────────────────────────────────────────
window._mcToggleSection = function (key) {
    const body = document.getElementById(`section-body-${key}`);
    const chevron = document.getElementById(`chevron-${key}`);
    if (!body) return;
    const hidden = body.classList.toggle('hidden');
    if (chevron) chevron.classList.toggle('rotate-180', !hidden);
};

// ── Upload Modal ──────────────────────────────────────────────────
function _openUploadModal() {
    _pendingFile = null;
    _mcSwitchTab('file');
    document.getElementById('file-preview')?.classList.add('hidden');
    document.getElementById('upload-progress')?.classList.add('hidden');
    document.getElementById('upload-error')?.classList.add('hidden');
    document.getElementById('link-url') && (document.getElementById('link-url').value = '');
    document.getElementById('link-name') && (document.getElementById('link-name').value = '');
    // Reset the Generate AI panel
    _mcAiJobId = null;
    const aiPrompt = document.getElementById('ai-prompt');
    if (aiPrompt) aiPrompt.value = '';
    document.getElementById('ai-prompt-count') && (document.getElementById('ai-prompt-count').textContent = '0 / 1000');
    document.getElementById('ai-results')?.classList.add('hidden');
    document.getElementById('ai-results-hint')?.classList.add('hidden');
    document.getElementById('ai-loading')?.classList.add('hidden');
    document.getElementById('ai-error')?.classList.add('hidden');
    document.getElementById('ai-insufficient')?.classList.add('hidden');
    // Resolve which AI tabs this org may see (admin-managed per-assistant capabilities).
    // Reset to "none" first so a stale capability never flashes a forbidden tab.
    _mcCaps = { canImage: false, assistantCanVideo: false, tierCanVideo: false };
    _mcApplyTabVisibility();
    _mcLoadCapabilities();
    // Reset the Generate AI Video panel
    if (typeof _mcVidStopPolling === 'function') _mcVidStopPolling();
    _mcVidJobId = null;
    const vidPrompt = document.getElementById('vid-prompt');
    if (vidPrompt) vidPrompt.value = '';
    document.getElementById('vid-prompt-count') && (document.getElementById('vid-prompt-count').textContent = '0 / 1000');
    document.getElementById('vid-generating')?.classList.add('hidden');
    document.getElementById('vid-result')?.classList.add('hidden');
    document.getElementById('vid-error')?.classList.add('hidden');
    document.getElementById('vid-insufficient')?.classList.add('hidden');
    document.getElementById('vid-form')?.classList.remove('hidden');
    if (typeof _mcVidSetDuration === 'function') _mcVidSetDuration(6);
    document.getElementById('modal-upload')?.classList.remove('hidden');
}

window._mcSwitchTab = function (tab) {
    _activeTab = tab;
    const ACTIVE = 'flex-1 py-2 text-sm font-bold rounded-lg transition bg-white shadow text-gray-900 cursor-pointer';
    const IDLE   = 'flex-1 py-2 text-sm font-bold rounded-lg transition text-gray-500 hover:text-gray-700 cursor-pointer';
    const AI_EXTRA = ' flex items-center justify-center gap-1';

    const tabs = {
        file:  { btn: 'tab-file',  panel: 'panel-file' },
        link:  { btn: 'tab-link',  panel: 'panel-link' },
        ai:    { btn: 'tab-ai',    panel: 'panel-ai' },
        video: { btn: 'tab-video', panel: 'panel-video' },
    };
    const ICON_TABS = ['ai', 'video'];
    for (const [key, ids] of Object.entries(tabs)) {
        const btn = document.getElementById(ids.btn);
        const panel = document.getElementById(ids.panel);
        if (btn) btn.className = (key === tab ? ACTIVE : IDLE) + (ICON_TABS.includes(key) ? AI_EXTRA : '');
        if (panel) panel.classList.toggle('hidden', key !== tab);
    }

    // The AI/video panels have their own buttons, so hide the standard footer there.
    document.getElementById('upload-footer')?.classList.toggle('hidden', tab === 'ai' || tab === 'video');
    // switchTab rewrites every tab's className above (dropping `hidden`) — re-apply capability
    // visibility so forbidden tabs stay hidden.
    _mcApplyTabVisibility();
    if (tab === 'ai') _mcRefreshAiBalance();
    if (tab === 'video') _mcVidOnOpen();
};

// ── AI media capabilities (admin-managed, per assistant type) ──────
// Which AI tabs this org may use. Resolved on each modal-open from get-ai-credit-balance:
//   canImage          — an active assistant's type has AI image generation enabled
//   assistantCanVideo — an active assistant's type has AI video generation enabled
//   tierCanVideo      — the plan tier permits video (video needs BOTH this and assistantCanVideo)
let _mcCaps = { canImage: false, assistantCanVideo: false, tierCanVideo: false };

async function _mcLoadCapabilities() {
    try {
        const res = await fetch('/.netlify/functions/get-ai-credit-balance');
        if (!res.ok) return;
        const d = await res.json();
        _mcCaps = {
            canImage: !!d.canImage,
            assistantCanVideo: !!d.assistantCanVideo,
            tierCanVideo: !!d.tierCanVideo,
        };
    } catch { /* leave tabs hidden on failure — server-side gate is the source of truth */ }
    _mcApplyTabVisibility();
}

// Show the AI Image / AI Video tabs only when the org's assistants grant the capability.
function _mcApplyTabVisibility() {
    document.getElementById('tab-ai')?.classList.toggle('hidden', !_mcCaps.canImage);
    document.getElementById('tab-video')?.classList.toggle('hidden', !_mcCaps.assistantCanVideo);
}

function _mcDisableBtn(id, disabled) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = disabled;
    // disabled: variants aren't in the prebuilt CSS — toggle present utilities directly.
    btn.classList.toggle('opacity-50', disabled);
    btn.classList.toggle('cursor-not-allowed', disabled);
}

// ── Generate AI Image ─────────────────────────────────────────────
let _mcAiJobId = null;

window._mcAiPromptInput = function () {
    const el = document.getElementById('ai-prompt');
    const counter = document.getElementById('ai-prompt-count');
    if (el && counter) counter.textContent = `${el.value.length} / 1000`;
};

async function _mcRefreshAiBalance() {
    const el = document.getElementById('ai-balance');
    if (!el) return;
    try {
        const res = await fetch('/.netlify/functions/get-ai-credit-balance');
        if (!res.ok) return;
        const { balance } = await res.json();
        el.textContent = `${balance} credit${balance === 1 ? '' : 's'}`;
        _mcSetAiAffordable(balance >= 1);
    } catch { /* leave placeholder */ }
}

function _mcSetAiAffordable(canAfford) {
    const btn = document.getElementById('ai-generate-btn');
    const warn = document.getElementById('ai-insufficient');
    if (btn) {
        btn.disabled = !canAfford;
        // disabled: variants aren't in the prebuilt CSS — toggle present utilities directly.
        btn.classList.toggle('opacity-50', !canAfford);
        btn.classList.toggle('cursor-not-allowed', !canAfford);
    }
    warn?.classList.toggle('hidden', canAfford);
}

window._mcGenerateAI = async function () {
    const promptEl = document.getElementById('ai-prompt');
    const aspectEl = document.getElementById('ai-aspect');
    const errorEl  = document.getElementById('ai-error');
    const loadingEl = document.getElementById('ai-loading');
    const resultsEl = document.getElementById('ai-results');
    const hintEl    = document.getElementById('ai-results-hint');
    const btn       = document.getElementById('ai-generate-btn');

    const prompt = (promptEl?.value || '').trim();
    errorEl.classList.add('hidden');
    if (!prompt) { errorEl.textContent = 'Please describe the image you want.'; errorEl.classList.remove('hidden'); return; }

    // Loading state — disable the button to prevent duplicate calls (AC).
    btn.disabled = true;
    loadingEl.classList.remove('hidden');
    resultsEl.classList.add('hidden');
    hintEl.classList.add('hidden');
    resultsEl.innerHTML = '';

    try {
        const res = await fetch('/.netlify/functions/generate-ai-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, aspectRatio: aspectEl.value }),
        });

        if (res.status === 403) {
            // Capability was revoked since the modal opened — drop the tab and bail out.
            _mcCaps.canImage = false;
            _mcApplyTabVisibility();
            _mcSwitchTab('file');
            return;
        }
        if (res.status === 402) {
            const { balance } = await res.json().catch(() => ({ balance: 0 }));
            document.getElementById('ai-balance').textContent = `${balance} credit${balance === 1 ? '' : 's'}`;
            _mcSetAiAffordable(false);
            return;
        }
        if (res.status === 422) {
            const { error } = await res.json().catch(() => ({}));
            errorEl.textContent = error || 'Prompt flagged for policy violation. Please adjust your text and try again.';
            errorEl.classList.remove('hidden');
            return;
        }
        if (!res.ok) {
            errorEl.textContent = 'Image generation failed. Please try again.';
            errorEl.classList.remove('hidden');
            return;
        }

        const { jobId, images, balance } = await res.json();
        _mcAiJobId = jobId;
        if (typeof balance === 'number') {
            document.getElementById('ai-balance').textContent = `${balance} credit${balance === 1 ? '' : 's'}`;
            _mcSetAiAffordable(balance >= 1);
        }
        resultsEl.innerHTML = (images || []).map(img => `
            <button type="button" onclick="window._mcSelectAI(${img.index})"
              class="relative group rounded-xl overflow-hidden border border-gray-200 hover:border-emerald-500 hover:ring-2 hover:ring-emerald-400 transition cursor-pointer aspect-square">
              <img src="${img.url}" alt="" class="w-full h-full object-cover">
              <span class="absolute inset-0 flex items-center justify-center">
                <span class="opacity-0 group-hover:opacity-100 bg-white text-emerald-700 text-xs font-bold px-3 py-1 rounded-full shadow transition">Use this</span>
              </span>
            </button>`).join('');
        resultsEl.classList.remove('hidden');
        hintEl.classList.remove('hidden');
    } catch (e) {
        errorEl.textContent = 'Image generation failed. Please try again.';
        errorEl.classList.remove('hidden');
    } finally {
        loadingEl.classList.add('hidden');
        btn.disabled = false;
    }
};

window._mcSelectAI = async function (index) {
    const errorEl = document.getElementById('ai-error');
    errorEl.classList.add('hidden');
    if (_mcAiJobId == null) return;
    try {
        const res = await fetch('/.netlify/functions/generate-ai-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'select', jobId: _mcAiJobId, index }),
        });
        if (!res.ok) {
            errorEl.textContent = 'Could not save that image. Please try again.';
            errorEl.classList.remove('hidden');
            return;
        }
        document.getElementById('modal-upload')?.classList.add('hidden');
        await _loadAssets();
        _mcRefreshHeaderCredits();
    } catch {
        errorEl.textContent = 'Could not save that image. Please try again.';
        errorEl.classList.remove('hidden');
    }
};

// ── Generate AI Video ─────────────────────────────────────────────
let _mcVidJobId = null;
let _mcVidDuration = 6;
let _mcVidPollTimer = null;

window._mcVidPromptInput = function () {
    const el = document.getElementById('vid-prompt');
    const counter = document.getElementById('vid-prompt-count');
    if (el && counter) counter.textContent = `${el.value.length} / 1000`;
};

window._mcVidSetDuration = function (n) {
    _mcVidDuration = n;
    const on  = 'flex-1 py-1.5 text-sm font-bold rounded-md transition bg-white shadow text-gray-900 cursor-pointer';
    const off = 'flex-1 py-1.5 text-sm font-bold rounded-md transition text-gray-500 hover:text-gray-700 cursor-pointer';
    document.getElementById('vid-dur-6').className  = n === 6  ? on : off;
    document.getElementById('vid-dur-10').className = n === 10 ? on : off;
};

async function _mcVidOnOpen() {
    const locked = document.getElementById('vid-locked');
    const form = document.getElementById('vid-form');
    try {
        const res = await fetch('/.netlify/functions/get-ai-credit-balance');
        if (!res.ok) return;
        const { balance, tierCanVideo } = await res.json();
        document.getElementById('vid-balance').textContent = `${balance} credit${balance === 1 ? '' : 's'}`;
        // The tab is only shown when the assistant grants video, so here we only resolve the
        // remaining plan-tier gate: tier-locked → upgrade CTA; otherwise the credit check.
        locked.classList.toggle('hidden', !!tierCanVideo);
        form.classList.toggle('hidden', !tierCanVideo);
        if (tierCanVideo) {
            const warn = document.getElementById('vid-insufficient');
            const canAfford = balance >= 5;
            _mcDisableBtn('vid-generate-btn', !canAfford);
            warn.classList.toggle('hidden', canAfford);
        }
    } catch { /* leave default */ }
}

window._mcGenerateVideo = async function () {
    const prompt = (document.getElementById('vid-prompt')?.value || '').trim();
    const errEl  = document.getElementById('vid-error');
    errEl.classList.add('hidden');
    if (!prompt) { errEl.textContent = 'Please describe the video you want.'; errEl.classList.remove('hidden'); return; }

    document.getElementById('vid-form').classList.add('hidden');
    document.getElementById('vid-result').classList.add('hidden');
    document.getElementById('vid-generating').classList.remove('hidden');

    try {
        const res = await fetch('/.netlify/functions/generate-ai-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, durationSeconds: _mcVidDuration }),
        });

        if (res.status === 403) {
            const { code } = await res.json().catch(() => ({}));
            document.getElementById('vid-generating').classList.add('hidden');
            if (code === 'feature_unavailable') {
                // Assistant no longer grants video — drop the tab and bail to file upload.
                _mcCaps.assistantCanVideo = false;
                _mcApplyTabVisibility();
                _mcSwitchTab('file');
            } else {
                // Tier-locked → show the upgrade CTA.
                document.getElementById('vid-locked').classList.remove('hidden');
            }
            return;
        }
        if (res.status === 402) {
            document.getElementById('vid-generating').classList.add('hidden');
            document.getElementById('vid-form').classList.remove('hidden');
            document.getElementById('vid-insufficient').classList.remove('hidden');
            return;
        }
        if (res.status === 422) {
            const { error } = await res.json().catch(() => ({}));
            document.getElementById('vid-generating').classList.add('hidden');
            document.getElementById('vid-form').classList.remove('hidden');
            errEl.textContent = error || 'Prompt flagged for policy violation. Please adjust your text and try again.';
            errEl.classList.remove('hidden');
            return;
        }
        if (!res.ok) {
            document.getElementById('vid-generating').classList.add('hidden');
            document.getElementById('vid-form').classList.remove('hidden');
            errEl.textContent = 'Could not start video generation. Please try again.';
            errEl.classList.remove('hidden');
            return;
        }

        const { jobId } = await res.json();
        _mcVidJobId = jobId;
        _mcRefreshHeaderCredits();   // credits were held
        _mcVidStartPolling();
    } catch (e) {
        document.getElementById('vid-generating').classList.add('hidden');
        document.getElementById('vid-form').classList.remove('hidden');
        errEl.textContent = 'Could not start video generation. Please try again.';
        errEl.classList.remove('hidden');
    }
};

function _mcVidStartPolling() {
    _mcVidStopPolling();
    _mcVidPollTimer = setInterval(async () => {
        if (_mcVidJobId == null) return;
        try {
            const res = await fetch(`/.netlify/functions/generate-ai-video?jobId=${_mcVidJobId}`);
            if (!res.ok) return;
            const { status, videoUrl, errorMessage } = await res.json();
            if (status === 'completed') {
                _mcVidStopPolling();
                document.getElementById('vid-generating').classList.add('hidden');
                if (videoUrl) document.getElementById('vid-player').src = videoUrl;
                document.getElementById('vid-result').classList.remove('hidden');
                _loadAssets();
                _mcRefreshHeaderCredits();
            } else if (status === 'failed' || status === 'flagged') {
                _mcVidStopPolling();
                document.getElementById('vid-generating').classList.add('hidden');
                document.getElementById('vid-form').classList.remove('hidden');
                const errEl = document.getElementById('vid-error');
                errEl.textContent = status === 'flagged'
                    ? 'Prompt flagged for policy violation. Please adjust your text and try again.'
                    : (errorMessage || 'Video generation failed. Your credits were refunded.');
                errEl.classList.remove('hidden');
                _mcRefreshHeaderCredits();   // refund restored balance
            }
        } catch { /* keep polling */ }
    }, 5000);
}

function _mcVidStopPolling() {
    if (_mcVidPollTimer) { clearInterval(_mcVidPollTimer); _mcVidPollTimer = null; }
}

window._mcVideoDone = function () {
    _mcVidStopPolling();
    _mcVidJobId = null;
    document.getElementById('modal-upload')?.classList.add('hidden');
    _loadAssets();
    _mcRefreshHeaderCredits();
};

// ── File selection ────────────────────────────────────────────────
window._mcFileSelected = function (e) {
    const file = e.target.files?.[0];
    if (file) _setSelectedFile(file);
};

window._mcDragOver = function (e) {
    e.preventDefault();
    document.getElementById('drop-zone')?.classList.add('border-emerald-500', 'bg-emerald-50/40');
};

window._mcDragLeave = function () {
    document.getElementById('drop-zone')?.classList.remove('border-emerald-500', 'bg-emerald-50/40');
};

window._mcDrop = function (e) {
    e.preventDefault();
    document.getElementById('drop-zone')?.classList.remove('border-emerald-500', 'bg-emerald-50/40');
    const file = e.dataTransfer?.files?.[0];
    if (file) _setSelectedFile(file);
};

function _setSelectedFile(file) {
    _pendingFile = file;
    const preview = document.getElementById('file-preview');
    const iconEl = document.getElementById('file-preview-icon');
    const nameEl = document.getElementById('file-preview-name');
    const sizeEl = document.getElementById('file-preview-size');

    if (file.type.startsWith('image/') && file.size < 10 * 1024 * 1024) {
        const reader = new FileReader();
        reader.onload = e => { iconEl.innerHTML = `<img src="${e.target.result}" class="w-full h-full object-cover">`; };
        reader.readAsDataURL(file);
    } else {
        iconEl.innerHTML = file.type.startsWith('video/')
            ? `<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.72v6.56a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`
            : `<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`;
    }
    nameEl.textContent = file.name;
    sizeEl.textContent = _formatBytes(file.size);
    preview.classList.remove('hidden');
}

window._mcClearFile = function () {
    _pendingFile = null;
    document.getElementById('file-preview')?.classList.add('hidden');
    document.getElementById('file-input').value = '';
};

// ── Submit upload ─────────────────────────────────────────────────
window._mcSubmitUpload = async function () {
    const errorEl = document.getElementById('upload-error');
    const btn = document.getElementById('btn-upload-submit');
    errorEl.classList.add('hidden');

    if (_activeTab === 'link') {
        const url = document.getElementById('link-url').value.trim();
        const label = document.getElementById('link-name').value.trim();
        if (!url) {
            errorEl.textContent = 'Please enter a URL.';
            errorEl.classList.remove('hidden');
            return;
        }
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            const res = await fetch('/.netlify/functions/content-assets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: label || url,
                    assetType: 'link',
                    externalUrl: url,
                }),
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
            const linkData = await res.json();
            document.getElementById('modal-upload').classList.add('hidden');
            await _loadAssets();
            // Scroll to rejected if flagged
            if (linkData.rejected) {
                const body = document.getElementById('section-body-rejected');
                if (body?.classList.contains('hidden')) window._mcToggleSection('rejected');
                setTimeout(() => document.querySelector('[data-section="rejected"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
            }
        } catch (e) {
            errorEl.textContent = e.message;
            errorEl.classList.remove('hidden');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg> Add to My Content';
        }
        return;
    }

    // File upload
    if (!_pendingFile) {
        errorEl.textContent = 'Please select a file to upload.';
        errorEl.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Uploading…';

    try {
        // 1. Get presigned URL
        const urlRes = await fetch('/.netlify/functions/content-upload-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileName: _pendingFile.name,
                mimeType: _pendingFile.type,
                fileSize: _pendingFile.size,
                orgId: _orgId,
            }),
        });
        if (!urlRes.ok) {
            const err = await urlRes.json().catch(() => ({}));
            throw new Error(err.error || 'Could not get upload URL.');
        }
        const { uploadUrl, storageKey, storageUrl, mock } = await urlRes.json();

        // Show progress bar
        document.getElementById('upload-progress').classList.remove('hidden');

        if (!mock) {
            // 2a. Real upload via XMLHttpRequest for progress
            await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('PUT', uploadUrl);
                xhr.setRequestHeader('Content-Type', _pendingFile.type);
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 100);
                        document.getElementById('upload-bar').style.width = pct + '%';
                        document.getElementById('upload-percent').textContent = pct + '%';
                    }
                };
                xhr.onload = () => xhr.status < 400 ? resolve() : reject(new Error('Upload failed'));
                xhr.onerror = () => reject(new Error('Network error during upload'));
                xhr.send(_pendingFile);
            });
        } else {
            // 2b. Mock mode — simulate progress
            for (let p = 0; p <= 100; p += 20) {
                document.getElementById('upload-bar').style.width = p + '%';
                document.getElementById('upload-percent').textContent = p + '%';
                await new Promise(r => setTimeout(r, 80));
            }
        }

        // 3. Create DB record (server also runs safety scan synchronously)
        const assetType = _pendingFile.type.startsWith('video/') ? 'video' : 'image';
        const createRes = await fetch('/.netlify/functions/content-assets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: _pendingFile.name,
                assetType,
                mimeType: _pendingFile.type,
                fileSize: _pendingFile.size,
                storageKey,
                storageUrl,
            }),
        });
        if (!createRes.ok) throw new Error('File uploaded but record save failed. Please contact support.');

        const createData = await createRes.json();
        document.getElementById('modal-upload').classList.add('hidden');
        await _loadAssets();

        // If the safety scan flagged this asset, scroll the rejected section into view
        if (createData.rejected) {
            const rejectedSection = document.querySelector('[data-section="rejected"]');
            if (rejectedSection) {
                // Expand the section if collapsed
                const body = document.getElementById('section-body-rejected');
                if (body?.classList.contains('hidden')) window._mcToggleSection('rejected');
                setTimeout(() => rejectedSection.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
            }
        }

    } catch (e) {
        errorEl.textContent = e.message;
        errorEl.classList.remove('hidden');
        document.getElementById('upload-progress').classList.add('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg> Add to My Content';
    }
};

// ── Delete ────────────────────────────────────────────────────────
// Issue #55: an asset can be attached to a draft/scheduled post (via attach-draft-media /
// regenerate-post-media) without its own status ever flipping to 'scheduled' — so it can still
// show the plain Delete button here. Warn before deleting if any active post uses it.
window._mcPromptDelete = function (assetId) {
    _assetToDelete = assetId;
    const all = [...(_assets.pending || []), ...(_assets.scheduled || []), ...(_assets.posted || []), ...(_assets.rejected || [])];
    const asset = all.find(a => a.id === assetId);
    const warningEl = document.getElementById('delete-warning');
    const usedIn = asset?.usedInPosts || [];
    if (usedIn.length > 0) {
        const postWord = usedIn.length === 1 ? 'post' : 'posts';
        warningEl.textContent = `This is used in ${usedIn.length} draft/scheduled ${postWord}. Deleting it will flag ${usedIn.length === 1 ? 'that post' : 'those posts'} in the Review Queue so the assistant can source new media.`;
        warningEl.classList.remove('hidden');
    } else {
        warningEl.classList.add('hidden');
    }
    document.getElementById('modal-delete-asset').classList.remove('hidden');
};

async function _doDelete() {
    if (!_assetToDelete) return;
    try {
        const res = await fetch(`/.netlify/functions/content-assets?id=${_assetToDelete}`, { method: 'DELETE' });
        if (res.ok) {
            const d = await res.json().catch(() => ({}));
            document.getElementById('modal-delete-asset').classList.add('hidden');
            _assetToDelete = null;
            await _loadAssets();
            const affected = d.affectedPosts?.length || 0;
            if (affected > 0) {
                const msg = `Deleted. ${affected} ${affected === 1 ? 'post has' : 'posts have'} been flagged in the Review Queue for new media.`;
                window.showToast ? window.showToast(msg, { icon: '⚠️', duration: 6000 }) : alert(msg);
            }
        }
    } catch { alert('Could not delete. Please try again.'); }
}

// ── Detach from scheduled post (US3) ─────────────────────────────
window._mcPromptDetach = function (assetId) {
    _assetToDetach = assetId;
    // Find asset
    const all = [...(_assets.scheduled || [])];
    const asset = all.find(a => a.id === assetId);
    const warningEl = document.getElementById('detach-warning');
    if (asset?.scheduledPostId) {
        warningEl.textContent = `Post #${asset.scheduledPostId} will be flagged as "Draft / Requires Attention" if it cannot exist without this asset.`;
        warningEl.classList.remove('hidden');
    } else {
        warningEl.classList.add('hidden');
    }
    document.getElementById('modal-detach').classList.remove('hidden');
};

async function _doDetach() {
    if (!_assetToDetach) return;
    try {
        const res = await fetch(`/.netlify/functions/content-assets?id=${_assetToDetach}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'detach' }),
        });
        if (res.ok) {
            document.getElementById('modal-detach').classList.add('hidden');
            _assetToDetach = null;
            await _loadAssets();
        }
    } catch { alert('Could not detach. Please try again.'); }
}

// ── Helpers ───────────────────────────────────────────────────────
function _escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function _typeLabel(type) {
    return { image: 'Image', video: 'Video', link: 'Link' }[type] || type;
}

// Which of {your upload, AI-sourced, AI-generated} an asset is, for the badges in
// _assetRow. Driven by contentAssets.provider (US3 AC3.2 / Epic 1 AI Media Generation):
// 'fal' = generated, 'pexels' (or any other stock provider) = sourced, null = user upload.
// Only shown for visual assets — link assets are always user-provided, so no badge adds value.
function _sourceInfo(asset) {
    if (asset.assetType !== 'image' && asset.assetType !== 'video') return null;
    if (asset.provider === 'fal') {
        return {
            label: 'AI Generated',
            badgeClass: 'bg-pink-50 text-pink-700 border-pink-200',
            chipClass: 'bg-pink-500',
            icon: `<svg class="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2l1.6 4.8L16 8.4l-4.4 1.6L10 15l-1.6-5-4.4-1.6 4.4-1.6L10 2z"/></svg>`,
        };
    }
    if (asset.provider) {
        return {
            label: 'Sourced by Assistant',
            badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
            chipClass: 'bg-blue-500',
            icon: `<svg class="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M19 11a8 8 0 11-16 0 8 8 0 0116 0z"/></svg>`,
        };
    }
    return {
        label: 'Your Upload',
        badgeClass: 'bg-gray-50 text-gray-600 border-gray-200',
        chipClass: 'bg-gray-500',
        icon: `<svg class="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16"/></svg>`,
    };
}

function _typeIcon(type) {
    if (type === 'image') return `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>`;
    if (type === 'video') return `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.72v6.56a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`;
    return `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>`;
}

function _daysUntilPurge(retentionDate) {
    if (!retentionDate) return 'unknown time';
    const diff = new Date(retentionDate) - Date.now();
    const days = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    return days === 0 ? 'less than 1 day' : `${days} day${days !== 1 ? 's' : ''}`;
}

})(); // end IIFE
