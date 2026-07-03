// integrations.js — Connections page controller

// ── Platform catalogue ───────────────────────────────────────────
const PLATFORMS = [
    {
        id: 'Facebook',
        oauthPlatform: true,
        oauthUrl: '/.netlify/functions/meta-oauth?action=start',
        emoji: '📘',
        iconBg: 'bg-blue-600',
        iconText: 'text-white',
        label: 'Facebook',
        tagline: 'Post to your Facebook Page and reach your audience directly.',
        handleLabel: 'Facebook Page URL',
        handlePlaceholder: 'https://facebook.com/yourpagename',
        handleHelp: 'The full URL of the Facebook Page you want this assistant to post to.',
        tokenLabel: 'Page Access Token',
        tokenHelp: 'A token that authorises Be More Swan to post on behalf of your Page. Never expires if generated correctly.',
        steps: [
            { text: 'Open the Meta Graph API Explorer', url: 'https://developers.facebook.com/tools/explorer/' },
            { text: 'Sign in with the Facebook account that has <strong>Admin</strong> access to your Page.' },
            { text: 'Click <strong>"Generate Access Token"</strong> at the top right.' },
            { text: 'From the dropdown, choose your <strong>Page</strong> (not "User Token").' },
            { text: 'Click <strong>"Generate"</strong>, approve all permissions, then copy the token shown.' },
            { text: 'Paste the token into the field below.' },
        ],
        note: 'You must be an Admin of the Facebook Page. If your page does not appear in the dropdown, check your role in Page Settings → Page Roles.',
    },
    {
        id: 'Instagram',
        oauthPlatform: true,
        oauthUrl: '/.netlify/functions/meta-oauth?action=start',
        emoji: '📸',
        iconBg: 'bg-gradient-to-br from-purple-600 via-pink-500 to-orange-400',
        iconText: 'text-white',
        label: 'Instagram',
        tagline: 'Publish posts, Reels, and Stories to your Instagram Business account.',
        handleLabel: 'Instagram Username',
        handlePlaceholder: '@yourbrand',
        handleHelp: 'Your Instagram username. The account must be a Business or Creator account.',
        tokenLabel: 'Instagram Access Token',
        tokenHelp: 'Instagram uses the same Meta API as Facebook. If you have already connected Facebook, the same token works here.',
        steps: [
            { text: 'Make sure your Instagram is a <strong>Business</strong> or <strong>Creator</strong> account — go to Instagram → Settings → Account → Switch to Professional Account if needed.' },
            { text: 'In Instagram Settings, go to <strong>Account → Linked Accounts</strong> and connect it to your Facebook Page.' },
            { text: 'Open the Meta Graph API Explorer', url: 'https://developers.facebook.com/tools/explorer/' },
            { text: 'Sign in and generate a <strong>Page Access Token</strong> for the connected Facebook Page (this token covers Instagram too).' },
            { text: 'Copy the token and paste it below.' },
        ],
        note: 'Personal Instagram accounts cannot be used with third-party tools — the account must be Business or Creator and linked to a Facebook Page.',
    },
    {
        id: 'LinkedIn',
        oauthPlatform: true,
        oauthUrl: '/.netlify/functions/social-oauth-init?platform=linkedin',
        emoji: '💼',
        iconBg: 'bg-blue-700',
        iconText: 'text-white',
        label: 'LinkedIn',
        tagline: 'Share thought leadership, company updates, and job posts.',
        handleLabel: 'LinkedIn Page or Profile URL',
        handlePlaceholder: 'https://linkedin.com/company/yourcompany',
        handleHelp: 'Your LinkedIn Company Page URL, or your personal profile URL if posting as yourself.',
        tokenLabel: 'LinkedIn Access Token',
        tokenHelp: 'An OAuth 2.0 access token from the LinkedIn Developer Portal.',
        steps: [
            { text: 'Go to LinkedIn Developer Portal', url: 'https://www.linkedin.com/developers/apps/new' },
            { text: 'Click <strong>"Create App"</strong>. Give it a name and associate it with your Company Page.' },
            { text: 'In the App, go to the <strong>"Auth"</strong> tab and request the following permissions: <code>r_liteprofile</code>, <code>w_member_social</code>, and <code>rw_company_admin</code>.' },
            { text: 'Go to the <strong>"OAuth 2.0 Tools"</strong> tab and click <strong>"Create token"</strong> with those scopes.' },
            { text: 'Copy the access token and paste it below.' },
        ],
        note: 'To post on behalf of a Company Page, your LinkedIn account must be an Admin of that page.',
    },
    {
        id: 'X',
        oauthPlatform: true,
        oauthUrl: '/.netlify/functions/social-oauth-init?platform=x',
        emoji: '✕',
        iconBg: 'bg-gray-950',
        iconText: 'text-white',
        label: 'X (Twitter)',
        tagline: 'Post threads, replies, and real-time content to X.',
        handleLabel: 'X Username',
        handlePlaceholder: '@yourbrand',
        handleHelp: 'Your X username with or without the @.',
        tokenLabel: 'Bearer Token',
        tokenHelp: 'A Bearer Token from the X Developer Portal gives read and write access to your account.',
        steps: [
            { text: 'Go to the X Developer Portal', url: 'https://developer.twitter.com/en/portal/dashboard' },
            { text: 'Sign in (or create a free developer account — it takes about 2 minutes).' },
            { text: 'Create a new <strong>Project</strong> and <strong>App</strong> inside it.' },
            { text: 'In your App settings, go to <strong>"User authentication settings"</strong> and enable <strong>Read and Write</strong> permissions.' },
            { text: 'Go to <strong>"Keys and Tokens"</strong> and copy the <strong>Bearer Token</strong>.' },
            { text: 'Paste it into the field below.' },
        ],
        note: 'X requires a free Developer account. The sign-up takes a few minutes and asks what you plan to build — describe it as "scheduling and publishing social media posts".',
    },
];

let _connToDelete = null;
let _userConnections = [];

// ── Per-assistant relevance ──────────────────────────────────────
// The relevance policy is owned and ENFORCED server-side (src/utils/connection-map.ts).
// The page passes the selected assistantId to the integrations GET and renders only the
// connectors the server returns in `allowedServices` — no policy is duplicated here.
const _esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let _assistants = [];
let _selectedAssistantId = null;
let _allowedServices = null; // null = no assistant scope → show all

// Per-assistant "Use for this assistant" toggle state (set when rendered inside the
// assistant detail Connections tab via initAssistantConnections). Connections are a
// shared org pool; this set is which connection IDs THIS assistant actually uses.
let _assistantScoped = false;
let _assistantSelectedIds = new Set();
// serviceName slug → short platform key stored in context.primary_platforms
const PLATFORM_KEY_MAP = { facebook: 'fb', instagram: 'ig', linkedin: 'li', x: 'x', twitter: 'x', tiktok: 'tt', youtube: 'yt', pinterest: 'pin' };

// Match a stored connection serviceName (e.g. 'x', 'linkedin' — lowercase from the OAuth
// callback) against a PLATFORMS id (e.g. 'X', 'LinkedIn' — capitalised). Case-insensitive,
// and treats x/twitter as the same platform via PLATFORM_KEY_MAP.
function _serviceMatchesPlatform(serviceName, platformId) {
    const s = String(serviceName || '').toLowerCase();
    const p = String(platformId || '').toLowerCase();
    if (s === p) return true;
    return !!PLATFORM_KEY_MAP[s] && PLATFORM_KEY_MAP[s] === PLATFORM_KEY_MAP[p];
}
// Social handles captured on Business Information (lowercase platform slug → handle).
// A platform can only be connected once a handle has been entered there.
let _socialHandles = {};

async function _loadSocialHandles() {
    try {
        const res = await fetch('/.netlify/functions/organisation-profile');
        if (res.ok) {
            const { profile } = await res.json();
            _socialHandles = (profile && profile.socialHandles) || {};
        }
    } catch { /* non-fatal — gating falls back to "add handle first" */ }
}

function _handleFor(platform) {
    const v = _socialHandles[(platform.id || '').toLowerCase()];
    return (typeof v === 'string' && v.trim()) ? v.trim() : '';
}

function _relevantPlatforms() {
    if (!_allowedServices) return PLATFORMS;
    // Server returns lowercase serviceNames ('facebook'); PLATFORMS ids are capitalised
    // ('Facebook'). Compare case-insensitively so the allow-list actually matches.
    const allow = new Set(_allowedServices.map(s => String(s).toLowerCase()));
    return PLATFORMS.filter(p => allow.has(String(p.id).toLowerCase()));
}

// Append the selected assistant so the OAuth flow binds the connection to it
// (and the server can enforce relevance). oauthUrl already carries a query string.
function _oauthUrl(platform) {
    return _selectedAssistantId
        ? `${platform.oauthUrl}&assistantId=${encodeURIComponent(_selectedAssistantId)}`
        : platform.oauthUrl;
}

async function _loadAssistantsForFilter() {
    const bar = document.getElementById('conn-assistant-bar');
    const sel = document.getElementById('conn-assistant-select');
    try {
        const res = await fetch('/.netlify/functions/get-assistants');
        if (res.ok) {
            const data = await res.json();
            _assistants = (data.assistants || []).filter(a => a.isActive !== false);
        }
    } catch { /* non-fatal */ }
    if (!sel) return;
    if (!_assistants.length) { if (bar) bar.classList.add('hidden'); return; }
    sel.innerHTML = _assistants.map(a =>
        `<option value="${a.id}">${_esc(a.name)}${a.role ? ' — ' + _esc(a.role) : ''}</option>`).join('');
    const urlId = new URLSearchParams(location.search).get('assistantId');
    _selectedAssistantId = (urlId && _assistants.some(a => String(a.id) === urlId)) ? urlId : String(_assistants[0].id);
    sel.value = _selectedAssistantId;
    if (bar) bar.classList.remove('hidden');
    if (!sel.dataset.bound) {
        sel.dataset.bound = '1';
        sel.addEventListener('change', () => { _selectedAssistantId = sel.value; _loadConnections(); });
    }
}

// ── Init ─────────────────────────────────────────────────────────
window.initIntegrations = async function () {
    await _loadSocialHandles();
    await _loadAssistantsForFilter();
    await _loadConnections();

    // Disconnect confirm button
    const confirmBtn = document.getElementById('btn-confirm-disconnect');
    if (confirmBtn) {
        const newBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
        newBtn.addEventListener('click', _doDisconnect);
    }
};

// ── Init inside the assistant detail Connections tab ─────────────
// Drives the same grid/modals as the standalone page, but scoped to ONE assistant
// (no dropdown) and with a per-assistant "Use for this assistant" toggle on each
// connected card. Connections remain a shared org pool.
window.initAssistantConnections = async function (assistantId, currentData) {
    _selectedAssistantId = String(assistantId);
    _assistantScoped = true;
    window._intLoadConnections = _loadConnections; // let the revoke-all flow refresh the grid
    _assistantSelectedIds = new Set([
        ...((currentData?.configuration?.appliedDefaults?.platforms) || []).map(Number),
        ...((window.cachedContext?.linked_integrations) || []).map(Number),
    ]);

    await _loadSocialHandles();
    await _loadConnections();

    // Disconnect confirm button (same wiring as initIntegrations)
    const confirmBtn = document.getElementById('btn-confirm-disconnect');
    if (confirmBtn) {
        const newBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
        newBtn.addEventListener('click', _doDisconnect);
    }
};

// Persist the per-assistant "Use for this assistant" toggle. Mirrors the old
// _renderPlatformsTab save: recompute primary_platforms slugs + linked_integrations
// + appliedDefaults.platforms, then PUT update-assistant-context.
window._intToggleUseForAssistant = async function (connId, checked) {
    connId = Number(connId);
    if (checked) _assistantSelectedIds.add(connId); else _assistantSelectedIds.delete(connId);
    const checkedIds = Array.from(_assistantSelectedIds);
    const activeConns = _userConnections.filter(c => c.status === 'active' && c.userId);
    const checkedKeys = activeConns
        .filter(c => checkedIds.includes(c.id))
        .map(c => PLATFORM_KEY_MAP[c.serviceName.toLowerCase()] || c.serviceName.toLowerCase());

    const statusEl = document.getElementById('platforms-save-status');
    if (statusEl) statusEl.textContent = 'Saving…';
    try {
        const updatedContext = { ...(window.cachedContext || {}), primary_platforms: checkedKeys, linked_integrations: checkedIds };
        const r = await fetch('/.netlify/functions/update-assistant-context', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistantId: parseInt(_selectedAssistantId), newContext: updatedContext, appliedDefaults: { platforms: checkedIds } }),
        });
        if (r.ok) {
            window.cachedContext = updatedContext;
            if (statusEl) { statusEl.textContent = '✓ Saved'; setTimeout(() => { if (statusEl.textContent === '✓ Saved') statusEl.textContent = ''; }, 2500); }
        } else if (statusEl) {
            statusEl.textContent = 'Error saving';
        }
    } catch {
        if (statusEl) statusEl.textContent = 'Error saving';
    }
};

// ── Load & render platform cards ─────────────────────────────────
async function _loadConnections() {
    const grid = document.getElementById('connections-grid');
    if (!grid) return;

    try {
        const url = _selectedAssistantId
            ? `/.netlify/functions/integrations?assistantId=${encodeURIComponent(_selectedAssistantId)}`
            : '/.netlify/functions/integrations';
        const res = await fetch(url);
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        _userConnections = (data.connections || []).filter(c => c.userId !== null);
        // Server-authoritative relevance allow-list (undefined when no assistant scope).
        _allowedServices = Array.isArray(data.allowedServices) ? data.allowedServices : null;
    } catch (e) {
        console.warn('Could not load connections:', e);
    }

    grid.innerHTML = '';
    const platforms = _relevantPlatforms();
    if (!platforms.length) {
        grid.innerHTML = '<div class="col-span-full bg-white border border-gray-200 rounded-2xl p-10 text-center text-sm text-gray-500">No connectors are relevant to this assistant yet. As we add more integrations (CRM, calendar, reviews), the right ones will appear here.</div>';
        return;
    }
    platforms.forEach(platform => {
        const conn = _userConnections.find(c => _serviceMatchesPlatform(c.serviceName, platform.id));
        grid.insertAdjacentHTML('beforeend', _platformCard(platform, conn));
    });
}

function _platformCard(platform, conn) {
    const isConnected = !!conn;
    const handle = conn?.externalUserId || '';

    // US-GAP-10.1.1 SC4: Active / Expiring Soon / Disconnected badges
    // Healthy, connected platforms show a pink "Connected" pill. (Pink Tailwind bg
    // utilities aren't in the prebuilt CSS, so the fills are set inline.)
    const connectedPill = `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-pink-700 border border-pink-200 px-2.5 py-1 rounded-full" style="background-color:#fce7f3"><span class="w-1.5 h-1.5 rounded-full" style="background-color:#ec4899"></span> Connected</span>`;
    let statusBadge;
    // Connections that carry an offline refresh token (e.g. X) are renewed silently by
    // the refresh-social-tokens cron, so their short-lived expiry shouldn't alarm the user.
    const autoRenews = isConnected && typeof conn.scopes === 'string' && conn.scopes.includes('offline.access');
    if (!isConnected) {
        statusBadge = `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-gray-500 bg-gray-100 border border-gray-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-gray-400"></span> Not connected</span>`;
    } else if (conn.status === 'expired' || conn.status === 'failed' || conn.status === 'revoked' || conn.status === 'token_refresh_failed') {
        statusBadge = `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-red-500"></span> Disconnected</span>`;
    } else if (autoRenews) {
        statusBadge = connectedPill;
    } else if (conn.tokenExpiresAt) {
        const daysLeft = Math.ceil((new Date(conn.tokenExpiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        if (daysLeft <= 7 && daysLeft > 0) {
            statusBadge = `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span> Expiring in ${daysLeft}d</span>`;
        } else if (daysLeft <= 0) {
            statusBadge = `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-red-500"></span> Disconnected</span>`;
        } else {
            statusBadge = connectedPill;
        }
    } else {
        statusBadge = conn.status === 'active'
            ? connectedPill
            : `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span> Needs attention</span>`;
    }

    // A platform can only be connected once its handle has been entered on Business
    // Information (single source of truth). Without one, show a disabled prompt that
    // points the user there instead of letting them start a connection.
    const hasHandle = !!_handleFor(platform);

    // US-SMM-4.1.1 / 4.1.2: OAuth platforms use redirect; manual token entry kept for non-OAuth
    const connectBtn = !hasHandle
        ? `<div class="flex flex-col gap-1.5">
               <button disabled class="px-4 py-2 bg-gray-100 text-gray-400 text-sm font-bold rounded-lg cursor-not-allowed self-start" type="button">Connect with ${platform.label}</button>
               <button onclick="window.loadView && window.loadView('assets')" class="text-xs font-semibold text-emerald-700 hover:underline cursor-pointer self-start" type="button">Add your ${platform.label} handle in Business Information first →</button>
           </div>`
        : platform.oauthPlatform
        ? `<a href="${_oauthUrl(platform)}" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg shadow transition cursor-pointer inline-block">Connect with ${platform.label}</a>`
        : `<button onclick="window._intOpenModal('${platform.id}')" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg shadow transition cursor-pointer" type="button">Connect</button>`;

    const reconnectBtn = platform.oauthPlatform
        ? `<a href="${_oauthUrl(platform)}" class="text-sm font-bold text-gray-500 hover:text-gray-800 transition cursor-pointer">Reconnect</a>`
        : `<button onclick="window._intOpenModal('${platform.id}')" class="text-sm font-bold text-gray-500 hover:text-gray-800 transition cursor-pointer" type="button">Update token</button>`;

    // US-SMM-4.3.2: preflight audit status badge
    const meta = conn?.metadata ?? {};
    const preflightStatus = meta.preflightStatus;
    const preflightChecks = meta.preflightAuditResults ?? [];
    let preflightBadge = '';
    if (isConnected && preflightStatus) {
        const colour = preflightStatus === 'passed' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : preflightStatus === 'partial' ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';
        const dot    = preflightStatus === 'passed' ? 'bg-emerald-500' : preflightStatus === 'partial' ? 'bg-amber-500 animate-pulse' : 'bg-red-500 animate-pulse';
        const label  = preflightStatus === 'passed' ? 'Audit passed' : preflightStatus === 'partial' ? 'Needs attention' : 'Audit failed';
        preflightBadge = `<span class="inline-flex items-center gap-1 text-xs font-bold ${colour} border px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 rounded-full ${dot}"></span>${label}</span>`;
    }

    // US-SMM-4.3.2: failed check cards with deep links + "I've done this" verification button
    const failedChecks = preflightChecks.filter(c => c.status === 'fail');
    let troubleshootingHtml = '';
    if (isConnected && failedChecks.length > 0) {
        // AC3.2.1: grouped LLM message shown above all failed cards (loaded async after render)
        const groupedMsgId = `trouble-grouped-${conn?.id}`;
        const cards = failedChecks.map(chk => `
            <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 flex flex-col gap-2" id="trouble-card-${conn?.id}-${chk.id}">
                <p class="text-xs font-bold text-amber-800">${chk.id}: ${chk.label}</p>
                <p class="text-xs text-amber-700">${chk.detail ?? ''}</p>
                <p class="text-xs text-amber-600 italic hidden" id="trouble-chat-${conn?.id}-${chk.id}"></p>
                <div class="flex items-center gap-2 flex-wrap">
                    ${chk.deepLink ? `<a href="${chk.deepLink}" target="_blank" rel="noopener noreferrer" class="text-xs font-bold text-amber-700 underline">Open Settings ↗</a>` : ''}
                    <button onclick="window._intVerifyCheck('${conn?.id ?? ''}','${platform.id.toLowerCase()}','${chk.id}','${(chk.label || '').replace(/'/g, "\\'")}','${(chk.detail || '').replace(/'/g, "\\'")}',this)" class="text-xs font-bold text-emerald-700 bg-white border border-emerald-300 rounded-lg px-2 py-0.5 cursor-pointer hover:bg-emerald-50 transition" type="button" id="verify-btn-${conn?.id}-${chk.id}">I've done this</button>
                    <span id="verify-spin-${conn?.id}-${chk.id}" class="hidden text-xs text-gray-400">Checking…</span>
                </div>
            </div>`).join('');
        troubleshootingHtml = `<div class="flex flex-col gap-2 pt-3 border-t border-amber-100">
            <p class="text-xs text-amber-700 italic" id="${groupedMsgId}">Reviewing configuration issues…</p>
            ${cards}
        </div>`;
        // AC3.2.1: fetch one grouped LLM message covering all failed checks (async, after DOM renders)
        setTimeout(() => window._intLoadGroupedTroubleshoot(conn?.id, platform.id.toLowerCase(), failedChecks), 50);
    }

    // US-SMM-4.2.2 / 4.2.1: Sync Profile and Generate Auto-Responder for Meta/LinkedIn
    const syncBtn = (isConnected && (platform.id === 'Instagram' || platform.id === 'Facebook' || platform.id === 'LinkedIn'))
        ? `<button onclick="window._intSyncProfile('${platform.id.toLowerCase()}')" class="text-xs font-bold text-blue-600 hover:text-blue-800 transition cursor-pointer" type="button">Sync Profile</button>`
        : '';
    const autoRespBtn = (isConnected && (platform.id === 'Instagram' || platform.id === 'Facebook'))
        ? `<button onclick="window._intGenerateAutoResponder()" class="text-xs font-bold text-purple-600 hover:text-purple-800 transition cursor-pointer" type="button">Auto-Responder</button>`
        : '';
    // AC1: Generate Bio for the social profile platforms.
    const bioBtn = (isConnected && (platform.id === 'Instagram' || platform.id === 'Facebook' || platform.id === 'LinkedIn'))
        ? `<button onclick="window._intGenerateBio()" class="text-xs font-bold text-emerald-600 hover:text-emerald-800 transition cursor-pointer" type="button">Generate Bio</button>`
        : '';

    const action = isConnected
        ? `<div class="flex items-center gap-2 flex-wrap">
               ${syncBtn}
               ${bioBtn}
               ${autoRespBtn}
               ${reconnectBtn}
               <button onclick="window._intPromptDisconnect(${conn.id})" class="text-sm font-bold text-red-500 hover:text-red-700 transition cursor-pointer" type="button">Disconnect</button>
           </div>`
        : connectBtn;

    // Per-assistant "Use for this assistant" toggle — only inside the assistant detail tab,
    // for live connections. Connections are a shared org pool; this controls whether THIS
    // assistant actually posts to it.
    const useToggle = (_assistantScoped && isConnected && conn.status === 'active')
        ? `<div class="flex items-center justify-between gap-3 pt-3 border-t border-gray-100">
               <span class="text-sm font-semibold text-gray-700">Use for this assistant</span>
               <label class="flex items-center cursor-pointer relative shrink-0">
                   <input type="checkbox" class="sr-only peer" ${_assistantSelectedIds.has(conn.id) ? 'checked' : ''} onchange="window._intToggleUseForAssistant(${conn.id}, this.checked)">
                   <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
               </label>
           </div>`
        : '';

    return `
        <div class="bg-white rounded-2xl border ${isConnected ? 'border-emerald-200 shadow-md' : 'border-gray-200 shadow-sm'} p-6 flex flex-col gap-4">
            <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-xl ${platform.iconBg} ${platform.iconText} flex items-center justify-center font-bold text-xl shadow-sm shrink-0">
                    ${platform.emoji}
                </div>
                <div class="flex-1 min-w-0">
                    <h3 class="font-extrabold text-gray-900">${platform.label}</h3>
                    <p class="text-sm text-gray-500 mt-0.5 truncate">${isConnected && handle ? handle : platform.tagline}</p>
                </div>
            </div>
            <div class="flex items-center justify-between pt-3 border-t border-gray-100">
                <div class="flex items-center gap-2 flex-wrap">
                    ${statusBadge}
                    ${preflightBadge}
                </div>
                ${action}
            </div>
            ${useToggle}
            ${troubleshootingHtml}
        </div>`;
}

// ── US-SMM-4.3.2: Load grouped LLM message for all failed checks (AC3.2.1) ──
// Called once per connection when failed checks are present — generates a single combined message.
window._intLoadGroupedTroubleshoot = async function (connId, platform, failedChecks) {
    const msgEl = document.getElementById(`trouble-grouped-${connId}`);
    if (!msgEl || !failedChecks?.length) return;
    try {
        const res = await fetch('/.netlify/functions/social-troubleshoot-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platform,
                checks: failedChecks.map(c => ({ checkId: c.id, checkLabel: c.label, checkDetail: c.detail })),
            }),
        });
        if (res.ok) {
            const data = await res.json();
            if (data.message) msgEl.textContent = data.message;
            else if (data.rateLimited) msgEl.textContent = 'Daily check limit reached — try again tomorrow.';
        } else {
            msgEl.classList.add('hidden');
        }
    } catch {
        msgEl.classList.add('hidden');
    }
};

// ── US-SMM-4.3.2: Verify a single pre-flight check ───────────────
// AC3.2.3: 10 re-check attempts per USER per CHECK per 24h (not per-platform)
window._intVerifyCheck = async function (connId, platform, checkId, checkLabel, checkDetail) {
    const spinEl = document.getElementById(`verify-spin-${connId}-${checkId}`);
    const btnEl  = document.getElementById(`verify-btn-${connId}-${checkId}`);
    const chatEl = document.getElementById(`trouble-chat-${connId}-${checkId}`);
    if (!btnEl) return;

    // AC3.2.3: Client-side rate limit is per-check (mirrors server-side key `userId:checkId`)
    const rlKey = `smc_rl_${checkId}`;
    const now = Date.now();
    let rlData = JSON.parse(localStorage.getItem(rlKey) || '{"count":0,"windowStart":0}');
    if (now - rlData.windowStart > 86400000) rlData = { count: 0, windowStart: now };
    if (rlData.count >= 10) {
        if (chatEl) { chatEl.textContent = 'You\'ve reached the daily re-check limit for this issue (10 per 24h). Please try again tomorrow.'; chatEl.classList.remove('hidden'); }
        return;
    }
    rlData.count++;
    localStorage.setItem(rlKey, JSON.stringify(rlData));

    btnEl.disabled = true;
    if (spinEl) spinEl.classList.remove('hidden');

    try {
        // Fetch LLM-generated contextual troubleshooting message for this specific check
        const chatRes = await fetch('/.netlify/functions/social-troubleshoot-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, checkId, checkLabel, checkDetail }),
        });
        if (chatRes.ok) {
            const chatData = await chatRes.json();
            if (chatEl && chatData.message) {
                chatEl.textContent = chatData.message;
                chatEl.classList.remove('hidden');
            }
            if (chatData.rateLimited) {
                if (chatEl) { chatEl.textContent = chatData.error; chatEl.classList.remove('hidden'); }
                return;
            }
        }

        // Run the actual pre-flight audit to recheck
        const auditRes = await fetch('/.netlify/functions/social-preflight-audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform }),
        });
        if (auditRes.ok) {
            await _loadConnections(); // Refresh to show updated check results
        }
    } catch { /* ignore */ } finally {
        if (spinEl) spinEl.classList.add('hidden');
        if (btnEl) btnEl.disabled = false;
    }
};

// ── Open connect modal ────────────────────────────────────────────
window._intOpenModal = function (platformId) {
    const platform = PLATFORMS.find(p => p.id === platformId);
    if (!platform) return;

    // US-SMM-4.1.1: OAuth platforms redirect instead of showing the token modal
    if (platform.oauthPlatform) {
        window.location.href = _oauthUrl(platform);
        return;
    }

    const existing = _userConnections.find(c => _serviceMatchesPlatform(c.serviceName, platformId));

    // Header
    document.getElementById('modal-platform-icon').className = `w-12 h-12 rounded-xl flex items-center justify-center text-xl font-bold shadow-sm shrink-0 ${platform.iconBg} ${platform.iconText}`;
    document.getElementById('modal-platform-icon').textContent = platform.emoji;
    document.getElementById('modal-platform-name').textContent = platform.label;
    document.getElementById('modal-platform-desc').textContent = platform.tagline;

    // Steps
    const stepsEl = document.getElementById('modal-steps');
    stepsEl.innerHTML = platform.steps.map((s, i) => {
        const link = s.url ? ` <a href="${s.url}" target="_blank" rel="noopener" class="text-emerald-600 hover:underline font-semibold inline-flex items-center gap-1">${s.text} <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg></a>` : `<span>${s.text}</span>`;
        return `<li class="flex items-start gap-3">
            <span class="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs font-extrabold flex items-center justify-center shrink-0 mt-0.5">${i + 1}</span>
            <p class="text-sm text-gray-700 leading-relaxed">${s.url ? link : s.text}</p>
        </li>`;
    }).join('');

    // Note
    const noteEl = document.getElementById('modal-note');
    if (platform.note) {
        noteEl.classList.remove('hidden');
        noteEl.innerHTML = `<svg class="w-4 h-4 shrink-0 text-amber-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>${platform.note}</span>`;
    } else {
        noteEl.classList.add('hidden');
    }

    // Form labels
    document.getElementById('handle-label').textContent = platform.handleLabel;
    document.getElementById('handle-help').textContent = platform.handleHelp;
    document.getElementById('conn-handle').placeholder = platform.handlePlaceholder;
    // Prefill the handle from Business Information (source of truth) so it's never asked twice.
    document.getElementById('conn-handle').value = existing?.externalUserId || _handleFor(platform) || '';
    document.getElementById('token-label').textContent = platform.tokenLabel;
    document.getElementById('token-help').textContent = platform.tokenHelp;
    document.getElementById('conn-token').value = '';
    document.getElementById('conn-token').type = 'password';
    document.getElementById('conn-service-name').value = platformId;
    document.getElementById('conn-type').value = 'api_key';
    document.getElementById('conn-error').classList.add('hidden');

    // Update submit button label
    document.getElementById('btn-connect-submit').innerHTML = `
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
        ${existing ? 'Update Connection' : 'Encrypt &amp; Connect'}`;

    document.getElementById('modal-connect').classList.remove('hidden');
};

// ── Toggle token visibility ───────────────────────────────────────
window._intToggleToken = function () {
    const input = document.getElementById('conn-token');
    input.type = input.type === 'password' ? 'text' : 'password';
};

// ── Submit credentials ────────────────────────────────────────────
window._intSubmit = async function (e) {
    if (e) e.preventDefault();

    const btn = document.getElementById('btn-connect-submit');
    const errorEl = document.getElementById('conn-error');
    const token = document.getElementById('conn-token').value.trim();
    const handle = document.getElementById('conn-handle').value.trim();
    const serviceName = document.getElementById('conn-service-name').value;

    if (!token) {
        errorEl.textContent = 'Please enter your access token.';
        errorEl.classList.remove('hidden');
        return;
    }

    errorEl.classList.add('hidden');
    btn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" class="opacity-75"/></svg> Encrypting…';
    btn.disabled = true;

    try {
        const res = await fetch('/.netlify/functions/integrations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serviceName, connectionType: 'api_key', apiKey: token, handle, assistantId: _selectedAssistantId || undefined }),
        });

        if (res.ok) {
            document.getElementById('modal-connect').classList.add('hidden');
            await _loadConnections(); // Refresh cards
        } else {
            const body = await res.json().catch(() => ({}));
            errorEl.textContent = body.error || 'Connection failed. Please check your token and try again.';
            errorEl.classList.remove('hidden');
        }
    } catch {
        errorEl.textContent = 'Network error — please check your connection and try again.';
        errorEl.classList.remove('hidden');
    } finally {
        btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg> Encrypt &amp; Connect';
        btn.disabled = false;
    }
};

// ── Disconnect ────────────────────────────────────────────────────
window._intPromptDisconnect = function (connId) {
    _connToDelete = connId;
    document.getElementById('modal-disconnect').classList.remove('hidden');
};

// ── US-SMM-4.2.2: Sync Profile ───────────────────────────────────
window._intSyncProfile = async function (platform) {
    const feedback = document.getElementById('revoke-all-feedback');
    if (feedback) { feedback.textContent = 'Syncing profile…'; feedback.classList.remove('hidden', 'text-red-700'); feedback.classList.add('text-blue-700'); }
    try {
        const res = await fetch('/.netlify/functions/social-profile-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        if (feedback) {
            const ok = Object.values(data.results ?? {}).some(r => r.status === 'ok');
            feedback.textContent = ok ? 'Profile synced successfully.' : 'Profile sync completed (some platforms skipped).';
            feedback.classList.remove('text-blue-700');
            feedback.classList.add(ok ? 'text-emerald-700' : 'text-amber-700');
            setTimeout(() => feedback.classList.add('hidden'), 4000);
        }
    } catch {
        if (feedback) { feedback.textContent = 'Profile sync failed. Please try again.'; feedback.classList.add('text-red-700'); }
    }
};

// ── US-SMM-4.2.1: Generate Auto-Responder ────────────────────────
window._intGenerateAutoResponder = async function () {
    const panel = document.getElementById('auto-responder-chat-panel');
    if (panel) {
        panel.classList.remove('hidden');
        panel.innerHTML = `<div class="flex items-center gap-3 p-5 border-b border-emerald-100">
            <div class="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0 text-emerald-700 font-bold text-sm">AI</div>
            <p class="text-sm text-gray-500 italic">Generating your auto-responder messages…</p>
        </div>`;
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    try {
        const res = await fetch('/.netlify/functions/social-auto-responder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        if (data.ok && data.draft) {
            _intRenderAutoResponderChatPanel(data.draft, data.metaPushStatus);
        } else {
            if (panel) {
                panel.innerHTML = `<div class="p-5 flex items-start gap-3">
                    <div class="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center shrink-0 text-red-600 font-bold text-sm">AI</div>
                    <p class="text-sm text-red-700 mt-1">${data.error ?? 'Auto-responder generation failed. Please try again.'}</p>
                </div>`;
            }
        }
    } catch {
        if (panel) {
            panel.innerHTML = `<div class="p-5 flex items-start gap-3">
                <div class="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center shrink-0 text-red-600 font-bold text-sm">AI</div>
                <p class="text-sm text-red-700 mt-1">Auto-responder generation failed. Please try again.</p>
            </div>`;
        }
    }
};

// AC2.1.3: Render the workspace chat panel with generated scripts + Edit/Undo controls
function _intRenderAutoResponderChatPanel(draft, metaPushStatus) {
    const panel = document.getElementById('auto-responder-chat-panel');
    if (!panel) return;
    const statusMsg = (metaPushStatus === 'ok' || metaPushStatus === 'partial')
        ? `I've successfully configured your Facebook Messenger auto-responder and Instagram welcome message. Here's the copy I used:`
        : `I generated your auto-responder copy but wasn't able to push it to Meta automatically. Here's the copy I created — you can apply it manually from Meta Business Suite:`;
    const statusColor = (metaPushStatus === 'ok') ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : (metaPushStatus === 'partial') ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-gray-600 bg-gray-50 border-gray-200';
    const statusLabel = { ok: '✓ Pushed to Meta', partial: '⚠ Partially pushed', failed: '— Push failed', skipped: '— Not connected' }[metaPushStatus] ?? '';
    const undoDeadline = Date.now() + 15 * 60 * 1000;

    function scriptBlock(key, label, value) {
        const esc = v => v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        return `<div class="border border-gray-200 rounded-xl p-4 flex flex-col gap-2" id="ar-block-${key}">
            <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">${label}</p>
            <p class="text-sm text-gray-800" id="ar-text-${key}">${esc(value)}</p>
            <textarea class="hidden w-full text-sm border border-emerald-300 rounded-lg p-2 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-300" id="ar-editor-${key}" rows="3">${esc(value)}</textarea>
            <div class="flex gap-2 mt-1">
                <button onclick="_intEditScript('${key}')" id="ar-edit-btn-${key}" class="text-xs font-bold text-emerald-700 hover:text-emerald-800 cursor-pointer">Edit copy</button>
                <button onclick="_intSaveScript('${key}')" id="ar-save-btn-${key}" class="hidden text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 px-2 py-0.5 rounded cursor-pointer">Save &amp; push</button>
                <button onclick="_intCancelEdit('${key}')" id="ar-cancel-btn-${key}" class="hidden text-xs font-bold text-gray-500 hover:text-gray-700 cursor-pointer">Cancel</button>
            </div>
        </div>`;
    }

    // AC7: objection replies are review-only drafts (not pushed to Meta) — the user copies
    // them into a DM/comment when a matching sales enquiry comes in.
    function objectionBlock(responses) {
        if (!Array.isArray(responses) || !responses.length) return '';
        const esc = v => String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const rows = responses.map(r => `
            <div class="border border-gray-200 rounded-lg p-3 bg-gray-50">
                <p class="text-xs font-bold text-gray-700">“${esc(r.objection)}”</p>
                <p class="text-sm text-gray-800 mt-1">${esc(r.reply)}</p>
            </div>`).join('');
        return `<div class="border border-emerald-200 rounded-xl p-4 flex flex-col gap-2">
            <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">Sales Objection Replies — staged for your review</p>
            <p class="text-xs text-gray-500">Copy these into a DM or comment reply when a matching enquiry comes in. They are not sent automatically.</p>
            <div class="flex flex-col gap-2 mt-1">${rows}</div>
        </div>`;
    }

    panel.innerHTML = `
        <div class="flex items-start gap-3 p-5 border-b border-emerald-100">
            <div class="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0 text-emerald-700 font-bold text-sm">AI</div>
            <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold text-gray-900">${statusMsg}</p>
                ${statusLabel ? `<span class="inline-block mt-1 text-xs font-bold px-2 py-0.5 rounded-full border ${statusColor}">${statusLabel}</span>` : ''}
            </div>
        </div>
        <div class="p-5 flex flex-col gap-3">
            ${scriptBlock('messengerGreeting', 'Messenger Greeting (max 160 chars)', draft.messengerGreeting)}
            ${scriptBlock('messengerAutoReply', 'Messenger Auto-Reply', draft.messengerAutoReply)}
            ${scriptBlock('instagramDmAutoReply', 'Instagram DM Auto-Reply', draft.instagramDmAutoReply)}
            ${objectionBlock(draft.objectionResponses)}
        </div>
        <div class="px-5 pb-5 flex items-center justify-between gap-3">
            <button onclick="_intUndoAutoResponder(${undoDeadline})" id="ar-undo-btn" class="text-xs font-bold text-gray-400 hover:text-red-600 cursor-pointer transition">Undo (revert within 15 min)</button>
            <button onclick="document.getElementById('auto-responder-chat-panel').classList.add('hidden')" class="text-xs text-gray-400 hover:text-gray-600 cursor-pointer">Dismiss</button>
        </div>`;

    // Store current draft on panel for edit/save operations
    panel._arDraft = draft;
}

window._intEditScript = function (key) {
    document.getElementById(`ar-text-${key}`)?.classList.add('hidden');
    document.getElementById(`ar-editor-${key}`)?.classList.remove('hidden');
    document.getElementById(`ar-edit-btn-${key}`)?.classList.add('hidden');
    document.getElementById(`ar-save-btn-${key}`)?.classList.remove('hidden');
    document.getElementById(`ar-cancel-btn-${key}`)?.classList.remove('hidden');
};

window._intCancelEdit = function (key) {
    document.getElementById(`ar-text-${key}`)?.classList.remove('hidden');
    document.getElementById(`ar-editor-${key}`)?.classList.add('hidden');
    document.getElementById(`ar-edit-btn-${key}`)?.classList.remove('hidden');
    document.getElementById(`ar-save-btn-${key}`)?.classList.add('hidden');
    document.getElementById(`ar-cancel-btn-${key}`)?.classList.add('hidden');
};

window._intSaveScript = async function (key) {
    const panel = document.getElementById('auto-responder-chat-panel');
    const editor = document.getElementById(`ar-editor-${key}`);
    const textEl = document.getElementById(`ar-text-${key}`);
    const saveBtn = document.getElementById(`ar-save-btn-${key}`);
    if (!editor || !textEl || !panel?._arDraft) return;
    const newVal = editor.value.trim();
    if (!newVal) return;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    // Update draft and re-push only the edited script
    const updatedDraft = { ...panel._arDraft, [key]: newVal };
    try {
        const res = await fetch('/.netlify/functions/social-auto-responder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ editedDraft: updatedDraft }),
        });
        const data = await res.json();
        if (data.ok) {
            panel._arDraft = updatedDraft;
            textEl.textContent = newVal;
            window._intCancelEdit(key);
        } else {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save & push'; }
            alert(data.error ?? 'Failed to save. Please try again.');
        }
    } catch {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save & push'; }
        alert('Network error. Please try again.');
    }
};

window._intUndoAutoResponder = async function (deadline) {
    if (Date.now() > deadline) { alert('The 15-minute undo window has passed.'); return; }
    if (!confirm('This will clear your Messenger greeting and auto-reply from Meta. Continue?')) return;
    const undoBtn = document.getElementById('ar-undo-btn');
    if (undoBtn) { undoBtn.disabled = true; undoBtn.textContent = 'Reverting…'; }
    try {
        await fetch('/.netlify/functions/social-auto-responder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ undo: true }),
        });
        document.getElementById('auto-responder-chat-panel')?.classList.add('hidden');
    } catch {
        if (undoBtn) { undoBtn.disabled = false; undoBtn.textContent = 'Undo (revert within 15 min)'; }
        alert('Undo failed. Please clear the messages manually in Meta Business Suite.');
    }
};

// ── AC1: Generate profile bios ───────────────────────────────────
window._intGenerateBio = async function () {
    const panel = document.getElementById('profile-bio-chat-panel');
    if (panel) {
        panel.classList.remove('hidden');
        panel.innerHTML = `<div class="flex items-center gap-3 p-5 border-b border-emerald-100">
            <div class="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0 text-emerald-700 font-bold text-sm">AI</div>
            <p class="text-sm text-gray-500 italic">Writing your profile bios…</p>
        </div>`;
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    try {
        const res = await fetch('/.netlify/functions/generate-profile-bio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const data = await res.json();
        if (data.ok && data.draft) {
            _intRenderBioChatPanel(data.draft);
        } else if (panel) {
            panel.innerHTML = `<div class="p-5 flex items-start gap-3">
                <div class="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center shrink-0 text-red-600 font-bold text-sm">AI</div>
                <p class="text-sm text-red-700 mt-1">${data.error ?? 'Bio generation failed. Please try again.'}</p>
            </div>`;
        }
    } catch {
        if (panel) {
            panel.innerHTML = `<div class="p-5 flex items-start gap-3">
                <div class="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center shrink-0 text-red-600 font-bold text-sm">AI</div>
                <p class="text-sm text-red-700 mt-1">Bio generation failed. Please try again.</p>
            </div>`;
        }
    }
};

// Render generated bios with per-platform Edit/Save + a hint to push via Sync Profile.
function _intRenderBioChatPanel(draft) {
    const panel = document.getElementById('profile-bio-chat-panel');
    if (!panel) return;
    const limits = { instagram: 150, facebook: 255, linkedin: 700 };
    const labels = { instagram: 'Instagram Bio', facebook: 'Facebook Page About', linkedin: 'LinkedIn About' };

    function bioBlock(key, value) {
        const esc = v => String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        return `<div class="border border-gray-200 rounded-xl p-4 flex flex-col gap-2" id="bio-block-${key}">
            <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">${labels[key]} (max ${limits[key]} chars)</p>
            <p class="text-sm text-gray-800 whitespace-pre-line" id="bio-text-${key}">${esc(value)}</p>
            <textarea class="hidden w-full text-sm border border-emerald-300 rounded-lg p-2 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-300" id="bio-editor-${key}" rows="4" maxlength="${limits[key]}">${esc(value)}</textarea>
            <div class="flex gap-2 mt-1">
                <button onclick="_intEditBio('${key}')" id="bio-edit-btn-${key}" class="text-xs font-bold text-emerald-700 hover:text-emerald-800 cursor-pointer">Edit</button>
                <button onclick="_intSaveBio('${key}')" id="bio-save-btn-${key}" class="hidden text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 px-2 py-0.5 rounded cursor-pointer">Save</button>
                <button onclick="_intCancelBioEdit('${key}')" id="bio-cancel-btn-${key}" class="hidden text-xs font-bold text-gray-500 hover:text-gray-700 cursor-pointer">Cancel</button>
                <button onclick="_intCopyBio('${key}')" class="text-xs font-bold text-gray-500 hover:text-gray-700 cursor-pointer ml-auto">Copy</button>
            </div>
        </div>`;
    }

    panel.innerHTML = `
        <div class="flex items-start gap-3 p-5 border-b border-emerald-100">
            <div class="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0 text-emerald-700 font-bold text-sm">AI</div>
            <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold text-gray-900">Here are profile bios tailored to each platform. Edit any you like, then use <span class="font-bold">Sync Profile</span> to push the Facebook &amp; LinkedIn versions to your connected pages.</p>
                <p class="text-xs text-gray-500 mt-1">Instagram bios must be pasted in manually — use Copy.</p>
            </div>
        </div>
        <div class="p-5 flex flex-col gap-3">
            ${bioBlock('instagram', draft.instagram)}
            ${bioBlock('facebook', draft.facebook)}
            ${bioBlock('linkedin', draft.linkedin)}
        </div>
        <div class="px-5 pb-5 flex items-center justify-end">
            <button onclick="document.getElementById('profile-bio-chat-panel').classList.add('hidden')" class="text-xs text-gray-400 hover:text-gray-600 cursor-pointer">Dismiss</button>
        </div>`;

    panel._bioDraft = draft;
}

window._intEditBio = function (key) {
    document.getElementById(`bio-text-${key}`)?.classList.add('hidden');
    document.getElementById(`bio-editor-${key}`)?.classList.remove('hidden');
    document.getElementById(`bio-edit-btn-${key}`)?.classList.add('hidden');
    document.getElementById(`bio-save-btn-${key}`)?.classList.remove('hidden');
    document.getElementById(`bio-cancel-btn-${key}`)?.classList.remove('hidden');
};

window._intCancelBioEdit = function (key) {
    document.getElementById(`bio-text-${key}`)?.classList.remove('hidden');
    document.getElementById(`bio-editor-${key}`)?.classList.add('hidden');
    document.getElementById(`bio-edit-btn-${key}`)?.classList.remove('hidden');
    document.getElementById(`bio-save-btn-${key}`)?.classList.add('hidden');
    document.getElementById(`bio-cancel-btn-${key}`)?.classList.add('hidden');
};

window._intCopyBio = function (key) {
    const panel = document.getElementById('profile-bio-chat-panel');
    const value = panel?._bioDraft?.[key];
    if (value) navigator.clipboard?.writeText(value).catch(() => {});
};

window._intSaveBio = async function (key) {
    const panel = document.getElementById('profile-bio-chat-panel');
    const editor = document.getElementById(`bio-editor-${key}`);
    const textEl = document.getElementById(`bio-text-${key}`);
    const saveBtn = document.getElementById(`bio-save-btn-${key}`);
    if (!editor || !textEl || !panel?._bioDraft) return;
    const newVal = editor.value.trim();
    if (!newVal) return;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    const updatedDraft = { ...panel._bioDraft, [key]: newVal };
    try {
        const res = await fetch('/.netlify/functions/generate-profile-bio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ editedDraft: updatedDraft }),
        });
        const data = await res.json();
        if (data.ok) {
            panel._bioDraft = data.draft ?? updatedDraft;
            textEl.textContent = newVal;
            window._intCancelBioEdit(key);
        } else {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
            alert(data.error ?? 'Failed to save. Please try again.');
        }
    } catch {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
        alert('Network error. Please try again.');
    }
};

async function _doDisconnect() {
    if (!_connToDelete) return;
    try {
        const res = await fetch(`/.netlify/functions/integrations?id=${_connToDelete}`, { method: 'DELETE' });
        if (res.ok) {
            document.getElementById('modal-disconnect').classList.add('hidden');
            _connToDelete = null;
            await _loadConnections();
        }
    } catch {
        alert('Could not disconnect. Please try again.');
    }
}
