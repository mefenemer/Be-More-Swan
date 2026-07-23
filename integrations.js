// integrations.js — Connections page controller

// ── Platform catalogue ───────────────────────────────────────────
const PLATFORMS = [
    {
        id: 'Facebook',
        oauthPlatform: true,
        // platform= tells meta-oauth which product to connect: Facebook stores a standalone
        // 'facebook' Page connection, Instagram stores the linked IG account. Without it the
        // callback can't tell them apart and every Meta connect became an Instagram one.
        oauthUrl: '/.netlify/functions/meta-oauth?action=start&platform=facebook',
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
        // Shown BEFORE redirecting to Meta's OAuth dialog — if this setup is missing,
        // Facebook shows an error page instead of connecting, so we front-load it here.
        preConnect: {
            intro: 'You\'ll be sent to Facebook to approve the connection. Check these first:',
            steps: [
                { text: 'You need a Facebook <strong>Page</strong> for your business — a personal profile can\'t be used. Create one here if you don\'t have one yet.', url: 'https://www.facebook.com/pages/create' },
                { text: 'The Facebook account you sign in with must have <strong>Admin (full control)</strong> access to that Page — check under Page Settings → Page access.' },
                { text: 'When Facebook asks for permissions, <strong>approve everything requested</strong> — declining any permission stops us from posting for you.' },
            ],
            note: 'If any of these steps are incomplete, Facebook will show an error instead of connecting. Finish the checklist, then come back and try again.',
        },
    },
    {
        id: 'Instagram',
        oauthPlatform: true,
        oauthUrl: '/.netlify/functions/meta-oauth?action=start&platform=instagram',
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
        // Shown BEFORE redirecting to Meta's OAuth dialog. Instagram connects THROUGH
        // Facebook, so users who haven't done the Meta-side setup land on a Facebook
        // error page — this checklist catches that before they leave our site.
        preConnect: {
            intro: 'Instagram connects through Facebook, so a little Meta setup is needed first:',
            steps: [
                { text: 'Switch your Instagram to a <strong>Professional</strong> account: Instagram app → Settings → Account type and tools → <strong>Switch to Professional Account</strong> → choose Business or Creator.' },
                { text: 'You need a Facebook <strong>Page</strong> for your business. Create one here if you don\'t have one yet.', url: 'https://www.facebook.com/pages/create' },
                { text: 'Link your Instagram to that Facebook Page: Instagram → <strong>Edit Profile → Page → Connect</strong> (or from the Page: Settings → Linked Accounts → Instagram).' },
                { text: 'The Facebook account you sign in with must have <strong>Admin (full control)</strong> access to that Page.' },
                { text: 'When Facebook asks for permissions, <strong>approve everything requested</strong> — declining any permission stops us from publishing your posts.' },
            ],
            note: 'If any of these steps are incomplete, Facebook will show an error instead of connecting your account. Finish the checklist, then come back and try again.',
        },
    },
    {
        id: 'LinkedIn',
        oauthPlatform: true,
        oauthUrl: '/.netlify/functions/social-oauth-init?platform=linkedin',
        emoji: '💼',
        iconBg: 'bg-blue-700',
        iconText: 'text-white',
        label: 'LinkedIn',
        tagline: 'Share thought leadership and company updates from your own feed.',
        handleLabel: 'LinkedIn Profile URL',
        handlePlaceholder: 'https://linkedin.com/in/yourname',
        handleHelp: 'Your personal LinkedIn profile URL — posts are published to your own feed.',
        tokenLabel: 'LinkedIn Access Token',
        tokenHelp: 'An OAuth 2.0 access token from the LinkedIn Developer Portal.',
        steps: [
            { text: 'Go to LinkedIn Developer Portal', url: 'https://www.linkedin.com/developers/apps/new' },
            { text: 'Click <strong>"Create App"</strong>. Give it a name and associate it with your Company Page.' },
            { text: 'In the App, go to the <strong>"Products"</strong> tab and add <strong>Sign In with LinkedIn using OpenID Connect</strong> and <strong>Share on LinkedIn</strong>. These grant <code>openid</code>, <code>profile</code>, <code>email</code> and <code>w_member_social</code>.' },
            { text: 'Go to the <strong>"OAuth 2.0 Tools"</strong> tab and click <strong>"Create token"</strong> with those scopes.' },
            { text: 'Copy the access token and paste it below.' },
        ],
        note: 'Posts are published to your personal LinkedIn feed. Posting to a Company Page needs LinkedIn’s Community Management access, which we have not been granted yet.',
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
    {
        id: 'Threads',
        oauthPlatform: true,
        // Threads connects through the universal integrations router (/api/oauth/:provider/connect),
        // not social-oauth-init like the four platforms above — its token lives in
        // workspace_integrations. See resolveSocialCredentials for how publishing bridges the two.
        oauthUrl: '/api/oauth/threads/connect',
        emoji: '@',
        iconBg: 'bg-gray-950',
        iconText: 'text-white',
        label: 'Threads',
        tagline: 'Join the conversation with short, text-first posts on Threads.',
        handleLabel: 'Threads Username',
        handlePlaceholder: '@yourbrand',
        handleHelp: 'Your Threads username. It matches the Instagram account the profile was created from.',
        tokenLabel: 'Threads Access Token',
        tokenHelp: 'Issued automatically when you connect — no manual token needed.',
        steps: [
            { text: 'Click <strong>Connect</strong> and sign in with the Instagram account your Threads profile belongs to.' },
            { text: 'Approve the permissions Threads asks for so posts can be published on your behalf.' },
        ],
        note: 'Threads posts are limited to 500 characters — the composer will warn you before you go over.',
        // Threads profiles are created from an Instagram account, so the common failure is a user
        // trying to connect with a Facebook/Threads-less login and landing on a Meta error page.
        preConnect: {
            intro: 'You\'ll be sent to Meta to approve the connection. Check these first:',
            steps: [
                { text: 'You need an existing <strong>Threads profile</strong>. Create one from the Instagram app or at threads.net if you don\'t have one yet.', url: 'https://www.threads.net/' },
                { text: 'Sign in with the <strong>Instagram account that owns the Threads profile</strong> — not a Facebook Page login.' },
                { text: 'When Meta asks for permissions, <strong>approve everything requested</strong> — declining any permission stops us from publishing your posts.' },
            ],
            note: 'If any of these steps are incomplete, Meta will show an error instead of connecting. Finish the checklist, then come back and try again.',
        },
    },
    {
        id: 'YouTube',
        oauthPlatform: true,
        // Like Threads, YouTube's token lives in workspace_integrations via the universal router.
        oauthUrl: '/api/oauth/youtube/connect',
        emoji: '▶',
        iconBg: 'bg-red-600',
        iconText: 'text-white',
        label: 'YouTube',
        tagline: 'Upload videos and Shorts to your channel.',
        handleLabel: 'YouTube Channel URL',
        handlePlaceholder: 'https://youtube.com/@yourchannel',
        handleHelp: 'The URL of the channel you want this assistant to upload to.',
        tokenLabel: 'YouTube Access Token',
        tokenHelp: 'Issued automatically when you connect — no manual token needed.',
        steps: [
            { text: 'Click <strong>Connect</strong> and sign in with the Google account that owns the channel.' },
            { text: 'Approve the upload permission so videos can be published on your behalf.' },
        ],
        // Set expectations up front: YouTube is the one platform the assistant cannot draft for,
        // because every drafter produces still images rather than video.
        note: 'YouTube posts need a video file — attach one in the composer. Your assistant will not draft YouTube posts on its own.',
        preConnect: {
            intro: 'You\'ll be sent to Google to approve the connection. Check these first:',
            steps: [
                { text: 'Sign in with the Google account that <strong>owns the channel</strong> — an account with only viewing access cannot upload.' },
                { text: 'Your channel must be <strong>verified</strong> to upload videos longer than 15 minutes.', url: 'https://www.youtube.com/verify' },
                { text: 'When Google asks for permission to <strong>manage your YouTube videos</strong>, approve it — declining stops us from uploading.' },
            ],
            note: 'Google may warn that the app is not verified while our review is pending. Choose "Advanced" → "Go to Be More Swan" to continue.',
        },
    },
];

// ── Inbound source catalogue ─────────────────────────────────────
// Sources are connectors assistants read FROM, never write to — the opposite direction to
// PLATFORMS above. They differ in three ways that _sourceCard() encodes: no social handle is
// required to connect (the handle gate is a publishing concern), there is no "Use for this
// assistant" toggle (connecting is workspace-wide — an inbound library isn't per-assistant
// state), and the CTA leads to browsing rather than publishing.
//
// serviceName here must match the CONNECTOR_CATEGORY key in src/utils/connection-map.ts
// (lowercased), which is what the server returns in `allowedServices`.
const SOURCES = [
    {
        id: 'canva',
        label: 'Canva',
        emoji: '🎨',
        // bg-teal-100 is in the compiled style.css; bg-cyan-100 is NOT, and an uncompiled
        // Tailwind class renders as no background at all.
        iconBg: 'bg-teal-100',
        iconText: 'text-teal-700',
        oauthUrl: '/api/oauth/canva/connect',
        tagline: 'Bring your Canva designs into your Content Library, so this assistant can use them in posts and articles.',
        headline: 'Import designs from Canva',
    },
];

// When this grid is rendered inside the Assistant Profile slide-over (assistant-detail.html),
// every connector popup opens on top of a drawer that is still covering the right half of the
// screen — and the modals are z-50 against the drawer's z-9001, so they render behind it.
// Close the drawer first: the popup becomes the one thing on screen, and the drawer's own
// close path flushes any pending profile save. No-op on the standalone Connections page.
function _closeDrawerForModal() {
    if (!document.body.classList.contains('brief-drawer-open')) return;
    window._closeBriefDrawer?.();
}

// Sources connect straight through the OAuth router — no pre-connect checklist and no handle
// gate, so unlike _intStartOAuth there is nothing to interstitial.
window._intConnectSource = function (sourceId) {
    const source = SOURCES.find(s => s.id === sourceId);
    if (source) window.location.href = source.oauthUrl;
};

// Canva is the only source with a picker, so this is deliberately Canva-specific rather than
// dispatching on sourceId — a second source would need its own browser anyway.
// Imports land in My Content, not on this tab, so there is nothing here to re-render: confirm
// what arrived and name where it went, otherwise the modal just closes and looks like a no-op.
// CanvaBrowser is loaded by workspace.html, which hosts this tab as a fragment.
window._intBrowseCanvaDesigns = function () {
    if (!window.CanvaBrowser) return;
    _closeDrawerForModal();
    window.CanvaBrowser.open({
        // Count items, not designs: the importer writes one asset per PAGE, so a 2-page
        // presentation lands as 2 items and "2 designs" would contradict what the user picked.
        onImported: (assetIds) => {
            const n = assetIds.length;
            window.showToast?.(`${n} item${n > 1 ? 's' : ''} imported to My Content.`, { icon: '✅' });
        },
    });
};

let _connToDelete = null;
let _userConnections = [];
// Monthly X posting usage { used, allowance, remaining } (Phase 1) — drives the X-card gauge.
let _xCredits = null;

// A slim usage gauge for the X card: "X posts this month — used / allowance", bar turns amber near
// the cap and red when spent. Only rendered for the X platform when the org has an allowance.
function _xUsageGauge(platform) {
    if (platform.id !== 'X' || !_xCredits || _xCredits.allowance <= 0) return '';
    const used = Math.max(0, _xCredits.used);
    const allowance = _xCredits.allowance;
    const pct = Math.min(100, Math.round((used / allowance) * 100));
    const spent = used >= allowance;
    const near = !spent && pct >= 80;
    const barColor = spent ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-emerald-600';
    const textColor = spent ? 'text-red-700' : near ? 'text-amber-700' : 'text-gray-500';
    const note = spent
        ? 'Monthly limit reached — new X posts pause until next month.'
        : `${_xCredits.remaining} left this month (links cost 13×).`;
    return `
        <div class="mt-1">
            <div class="flex items-center justify-between text-[11px] font-semibold ${textColor} mb-1">
                <span>X posts this month</span><span>${used} / ${allowance}</span>
            </div>
            <div class="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden"><div class="h-full ${barColor} rounded-full" style="width:${pct}%"></div></div>
            <p class="text-[11px] ${textColor} mt-1">${_esc(note)}</p>
        </div>`;
}

// ── Per-assistant relevance ──────────────────────────────────────
// The relevance policy is owned and ENFORCED server-side (src/utils/connection-map.ts).
// The page passes the selected assistantId to the integrations GET and renders only the
// connectors the server returns in `allowedServices` — no policy is duplicated here.
const _esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let _assistants = [];
let _selectedAssistantId = null;
let _allowedServices = null; // null = no assistant scope → show all
// Supported external tools for the scoped assistant (from the server's connection-map).
// Includes categories with no live connector yet (available:false → "coming soon").
let _supportedTools = [];
// Read by the assistant detail page to fold supported tools into "Your Onboarding Answers".
window._intGetSupportedTools = () => _supportedTools;
// Display names of connectors the workspace has actively connected (for the summary).
window._intGetConnectedServices = () =>
    _userConnections.filter(c => c.status === 'active').map(c => c.serviceName);

// Per-assistant "Use for this assistant" toggle state (set when rendered inside the
// assistant detail Connections tab via initAssistantConnections). Connections are a
// shared org pool; this set is which connection IDs THIS assistant actually uses.
let _assistantScoped = false;
let _assistantSelectedIds = new Set();

// Blog syndication destinations (Ghost, WordPress, Dev.to, Hashnode, WordPress.com) — the `cms`
// category. These are NOT OAuth connectors: they live in their own subsystem (connect-blog-destination
// + src/utils/blog-destinations) and are connected by a paste form (or OAuth for WordPress.com), so
// they get their own loader/cards/handlers rather than riding the _userConnections path above.
let _blogDestinations = [];
// The `cms` category is live for this assistant (blog writer) — the server marks it available.
function _cmsIsLive() {
    return _supportedTools.some(t => t && t.key === 'cms' && t.available === true);
}
// serviceName slug → short platform key stored in context.primary_platforms
const PLATFORM_KEY_MAP = { facebook: 'fb', instagram: 'ig', linkedin: 'li', x: 'x', twitter: 'x', tiktok: 'tt', youtube: 'yt', threads: 'th', pinterest: 'pin' };

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

function _relevantSources() {
    if (!_allowedServices) return SOURCES;
    const allow = new Set(_allowedServices.map(s => String(s).toLowerCase()));
    return SOURCES.filter(s => allow.has(String(s.id).toLowerCase()));
}

// Append the selected assistant so the OAuth flow binds the connection to it (and the server
// can enforce relevance). The separator is computed rather than assumed: the older platforms
// route through social-oauth-init/meta-oauth and already carry a query string, but the
// /api/oauth/:provider/connect routes (Threads, and any future workspace-integration platform)
// do not — a hardcoded '&' produced '…/connect&assistantId=3', which the rewrite never matches.
function _oauthUrl(platform) {
    if (!_selectedAssistantId) return platform.oauthUrl;
    const sep = platform.oauthUrl.includes('?') ? '&' : '?';
    return `${platform.oauthUrl}${sep}assistantId=${encodeURIComponent(_selectedAssistantId)}`;
}

// Instagram Business accounts authenticate via Meta's Facebook Login (there is no
// separate Instagram-only OAuth dialog), so "Connect with Instagram" lands on a
// facebook.com screen asking the user to log into Facebook and pick the linked Page.
// Without warning, that reads as a bug ("I clicked Instagram and it opened Facebook").
// Surface the existing platform note first so the redirect is expected, not surprising.
window._intStartOAuth = function (platformId) {
    const platform = PLATFORMS.find(p => p.id === platformId);
    if (!platform) return;
    // Platforms with a preConnect checklist (Meta) go via the setup modal first —
    // skipping it lands unprepared users on a raw Facebook error page. The Instagram
    // checklist also covers the "connects through Facebook" warning below.
    if (platform.preConnect) { window._intOpenPreConnect(platformId); return; }
    if (platform.id === 'Instagram' && typeof window.showConfirmModal === 'function') {
        _closeDrawerForModal();
        window.showConfirmModal(
            `Instagram connects through Meta's Facebook Login — you'll be asked to log into Facebook and choose the Facebook Page linked to your Instagram account. ${platform.note}`,
            () => { window.location.href = _oauthUrl(platform); },
            { title: 'Connecting Instagram', confirmLabel: 'Continue to Facebook', cancelLabel: 'Cancel', confirmColor: '#059669' }
        );
        return;
    }
    window.location.href = _oauthUrl(platform);
};

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

// The same save feedback drives the Connections drawer header and the Overview status card,
// either of which may be the one the user is looking at when they flip a switch.
const _SAVE_STATUS_IDS = ['platforms-save-status', 'connections-save-status'];
function _setPlatformSaveStatus(text) {
    _SAVE_STATUS_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    });
}

// Persist the per-assistant "Use for this assistant" toggle. Mirrors the old
// _renderPlatformsTab save: recompute primary_platforms slugs + linked_integrations
// + appliedDefaults.platforms, then PUT update-assistant-context.
window._intToggleUseForAssistant = async function (connId, checked) {
    connId = Number(connId);
    if (checked) _assistantSelectedIds.add(connId); else _assistantSelectedIds.delete(connId);
    // Repaint the Overview card off the new state so its pill/headline track the switch the
    // user just flipped, wherever they flipped it. The drawer grid re-renders on next open.
    window._renderConnectionsStatusCard();
    const checkedIds = Array.from(_assistantSelectedIds);
    const activeConns = _userConnections.filter(c => c.status === 'active' && c.userId);
    const checkedKeys = activeConns
        .filter(c => checkedIds.includes(c.id))
        .map(c => PLATFORM_KEY_MAP[c.serviceName.toLowerCase()] || c.serviceName.toLowerCase());

    _setPlatformSaveStatus('Saving…');
    try {
        const updatedContext = { ...(window.cachedContext || {}), primary_platforms: checkedKeys, linked_integrations: checkedIds };
        const r = await fetch('/.netlify/functions/update-assistant-context', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistantId: parseInt(_selectedAssistantId), newContext: updatedContext, appliedDefaults: { platforms: checkedIds } }),
        });
        if (r.ok) {
            window.cachedContext = updatedContext;
            _setPlatformSaveStatus('✓ Saved');
            setTimeout(() => {
                const el = document.getElementById('platforms-save-status');
                if (el && el.textContent === '✓ Saved') _setPlatformSaveStatus('');
            }, 2500);
        } else {
            _setPlatformSaveStatus('Error saving');
        }
    } catch {
        _setPlatformSaveStatus('Error saving');
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
        // Supported external tools for this assistant's role, incl. "coming soon" ones.
        _supportedTools = Array.isArray(data.supportedTools) ? data.supportedTools : [];
        // Monthly X posting usage { used, allowance, remaining } for the X-card gauge (Phase 1).
        _xCredits = (data.xCredits && typeof data.xCredits.allowance === 'number') ? data.xCredits : null;
    } catch (e) {
        console.warn('Could not load connections:', e);
    }

    // Blog destinations (cms category) — a separate subsystem, loaded only when it's live for
    // this assistant so the OAuth-only pages never call it.
    await _loadBlogDestinations();

    // Overview status card first — it lives outside this grid and must render on every path,
    // including the "nothing relevant to connect" empty state below.
    window._renderConnectionsStatusCard();

    grid.innerHTML = '';
    const platforms = _relevantPlatforms();
    // Inbound sources (Canva). Their category is marked available:true by the server's
    // connection-map, which is what keeps them out of the coming-soon list below — so this
    // renderer is the ONLY thing standing between a tagged source connector and a silently
    // empty grid.
    const sources = _relevantSources();
    // Categories the role supports that have no live connector yet — rendered as
    // "coming soon" cards so every assistant shows the tools it's built to use.
    // Exclude any category already covered by an enable-able "Synced actions" recipe
    // (published by assistant-integrations.js) so a capability never appears as both an
    // enable-able recipe and a "coming soon" card.
    const covered = window._syncedActionCategories || new Set();
    const comingSoon = _supportedTools.filter(t => t && t.available === false && !covered.has(t.key));

    if (!platforms.length && !sources.length && !comingSoon.length && !_blogDestinations.length) {
        // Nothing to connect and nothing "coming soon" here — but the assistant may still
        // have enable-able recipes rendered by the Synced actions list above, so only show
        // the empty state when there are no recipes either.
        grid.innerHTML = covered.size ? '' : '<div class="col-span-full bg-white border border-gray-200 rounded-2xl p-10 text-center text-sm text-gray-500">No connectors are relevant to this assistant yet. As we add more integrations (CRM, calendar, reviews), the right ones will appear here.</div>';
        return;
    }
    platforms.forEach(platform => {
        const conn = _userConnections.find(c => _serviceMatchesPlatform(c.serviceName, platform.id));
        grid.insertAdjacentHTML('beforeend', _platformCard(platform, conn));
    });
    sources.forEach(source => {
        const conn = _userConnections.find(c => String(c.serviceName).toLowerCase() === source.id);
        grid.insertAdjacentHTML('beforeend', _sourceCard(source, conn));
    });
    _blogDestinations.forEach(dest => grid.insertAdjacentHTML('beforeend', _blogDestCard(dest)));
    comingSoon.forEach(tool => grid.insertAdjacentHTML('beforeend', _comingSoonCard(tool)));

    _queueConnectPermissionPrompts(platforms);
}

// Card for a supported tool category that has no live connector yet. Mirrors the
// _platformCard shell (same grid cell size/rounding) but is non-interactive and
// badged "Coming soon" — it advertises what the assistant is built to use.
function _comingSoonCard(tool) {
    return `
      <div class="bg-white border border-gray-200 border-dashed rounded-2xl p-5 flex flex-col gap-3 opacity-90">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-gray-100 text-gray-400 flex items-center justify-center text-lg shrink-0">🔌</div>
          <div class="min-w-0">
            <p class="text-sm font-bold text-gray-900">${_esc(tool.label)}</p>
            <span class="inline-flex items-center gap-1.5 text-xs font-bold text-gray-500 mt-0.5"><span class="w-1.5 h-1.5 rounded-full bg-gray-400"></span> Coming soon</span>
          </div>
        </div>
        <p class="text-xs text-gray-500">${_esc(tool.description || '')}</p>
        <button type="button" disabled class="mt-auto w-full text-sm font-bold text-gray-400 bg-gray-50 border border-gray-200 rounded-xl py-2.5 cursor-not-allowed">Not yet available</button>
      </div>`;
}

// ── Blog destinations (cms category) ─────────────────────────────
// Load the org's blog-connector status (Ghost/WordPress/Dev.to/Hashnode/WordPress.com) only when
// the category is live for this assistant. Populates _blogDestinations for the grid + status card.
async function _loadBlogDestinations() {
    _blogDestinations = [];
    if (!_cmsIsLive()) return;
    try {
        const res = await fetch('/.netlify/functions/connect-blog-destination');
        if (!res.ok) return;
        const data = await res.json();
        _blogDestinations = Array.isArray(data.destinations) ? data.destinations : [];
    } catch (e) {
        console.warn('Could not load blog destinations:', e);
    }
}

// A connector card for one blog destination. Connect is a paste form (Ghost/WordPress/Dev.to/
// Hashnode) or an OAuth redirect (WordPress.com). Once connected it shows the account, a
// draft/live control (how auto-syndication publishes on this blog), and Disconnect. Blog
// connections are org-wide (shared across assistants), like inbound sources.
function _blogDestCard(d) {
    const connected = !!d.connected;
    const primaryBtn = 'w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-xl shadow-sm hover:shadow transition cursor-pointer';
    const ghostPill = 'inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg border transition cursor-pointer';
    const disconnectBtn = `<button onclick="window._blogDestDisconnect('${d.id}')" class="${ghostPill} text-red-600 bg-white hover:bg-red-600 hover:text-white border-red-200 hover:border-red-600" type="button">Disconnect</button>`;

    // Connect control: OAuth destinations redirect; paste destinations reveal an inline form.
    const connectBtn = d.oauth
        ? `<button onclick="window.location.href='${_esc(d.connectUrl || '#')}'" class="${primaryBtn}" type="button">Connect ${_esc(d.label)}</button>`
        : `<button onclick="window._blogDestToggleForm('${d.id}')" class="${primaryBtn}" type="button">Connect ${_esc(d.label)}</button>`;

    const account = d.accountLabel
        ? `<div class="flex items-center gap-1.5 w-fit max-w-full text-xs font-semibold text-gray-600 bg-gray-50 border border-gray-100 rounded-lg px-2.5 py-1.5 mt-2"><span class="truncate">Connected as ${_esc(d.accountLabel)}</span></div>`
        : '';

    // Draft/live control — how auto-syndication publishes here on publish. Hashnode is live-only.
    const modeControl = d.supportsDraft
        ? `<label class="flex items-center justify-between gap-2 mt-2 text-xs font-semibold text-gray-600">
               <span>On publish, push as</span>
               <select onchange="window._blogDestSetMode('${d.id}', this.value)" class="text-xs font-bold border border-gray-200 rounded-lg px-2 py-1 bg-white cursor-pointer">
                   <option value="draft"${d.publishMode !== 'live' ? ' selected' : ''}>Draft</option>
                   <option value="live"${d.publishMode === 'live' ? ' selected' : ''}>Live</option>
               </select>
           </label>`
        : `<p class="mt-2 text-xs font-semibold text-gray-400">On publish, pushed live (no draft API)</p>`;

    const capPill = connected
        ? `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">✓ Connected</span>`
        : `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">Not connected</span>`;

    const body = connected
        ? `${account}${modeControl}
           <details class="mt-1"><summary class="text-xs font-semibold text-gray-500 cursor-pointer hover:text-gray-700 select-none">Manage connection</summary>
               <div class="mt-2 pt-3 border-t border-gray-100 flex items-center gap-2 flex-wrap">${disconnectBtn}</div>
           </details>`
        : `<div class="mt-auto pt-4 border-t border-gray-100">${connectBtn}</div>
           <div id="blogdest-form-${d.id}" class="hidden mt-3"></div>`;

    return `
      <div class="bg-white border border-gray-200 rounded-2xl p-5 flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-3 min-w-0">
            <span class="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center text-lg shrink-0">✍️</span>
            <p class="text-sm font-bold text-gray-900 truncate">${_esc(d.label)}</p>
          </div>
          ${capPill}
        </div>
        <p class="text-xs text-gray-500">Publish your posts to ${_esc(d.label)} automatically. Blog connections are shared across your workspace.</p>
        ${body}
      </div>`;
}

// Reveal / hide the inline paste form for a blog destination, built from its credFields.
window._blogDestToggleForm = function (id) {
    const host = document.getElementById(`blogdest-form-${id}`);
    if (!host) return;
    if (!host.classList.contains('hidden')) { host.classList.add('hidden'); host.innerHTML = ''; return; }
    const d = _blogDestinations.find(x => x.id === id);
    if (!d) return;
    const fields = (d.credFields || []).map(f => `
        <label class="block mb-2">
            <span class="text-xs font-semibold text-gray-600">${_esc(f.label)}</span>
            <input data-key="${_esc(f.key)}" type="${f.secret ? 'password' : 'text'}" placeholder="${_esc(f.help || '')}"
                class="mt-1 w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-emerald-300">
        </label>`).join('');
    host.innerHTML = `
        ${fields}
        <div id="blogdest-err-${id}" class="hidden text-xs font-semibold text-red-600 mb-2"></div>
        <button onclick="window._blogDestConnect('${id}')" type="button"
            class="w-full px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition cursor-pointer">Connect</button>`;
    host.classList.remove('hidden');
};

// Validate + store a paste-destination's credentials, then refresh the grid.
window._blogDestConnect = async function (id) {
    const host = document.getElementById(`blogdest-form-${id}`);
    const errEl = document.getElementById(`blogdest-err-${id}`);
    if (!host) return;
    const creds = {};
    host.querySelectorAll('input[data-key]').forEach(inp => { creds[inp.getAttribute('data-key')] = inp.value.trim(); });
    if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
    try {
        const res = await fetch('/.netlify/functions/connect-blog-destination', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'connect', provider: id, creds }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (errEl) { errEl.textContent = data.error || 'Could not connect — check your details.'; errEl.classList.remove('hidden'); }
            return;
        }
        await _loadConnections();
    } catch {
        if (errEl) { errEl.textContent = 'Could not reach the server. Try again.'; errEl.classList.remove('hidden'); }
    }
};

// Disconnect a blog destination (org-wide), then refresh the grid.
window._blogDestDisconnect = async function (id) {
    const d = _blogDestinations.find(x => x.id === id);
    if (!window.confirm(`Disconnect ${d ? d.label : 'this blog'}? Your posts will stop syndicating there.`)) return;
    try {
        await fetch('/.netlify/functions/connect-blog-destination', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'disconnect', provider: id }),
        });
    } catch { /* best-effort; refresh reflects true state */ }
    await _loadConnections();
};

// Set how a destination receives auto-syndicated posts (draft vs live).
window._blogDestSetMode = async function (id, mode) {
    try {
        await fetch('/.netlify/functions/connect-blog-destination', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'setmode', provider: id, publishMode: mode }),
        });
        const d = _blogDestinations.find(x => x.id === id);
        if (d) d.publishMode = mode;
    } catch { /* best-effort; selection stays as chosen */ }
};

// ── US-97: Proactively ask permission to connect platforms the user already ──
// gave a handle for on Business Information, one at a time, "in turn". Only
// BMS-supported platforms (PLATFORMS, further narrowed by _relevantPlatforms)
// are ever prompted for. Each platform is asked at most once per browser
// session so revisiting this tab doesn't re-nag after a "Not now".
function _connectPromptKey(platform) {
    return `bms-connect-asked:${_selectedAssistantId || 'org'}:${platform.id.toLowerCase()}`;
}

function _queueConnectPermissionPrompts(platforms) {
    const queue = platforms.filter(platform => {
        if (!_handleFor(platform)) return false;
        const conn = _userConnections.find(c => _serviceMatchesPlatform(c.serviceName, platform.id));
        if (conn && conn.status === 'active') return false;
        try { if (sessionStorage.getItem(_connectPromptKey(platform))) return false; } catch { /* ignore */ }
        return true;
    });
    if (!queue.length || typeof window.showConfirmModal !== 'function') return;

    const askNext = () => {
        const platform = queue.shift();
        if (!platform) return;
        try { sessionStorage.setItem(_connectPromptKey(platform), '1'); } catch { /* ignore */ }
        window.showConfirmModal(
            `You added a ${platform.label} handle in Business Information. Be More Swan needs your permission to connect to ${platform.label} so it can post on your behalf. Connect now?`,
            async () => {
                if (platform.oauthPlatform) window._intStartOAuth(platform.id);
                else window._intOpenModal(platform.id);
            },
            {
                title: `Connect ${platform.label}?`,
                confirmLabel: `Connect ${platform.label}`,
                cancelLabel: 'Not now',
                confirmColor: '#059669',
                onCancel: askNext,
            }
        );
    };
    askNext();
}

// ── Overview ▸ Connections status card ───────────────────────────
// Sits beside the Autopilot card and answers two questions at a glance: is each channel
// connected and healthy, and is THIS assistant switched on for it. The switch writes the
// same per-assistant state as "Use for this assistant" in the Connections drawer
// (_intToggleUseForAssistant → primary_platforms + linked_integrations). Connecting,
// reconnecting and disconnecting stay in the drawer, where the handle gate and the
// troubleshooting flow live — a row that isn't connected links there instead of
// re-implementing that gate.
function _connSwitch(conn, label, on) {
    return `
        <label class="relative shrink-0 cursor-pointer">
            <input type="checkbox" class="sr-only peer" ${on ? 'checked' : ''}
                aria-label="Use ${_esc(label)} for this assistant"
                onchange="window._intToggleUseForAssistant(${conn.id}, this.checked)">
            <span class="block w-11 h-6 bg-gray-200 rounded-full peer-checked:bg-emerald-700 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-200 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:shadow-sm after:transition-all peer-checked:after:translate-x-full peer-checked:after:border-white"></span>
        </label>`;
}

function _connStatusRow(platform, conn) {
    const health = _connHealth(conn);
    const isActive = !!conn && conn.status === 'active';
    const on = isActive && _assistantSelectedIds.has(conn.id);
    // Subtext carries the health when it needs attention, otherwise whether this
    // assistant is switched on — the toggle beside it already shows on/off state.
    const sub = !conn ? 'Connect it to publish here'
        : health.problem ? health.label
        : on ? 'Publishing enabled' : 'Connected, not in use';
    const subTone = !conn ? 'text-gray-400' : health.problem ? 'text-amber-700' : on ? 'text-emerald-700' : 'text-gray-400';
    const control = isActive
        ? _connSwitch(conn, platform.label, on)
        : `<button type="button" onclick="window._openBriefDrawer && window._openBriefDrawer('platforms')" class="shrink-0 px-2.5 py-1 text-xs font-bold rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 transition cursor-pointer">${conn ? 'Reconnect' : 'Connect'}</button>`;
    return `
        <div class="flex items-center justify-between gap-3 py-2">
            <div class="flex items-center gap-2.5 min-w-0">
                <span class="w-8 h-8 rounded-lg ${platform.iconBg} ${platform.iconText} flex items-center justify-center text-base shrink-0">${platform.emoji}</span>
                <div class="min-w-0">
                    <p class="text-sm font-bold text-gray-900 truncate">${_esc(platform.label)}</p>
                    <p class="text-xs font-semibold ${subTone} truncate">${_esc(sub)}</p>
                </div>
            </div>
            ${control}
        </div>`;
}

// Status row for an inbound source (SOURCES). Same shell as _connStatusRow, minus the
// switch: connecting a source is workspace-wide, so there is no per-assistant on/off to
// show. A connected source is simply available to the assistant.
function _sourceStatusRow(source, conn) {
    const health = _connHealth(conn);
    const isActive = !!conn && conn.status === 'active';
    const sub = !conn ? 'Connect it to import designs'
        : health.problem ? health.label
        : 'Designs available';
    const subTone = !conn ? 'text-gray-400' : health.problem ? 'text-amber-700' : 'text-emerald-700';
    const control = isActive
        ? ''
        : `<button type="button" onclick="window._openBriefDrawer && window._openBriefDrawer('platforms')" class="shrink-0 px-2.5 py-1 text-xs font-bold rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 transition cursor-pointer">${conn ? 'Reconnect' : 'Connect'}</button>`;
    return `
        <div class="flex items-center justify-between gap-3 py-2">
            <div class="flex items-center gap-2.5 min-w-0">
                <span class="w-8 h-8 rounded-lg ${source.iconBg} ${source.iconText} flex items-center justify-center text-base shrink-0">${source.emoji}</span>
                <div class="min-w-0">
                    <p class="text-sm font-bold text-gray-900 truncate">${_esc(source.label)}</p>
                    <p class="text-xs font-semibold ${subTone} truncate">${_esc(sub)}</p>
                </div>
            </div>
            ${control}
        </div>`;
}

// Rendered from whatever _loadConnections last fetched, so it never issues its own request.
// Self-hides for roles with no connectors at all (their integrations are recipes in the
// Connections drawer's "Synced actions" list, which carry their own enable toggles).
window._renderConnectionsStatusCard = function () {
    const card = document.getElementById('connections-status-card');
    if (!card) return;
    const platforms = _assistantScoped ? _relevantPlatforms() : [];
    const sources = _assistantScoped ? _relevantSources() : [];
    // Blog destinations (cms) are org-wide like sources — a connected one is "on" with no switch.
    const blogDests = _assistantScoped ? _blogDestinations : [];
    const nothingRelevant = !platforms.length && !sources.length && !blogDests.length;
    // A social media assistant always keeps its Connections card — even before anything is
    // connected the user needs a permanent place to add a channel, so it shows an empty state
    // rather than vanishing. Other roles (whose "connectors" are Synced-action recipes living
    // in the drawer) still hide the card when they have none.
    const keepForSocial = window._detailCurrentData?.roleKey === 'social_media_manager';
    if (nothingRelevant && !keepForSocial) {
        card.classList.add('hidden');
        window._syncStatusRow && window._syncStatusRow();
        return;
    }
    card.classList.remove('hidden');

    const rows = platforms.map(p => ({ p, conn: _userConnections.find(c => _serviceMatchesPlatform(c.serviceName, p.id)) }));
    const connected = rows.filter(r => r.conn && r.conn.status === 'active');
    const enabled = connected.filter(r => _assistantSelectedIds.has(r.conn.id));
    const sourceRows = sources.map(s => ({ s, conn: _userConnections.find(c => String(c.serviceName).toLowerCase() === s.id) }));
    const activeSources = sourceRows.filter(r => r.conn && r.conn.status === 'active');
    const connectedBlogs = blogDests.filter(d => d.connected);

    const pill = document.getElementById('connections-pill');
    if (pill) {
        // A connected source/blog has no switch, so it counts as on the moment it is connected.
        const onCount = enabled.length + activeSources.length + connectedBlogs.length;
        const connectedCount = connected.length + activeSources.length + connectedBlogs.length;
        pill.textContent = connectedCount ? `${onCount} of ${connectedCount} on` : '● None connected';
        pill.className = 'inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ' +
            (onCount ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500');
    }
    const headline = document.getElementById('connections-headline');
    if (headline) {
        const parts = [];
        if (enabled.length) parts.push(`Posting to ${_listPhrase(enabled.map(r => r.p.label))}`);
        if (activeSources.length) parts.push(`Designs from ${_listPhrase(activeSources.map(r => r.s.label))}`);
        if (connectedBlogs.length) parts.push(`Publishing to ${_listPhrase(connectedBlogs.map(d => d.label))}`);
        const anyConnected = connected.length || activeSources.length || connectedBlogs.length;
        headline.textContent = !anyConnected
            ? ((sources.length || blogDests.length) ? 'Nothing connected yet' : 'No channels connected yet')
            : parts.length
            ? parts.join(' · ')
            : 'Connected — but no channel is switched on for this assistant';
    }
    // The per-connection list + toggles were removed from this summary card — they were slow to
    // render here and rarely acted on. The card now shows only the "N of M on" pill and the
    // "Posting to …" headline; the full connect / manage / per-assistant switch UI lives behind the
    // "Manage connections" button (the Connections tab). rows/enabled above still drive the summary.
    window._syncStatusRow && window._syncStatusRow();
};

// Status row for a blog destination in the Overview card. Same shell as _sourceStatusRow, no switch
// (org-wide): a connected blog is simply on. Connect opens the Connections tab where the card lives.
function _blogDestStatusRow(d) {
    const connected = !!d.connected;
    const sub = !connected ? 'Connect it to publish here'
        : d.publishMode === 'live' ? 'Auto-publishing live' : 'Auto-publishing as draft';
    const subTone = connected ? 'text-emerald-700' : 'text-gray-400';
    const control = connected
        ? ''
        : `<button type="button" onclick="window._openBriefDrawer && window._openBriefDrawer('platforms')" class="shrink-0 px-2.5 py-1 text-xs font-bold rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 transition cursor-pointer">Connect</button>`;
    return `
        <div class="flex items-center justify-between gap-3 py-2">
            <div class="flex items-center gap-2.5 min-w-0">
                <span class="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center text-base shrink-0">✍️</span>
                <div class="min-w-0">
                    <p class="text-sm font-bold text-gray-900 truncate">${_esc(d.label)}</p>
                    <p class="text-xs font-semibold ${subTone} truncate">${_esc(sub)}</p>
                </div>
            </div>
            ${control}
        </div>`;
}

// "Facebook", "Facebook and X", "Facebook, X and LinkedIn"
function _listPhrase(items) {
    if (items.length <= 1) return items[0] || '';
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

// US-GAP-10.1.1 SC4: token health of a stored connection — Connected / Expiring soon /
// Disconnected / Needs attention. Shared by the platform card badge and the Overview
// Connections card, so the two can never disagree about a connection's state.
// `problem`: the connection exists but needs the user's attention.
function _connHealth(conn) {
    if (!conn) return { key: 'none', label: 'Not connected', problem: false };
    if (conn.status === 'expired' || conn.status === 'failed' || conn.status === 'revoked' || conn.status === 'token_refresh_failed') {
        return { key: 'bad', label: 'Disconnected', problem: true };
    }
    // Connections that carry an offline refresh token are renewed silently (the
    // refresh-social-tokens cron for X/LinkedIn, getFreshAccessToken at action time for the
    // rest), so their short-lived access-token expiry shouldn't alarm the user. The server
    // flags these via `autoRefresh`; otherwise a 1-hour Google token (YouTube, Gmail, Search
    // Console) would forever render as "Expiring in 1d" the moment it's connected.
    // (Legacy `offline.access` scope kept as a fallback for rows predating the flag.)
    if (conn.autoRefresh || (typeof conn.scopes === 'string' && conn.scopes.includes('offline.access'))) {
        return { key: 'ok', label: 'Connected', problem: false };
    }
    if (conn.tokenExpiresAt) {
        const daysLeft = Math.ceil((new Date(conn.tokenExpiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        if (daysLeft <= 0) return { key: 'bad', label: 'Disconnected', problem: true };
        if (daysLeft <= 7) return { key: 'warn', label: `Expiring in ${daysLeft}d`, problem: true };
        return { key: 'ok', label: 'Connected', problem: false };
    }
    return conn.status === 'active'
        ? { key: 'ok', label: 'Connected', problem: false }
        : { key: 'warn', label: 'Needs attention', problem: true };
}

// Healthy, connected platforms show a pink "Connected" pill. (Pink Tailwind bg
// utilities aren't in the prebuilt CSS, so the fills are set inline.)
function _healthBadge(health) {
    const pill = 'inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full border';
    const dot = 'w-1.5 h-1.5 rounded-full';
    if (health.key === 'ok')   return `<span class="${pill} text-pink-700 border-pink-200" style="background-color:#fce7f3"><span class="${dot}" style="background-color:#ec4899"></span> ${health.label}</span>`;
    if (health.key === 'bad')  return `<span class="${pill} text-red-700 bg-red-50 border-red-200"><span class="${dot} bg-red-500"></span> ${health.label}</span>`;
    if (health.key === 'warn') return `<span class="${pill} text-amber-700 bg-amber-50 border-amber-200"><span class="${dot} bg-amber-500 animate-pulse"></span> ${health.label}</span>`;
    return `<span class="${pill} text-gray-500 bg-gray-100 border-gray-200"><span class="${dot} bg-gray-400"></span> ${health.label}</span>`;
}

// Card for an inbound source (SOURCES). Mirrors _platformCard's shell — same grid cell size,
// rounding and pill language — but drops the two things that only make sense for an outbound
// publishing target: the Business-Information handle gate and the "Use for this assistant"
// toggle. The direction marker reads "in" rather than "out".
function _sourceCard(source, conn) {
    const isConnected = !!conn;
    const isActive = isConnected && conn.status === 'active';
    const health = _connHealth(conn);
    const account = conn?.externalAccountName || conn?.externalUserId || '';

    const connectIcon = `<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 010 5.657l-3 3a4 4 0 01-5.657-5.657l1.5-1.5m6.828-6.829l3-3a4 4 0 015.657 5.657l-1.5 1.5"/></svg>`;
    const primaryBtn = 'w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-xl shadow-sm hover:shadow transition cursor-pointer';
    const connectBtn = `<button onclick="window._intConnectSource('${source.id}')" class="${primaryBtn}" type="button">${connectIcon} Connect ${_esc(source.label)}</button>`;

    const ghostPill = 'inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg border transition cursor-pointer';
    const neutralPill = `${ghostPill} text-gray-600 bg-gray-50 hover:bg-gray-100 border-gray-200`;
    const reconnectBtn = `<button onclick="window._intConnectSource('${source.id}')" class="${neutralPill}" type="button">Reconnect</button>`;
    const disconnectBtn = `<button onclick="window._intPromptDisconnect(${conn?.id})" class="${ghostPill} text-red-600 bg-white hover:bg-red-600 hover:text-white border-red-200 hover:border-red-600" type="button">Disconnect</button>`;

    const accountChip = (isConnected && account)
        ? `<div class="flex items-center gap-1.5 w-fit max-w-full text-xs font-semibold text-gray-600 bg-gray-50 border border-gray-100 rounded-lg px-2.5 py-1.5 mt-2">
               <svg class="w-3.5 h-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
               <span class="truncate">Connected as ${_esc(account)}</span>
           </div>`
        : '';

    const action = isConnected
        ? `<div class="mt-auto pt-4 border-t border-gray-100 flex items-center gap-2 flex-wrap">
               ${reconnectBtn}
               <span class="ml-auto">${disconnectBtn}</span>
           </div>`
        : `<div class="mt-auto pt-4 border-t border-gray-100">${connectBtn}</div>`;

    // Assistant-scoped: match the capability-card language of the social cards beside it.
    // There is no Enable step — an inbound source is either connected or not, and once it is,
    // the useful next move is to open the picker.
    if (_assistantScoped) {
        const capPill = !isActive
            ? `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">⚠ Connect ${_esc(source.label)}</span>`
            : `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">✓ Connected</span>`;
        const healthPill = (isConnected && health.problem) ? _healthBadge(health) : '';
        const primary = !isActive
            ? connectBtn
            : `<button type="button" onclick="window._intBrowseCanvaDesigns()" class="w-full px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition cursor-pointer">Browse designs</button>`;
        const manage = isConnected
            ? `<details class="mt-1">
                   <summary class="text-xs font-semibold text-gray-500 cursor-pointer hover:text-gray-700 select-none">Manage connection</summary>
                   <div>${action}</div>
               </details>`
            : '';
        return `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex flex-col gap-3">
            <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2 flex-wrap">${capPill}${healthPill}<span class="text-xs font-semibold text-gray-400">← in</span></div>
                <span class="text-xs font-semibold text-gray-400">${_esc(source.label)}</span>
            </div>
            <div class="grow">
                <p class="font-bold text-gray-900">${_esc(source.headline)}</p>
                <p class="text-sm text-gray-500 mt-1">${_esc(source.tagline)}</p>
                ${accountChip}
            </div>
            ${primary}
            ${manage}
        </div>`;
    }

    return `
        <div class="relative bg-white rounded-2xl border ${isConnected ? 'border-emerald-200 shadow-md ring-1 ring-emerald-100' : 'border-gray-200 shadow-sm hover:border-gray-300 hover:shadow-md'} p-5 flex flex-col gap-3 transition">
            <div class="flex items-start gap-3.5">
                <div class="w-11 h-11 rounded-xl ${source.iconBg} ${source.iconText} flex items-center justify-center font-bold text-xl shadow-sm shrink-0">
                    ${source.emoji}
                </div>
                <div class="flex-1 min-w-0">
                    <h3 class="font-extrabold text-gray-900 leading-tight truncate">${_esc(source.label)}</h3>
                    <p class="text-[13px] text-gray-500 mt-1 leading-snug line-clamp-2">${_esc(source.tagline)}</p>
                </div>
                <div class="shrink-0">${_healthBadge(health)}</div>
            </div>
            ${accountChip}
            ${action}
        </div>`;
}

function _platformCard(platform, conn) {
    const isConnected = !!conn;
    const handle = conn?.externalUserId || '';

    const health = _connHealth(conn);
    const statusBadge = _healthBadge(health);
    // connProblem: the connection exists but its token needs attention (expiring/disconnected).
    // Used by the assistant-scoped capability card to surface a secondary health pill.
    const connProblem = health.problem;

    // A platform can only be connected once its handle has been entered on Business
    // Information (single source of truth). Without one, show a disabled prompt that
    // points the user there instead of letting them start a connection.
    const hasHandle = !!_handleFor(platform);

    // US-SMM-4.1.1 / 4.1.2: OAuth platforms use redirect; manual token entry kept for non-OAuth
    // Full-width primary CTA in the brand pink (emerald-700 is remapped to Neon Pink).
    const connectIcon = `<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 010 5.657l-3 3a4 4 0 01-5.657-5.657l1.5-1.5m6.828-6.829l3-3a4 4 0 015.657 5.657l-1.5 1.5"/></svg>`;
    const primaryBtn = 'w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-xl shadow-sm hover:shadow transition cursor-pointer';
    const connectBtn = !hasHandle
        ? `<div class="flex flex-col gap-2">
               <button disabled class="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-100 text-gray-400 text-sm font-bold rounded-xl cursor-not-allowed" type="button">${connectIcon} Connect ${platform.label}</button>
               <button onclick="window.loadView && window.loadView('assets')" class="text-xs font-semibold text-emerald-700 hover:underline cursor-pointer text-center" type="button">Add your ${platform.label} handle in Business Information first →</button>
           </div>`
        : platform.oauthPlatform
        // _intStartOAuth routes platforms with a preConnect checklist (Meta) via the
        // setup modal before redirecting to OAuth.
        ? `<button onclick="window._intStartOAuth('${platform.id}')" class="${primaryBtn}" type="button">${connectIcon} Connect ${platform.label}</button>`
        : `<button onclick="window._intOpenModal('${platform.id}')" class="${primaryBtn}" type="button">${connectIcon} Connect ${platform.label}</button>`;

    // Ghost-pill styles keep the connected-card footer calm and consistent.
    const ghostPill = 'inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg border transition cursor-pointer';
    const neutralPill = `${ghostPill} text-gray-600 bg-gray-50 hover:bg-gray-100 border-gray-200`;
    const brandPill = `${ghostPill} text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-100`;
    const reconnectBtn = platform.oauthPlatform
        ? `<button onclick="window._intStartOAuth('${platform.id}')" class="${neutralPill}" type="button">Reconnect</button>`
        : `<button onclick="window._intOpenModal('${platform.id}')" class="${neutralPill}" type="button">Update token</button>`;
    const disconnectBtn = `<button onclick="window._intPromptDisconnect(${conn?.id})" class="${ghostPill} text-red-600 bg-white hover:bg-red-600 hover:text-white border-red-200 hover:border-red-600" type="button">Disconnect</button>`;

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
        ? `<button onclick="window._intSyncProfile('${platform.id.toLowerCase()}')" class="${brandPill}" type="button">Sync Profile</button>`
        : '';
    const autoRespBtn = (isConnected && (platform.id === 'Instagram' || platform.id === 'Facebook'))
        ? `<button onclick="window._intGenerateAutoResponder()" class="${brandPill}" type="button">Auto-Responder</button>`
        : '';
    // AC1: Generate Bio for the social profile platforms.
    const bioBtn = (isConnected && (platform.id === 'Instagram' || platform.id === 'Facebook' || platform.id === 'LinkedIn'))
        ? `<button onclick="window._intGenerateBio()" class="${brandPill}" type="button">Generate Bio</button>`
        : '';

    // Connected → footer of ghost-pill actions (value actions first, Disconnect pushed right).
    // Disconnected → full-width primary CTA.
    const action = isConnected
        ? `<div class="mt-auto pt-4 border-t border-gray-100 flex items-center gap-2 flex-wrap">
               ${syncBtn}
               ${bioBtn}
               ${autoRespBtn}
               ${reconnectBtn}
               <span class="ml-auto">${disconnectBtn}</span>
           </div>`
        : `<div class="mt-auto pt-4 border-t border-gray-100">${connectBtn}</div>`;

    // Per-assistant "Use for this assistant" toggle — only inside the assistant detail tab,
    // for live connections. Connections are a shared org pool; this controls whether THIS
    // assistant actually posts to it.
    const useToggle = (_assistantScoped && isConnected && conn.status === 'active')
        ? `<label class="flex items-center justify-between gap-3 rounded-xl bg-emerald-50 border border-emerald-100 px-3.5 py-3 cursor-pointer">
               <span class="min-w-0">
                   <span class="block text-sm font-bold text-gray-800">Use for this assistant</span>
                   <span class="block text-xs text-gray-500 mt-0.5 leading-snug">Let this assistant post to ${platform.label}.</span>
               </span>
               <span class="relative shrink-0">
                   <input type="checkbox" class="sr-only peer" ${_assistantSelectedIds.has(conn.id) ? 'checked' : ''} onchange="window._intToggleUseForAssistant(${conn.id}, this.checked)">
                   <span class="block w-11 h-6 bg-gray-200 rounded-full peer-checked:bg-emerald-700 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-200 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:shadow-sm after:transition-all peer-checked:after:translate-x-full peer-checked:after:border-white"></span>
               </span>
           </label>`
        : '';

    // Connected handle shown as a subtle chip so the tagline (what the tool does) stays visible too.
    const handleChip = (isConnected && handle)
        ? `<div class="flex items-center gap-1.5 w-fit max-w-full text-xs font-semibold text-gray-600 bg-gray-50 border border-gray-100 rounded-lg px-2.5 py-1.5">
               <svg class="w-3.5 h-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
               <span class="truncate">${_esc(handle)}</span>
           </div>`
        : '';

    // ── Assistant-scoped capability card ─────────────────────────────
    // Inside an assistant's Connections tab, render social platforms in the SAME recipe-card
    // language as the "Synced actions" list (assistant-integrations.js) so the area reads as
    // one consistent set of enable-able actions. This drives the real Connect + per-assistant
    // "Use for this assistant" flow — publishing itself is handled by the existing social
    // pipeline (approve-post → publish-*), not the scenario engine, so there's nothing new to
    // fire here. Rich management (reconnect/disconnect/sync/bio/auto-responder/troubleshooting)
    // is preserved behind a "Manage connection" disclosure. The standalone hub keeps the full
    // card below.
    if (_assistantScoped) {
        const isActive = isConnected && conn.status === 'active';
        const inUse = isActive && _assistantSelectedIds.has(conn.id);
        // Recipe-vocabulary status pill: Connect → Not enabled → Enabled.
        const capPill = !isActive
            ? `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">⚠ Connect ${_esc(platform.label)}</span>`
            : inUse
            ? `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">✓ Enabled</span>`
            : `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">Not enabled</span>`;
        // Keep a health pill visible only when the token needs attention (expiring/disconnected).
        const healthPill = (isConnected && connProblem) ? statusBadge : '';
        // Connect button is ALWAYS visible. When the connection is already active it's greyed out
        // and disabled (nothing left to connect); when inactive it's the live connect CTA — which
        // itself still gates on a missing Business-Information handle.
        const connectControl = isActive
            ? `<button disabled class="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-100 text-gray-400 text-sm font-bold rounded-xl cursor-not-allowed" type="button">${connectIcon} Connect ${_esc(platform.label)}</button>`
            : connectBtn;
        // Enabling this connection for the assistant is a toggle switch (was an Enable/Enabled
        // button). Only meaningful once the connection is active.
        const enableToggle = isActive
            ? `<label class="flex items-center justify-between gap-3 rounded-xl bg-emerald-50 border border-emerald-100 px-3.5 py-3 cursor-pointer">
                   <span class="min-w-0">
                       <span class="block text-sm font-bold text-gray-800">Use for this assistant</span>
                       <span class="block text-xs text-gray-500 mt-0.5 leading-snug">Let this assistant post to ${_esc(platform.label)}.</span>
                   </span>
                   <span class="relative shrink-0">
                       <input type="checkbox" class="sr-only peer" ${inUse ? 'checked' : ''} onchange="window._intToggleUseForAssistant(${conn.id}, this.checked)">
                       <span class="block w-11 h-6 bg-gray-200 rounded-full peer-checked:bg-emerald-700 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-200 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:shadow-sm after:transition-all peer-checked:after:translate-x-full peer-checked:after:border-white"></span>
                   </span>
               </label>`
            : '';
        const manage = isConnected
            ? `<details class="mt-1">
                   <summary class="text-xs font-semibold text-gray-500 cursor-pointer hover:text-gray-700 select-none">Manage connection</summary>
                   <div>${action}${troubleshootingHtml}</div>
               </details>`
            : '';
        return `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex flex-col gap-3">
            <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2 flex-wrap">${capPill}${healthPill}<span class="text-xs font-semibold text-gray-400">→ out</span></div>
                <span class="text-xs font-semibold text-gray-400">${_esc(platform.label)}</span>
            </div>
            <div class="grow">
                <p class="font-bold text-gray-900">Publish approved posts to ${_esc(platform.label)}</p>
                <p class="text-sm text-gray-500 mt-1">${_esc(platform.tagline)}</p>
                ${handleChip}
                ${_xUsageGauge(platform)}
            </div>
            ${connectControl}
            ${enableToggle}
            ${manage}
        </div>`;
    }

    return `
        <div class="relative bg-white rounded-2xl border ${isConnected ? 'border-emerald-200 shadow-md ring-1 ring-emerald-100' : 'border-gray-200 shadow-sm hover:border-gray-300 hover:shadow-md'} p-5 flex flex-col gap-3 transition">
            <div class="flex items-start gap-3.5">
                <div class="w-11 h-11 rounded-xl ${platform.iconBg} ${platform.iconText} flex items-center justify-center font-bold text-xl shadow-sm shrink-0">
                    ${platform.emoji}
                </div>
                <div class="flex-1 min-w-0">
                    <h3 class="font-extrabold text-gray-900 leading-tight truncate">${platform.label}</h3>
                    <p class="text-[13px] text-gray-500 mt-1 leading-snug line-clamp-2">${platform.tagline}</p>
                </div>
                <div class="shrink-0">${statusBadge}</div>
            </div>
            ${handleChip}
            ${_xUsageGauge(platform)}
            ${preflightBadge ? `<div>${preflightBadge}</div>` : ''}
            ${action}
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

// ── Pre-connect setup checklist (Meta platforms) ─────────────────
// Instagram/Facebook OAuth fails on Facebook's side (with an unhelpful Meta error
// page) when the user hasn't done the Business-account/Page setup. Show the
// required steps BEFORE redirecting, with an explicit "Continue" to start OAuth.
window._intOpenPreConnect = function (platformId) {
    const platform = PLATFORMS.find(p => p.id === platformId);
    if (!platform || !platform.preConnect) return;
    const pc = platform.preConnect;

    const iconEl = document.getElementById('preconnect-icon');
    if (iconEl) {
        iconEl.className = `w-12 h-12 rounded-xl flex items-center justify-center text-xl font-bold shadow-sm shrink-0 ${platform.iconBg} ${platform.iconText}`;
        iconEl.textContent = platform.emoji;
    }
    const titleEl = document.getElementById('preconnect-title');
    if (titleEl) titleEl.textContent = `Connect ${platform.label}`;
    const introEl = document.getElementById('preconnect-intro');
    if (introEl) introEl.textContent = pc.intro || '';

    const stepsEl = document.getElementById('preconnect-steps');
    if (stepsEl) {
        stepsEl.innerHTML = pc.steps.map((s, i) => `<li class="flex items-start gap-3">
            <span class="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs font-extrabold flex items-center justify-center shrink-0 mt-0.5">${i + 1}</span>
            <p class="text-sm text-gray-700 leading-relaxed">${s.text}${s.url ? ` <a href="${s.url}" target="_blank" rel="noopener" class="text-emerald-600 hover:underline font-semibold">Open ↗</a>` : ''}</p>
        </li>`).join('');
    }

    const noteEl = document.getElementById('preconnect-note');
    if (noteEl) {
        if (pc.note) {
            noteEl.classList.remove('hidden');
            noteEl.innerHTML = `<svg class="w-4 h-4 shrink-0 text-amber-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>${pc.note}</span>`;
        } else {
            noteEl.classList.add('hidden');
        }
    }

    const continueBtn = document.getElementById('btn-preconnect-continue');
    if (continueBtn) {
        continueBtn.setAttribute('href', _oauthUrl(platform));
        continueBtn.textContent = `I've done all this — continue to ${platform.label}`;
    }

    _closeDrawerForModal();
    document.getElementById('modal-preconnect')?.classList.remove('hidden');
};

// ── Open connect modal ────────────────────────────────────────────
window._intOpenModal = function (platformId) {
    const platform = PLATFORMS.find(p => p.id === platformId);
    if (!platform) return;

    // US-SMM-4.1.1: OAuth platforms redirect instead of showing the token modal
    // (via the pre-connect setup checklist when the platform defines one).
    if (platform.oauthPlatform) {
        if (platform.preConnect) { window._intOpenPreConnect(platformId); return; }
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

    _closeDrawerForModal();
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
    _closeDrawerForModal();
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
                <p class="text-sm font-semibold text-gray-900">Here are profile bios tailored to each platform. Edit any you like, then use <span class="font-bold">Sync Profile</span> to push the Facebook version to your connected Page.</p>
                <p class="text-xs text-gray-500 mt-1">Instagram and LinkedIn bios must be pasted in manually — use Copy.</p>
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
