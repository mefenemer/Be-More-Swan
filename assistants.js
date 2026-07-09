// ==========================================
// GLOBAL STATE
// ==========================================
window.activeAssistantId = null;
window.cachedContext = {};

// ── Magic Wand click sound — synthesized "magical whoosh" (Web Audio API, no
// binary asset needed) played whenever the Swan & Wand icon is clicked, on
// every page it appears on (delegated listener, so drawer/detail content
// injected later is covered too). ──────────────────────────────────────────
window._playMagicWandSound = function () {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = window._wandAudioCtx || (window._wandAudioCtx = new Ctx());
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;

        // Whoosh: band-pass filtered noise sweeping up then settling back down.
        const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const noise = ctx.createBufferSource();
        noise.buffer = noiseBuffer;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 0.8;
        filter.frequency.setValueAtTime(300, now);
        filter.frequency.exponentialRampToValueAtTime(3200, now + 0.22);
        filter.frequency.exponentialRampToValueAtTime(500, now + 0.5);

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.0001, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.3, now + 0.15);
        noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

        noise.connect(filter).connect(noiseGain).connect(ctx.destination);
        noise.start(now);
        noise.stop(now + 0.5);

        // Sparkle: a few high chimes shimmering near the top of the sweep.
        [1760, 2349, 3136].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const gain = ctx.createGain();
            const start = now + 0.16 + i * 0.05;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.1, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
            osc.connect(gain).connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.4);
        });
    } catch { /* audio is a nice-to-have; never block the click it's attached to */ }
};

document.addEventListener('click', (e) => {
    const onWand = e.target.closest('.ai-wand-img') ||
        e.target.closest('button, a, [role="button"]')?.querySelector?.('.ai-wand-img');
    if (onWand) window._playMagicWandSound();
});

// ==========================================
// 1. SHARED CARD GENERATOR (Dashboard & Directory)
// ==========================================
// Platform display helpers used by card and detail metrics
window._PLATFORM_ICONS = {
    instagram: `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>`,
    facebook: `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
    linkedin: `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,
    x: `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.835L1.254 2.25H8.08l4.253 5.622 5.911-5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
};
window._PLATFORM_LABEL = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X' };

// ── Shared lifecycle badge resolver (Epic 1 AC1.1.2) ──────────────────────────
// Single source of truth for the "My Assistants" list card and the Assistant Details pill,
// so they can't diverge again. A `working` lifecycle refines into an operational sub-state
// from live signals: a mid-flight job → "Executing Task"; else drafts awaiting the user →
// "Awaiting Human Review"; else "Idle".
window._LIFECYCLE_BADGES = {
    blocked:        { cls: 'bg-amber-50 text-amber-700 border-amber-200',      dot: 'bg-amber-500',                 label: 'Action Required',    toggle: 'Initiate Kick-Off' },
    provisioning:   { cls: 'bg-amber-50 text-amber-700 border-amber-200',      dot: 'bg-amber-500 animate-pulse',   label: 'Setup in Progress',  toggle: 'Pause Assistant' },
    ready_for_work: { cls: 'bg-blue-50 text-blue-700 border-blue-200',          dot: 'bg-blue-500',                  label: 'Ready for Work',     toggle: 'Initiate Kick-Off' },
    working:        { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500 animate-pulse', label: 'Working',            toggle: 'Pause Assistant' },
    paused:         { cls: 'bg-gray-100 text-gray-600 border-gray-200',         dot: 'bg-gray-400',                  label: 'Paused',             toggle: 'Resume Assistant' },
    system_paused:  { cls: 'bg-red-50 text-red-700 border-red-200',             dot: 'bg-red-500 animate-pulse',     label: 'Attention Required', toggle: 'Resume Assistant' },
    archived:       { cls: 'bg-gray-100 text-gray-500 border-gray-200',         dot: 'bg-gray-300',                  label: 'Archived',           toggle: 'Resume Assistant' },
};

window._resolveAssistantBadge = function(data, opSignals) {
    // Lifecycle state machine (assistant-lifecycle-epic). Fall back to legacy fields.
    // A gate-blocked assistant reads as lifecycle 'provisioning' but needs user action, so it gets
    // its own "Action Required" badge instead of the passive "Setup in Progress" spinner.
    const lifecycle = data.status === 'blocked' ? 'blocked' : (data.lifecycleStatus
      || (data.status === 'pending' ? 'provisioning' : (data.isActive === false ? 'paused' : 'working')));
    let p = window._LIFECYCLE_BADGES[lifecycle] || window._LIFECYCLE_BADGES.working;

    if (lifecycle === 'working') {
        const sig = opSignals || {};
        if (sig.activeJobCount > 0) {
            p = { ...p, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500 animate-pulse', label: 'Executing Task' };
        } else if (sig.pendingReview > 0) {
            p = { ...p, cls: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500', label: 'Awaiting Human Review' };
        } else {
            p = { ...p, cls: 'bg-gray-100 text-gray-600 border-gray-200', dot: 'bg-gray-400', label: 'Idle' };
        }
    }
    return p;
};

window.generateAssistantCardHTML = function(assistant) {
    const initial = assistant.name ? assistant.name.charAt(0).toUpperCase() : 'A';
    const role = assistant.role || 'Custom Assistant';

    const db = window._resolveAssistantBadge(assistant, assistant.opSignals);
    const statusHtml = `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold ${db.cls}"><span class="w-1.5 h-1.5 rounded-full ${db.dot}"></span> ${db.label}</span>`;

    // SMART Goals AC2.1.1 — "X On Track | Y Off Track" micro-summary.
    // When no goals exist yet, show a prompt that deep-links to the assistant's Goals tab so the
    // user is nudged (and able) to set measurable targets. Goals start life as 'pending' until the
    // run-rate engine assesses them (poll-goal-telemetry, gated by RUN_RATE_THRESHOLDS.minObservationDays),
    // so a card whose goals are all still pending must say so instead of showing a misleading "0 On
    // Track | 0 Off Track" (issue #135).
    const gs = assistant.goalSummary || { onTrack: 0, offTrack: 0, total: 0 };
    const goalsAssessed = gs.onTrack + gs.offTrack;
    const goalsHtml = gs.total > 0 ? (goalsAssessed > 0 ? `
        <div class="flex items-center gap-4 text-xs font-semibold mb-5">
            <span class="inline-flex items-center gap-1.5 text-emerald-600"><span class="w-2 h-2 rounded-full bg-emerald-500"></span>${gs.onTrack} On Track</span>
            <span class="inline-flex items-center gap-1.5 text-red-600"><span class="w-2 h-2 rounded-full bg-red-500"></span>${gs.offTrack} Off Track</span>
        </div>` : `
        <div class="flex items-center gap-2 text-xs font-semibold text-gray-400 mb-5">
            <span class="w-2 h-2 rounded-full bg-gray-300"></span>Awaiting first progress check-in
        </div>`) : `
        <button type="button" onclick="event.stopPropagation(); window._assistantDetailInitialTab='goals'; window.routeToAssistantDetail('${assistant.id}')"
            class="flex items-center gap-2 text-xs font-semibold text-gray-400 hover:text-emerald-700 mb-5 cursor-pointer transition-colors text-left">
            <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v8m4-4H8m13 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            No goals set yet — <span class="underline">add goals to track performance</span>
        </button>`;

    // Post metrics strip
    const pm = assistant.postMetrics || {};
    const totalCreated = pm.totalCreated || 0;
    const totalScheduled = pm.totalScheduled || 0;
    const totalPublished = pm.totalPublished || 0;
    const hoursSaved = pm.hoursSaved || 0;
    const gbpSaved = pm.gbpSaved ?? null;

    // Per-platform icons row (only platforms with at least one post)
    const byPlatform = pm.byPlatform || {};
    const platformPills = Object.entries(byPlatform)
        .filter(([, v]) => v.created > 0)
        .map(([p, v]) => {
            const icon = window._PLATFORM_ICONS[p] || '';
            const label = window._PLATFORM_LABEL[p] || p;
            return `<span class="inline-flex items-center gap-1 text-gray-500" title="${label}: ${v.created} created, ${v.published} published">
                ${icon}<span class="text-xs font-semibold">${v.published}/${v.created}</span>
            </span>`;
        }).join('');

    const metricsHtml = totalCreated > 0 ? `
        <div class="mt-3 mb-4 p-3 rounded-xl bg-gray-50 border border-gray-100">
            <div class="flex items-center justify-between gap-2 mb-2">
                <div class="flex items-center gap-3 flex-wrap">
                    <span class="inline-flex items-center gap-1 text-xs font-semibold text-gray-700" title="Posts created by this assistant">
                        <svg class="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                        ${totalCreated} created
                    </span>
                    <span class="inline-flex items-center gap-1 text-xs font-semibold text-gray-700" title="Posts scheduled or awaiting approval">
                        <svg class="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                        ${totalScheduled} scheduled
                    </span>
                    <span class="inline-flex items-center gap-1 text-xs font-semibold text-gray-700" title="Posts successfully published">
                        <svg class="w-3.5 h-3.5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                        ${totalPublished} published
                    </span>
                </div>
            </div>
            ${platformPills ? `<div class="flex items-center gap-3 mb-2">${platformPills}</div>` : ''}
            <div class="flex items-center justify-between pt-2 border-t border-gray-200">
                <span class="inline-flex items-center gap-1 text-xs font-semibold text-green-700" title="Time saved this week — matches this assistant's Impact & ROI tab">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                    ~${hoursSaved}h saved
                </span>
                ${gbpSaved !== null
                    ? `<span class="text-xs font-bold text-green-700 bg-green-50 px-2 py-0.5 rounded-full">≈ £${gbpSaved.toLocaleString('en-GB', {minimumFractionDigits: 0, maximumFractionDigits: 0})} ROI</span>`
                    : `<span class="text-xs text-gray-400 cursor-pointer hover:text-green-600 transition" onclick="event.stopPropagation(); loadView && loadView('account')" title="Set your hourly rate to see financial ROI">Set rate → ROI</span>`
                }
            </div>
        </div>` : '';

    // Issue #178: per-assistant Quick Actions — replaces the old dashboard-wide "Quick
    // actions" widget with shortcuts scoped to this assistant, using the same per-role
    // labels as its own Data Hub / Review Queue tabs (AssistantDashboardRegistry), so a
    // lead_qualifier card links to "Leads" while a tier1_support_agent links to "Tickets".
    const dReg = window.AssistantDashboardRegistry ? window.AssistantDashboardRegistry.get(assistant.roleKey) : null;
    const quickActions = dReg ? [
        ['🗂️', dReg.hubTab?.label || 'Data Hub', 'datahub'],
        ['✅', dReg.reviewQueue?.label || 'Review', 'review-queue'],
        ['📅', 'Calendar', 'calendar'],
    ] : [];
    const quickActionsHtml = quickActions.length ? `
        <div class="flex items-center gap-2 flex-wrap mb-4 pt-4 border-t border-gray-50">
            ${quickActions.map(([icon, label, tab]) => `
            <button type="button" onclick="event.stopPropagation(); window._assistantDetailInitialTab='${tab}'; window.routeToAssistantDetail('${assistant.id}')"
                class="px-2.5 py-1.5 text-xs font-semibold text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 hover:text-emerald-700 transition">${icon} ${label}</button>`).join('')}
        </div>` : '';

    return `
    <div class="bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow p-6 flex flex-col cursor-pointer group" onclick="window.routeToAssistantDetail('${assistant.id}')">
        <div class="flex justify-between items-start mb-4">
            <div class="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold text-lg shadow-sm">
                ${initial}
            </div>
            ${statusHtml}
        </div>
        <h3 class="text-lg font-bold text-gray-900 group-hover:text-emerald-700 transition-colors">${assistant.name}</h3>
        <p class="text-sm text-gray-500 mb-4">${role}</p>
        ${goalsHtml}
        ${metricsHtml}
        ${quickActionsHtml}
        <div class="mt-auto pt-4 border-t border-gray-50 flex justify-between items-center">
            <button type="button" onclick="event.stopPropagation(); window.openAssistantChatModal ? window.openAssistantChatModal('${assistant.id}', '${(assistant.name || 'Your assistant').replace(/'/g, '&#39;')}', '${role.replace(/'/g, '&#39;')}', '${(assistant.roleKey || '').replace(/'/g, '&#39;')}') : (window.location.href = 'assistant-chat.html?assistantId=${assistant.id}')"
               class="px-3.5 py-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition cursor-pointer">💬 Chat</button>
            <span class="text-sm font-bold text-gray-900 group-hover:text-emerald-700 transition-colors">View Details &rarr;</span>
        </div>
    </div>`;
};

// ==========================================
// 1b. "ADD NEW ASSISTANT" PLACEHOLDER CARD
// ==========================================
// Inviting empty-state / trailing card that guides the user into the hire flow. Styled with the
// scoped plain CSS in assistants-directory.html (.add-asst-*), so it is immune to the prebuilt
// Tailwind build. The copy rotates by index to keep multiple placeholders feeling fresh.
window._ADD_ASSISTANT_COPY = [
    { title: 'Hire an Assistant',     sub: 'Bring a new AI teammate on board to take a task off your plate.' },
    { title: 'Grow Your Team',        sub: 'Expand your AI workforce and delegate even more of your day.' },
    { title: 'Automate Another Task', sub: 'Find the right assistant for your next repetitive chore.' },
];

window.generateAddAssistantPlaceholderHTML = function(index) {
    const pool = window._ADD_ASSISTANT_COPY;
    const copy = pool[(((index || 0) % pool.length) + pool.length) % pool.length];
    const plus = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>`;
    return `
    <div class="add-asst-card" role="button" tabindex="0" aria-label="${copy.title}"
         onclick="loadView('catalog')"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();loadView('catalog');}">
        <div class="add-asst-ico">${plus}</div>
        <h3 class="add-asst-title">${copy.title}</h3>
        <p class="add-asst-sub">${copy.sub}</p>
        <span class="add-asst-cta">${plus}Add New Assistant</span>
    </div>`;
};

// ==========================================
// 2. FETCH & RENDER ENGINE
// ==========================================
// options.placeholders — render inviting "Add New Assistant" cards (My Assistants page).
window.fetchAndRenderAssistants = async function(containerId, options) {
    const opts = options || {};
    const container = document.getElementById(containerId);
    if (!container) return;

    try {
        const res = await fetch('/.netlify/functions/get-assistants');
        if (!res.ok) throw new Error("Failed to fetch");

        const data = await res.json();
        container.innerHTML = ''; // Clear the "Gathering your team..." placeholder

        // US6 AC5.3: archived assistants are removed from active views (history kept server-side).
        const visible = (data.assistants || []).filter(a => a.lifecycleStatus !== 'archived' && a.status !== 'cancelled');

        if (opts.placeholders) {
            // My Assistants always guides the user with placeholder cards instead of empty text.
            // Empty team → a full row of 3 invitations. With assistants present, show them and
            // fill the first row to 3 (1 active → 2 placeholders, 2 → 1), and always keep at least
            // one trailing "Add New" placeholder once there are 3+ assistants.
            visible.forEach(assistant => {
                container.insertAdjacentHTML('beforeend', window.generateAssistantCardHTML(assistant));
            });
            const placeholderCount = visible.length === 0 ? 3 : (visible.length < 3 ? 3 - visible.length : 1);
            for (let i = 0; i < placeholderCount; i++) {
                container.insertAdjacentHTML('beforeend', window.generateAddAssistantPlaceholderHTML(i));
            }
            return;
        }

        if (visible.length === 0) {
            container.innerHTML = `
              <div class="col-span-full py-12 text-center text-gray-500 font-medium bg-white rounded-2xl border border-gray-100 shadow-sm">
                  Your team is currently empty. <a href="#" onclick="loadView('catalog')" class="text-emerald-600 hover:underline">Hire an assistant</a>.
              </div>`;
            return;
        }

        visible.forEach(assistant => {
            container.insertAdjacentHTML('beforeend', window.generateAssistantCardHTML(assistant));
        });
    } catch (error) {
        container.innerHTML = `<div class="col-span-full text-center text-red-500">Could not connect to the database to load your team.</div>`;
    }
};

// ==========================================
// 3. SPA ROUTER INITIALIZATION HOOKS
// ==========================================
window.initDashboard = async function() {
    await window.fetchAndRenderAssistants('dashboard-assistants-grid');
};

window.initAssistantsDirectory = async function(loadViewCb) {
    await window.fetchAndRenderAssistants('directory-assistants-grid', { placeholders: true });

    const catalogBtn = document.getElementById('route-to-catalog-from-dir');
    if (catalogBtn) {
        catalogBtn.addEventListener('click', () => loadViewCb('catalog'));
    }

    // Issue #134: disabled ("coming soon") in the markup — no click routing to wire up.
};

// ==========================================
// 4. ASSISTANT DETAIL CONTROLLER (The Control Room)
// ==========================================

// Name generator pool
const _namePool = [
    'Aria', 'Nova', 'Echo', 'Sage', 'Luna', 'Atlas', 'Ember', 'Orion',
    'Lyra', 'Zara', 'Finn', 'Cleo', 'Rex', 'Mira', 'Axel', 'Skye',
    'Juno', 'Blaze', 'Ivy', 'Max', 'Stella', 'Cole', 'Pip', 'Dawn',
    'Felix', 'Nova', 'Cyra', 'Dex', 'Wren', 'Lux'
];
let _namePoolIdx = Math.floor(Math.random() * _namePool.length);

function _detailSetVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val || '';
}

// Posting Frequency is now a discrete <select>. A legacy/custom stored value (free text like
// "twice a day", or a key like "3x_week") won't match a built-in option, so inject it as a
// selectable option to preserve it — the backend cadence parser still understands it.
function _setFrequencySelect(val) {
    const sel = document.getElementById('edit_frequency');
    if (!sel) return;
    const value = (val || '').toString();
    if (value && !Array.from(sel.options).some(o => o.value === value)) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        sel.appendChild(opt);
    }
    sel.value = value;
}

// ── Posting Schedule (frequency + days + times + timezone) ──────────────────────────────
// Stored on onboarding_context: posting_frequency, posting_days[], posting_times[], posting_timezone.
const _POSTING_DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const _POSTING_DEFAULT_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const _POSTING_DEFAULT_TIMES = ['09:00'];
const _POSTING_DEFAULT_TZ = 'Europe/London';
const _POSTING_DEFAULT_FREQ = '3 times a week';

function _normaliseTime(v) {
    const m = String(v ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Build one removable time-input row. Inputs/removal notify the autosave via the global hook.
function _addPostingTimeRow(value) {
    const list = document.getElementById('posting-times-list');
    if (!list) return;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:0.5rem';
    row.innerHTML = `
        <input type="time" value="${_normaliseTime(value) || '09:00'}" class="posting-time-input border border-gray-300 rounded-lg p-2.5 text-sm bg-white focus:ring-2 focus:ring-emerald-700 transition shadow-sm">
        <button type="button" class="posting-time-remove text-gray-400 hover:text-red-500 transition cursor-pointer" title="Remove time" aria-label="Remove time">✕</button>`;
    row.querySelector('.posting-time-input').addEventListener('input', () => window._postingScheduleChanged && window._postingScheduleChanged());
    row.querySelector('.posting-time-remove').addEventListener('click', () => {
        row.remove();
        window._postingScheduleChanged && window._postingScheduleChanged();
    });
    list.appendChild(row);
}

function _renderPostingTimes(times) {
    const list = document.getElementById('posting-times-list');
    if (!list) return;
    list.innerHTML = '';
    const clean = (Array.isArray(times) ? times : []).map(_normaliseTime).filter(Boolean);
    (clean.length ? clean : _POSTING_DEFAULT_TIMES).forEach(t => _addPostingTimeRow(t));
}

function _collectPostingTimes() {
    const inputs = Array.from(document.querySelectorAll('#posting-times-list .posting-time-input'));
    const seen = new Set();
    const out = [];
    inputs.forEach(el => {
        const t = _normaliseTime(el.value);
        if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    });
    return out.sort();
}

function _collectPostingDays() {
    return _POSTING_DAY_KEYS.filter(d => document.getElementById('edit_day_' + d)?.checked);
}

// Content Pillars are stored as a discrete array. Parse the comma/semicolon/newline-separated
// entry field into a deduped, trimmed list of up to 5 themes.
function _parsePillars(raw) {
    const seen = new Set();
    return (Array.isArray(raw) ? raw : String(raw ?? ''))
        .toString()
        .split(/[,;\n]/)
        .map(p => p.trim())
        .filter(p => {
            if (!p) return false;
            const key = p.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 5);
}

// Render a live chip preview of the discrete pillars below the entry field.
function _renderPillarChips() {
    const host = document.getElementById('pillars-chips');
    if (!host) return;
    const pillars = _parsePillars(document.getElementById('edit_pillars')?.value);
    if (!pillars.length) { host.innerHTML = ''; return; }
    const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    host.innerHTML = pillars.map(p =>
        `<span class="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">${esc(p)}</span>`
    ).join('');
}

// Brief fields that auto-grow with their content. These can hold a lot of text (especially the
// AI-wand fields), so they're rendered as textareas that expand to keep everything visible —
// no inner scrollbar, no truncation. Heights must be recomputed when a hidden tab is revealed,
// since scrollHeight is 0 while the panel is display:none.
const _AUTOGROW_FIELDS = ['edit_problem', 'edit_core_message', 'edit_audience', 'edit_tone', 'edit_pillars', 'edit_offerings', 'edit_objections'];

function _autoGrowField(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function _initBriefAutoGrow() {
    _AUTOGROW_FIELDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.dataset.autogrow) return;
        el.dataset.autogrow = '1';
        el.addEventListener('input', () => _autoGrowField(el));
    });
    // Keep the discrete pillar chips in sync as the user types (and on wand-applied changes,
    // which dispatch an 'input' event on edit_pillars).
    const pillarsEl = document.getElementById('edit_pillars');
    if (pillarsEl && !pillarsEl.dataset.chipsync) {
        pillarsEl.dataset.chipsync = '1';
        pillarsEl.addEventListener('input', _renderPillarChips);
    }
}

function _resizeBriefAutoGrow() {
    _AUTOGROW_FIELDS.forEach(id => _autoGrowField(document.getElementById(id)));
    // Per-assistant Assistant Rules rows (#tab-rules) are built dynamically and hit the
    // same display:none / scrollHeight:0 problem — recompute their height too.
    document.querySelectorAll('#assistant-rules-editor .ar-input').forEach(_autoGrowField);
}

// ── Assistant-detail tab switching (event delegation) ─────────────────────────
// Two levels of tabs on the detail page:
//   • Main tabs (.main-tab-btn → #maintab-*): Overview / Goals / Automation / Configuration.
//   • Child tabs (.detail-tab-btn → #tab-*): the Configuration sub-sections, nested inside
//     the Configuration main tab.
// Both are bound ONCE at module load on the document, not per-button inside initAssistantDetail.
// The detail view is re-injected via innerHTML on every navigation, so per-button
// addEventListener handlers attached during init are brittle: they break if init
// throws before reaching them, if the buttons are re-rendered after binding, or if a
// stale set of nodes is matched. Delegation resolves the target at click time, so it
// works regardless of when/whether init ran and survives any view re-injection.

// Activate a main tab by name ('overview' | 'goals' | 'workflow' | 'meetings'). Exposed so other code
// (deep-links, attention CTAs, child-tab clicks) can surface the right section.
window._activateMainTab = function(name) {
    document.querySelectorAll('.main-tab-btn').forEach(b => b.classList.toggle('active-tab', b.dataset.maintab === name));
    document.querySelectorAll('.main-tab-content').forEach(c => c.classList.toggle('hidden', c.id !== 'maintab-' + name));
    // Recompute auto-grow heights now panels are visible (scrollHeight was 0 while hidden).
    _resizeBriefAutoGrow();
    // Load the assistant-scoped review queue when the tab is first opened. detailRqOpenStatus
    // branches on window._detailReviewQueue.kind (posts vs records) internally.
    if (name === 'review-queue') {
        const renderDone = detailRqOpenStatus('review');
        // Issue #180 follow-up: a chat "review & approve" link can name the exact post it
        // just drafted (window._assistantDetailInitialPostId, set by workspace.html's
        // ?postId= deep-link) — pop the review modal to it once the list has rendered and
        // warmed the post cache (openPostReview falls back to its own fetch either way).
        const openPostId = window._assistantDetailInitialPostId;
        if (openPostId != null) {
            window._assistantDetailInitialPostId = null;
            Promise.resolve(renderDone).then(() => window.openPostReview?.(openPostId));
        }
    }
    // Re-read the Data Hub each time it's opened, so records produced after page-load —
    // discovery-promoted leads, chat/integration records, Review-Queue approvals — appear
    // without a full reload. init() already ran at page setup; this only refetches.
    if (name === 'datahub') window.AssistantDataHub?.refresh();
    // Render the per-assistant Calendar on first open (component scopes calendar.js to this assistant).
    if (name === 'calendar') window.AssistantCalendar?.show();
};

// ── Assistant-detail scoped Review Queue ─────────────────────────────────────
// Mirrors the global rqOpenStatus/rqRenderGroups in workspace.html but scopes all
// fetches to window._currentAssistantId so only this assistant's content shows.

const _DETAIL_RQ_COLUMNS = {
    review:    { postStatus: 'pending_approval', ideaFilter: i => i.status === 'pending' },
    approved:  { postStatus: 'approved',         ideaFilter: () => false },
    scheduled: { postStatus: 'scheduled',        ideaFilter: () => false },
    posted:    { postStatus: 'published',        ideaFilter: () => false },
    // Once an idea has been woven into a post (in_review/delivered), its own review happens on
    // that post's card in the Posts group — it no longer needs a separate slot in Review.
    archived:  { postStatus: 'rejected',         ideaFilter: i => i.status === 'discarded' || i.status === 'in_review' || i.status === 'delivered' },
};

let _detailRqCurrentStatus = 'review';
const _detailRqGroupOpen = { ideas: true, posts: true };

window.detailRqOpenStatus = function(statusKey, btn) {
    if (!_DETAIL_RQ_COLUMNS[statusKey]) return;
    _detailRqCurrentStatus = statusKey;
    document.querySelectorAll('.detail-rq-col').forEach(t => {
        t.classList.remove('border-b-2', 'border-emerald-600', 'text-emerald-700');
        t.classList.add('text-gray-500');
    });
    const active = btn || document.querySelector(`.detail-rq-col[data-status="${statusKey}"]`);
    if (active) { active.classList.add('border-b-2', 'border-emerald-600', 'text-emerald-700'); active.classList.remove('text-gray-500'); }
    return _detailRqRenderGroups(statusKey);
};

// Re-render whichever column is currently open, e.g. after a new idea/post is added elsewhere
// (the Create Post sheet) so the list reflects it without the user manually switching tabs.
window.detailRqRefresh = function() {
    if (document.getElementById('detail-rq-groups')) _detailRqRenderGroups(_detailRqCurrentStatus);
};

async function _detailRqRenderGroups(statusKey) {
    // Records-backed Review Queue (data-hub roles): assistant_records gated by approval_status,
    // rather than the social posts/ideas lifecycle below.
    if ((window._detailReviewQueue || {}).kind === 'records') return _detailRqRenderRecords(statusKey);
    // Blog Writer: long-form drafts live in blog_posts (not scheduled_posts). The queue lists them
    // and routes into Blog Studio (where blog review/editing lives) + schedules via schedule-blog.
    if ((window._detailReviewQueue || {}).source === 'blog_posts') return _detailRqRenderBlog(statusKey);

    const col = _DETAIL_RQ_COLUMNS[statusKey] || _DETAIL_RQ_COLUMNS.review;
    const container = document.getElementById('detail-rq-groups');
    if (!container) return;
    container.innerHTML = '<p class="text-sm text-gray-400 py-10 text-center">Loading…</p>';

    const aid = window._currentAssistantId;
    if (!aid) { container.innerHTML = '<p class="text-sm text-red-500 py-10 text-center">No assistant selected.</p>'; return; }

    let posts = [], ideas = [];
    try {
        const [pRes, iRes] = await Promise.all([
            fetch(`/.netlify/functions/get-social-drafts?status=${col.postStatus}&assistantId=${aid}`),
            fetch(`/.netlify/functions/get-post-ideas?assistantId=${aid}`),
        ]);
        if (pRes.ok) posts = (await pRes.json()).drafts || [];
        if (iRes.ok) ideas = ((await iRes.json()).ideas || []).filter(col.ideaFilter);
    } catch {
        container.innerHTML = '<p class="text-sm text-red-500 py-10 text-center">Failed to load.</p>';
        return;
    }

    // Keep the Review column badge and the tab badge in sync.
    if (statusKey === 'review') {
        const colBadge = document.getElementById('detail-rq-col-count-review');
        if (colBadge) { colBadge.textContent = posts.length || ''; colBadge.classList.toggle('hidden', !posts.length); }
        const tabBadge = document.getElementById('detail-rq-pending-badge');
        if (tabBadge) { tabBadge.textContent = posts.length || ''; tabBadge.classList.toggle('hidden', !posts.length); }
        // Keep the Overview action-bar badge + status pill in sync as the queue changes (e.g. after approving).
        window._setReviewPendingBadge?.(posts.length);
        window._updateOpSignals?.({ pendingReview: posts.length });
    }

    // Reuse the global render helpers from workspace.html (rqRenderSocialCard, rqRenderIdeaCard, etc.)
    const renderByGroup = { ideas: typeof rqRenderIdeaCard === 'function' ? rqRenderIdeaCard : () => '', posts: typeof rqRenderSocialCard === 'function' ? rqRenderSocialCard : () => '' };
    const RQ_GROUPS = [
        { key: 'ideas', label: 'Ideas', empty: 'No ideas here.', emptyReview: 'No ideas yet — use Create Post → Suggest an idea.' },
        { key: 'posts', label: 'Posts', empty: 'No posts here.', emptyReview: 'No posts awaiting review.' },
    ];
    const itemsByGroup = { ideas, posts };
    container.innerHTML = RQ_GROUPS.map(g => _detailRqGroupSection(g, itemsByGroup[g.key] || [], renderByGroup[g.key], statusKey)).join('');
}

function _detailRqGroupSection(g, items, render, statusKey) {
    const open = _detailRqGroupOpen[g.key] !== false;
    const emptyMsg = statusKey === 'review' ? g.emptyReview : g.empty;
    const body = items.length
        ? `<div class="divide-y divide-gray-100">${items.map(render).join('')}</div>`
        : `<p class="text-sm text-gray-400 py-6 text-center">${emptyMsg}</p>`;
    return `<section class="border-b border-gray-100 last:border-0">
      <button onclick="_detailRqToggleGroup('${g.key}')" class="w-full flex items-center gap-2 py-3 text-left cursor-pointer group">
        <svg class="detail-rq-group-chevron-${g.key} w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
        <span class="text-sm font-bold text-gray-900 group-hover:text-emerald-700">${g.label}</span>
        <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">${items.length}</span>
      </button>
      <div class="detail-rq-group-body-${g.key} ${open ? '' : 'hidden'} pb-1">${body}</div>
    </section>`;
}

// ── Records-backed Review Queue (data-hub roles) ─────────────────────────────
// The human-in-the-loop gate for Leads / Ledger / Tickets / … : assistant_records enter
// approval_status='pending_approval' and surface here for the user to Approve, Approve &
// Schedule, or Reject before anything acts on them. Lifecycle columns map to approval states.
const _RQ_RECORD_STATE = { review: 'pending_approval', approved: 'approved', scheduled: 'scheduled', posted: null, archived: 'rejected' };

// Default chase reminder for an approved lead: 3 days out at 09:00 local, nudged off weekends.
function _rqChaseDate() {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    d.setHours(9, 0, 0, 0);
    if (d.getDay() === 6) d.setDate(d.getDate() + 2);      // Sat → Mon
    else if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sun → Mon
    return d;
}

function _rqEsc(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _rqRecordSnippet(r) {
    const d = r.data || {};
    return d.summary || d.rationale || d.reason || (d.outreachDraft && d.outreachDraft.body) || d.draftReply || d.meetingSummary || '';
}

function _rqRecordActions(r, statusKey) {
    const secondary = 'px-3 py-1.5 text-xs font-bold rounded-lg bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 transition cursor-pointer';
    const primary = 'px-3 py-1.5 text-xs font-bold rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white transition cursor-pointer';
    const btn = (label, act, cls) => `<button type="button" onclick="_detailRqRecordAct(this,'${act}')" class="${cls}">${label}</button>`;
    const reject = `<button type="button" onclick="_detailRqRecordAct(this,'reject')" class="px-3 py-1.5 text-xs font-bold rounded-lg bg-white border border-gray-200 text-red-600 hover:border-red-300 hover:bg-red-50 transition cursor-pointer ml-auto">Reject</button>`;
    // Leads follow a simpler lifecycle than posts: Approve just accepts the lead (no "Approve &
    // Schedule"). The chase reminder (a scheduled_for that surfaces on the Calendar) is set later,
    // once the first outreach has gone out — via "Mark outreach sent" in the Approved column.
    const isLead = r.recordType === 'lead';
    let buttons = '';
    if (statusKey === 'review') {
        buttons = isLead
            ? btn('Approve', 'approve', primary) + reject
            : btn('Approve', 'approve', primary) + btn('Approve &amp; Schedule', 'showSchedule', secondary) + reject;
    } else if (statusKey === 'approved') {
        buttons = isLead
            ? btn('Mark outreach sent', 'outreachSent', primary) + btn('Send back to review', 'review', secondary)
            : btn('Schedule', 'showSchedule', primary) + btn('Send back to review', 'review', secondary);
    } else if (statusKey === 'scheduled') {
        buttons = btn(isLead ? 'Clear chase reminder' : 'Unschedule', 'unschedule', secondary);
    } else if (statusKey === 'archived') {
        buttons = btn('Restore to review', 'review', secondary);
    }
    return `<div class="flex flex-wrap items-center gap-2 mt-3">
        ${buttons}
        <div class="rq-sched-row hidden w-full flex items-center gap-2 mt-2">
          <input type="datetime-local" class="rq-sched-input border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500">
          <button type="button" onclick="_detailRqRecordAct(this,'schedule')" class="px-3 py-1.5 text-xs font-bold rounded-lg bg-yellow-500 hover:bg-yellow-600 text-white cursor-pointer">Confirm schedule</button>
        </div>
        <p class="rq-rec-err hidden w-full text-xs font-semibold text-red-600 mt-1"></p>
    </div>`;
}

// Meeting Note Taker Phase 3 (step 5) — surface the per-task PM-sync ledger on the Inbox card.
// The action_items sync state (attached to meeting records by assistant-records GET) becomes a
// "N of M synced" summary chip + one ✓/⚠ pill per action item, so a partial Jira/Asana sync is
// visible at a glance. Returns { summary, pills } as HTML strings (both '' when no ledger yet).
function _rqMeetingSync(r) {
    const s = r && r.actionItemSync;
    if (!s || !s.total) return { summary: '', pills: '' };
    const summaryCls = s.failed
        ? 'bg-red-50 text-red-700 border-red-200'
        : s.synced === s.total
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : 'bg-gray-100 text-gray-600 border-gray-200';
    const summary = `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full border ${summaryCls}">${s.synced} of ${s.total} synced${s.failed ? ` · ${s.failed} failed` : ''}</span>`;
    const pills = s.items.map((it) => {
        const st = it.syncStatus;
        const icon = st === 'synced' ? '✓' : st === 'failed' ? '⚠' : st === 'skipped' ? '–' : '⋯';
        const cls = st === 'synced' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : st === 'failed' ? 'bg-red-50 text-red-700 border-red-200'
            : 'bg-gray-50 text-gray-500 border-gray-200';
        const desc = String(it.description || '');
        const label = _rqEsc(desc.length > 44 ? desc.slice(0, 44) + '…' : desc);
        // Tooltip: the failure reason, otherwise the provider it (would) land in.
        const tip = st === 'failed' && it.errorMessage ? `Failed: ${it.errorMessage}`
            : st === 'skipped' ? 'No task tool connected yet'
            : st === 'pending' ? 'Queued to sync'
            : it.provider ? `Synced to ${it.provider}` : '';
        const inner = `<span class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${cls}"${tip ? ` title="${_rqEsc(tip)}"` : ''}>${icon} ${label}</span>`;
        return it.externalUrl ? `<a href="${_rqEsc(it.externalUrl)}" target="_blank" rel="noopener">${inner}</a>` : inner;
    }).join('');
    return { summary, pills: `<div class="flex flex-wrap gap-1 mt-2">${pills}</div>` };
}

function _detailRqRecordCard(r, statusKey) {
    const snippet = _rqRecordSnippet(r);
    const schedVerb = r.recordType === 'lead' ? 'chase by' : 'scheduled';
    const sched = r.scheduledFor ? ` · ${schedVerb} ${new Date(r.scheduledFor).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
    const sync = r.recordType === 'meeting' ? _rqMeetingSync(r) : { summary: '', pills: '' };
    return `<div class="py-4" data-rq-record="${r.id}">
      <div class="min-w-0">
        <p class="text-sm font-bold text-gray-900 truncate">${_rqEsc(r.title)}</p>
        ${snippet ? `<p class="text-xs text-gray-500 mt-0.5 line-clamp-2">${_rqEsc(snippet)}</p>` : ''}
        <div class="flex flex-wrap items-center gap-2 mt-2">
          ${r.status ? `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">${_rqEsc(r.status)}</span>` : ''}
          ${sync.summary}
          ${sched ? `<span class="text-[11px] font-semibold text-yellow-700">${_rqEsc(sched)}</span>` : ''}
        </div>
        ${sync.pills}
      </div>
      ${_rqRecordActions(r, statusKey)}
    </div>`;
}

async function _detailRqRenderRecords(statusKey) {
    const container = document.getElementById('detail-rq-groups');
    if (!container) return;
    const rq = window._detailReviewQueue || {};
    const recordType = rq.recordType;
    const approval = _RQ_RECORD_STATE[statusKey];
    const aid = window._currentAssistantId;

    container.innerHTML = '<p class="text-sm text-gray-400 py-10 text-center">Loading…</p>';
    if (!aid || !recordType) { container.innerHTML = '<p class="text-sm text-red-500 py-10 text-center">No assistant selected.</p>'; return; }
    if (approval === null) { container.innerHTML = '<p class="text-sm text-gray-400 py-10 text-center">These records don’t have a published state — see the Approved and Scheduled columns.</p>'; return; }

    let records = [];
    try {
        const res = await fetch(`/.netlify/functions/assistant-records?assistantId=${aid}&recordType=${encodeURIComponent(recordType)}&approvalStatus=${approval}`);
        if (!res.ok) throw new Error();
        records = (await res.json()).records || [];
    } catch { container.innerHTML = '<p class="text-sm text-red-500 py-10 text-center">Failed to load.</p>'; return; }

    // Keep the Review column badge + tab badge + Overview shortcut in sync.
    if (statusKey === 'review') {
        const colBadge = document.getElementById('detail-rq-col-count-review');
        if (colBadge) { colBadge.textContent = records.length || ''; colBadge.classList.toggle('hidden', !records.length); }
        const tabBadge = document.getElementById('detail-rq-pending-badge');
        if (tabBadge) { tabBadge.textContent = records.length || ''; tabBadge.classList.toggle('hidden', !records.length); }
        window._setReviewPendingBadge?.(records.length);
        window._updateOpSignals?.({ pendingReview: records.length });
    }

    container.innerHTML = records.length
        ? `<div class="divide-y divide-gray-100">${records.map((r) => _detailRqRecordCard(r, statusKey)).join('')}</div>`
        : `<p class="text-sm text-gray-400 py-10 text-center">${statusKey === 'review' ? 'Nothing awaiting your review.' : 'Nothing here yet.'}</p>`;
}

// Approve / reject / schedule a record from the Review Queue (PATCH assistant-records).
window._detailRqRecordAct = async function (btn, action) {
    const card = btn.closest('[data-rq-record]');
    if (!card) return;
    const errEl = card.querySelector('.rq-rec-err');
    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };
    if (errEl) errEl.classList.add('hidden');

    if (action === 'showSchedule') { card.querySelector('.rq-sched-row')?.classList.remove('hidden'); return; }

    const patch = { id: Number(card.getAttribute('data-rq-record')) };
    let chaseWhen = null;
    if (action === 'approve') patch.approvalStatus = 'approved';
    else if (action === 'outreachSent') {
        // First outreach has gone out → move the approved lead to a chase reminder (default 3
        // days out, 09:00) that lands on the Calendar.
        chaseWhen = _rqChaseDate();
        patch.approvalStatus = 'scheduled';
        patch.scheduledFor = chaseWhen.toISOString();
    }
    else if (action === 'reject') patch.approvalStatus = 'rejected';
    else if (action === 'review') patch.approvalStatus = 'pending_approval';
    else if (action === 'unschedule') patch.approvalStatus = 'approved';
    else if (action === 'schedule') {
        const val = card.querySelector('.rq-sched-input')?.value;
        if (!val) { showErr('Pick a date and time first.'); return; }
        patch.approvalStatus = 'scheduled';
        patch.scheduledFor = new Date(val).toISOString();
    } else { return; }

    const buttons = card.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    try {
        const res = await fetch('/.netlify/functions/assistant-records', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Update failed.');

        // Auto-send: when a LEAD is approved and the assistant has an email provider connected,
        // send its outreach email. The backend returns { sent, reason } and, on send, moves the
        // record to scheduled + chase reminder — so we just translate the outcome into a toast.
        if (action === 'approve' && (window._detailReviewQueue || {}).recordType === 'lead') {
            let toast = 'Lead approved.';
            try {
                const sres = await fetch('/.netlify/functions/lead-generation', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'send_outreach', assistantId: window._currentAssistantId, recordId: patch.id }),
                });
                const sdata = await sres.json().catch(() => ({}));
                if (sres.ok && sdata.sent) {
                    const d = sdata.chaseDate ? new Date(sdata.chaseDate) : null;
                    toast = `Outreach emailed to ${sdata.to} — chase reminder set${d ? ` for ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}` : ''}. See the Calendar.`;
                } else if (sres.ok && sdata.reason === 'not_connected') {
                    toast = 'Lead approved. Connect your Google account (Integrations) to auto-send outreach.';
                } else if (sres.ok && sdata.reason === 'microsoft_coming_soon') {
                    toast = 'Lead approved. Microsoft email sending is coming soon — use “Mark outreach sent” for now.';
                } else if (sres.ok && sdata.reason === 'no_recipient') {
                    toast = 'Lead approved — no email address on this lead, so nothing was sent.';
                }
                // reason 'no_provider' (user chose manual outreach) keeps the plain "Lead approved." toast.
            } catch { /* network issue on send — the lead is still approved; keep the plain toast */ }
            window.showToast?.(toast);
        } else {
            const toast = action === 'outreachSent'
                ? `First outreach logged — chase reminder set for ${chaseWhen.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}. See the Calendar.`
                : action === 'schedule' ? 'Scheduled — it’s on the Calendar now.'
                : action === 'reject' ? 'Rejected.' : 'Updated.';
            window.showToast?.(toast);
        }
        _detailRqRenderGroups(_detailRqCurrentStatus);
        // A newly scheduled/approved record changes the Calendar + Data Hub — force them to reload
        // next time they're opened (both are cached once per detail mount).
        const calHost = document.getElementById('assistant-calendar-host');
        if (calHost) calHost.dataset.ready = '';
    } catch (e) {
        buttons.forEach((b) => { b.disabled = false; });
        showErr(e.message || 'Something went wrong.');
    }
};

// ── Blog Writer Review Queue (kind 'posts', source 'blog_posts') ─────────────
// Long-form drafts (blog_posts). Review/editing happens in Blog Studio, so the queue lists
// drafts per lifecycle column and routes into the studio; scheduling uses schedule-blog.ts.
// Autonomous + manual drafts default to 'draft'; there's no rejected/archived blog state.
const _RQ_BLOG_STATUS = {
    review: ['draft', 'pending_approval', 'in_review'],
    approved: ['approved'],
    scheduled: ['scheduled'],
    posted: ['published'],
    archived: [],
};

function _rqBlogActions(p, statusKey) {
    const primary = 'px-3 py-1.5 text-xs font-bold rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white transition cursor-pointer';
    const secondary = 'px-3 py-1.5 text-xs font-bold rounded-lg bg-white border border-gray-200 text-gray-700 hover:border-emerald-300 hover:text-emerald-800 transition cursor-pointer';
    const open = `<button type="button" onclick="_detailRqBlogAct(this,'open')" class="${statusKey === 'review' ? primary : secondary}">Open in Blog Studio</button>`;
    let extra = '';
    if (statusKey === 'review' || statusKey === 'approved') extra = `<button type="button" onclick="_detailRqBlogAct(this,'showSchedule')" class="${secondary}">Schedule</button>`;
    else if (statusKey === 'scheduled') extra = `<button type="button" onclick="_detailRqBlogAct(this,'unschedule')" class="${secondary}">Unschedule</button>`;
    return `<div class="flex flex-wrap items-center gap-2 mt-3">
        ${open}${extra}
        <div class="rq-sched-row hidden w-full flex items-center gap-2 mt-2">
          <input type="datetime-local" class="rq-sched-input border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500">
          <button type="button" onclick="_detailRqBlogAct(this,'schedule')" class="px-3 py-1.5 text-xs font-bold rounded-lg bg-yellow-500 hover:bg-yellow-600 text-white cursor-pointer">Confirm schedule</button>
        </div>
        <p class="rq-rec-err hidden w-full text-xs font-semibold text-red-600 mt-1"></p>
    </div>`;
}

function _detailRqBlogCard(p, statusKey) {
    const when = p.publishDate
        ? `scheduled ${new Date(p.publishDate).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
        : (p.updatedAt ? `updated ${new Date(p.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : '');
    return `<div class="py-4" data-rq-blog="${p.id}">
      <div class="min-w-0">
        <p class="text-sm font-bold text-gray-900 truncate">${_rqEsc(p.title || '(untitled draft)')}</p>
        <div class="flex items-center gap-2 mt-2">
          <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">${_rqEsc(p.status)}</span>
          ${when ? `<span class="text-[11px] font-semibold text-gray-400">${_rqEsc(when)}</span>` : ''}
        </div>
      </div>
      ${_rqBlogActions(p, statusKey)}
    </div>`;
}

async function _detailRqRenderBlog(statusKey) {
    const container = document.getElementById('detail-rq-groups');
    if (!container) return;
    const aid = window._currentAssistantId;
    const wanted = _RQ_BLOG_STATUS[statusKey] || [];

    container.innerHTML = '<p class="text-sm text-gray-400 py-10 text-center">Loading…</p>';
    if (!aid) { container.innerHTML = '<p class="text-sm text-red-500 py-10 text-center">No assistant selected.</p>'; return; }
    if (!wanted.length) { container.innerHTML = '<p class="text-sm text-gray-400 py-10 text-center">Blog posts don’t have this state.</p>'; return; }

    let posts = [];
    try {
        const res = await fetch(`/.netlify/functions/blog-posts?assistantId=${aid}`);
        if (!res.ok) throw new Error();
        posts = ((await res.json()).posts || []).filter((p) => wanted.includes(p.status));
    } catch { container.innerHTML = '<p class="text-sm text-red-500 py-10 text-center">Failed to load.</p>'; return; }

    if (statusKey === 'review') {
        const colBadge = document.getElementById('detail-rq-col-count-review');
        if (colBadge) { colBadge.textContent = posts.length || ''; colBadge.classList.toggle('hidden', !posts.length); }
        const tabBadge = document.getElementById('detail-rq-pending-badge');
        if (tabBadge) { tabBadge.textContent = posts.length || ''; tabBadge.classList.toggle('hidden', !posts.length); }
        window._setReviewPendingBadge?.(posts.length);
        window._updateOpSignals?.({ pendingReview: posts.length });
    }

    container.innerHTML = posts.length
        ? `<div class="divide-y divide-gray-100">${posts.map((p) => _detailRqBlogCard(p, statusKey)).join('')}</div>`
        : `<p class="text-sm text-gray-400 py-10 text-center">${statusKey === 'review' ? 'No blog drafts awaiting review.' : 'Nothing here yet.'}</p>`;
}

// Open in Blog Studio / schedule / unschedule a blog draft from the Review Queue.
window._detailRqBlogAct = async function (btn, action) {
    const card = btn.closest('[data-rq-blog]');
    if (!card) return;
    const id = Number(card.getAttribute('data-rq-blog'));
    const errEl = card.querySelector('.rq-rec-err');
    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };
    if (errEl) errEl.classList.add('hidden');

    if (action === 'open') { window.openBlogStudio?.({ assistantId: window._currentAssistantId, postId: id }); return; }
    if (action === 'showSchedule') { card.querySelector('.rq-sched-row')?.classList.remove('hidden'); return; }

    let payload;
    if (action === 'unschedule') payload = { id, action: 'unschedule' };
    else if (action === 'schedule') {
        const val = card.querySelector('.rq-sched-input')?.value;
        if (!val) { showErr('Pick a date and time first.'); return; }
        payload = { id, publishDate: new Date(val).toISOString() };
    } else { return; }

    const buttons = card.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    try {
        const res = await fetch('/.netlify/functions/schedule-blog', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Update failed.');
        window.showToast?.(action === 'schedule' ? 'Scheduled — it’s on the Calendar now.' : 'Unscheduled.');
        _detailRqRenderGroups(_detailRqCurrentStatus);
        const calHost = document.getElementById('assistant-calendar-host');
        if (calHost) calHost.dataset.ready = '';
    } catch (e) {
        buttons.forEach((b) => { b.disabled = false; });
        showErr(e.message || 'Something went wrong.');
    }
};

window._detailRqToggleGroup = function(key) {
    const wasOpen = _detailRqGroupOpen[key] !== false;
    _detailRqGroupOpen[key] = !wasOpen;
    const body = document.querySelector('.detail-rq-group-body-' + key);
    const chev = document.querySelector('.detail-rq-group-chevron-' + key);
    if (body) body.classList.toggle('hidden', wasOpen);
    if (chev) chev.classList.toggle('rotate-90', !wasOpen);
};

// ── Right-hand persona / config slide-over (Epic 1) ───────────────────────────
// The drawer has a "home" panel (#tab-profile-home: onboarding answers + Operating
// File card index) and one panel per section (#tab-problem, #tab-operation, …).
// _openProfileDrawer lands on home; clicking a card calls _openBriefDrawer(section),
// which swaps panels in place and reveals a back arrow. It is reached from the header
// "Assistant Profile" button — there is no longer a setup tab in the main nav.

// Show exactly one drawer panel by element id (CSS hides all .detail-tab-content
// unless they carry .active-drawer-tab while the drawer is open).
function _briefShowPanel(panelId) {
    document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.remove('active-drawer-tab'));
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('active-drawer-tab');
}

// Run the open animation/backdrop/scroll-lock. Idempotent: safe to call when the
// drawer is already open (so cards can swap panels without re-triggering anything odd).
function _briefOpenChrome() {
    const drawer = document.getElementById('brief-drawer');
    const backdrop = document.getElementById('brief-drawer-backdrop');
    if (!drawer) return;
    document.body.classList.add('brief-drawer-open');
    if (backdrop) { backdrop.style.display = 'block'; setTimeout(() => backdrop.style.opacity = '1', 10); }
    drawer.style.transform = 'translateX(0)';
    document.body.style.overflow = 'hidden';
    const body = document.getElementById('brief-drawer-body');
    if (body) body.scrollTop = 0;
    _resizeBriefAutoGrow();
}

// Entry point from the header — opens the drawer to the profile "home" card index.
window._openProfileDrawer = function() {
    _briefShowPanel('tab-profile-home');
    const titleEl = document.getElementById('brief-drawer-title');
    if (titleEl) titleEl.textContent = window._assistantProfileTitle || 'Assistant Profile';
    const backBtn = document.getElementById('brief-drawer-back');
    if (backBtn) backBtn.hidden = true;
    _briefOpenChrome();
};

// Open (or swap to) a specific section panel, with a back arrow to the home index.
window._openBriefDrawer = function(tabKey) {
    _briefShowPanel('tab-' + tabKey);
    const titles = { problem: 'Mandate', operation: 'Operational Setup', strategy: 'Creative Brief', platforms: 'Connections', rules: 'Rules', guardrails: 'Brand Safety & Legal', notifications: 'Notifications' };
    const titleEl = document.getElementById('brief-drawer-title');
    if (titleEl) titleEl.textContent = titles[tabKey] || tabKey;
    const backBtn = document.getElementById('brief-drawer-back');
    if (backBtn) backBtn.hidden = false;
    if (tabKey === 'notifications') _initAssistantNotifPrefs();
    // Re-read the assistant's synced-action recipes each time the Connections tab opens, so a
    // just-connected provider or a recipe enabled in the hub reflects here without a reload.
    if (tabKey === 'platforms') window.AssistantIntegrations?.refresh();
    // Learned Directives lives alongside Assistant Rules on this panel (issue #113, moved into
    // its own Rules section in issue #125) — refresh it whenever the panel is opened, same as
    // the rules editor.
    if (tabKey === 'rules') window._renderRunbookDirectives?.();
    _briefOpenChrome();
};

// ── Assistant Profile › Notifications panel ───────────────────────────────────
// Renders the scope:'assistant' categories of the unified notification preference
// matrix (Approvals, Assistant Tasks, Content & Publishing, Connections) for THIS
// assistant. Values come from /notification-preferences?assistantId=N — the
// workspace-wide setting overlaid with this assistant's per-user overrides.
// Toggling writes an override for this assistant only; "Reset" restores the
// workspace default. Also hosts the review-alert cadence (set-review-notif-prefs).
let _assistantNotifPrefsLoadedFor = null;
async function _initAssistantNotifPrefs() {
    const assistantId = Number(window._currentAssistantId);
    if (_assistantNotifPrefsLoadedFor === assistantId) return;
    const loadingEl = document.getElementById('assistant-notif-prefs-loading');
    const listEl = document.getElementById('assistant-notif-prefs-list');
    if (!listEl || !assistantId) return;

    const paintToggle = (btn, on) => {
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.classList.toggle('bg-emerald-500', on);
        btn.classList.toggle('bg-gray-300', !on);
        const dot = btn.querySelector('span');
        if (dot) { dot.classList.toggle('translate-x-5', on); dot.classList.toggle('translate-x-0', !on); }
    };

    const flashSaved = () => {
        const saved = document.getElementById('assistant-notif-prefs-saved');
        if (saved) { saved.classList.remove('hidden'); setTimeout(() => saved.classList.add('hidden'), 2500); }
    };

    // A category row is "custom" when either channel carries an override for this assistant.
    const paintRowState = (row, custom) => {
        const badge = row.querySelector('[data-custom-badge]');
        const reset = row.querySelector('[data-reset-cat]');
        if (badge) badge.classList.toggle('hidden', !custom);
        if (reset) reset.classList.toggle('hidden', !custom);
    };

    try {
        const res = await fetch(`/.netlify/functions/notification-preferences?assistantId=${assistantId}`);
        if (!res.ok) throw new Error('Load failed');
        const { categories } = await res.json();
        // Role-aware: post/publishing alerts only apply to roles that actually publish
        // content. Non-social roles (Lead Generator, AR Clerk, Support, …) never draft or
        // publish posts, so the registry hides "Content & Publishing" for them — mirroring
        // how the Review-alert cadence card is gated in _applyDashboardRegistry.
        const registry = window.AssistantDashboardRegistry;
        const roleMods = (registry && typeof registry.get === 'function'
            ? registry.get(window._detailCurrentData && window._detailCurrentData.roleKey)
            : null)?.modules || {};
        const hiddenForRole = { content_calendar: roleMods.hasContentPublishing === false };
        const rows = (categories || [])
            .filter(c => c.scope === 'assistant' && !hiddenForRole[c.key]);

        const toggleHtml = (cat, channel, on) => `
            <label class="flex items-center gap-2">
              <span class="text-xs font-semibold text-gray-500">${channel === 'inApp' ? 'In app' : 'Email'}</span>
              <button type="button" data-notif-cat="${cat.key}" data-notif-channel="${channel}"
                class="${on ? 'bg-emerald-500' : 'bg-gray-300'} relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
                role="switch" aria-checked="${on ? 'true' : 'false'}">
                <span aria-hidden="true" class="${on ? 'translate-x-5' : 'translate-x-0'} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"></span>
              </button>
            </label>`;

        listEl.innerHTML = rows.map(cat => {
            const custom = !!(cat.overridden && (cat.overridden.inApp || cat.overridden.email));
            return `
            <div class="py-4 first:pt-0 last:pb-0" data-notif-row="${cat.key}">
              <div class="flex items-center gap-2 flex-wrap">
                <p class="text-sm font-semibold text-gray-900">${cat.label}</p>
                <span data-custom-badge class="${custom ? '' : 'hidden '}text-[10px] font-bold bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200">Custom for this assistant</span>
              </div>
              <p class="text-xs text-gray-400 mt-0.5 leading-snug">${cat.description}</p>
              <div class="flex items-center gap-6 mt-2">
                ${toggleHtml(cat, 'inApp', !!cat.inApp.value)}
                ${toggleHtml(cat, 'email', !!cat.email.value)}
                <button type="button" data-reset-cat="${cat.key}"
                  class="${custom ? '' : 'hidden '}text-xs font-semibold text-gray-400 hover:text-emerald-700 underline decoration-dotted cursor-pointer">Reset to workspace default</button>
              </div>
            </div>`;
        }).join('');

        if (loadingEl) loadingEl.classList.add('hidden');
        listEl.classList.remove('hidden');
        _assistantNotifPrefsLoadedFor = assistantId;

        if (!listEl.dataset.wired) {
            listEl.dataset.wired = '1';
            listEl.addEventListener('click', async (e) => {
                // Reset a category → clear both channel overrides, reload effective values.
                const resetBtn = e.target.closest('button[data-reset-cat]');
                if (resetBtn) {
                    const key = resetBtn.getAttribute('data-reset-cat');
                    try {
                        await Promise.all(['inApp', 'email'].map(channel =>
                            fetch('/.netlify/functions/notification-preferences', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ assistantId: Number(window._currentAssistantId), key, channel, value: null }),
                            })));
                        _assistantNotifPrefsLoadedFor = null;
                        await _initAssistantNotifPrefs();
                        flashSaved();
                    } catch { /* leave panel as-is */ }
                    return;
                }

                const btn = e.target.closest('button[data-notif-channel]');
                if (!btn) return;
                const current = btn.getAttribute('aria-checked') === 'true';
                const next = !current;
                paintToggle(btn, next); // optimistic
                try {
                    const r = await fetch('/.netlify/functions/notification-preferences', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ assistantId: Number(window._currentAssistantId), key: btn.dataset.notifCat, channel: btn.dataset.notifChannel, value: next }),
                    });
                    if (!r.ok) { paintToggle(btn, current); return; }
                    paintRowState(btn.closest('[data-notif-row]'), true);
                    flashSaved();
                } catch { paintToggle(btn, current); }
            });
        }
    } catch {
        if (loadingEl) loadingEl.textContent = 'Could not load preferences. Please refresh.';
    }

    _initReviewCadence();
}

// Review-alert cadence for this assistant (aiAssistants.reviewNotifPreference):
// how urgently to alert when drafted posts are waiting for approval. Read from
// get-assistant-context (stashed on window by initAssistantDetail), saved via
// PATCH set-review-notif-prefs.
function _initReviewCadence() {
    const wrap = document.getElementById('review-cadence-options');
    if (!wrap) return;
    const current = window._reviewNotifPreference || 'immediate';

    wrap.querySelectorAll('input[name="review-cadence"]').forEach(radio => {
        radio.checked = radio.value === current;
        if (radio.dataset.wired) return;
        radio.dataset.wired = '1';
        radio.addEventListener('change', async () => {
            if (!radio.checked) return;
            const previous = window._reviewNotifPreference || 'immediate';
            const statusEl = document.getElementById('review-cadence-status');
            try {
                const r = await fetch('/.netlify/functions/set-review-notif-prefs', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ assistantId: Number(window._currentAssistantId), reviewNotifPreference: radio.value }),
                });
                if (!r.ok) throw new Error('save failed');
                window._reviewNotifPreference = radio.value;
                if (statusEl) {
                    statusEl.textContent = '✓ Cadence saved';
                    statusEl.classList.remove('hidden', 'text-red-600');
                    statusEl.classList.add('text-emerald-600');
                    setTimeout(() => statusEl.classList.add('hidden'), 2500);
                }
            } catch {
                // Snap back to the last saved value
                wrap.querySelectorAll('input[name="review-cadence"]').forEach(rb => { rb.checked = rb.value === previous; });
                if (statusEl) {
                    statusEl.textContent = 'Could not save — please try again.';
                    statusEl.classList.remove('hidden', 'text-emerald-600');
                    statusEl.classList.add('text-red-600');
                }
            }
        });
    });
}

window._closeBriefDrawer = function() {
    window._flushAssistantDetailSave?.();
    const drawer = document.getElementById('brief-drawer');
    const backdrop = document.getElementById('brief-drawer-backdrop');
    if (drawer) drawer.style.transform = 'translateX(100%)';
    if (backdrop) { backdrop.style.opacity = '0'; setTimeout(() => { backdrop.style.display = 'none'; }, 250); }
    document.body.classList.remove('brief-drawer-open');
    document.body.style.overflow = '';
};

// ── Operational status pill (Epic 1 AC1.1.2) ──────────────────────────────────
// The header pill keeps the lifecycle vocabulary for every non-active state
// (Setup in Progress / Paused / Archived …). For an actively *working* assistant it
// refines into an operational sub-state from live signals: a mid-flight job →
// "Executing Task"; else drafts awaiting the user → "Awaiting Human Review"; else
// "Idle". Signals are cached so the pill re-renders as activity/review data lands.
// Badge resolution itself lives in window._resolveAssistantBadge, shared with the
// "My Assistants" list card so the two views can't disagree on an assistant's status.
window._detailOpSignals = { activeJobCount: 0, pendingReview: 0 };

window._renderStatusPill = function(data) {
    data = data || window._detailCurrentData;
    const statusEl = document.getElementById('detail-status');
    if (!statusEl || !data) return;
    const toggleBtn = document.getElementById('btn-toggle-status');

    const p = window._resolveAssistantBadge(data, window._detailOpSignals);

    statusEl.className = `inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold border ${p.cls}`;
    statusEl.innerHTML = `<span class="w-2 h-2 rounded-full ${p.dot}"></span> ${p.label}`;
    if (toggleBtn) toggleBtn.textContent = p.toggle;
};

// Update one or more operational signals and re-render the pill in place.
window._updateOpSignals = function(patch) {
    window._detailOpSignals = { ...window._detailOpSignals, ...patch };
    window._renderStatusPill();
};

// Action bar (Epic 2.1): reflect the pending-review count on the "Review Pending Items"
// button — hidden at 0, amber pill otherwise. Replaces the retired amber strip.
window._setReviewPendingBadge = function(count) {
    const badge = document.getElementById('review-pending-count');
    if (!badge) return;
    badge.textContent = count || '';
    badge.classList.toggle('hidden', !count);
};

// ══ Epic 3 — Continuous Improvement Loop (Tuning Sessions + Runbook) ═══════════

// ── Runbook: Learned Directives changelog (Feature 3.2) ───────────────────────
// Renders content_rules for the current assistant as a chronological, toggleable
// audit trail. Shares the content-rules CRUD with the Guardrails panel; provenance
// (manual / feedback / tuning) is foregrounded here.
const _RUNBOOK_ORIGIN = {
    manual:             ['Manual',        'bg-gray-100 text-gray-600'],
    rejection_feedback: ['From feedback', 'bg-amber-100 text-amber-700'],
    tuning:             ['From tuning',   'bg-indigo-100 text-indigo-700'],
};

window._renderRunbookDirectives = async function(assistantId) {
    const host = document.getElementById('runbook-directives');
    if (!host) return;
    const aid = assistantId || window._currentAssistantId;
    if (!aid) return;
    let rules = [];
    try {
        const res = await fetch(`/.netlify/functions/content-rules?assistantId=${aid}`);
        if (res.ok) rules = (await res.json()).rules || [];
    } catch { /* non-critical */ }
    rules.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    if (!rules.length) {
        host.innerHTML = '<p class="text-sm text-gray-400 text-center py-6">No directives yet. Start a Tuning Session to teach your assistant its first rule.</p>';
        return;
    }
    host.innerHTML = rules.map(r => {
        const active = r.isActive !== false;
        const o = _RUNBOOK_ORIGIN[r.origin] || _RUNBOOK_ORIGIN.manual;
        const when = r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        const cap = r.originPost && r.originPost.caption ? String(r.originPost.caption) : '';
        const originPost = cap ? `<p class="text-xs text-gray-400 mt-1 italic">from post: “${_escapeHtml(cap.slice(0, 80))}${cap.length > 80 ? '…' : ''}”</p>` : '';
        return `<div class="flex items-start gap-3 px-3 py-3 rounded-xl border border-gray-100 ${active ? '' : 'bg-gray-50'}" data-rule-id="${r.id}">
            <div class="flex-1 min-w-0">
                <p class="text-sm ${active ? 'text-gray-800' : 'text-gray-400 line-through'}">${_escapeHtml(r.ruleText || '')}</p>
                <div class="flex items-center gap-2 mt-1">
                    <span class="px-2 py-0.5 rounded-full text-xs font-bold ${o[1]}">${o[0]}</span>
                    <span class="text-xs text-gray-400">${when}</span>
                </div>
                ${originPost}
            </div>
            <button type="button" aria-checked="${active}" onclick="window._toggleDirective(${r.id}, this)" class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors mt-0.5 ${active ? 'bg-emerald-500' : 'bg-gray-300'}">
                <span class="${active ? 'translate-x-5' : 'translate-x-0'} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition"></span>
            </button>
            <button type="button" onclick="window._deleteDirective(${r.id})" class="text-gray-400 hover:text-red-500 transition mt-1" aria-label="Delete directive">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
        </div>`;
    }).join('');
};

window._toggleDirective = async function(id, btn) {
    const nowActive = btn.getAttribute('aria-checked') !== 'true';
    try {
        await fetch('/.netlify/functions/content-rules', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, isActive: nowActive }) });
    } catch { /* non-critical */ }
    window._renderRunbookDirectives();
};

window._deleteDirective = async function(id) {
    if (!confirm('Delete this directive? Your assistant will no longer follow it.')) return;
    try { await fetch(`/.netlify/functions/content-rules?id=${id}`, { method: 'DELETE' }); } catch { /* non-critical */ }
    window._renderRunbookDirectives();
};

// ── Tuning Session (Feature 3.1) — correct an output → learned directive ──────
let _tuningCtx = null;

window._openTuningSession = async function(ctx) {
    ctx = ctx || {};
    _tuningCtx = { postId: ctx.postId || null, output: ctx.output || '', meta: ctx.meta || '', platform: ctx.platform || null };
    const modal = document.getElementById('modal-tuning');
    if (!modal) return;
    const outEl = document.getElementById('tuning-output');
    const metaEl = document.getElementById('tuning-output-meta');
    const corr = document.getElementById('tuning-correction');
    // Reset to the "collect correction" state.
    document.getElementById('tuning-result').classList.add('hidden');
    document.getElementById('tuning-error').classList.add('hidden');
    document.getElementById('tuning-submit-btn').classList.remove('hidden');
    document.getElementById('tuning-cancel-btn').classList.remove('hidden');
    document.getElementById('tuning-revise-btn').classList.add('hidden');
    document.getElementById('tuning-done-btn').classList.add('hidden');
    if (corr) { corr.value = ''; corr.disabled = false; }
    if (outEl) outEl.textContent = _tuningCtx.output || 'Loading…';
    if (metaEl) metaEl.textContent = _tuningCtx.meta || '';
    modal.classList.remove('hidden');
    // Seed the output caption when only a postId was supplied (e.g. from an activity row).
    if (!_tuningCtx.output && _tuningCtx.postId) {
        try {
            const res = await fetch(`/.netlify/functions/scheduled-posts?id=${_tuningCtx.postId}`);
            if (res.ok) {
                const { post } = await res.json();
                if (post) {
                    _tuningCtx.output = post.caption || '(No caption)';
                    _tuningCtx.platform = _tuningCtx.platform || post.platform || null;
                    if (outEl) outEl.textContent = _tuningCtx.output;
                    if (metaEl) metaEl.textContent = [post.platform, post.publishDate ? new Date(post.publishDate).toLocaleDateString('en-GB') : ''].filter(Boolean).join(' · ');
                }
            } else if (outEl) outEl.textContent = '(Could not load the post.)';
        } catch { if (outEl) outEl.textContent = '(Could not load the post.)'; }
    }
    corr?.focus();
};

window._closeTuningSession = function() {
    document.getElementById('modal-tuning')?.classList.add('hidden');
    _tuningCtx = null;
};

window._submitTuning = async function() {
    if (!_tuningCtx) return;
    const corr = document.getElementById('tuning-correction');
    const errEl = document.getElementById('tuning-error');
    const text = (corr?.value || '').trim();
    errEl.classList.add('hidden');
    if (!text) { errEl.textContent = 'Tell your assistant what should be different.'; errEl.classList.remove('hidden'); return; }
    const submitBtn = document.getElementById('tuning-submit-btn');
    submitBtn.disabled = true; submitBtn.textContent = 'Working…';
    try {
        const res = await fetch('/.netlify/functions/tune-assistant', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistantId: window._currentAssistantId, postId: _tuningCtx.postId, output: _tuningCtx.output, correction: text, platform: _tuningCtx.platform }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Failed to save the directive.'); }
        const { directive } = await res.json();
        document.getElementById('tuning-directive').textContent = directive;
        document.getElementById('tuning-result').classList.remove('hidden');
        if (corr) corr.disabled = true;
        submitBtn.classList.add('hidden');
        document.getElementById('tuning-cancel-btn').classList.add('hidden');
        document.getElementById('tuning-revise-btn').classList.toggle('hidden', !_tuningCtx.postId);
        document.getElementById('tuning-done-btn').classList.remove('hidden');
        window._renderRunbookDirectives();
        window.showToast?.('Directive added to Progress Reviews.');
    } catch (e) {
        errEl.textContent = e.message || 'Something went wrong.'; errEl.classList.remove('hidden');
    } finally {
        submitBtn.disabled = false; submitBtn.textContent = 'Submit correction';
    }
};

window._tuningRevisePost = async function() {
    if (!_tuningCtx?.postId) { window._closeTuningSession(); return; }
    const correction = (document.getElementById('tuning-correction')?.value || '').trim();
    const btn = document.getElementById('tuning-revise-btn');
    btn.disabled = true; btn.textContent = 'Revising…';
    try {
        await fetch('/.netlify/functions/reject-post', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId: _tuningCtx.postId, feedbackText: correction, applyAsRule: false }),
        });
        window.showToast?.('Revised draft on the way — check your Review.');
    } catch { /* non-critical */ }
    window._closeTuningSession();
};

// ── Active Workflows dependency map (Epic 4.2) ────────────────────────────────
// Orchestrations has no runtime consumer yet (see netlify/functions/orchestrations.ts),
// so this card is disabled and just shows a "Coming soon" state (issue #147) instead of
// fetching/rendering real orchestration_links or linking into the Orchestrations hub.

window._renderActiveWorkflows = function(assistantId) {
    const card = document.getElementById('active-workflows-card');
    if (!card) return;
    const aid = Number(assistantId || window._currentAssistantId);
    if (!aid) return;
    card.classList.remove('hidden');
};

// Action-bar / Runbook entry: pick a recent post to tune (each row seeds a session by id).
window._openTuningPicker = async function() {
    const modal = document.getElementById('modal-tuning-picker');
    const list = document.getElementById('tuning-picker-list');
    if (!modal || !list) return;
    list.innerHTML = '<div class="h-10 bg-gray-50 rounded-lg border border-dashed border-gray-200 flex items-center justify-center text-sm text-gray-400">Loading recent posts…</div>';
    modal.classList.remove('hidden');
    let drafts = [];
    try {
        const res = await fetch(`/.netlify/functions/get-social-drafts?status=pending_approval&assistantId=${window._currentAssistantId}`);
        if (res.ok) drafts = (await res.json()).drafts || [];
    } catch { /* non-critical */ }
    if (!drafts.length) {
        list.innerHTML = '<p class="text-sm text-gray-400 text-center py-6">No recent posts to tune. Posts appear here once your assistant drafts them.</p>';
        return;
    }
    list.innerHTML = drafts.slice(0, 15).map(d => `
        <button type="button" onclick="document.getElementById('modal-tuning-picker').classList.add('hidden'); window._openTuningSession({ postId:${Number(d.id)} })"
            class="w-full text-left px-4 py-3 rounded-xl border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50/40 transition cursor-pointer">
            <p class="text-xs text-gray-400 mb-0.5">${_escapeHtml(d.platform || '')}</p>
            <p class="text-sm text-gray-800">${_escapeHtml(String(d.caption || '(No caption)').slice(0, 120))}</p>
        </button>`).join('');
};

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('brief-drawer-open')) {
        window._closeBriefDrawer();
    }
});

if (!window._detailTabsDelegated) {
    window._detailTabsDelegated = true;
    document.addEventListener('click', (e) => {
        // Main-level tabs
        const mainBtn = e.target.closest('.main-tab-btn');
        if (mainBtn) { window._activateMainTab(mainBtn.dataset.maintab); return; }

        // Child-level (Operating File) cards — swap to that section inside the open drawer.
        const btn = e.target.closest('.detail-tab-btn');
        if (!btn) return;
        window._openBriefDrawer(btn.dataset.tab);
    });
}


// Read-only "Your Onboarding Answers" summary — the single place every answer the user gave
// during onboarding is visible on the detail page, regardless of which editable fields are
// wired below (e.g. Trigger/Content Source are captured as label strings the radios can't bind).
// Sourced from the structured onboardingContext (data.context) + configuration.inputs.
//
// Schema-driven roles: ALL of the role's onboarding fields are folded in here as a read-only
// reminder. Editing them happens in the relevant profile sub-section (Operational Setup —
// see _renderOperationSection) rather than in a second copy on this home tab (see issue #169).
function _renderOnboardingSummary(data) {
    const host = document.getElementById('onboarding-summary');
    if (!host) return;
    const ctx = (data && data.context && typeof data.context === 'object') ? data.context : {};
    const inputs = (data && data.configuration && data.configuration.inputs) || {};
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const MISSING = '⚠️ [MISSING - PLEASE UPDATE]';
    const clean = (v) => (v === null || v === undefined) ? '' : String(v).trim();

    // Roles onboarded via the schema wizard capture Trigger/Content Source under their own
    // schema fields (surfaced by schemaRows below), so drop the legacy inputs-based rows for
    // them to avoid showing each answer twice.
    const schemaFields = _roleSchemaFields(data && data.roleKey);
    const hasSchemaOperational = schemaFields.length > 0;

    const objectiveLabels = { brand_awareness: 'Brand Awareness', lead_generation: 'Lead Generation', direct_sales: 'Direct Sales', community_engagement: 'Community & Engagement' };
    const objective = clean(ctx.primary_objective || inputs.primary_objective);
    const platforms = (Array.isArray(ctx.primary_platforms) && ctx.primary_platforms.length)
        ? ctx.primary_platforms
        : (Array.isArray(inputs.platforms) ? inputs.platforms : []);

    const rows = [
        ['Your Bottleneck', clean(ctx.problem_statement || inputs.problem)],
        ['Primary Objective', objective ? (objectiveLabels[objective] || objective) : ''],
        ['Core Message', clean(ctx.core_message || inputs.core_message)],
        ['Primary CTA', clean(ctx.cta || inputs.cta)],
        ['Incentive', clean(ctx.incentive || inputs.incentive)],
        ['Target Audience', clean(ctx.target_audience)],
        ['Content Pillars', Array.isArray(ctx.content_pillars) ? ctx.content_pillars.join(', ') : clean(ctx.content_pillars)],
        ['Tone of Voice', clean(ctx.tone_of_voice)],
        ['Posting Frequency', clean(ctx.posting_frequency)],
        ['Platforms', platforms.map(clean).filter(Boolean).join(', ')],
        ...(hasSchemaOperational ? [] : [
            ['Trigger', clean(inputs.triggerText)],
            ['Content Source', clean(inputs.sourceText)],
        ]),
    ].filter(([, v]) => v && v !== MISSING);

    // Answers captured by the schema wizard (assistant-setup.html) live in onboardingContext
    // under the schema's own keys — surface them via the role's AssistantOnboardingSchemas
    // entry so non-social roles aren't shown as "no answers". They're editable in the
    // Operational Setup profile sub-section (_renderOperationSection), not here.
    const schemaRows = schemaFields
        .map(f => [f.label || f.key, _formatSchemaAnswer(f, ctx[f.key])])
        .filter(([, v]) => v !== '');
    rows.unshift(...schemaRows);

    // Knowledge base + guardrail rules (strictRules) — strip the leading "- " bullet prefix.
    const rules = (Array.isArray(inputs.strictRules) ? inputs.strictRules : [])
        .map(r => clean(r).replace(/^-\s*/, '')).filter(Boolean);

    if (!rows.length && !rules.length) {
        // Still surface the supported tools (Connections) even when no free-text answers
        // were captured — the block is filled by _renderOnboardingConnections post-load.
        host.innerHTML = '<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6"><p class="text-sm text-gray-500">No onboarding answers were captured for this assistant.</p><div id="onboarding-connections-block"></div></div>';
        return;
    }

    const fieldCount = rows.length + (rules.length ? 1 : 0);
    host.innerHTML = `
      <details class="group bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <summary class="flex items-center justify-between gap-4 p-6 sm:px-8 cursor-pointer select-none list-none">
          <div>
            <h4 class="text-base font-bold text-gray-900">Your Onboarding Answers</h4>
            <p class="text-sm text-gray-500 mt-1">A read-only summary of everything you told us when setting up this assistant. Expand to review — you can edit any of it in the tabs below.</p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span id="onboarding-summary-count" data-base-count="${fieldCount}" class="text-xs font-semibold text-gray-400">${fieldCount} item${fieldCount === 1 ? '' : 's'}</span>
            <svg class="w-5 h-5 text-gray-400 transition-transform duration-200 group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
          </div>
        </summary>
        <div class="px-6 sm:px-8 pb-6 sm:pb-8 pt-2 border-t border-gray-100">
          <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 mt-4">
            ${rows.map(([label, value]) => `
              <div>
                <dt class="text-xs font-bold text-gray-400 uppercase tracking-wide">${esc(label)}</dt>
                <dd class="text-sm text-gray-900 mt-1 whitespace-pre-line">${esc(value)}</dd>
              </div>`).join('')}
          </dl>
          ${rules.length ? `
            <div class="mt-6 pt-5 border-t border-gray-100">
              <p class="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Knowledge &amp; Guardrails</p>
              <ul class="list-disc pl-5 space-y-1 text-sm text-gray-900">
                ${rules.map(r => `<li class="whitespace-pre-line">${esc(r)}</li>`).join('')}
              </ul>
            </div>` : ''}
          <!-- Supported external tools — filled by _renderOnboardingConnections once the
               Connections tab has loaded the server's supportedTools list. -->
          <div id="onboarding-connections-block"></div>
        </div>
      </details>`;
}

// Fold the assistant's supported external tools (Connections) into the read-only
// "Your Onboarding Answers" summary. Runs AFTER initAssistantConnections has loaded the
// server-owned supportedTools list (connection-map.ts), so it reads that via the getters
// integrations.js exposes rather than duplicating the role→category policy on the client.
function _renderOnboardingConnections() {
    const block = document.getElementById('onboarding-connections-block');
    if (!block) return;
    const tools = (typeof window._intGetSupportedTools === 'function') ? (window._intGetSupportedTools() || []) : [];
    if (!tools.length) { block.innerHTML = ''; return; }

    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const connected = (typeof window._intGetConnectedServices === 'function') ? (window._intGetConnectedServices() || []) : [];
    const connectedLabels = connected.map(s => ({ x: 'X (Twitter)', twitter: 'X (Twitter)', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn' }[String(s).toLowerCase()] || s));

    const pill = (label, cls) => `<span class="inline-flex items-center text-[11px] font-bold ${cls} px-2 py-0.5 rounded-full">${label}</span>`;
    const items = tools.map(t => `
        <li class="flex items-center justify-between gap-3 py-1.5">
          <span class="text-sm text-gray-900">${esc(t.label)}</span>
          ${t.available ? pill('Available', 'text-emerald-700 bg-emerald-50 border border-emerald-200')
                        : pill('Coming soon', 'text-gray-500 bg-gray-100 border border-gray-200')}
        </li>`).join('');

    block.innerHTML = `
        <div class="mt-6 pt-5 border-t border-gray-100">
          <p class="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Connections</p>
          <p class="text-xs text-gray-500 mb-2">External tools this assistant can use. Manage them in the Connections tab below.</p>
          <ul class="divide-y divide-gray-100">${items}</ul>
          ${connectedLabels.length ? `<p class="text-xs text-gray-500 mt-3">Currently connected: <span class="font-semibold text-gray-700">${connectedLabels.map(esc).join(', ')}</span></p>` : ''}
        </div>`;

    // Keep the collapsed item count honest — add "Connections" as one more item.
    const countEl = document.getElementById('onboarding-summary-count');
    if (countEl) {
        const base = parseInt(countEl.dataset.baseCount || '0', 10) || 0;
        const total = base + 1;
        countEl.textContent = `${total} item${total === 1 ? '' : 's'}`;
    }
}

// Lead Generator email-connect CTA. When the user chose to send outreach from their own inbox
// (onboardingContext.outreachEmailProvider) but the account isn't connected, surface a prominent
// Connect card above the onboarding summary. Google uses the existing OAuth (a plain link, same
// as integrations.html); Microsoft is a fast-follow (informational only for now).
async function _renderOutreachEmailConnect(data) {
    const anchor = document.getElementById('onboarding-summary');
    if (!anchor || !anchor.parentNode) return;
    const ID = 'outreach-email-connect-card';
    const existing = document.getElementById(ID);
    const provider = (data && data.context && typeof data.context === 'object')
        ? String(data.context.outreachEmailProvider || '') : '';

    // Only relevant when the user opted into sending outreach from their own inbox.
    if (provider !== 'google' && provider !== 'microsoft') { if (existing) existing.remove(); return; }

    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const card = existing || document.createElement('div');
    card.id = ID;
    card.className = 'mb-4';
    if (!existing) anchor.parentNode.insertBefore(card, anchor);

    if (provider === 'microsoft') {
        card.innerHTML = `
          <div class="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-start gap-3">
            <span class="text-xl shrink-0">📧</span>
            <div>
              <p class="font-bold text-gray-900 text-sm">Microsoft email — coming soon</p>
              <p class="text-sm text-gray-600 mt-0.5">You chose to send outreach from Outlook / Microsoft 365. That connection is on the way — until then, approved leads get a ready-to-send draft you send yourself.</p>
            </div>
          </div>`;
        return;
    }

    // provider === 'google' → check the live connection status, then render connect vs confirmed.
    card.innerHTML = '<div class="bg-white border border-gray-200 rounded-2xl p-5 text-sm text-gray-400">Checking your Google connection…</div>';
    let connected = false, accountName = null;
    try {
        const res = await fetch('/api/oauth/status');
        if (res.ok) {
            const g = ((await res.json()) || {}).providers?.gmail;
            connected = !!(g && g.connected);
            accountName = g && g.accountName;
        }
    } catch { /* treat as not connected → show the Connect CTA */ }

    // Guard against a stale re-render having replaced the node while we awaited.
    if (document.getElementById(ID) !== card) return;

    card.innerHTML = connected
        ? `<div class="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 flex items-start gap-3">
             <span class="text-xl shrink-0">✅</span>
             <div>
               <p class="font-bold text-gray-900 text-sm">Google connected — outreach sends automatically</p>
               <p class="text-sm text-gray-600 mt-0.5">Approving a lead emails your outreach from ${accountName ? `<span class="font-semibold text-gray-800">${esc(accountName)}</span>` : 'your connected Google account'} and sets a chase reminder on the Calendar.</p>
             </div>
           </div>`
        : `<div class="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
             <div class="flex items-start gap-3">
               <span class="text-xl shrink-0">📧</span>
               <div>
                 <p class="font-bold text-gray-900 text-sm">Connect your Google account to send outreach</p>
                 <p class="text-sm text-gray-600 mt-0.5">You chose to send outreach emails from your own inbox. Connect Gmail / Google Workspace and approved leads are emailed automatically, with a chase reminder set for you.</p>
               </div>
             </div>
             <a href="/api/oauth/gmail/connect" class="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold rounded-lg transition whitespace-nowrap">Connect Gmail</a>
           </div>`;
}

// Role-specific "Quick Start Suggestions" for the Mandate tab — clickable bottleneck
// prompts (parity with Social Media Manager onboarding). Sourced from
// src/config/mandate-suggestions.js, keyed by roleKey with a social fallback. Clicking a
// chip writes the text into #edit_problem and dispatches 'input' so the existing autogrow +
// autosave handlers pick it up (persisting to onboardingContext.problem_statement, which the
// "Your Onboarding Answers" summary surfaces as "Your Bottleneck").
function _renderMandateSuggestions(data) {
    const wrap = document.getElementById('mandate-suggestions');
    const list = document.getElementById('mandate-suggestions-list');
    if (!wrap || !list) return;

    const registry = window.MandateSuggestions;
    const suggestions = (registry && typeof registry.get === 'function')
        ? registry.get(data && data.roleKey)
        : null;
    if (!Array.isArray(suggestions) || !suggestions.length) {
        wrap.classList.add('hidden');
        return;
    }

    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    list.innerHTML = suggestions.map(s => `
      <button type="button" title="${esc(s.text)}"
        class="mandate-suggestion text-left text-sm bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg p-3 hover:bg-emerald-100 hover:border-emerald-300 transition shadow-sm cursor-pointer">
        <span class="font-bold block mb-1">${esc(s.title)}</span>
        <span class="line-clamp-2 text-emerald-700">${esc(s.text)}</span>
      </button>`).join('');

    list.querySelectorAll('.mandate-suggestion').forEach((btn, i) => {
        btn.addEventListener('click', () => {
            const el = document.getElementById('edit_problem');
            if (!el) return;
            el.value = suggestions[i].text;
            _autoGrowField(el);
            // Route through the standard input event so triggerAutoSave (attachAutoSave) persists it.
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.focus();
        });
    });
    wrap.classList.remove('hidden');
}

// ── Role-aware dashboard (AssistantDashboardRegistry) ────────────
// Injects the role's KPI card copy and toggles the social-only UI modules
// declared in src/components/assistant-dashboard-registry.js. Unknown or
// missing roleKeys fall back to the registry's social_media_manager default
// (legacy assistants are all social), so the page always has a complete
// generic display; if the registry script isn't loaded we change nothing.
function _applyDashboardRegistry(data) {
    const registry = window.AssistantDashboardRegistry;
    const cfg = (registry && typeof registry.get === 'function') ? registry.get(data.roleKey) : null;
    if (!cfg) return;

    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text || ''; };
    (cfg.kpis || []).slice(0, 4).forEach((kpi, i) => {
        setText(`kpi-${i + 1}-label`, kpi.label || kpi.title);
        setText(`kpi-${i + 1}-title`, kpi.title);
        setText(`kpi-${i + 1}-desc`, kpi.desc);
    });

    const mods = cfg.modules || {};
    const toggle = (id, show) => { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', !show); };
    // Action-bar buttons use `inline-flex`, which the compiled style.css orders AFTER
    // `.hidden` — so the `hidden` class alone does NOT hide them. Force it with an inline
    // display override (cleared when shown so the class layout wins again).
    const toggleBtn = (id, show) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('hidden', !show);
        el.style.display = show ? '' : 'none';
    };
    // Review Queue is a CORE tab on every assistant — the human-in-the-loop approval gate — so
    // it (and the Overview shortcut that opens it) is always shown. Its data model comes from
    // cfg.reviewQueue { kind: 'posts' | 'records', recordType? } and is read by _detailRq* and
    // _activateMainTab. Default to posts for any legacy/unknown role.
    window._detailReviewQueue = cfg.reviewQueue || { kind: 'posts' };
    toggle('maintab-btn-review-queue', true);
    toggleBtn('btn-review-pending', true);
    // Per-role tab label override (e.g. meeting note-taker → "Inbox"); defaults to "Review".
    // The tab button's badge span must survive, so only its leading text node is rewritten.
    const rqLabel = window._detailReviewQueue.label || 'Review';
    setText('detail-rq-heading', rqLabel);
    const rqTabBtn = document.getElementById('maintab-btn-review-queue');
    if (rqTabBtn && rqTabBtn.firstChild && rqTabBtn.firstChild.nodeType === 3) rqTabBtn.firstChild.nodeValue = rqLabel + ' ';
    // Review Queue tab header/columns adapt to the queue kind. Records queues (data-hub roles)
    // approve/schedule records — there's no "Posted" state and no post-generation button here.
    const rqIsRecords = window._detailReviewQueue.kind === 'records';
    const rqIsBlog = window._detailReviewQueue.source === 'blog_posts';
    setText('detail-rq-subtitle', rqIsRecords
        ? 'Records this assistant produced, awaiting your approval — approve, schedule or reject before anything acts on them.'
        : rqIsBlog
            ? 'Long-form drafts awaiting your review — open in Blog Studio to edit and approve, then schedule.'
            : 'Items awaiting your review — approve, edit or reject before anything is scheduled.');
    // Records queues have no post-generation button; blog re-points it at Blog Studio.
    toggleBtn('detail-rq-primary-btn', !rqIsRecords);
    toggle('detail-rq-col-posted', !rqIsRecords);
    if (rqIsBlog) {
        setText('detail-rq-primary-label', 'Write Blog Post');
        const rqBtn = document.getElementById('detail-rq-primary-btn');
        if (rqBtn) rqBtn.onclick = () => { window.openBlogStudio?.({ assistantId: data.id }); };
    }

    // Role-specific Overview secondary action — the Lead Generator's "Review Lead Ideas"
    // replaces the (hidden) social "Review Pending Items" button. Shown + wired from the
    // registry's ideasReview config; the component (assistant-lead-ideas.js) drives the modal.
    const ideas = cfg.ideasReview;
    toggleBtn('btn-lead-ideas', !!ideas);
    if (ideas) {
        setText('lead-ideas-label', ideas.label || 'Review Lead Ideas');
        window.AssistantLeadIdeas?.init({ assistantId: data.id, cfg: ideas });
    }
    // Lead Generator "Find New Leads" — outbound discovery campaigns (assistant-discovery-campaigns.js).
    const discovery = cfg.discoveryCampaigns;
    toggleBtn('btn-discovery-campaigns', !!discovery);
    if (discovery) {
        setText('discovery-campaigns-label', discovery.label || 'Find New Leads');
        window.AssistantDiscoveryCampaigns?.init({ assistantId: data.id, cfg: discovery });
    }
    toggle('module-posting-schedule', mods.hasPostingSchedule !== false);
    toggle('module-social-strategy', mods.hasSocialStrategy !== false);

    // Overview — the post-based Impact & ROI card is meaningless for non-social roles (they publish
    // nothing); their role KPI cards carry the Overview instead. A dataset flag makes the hide stick
    // even though _fetchAndRenderAssistantMetrics runs asynchronously and would otherwise un-hide it.
    const impactOn = mods.hasImpactRoi !== false;
    const metricsCard = document.getElementById('assistant-metrics-card');
    if (metricsCard) {
        if (impactOn) { delete metricsCard.dataset.roleHidden; }
        else { metricsCard.dataset.roleHidden = '1'; metricsCard.classList.add('hidden'); }
    }
    // Profile ▸ Creative Brief — the marketing cards (objective/CTA, audience/voice/pillars,
    // reference style) and the Sales Context playbook. Business Information & the AI-disclosure
    // cards stay for every role, so the tab itself is never hidden.
    toggle('module-creative-objective', mods.hasCreativeBrief !== false);
    toggle('module-creative-audience', mods.hasCreativeBrief !== false);
    toggle('module-reference-style', mods.hasCreativeBrief !== false);
    toggle('module-sales-context', mods.hasSalesContext !== false);
    // Profile ▸ Brand Safety ▸ Empty-Library Draft Fallback, and Notifications ▸ Review-alert
    // cadence — both only make sense when there's a posting Review Queue.
    toggle('module-empty-library', mods.hasEmptyLibraryFallback !== false);
    toggle('module-review-cadence', mods.hasReviewCadence !== false);
    // Operating File nav-card subtitles — when the social cards inside are hidden, the subtitle
    // shouldn't promise them. Creative Brief collapses to just Business Knowledge for these roles.
    if (mods.hasCreativeBrief === false) {
        setText('opcard-strategy-title', 'Brand Knowledge');
        setText('opcard-strategy-sub', 'Business information and brand context your assistant applies');
    }
    if (mods.hasPostingSchedule === false) {
        setText('opcard-operation-sub', 'Trigger and content source');
    }

    // Automation (autonomous posting + media sources) — entirely post/media-centric, lives in the
    // profile's Operational Setup section (issue #194: moved out of its own main tab).
    toggle('module-content-automation', mods.hasContentAutomation !== false);

    // Overview primary action — relabel + rebind by role. 'chat' opens the assistant's chat intake
    // (how Data Hub roles receive work); the Blog Writer opens the Blog Studio modal (authored as
    // the user, this assistant supporting); anything else keeps the post-generation sheet.
    const pa = cfg.primaryAction;
    const paBtn = document.getElementById('btn-primary-action');
    const paLabel = document.getElementById('primary-action-label');
    // Issue #177: the button starts hidden in markup (its label/onclick are the SMM defaults) —
    // reveal it only now that the role-specific label/handler below are actually being applied.
    toggleBtn('btn-primary-action', true);
    if (data.roleKey === 'blog_writer') {
        if (paLabel) paLabel.textContent = 'Write Blog Post';
        if (paBtn) paBtn.onclick = () => { if (window.openBlogStudio) window.openBlogStudio({ assistantId: data.id }); };
    } else if (pa) {
        if (paLabel) paLabel.textContent = pa.label || 'Assign New Task';
        if (paBtn) {
            if (pa.kind === 'chat') {
                paBtn.onclick = () => { window.location.href = `assistant-chat.html?assistantId=${data.id}`; };
            } else {
                paBtn.onclick = () => { if (window.openGeneratePostSheet) window.openGeneratePostSheet(); };
            }
        }
    }

    // Data Hub tab — a CORE tab on every assistant (its workspace/database). Every role now has
    // a hubTab: records (Leads / Ledger / …) for data-hub roles, or a content library
    // (kind:'content_library') for social/blog. Always shown; label + data model come from hub.
    const hub = cfg.hubTab;
    toggle('maintab-btn-datahub', true);
    if (hub) {
        setText('datahub-tab-label', hub.label);
        window.AssistantDataHub?.init({ hub, assistantId: data.id });
    }

    // Calendar tab — a CORE tab on every assistant, scoped to just this assistant. Registered
    // here with the assistant id; rendered lazily on first _activateMainTab('calendar').
    window.AssistantCalendar?.register({ assistantId: data.id, roleKey: data.roleKey });

    // Knowledge Base tab — only roles with a kbTab config (tier1_support_agent):
    // the articles that ground the assistant's Resolved answers (KB phase).
    const kb = cfg.kbTab;
    toggle('maintab-btn-kb', !!kb);
    if (kb) {
        setText('kb-tab-label', kb.label);
        window.AssistantKnowledgeBase?.init({ kb, assistantId: data.id });
    }
}

// Steps from the role's schema-driven onboarding definition
// (src/config/assistant-onboarding-schemas.js) — [] when the role has none
// (social assistants use the hand-built drawer fields instead).
function _roleSchemaSteps(roleKey) {
    const schema = (window.AssistantOnboardingSchemas || {})[roleKey];
    if (!Array.isArray(schema) || !schema.length) return [];
    return schema.every(s => Array.isArray(s?.fields)) ? schema : [{ fields: schema }];
}

// Flattened field list across all of a role's onboarding steps.
function _roleSchemaFields(roleKey) {
    return _roleSchemaSteps(roleKey).flatMap(s => (s.fields || []).filter(f => f && f.key && f.type));
}

// Human-readable value for a schema answer (option label for radio/dropdown,
// Yes/No for toggles). '' means "not answered" and the row is omitted.
function _formatSchemaAnswer(field, value) {
    if (field.type === 'toggle') return (value === undefined || value === null) ? '' : (value ? 'Yes' : 'No');
    if (value === undefined || value === null || String(value).trim() === '') return '';
    if ((field.type === 'radio' || field.type === 'dropdown') && Array.isArray(field.options)) {
        const opt = field.options.find(o => String(o.value) === String(value));
        if (opt) return String(opt.label ?? opt.value);
    }
    return String(value);
}

// Shared control renderer for schema-driven onboarding answers, used by the Operational Setup
// section (idPrefix 'edit_op_'). Inputs get an id starting `edit_` (so the [id^="edit_"]
// autosave wiring picks them up) and
// carry data-onboarding-key (so _detailCollect writes them back into onboardingContext under
// their original keys). radio/dropdown render as a <select> for a compact edit surface.
function _onboardingFieldControl(f, ctx, idPrefix) {
    const esc = _escapeHtml;
    const inputCls = 'w-full border border-gray-300 rounded-lg p-3 text-sm bg-white focus:ring-2 focus:ring-emerald-700 focus:border-emerald-700 transition shadow-sm';
    const common = `id="${esc(idPrefix + f.key)}" data-onboarding-key="${esc(f.key)}"`;
    const v = ctx[f.key];
    switch (f.type) {
        case 'textarea':
            return `<textarea ${common} rows="3" placeholder="${esc(f.placeholder || '')}" class="${inputCls} resize-y">${esc(v ?? '')}</textarea>`;
        case 'number':
            return `<input type="number" ${common} data-onb-type="number" value="${esc(v ?? '')}"
                ${f.min !== undefined ? `min="${esc(f.min)}"` : ''} ${f.max !== undefined ? `max="${esc(f.max)}"` : ''}
                placeholder="${esc(f.placeholder || '')}" class="${inputCls}">`;
        case 'dropdown':
        case 'radio':
            return `<select ${common} class="${inputCls}">
                <option value="">${esc(f.placeholder || 'Please select…')}</option>
                ${(f.options || []).map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(v ?? '') ? 'selected' : ''}>${esc(o.label ?? o.value)}</option>`).join('')}
            </select>`;
        case 'toggle':
            return `<label class="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="checkbox" ${common} class="rounded text-emerald-700 focus:ring-emerald-700" ${v ? 'checked' : ''}> Enabled
            </label>`;
        default: // text
            return `<input type="text" ${common} value="${esc(v ?? '')}" placeholder="${esc(f.placeholder || '')}" class="${inputCls}">`;
    }
}

// Belt-and-braces: sync select values programmatically as well as via the `selected`
// attribute, so stored answers always pre-select their option after innerHTML render.
function _syncSchemaSelects(fields, ctx, idPrefix) {
    fields.forEach(f => {
        if (f.type !== 'dropdown' && f.type !== 'radio') return;
        const sel = document.getElementById(idPrefix + f.key);
        const v = ctx[f.key];
        if (sel && v !== undefined && v !== null) sel.value = String(v);
    });
}

// Role-specific Operational Setup section (profile ▸ Operational Setup tab). Schema-driven
// roles render ALL of their onboarding fields into #operation-role-fields — this is the one
// editable home for those answers (see issue #169) — and hide the generic Trigger/Content
// Source block (#operation-generic); social/legacy roles keep the generic block.
function _renderOperationSection(data) {
    const host = document.getElementById('operation-role-fields');
    const generic = document.getElementById('operation-generic');
    if (!host) return;
    const fields = _roleSchemaFields(data.roleKey);
    if (!fields.length) {
        host.innerHTML = '';
        if (generic) generic.classList.remove('hidden');
        // Reset the intro in case a schema role was viewed earlier this session (the Operating
        // File subtitle is reset per-load by _applyDashboardRegistry, so it's left alone here).
        const intro0 = document.getElementById('operation-intro');
        if (intro0) intro0.textContent = 'When does your assistant run, and where does it get its content from?';
        return;
    }
    if (generic) generic.classList.add('hidden');
    // Retitle the section + Operating File card away from the social "Trigger / content source"
    // wording (_applyDashboardRegistry) now that role-specific operational questions show here.
    const intro = document.getElementById('operation-intro');
    if (intro) intro.textContent = 'The settings that control how this assistant runs — when it works, what it acts on, and how it hands off.';
    const opSub = document.getElementById('opcard-operation-sub');
    if (opSub) opSub.textContent = 'How this assistant runs day to day';
    const ctx = (data.context && typeof data.context === 'object') ? data.context : {};
    const esc = _escapeHtml;

    host.innerHTML = fields.map(f => `
        <div>
          <label for="edit_op_${esc(f.key)}" class="block text-sm font-bold text-gray-700 mb-1">${esc(f.label || f.key)}</label>
          ${f.helpText ? `<p class="text-xs text-gray-500 mb-2">${esc(f.helpText)}</p>` : ''}
          ${_onboardingFieldControl(f, ctx, 'edit_op_')}
        </div>`).join('');

    _syncSchemaSelects(fields, ctx, 'edit_op_');
}

function _detailHydrate(data) {
    const ctx = data.context || {};
    const cfg = data.configuration || {};
    const inputs = cfg.inputs || {};

    _detailSetVal('edit_problem', ctx.problem_statement || inputs.problem || '');
    _setFrequencySelect(ctx.posting_frequency || _POSTING_DEFAULT_FREQ);

    // ── Posting Schedule: days / times / timezone / draft horizon ──
    const _days = (Array.isArray(ctx.posting_days) && ctx.posting_days.length)
        ? ctx.posting_days.map(d => String(d).toLowerCase().slice(0, 3))
        : _POSTING_DEFAULT_DAYS;
    _POSTING_DAY_KEYS.forEach(d => {
        const el = document.getElementById('edit_day_' + d);
        if (el) el.checked = _days.includes(d);
    });
    _renderPostingTimes(ctx.posting_times);
    // Inject a stored timezone that isn't in the curated list so it round-trips.
    const tzSel = document.getElementById('edit_timezone');
    const tzVal = ctx.posting_timezone || _POSTING_DEFAULT_TZ;
    if (tzSel) {
        if (!Array.from(tzSel.options).some(o => o.value === tzVal)) {
            const opt = document.createElement('option');
            opt.value = tzVal; opt.textContent = tzVal;
            tzSel.appendChild(opt);
        }
        tzSel.value = tzVal;
    }
    const horizonEl = document.getElementById('posting-horizon-input');
    if (horizonEl) horizonEl.value = data.draftHorizonDays ?? 7;

    // Objective
    const objectiveVal = ctx.primary_objective || inputs.primary_objective || '';
    if (objectiveVal) {
        const r = document.querySelector(`input[name="edit_objective"][value="${objectiveVal}"]`);
        if (r) r.checked = true;
    }
    // Core message + CTA
    _detailSetVal('edit_core_message', ctx.core_message || inputs.core_message || '');
    _detailSetVal('edit_cta', ctx.cta || inputs.cta || '');
    _detailSetVal('edit_incentive', ctx.incentive || inputs.incentive || '');
    _detailSetVal('edit_audience', ctx.target_audience || '');
    _detailSetVal('edit_tone', ctx.tone_of_voice || '');
    _detailSetVal('edit_pillars', Array.isArray(ctx.content_pillars) ? ctx.content_pillars.join(', ') : (ctx.content_pillars || ''));
    _renderPillarChips();
    // Sales context — feeds the auto-responder objection playbook (P4) and DM drafting.
    _detailSetVal('edit_offerings', ctx.service_offerings || '');
    _detailSetVal('edit_objections', ctx.sales_objections || '');
    // Reference style link + per-platform hashtag/algorithm strategy (parity with onboarding).
    _detailSetVal('edit_reference_url', ctx.reference_style_url || '');
    _hydratePlatformStrategy(data);
    // workflowText is Be More Swan IP — not displayed to the user

    // Radios — trigger / source.
    // Onboarding may store these as the radio value (e.g. "on_demand") OR as a human label
    // (e.g. "On Demand" in triggerText/sourceText). Normalise labels → value keys so the radio
    // pre-selects either way ("On Demand" → "on_demand", "Client Provided" → "client_provided").
    const _toOptionValue = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const _checkRadio = (name, ...candidates) => {
        for (const c of candidates) {
            const v = _toOptionValue(c);
            if (!v) continue;
            const r = document.querySelector(`input[name="${name}"][value="${v}"]`);
            if (r) { r.checked = true; return; }
        }
    };
    _checkRadio('edit_trigger', inputs.trigger_type, inputs.triggerText);
    _checkRadio('edit_source', inputs.content_source, inputs.sourceText);

    // Platforms are rendered dynamically in the Connections tab — see initAssistantConnections()

    // Guardrails — separate knowledge base out of strictRules
    const allStrict = inputs.strictRules || [];
    const kbLine = allStrict.find(r => r.includes('KNOWLEDGE BASE (TEXT)'));
    const otherRules = allStrict.filter(r => !r.includes('KNOWLEDGE BASE (TEXT)'));
    _detailSetVal('edit_strict_rules', otherRules.join('\n'));
    if (kbLine) {
        const m = kbLine.match(/:\s*"([^"]+)"/);
        _detailSetVal('edit_knowledge', m ? m[1] : '');
    }

    // Per-assistant AI disclosure (EU AI Act transparency rules — Art. 50)
    _detailSetVal('edit_ai_disclosure', data.disclosureText || '');
    _renderDisclosureHelp(data);

    // Reflect guardrails state in the Brand Protected header badge
    if (typeof window._updateGuardrailsBadge === 'function') window._updateGuardrailsBadge();

    // Size the auto-growing brief fields to their loaded content (visible tab only — the rest
    // are resized when their tab is first shown, see the tab-switching handler).
    _initBriefAutoGrow();
    requestAnimationFrame(_resizeBriefAutoGrow);
}

// Tailor the AI-disclosure guidance to what this assistant actually produces.
// Social/posting assistants generate images, video and text published under the user's
// brand → the deployer (the user's business) must label AI-generated media (EU AI Act
// Art. 50). Conversational/other assistants need the "you're talking to an AI" notice.
function _isSocialPostingAssistant(data) {
    const role = `${data.role || ''} ${data.category || ''}`.toLowerCase();
    if (/social|media|content|community|marketing|post/.test(role)) return true;
    const platforms = []
        .concat(data.context?.primary_platforms || [])
        .concat(data.configuration?.inputs?.platforms || [])
        .map(p => String(p).toLowerCase());
    return platforms.some(p => /instagram|facebook|linkedin|twitter|^x$|tiktok|youtube|threads|pinterest/.test(p));
}

function _renderDisclosureHelp(data) {
    const box = document.getElementById('disclosure-examples');
    const desc = document.getElementById('disclosure-desc');
    const field = document.getElementById('edit_ai_disclosure');
    if (!box) return;

    // A single post can mix image, video and text — each may need its own disclosure line.
    // Each example is therefore a TOGGLE that adds/removes its line, so several can be combined.
    const example = (icon, label, text, note) => `
        <div class="flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2.5">
            <span class="text-base leading-5 shrink-0">${icon}</span>
            <div class="min-w-0 flex-1">
                <p class="text-xs font-bold text-gray-700">${label}</p>
                <p class="text-xs text-gray-600 italic">&ldquo;${text}&rdquo;</p>
                <p class="text-[11px] text-gray-400 mt-0.5">${note}</p>
            </div>
            <button type="button" role="switch" aria-checked="false" data-disclosure-example="${_escapeHtml(text)}"
                title="Include this disclosure"
                class="ar-disclosure-toggle relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none self-center bg-gray-300">
                <span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ease-in-out translate-x-0"></span>
            </button>
        </div>`;

    if (_isSocialPostingAssistant(data)) {
        if (desc) desc.textContent = "How this assistant labels the content it publishes as AI-generated, as required by the EU AI Act's transparency rules (Art. 50). A single post can mix image, video and text — switch on every disclosure that applies and they'll be combined. This must be set before the assistant can be activated in the Kick Off Meeting.";
        if (field) field.placeholder = 'Switch on the disclosures that apply above, or write your own — e.g. Some content on this account is created with the help of Be More Swan AI.';
        box.innerHTML = `
            <p class="text-xs font-semibold text-gray-500 mb-2">Switch on every disclosure that applies — combine image, video and text as needed, then fine-tune the wording below:</p>
            <div class="space-y-2">
                ${example('🖼️', 'AI-generated images', 'Image created with Be More Swan AI.',
                    'Required for realistic or altered AI images (Art. 50 — “deepfake” labelling).')}
                ${example('🎬', 'AI-generated video', 'Video generated with Be More Swan AI.',
                    'Required for AI-generated or AI-manipulated video.')}
                ${example('✍️', 'AI-generated text / captions', 'Written with the help of Be More Swan AI.',
                    'Required only for posts on matters of public interest (news, politics, health) where no human took editorial responsibility — routine marketing copy is generally exempt.')}
            </div>`;
    } else {
        if (desc) desc.textContent = "The notice shown to people interacting with this assistant, confirming they're dealing with an AI system, as required by the EU AI Act's transparency rules (Art. 50). This must be set before the assistant can be activated in the Kick Off Meeting.";
        if (field) field.placeholder = "e.g. You're chatting with an AI assistant working on behalf of [your business]. Responses are AI-generated.";
        box.innerHTML = `
            <p class="text-xs font-semibold text-gray-500 mb-2">Switch on the disclosure to use it, or write your own:</p>
            <div class="space-y-2">
                ${example('💬', 'AI interaction notice', "You're chatting with an AI assistant working on behalf of [your business]. Responses are AI-generated.",
                    'Shown to people the moment they interact with the assistant (Art. 50 — AI-interaction transparency).')}
            </div>`;
    }

    // Each toggle adds/removes its disclosure line so multiple content types can be combined in
    // one post. The textarea stays the saved source of truth; toggling fires its input listener
    // (the existing auto-save) and keeps the switch in sync with what's actually in the field.
    const fieldLines = () => (field?.value || '').split('\n').map(l => l.trim()).filter(Boolean);
    const setToggleVisual = (btn, on) => {
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.classList.toggle('bg-emerald-500', on);
        btn.classList.toggle('bg-gray-300', !on);
        const dot = btn.querySelector('span');
        if (dot) { dot.classList.toggle('translate-x-5', on); dot.classList.toggle('translate-x-0', !on); }
    };

    const toggles = Array.from(box.querySelectorAll('.ar-disclosure-toggle'));
    const syncToggles = () => {
        const present = fieldLines();
        toggles.forEach(b => setToggleVisual(b, present.includes((b.dataset.disclosureExample || '').trim())));
    };

    toggles.forEach(btn => {
        btn.addEventListener('click', () => {
            if (!field) return;
            const line = (btn.dataset.disclosureExample || '').trim();
            const lines = fieldLines();
            const idx = lines.indexOf(line);
            if (idx >= 0) lines.splice(idx, 1); else lines.push(line);
            field.value = lines.join('\n');
            field.dispatchEvent(new Event('input', { bubbles: true }));
            _autoGrowField(field);
            syncToggles();
        });
    });

    // Reflect the saved disclosure (and any manual edits) in the switches.
    syncToggles();
    if (field && !field._disclosureSyncBound) {
        field._disclosureSyncBound = true;
        field.addEventListener('input', syncToggles);
    }
}

// Which of fb/ig/li/x/threads/tiktok/youtube this assistant actually uses. Platforms are
// stored inconsistently across versions — context.primary_platforms as short codes
// (["fb","ig"], with "th"/"tt"/"yt" for the newer platforms) OR configuration.inputs.platforms
// as labels ("Facebook (https://…)") — so scan both and match on known tokens.
function _platformCodes(data) {
    const ctx = data.context || {};
    const raw = []
        .concat(Array.isArray(ctx.primary_platforms) ? ctx.primary_platforms : [])
        .concat(Array.isArray(data.configuration?.inputs?.platforms) ? data.configuration.inputs.platforms : [])
        .map(p => String(p).toLowerCase());
    const codes = new Set();
    raw.forEach(p => {
        if (p === 'fb' || p.includes('facebook')) codes.add('fb');
        if (p === 'ig' || p.includes('instagram')) codes.add('ig');
        if (p === 'li' || p.includes('linkedin')) codes.add('li');
        if (p === 'x' || p.includes('twitter') || /(^|\W)x(\W|$)/.test(p)) codes.add('x');
        if (p === 'th' || p.includes('threads')) codes.add('threads');
        if (p === 'tt' || p.includes('tiktok')) codes.add('tiktok');
        if (p === 'yt' || p.includes('youtube')) codes.add('youtube');
    });
    return codes;
}

// Show a per-platform strategy block only for the platforms in use, and fill it from
// context.platform_strategy (written by both onboarding and this form).
function _hydratePlatformStrategy(data) {
    const codes = _platformCodes(data);
    const ps = (data.context && typeof data.context.platform_strategy === 'object' && data.context.platform_strategy) || {};
    const emptyEl = document.getElementById('platform-strategy-empty');
    if (emptyEl) emptyEl.classList.toggle('hidden', codes.size > 0);

    ['fb', 'ig', 'li', 'x', 'threads', 'tiktok', 'youtube'].forEach(p => {
        const block = document.getElementById(`edit_algo_block_${p}`);
        if (block) block.classList.toggle('hidden', !codes.has(p));
        const s = ps[p] || {};
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
        const check = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
        set(`edit_algo_tags_${p}`, s.tags || '');
        if (p === 'fb') { set('edit_algo_strategy_fb', s.strategy || 'strict_custom'); check('edit_fb_opt_groups', s.groups); }
        if (p === 'ig') { set('edit_ig_opt_format', s.format || 'mix'); check('edit_ig_opt_audio', s.audio); }
        if (p === 'li') { check('edit_li_opt_links', s.links_first_comment); check('edit_li_opt_sliders', s.sliders); }
        if (p === 'x')  { set('edit_x_opt_length', s.length || 'mix'); check('edit_x_opt_media', s.media); }
        if (p === 'threads') { check('edit_threads_opt_conversational', s.conversational); }
        if (p === 'tiktok')  { check('edit_tiktok_opt_hooks', s.hooks); }
        if (p === 'youtube') { set('edit_youtube_opt_format', s.format || 'mix'); check('edit_youtube_opt_seo', s.seo); }
    });
}

// Read the strategy blocks back into a structured object for context.platform_strategy. Only
// visible (in-use) blocks are read; hidden platforms keep their previously stored strategy so a
// save never wipes settings for a platform that isn't currently surfaced.
function _collectPlatformStrategy(prior) {
    const val = (id) => document.getElementById(id)?.value || '';
    const on  = (id) => !!document.getElementById(id)?.checked;
    const visible = (p) => !document.getElementById(`edit_algo_block_${p}`)?.classList.contains('hidden');
    const out = { ...(prior && typeof prior === 'object' ? prior : {}) };
    if (visible('fb')) out.fb = { tags: val('edit_algo_tags_fb'), strategy: val('edit_algo_strategy_fb'), groups: on('edit_fb_opt_groups') };
    if (visible('ig')) out.ig = { tags: val('edit_algo_tags_ig'), format: val('edit_ig_opt_format'), audio: on('edit_ig_opt_audio') };
    if (visible('li')) out.li = { tags: val('edit_algo_tags_li'), links_first_comment: on('edit_li_opt_links'), sliders: on('edit_li_opt_sliders') };
    if (visible('x'))  out.x  = { tags: val('edit_algo_tags_x'), length: val('edit_x_opt_length'), media: on('edit_x_opt_media') };
    if (visible('threads')) out.threads = { conversational: on('edit_threads_opt_conversational') };
    if (visible('tiktok'))  out.tiktok  = { tags: val('edit_algo_tags_tiktok'), hooks: on('edit_tiktok_opt_hooks') };
    if (visible('youtube')) out.youtube = { format: val('edit_youtube_opt_format'), seo: on('edit_youtube_opt_seo') };
    return out;
}

function _detailCollect(currentData) {
    // Platforms are managed via the dynamic platforms tab — preserve existing values
    const platforms = currentData.context?.primary_platforms || [];
    const platformsRaw = currentData.configuration?.inputs?.platforms || [];

    const strictLines = (document.getElementById('edit_strict_rules')?.value || '')
        .split('\n').map(l => l.trim()).filter(Boolean);
    const knowledge = document.getElementById('edit_knowledge')?.value || '';
    if (knowledge) strictLines.push(`- KNOWLEDGE BASE (TEXT): Consider the following brand stories and context: "${knowledge}"`);

    // update-assistant-context REPLACES onboarding_context wholesale, so spread the existing
    // context first to preserve fields not surfaced in this form (business_bio/profile_bios,
    // business_hours, business_category, etc.) — otherwise a save here would wipe them.
    const newContext = {
        ...(currentData.context || {}),
        problem_statement: document.getElementById('edit_problem')?.value || '',
        primary_objective: document.querySelector('input[name="edit_objective"]:checked')?.value || '',
        core_message: document.getElementById('edit_core_message')?.value || '',
        cta: document.getElementById('edit_cta')?.value || '',
        incentive: document.getElementById('edit_incentive')?.value || '',
        posting_frequency: document.getElementById('edit_frequency')?.value || '',
        posting_days: _collectPostingDays(),
        posting_times: _collectPostingTimes(),
        posting_timezone: document.getElementById('edit_timezone')?.value || _POSTING_DEFAULT_TZ,
        target_audience: document.getElementById('edit_audience')?.value || '',
        tone_of_voice: document.getElementById('edit_tone')?.value || '',
        content_pillars: _parsePillars(document.getElementById('edit_pillars')?.value),
        service_offerings: document.getElementById('edit_offerings')?.value || '',
        sales_objections: document.getElementById('edit_objections')?.value || '',
        reference_style_url: document.getElementById('edit_reference_url')?.value || '',
        platform_strategy: _collectPlatformStrategy(currentData.context?.platform_strategy),
        primary_platforms: platforms,
    };

    // Role-specific onboarding answers (schema-driven roles) — inputs in the Operational Setup
    // section (#operation-role-fields) carry data-onboarding-key; write each back under its
    // original onboardingContext key so assistant-setup.html answers stay editable here.
    document.querySelectorAll('#operation-role-fields [data-onboarding-key]').forEach(el => {
        const key = el.dataset.onboardingKey;
        if (!key) return;
        if (el.type === 'checkbox') {
            newContext[key] = el.checked;
        } else if (el.dataset.onbType === 'number') {
            const n = Number(el.value);
            newContext[key] = (el.value.trim() === '' || !Number.isFinite(n)) ? null : n;
        } else {
            newContext[key] = el.value;
        }
    });

    const newConfiguration = {
        ...(currentData.configuration || {}),
        inputs: {
            ...(currentData.configuration?.inputs || {}),
            problem: document.getElementById('edit_problem')?.value || '',
            trigger_type: document.querySelector('input[name="edit_trigger"]:checked')?.value || '',
            triggerText: document.querySelector('input[name="edit_trigger"]:checked')?.value || '',
            content_source: document.querySelector('input[name="edit_source"]:checked')?.value || '',
            sourceText: document.querySelector('input[name="edit_source"]:checked')?.value || '',
            platforms: platformsRaw,
            generalPreferences: [
                document.getElementById('edit_audience')?.value ? `- Target Audience: ${document.getElementById('edit_audience').value}` : '',
                document.getElementById('edit_pillars')?.value ? `- Core Topics: ${document.getElementById('edit_pillars').value}` : '',
                document.getElementById('edit_tone')?.value ? `- Preferred Tone: ${document.getElementById('edit_tone').value}` : '',
            ].filter(Boolean),
            workflowText: currentData.configuration?.inputs?.workflowText || '', // preserved, not editable
            strictRules: strictLines,
        }
    };

    return { newContext, newConfiguration };
}

function _detailSetSaveStatus(msg, colour) {
    const el = document.getElementById('detail-save-status');
    if (el) {
        el.className = `text-sm font-semibold transition-all ${colour || 'text-emerald-600'}`;
        el.textContent = msg;
    }
    // Mirror into the slide-over header — the page header status sits behind the drawer
    // backdrop, so edits made inside the drawer need their own visible save indicator.
    const drawerEl = document.getElementById('brief-drawer-save');
    if (drawerEl) {
        drawerEl.style.color = /fail|error/i.test(msg) ? '#dc2626' : (/saving/i.test(msg) ? '#9ca3af' : '#059669');
        drawerEl.textContent = msg;
    }
}

window.initAssistantDetail = async function(assistantId, loadViewCb) {
    if (!assistantId) {
        // No assistant to load — don't leave the loading skeleton stuck on screen forever.
        document.getElementById('assistant-detail-skeleton')?.classList.add('hidden');
        document.getElementById('assistant-detail-content')?.classList.remove('hidden');
        return;
    }
    window.activeAssistantId = assistantId;
    window._currentAssistantId = assistantId;

    // Back button
    const btnBack = document.getElementById('btn-back-assistants');
    if (btnBack) {
        const newBtn = btnBack.cloneNode(true);
        btnBack.parentNode.replaceChild(newBtn, btnBack);
        newBtn.addEventListener('click', () => loadViewCb('assistants'));
    }

    // Issue #197: header "Chat" CTA — always visible, regardless of tab or role.
    const btnChat = document.getElementById('btn-detail-chat');
    if (btnChat) {
        btnChat.onclick = () => { window.location.href = `assistant-chat.html?assistantId=${assistantId}`; };
    }

    // ── Tab switching ─────────────────────────────────────────────
    // Both main tabs (Overview / Goals & Automation / Configuration) and the nested
    // Configuration child tabs are handled by module-level delegated click listeners
    // (see top of file) so they survive this view being re-injected on every navigation.

    // Deep-link to a specific section. 'goals' (and other tabs that don't depend on the
    // assistant-context fetch below) can activate immediately; every other target —
    // review-queue/datahub/calendar main tabs (e.g. issue #178's per-assistant dashboard
    // Quick Actions, or chat's "View in Review Queue" link) and the Configuration child
    // tabs (e.g. post-OAuth returning to Connections) — needs that data first, so it's
    // consumed by the matching block after "Load & hydrate" below. Activating a
    // records-backed queue early would render it with the wrong (default 'posts') renderer.
    if (window._assistantDetailInitialTab === 'goals') {
        window._assistantDetailInitialTab = null;
        window._activateMainTab?.('goals');
    }

    // ── Platform handle toggles ───────────────────────────────────
    ['fb', 'ig', 'li', 'x'].forEach(p => {
        const chk = document.getElementById('plat_' + p);
        if (chk) chk.addEventListener('change', () => _detailToggleHandle(p));
    });

    // ── Load assistant data ───────────────────────────────────────
    let currentData = {};
    let saveTimeout = null;

    async function persistChanges() {
        _detailSetSaveStatus('Saving…', 'text-gray-400');
        const { newContext, newConfiguration } = _detailCollect(currentData);
        // Also save the name
        const nameInput = document.getElementById('detail-name-input');
        const newName = nameInput ? nameInput.value.trim() : null;
        // Per-assistant AI disclosure (EU AI Act Art. 52) — saved alongside the context.
        const disclosureEl = document.getElementById('edit_ai_disclosure');
        const disclosureText = disclosureEl ? disclosureEl.value.trim() : undefined;
        try {
            const body = { assistantId: parseInt(assistantId), newContext, newConfiguration };
            if (newName) body.newName = newName;
            if (disclosureText !== undefined) body.disclosureText = disclosureText;
            const res = await fetch('/.netlify/functions/update-assistant-context', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                currentData.context = newContext;
                currentData.configuration = newConfiguration;
                if (disclosureText !== undefined) currentData.disclosureText = disclosureText;
                if (newName) {
                    document.getElementById('detail-avatar').textContent = newName.charAt(0).toUpperCase();
                    currentData.name = newName;
                }
                _detailSetSaveStatus('✓ Saved', 'text-emerald-600');
                setTimeout(() => _detailSetSaveStatus(''), 3000);
                // Refresh the Kick Off readiness so "AI disclosure acknowledged" (and any
                // other items affected by this save) re-evaluate without a page reload.
                if (typeof _renderKickOff === 'function') _renderKickOff(assistantId);
            } else {
                const err = await res.json().catch(() => ({}));
                _detailSetSaveStatus(err.error && /disclosure/i.test(err.error) ? 'Disclosure required' : 'Save failed', 'text-red-500');
            }
        } catch {
            _detailSetSaveStatus('Save failed', 'text-red-500');
        }
    }

    function triggerAutoSave() {
        _detailSetSaveStatus('Unsaved changes…', 'text-gray-400');
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(persistChanges, 1200);
    }

    // Closing the drawer (X / backdrop / Escape) right after typing would otherwise leave the
    // 1200ms debounce pending — the edit (and the Kick Off checklist refresh it triggers) only
    // lands in the background afterwards, so the checklist reads stale until the user happens to
    // re-check it later. Flush immediately so a close always reflects the save.
    window._flushAssistantDetailSave = () => {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
            persistChanges();
        }
    };

    function attachAutoSave() {
        const selectors = [
            '[id^="edit_"]',
            'input[name="edit_trigger"]', 'input[name="edit_source"]', 'input[name="edit_objective"]',
            '#detail-name-input'
        ].join(', ');
        document.querySelectorAll(selectors).forEach(el => {
            el.addEventListener('input', triggerAutoSave);
            el.addEventListener('change', triggerAutoSave);
        });
    }

    // ── Posting Schedule wiring ───────────────────────────────────
    // Day checkboxes / timezone autosave via the generic [id^="edit_"] handler above. The dynamic
    // time rows + "Add a time" button notify through this global hook; the draft horizon has its
    // own endpoint (set-draft-horizon) with gap-fill / archive side-effects, so it saves separately.
    function _wirePostingSchedule() {
        window._postingScheduleChanged = triggerAutoSave;

        const addBtn = document.getElementById('btn-add-posting-time');
        if (addBtn) addBtn.addEventListener('click', () => {
            _addPostingTimeRow('09:00');
            triggerAutoSave();
        });

        const horizonEl = document.getElementById('posting-horizon-input');
        const statusEl  = document.getElementById('posting-horizon-status');
        if (horizonEl) {
            let horizonTimer = null;
            const setStatus = (msg, cls) => { if (statusEl) { statusEl.textContent = msg; statusEl.className = `text-sm font-semibold ${cls || ''}`; } };
            const saveHorizon = async () => {
                let days = parseInt(horizonEl.value, 10);
                if (!Number.isInteger(days)) return;
                days = Math.max(1, Math.min(30, days));
                horizonEl.value = days;
                setStatus('Saving…', 'text-gray-400');
                try {
                    const res = await fetch('/.netlify/functions/set-draft-horizon', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ assistantId: parseInt(assistantId), draftHorizonDays: days }),
                    });
                    if (res.ok) {
                        const out = await res.json().catch(() => ({}));
                        currentData.draftHorizonDays = days;
                        setStatus(out.gapFillEnqueued ? `✓ Saved — drafting ${out.gapFillEnqueued} new post${out.gapFillEnqueued === 1 ? '' : 's'}` : '✓ Saved', 'text-emerald-600');
                        setTimeout(() => setStatus(''), 4000);
                    } else {
                        setStatus('Save failed', 'text-red-500');
                    }
                } catch {
                    setStatus('Save failed', 'text-red-500');
                }
            };
            horizonEl.addEventListener('change', () => { clearTimeout(horizonTimer); horizonTimer = setTimeout(saveHorizon, 600); });
        }
    }

    // ── Load & hydrate ────────────────────────────────────────────
    try {
        const res = await fetch(`/.netlify/functions/get-assistant-context?id=${assistantId}`);
        if (res.status === 403) {
            const errBody = await res.json().catch(() => ({}));
            if (errBody.code === 'DPA_REQUIRED') {
                // Show blocking DPA acceptance modal — user cannot view assistant config until accepted
                const modal = document.getElementById('modal-dpa-required');
                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('flex');
                    // Wire up accept button with the assistantId so we can reload after acceptance
                    const acceptBtn = document.getElementById('btn-dpa-accept');
                    if (acceptBtn) acceptBtn.dataset.assistantId = assistantId;
                }
                return;
            }
            throw new Error('Failed to load');
        }
        if (!res.ok) throw new Error('Failed to load');
        currentData = await res.json();

        // Review-alert cadence for the Profile › Notifications panel (saved via
        // set-review-notif-prefs; stashed here so the panel doesn't refetch context).
        window._reviewNotifPreference = currentData.reviewNotifPreference || 'immediate';

        // Hero header
        const nameInput = document.getElementById('detail-name-input');
        if (nameInput) nameInput.value = currentData.name || 'Your Assistant';

        // Assistant Profile slide-over title — "[Name]'s Profile" (header button keeps its
        // static "Assistant Profile" label; the personalised title shows on the drawer home).
        window._assistantProfileTitle = (currentData.name || 'Your Assistant') + "'s Profile";
        const homeTitleEl = document.getElementById('brief-drawer-title');
        if (homeTitleEl && !document.body.classList.contains('brief-drawer-open')) {
            homeTitleEl.textContent = window._assistantProfileTitle;
        }

        const avatarEl = document.getElementById('detail-avatar');
        if (avatarEl) avatarEl.textContent = (currentData.name || 'A').charAt(0).toUpperCase();

        const roleEl = document.getElementById('detail-role');
        if (roleEl) roleEl.textContent = currentData.role || 'Digital Assistant';

        // Status pill (Epic 1 AC1.1.2). Cache the record so the pill can re-render
        // reactively when operational signals (active jobs / pending reviews) arrive.
        window._detailCurrentData = currentData;
        window._renderStatusPill(currentData);

        // US6 AC5.1: Archive Assistant — stops it and removes it from the active workspace.
        // Issue #191: no longer immediately permanent — a 14-day reinstate window follows.
        const archiveBtn = document.getElementById('btn-archive-assistant');
        if (archiveBtn) archiveBtn.onclick = async () => {
            const name = currentData.name || 'this assistant';
            const message = `Archive "${name}"? This stops the assistant and removes it from your active workspace. You'll have 14 days to reinstate it (subject to your plan's assistant limit) before it and all of its data are permanently deleted.`;
            const doArchive = async () => {
                archiveBtn.disabled = true;
                try {
                    const r = await fetch(`/.netlify/functions/manage-assistant?id=${assistantId}`, { method: 'DELETE' });
                    if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || 'Failed to archive assistant.'); archiveBtn.disabled = false; return; }
                    window.showToast?.('Assistant archived.');
                    window.loadView?.('dashboard');
                } catch { alert('Network error — please try again.'); archiveBtn.disabled = false; }
            };
            if (window.showConfirmModal) {
                window.showConfirmModal(message, doArchive, { title: 'Archive assistant?', confirmLabel: 'Yes, archive', cancelLabel: 'Keep assistant' });
            } else if (confirm(message)) {
                await doArchive();
            }
        };

        // Issue #191: an archived assistant can't be archived or paused/resumed again — hide
        // both "More actions" entries and show a reinstate banner with the countdown instead
        // (below). The banner's own button is the one live path back from archived.
        const isArchived = currentData.lifecycleStatus === 'archived';
        if (archiveBtn) archiveBtn.classList.toggle('hidden', isArchived);
        document.getElementById('btn-toggle-status')?.classList.toggle('hidden', isArchived);
        // Both entries are hidden when archived, so the "…" trigger has nothing left to open.
        document.getElementById('btn-more-actions')?.classList.toggle('hidden', isArchived);

        // Issue #191 — Safe Archiving reinstate window: archived assistants are reachable only
        // via the archive notification's deep link (they're filtered out of the "My Assistants"
        // grid), so this banner is the one place a user can reinstate one within its 14-day
        // window, gated server-side on the plan's assistant limit (manage-assistant.ts).
        const existingArchivedBanner = document.getElementById('archived-assistant-banner');
        if (existingArchivedBanner) existingArchivedBanner.remove();
        if (currentData.lifecycleStatus === 'archived') {
            const deletionAt = currentData.scheduledDeletionAt ? new Date(currentData.scheduledDeletionAt) : null;
            const daysLeft = deletionAt ? Math.max(0, Math.ceil((deletionAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : null;
            const deletionLabel = deletionAt ? deletionAt.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null;
            const banner = document.createElement('div');
            banner.id = 'archived-assistant-banner';
            banner.className = 'mx-4 mt-4 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3';
            banner.innerHTML = `
                <span class="text-2xl flex-shrink-0">🗄️</span>
                <div class="flex-1">
                    <p class="text-sm font-bold text-red-800">This assistant is archived.</p>
                    <p class="text-sm text-red-700 mt-0.5">
                        ${daysLeft !== null
                            ? `You have ${daysLeft} day${daysLeft === 1 ? '' : 's'} left (until ${deletionLabel}) to reinstate it, subject to your plan's assistant limit.`
                            : `You have a limited time to reinstate it, subject to your plan's assistant limit.`}
                        After that, this assistant and all of its associated data will be permanently deleted — this cannot be undone.
                    </p>
                    <button type="button" id="btn-reinstate-assistant" class="mt-2.5 px-4 py-2 text-sm font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors cursor-pointer">
                        Reinstate assistant
                    </button>
                </div>`;
            const detailEl = document.getElementById('assistant-detail-view') || document.getElementById('content-container');
            if (detailEl) detailEl.prepend(banner);

            const reinstateBtn = document.getElementById('btn-reinstate-assistant');
            if (reinstateBtn) reinstateBtn.onclick = async () => {
                reinstateBtn.disabled = true;
                const original = reinstateBtn.textContent;
                reinstateBtn.textContent = 'Reinstating…';
                try {
                    const r = await fetch(`/.netlify/functions/manage-assistant?id=${assistantId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'reinstate' }),
                    });
                    if (!r.ok) {
                        const d = await r.json().catch(() => ({}));
                        alert(d.error || 'Failed to reinstate assistant.');
                        reinstateBtn.disabled = false;
                        reinstateBtn.textContent = original;
                        return;
                    }
                    window.showToast?.('Assistant reinstated.');
                    window.routeToAssistantDetail?.(assistantId);
                } catch {
                    alert('Network error — please try again.');
                    reinstateBtn.disabled = false;
                    reinstateBtn.textContent = original;
                }
            };
        }

        // US-ADM-4.1.1: Show deprecation banner if assistant's master role is deprecated
        const existingBanner = document.getElementById('deprecated-assistant-banner');
        if (existingBanner) existingBanner.remove();
        if (currentData.lifecycleState === 'deprecated') {
            const banner = document.createElement('div');
            banner.id = 'deprecated-assistant-banner';
            banner.className = 'mx-4 mt-4 p-4 bg-orange-50 border border-orange-200 rounded-xl flex items-start gap-3';
            banner.innerHTML = `
                <span class="text-2xl flex-shrink-0">⚠️</span>
                <div class="flex-1">
                    <p class="text-sm font-bold text-orange-800">This assistant is being retired.</p>
                    <p class="text-sm text-orange-700 mt-0.5">
                        This assistant role will be archived soon and may lose functionality.
                        ${currentData.replacementAssistantId
                            ? `A recommended replacement is available — <a href="#" onclick="window.routeToAssistantDetail && window.routeToAssistantDetail(${currentData.replacementAssistantId}); return false;" class="underline font-semibold">switch now</a>.`
                            : 'Contact support for guidance on migrating your workflows.'}
                    </p>
                </div>`;
            // Insert before main content area or at top of detail container
            const detailEl = document.getElementById('assistant-detail-view') || document.getElementById('content-container');
            if (detailEl) detailEl.prepend(banner);
        }

        // Set window.cachedContext so fetchAndRenderIntegrations can use it
        window.cachedContext = currentData.context || {};

        // Role-aware dashboard: KPI card copy + social-only module visibility
        // (must run before attachAutoSave so the operational-setup editor inputs exist).
        _applyDashboardRegistry(currentData);
        _detailHydrate(currentData);
        _renderMandateSuggestions(currentData);
        _renderOnboardingSummary(currentData);
        _renderOutreachEmailConnect(currentData);
        _renderOperationSection(currentData);
        _renderMeetingsBrief(currentData);
        _hydrateAutonomousToggle(currentData);
        attachAutoSave();
        _wirePostingSchedule();
        _renderKickOff(assistantId);
        window._initReviewMeetings?.(assistantId);

        // Deep-link (continued from above): review-queue/datahub/calendar main tabs read
        // window._detailReviewQueue (just set by _applyDashboardRegistry above) and other
        // data hydrated here, so they're only safe to activate now — e.g. chat's "View in
        // Review Queue" link (chat-session.js / workspace.html's ?view=assistant-detail&tab=)
        // must not fire detailRqOpenStatus() before _detailReviewQueue.kind is known, or a
        // records-backed queue would render with the wrong (default 'posts') renderer.
        if (window._assistantDetailInitialTab) {
            const wanted = window._assistantDetailInitialTab;
            window._assistantDetailInitialTab = null;
            if (document.querySelector(`.main-tab-btn[data-maintab="${wanted}"]`)) {
                window._activateMainTab?.(wanted);
            } else {
                const target = document.querySelector(`.detail-tab-btn[data-tab="${wanted}"]`);
                if (target) target.click();
            }
        }
    } catch (e) {
        console.error('Failed to load assistant detail:', e);
    } finally {
        // Issue #177 follow-up: reveal the real (now role-correct) markup and drop the generic
        // loading skeleton — runs on success, failure, and the DPA-required early return alike,
        // so the skeleton never gets stuck showing.
        document.getElementById('assistant-detail-skeleton')?.classList.add('hidden');
        document.getElementById('assistant-detail-content')?.classList.remove('hidden');
    }

    // ── Name generator ────────────────────────────────────────────
    const genBtn = document.getElementById('btn-generate-name');
    if (genBtn) {
        genBtn.addEventListener('click', () => {
            // Brief "casting" flourish so the click registers as an action even though it's instant.
            const wandImg = genBtn.querySelector('img');
            if (wandImg) {
                wandImg.classList.add('is-casting');
                setTimeout(() => wandImg.classList.remove('is-casting'), 600);
            }
            _namePoolIdx = (_namePoolIdx + 1) % _namePool.length;
            const nameInput = document.getElementById('detail-name-input');
            if (nameInput) {
                nameInput.value = _namePool[_namePoolIdx];
                triggerAutoSave();
            }
        });
    }

    // ── Impact & ROI metrics card — fetched first so the card is visible before
    //    Completed Tasks loads, preserving the DOM order on first render. ─────
    await _fetchAndRenderAssistantMetrics(assistantId);

    // ── Recent Activity ───────────────────────────────────────────
    const activityList = document.getElementById('recent-activity-list');
    if (activityList) {
        const loadActivity = async (timeframe = '1d') => {
        // update button styles
        document.querySelectorAll('.activity-tf-btn').forEach(btn => {
            const active = btn.dataset.tf === timeframe;
            btn.className = `activity-tf-btn text-xs px-2.5 py-1 rounded-lg border ${active ? 'border-indigo-500 bg-indigo-50 text-indigo-700 font-semibold' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`;
        });
        activityList.innerHTML = '<div class="h-10 bg-gray-50 rounded-lg border border-dashed border-gray-200 flex items-center justify-center text-sm text-gray-400">Loading activity…</div>';
        try {
            const res = await fetch(`/.netlify/functions/get-assistant-activity?id=${assistantId}&timeframe=${timeframe}`);
            if (res.ok) {
                const { logs, activeJobCount } = await res.json();
                // Feed the operational status pill (Epic 1 AC1.1.2): mid-flight jobs → "Executing Task".
                window._updateOpSignals?.({ activeJobCount: activeJobCount || 0 });
                if (logs && logs.length > 0) {
                    const iconSvg = (icon) => {
                        const icons = {
                            sparkles: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"/></svg>`,
                            'check-circle': `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
                            check: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`,
                            calendar: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
                            clock: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
                            lightbulb: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>`,
                            image: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
                            video: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
                            users: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path stroke-linecap="round" stroke-linejoin="round" d="M23 21v-2a4 4 0 00-3-3.87"/><path stroke-linecap="round" stroke-linejoin="round" d="M16 3.13a4 4 0 010 7.75"/></svg>`,
                            settings: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path stroke-linecap="round" stroke-linejoin="round" d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
                            edit: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>`,
                            alert: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`,
                            x: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
                            rocket: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.82m5.84-2.56a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.82m2.56-5.84a14.98 14.98 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z"/></svg>`,
                            shield: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>`,
                            link: `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>`,
                        };
                        return icons[icon] || icons.settings;
                    };
                    const iconBg = (icon) => {
                        const map = {
                            sparkles: 'bg-violet-100 text-violet-600',
                            'check-circle': 'bg-emerald-100 text-emerald-600',
                            check: 'bg-emerald-100 text-emerald-600',
                            calendar: 'bg-blue-100 text-blue-600',
                            clock: 'bg-amber-100 text-amber-600',
                            lightbulb: 'bg-yellow-100 text-yellow-600',
                            image: 'bg-pink-100 text-pink-600',
                            video: 'bg-pink-100 text-pink-600',
                            users: 'bg-teal-100 text-teal-600',
                            settings: 'bg-gray-100 text-gray-500',
                            edit: 'bg-indigo-100 text-indigo-600',
                            alert: 'bg-red-100 text-red-500',
                            x: 'bg-gray-100 text-gray-400',
                            rocket: 'bg-emerald-100 text-emerald-600',
                            shield: 'bg-blue-100 text-blue-600',
                            link: 'bg-purple-100 text-purple-600',
                        };
                        return map[icon] || 'bg-gray-100 text-gray-500';
                    };
                    // Status tag (Epic 2.2). Info/neutral rows get no tag to keep the history clean.
                    const statusTag = (s) => {
                        const tags = {
                            success:     ['Success',     'bg-emerald-100 text-emerald-700'],
                            failed:      ['Failed',      'bg-red-100 text-red-700'],
                            needs_input: ['Needs Input', 'bg-amber-100 text-amber-700'],
                            in_progress: ['In Progress', 'bg-blue-100 text-blue-700'],
                        };
                        const t = tags[s];
                        return t ? `<span class="shrink-0 px-2 py-0.5 rounded-full text-xs font-bold ${t[1]}">${t[0]}</span>` : '';
                    };
                    // Attention rows (failed / needs_input) get an inline tint + coloured left edge
                    // (inline style avoids the prebuilt-CSS arbitrary-class gotcha).
                    const rowHtml = (log, attention) => {
                        const tint = log.status === 'failed' ? 'background:#fef2f2;border-left:3px solid #f87171'
                                   : log.status === 'needs_input' ? 'background:#fffbeb;border-left:3px solid #fbbf24' : '';
                        // Epic 3.1 entry point: attention rows tied to a post get a "Tune" affordance.
                        const postMatch = log.type === 'scheduled_post' && /^post-(\d+)$/.exec(log.id || '');
                        const tuneBtn = (attention && postMatch)
                            ? `<button type="button" onclick="window._openTuningSession({ postId:${Number(postMatch[1])} })" class="mt-1 inline-flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-800 transition cursor-pointer">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"/></svg>Tune</button>`
                            : '';
                        return `
                        <div class="flex items-start gap-3 py-2.5 px-2 rounded-lg border-b border-gray-100 last:border-0"${attention ? ` style="${tint}"` : ''}>
                            <div class="w-6 h-6 rounded-full ${iconBg(log.icon)} flex items-center justify-center shrink-0 mt-0.5">${iconSvg(log.icon)}</div>
                            <div class="flex-1 min-w-0">
                                <div class="flex items-start justify-between gap-2">
                                    <p class="text-sm text-gray-700">${log.description || log.actionType}</p>
                                    ${statusTag(log.status)}
                                </div>
                                <p class="text-xs text-gray-400 mt-0.5">${log.createdAt ? new Date(log.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</p>
                                ${tuneBtn}
                            </div>
                        </div>`;
                    };
                    const sectionLabel = (txt) => `<p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1.5">${txt}</p>`;
                    // Pin Failed + Needs-Input into a "Needs attention" group above the chronological list.
                    const attention = logs.filter(l => l.status === 'failed' || l.status === 'needs_input');
                    const rest = logs.filter(l => l.status !== 'failed' && l.status !== 'needs_input');
                    let html = '';
                    if (attention.length) html += sectionLabel('Needs attention') + attention.map(l => rowHtml(l, true)).join('');
                    if (rest.length) {
                        if (attention.length) html += '<div class="h-4"></div>';
                        html += sectionLabel('Recent') + rest.map(l => rowHtml(l, false)).join('');
                    }
                    activityList.innerHTML = html || '<p class="text-sm text-gray-400 text-center py-3">No activity yet.</p>';
                } else {
                    activityList.innerHTML = '<p class="text-sm text-gray-400 text-center py-3">No activity yet — your assistant is ready to get to work.</p>';
                }
            } else {
                activityList.innerHTML = '<p class="text-sm text-gray-400 text-center py-3">No activity yet.</p>';
            }
        } catch {
            activityList.innerHTML = '<p class="text-sm text-gray-400 text-center py-3">No activity yet.</p>';
        }
        }; // end loadActivity

        document.querySelectorAll('.activity-tf-btn').forEach(btn => {
            btn.addEventListener('click', () => loadActivity(btn.dataset.tf));
        });
        await loadActivity('1d');
    }

    // ── Impact & ROI metrics card — fire immediately so it appears at the top of
    // Overview without waiting behind connections/integrations/goals fetches ──────
    _fetchAndRenderAssistantMetrics(assistantId);

    // ── Performance Metrics (post_insights aggregation) ───────────
    await _loadAssistantMetrics(assistantId);

    // ── Connections (full connect/manage UI, scoped to this assistant) ──
    await window.initAssistantConnections(assistantId, currentData);
    // Synced actions — this assistant's Integration Scenario Library recipes, in the same tab.
    // Reads relevance from window._detailReviewQueue.recordType (set by the dashboard registry).
    window.AssistantIntegrations?.init({ assistantId });
    // Now that supportedTools have loaded, fold them into "Your Onboarding Answers".
    _renderOnboardingConnections();

    // ── Integrations ──────────────────────────────────────────────
    await window.fetchAndRenderIntegrations();

    // ── Workspace defaults (Brand Profile) ────────────────────────
    await _fetchAndRenderWorkspaceDefaults(assistantId, currentData, triggerAutoSave);

    // ── Per-assistant Assistant Rules (content_rules → this assistant's brief) ──
    await _fetchAndRenderAssistantRules(assistantId);

    // ── Learned Directives (issue #113: lives alongside Assistant Rules) ──
    window._renderRunbookDirectives?.(assistantId);

    // ── SMART Goals (Feature 1) ───────────────────────────────────
    await _fetchAndRenderGoals(assistantId);

    // ── AC6: Daily Relationship-Building Checklist ────────────────
    // Hidden — belongs to a future Engagement/CTA assistant, not SMM.
    // await _fetchAndRenderRelationshipChecklist(assistantId);

    // ── Review Queue tab — prefetch pending count so the badge shows without opening the tab ──
    _prefetchDetailRqBadge(assistantId);

    // ── Epic 4.2 — Active Workflows dependency map (always shown; empty state when no links) ──
    window._renderActiveWorkflows?.(assistantId);
};

async function _prefetchDetailRqBadge(assistantId) {
    const rq = window._detailReviewQueue || {};
    try {
        let count = 0;
        if (rq.kind === 'records' && rq.recordType) {
            // Records-backed queue (data-hub roles): count assistant_records awaiting approval.
            const res = await fetch(`/.netlify/functions/assistant-records?assistantId=${assistantId}&recordType=${encodeURIComponent(rq.recordType)}&approvalStatus=pending_approval`);
            if (!res.ok) return;
            count = ((await res.json()).records || []).length;
        } else if (rq.source === 'blog_posts') {
            // Blog Writer: count long-form drafts awaiting review.
            const res = await fetch(`/.netlify/functions/blog-posts?assistantId=${assistantId}`);
            if (!res.ok) return;
            const wanted = new Set(['draft', 'pending_approval', 'in_review']);
            count = ((await res.json()).posts || []).filter((p) => wanted.has(p.status)).length;
        } else {
            const res = await fetch(`/.netlify/functions/get-social-drafts?status=pending_approval&assistantId=${assistantId}`);
            if (!res.ok) return;
            count = ((await res.json()).drafts || []).length;
        }
        const tabBadge = document.getElementById('detail-rq-pending-badge');
        if (tabBadge) { tabBadge.textContent = count || ''; tabBadge.classList.toggle('hidden', !count); }
        // Action bar (Epic 2.1): "Review Pending Items" count badge — amber when there's work waiting.
        window._setReviewPendingBadge?.(count);
        // Feed the operational status pill (Epic 1 AC1.1.2): pending drafts → "Awaiting Human Review".
        window._updateOpSignals?.({ pendingReview: count });
    } catch { /* non-critical */ }
}

// ─────────────────────────────────────────────────────────────────
// Impact & ROI metrics — per-assistant post counts + time/money saved.
// ─────────────────────────────────────────────────────────────────
// Default to 'month', not 'week': the calendar week resets hard at the Sunday
// boundary, so for many hours after each rollover an assistant with real
// historical activity legitimately has nothing yet in the brand-new week
// window and this card reads as "broken" (0 hours/£ saved) despite the
// all-time post counts above it being nonzero. The dashboard hero widget
// hit the identical issue (#132) and was fixed the same way — see the
// matching comment in dashboard-content.html.
async function _fetchAndRenderAssistantMetrics(assistantId, period = 'month') {
    const card = document.getElementById('assistant-metrics-card');
    if (!card) return;
    // Non-social roles have no post-based ROI — the registry marks the card role-hidden; respect it.
    if (card.dataset.roleHidden === '1') return;

    // Period toggle — mirrors the dashboard hero's This Week / This Month tabs so
    // the hours/£ figures here are always comparable with whichever view the
    // dashboard is showing.
    card.querySelectorAll('.metrics-period-btn').forEach(btn => {
        const active = btn.dataset.period === period;
        btn.className = `metrics-period-btn px-3 py-1.5 text-xs font-bold rounded-lg transition ${active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`;
        btn.setAttribute('aria-selected', String(active));
        btn.onclick = active ? null : () => _fetchAndRenderAssistantMetrics(assistantId, btn.dataset.period);
    });

    try {
        const res = await fetch(`/.netlify/functions/get-assistant-metrics?id=${assistantId}&period=${period}`);
        if (!res.ok) return;
        const d = await res.json();

        // Gate on any real ROI signal, not just post creation — hoursSaved already accounts for
        // completed task runs (see get-assistant-metrics.ts), so a task-driven assistant that
        // hasn't created any scheduledPosts yet still surfaces the card once it's done work.
        if (!d.totalCreated && !d.hoursSaved) return; // no recorded activity yet — keep card hidden
        if (card.dataset.roleHidden === '1') return;  // role-hidden set while we were awaiting — respect it

        card.classList.remove('hidden');

        const el = id => document.getElementById(id);
        const periodLabel = period === 'month' ? 'this month' : 'this week';
        el('metrics-period-note').textContent = `All-time posts created by this assistant; time & money saved ${periodLabel} (matches the dashboard's ${period === 'month' ? 'This Month' : 'This Week'} view)`;
        el('metrics-total-created').textContent = d.totalCreated.toLocaleString();
        el('metrics-total-scheduled').textContent = d.totalScheduled.toLocaleString();
        el('metrics-total-published').textContent = d.totalPublished.toLocaleString();
        el('metrics-hours-saved').textContent = `~${d.hoursSaved}h`;
        if (d.minutesPerPost != null) el('metrics-hours-note').textContent = `Based on ~${d.minutesPerPost} min per post`;

        if (d.gbpSaved !== null) {
            el('metrics-gbp-saved').textContent = `£${d.gbpSaved.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
            el('metrics-roi-note').textContent = `At your configured hourly rate`;
        } else {
            el('metrics-gbp-saved').textContent = '—';
            el('metrics-roi-note').innerHTML = `<a href="#" onclick="loadView && loadView('account'); return false" class="text-emerald-600 hover:underline">Set your hourly rate</a> to see £ ROI`;
        }

        // Per-platform breakdown table
        const platformEl = el('metrics-by-platform');
        if (platformEl && d.byPlatform) {
            const rows = Object.entries(d.byPlatform)
                .filter(([, v]) => v.created > 0)
                .sort(([, a], [, b]) => b.created - a.created)
                .map(([p, v]) => {
                    const icon = (window._PLATFORM_ICONS || {})[p] || '';
                    const label = (window._PLATFORM_LABEL || {})[p] || p.charAt(0).toUpperCase() + p.slice(1);
                    const pct = d.totalCreated > 0 ? Math.round((v.published / d.totalCreated) * 100) : 0;
                    return `<div class="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
                        <div class="flex items-center gap-2 text-sm font-semibold text-gray-700">
                            <span class="text-gray-400">${icon}</span>${label}
                        </div>
                        <div class="flex items-center gap-4 text-xs font-semibold">
                            <span class="text-gray-500">${v.created} created</span>
                            <span class="text-blue-600">${v.scheduled} scheduled</span>
                            <span class="text-emerald-600">${v.published} published</span>
                        </div>
                    </div>`;
                }).join('');
            platformEl.innerHTML = rows || '<p class="text-xs text-gray-400">No platform data yet.</p>';
        }
    } catch {
        // silently skip — metrics are supplementary
    }
}

// ─────────────────────────────────────────────────────────────────
// AC6: Daily Relationship-Building Checklist — loads today's actions, renders
// tickable items, persists completion. The card stays hidden for non-social
// assistants (the endpoint returns 403 CONNECTION_NOT_RELEVANT).
// ─────────────────────────────────────────────────────────────────
async function _fetchAndRenderRelationshipChecklist(assistantId) {
    const card = document.getElementById('relationship-checklist-card');
    const list = document.getElementById('rbc-list');
    if (!card || !list) return;
    window._rbcAssistantId = assistantId;
    try {
        const res = await fetch(`/.netlify/functions/relationship-checklist?assistantId=${assistantId}`);
        if (!res.ok) { card.classList.add('hidden'); return; }  // 403 for non-social assistants → stay hidden
        const data = await res.json();
        card.classList.remove('hidden');
        _rbcRender(data.items || []);
    } catch {
        card.classList.add('hidden');
    }
}

function _rbcRender(items) {
    const list = document.getElementById('rbc-list');
    const progress = document.getElementById('rbc-progress');
    if (!list) return;
    if (!items.length) {
        list.innerHTML = '<p class="text-sm text-gray-400 text-center py-3">No checklist items today.</p>';
        if (progress) progress.textContent = '';
        return;
    }
    const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const CAT = {
        engagement: { label: 'Engage', cls: 'bg-emerald-50 text-emerald-700' },
        outreach:   { label: 'Outreach', cls: 'bg-blue-50 text-blue-700' },
        community:  { label: 'Community', cls: 'bg-violet-50 text-violet-700' },
        follow_up:  { label: 'Follow-up', cls: 'bg-amber-50 text-amber-700' },
    };
    list.innerHTML = items.map(item => {
        const cat = CAT[item.category];
        const badge = cat ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${cat.cls} shrink-0">${cat.label}</span>` : '';
        return `<label class="flex items-start gap-3 p-3 rounded-lg border border-gray-100 hover:border-emerald-200 transition cursor-pointer" id="rbc-item-${item.id}">
            <input type="checkbox" ${item.completed ? 'checked' : ''} onchange="window._rbcToggle(${item.id}, this.checked)" class="mt-0.5 w-4 h-4 text-emerald-600 rounded focus:ring-emerald-500 cursor-pointer">
            <span class="flex-1 min-w-0">
                <span class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-semibold ${item.completed ? 'text-gray-400 line-through' : 'text-gray-800'}" id="rbc-title-${item.id}">${esc(item.title)}</span>
                    ${badge}
                </span>
                ${item.description ? `<span class="block text-xs text-gray-500 mt-0.5">${esc(item.description)}</span>` : ''}
            </span>
        </label>`;
    }).join('');
    _rbcUpdateProgress(items);
    window._rbcItems = items;
}

function _rbcUpdateProgress(items) {
    const progress = document.getElementById('rbc-progress');
    if (!progress) return;
    const done = items.filter(i => i.completed).length;
    progress.textContent = `${done} of ${items.length} done${done === items.length ? ' — nice work! 🎉' : ''}`;
}

window._rbcToggle = async function (taskId, completed) {
    // Optimistic UI: update title styling + progress immediately, persist in the background.
    const titleEl = document.getElementById(`rbc-title-${taskId}`);
    if (titleEl) {
        titleEl.classList.toggle('line-through', completed);
        titleEl.classList.toggle('text-gray-400', completed);
        titleEl.classList.toggle('text-gray-800', !completed);
    }
    const item = (window._rbcItems || []).find(i => i.id === taskId);
    if (item) { item.completed = completed; _rbcUpdateProgress(window._rbcItems); }
    try {
        const res = await fetch('/.netlify/functions/relationship-checklist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId, completed }),
        });
        if (!res.ok) throw new Error('save failed');
    } catch {
        // Revert on failure.
        const cb = document.querySelector(`#rbc-item-${taskId} input[type=checkbox]`);
        if (cb) cb.checked = !completed;
        if (titleEl) {
            titleEl.classList.toggle('line-through', !completed);
            titleEl.classList.toggle('text-gray-400', !completed);
            titleEl.classList.toggle('text-gray-800', completed);
        }
        if (item) { item.completed = !completed; _rbcUpdateProgress(window._rbcItems); }
        window.showToast?.('Could not save — please try again.');
    }
};

window._rbcRegenerate = async function () {
    const assistantId = window._rbcAssistantId;
    if (!assistantId) return;
    const btn = document.getElementById('rbc-regenerate-btn');
    const list = document.getElementById('rbc-list');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
    if (list) list.innerHTML = '<div class="h-10 bg-gray-50 rounded-lg border border-dashed border-gray-200 flex items-center justify-center text-sm text-gray-400">Generating a fresh checklist…</div>';
    try {
        const res = await fetch('/.netlify/functions/relationship-checklist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistantId, regenerate: true }),
        });
        const data = await res.json();
        if (data.ok) _rbcRender(data.items || []);
        else window.showToast?.(data.error || 'Could not regenerate the checklist.');
    } catch {
        window.showToast?.('Network error — please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Regenerate'; }
    }
};

// ─────────────────────────────────────────────────────────────────
// Kick Off Meeting — readiness checklist + activation gate. Fetches
// get-assistant-readiness and renders the checklist; the Kick Off button is
// enabled only when all required items pass and the assistant isn't already
// working. Clicking it activates the assistant via manage-assistant (resume).
// ─────────────────────────────────────────────────────────────────
async function _renderKickOff(assistantId) {
    const card      = document.getElementById('kickoff-card');
    const listEl    = document.getElementById('kickoff-checklist');
    const btn       = document.getElementById('btn-kick-off');
    const hintEl    = document.getElementById('kickoff-hint');
    const subEl     = document.getElementById('kickoff-subtitle');
    if (!card || !listEl || !btn) return;

    card.classList.remove('hidden');

    // Collapsible body — wire the chevron toggle once; the default open/closed state is
    // set per branch below (working assistants start collapsed to keep the page tidy).
    const bodyEl   = document.getElementById('kickoff-body');
    const toggleEl = document.getElementById('kickoff-toggle');
    const chevron  = document.getElementById('kickoff-chevron');
    const setCollapsed = (collapsed) => {
        if (!bodyEl) return;
        bodyEl.classList.toggle('hidden', collapsed);
        if (chevron) chevron.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
        if (toggleEl) toggleEl.setAttribute('aria-expanded', String(!collapsed));
    };
    if (toggleEl && !toggleEl.dataset.wired) {
        toggleEl.dataset.wired = '1';
        toggleEl.addEventListener('click', () => setCollapsed(!bodyEl.classList.contains('hidden')));
    }
    // Default expanded; the working branch below overrides to collapsed.
    setCollapsed(false);

    let data;
    try {
        const res = await fetch(`/.netlify/functions/get-assistant-readiness?id=${assistantId}`);
        if (!res.ok) { card.classList.add('hidden'); return; }
        data = await res.json();
    } catch { card.classList.add('hidden'); return; }

    // US5 AC5.2: system_paused → red "Attention Required" diagnostic + targeted fix CTA,
    // replacing the normal kick-off flow (the kick-off endpoint also 409s on system_paused).
    if (data.attention) {
        const attn = data.attention;
        const CONN_LABELS = { x: 'X (Twitter)', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn' };
        const svc = (attn.services || []).map(s => CONN_LABELS[s] || (s.charAt(0).toUpperCase() + s.slice(1)));
        let reason, ctaLabel, ctaKind;
        if (attn.kind === 'connection') {
            reason = `Reconnect ${svc.join(', ')} to put this assistant back to work.`;
            ctaLabel = `Reconnect ${svc[0] || 'account'}`; ctaKind = 'platforms';
        } else if (attn.kind === 'billing') {
            reason = 'Your subscription needs attention before this assistant can run.';
            ctaLabel = 'Fix Billing'; ctaKind = 'billing';
        } else if (attn.kind === 'limit') {
            reason = "This assistant is paused because your plan's assistant limit was exceeded.";
            ctaLabel = 'Manage Plan'; ctaKind = 'billing';
        } else {
            reason = 'This assistant needs attention before it can run again.';
            ctaLabel = 'Review Connections'; ctaKind = 'platforms';
        }
        subEl.textContent = 'Attention required — resolve the issue below to resume.';
        listEl.innerHTML = '';
        const panel = document.getElementById('kickoff-summary');
        if (panel) {
            panel.className = 'mb-5 p-4 rounded-xl bg-red-50 border border-red-200';
            panel.innerHTML = `
                <p class="text-xs font-bold text-red-500 uppercase tracking-wider mb-1">⚠ Attention required</p>
                <p class="text-sm font-semibold text-red-800 mb-3">${reason}</p>
                <button type="button" id="btn-fix-attention" class="px-4 py-2 text-sm font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-sm transition cursor-pointer">${ctaLabel}</button>`;
            const fix = document.getElementById('btn-fix-attention');
            if (fix) fix.onclick = () => {
                if (ctaKind === 'billing') window.loadView?.('billing');
                else document.querySelector('.detail-tab-btn[data-tab="platforms"]')?.click();
            };
        }
        btn.classList.add('hidden');
        hintEl.textContent = '';
        return;
    }

    // A compliance gate blocked provisioning → amber "Action Required" panel + Retry, replacing the
    // normal kick-off flow (kickoff-assistant also 409s with PROVISIONING_BLOCKED). Once the user
    // satisfies the precondition, retry re-fires provisioning and the assistant advances.
    if (data.blocked) {
        const b = data.blocked;
        subEl.textContent = 'Action required before this assistant can start.';
        const panel = document.getElementById('kickoff-summary');
        if (panel) {
            panel.className = 'mb-5 p-4 rounded-xl bg-red-50 border border-red-200';
            panel.innerHTML = `
                <p class="text-xs font-bold text-red-500 uppercase tracking-wider mb-1">⚠ ${b.title || 'Action required'}</p>
                <p class="text-sm font-semibold text-red-800 mb-3">${b.message || 'An action is needed before setup can finish.'}</p>
                <button type="button" id="btn-retry-prov" class="px-4 py-2 text-sm font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shadow-sm transition cursor-pointer">${b.cta || 'Retry'} &amp; retry</button>`;
            const r = document.getElementById('btn-retry-prov');
            if (r) r.onclick = () => window.retryProvisioning?.(assistantId, r, () => _renderKickOff(assistantId));
        }
        // Render the checklist inline so the user sees exactly which gates failed — incomplete
        // items as red rows (rather than the normal gray-cross/green-tick neutral flow).
        const bItems = data.items || [];
        const bTick = `<svg class="w-4 h-4 text-emerald-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>`;
        const bCross = `<svg class="w-4 h-4 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-width="2"/><path stroke-linecap="round" stroke-width="2.5" d="M9 9l6 6m0-6l-6 6"/></svg>`;
        listEl.innerHTML = bItems.map(it => `
            <li class="flex items-start gap-3">
                ${it.done ? bTick : bCross}
                <span class="min-w-0">
                    <span class="block text-sm font-semibold ${it.done ? 'text-gray-800' : 'text-red-700'}">${it.label}${it.required ? '' : ' <span class="text-xs font-normal text-gray-400">(recommended)</span>'}</span>
                    ${it.done ? '' : `<span class="block text-xs text-red-500 mt-0.5">${it.hint || ''}${it.key === 'disclosure' ? ' <button type="button" onclick="window._goToDisclosureField()" class="text-emerald-600 hover:underline cursor-pointer font-semibold">Open Guardrails tab →</button>' : ''}</span>`}
                </span>
            </li>`).join('') || '';
        btn.classList.add('hidden');
        hintEl.textContent = '';
        return;
    }

    const items = data.items || [];
    const tick = `<svg class="w-4 h-4 text-emerald-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>`;
    const cross = `<svg class="w-4 h-4 text-gray-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-width="2"/></svg>`;

    window._goToDisclosureField = function() {
        document.querySelector('.detail-tab-btn[data-tab="guardrails"]')?.click();
        setTimeout(() => {
            const el = document.getElementById('edit_ai_disclosure');
            if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
        }, 120);
    };

    listEl.innerHTML = items.map(it => `
        <li class="flex items-start gap-3">
            ${it.done ? tick : cross}
            <span class="min-w-0">
                <span class="block text-sm font-semibold ${it.done ? 'text-gray-800' : 'text-gray-500'}">${it.label}${it.required ? '' : ' <span class="text-xs font-normal text-gray-400">(recommended)</span>'}</span>
                ${it.done ? '' : `<span class="block text-xs text-gray-400 mt-0.5">${it.hint || ''}${it.key === 'disclosure' ? ' <button type="button" onclick="window._goToDisclosureField()" class="text-emerald-600 hover:underline cursor-pointer font-semibold">Open Guardrails tab →</button>' : ''}</span>`}
            </span>
        </li>`).join('') || '<li class="text-sm text-gray-400">No checklist items.</li>';

    // US3 AC3.1: summary — primary directive + active connections the user reviews before confirming.
    const summaryEl = document.getElementById('kickoff-summary');
    if (summaryEl) {
        const sm = data.summary || {};
        const CONN_LABELS = { x: 'X (Twitter)', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn' };
        const conns = (sm.connections || []);
        const connPills = conns.length
            ? conns.map(c => `<span class="inline-flex items-center gap-1 text-xs font-semibold text-gray-700 bg-white border border-gray-200 px-2 py-0.5 rounded-full">${CONN_LABELS[c] || (c.charAt(0).toUpperCase() + c.slice(1))}</span>`).join(' ')
            : '<span class="text-xs text-gray-400 italic">No connected accounts yet</span>';
        summaryEl.className = 'mb-5 p-4 rounded-xl bg-gray-50 border border-gray-100' + (data.working ? ' hidden' : '');
        summaryEl.innerHTML = `
            <p class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Primary directive</p>
            <p class="text-sm font-semibold text-gray-800 mb-3">${sm.directive || 'Digital Assistant'}</p>
            <p class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Active connections</p>
            <div class="flex flex-wrap gap-1.5">${connPills}</div>`;
    }

    // Overview kick-off CTA and tab badge — visible only until the assistant is working.
    const overviewCta  = document.getElementById('meetings-kickoff-cta');
    const meetingsBadge = document.getElementById('meetings-kickoff-badge');

    // Issue #115: once kicked off, the Kick Off Meeting card has done its job — its detail
    // (primary directive + connections) now lives in the notification sent by
    // kickoff-assistant.ts, and pausing a working assistant is already available from the
    // My Assistants grid (window._assistantTogglePause), so the card no longer needs to
    // linger here at all.
    if (data.working) {
        if (overviewCta)   overviewCta.classList.add('hidden');
        if (meetingsBadge) meetingsBadge.classList.add('hidden');
        card.classList.add('hidden');
        return;
    }

    // Not yet working — show the Overview CTA and badge so users notice the Meetings tab.
    if (overviewCta)   overviewCta.classList.remove('hidden');
    if (meetingsBadge) meetingsBadge.classList.remove('hidden');

    btn.classList.remove('hidden');
    const outstanding = items.filter(i => i.required && !i.done);
    if (data.allRequiredDone) {
        subEl.textContent = 'Everything is ready — kick off to put your assistant to work.';
        btn.disabled = false;
        hintEl.textContent = '';
    } else {
        subEl.textContent = 'A few things to confirm before your assistant can start working.';
        btn.disabled = true;
        hintEl.textContent = outstanding.length
            ? `Outstanding: ${outstanding.map(i => i.label).join(', ')}`
            : '';
    }

    // Wire the activation once (avoid stacking listeners across re-renders).
    btn.onclick = async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'Starting…';
        try {
            // US3 AC3.2/AC3.3: canonical kick-off — transitions ready_for_work → working via the
            // state-machine helper (server-side readiness gate + audit), then unlocks the assistant.
            const res = await fetch(`/.netlify/functions/kickoff-assistant?id=${assistantId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                alert(d.error || 'Could not start the assistant. Please check the checklist and try again.');
                btn.disabled = false;
                btn.textContent = original;
                return;
            }
            // Reflect the new working state: refresh the kick-off card + the status pill.
            window.showToast?.('Your assistant is now working! 🚀', { icon: '🚀' });
            window.fireConfetti?.();
            await _renderKickOff(assistantId);
            if (window._detailCurrentData) { window._detailCurrentData.lifecycleStatus = 'working'; window._detailCurrentData.isActive = true; }
            window._renderStatusPill?.();
        } catch {
            alert('Network error — please try again.');
            btn.disabled = false;
            btn.textContent = original;
        }
    };
}

// ─────────────────────────────────────────────────────────────────
// Meetings tab — Foundational Brief read-only snapshot
// ─────────────────────────────────────────────────────────────────
function _renderMeetingsBrief(data) {
    const card    = document.getElementById('meetings-brief-summary');
    const content = document.getElementById('meetings-brief-content');
    if (!card || !content) return;

    const ctx  = data.context      || {};
    const conf = data.configuration || {};
    const CONN_LABELS = { x: 'X (Twitter)', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn' };

    const rows = [];
    if (ctx.directive || ctx.problem)
        rows.push({ label: 'Primary Directive', value: ctx.directive || ctx.problem });
    if (data.role)
        rows.push({ label: 'Role', value: data.role });
    if (ctx.targetAudience)
        rows.push({ label: 'Target Audience', value: ctx.targetAudience });
    if (ctx.brandVoice)
        rows.push({ label: 'Brand Voice', value: ctx.brandVoice });
    const platforms = conf.platforms || [];
    if (platforms.length)
        rows.push({ label: 'Active Connections', value: platforms.map(p => CONN_LABELS[p] || p).join(', ') });

    if (!rows.length) { card.classList.add('hidden'); return; }

    content.innerHTML = rows.map(r => `
        <div class="border-t border-gray-100 pt-4 first:border-t-0 first:pt-0">
          <p class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">${r.label}</p>
          <p class="text-sm text-gray-800">${r.value}</p>
        </div>`).join('');
    card.classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────────
// Meetings tab — Review Meetings (localStorage-backed log per assistant)
// ─────────────────────────────────────────────────────────────────
(function () {
    let _reviewAssistantId = null;

    function _reviewKey() { return `review_meetings_${_reviewAssistantId}`; }

    function _loadReviews() {
        try { return JSON.parse(localStorage.getItem(_reviewKey()) || '[]'); } catch { return []; }
    }

    function _saveReviews(list) {
        localStorage.setItem(_reviewKey(), JSON.stringify(list));
    }

    function _renderHistory() {
        const host = document.getElementById('review-history');
        if (!host) return;
        const list = _loadReviews();
        if (!list.length) {
            host.innerHTML = '<p class="text-sm text-gray-400 text-center py-8">No review meetings logged yet.<br>Log your first review to track your assistant\'s progress over time.</p>';
            return;
        }
        const stars = (n) => '⭐'.repeat(Number(n));
        const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return iso; } };
        const STATUS_BADGE = {
            on_track:  { cls: 'bg-emerald-100 text-emerald-700', label: 'On Track' },
            at_risk:   { cls: 'bg-amber-100 text-amber-700',   label: 'At Risk' },
            off_track: { cls: 'bg-red-100 text-red-700',       label: 'Off Track' },
            achieved:  { cls: 'bg-blue-100 text-blue-700',     label: 'Achieved' },
        };
        host.innerHTML = list.slice().reverse().map((r, i) => {
            const idx = list.length - 1 - i;
            const goalChips = (r.goalStatuses || []).map(gs => {
                const b = STATUS_BADGE[gs.status] || { cls: 'bg-gray-100 text-gray-600', label: gs.status };
                return `<span class="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${b.cls}">${_escapeHtml(gs.label)}: ${b.label}</span>`;
            }).join('');
            const recs = (r.recommendations || []).map(t => `<li class="text-sm text-gray-700">${_escapeHtml(t)}</li>`).join('');
            const autoBadge = r.auto
                ? '<span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">Auto-logged</span>'
                : '';
            return `
            <div class="border border-gray-100 rounded-xl p-4 space-y-2.5">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="flex items-center gap-2">
                    <p class="text-sm font-bold text-gray-900">${fmtDate(r.date)}</p>
                    ${autoBadge}
                  </div>
                  <p class="text-xs text-gray-500 mt-0.5">${stars(r.rating)} ${['','Poor','Needs improvement','Satisfactory','Good','Excellent'][r.rating] || ''}</p>
                </div>
                <button onclick="window._deleteReviewMeeting(${idx})" class="text-xs text-gray-400 hover:text-red-500 transition cursor-pointer shrink-0">Remove</button>
              </div>
              ${r.agenda ? `<div><p class="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-0.5">Agenda</p><p class="text-sm text-gray-700 whitespace-pre-wrap">${_escapeHtml(r.agenda)}</p></div>` : ''}
              ${goalChips ? `<div class="flex flex-wrap gap-1.5">${goalChips}</div>` : ''}
              ${r.notes ? `<div><p class="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-0.5">Discussion</p><p class="text-sm text-gray-700 whitespace-pre-wrap">${_escapeHtml(r.notes)}</p></div>` : ''}
              ${r.outcomes ? `<div><p class="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-0.5">Outcomes &amp; Actions</p><p class="text-sm text-gray-700 whitespace-pre-wrap">${_escapeHtml(r.outcomes)}</p></div>` : ''}
              ${recs ? `<div><p class="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-0.5">Recommendations</p><ul class="list-disc list-inside space-y-0.5">${recs}</ul></div>` : ''}
              ${r.nextDate ? `<p class="text-xs text-gray-400 pt-1 border-t border-gray-50">Next review: <span class="font-semibold text-gray-600">${fmtDate(r.nextDate)}</span></p>` : ''}
            </div>`;
        }).join('');
    }

    window._initReviewMeetings = function (assistantId) {
        _reviewAssistantId = assistantId;
        // Default date to today
        const dateEl = document.getElementById('review-date');
        if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);
        _renderHistory();
    };

    window._openReviewForm = function () {
        const form = document.getElementById('review-form');
        if (!form) return;
        const dateEl = document.getElementById('review-date');
        if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
        const notesEl = document.getElementById('review-notes');
        if (notesEl) notesEl.value = '';
        const outcomesEl = document.getElementById('review-outcomes');
        if (outcomesEl) outcomesEl.value = '';
        const nextEl = document.getElementById('review-next');
        if (nextEl) nextEl.value = '';
        const ratingEl = document.getElementById('review-rating');
        if (ratingEl) ratingEl.value = '3';
        // Reset goal status selects
        document.querySelectorAll('#review-goals-checks select').forEach(s => { s.value = ''; });
        form.classList.remove('hidden');
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    window._closeReviewForm = function () {
        document.getElementById('review-form')?.classList.add('hidden');
    };

    window._saveReviewMeeting = function () {
        const date     = document.getElementById('review-date')?.value;
        const rating   = document.getElementById('review-rating')?.value || '3';
        const notes    = document.getElementById('review-notes')?.value?.trim() || '';
        const outcomes = document.getElementById('review-outcomes')?.value?.trim() || '';
        const next     = document.getElementById('review-next')?.value || '';
        if (!date) { window.showToast?.('Please select a meeting date.'); return; }
        // Capture goal statuses (only those explicitly set)
        const goalStatuses = [];
        document.querySelectorAll('#review-goals-checks select').forEach(s => {
            if (s.value) {
                const goalId = s.name.replace('goal_status_', '');
                const goal = (window._goalsCache || []).find(g => String(g.id) === goalId);
                if (goal) {
                    const { label } = window._goalMetricLabel?.(goal.metricKey) || { label: goal.metricKey };
                    goalStatuses.push({ goalId, label, status: s.value });
                }
            }
        });
        const list = _loadReviews();
        list.push({ date, rating: Number(rating), notes, outcomes, goalStatuses, nextDate: next, savedAt: new Date().toISOString() });
        _saveReviews(list);
        window._closeReviewForm();
        _renderHistory();
        window.showToast?.('Review meeting saved.');
    };

    window._deleteReviewMeeting = function (idx) {
        const list = _loadReviews();
        list.splice(idx, 1);
        _saveReviews(list);
        _renderHistory();
    };

    // Auto-log / update today's Review Progress session as a Review Meeting. Deduped to one
    // auto entry per assistant per day: reopening the page (or generating recommendations)
    // updates that entry rather than appending a new one. Manual "Log a Review" entries are
    // left untouched.
    window._upsertAutoReviewMeeting = function (payload) {
        if (_reviewAssistantId == null) return null;
        const today = new Date().toISOString().slice(0, 10);
        const list = _loadReviews();
        let entry = list.find(r => r.auto && r.date === today);
        if (entry) {
            Object.assign(entry, payload, { auto: true, date: today, savedAt: new Date().toISOString() });
        } else {
            entry = { date: today, auto: true, notes: '', outcomes: '', goalStatuses: [], nextDate: '', recommendations: [], savedAt: new Date().toISOString(), ...payload };
            list.push(entry);
        }
        _saveReviews(list);
        _renderHistory();
        return entry;
    };
})();

// ─────────────────────────────────────────────────────────────────
// Performance Metrics — fetches get-assistant-metrics and populates the
// three KPI cards. Shows "—" honestly wherever a metric has no data or the
// platform doesn't expose it (e.g. CTR for Instagram's organic feed).
// ─────────────────────────────────────────────────────────────────
async function _loadAssistantMetrics(assistantId) {
    const valEl   = (k) => document.getElementById(`metric-${k}-value`);
    const trendEl = (k) => document.getElementById(`metric-${k}-trend`);
    const dotEl   = (k) => document.getElementById(`metric-${k}-dot`);
    if (!valEl('engagement')) return; // section not on this page

    // 0–1 fraction → "12.3%". Null/undefined → "—".
    const pct = (v) => (v === null || v === undefined) ? '—' : `${(v * 100).toFixed(1)}%`;
    // Signed percentage for growth, with colour + arrow on the dot.
    const signedPct = (v) => {
        if (v === null || v === undefined) return '—';
        const s = `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
        return s;
    };
    const setDot = (k, state) => {
        const el = dotEl(k);
        if (!el) return;
        el.className = 'w-2 h-2 rounded-full ' + (
            state === 'up'   ? 'bg-emerald-400' :
            state === 'down' ? 'bg-rose-400' :
            state === 'live' ? 'bg-emerald-400' : 'bg-gray-200'
        );
    };

    try {
        const res = await fetch(`/.netlify/functions/get-assistant-metrics?id=${assistantId}`);
        if (!res.ok) return; // leave the "—" placeholders in place
        const data = await res.json();

        const note = document.getElementById('metrics-status-note');
        if (note) note.textContent = data.hasData
            ? `Last ${data.periodDays || 30} days`
            : 'No published-post data yet';

        if (!data.hasData) return; // keep placeholders

        const m = data.metrics || {};

        // Engagement Rate
        valEl('engagement').textContent = pct(m.engagementRate);
        if (m.engagementRate !== null && m.engagementRate !== undefined) {
            trendEl('engagement').textContent = `${(data.current?.posts) || 0} posts`;
            setDot('engagement', 'live');
        }

        // Organic Reach Growth (period-over-period; can be negative)
        valEl('reach').textContent = signedPct(m.reachGrowth);
        if (m.reachGrowth !== null && m.reachGrowth !== undefined) {
            trendEl('reach').textContent = m.reachGrowth >= 0 ? 'Growing' : 'Declining';
            setDot('reach', m.reachGrowth >= 0 ? 'up' : 'down');
        }

        // Click-Through Rate (null for IG organic — stays "—")
        valEl('ctr').textContent = pct(m.clickThroughRate);
        if (m.clickThroughRate !== null && m.clickThroughRate !== undefined) {
            setDot('ctr', 'live');
        } else {
            trendEl('ctr').textContent = 'Not tracked on Instagram';
        }

        // Meaningful Engagement (AC8) — saves + shares + comments over reach, the value-weighted
        // headline. Trend shows the raw value signals so success isn't judged on views alone.
        if (valEl('value')) {
            valEl('value').textContent = pct(m.meaningfulEngagementRate);
            const c = data.current || {};
            const parts = [];
            if (c.saves != null)  parts.push(`${c.saves} saves`);
            if (c.shares != null) parts.push(`${c.shares} shares`);
            if (parts.length) trendEl('value').textContent = parts.join(' · ');
            if (m.meaningfulEngagementRate != null) {
                setDot('value', m.valueScoreGrowth != null && m.valueScoreGrowth < 0 ? 'down' : 'up');
            }
            // Recognise high-value / low-reach posts as wins.
            const wins = (data.topValuePosts || []).filter(p => p.lowReachHighValue).length;
            const winsEl = document.getElementById('metric-value-wins');
            if (winsEl && wins > 0) {
                winsEl.textContent = `★ ${wins} post${wins === 1 ? '' : 's'} converted strongly on saves/shares despite low reach — counted as wins.`;
                winsEl.classList.remove('hidden');
            }
        }
    } catch {
        // Network/parse failure — leave the static "—" placeholders untouched.
    }
}


// fetchAndRenderIntegrations now delegates to the merged Connections tab
window.fetchAndRenderIntegrations = async function() {
    // No-op: connections are rendered in the Connections tab (initAssistantConnections, integrations.js)
};

// ─────────────────────────────────────────────────────────────────
// Workspace Defaults renderer — Brand Profile + Assistant Rules
// ─────────────────────────────────────────────────────────────────
async function _fetchAndRenderWorkspaceDefaults(assistantId, currentData, triggerAutoSave) {
    // ── Assistant Rules now live per-assistant — see _fetchAndRenderAssistantRules() ──

    // ── Business Information & Brand Knowledge ─────────────────────
    // There is no longer a separate "Brand Profile". The documents and links the user adds in
    // Business Information are mandatory context: they're always applied to this assistant as a
    // strict rule that can't be turned off — so this panel is informational only, no toggle.
    const knowledgeContainer = document.getElementById('business-knowledge-content');
    if (knowledgeContainer) {
        let assets = [];
        try {
            const aRes = await fetch('/.netlify/functions/get-workspace-assets');
            if (aRes.ok) assets = (await aRes.json()).assets || [];
        } catch { /* non-fatal — still show the strict-rule notice below */ }

        const strictNote = `
            <div class="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-800 mb-4">
                <svg class="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                <span>Your business details and every document or link in Business Information are considered by Be More Swan AI whenever it generates content. This is applied as a <strong>strict rule that can't be turned off</strong>.</span>
            </div>`;

        const catLabel = (c) => ({ tone_of_voice: 'Tone of Voice', logo: 'Brand Logo', product_info: 'Product Knowledge', general: 'General Context' }[c] || 'General Context');

        // Only assets the blueprint actually injects count as "applied": status ∈ {ready, confirmed}
        // (mirrors assemble-blueprint § 11 in src/utils/blueprint.ts). Anything still processing or
        // failed is shown separately so we don't claim it's an active strict rule when it isn't.
        const APPLIED_STATUSES = ['ready', 'confirmed'];
        const applied = assets.filter(a => APPLIED_STATUSES.includes(a.status));
        const pending = assets.filter(a => !APPLIED_STATUSES.includes(a.status));

        // Plain-language reason an asset isn't applied yet (mirrors STATUS_HINTS in assets.js).
        const notAppliedHint = (s) => ({
            processing: 'Still processing — will apply automatically once ready.',
            pending:    "Upload didn't finish, so it isn't applied. Remove it and try again.",
            failed:     "Upload failed, so it isn't applied. Remove it and try again.",
        }[s] || 'Not applied yet.');

        const appliedList = applied.length ? `
                <ul class="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
                    ${applied.map(a => `
                        <li class="flex items-center justify-between gap-3 px-4 py-3">
                            <div class="min-w-0">
                                <p class="text-sm font-semibold text-gray-800 truncate">${_escapeHtml(a.name)}</p>
                                <p class="text-xs text-gray-400 mt-0.5">${a.isFile ? 'Document' : 'Link'} · ${_escapeHtml(catLabel(a.category))}</p>
                            </div>
                            ${(a.externalUrl && !a.isFile) ? `<a href="${_escapeHtml(a.externalUrl)}" target="_blank" rel="noopener" class="text-xs font-bold text-emerald-700 hover:underline shrink-0">Open</a>` : ''}
                        </li>`).join('')}
                </ul>` : `
                <div class="flex flex-col items-center justify-center py-4 text-center gap-2">
                    <p class="text-sm text-gray-500">No documents or links applied yet.</p>
                    <a href="#" onclick="window.loadView('assets')" class="text-sm font-bold text-emerald-600 hover:underline cursor-pointer">Add documents or links in Business Information →</a>
                </div>`;

        // Muted section for assets that exist but aren't feeding the assistant yet.
        const pendingList = pending.length ? `
                <div class="mt-4">
                    <p class="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Not applied yet</p>
                    <ul class="divide-y divide-gray-100 border border-dashed border-gray-200 rounded-xl overflow-hidden">
                        ${pending.map(a => `
                            <li class="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50/50">
                                <div class="min-w-0">
                                    <p class="text-sm font-semibold text-gray-500 truncate">${_escapeHtml(a.name)}</p>
                                    <p class="text-xs text-gray-400 mt-0.5">${a.isFile ? 'Document' : 'Link'} · ${_escapeHtml(catLabel(a.category))}</p>
                                </div>
                                <span class="text-xs font-medium text-gray-400 shrink-0" title="${_escapeHtml(notAppliedHint(a.status))}">${_escapeHtml(a.status)}</span>
                            </li>`).join('')}
                    </ul>
                </div>` : '';

        knowledgeContainer.innerHTML = strictNote + appliedList + pendingList + `
                <div class="mt-3 text-right">
                    <a href="#" onclick="window.loadView('assets')" class="text-sm font-bold text-emerald-600 hover:underline cursor-pointer">Manage in Business Information →</a>
                </div>`;
    }
}

function _escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────────────────────────
// Per-assistant Assistant Rules — editable rules stored in content_rules
// and injected into THIS assistant's brief (assemble-blueprint § 4-content-rules).
// Replaces the old global-rules-with-toggles view.
// ─────────────────────────────────────────────────────────────────
const RULE_CATEGORIES = [
    { id: 'tone_of_voice',       title: 'Tone of Voice & Personality', placeholder: 'e.g. Always maintain a professional yet friendly tone.' },
    { id: 'response_formatting', title: 'Response Formatting',          placeholder: 'e.g. Always use short paragraphs; never use technical jargon.' },
    { id: 'core_knowledge',      title: 'Core Business Facts',          placeholder: 'e.g. Our flagship service is X, launched in 2024.' },
    { id: 'target_audience',     title: 'Target Audience Context',      placeholder: 'e.g. Speak to busy small-business owners aged 30–50.' },
];
const RULE_CATEGORY_TITLES = Object.fromEntries(RULE_CATEGORIES.map(c => [c.id, c.title]));
// Map rule categories to jargon-explainer slugs (see explainers.js GLOSSARY).
// Only categories with a glossary entry get a ⓘ; others are left plain.
const RULE_CATEGORY_EXPLAIN = {
    tone_of_voice: 'tone-of-voice',
    response_formatting: 'response-formatting',
    core_knowledge: 'core-business-facts',
    target_audience: 'target-audience',
};

let _rulesAssistantId = null;
const RULES_API = '/.netlify/functions/content-rules';

function _setRulesStatus(text, isError) {
    const el = document.getElementById('assistant-rules-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = `text-sm font-bold shrink-0 transition-all ${isError ? 'text-red-600' : 'text-emerald-600'}`;
    if (text && !isError && /Saved/.test(text)) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2000);
}

async function _fetchAndRenderAssistantRules(assistantId) {
    _rulesAssistantId = parseInt(assistantId);
    const editor = document.getElementById('assistant-rules-editor');
    if (!editor) return;

    let rules = [];
    try {
        const res = await fetch(`${RULES_API}?assistantId=${_rulesAssistantId}`);
        if (res.ok) rules = (await res.json()).rules || [];
    } catch (e) {
        console.warn('Could not load assistant rules:', e);
    }

    // Group rules by known category; anything else (legacy / rejection_feedback) → "Other rules"
    const byCat = {};
    RULE_CATEGORIES.forEach(c => { byCat[c.id] = []; });
    const other = [];
    rules.forEach(r => {
        if (r.category && byCat[r.category]) byCat[r.category].push(r);
        else other.push(r);
    });

    editor.innerHTML = '';
    RULE_CATEGORIES.forEach(cat => {
        editor.appendChild(_buildRuleCategoryCard(cat.id, cat.title, cat.placeholder, byCat[cat.id], false));
    });
    if (other.length) {
        editor.appendChild(_buildRuleCategoryCard('', 'Other rules', '', other, true));
    }

    // "Copy from another assistant" only makes sense with 2+ assistants — hide it otherwise.
    _toggleCopyRulesButton();
}

// Show the copy-rules button only when the user has another assistant to copy from.
// NOTE: the button is `inline-flex`, and in the prebuilt style.css `.inline-flex` is declared
// AFTER `.hidden`, so the `hidden` class can't hide it (display:inline-flex wins). We must toggle
// visibility via inline style.display, which beats any class-based display rule.
async function _toggleCopyRulesButton() {
    const btn = document.getElementById('btn-copy-rules');
    if (!btn) return;
    btn.style.display = 'none'; // default hidden until we confirm another assistant exists
    try {
        const res = await fetch('/.netlify/functions/get-assistants');
        if (!res.ok) return;
        const data = await res.json();
        const others = (data.assistants || []).filter(a =>
            a && a.id && parseInt(a.id) !== _rulesAssistantId &&
            a.lifecycleStatus !== 'archived' && a.status !== 'cancelled');
        if (others.length) btn.style.display = 'inline-flex'; // reveal with correct icon/text layout
    } catch { /* leave hidden on error — copying needs a successful list anyway */ }
}

function _buildRuleCategoryCard(catId, title, placeholder, rules, readOnlyAdd) {
    const card = document.createElement('div');
    card.className = 'border border-gray-200 rounded-xl overflow-hidden';
    card.innerHTML = `
        <div class="px-4 py-3 bg-gray-50/60 border-b border-gray-100 flex items-center justify-between">
            <h4 class="text-sm font-bold text-gray-800"${RULE_CATEGORY_EXPLAIN[catId] ? ` data-explain="${RULE_CATEGORY_EXPLAIN[catId]}"` : ''}>${_escapeHtml(title)}</h4>
            ${readOnlyAdd ? '' : `<button type="button" data-cat="${catId}" class="ar-add-btn text-sm font-bold text-emerald-600 hover:text-emerald-700 flex items-center gap-1 bg-emerald-50 px-3 py-1.5 rounded-md transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>Add Rule</button>`}
        </div>
        <div class="ar-rows divide-y divide-gray-100" data-cat="${catId}"></div>`;

    const rowsEl = card.querySelector('.ar-rows');
    if (rules && rules.length) {
        rules.forEach(r => rowsEl.appendChild(_buildRuleRow(catId, placeholder, r)));
    } else if (!readOnlyAdd) {
        rowsEl.appendChild(_buildEmptyHint(rowsEl));
    }

    const addBtn = card.querySelector('.ar-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => {
        const hint = rowsEl.querySelector('.ar-empty-hint');
        if (hint) hint.remove();
        const row = _buildRuleRow(catId, placeholder, null);
        rowsEl.appendChild(row);
        row.querySelector('.ar-input')?.focus();
    });
    return card;
}

function _buildEmptyHint() {
    const div = document.createElement('div');
    div.className = 'ar-empty-hint px-4 py-3 text-sm text-gray-400';
    div.textContent = 'No rules yet — click “Add Rule” to create one.';
    return div;
}

function _buildRuleRow(catId, placeholder, rule) {
    const tr = document.createElement('div');
    tr.className = 'ar-row flex items-start gap-3 px-4 py-3 group';
    if (rule?.id) tr.dataset.ruleId = String(rule.id);
    tr.dataset.cat = catId;
    const active = rule ? rule.isActive !== false : true;
    const isFeedback = rule?.origin === 'rejection_feedback';

    tr.innerHTML = `
        <div class="flex-1 min-w-0">
            <textarea rows="1" placeholder="${_escapeHtml(placeholder || 'Describe the rule…')}"
                class="ar-input w-full px-3 py-2 text-sm rounded-lg border border-transparent hover:border-gray-300 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none bg-transparent focus:bg-white resize-none overflow-hidden ${active ? '' : 'text-gray-400 line-through'}">${_escapeHtml(rule?.ruleText || '')}</textarea>
            ${isFeedback ? '<p class="text-xs text-amber-600 font-semibold px-3 mt-0.5">From rejected-post feedback</p>' : ''}
        </div>
        <button type="button" aria-checked="${active}" class="ar-toggle relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none mt-1 ${active ? 'bg-emerald-500' : 'bg-gray-300'}">
            <span class="${active ? 'translate-x-5' : 'translate-x-0'} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ease-in-out"></span>
        </button>
        <button type="button" class="ar-del text-gray-400 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 mt-1.5">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </button>`;

    const input = tr.querySelector('.ar-input');
    const toggle = tr.querySelector('.ar-toggle');
    const dot = toggle.querySelector('span');

    const autoResize = () => { input.style.height = ''; input.style.height = input.scrollHeight + 'px'; };
    requestAnimationFrame(autoResize);

    let saveTimer;
    input.addEventListener('input', () => {
        autoResize();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => _saveRuleRow(tr), 700);
    });
    input.addEventListener('blur', () => { clearTimeout(saveTimer); _saveRuleRow(tr); });

    toggle.addEventListener('click', async () => {
        const nowActive = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', nowActive);
        toggle.className = `ar-toggle relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none mt-1 ${nowActive ? 'bg-emerald-500' : 'bg-gray-300'}`;
        dot.className = `${nowActive ? 'translate-x-5' : 'translate-x-0'} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ease-in-out`;
        nowActive ? input.classList.remove('text-gray-400', 'line-through') : input.classList.add('text-gray-400', 'line-through');
        if (tr.dataset.ruleId) {
            _setRulesStatus('Saving…');
            try {
                const r = await fetch(RULES_API, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: Number(tr.dataset.ruleId), isActive: nowActive }) });
                _setRulesStatus(r.ok ? '✓ Saved' : 'Error saving', !r.ok);
                if (r.ok) _renderKickOff(_rulesAssistantId);
            } catch { _setRulesStatus('Error saving', true); }
        }
    });

    tr.querySelector('.ar-del').addEventListener('click', async () => {
        if (tr.dataset.ruleId) {
            if (!confirm('Delete this rule? It will no longer be applied to this assistant.')) return;
            _setRulesStatus('Saving…');
            try {
                const r = await fetch(`${RULES_API}?id=${tr.dataset.ruleId}`, { method: 'DELETE' });
                if (!r.ok) { _setRulesStatus('Error deleting', true); return; }
                _setRulesStatus('✓ Saved');
                _renderKickOff(_rulesAssistantId);
            } catch { _setRulesStatus('Error deleting', true); return; }
        }
        const rows = tr.parentElement;
        tr.remove();
        if (rows && !rows.querySelector('.ar-row') && rows.dataset.cat) rows.appendChild(_buildEmptyHint());
    });

    return tr;
}

// Create-on-first-save, then patch on subsequent edits. No-op for empty text on a new row.
async function _saveRuleRow(tr) {
    const input = tr.querySelector('.ar-input');
    const text = (input?.value || '').trim();
    const id = tr.dataset.ruleId ? Number(tr.dataset.ruleId) : null;

    if (!text) {
        // Empty existing rule → delete it; empty brand-new row → ignore
        if (id) {
            try { await fetch(`${RULES_API}?id=${id}`, { method: 'DELETE' }); } catch {}
            delete tr.dataset.ruleId;
            _renderKickOff(_rulesAssistantId);
        }
        return;
    }
    if (tr.dataset.savedText === text) return; // unchanged since last save

    _setRulesStatus('Saving…');
    try {
        let res;
        if (id) {
            res = await fetch(RULES_API, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ruleText: text }) });
        } else {
            res = await fetch(RULES_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assistantId: _rulesAssistantId, ruleText: text, category: tr.dataset.cat || null }) });
            if (res.ok) {
                const data = await res.json();
                if (data.rule?.id) tr.dataset.ruleId = String(data.rule.id);
            }
        }
        if (res.ok) { tr.dataset.savedText = text; _setRulesStatus('✓ Saved'); _renderKickOff(_rulesAssistantId); }
        else _setRulesStatus('Error saving', true);
    } catch { _setRulesStatus('Error saving', true); }
}

// ── Copy rules from another assistant ─────────────────────────────
window._openCopyRules = async function () {
    const sel = document.getElementById('copy-rules-source');
    const errEl = document.getElementById('copy-rules-error');
    const preview = document.getElementById('copy-rules-preview');
    if (errEl) errEl.classList.add('hidden');
    if (preview) preview.textContent = '';
    if (sel) sel.innerHTML = '<option value="">Loading assistants…</option>';
    document.getElementById('modal-copy-rules')?.classList.remove('hidden');

    try {
        const res = await fetch('/.netlify/functions/get-assistants');
        const data = res.ok ? await res.json() : {};
        const list = (data.assistants || data || []).filter(a => a && a.id && parseInt(a.id) !== _rulesAssistantId);
        if (!sel) return;
        if (!list.length) {
            sel.innerHTML = '<option value="">No other assistants found</option>';
            return;
        }
        sel.innerHTML = '<option value="">Select an assistant…</option>' +
            list.map(a => `<option value="${a.id}">${_escapeHtml(a.name || ('Assistant #' + a.id))}</option>`).join('');
    } catch {
        if (sel) sel.innerHTML = '<option value="">Could not load assistants</option>';
    }
};

window._confirmCopyRules = async function () {
    const sel = document.getElementById('copy-rules-source');
    const errEl = document.getElementById('copy-rules-error');
    const btn = document.getElementById('btn-copy-rules-confirm');
    const sourceId = sel?.value ? Number(sel.value) : null;
    if (errEl) errEl.classList.add('hidden');
    if (!sourceId) { if (errEl) { errEl.textContent = 'Please select a source assistant.'; errEl.classList.remove('hidden'); } return; }

    if (btn) { btn.disabled = true; btn.classList.add('opacity-60'); }
    try {
        const res = await fetch(`${RULES_API}?assistantId=${sourceId}`);
        const srcRules = res.ok ? ((await res.json()).rules || []) : [];
        const toCopy = srcRules.filter(r => r.ruleText && r.isActive !== false);
        if (!toCopy.length) {
            if (errEl) { errEl.textContent = 'That assistant has no active rules to copy.'; errEl.classList.remove('hidden'); }
            return;
        }
        for (const r of toCopy) {
            await fetch(RULES_API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assistantId: _rulesAssistantId, ruleText: r.ruleText, category: r.category || null, platform: r.platform || null }) });
        }
        document.getElementById('modal-copy-rules')?.classList.add('hidden');
        await _fetchAndRenderAssistantRules(_rulesAssistantId);
        _setRulesStatus(`✓ Copied ${toCopy.length} rule${toCopy.length === 1 ? '' : 's'}`);
    } catch {
        if (errEl) { errEl.textContent = 'Could not copy rules. Please try again.'; errEl.classList.remove('hidden'); }
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-60'); }
    }
};

// ══════════════════════════════════════════════════════════════════
// SMART Goals (Feature 1) — per-assistant goal builder + list
// ══════════════════════════════════════════════════════════════════
const GOALS_API = '/.netlify/functions/manage-goals';
let _goalsAssistantId = null;
let _goalMetrics = [];   // available metric catalog entries for this workspace (AC1.1.3)
let _goalsCache = [];    // last-loaded goals for this assistant (for the header bar + review modal)
let _goalEntitlements = { aiRecommendations: false, magicWand: false, autonomous: false }; // Feature 3 tier gates
let _autonomousGoalSeeking = false;
let _autonomousMediaEnabled = false;   // Epic 2 US5
let _autonomousMediaCap = 20;
let _planMonthlyCredits = 0;           // org's plan-included monthly AI credit allowance (issue #64)

// Media Source Selection — ordered list of enabled sources (priority = order). Default matrix.
let _mediaSources = ['manual', 'stock', 'ai'];
const _MEDIA_SOURCE_META = {
    manual: { label: 'Manual Upload', desc: 'Pick from your uploaded content library.' },
    stock:  { label: 'AI Stock Search', desc: 'Search Pexels for a relevant photo or video.' },
    ai:     { label: 'AI Generation', desc: 'Generate a fresh image on demand.' },
};
const _ALL_MEDIA_SOURCES = ['manual', 'stock', 'ai'];

const _GOAL_STATUS_META = {
    pending:            { label: 'Pending',        dot: 'bg-gray-300',    text: 'text-gray-500'   },
    on_track:           { label: 'On Track',       dot: 'bg-emerald-500', text: 'text-emerald-600' },
    at_risk:            { label: 'At Risk',        dot: 'bg-amber-500',   text: 'text-amber-600'  },
    off_track:          { label: 'Off Track',      dot: 'bg-red-500',     text: 'text-red-600'    },
    data_disconnected:  { label: 'Data Disconnected', dot: 'bg-gray-400', text: 'text-gray-500'   },
};

function _goalMetricLabel(key) {
    const m = _goalMetrics.find(x => x.key === key);
    return m ? { label: m.label, unit: m.unit } : { label: key, unit: '' };
}
window._goalMetricLabel = _goalMetricLabel;

async function _fetchAndRenderGoals(assistantId) {
    _goalsAssistantId = parseInt(assistantId);
    const list = document.getElementById('goals-list');
    if (!list) return;

    let goals = [];
    try {
        const res = await fetch(`${GOALS_API}?assistantId=${_goalsAssistantId}`);
        if (res.ok) {
            const data = await res.json();
            goals = data.goals || [];
            _goalMetrics = data.availableMetrics || [];
            _goalEntitlements = data.entitlements || _goalEntitlements;
            _autonomousGoalSeeking = !!data.autonomousGoalSeeking;
            _autonomousMediaEnabled = !!data.autonomousMediaEnabled;
            _autonomousMediaCap = data.autonomousMediaMonthlyCap ?? 20;
            _planMonthlyCredits = data.planMonthlyCredits ?? 0;
            _mediaSources = _normalizeMediaSources(data.mediaSources);
        }
    } catch (e) {
        console.warn('Could not load goals:', e);
    }

    _goalsCache = goals;
    window._goalsCache = goals; // keep window reference in sync for IIFE closures
    _populateGoalMetricDropdown();
    _renderPrimaryGoalHeader();
    _syncReviewButton();
    _applyGoalEntitlementsUi();
    _applyAutonomousMediaUi();
    _applyMediaSourcesUi();

    if (!goals.length) {
        list.innerHTML = `<div class="py-8 text-center text-sm text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
            No goals yet. Click <span class="font-bold text-emerald-600">Add New Goal</span> to set your first target.</div>`;
        return;
    }
    list.innerHTML = goals.map(_buildGoalCard).join('');

    // AC2.2.1 — a dashboard "Review Progress" click deep-links here; open the modal once.
    if (window._reviewProgressOnLoad) {
        window._reviewProgressOnLoad = false;
        setTimeout(() => window._openReviewProgress(), 150);
    }
}

// AC2.1.2 — primary goal progress bar in the assistant detail header.
function _renderPrimaryGoalHeader() {
    const box = document.getElementById('detail-primary-goal');
    if (!box) return;
    const primary = _goalsCache.find(g => g.isPrimary) || _goalsCache[0];
    if (!primary) { box.classList.add('hidden'); box.innerHTML = ''; return; }

    const meta = _GOAL_STATUS_META[primary.status] || _GOAL_STATUS_META.pending;
    const { label, unit } = _goalMetricLabel(primary.metricKey);
    const target = Number(primary.targetValue);
    const latest = primary.latestValue != null ? Number(primary.latestValue) : null;
    const pct = (latest != null && target > 0) ? Math.max(0, Math.min(100, Math.round((latest / target) * 100))) : 0;
    const fmt = (n) => n == null ? '—' : Number(n).toLocaleString();

    box.classList.remove('hidden');
    box.innerHTML = `
        <div class="flex items-center justify-between text-xs mb-1">
            <span class="font-bold text-gray-700">${_escapeHtml(label)}</span>
            <span class="inline-flex items-center gap-1.5 font-bold ${meta.text}"><span class="w-2 h-2 rounded-full ${meta.dot}"></span>${meta.label}</span>
        </div>
        <div class="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
            <div class="h-full ${meta.dot} transition-all" style="width:${pct}%"></div>
        </div>
        <p class="text-[11px] text-gray-400 mt-1">${latest != null ? fmt(latest) : '—'} / ${fmt(target)} ${_escapeHtml(unit)}</p>`;
}

function _syncReviewButton() {
    // Always visible — Review Meeting is not gated on goals existing.
}

window._openReviewMeeting = function () {
    window._activateMainTab('meetings');
    setTimeout(() => {
        const section = document.getElementById('review-goals-section');
        const checks = document.getElementById('review-goals-checks');
        if (section && checks && _goalsCache.length) {
            checks.innerHTML = _goalsCache.map(g => {
                const { label } = _goalMetricLabel(g.metricKey);
                return `<label class="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <select name="goal_status_${g.id}" class="border border-gray-300 rounded-md px-2 py-1 text-xs bg-white focus:ring-2 focus:ring-emerald-500 outline-none">
                        <option value="">Not discussed</option>
                        <option value="on_track">On Track</option>
                        <option value="at_risk">At Risk</option>
                        <option value="off_track">Off Track</option>
                        <option value="achieved">Achieved</option>
                    </select>
                    <span class="truncate">${_escapeHtml(label)}${g.isPrimary ? ' <span class="text-gray-400 text-xs">(Primary)</span>' : ''}</span>
                </label>`;
            }).join('');
            section.classList.remove('hidden');
        } else if (section) {
            section.classList.add('hidden');
        }
        window._openReviewForm();
    }, 80);
};

// Objective labels — mirror GOAL_OBJECTIVES in src/config/goal-metrics.ts. 'outcome' is the
// non-social bucket (invoices chased, tickets resolved…) that replaces the marketing funnel.
const _GOAL_OBJECTIVE_LABELS = {
    awareness: 'Grow my Audience (Awareness)',
    engagement: 'Increase Interaction (Engagement)',
    action: 'Drive Traffic (Action)',
    outcome: 'Business Outcome',
};
const _GOAL_OBJECTIVE_ORDER = ['awareness', 'engagement', 'action', 'outcome'];

// US-01 AC1.1/AC1.2 — the Objective dropdown drives which metrics appear; AC1.1.3 still gates the
// metrics by which apps are actually connected. The objectives shown are derived from the metrics
// this assistant's ROLE actually has (server-filtered), so a non-social role sees only "Business
// Outcome" and a social role sees the funnel objectives it can measure. Selecting an objective
// instantly (re)populates the Metric dropdown.
function _populateGoalMetricDropdown() {
    const objSel = document.getElementById('goal-objective');
    const sel = document.getElementById('goal-metric');
    const help = document.getElementById('goal-metric-help');
    if (!objSel || !sel) return;

    // Rebuild the objective options from the objectives present in this role's available metrics.
    const present = _GOAL_OBJECTIVE_ORDER.filter(o => _goalMetrics.some(m => m.objective === o));
    const single = present.length === 1;
    objSel.innerHTML = (single
        ? '' // no placeholder when there's only one objective — it's preselected below
        : '<option value="">Select an objective…</option>'
    ) + present.map(o => `<option value="${o}">${_escapeHtml(_GOAL_OBJECTIVE_LABELS[o] || o)}</option>`).join('');
    if (single) objSel.value = present[0];

    const renderMetrics = () => {
        const objective = objSel.value;
        if (help) help.textContent = '';
        if (!objective) {
            sel.innerHTML = '<option value="">Select an objective first…</option>';
            sel.disabled = true;
            return;
        }
        const metrics = _goalMetrics.filter(m => m.objective === objective);
        if (!metrics.length) {
            sel.innerHTML = '<option value="">No measurable metrics for this objective yet</option>';
            sel.disabled = true;
            if (help) help.innerHTML = 'Connect a social or data app on the <span class="font-semibold">Connections</span> tab to unlock metrics for this objective.';
            return;
        }
        sel.disabled = false;
        sel.innerHTML = '<option value="">Select a metric…</option>' +
            metrics.map(m => `<option value="${m.key}" data-unit="${_escapeHtml(m.unit)}">${_escapeHtml(m.label)}</option>`).join('');
    };

    objSel.onchange = renderMetrics;
    sel.onchange = () => {
        const m = _goalMetrics.find(x => x.key === sel.value);
        if (help) help.textContent = m ? m.description : '';
    };
    renderMetrics();
}

function _buildGoalCard(g) {
    const meta = _GOAL_STATUS_META[g.status] || _GOAL_STATUS_META.pending;
    const { label, unit } = _goalMetricLabel(g.metricKey);
    const target = Number(g.targetValue);
    const latest = g.latestValue != null ? Number(g.latestValue) : null;
    const pct = (latest != null && target > 0) ? Math.max(0, Math.min(100, Math.round((latest / target) * 100))) : 0;
    const due = g.targetDate ? new Date(g.targetDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    const fmt = (n) => n == null ? '—' : Number(n).toLocaleString();

    return `<div class="border border-gray-200 rounded-xl p-4">
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                    <h4 class="text-sm font-bold text-gray-900">${_escapeHtml(label)}</h4>
                    ${g.isPrimary ? '<span class="text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded">Primary</span>' : ''}
                </div>
                <p class="text-xs text-gray-500 mt-0.5">Target: <span class="font-semibold text-gray-700">${fmt(target)} ${_escapeHtml(unit)}</span> by ${due}</p>
            </div>
            <div class="flex items-center gap-3 shrink-0">
                <span class="inline-flex items-center gap-1.5 text-xs font-bold ${meta.text}">
                    <span class="w-2 h-2 rounded-full ${meta.dot}"></span>${meta.label}
                </span>
                <button type="button" onclick="window._deleteGoal(${g.id})" aria-label="Delete goal" class="text-gray-300 hover:text-red-500 transition cursor-pointer">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
            </div>
        </div>
        <div class="mt-3">
            <div class="flex items-center justify-between text-[11px] text-gray-400 mb-1">
                <span>${latest != null ? fmt(latest) + ' ' + _escapeHtml(unit) : 'Awaiting first data sync'}</span>
                <span>${latest != null ? pct + '%' : ''}</span>
            </div>
            <div class="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                <div class="h-full ${meta.dot} transition-all" style="width:${pct}%"></div>
            </div>
        </div>
    </div>`;
}

window._toggleGoalBuilder = function (show) {
    const builder = document.getElementById('goal-builder');
    const err = document.getElementById('goal-builder-error');
    if (!builder) return;
    if (err) err.classList.add('hidden');
    if (show) {
        builder.classList.remove('hidden');
        const t = document.getElementById('goal-target'); if (t) t.value = '';
        const d = document.getElementById('goal-date'); if (d) d.value = '';
        const o = document.getElementById('goal-objective'); if (o) o.value = '';
        const m = document.getElementById('goal-metric'); if (m) m.value = '';
        const p = document.getElementById('goal-primary'); if (p) p.checked = false;
        const help = document.getElementById('goal-metric-help'); if (help) help.textContent = '';
        // Reset the Metric dropdown back to its "select an objective first" state.
        _populateGoalMetricDropdown();
    } else {
        builder.classList.add('hidden');
    }
};

window._saveGoal = async function () {
    const err = document.getElementById('goal-builder-error');
    const btn = document.getElementById('btn-save-goal');
    const metricKey = document.getElementById('goal-metric')?.value;
    const targetValue = document.getElementById('goal-target')?.value;
    const targetDate = document.getElementById('goal-date')?.value;
    const isPrimary = document.getElementById('goal-primary')?.checked || false;

    const fail = (msg) => { if (err) { err.textContent = msg; err.classList.remove('hidden'); } };
    if (err) err.classList.add('hidden');
    if (!metricKey) return fail('Please choose a target metric.');
    if (!targetValue || Number(targetValue) <= 0) return fail('Enter a positive target value.');
    if (!targetDate || new Date(targetDate).getTime() <= Date.now()) return fail('Choose a target date in the future.');

    if (btn) { btn.disabled = true; btn.classList.add('opacity-60'); }
    try {
        const res = await fetch(GOALS_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistantId: _goalsAssistantId, metricKey, targetValue: Number(targetValue), targetDate, isPrimary }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); return fail(e.error || 'Could not save goal.'); }
        window._toggleGoalBuilder(false);
        await _fetchAndRenderGoals(_goalsAssistantId);
    } catch {
        fail('Could not save goal. Please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-60'); }
    }
};

window._deleteGoal = async function (id) {
    const doDelete = async () => {
        try {
            const res = await fetch(`${GOALS_API}?id=${id}`, { method: 'DELETE' });
            if (res.ok) await _fetchAndRenderGoals(_goalsAssistantId);
        } catch { /* no-op */ }
    };
    if (window.showConfirmModal) {
        window.showConfirmModal('Delete this goal? This cannot be undone.', doDelete, { title: 'Delete goal?', confirmLabel: 'Yes, delete goal', cancelLabel: 'Keep goal' });
    } else if (confirm('Delete this goal? This cannot be undone.')) {
        await doDelete();
    }
};

// ── Review Progress (US2.2) — trendline vs trajectory chart + base-tier manual path ──
const GOAL_TELEMETRY_API = '/.netlify/functions/get-goal-telemetry';

const _REVIEW_BANNER = {
    on_track:          { tone: 'emerald', text: 'On track to hit your target by the deadline.' },
    at_risk:           { tone: 'amber',   text: 'Slightly behind pace. A small adjustment now keeps you on target.' },
    off_track:         { tone: 'red',     text: 'Off track — at the current rate this goal will miss its target.' },
    pending:           { tone: 'gray',    text: 'Gathering data. Status appears once a few data points are in.' },
    data_disconnected: { tone: 'gray',    text: 'We lost connection to the data source. Re-authenticate to resume tracking.' },
};
const _REVIEW_TONE_CLS = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    amber:   'bg-amber-50 border-amber-200 text-amber-800',
    red:     'bg-red-50 border-red-200 text-red-800',
    gray:    'bg-gray-50 border-gray-200 text-gray-600',
};

window._openReviewProgress = function (goalId) {
    const modal = document.getElementById('modal-review-progress');
    const sel = document.getElementById('review-goal-select');
    if (!modal || !sel) return;
    // No goals to review against yet — fall back to the manual review-log form so the
    // hero CTA is never a dead end.
    if (!_goalsCache.length) { window._openReviewMeeting?.(); return; }
    sel.innerHTML = _goalsCache.map(g => {
        const { label } = _goalMetricLabel(g.metricKey);
        return `<option value="${g.id}">${_escapeHtml(label)}${g.isPrimary ? ' (Primary)' : ''}</option>`;
    }).join('');
    const initial = goalId || (_goalsCache.find(g => g.isPrimary) || _goalsCache[0]).id;
    sel.value = String(initial);
    modal.classList.remove('hidden');
    window._renderReviewChart(Number(initial));
    // Opening the progress page is itself a review session — log it (once per day) as a
    // Review Meeting so the user and assistant can refer back to it.
    _recordReviewProgressSession();
};

// Auto-log the current Review Progress session as a Review Meeting. The "agenda" captures
// which goals were reviewed and their status; "outcomes" summarises the headline result and
// is enriched with the assistant's recommendations once they're generated (_getAiRecommendations).
function _recordReviewProgressSession() {
    if (!_goalsCache.length || !window._upsertAutoReviewMeeting) return;
    const goalStatuses = _goalsCache.map(g => {
        const { label } = _goalMetricLabel(g.metricKey);
        const status = _GOAL_STATUS_META[g.status] ? g.status : 'pending';
        return { goalId: String(g.id), label, status };
    });
    const counts = goalStatuses.reduce((a, gs) => { a[gs.status] = (a[gs.status] || 0) + 1; return a; }, {});
    const onTrack = counts.on_track || 0;
    const atRisk = counts.at_risk || 0;
    const offTrack = counts.off_track || 0;
    const n = goalStatuses.length;
    const assistantName = document.getElementById('detail-name-input')?.value?.trim() || 'Your assistant';
    const agenda = `Progress review of ${n} goal${n > 1 ? 's' : ''}: ${goalStatuses.map(gs => gs.label).join(', ')}.`;
    let rating = 3;
    if (offTrack === 0 && atRisk === 0) rating = 5;
    else if (offTrack === 0) rating = 4;
    else if (offTrack >= n) rating = 1;
    else rating = 2;
    const bits = [];
    if (onTrack) bits.push(`${onTrack} on track`);
    if (atRisk) bits.push(`${atRisk} at risk`);
    if (offTrack) bits.push(`${offTrack} off track`);
    const outcomes = `${assistantName} reviewed progress — ${bits.join(', ') || 'status pending'}.`;
    window._upsertAutoReviewMeeting({ agenda, goalStatuses, rating, outcomes });
}

window._renderReviewChart = async function (goalId) {
    const chart = document.getElementById('review-chart');
    const banner = document.getElementById('review-status-banner');
    const footer = document.getElementById('review-footer');
    if (!chart) return;
    chart.innerHTML = '<span class="text-sm text-gray-400">Loading chart…</span>';
    if (banner) banner.innerHTML = '';
    if (footer) footer.innerHTML = '';

    let data = null;
    try {
        const res = await fetch(`${GOAL_TELEMETRY_API}?id=${goalId}`);
        if (res.ok) data = await res.json();
    } catch { /* handled below */ }
    if (!data) { chart.innerHTML = '<span class="text-sm text-red-500">Could not load telemetry.</span>'; return; }

    const status = data.goal.status;
    const b = _REVIEW_BANNER[status] || _REVIEW_BANNER.pending;
    if (banner) {
        banner.innerHTML = `<div class="flex items-start gap-2 text-sm font-medium border rounded-lg px-3 py-2.5 ${_REVIEW_TONE_CLS[b.tone]}">
            <span class="font-bold">${(_GOAL_STATUS_META[status] || _GOAL_STATUS_META.pending).label}:</span><span>${b.text}</span></div>`;
    }

    chart.innerHTML = _buildTelemetrySvg(data.actual || [], data.trajectory || []);

    const recsBox = document.getElementById('review-recommendations');
    if (recsBox) { recsBox.classList.add('hidden'); recsBox.innerHTML = ''; }

    // Footer: premium "Get AI Recommendations" (padlock if base tier, AC3.1.1) + base-tier
    // manual "Edit Assistant Brief" when off pace (AC2.2.3).
    if (footer) {
        const offPace = status === 'off_track' || status === 'at_risk';
        const lock = _goalEntitlements.aiRecommendations ? '' : '🔒 ';
        // US-03 — the headline resolution flow for a failing goal: diagnosis + a one-click strategy fix.
        // It's the primary CTA when off pace; "Get AI Recommendations" drops to a secondary outline.
        const fixBtn = offPace
            ? `<button type="button" onclick="window._openStrategyFix(${goalId})" class="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg shadow transition cursor-pointer">${lock}One-Click Fix</button>`
            : '';
        const recsCls = offPace
            ? 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow';
        const assistantName = document.getElementById('detail-name-input')?.value?.trim() || 'AI';
        const recsBtn = `<button type="button" onclick="window._getAiRecommendations(${goalId})" class="px-5 py-2 ${recsCls} text-sm font-bold rounded-lg transition cursor-pointer">${lock}${_escapeHtml(assistantName)}'s Recommendations</button>`;
        const editBtn = offPace
            ? `<button type="button" onclick="window._editBriefFromReview()" class="px-5 py-2 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-bold rounded-lg transition cursor-pointer">Edit Assistant Brief</button>`
            : '';
        footer.innerHTML = editBtn + recsBtn + fixBtn;
    }
};

window._editBriefFromReview = function () {
    document.getElementById('modal-review-progress')?.classList.add('hidden');
    document.querySelector('.detail-tab-btn[data-tab="rules"]')?.click();
    setTimeout(() => {
        const el = document.getElementById('edit_strict_rules');
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
    }, 120);
};

// Dependency-free line chart: actual (solid emerald) vs required trajectory (dashed grey).
function _buildTelemetrySvg(actual, trajectory) {
    const all = [...actual, ...trajectory];
    if (!all.length) return '<span class="text-sm text-gray-400">No data yet — the first sync will populate this chart.</span>';

    const W = 560, H = 220, PAD = { l: 52, r: 16, t: 14, b: 28 };
    const xs = all.map(p => new Date(p.date).getTime());
    const ys = all.map(p => Number(p.value));
    let minX = Math.min(...xs), maxX = Math.max(...xs);
    let minY = Math.min(0, ...ys), maxY = Math.max(...ys);
    if (maxX === minX) maxX = minX + 1;
    if (maxY === minY) maxY = minY + 1;
    const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
    const sx = t => PAD.l + ((t - minX) / (maxX - minX)) * plotW;
    const sy = v => PAD.t + (1 - (v - minY) / (maxY - minY)) * plotH;
    const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(new Date(p.date).getTime()).toFixed(1)},${sy(Number(p.value)).toFixed(1)}`).join(' ');

    const trajPath = trajectory.length >= 2 ? `<path d="${path(trajectory)}" fill="none" stroke="#9ca3af" stroke-width="2" stroke-dasharray="5 5"/>` : '';
    const actPath = actual.length >= 2 ? `<path d="${path(actual)}" fill="none" stroke="#059669" stroke-width="2.5"/>` : '';
    const actDots = actual.map(p => `<circle cx="${sx(new Date(p.date).getTime()).toFixed(1)}" cy="${sy(Number(p.value)).toFixed(1)}" r="3" fill="#059669"/>`).join('');

    const fmtV = v => Number(v).toLocaleString();
    const fmtD = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const axis = `<line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${H - PAD.b}" stroke="#e5e7eb"/><line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" stroke="#e5e7eb"/>`;
    const labels =
        `<text x="${PAD.l - 6}" y="${(sy(maxY) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#9ca3af">${fmtV(maxY)}</text>` +
        `<text x="${PAD.l - 6}" y="${(sy(minY) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#9ca3af">${fmtV(minY)}</text>` +
        `<text x="${PAD.l}" y="${H - 8}" text-anchor="start" font-size="10" fill="#9ca3af">${fmtD(minX)}</text>` +
        `<text x="${W - PAD.r}" y="${H - 8}" text-anchor="end" font-size="10" fill="#9ca3af">${fmtD(maxX)}</text>`;

    return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" xmlns="http://www.w3.org/2000/svg">${axis}${trajPath}${actPath}${actDots}${labels}</svg>`;
}

// ══════════════════════════════════════════════════════════════════
// Feature 3 — Premium AI Optimization (recommendations, magic wand, autonomous)
// ══════════════════════════════════════════════════════════════════
const GOAL_AI_API = '/.netlify/functions/goal-ai';
const _WAND_FIELD_LABELS = { tone_of_voice: 'Brand Voice', target_audience: 'Target Audience', content_pillars: 'Content Strategy', core_message: 'Core Message', problem_statement: 'Your Bottleneck', service_offerings: 'Products & Services' };

function _openUpgrade(msg) {
    if (typeof window.openUpgradeModal === 'function') {
        window.openUpgradeModal('Upgrade your plan', 'Premium AI optimization', msg);
    } else {
        alert(msg);
    }
}

// Reflect tier entitlements + autonomous state onto the UI (toggle, premium lock chip).
function _applyGoalEntitlementsUi() {
    const tog = document.getElementById('toggle-autonomous-goals');
    const dot = document.getElementById('toggle-autonomous-goals-dot');
    const lock = document.getElementById('autonomous-lock');
    if (tog && dot) {
        const on = _autonomousGoalSeeking;
        tog.setAttribute('aria-checked', on ? 'true' : 'false');
        tog.classList.toggle('bg-emerald-600', on);
        tog.classList.toggle('bg-gray-300', !on);
        dot.classList.toggle('translate-x-5', on);
        dot.classList.toggle('translate-x-0', !on);
    }
    if (lock) lock.classList.toggle('hidden', _goalEntitlements.autonomous);
}

// Epic 2 US5 — reflect autonomous media-suggestion state on the toggle + cap input.
function _applyAutonomousMediaUi() {
    const tog = document.getElementById('toggle-autonomous-media');
    const dot = document.getElementById('toggle-autonomous-media-dot');
    const capRow = document.getElementById('autonomous-media-cap-row');
    const capInput = document.getElementById('autonomous-media-cap');
    const capHint = document.getElementById('autonomous-media-cap-hint');
    if (tog && dot) {
        const on = _autonomousMediaEnabled;
        tog.setAttribute('aria-checked', on ? 'true' : 'false');
        tog.classList.toggle('bg-emerald-600', on);
        tog.classList.toggle('bg-gray-300', !on);
        dot.classList.toggle('translate-x-5', on);
        dot.classList.toggle('translate-x-0', !on);
    }
    if (capRow) capRow.classList.toggle('hidden', !_autonomousMediaEnabled);
    if (capInput) capInput.value = _autonomousMediaCap;
    if (capHint) {
        capHint.textContent = `This assistant's cap is currently ${_autonomousMediaCap} credits/month. ` +
            `Your plan includes ${_planMonthlyCredits} credits/month — raising the cap above that will ` +
            `need your confirmation, as extra usage is charged.`;
    }
}

async function _setAutonomousMedia(patch) {
    const res = await fetch('/.netlify/functions/set-autonomous-media', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistantId: _goalsAssistantId, ...patch }),
    });
    if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        const err = new Error(payload.error || res.statusText);
        err.status = res.status;
        err.payload = payload;
        throw err;
    }
    return res.json();
}

window._toggleAutonomousMedia = async function () {
    const next = !_autonomousMediaEnabled;
    try {
        const data = await _setAutonomousMedia({ enabled: next });
        _autonomousMediaEnabled = !!data.autonomousMediaEnabled;
        _autonomousMediaCap = data.autonomousMediaMonthlyCap ?? _autonomousMediaCap;
        _applyAutonomousMediaUi();
    } catch (e) { alert('Could not update the setting: ' + e.message); }
};

// issue #64: the cap is meant to be bounded by the plan's included monthly credits. Raising it
// above that means the assistant could spend credits the plan doesn't cover, so the user must
// explicitly confirm they accept being charged for the extra credits before it's saved.
window._saveAutonomousMediaCap = async function () {
    const input = document.getElementById('autonomous-media-cap');
    const cap = parseInt(input?.value, 10);
    if (!Number.isFinite(cap) || cap < 0) { input.value = _autonomousMediaCap; return; }

    const commit = async (confirmOverage) => {
        try {
            const data = await _setAutonomousMedia({ monthlyCap: cap, confirmOverage });
            _autonomousMediaCap = data.autonomousMediaMonthlyCap ?? cap;
            _applyAutonomousMediaUi();
            // issue #67: saving succeeds silently — the input already shows the value the user just
            // typed, so with no confirmation the click on "OK" in the dialog above looks like a no-op.
            window.showToast?.(
                confirmOverage ? 'Monthly credit cap updated — extra usage above your plan allowance will be billed.'
                                : 'Monthly credit cap updated.'
            );
        } catch (e) { alert('Could not update the cap: ' + e.message); input.value = _autonomousMediaCap; }
    };

    if (cap > _planMonthlyCredits) {
        const message = `Your plan includes ${_planMonthlyCredits} AI credits per month. Setting this assistant's ` +
            `cap to ${cap} means it may use up to ${cap - _planMonthlyCredits} credits beyond your plan's ` +
            `allowance, which will be charged as additional usage. Continue?`;
        const opts = {
            title: 'Extra usage will be charged',
            confirmLabel: 'Yes, continue',
            cancelLabel: 'Cancel',
            confirmColor: '#ff007f',
            onCancel: () => { input.value = _autonomousMediaCap; },
        };
        if (window.showConfirmModal) {
            window.showConfirmModal(message, () => commit(true), opts);
        } else if (confirm(message)) {
            await commit(true);
        } else {
            input.value = _autonomousMediaCap;
        }
        return;
    }

    await commit(false);
};

// ── Media Source Selection ──────────────────────────────────────────
// Coerce the stored value into a clean ordered list of valid sources (mirrors the server helper).
function _normalizeMediaSources(raw) {
    const valid = new Set(_ALL_MEDIA_SOURCES);
    const out = [];
    if (Array.isArray(raw)) {
        for (const v of raw) {
            const s = String(v || '').toLowerCase();
            if (valid.has(s) && !out.includes(s)) out.push(s);
        }
    }
    return out.length ? out : [..._ALL_MEDIA_SOURCES];
}

// Render the enabled sources (in priority order, with reorder arrows) followed by disabled ones.
function _applyMediaSourcesUi() {
    const list = document.getElementById('media-sources-list');
    if (!list) return;
    const enabled = _mediaSources;
    const disabled = _ALL_MEDIA_SOURCES.filter(s => !enabled.includes(s));

    const row = (src, on, idx) => {
        const meta = _MEDIA_SOURCE_META[src];
        const arrows = on ? `
            <div class="flex flex-col">
              <button type="button" aria-label="Move up" onclick="window._reorderMediaSource('${src}',-1)"
                class="px-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400 cursor-pointer leading-none" ${idx === 0 ? 'disabled' : ''}>&#9650;</button>
              <button type="button" aria-label="Move down" onclick="window._reorderMediaSource('${src}',1)"
                class="px-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400 cursor-pointer leading-none" ${idx === enabled.length - 1 ? 'disabled' : ''}>&#9660;</button>
            </div>` : '<div class="w-[18px]"></div>';
        const badge = on ? `<span class="text-xs font-bold text-gray-400 w-5 text-center">${idx + 1}</span>` : '<span class="w-5"></span>';
        return `
        <div class="flex items-center gap-3 border ${on ? 'border-gray-200 bg-white' : 'border-dashed border-gray-200 bg-gray-50'} rounded-xl px-4 py-3">
          ${badge}
          ${arrows}
          <div class="flex-1 min-w-0">
            <p class="text-sm font-bold ${on ? 'text-gray-900' : 'text-gray-500'} inline-flex items-center" data-explain="media-source-${src}">${meta.label}</p>
            <p class="text-xs text-gray-400">${meta.desc}</p>
          </div>
          <button type="button" role="switch" aria-checked="${on}" aria-label="${on ? 'Disable' : 'Enable'} ${meta.label}"
            onclick="window._toggleMediaSource('${src}')"
            class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${on ? 'bg-emerald-600' : 'bg-gray-300'}">
            <span class="${on ? 'translate-x-5' : 'translate-x-0'} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"></span>
          </button>
        </div>`;
    };

    list.innerHTML = enabled.map((s, i) => row(s, true, i)).join('') + disabled.map(s => row(s, false, -1)).join('');
    const warn = document.getElementById('media-sources-empty-warning');
    if (warn) warn.classList.toggle('hidden', enabled.length > 0);
}

async function _persistMediaSources(prev) {
    try {
        const data = await _setAutonomousMedia({ mediaSources: _mediaSources });
        _mediaSources = _normalizeMediaSources(data.mediaSources);
    } catch (e) {
        _mediaSources = prev;   // revert on failure
        alert('Could not update media sources: ' + e.message);
    }
    _applyMediaSourcesUi();
}

window._toggleMediaSource = function (src) {
    if (!_ALL_MEDIA_SOURCES.includes(src)) return;
    const prev = [..._mediaSources];
    if (_mediaSources.includes(src)) {
        _mediaSources = _mediaSources.filter(s => s !== src);   // disable
    } else {
        _mediaSources = [..._mediaSources, src];                // enable (lowest priority)
    }
    _applyMediaSourcesUi();   // optimistic
    _persistMediaSources(prev);
};

window._reorderMediaSource = function (src, delta) {
    const i = _mediaSources.indexOf(src);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= _mediaSources.length) return;
    const prev = [..._mediaSources];
    const next = [..._mediaSources];
    [next[i], next[j]] = [next[j], next[i]];
    _mediaSources = next;
    _applyMediaSourcesUi();   // optimistic
    _persistMediaSources(prev);
};

// AC3.1 — premium AI recommendations for an off-track goal.
window._getAiRecommendations = async function (goalId) {
    if (!_goalEntitlements.aiRecommendations) {
        return _openUpgrade('AI Recommendations are available on the Saver and Employee plans.');
    }
    const box = document.getElementById('review-recommendations');
    if (box) { box.classList.remove('hidden'); box.innerHTML = '<p class="text-sm text-gray-400 mt-3">Analysing your goal…</p>'; }
    try {
        const res = await fetch(GOAL_AI_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'recommend', goalId }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 402) { if (box) box.classList.add('hidden'); return _openUpgrade('AI Recommendations require a higher plan.'); }
        if (!res.ok || !Array.isArray(data.recommendations)) {
            if (box) box.innerHTML = `<p class="text-sm text-red-500 mt-3">${_escapeHtml(data.error || 'Could not generate recommendations.')}</p>`;
            return;
        }
        // US-02 — the diagnosis is steered by the metric's funnel stage; label it so the user sees why.
        const funnelTag = data.funnelStage
            ? `<span class="text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded">${_escapeHtml(data.funnelStage)}</span>`
            : '';
        const assistantName = document.getElementById('detail-name-input')?.value?.trim() || 'AI';
        // Fold the assistant's update + recommendations into today's auto-logged Review Meeting.
        window._upsertAutoReviewMeeting?.({ recommendations: data.recommendations });
        if (box) box.innerHTML = `<div class="mt-3 space-y-3">
            <div class="flex items-center gap-2 flex-wrap">
                <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">${_escapeHtml(assistantName)}'s Recommendations</p>
                ${funnelTag}
            </div>
            <p class="text-xs text-gray-400">Select the recommendations you'd like to progress, then click <strong>Progress Selected</strong>.</p>
            <div class="space-y-2" id="recs-list">
                ${data.recommendations.map((r, i) => `<label class="flex items-start gap-3 text-sm text-gray-700 bg-emerald-50/60 border border-emerald-100 rounded-lg px-3 py-2.5 cursor-pointer hover:bg-emerald-50 transition has-[:checked]:border-emerald-400 has-[:checked]:bg-emerald-50">
                    <input type="checkbox" data-rec-idx="${i}" class="rec-checkbox mt-0.5 accent-emerald-600 shrink-0 w-4 h-4 cursor-pointer">
                    <span>${_escapeHtml(r)}</span>
                </label>`).join('')}
            </div>
            <div class="flex items-center gap-2 flex-wrap pt-1">
                <button type="button" onclick="window._progressSelectedRecs()" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg shadow transition cursor-pointer">Progress Selected</button>
                <button type="button" onclick="window._getAiRecommendations(${goalId})" class="px-4 py-2 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 text-xs font-bold rounded-lg transition cursor-pointer">Reject &amp; Ask for More</button>
            </div>
        </div>`;
    } catch {
        if (box) box.innerHTML = '<p class="text-sm text-red-500 mt-3">Could not generate recommendations.</p>';
    }
};

// Progress selected recommendations — opens a checklist confirmation.
window._progressSelectedRecs = function () {
    const checked = [...document.querySelectorAll('.rec-checkbox:checked')];
    if (!checked.length) {
        alert('Please select at least one recommendation to progress.');
        return;
    }
    const items = checked.map(cb => cb.closest('label')?.querySelector('span')?.textContent?.trim()).filter(Boolean);
    const list = items.map(t => `• ${t}`).join('\n');
    if (confirm(`Progress the following ${items.length} recommendation${items.length > 1 ? 's' : ''}?\n\n${list}\n\nThis will add them to your action plan.`)) {
        const box = document.getElementById('review-recommendations');
        if (box) {
            box.innerHTML += `<div class="mt-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 font-medium">
                ✓ ${items.length} recommendation${items.length > 1 ? 's' : ''} added to your action plan.
            </div>`;
            box.querySelectorAll('.rec-checkbox').forEach(cb => { cb.disabled = true; });
            box.querySelectorAll('button').forEach(btn => { btn.disabled = true; btn.classList.add('opacity-50'); });
        }
    }
};

// AC3.2 — goal-aware field rewrite (magic wand).
window._magicWand = async function (field, inputId, btn) {
    if (!_goalEntitlements.magicWand) {
        return _openUpgrade('The AI Magic Wand is available on the Saver and Employee plans.');
    }
    const input = document.getElementById(inputId);
    if (!input) return;
    const wandImg = btn ? btn.querySelector('img') : null;
    if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; }
    wandImg?.classList.add('is-casting');   // visible "something's happening" feedback
    try {
        const res = await fetch(GOAL_AI_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'rewrite', assistantId: _goalsAssistantId, field, text: input.value }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 402) return _openUpgrade('The AI Magic Wand requires a higher plan.');
        if (!res.ok || !data.suggestion) { alert(data.error || 'Could not generate a suggestion.'); return; }
        _showWandSuggestion(field, inputId, data.suggestion);
    } catch {
        alert('Could not generate a suggestion.');
    } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        wandImg?.classList.remove('is-casting');
    }
};

function _showWandSuggestion(field, inputId, suggestion) {
    const lbl = document.getElementById('wand-field-label');
    const sug = document.getElementById('wand-suggestion');
    const accept = document.getElementById('wand-accept');
    if (lbl) lbl.textContent = _WAND_FIELD_LABELS[field] || field;
    if (sug) sug.textContent = suggestion;
    if (accept) accept.onclick = () => {            // AC3.2.3 — one-click apply (then autosave)
        const input = document.getElementById(inputId);
        if (input) { input.value = suggestion; input.dispatchEvent(new Event('input', { bubbles: true })); }
        document.getElementById('modal-wand')?.classList.add('hidden');
    };
    document.getElementById('modal-wand')?.classList.remove('hidden');
}

// ── US-03 One-Click Fix — diagnosis + side-by-side strategy diff + apply-all ──
// Strategy field (onboardingContext key) → the Guardrails-tab input that holds it. Applying a fix
// just writes these inputs and lets the detail page's debounced autosave persist them (the same
// path the Magic Wand uses), so all changed fields save together in one round-trip (AC3.4).
const _STRATEGY_FIELD_INPUTS = { tone_of_voice: 'edit_tone', target_audience: 'edit_audience', content_pillars: 'edit_pillars' };

window._openStrategyFix = async function (goalId) {
    if (!_goalEntitlements.aiRecommendations) {
        return _openUpgrade('One-Click Fix is available on the Saver and Employee plans.');
    }
    const modal = document.getElementById('modal-strategy-fix');
    const body = document.getElementById('strategy-fix-body');
    const footer = document.getElementById('strategy-fix-footer');
    if (!modal || !body) return;
    footer?.classList.add('hidden');
    body.innerHTML = '<div class="flex items-center justify-center py-10 text-sm text-gray-400">Analysing your strategy…</div>';
    modal.classList.remove('hidden');

    try {
        const res = await fetch(GOAL_AI_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'strategy', goalId }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 402) { modal.classList.add('hidden'); return _openUpgrade('One-Click Fix requires a higher plan.'); }
        if (!res.ok) {
            body.innerHTML = `<p class="text-sm text-red-500 py-6 text-center">${_escapeHtml(data.error || 'Could not generate a strategy fix.')}</p>`;
            return;
        }
        _renderStrategyFix(data);
    } catch {
        body.innerHTML = '<p class="text-sm text-red-500 py-6 text-center">Could not generate a strategy fix.</p>';
    }
};

function _renderStrategyFix(data) {
    const body = document.getElementById('strategy-fix-body');
    const footer = document.getElementById('strategy-fix-footer');
    const accept = document.getElementById('strategy-fix-accept');
    const changes = Array.isArray(data.changes) ? data.changes : [];

    // AC3.2 — plain-text diagnosis of why the goal is failing.
    const funnelTag = data.funnelStage
        ? `<span class="text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded">${_escapeHtml(data.funnelStage)}</span>`
        : '';
    const diagnosis = data.diagnosis
        ? `<div class="space-y-2">
              <div class="flex items-center gap-2 flex-wrap">
                <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">Diagnosis</p>${funnelTag}
              </div>
              <p class="text-sm text-gray-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2.5">${_escapeHtml(data.diagnosis)}</p>
           </div>`
        : '';

    if (!changes.length) {
        // Diagnosis only — nothing to apply. Offer manual editing instead.
        if (body) body.innerHTML = `${diagnosis || '<p class="text-sm text-gray-600">No strategy changes are recommended right now.</p>'}
            <p class="text-sm text-gray-500">Your current strategy already looks well-aligned to this goal — no automatic changes are recommended.</p>`;
        footer?.classList.remove('hidden');
        if (accept) { accept.textContent = 'Edit Assistant Brief'; accept.onclick = () => { document.getElementById('modal-strategy-fix')?.classList.add('hidden'); window._editBriefFromReview(); }; }
        return;
    }

    // AC3.3 — Git-style side-by-side Current vs AI-Suggested diff for each changed field.
    const diffRows = changes.map(c => `
        <div class="border border-gray-200 rounded-xl overflow-hidden">
            <div class="px-3 py-2 bg-gray-50 border-b border-gray-200"><p class="text-xs font-bold text-gray-700">${_escapeHtml(c.label)}</p></div>
            <div class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-200">
                <div class="p-3 bg-red-50/40">
                    <p class="text-[10px] font-bold uppercase tracking-wide text-red-400 mb-1">− Current</p>
                    <p class="text-sm text-gray-600 whitespace-pre-wrap">${c.current ? _escapeHtml(c.current) : '<span class="italic text-gray-400">(empty)</span>'}</p>
                </div>
                <div class="p-3 bg-emerald-50/50">
                    <p class="text-[10px] font-bold uppercase tracking-wide text-emerald-600 mb-1">+ AI-Suggested</p>
                    <p class="text-sm text-gray-800 whitespace-pre-wrap">${_escapeHtml(c.suggested)}</p>
                </div>
            </div>
        </div>`).join('');

    if (body) body.innerHTML = `${diagnosis}
        <div class="space-y-3">
            <p class="text-xs font-bold text-gray-500 uppercase tracking-wide">Suggested strategy changes</p>
            ${diffRows}
        </div>`;
    footer?.classList.remove('hidden');
    if (accept) { accept.textContent = 'Accept & Update Strategy'; accept.onclick = () => _applyStrategyFix(changes); }
}

// AC3.4 — apply every suggested field at once. Writes the Guardrails inputs and fires the input
// event so the detail page's debounced autosave persists the whole brief in one save.
function _applyStrategyFix(changes) {
    let applied = 0;
    changes.forEach(c => {
        const inputId = _STRATEGY_FIELD_INPUTS[c.field];
        const input = inputId && document.getElementById(inputId);
        if (input) {
            input.value = c.suggested;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            if (window.cachedContext) window.cachedContext[c.field] = c.suggested;
            applied++;
        }
    });
    const modal = document.getElementById('modal-strategy-fix');
    if (!applied) {
        // Detail inputs weren't on the page — fall back to opening the brief for manual editing.
        modal?.classList.add('hidden');
        window._editBriefFromReview();
        return;
    }
    // Confirm in-place, then close both the fix modal and Review Progress.
    const body = document.getElementById('strategy-fix-body');
    const footer = document.getElementById('strategy-fix-footer');
    if (body) body.innerHTML = `<div class="flex flex-col items-center justify-center py-10 text-center gap-2">
        <div class="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 text-2xl">✓</div>
        <p class="text-sm font-bold text-gray-800">Strategy updated</p>
        <p class="text-xs text-gray-500">${applied} field${applied === 1 ? '' : 's'} updated and saving automatically.</p>
    </div>`;
    footer?.classList.add('hidden');
    setTimeout(() => {
        modal?.classList.add('hidden');
        document.getElementById('modal-review-progress')?.classList.add('hidden');
    }, 1600);
}

// AC3.3.1 — toggle Autonomous Goal Seeking (premium-gated).
window._toggleAutonomousGoals = async function () {
    if (!_goalEntitlements.autonomous && !_autonomousGoalSeeking) {
        return _openUpgrade('Autonomous Goal Seeking is available on the Saver and Employee plans.');
    }
    const next = !_autonomousGoalSeeking;
    try {
        const res = await fetch(GOALS_API, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistantId: _goalsAssistantId, autonomousGoalSeeking: next }),
        });
        if (res.ok) { _autonomousGoalSeeking = next; _applyGoalEntitlementsUi(); }
        else if (res.status === 402) _openUpgrade('Autonomous Goal Seeking requires a higher plan.');
    } catch { /* no-op */ }
};

// ── Safe Content Benchmark modal + safety feedback (moved from instructions page) ──
window._openSafetyBenchmark = function () {
    document.getElementById('modal-safety-benchmark')?.classList.remove('hidden');
};

window._openSafetyFeedback = function () {
    const s = document.getElementById('safety-suggestion'); if (s) s.value = '';
    const c = document.getElementById('safety-context'); if (c) c.value = '';
    document.getElementById('safety-feedback-error')?.classList.add('hidden');
    document.getElementById('safety-feedback-success')?.classList.add('hidden');
    const btn = document.getElementById('btn-safety-submit');
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg> Submit Suggestion'; }
    document.getElementById('modal-safety-feedback')?.classList.remove('hidden');
};

window._submitSafetyFeedback = async function () {
    const suggestion = (document.getElementById('safety-suggestion')?.value || '').trim();
    const context = (document.getElementById('safety-context')?.value || '').trim();
    const errorEl = document.getElementById('safety-feedback-error');
    const successEl = document.getElementById('safety-feedback-success');
    const btn = document.getElementById('btn-safety-submit');
    errorEl?.classList.add('hidden');
    successEl?.classList.add('hidden');
    if (!suggestion) { if (errorEl) { errorEl.textContent = 'Please describe your suggested safety rule.'; errorEl.classList.remove('hidden'); } return; }
    if (btn) { btn.disabled = true; btn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" class="opacity-75"/></svg> Sending…'; }
    try {
        const res = await fetch('/.netlify/functions/safety-feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suggestion, context }) });
        if (res.ok) {
            successEl?.classList.remove('hidden');
            if (btn) btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Sent!';
            setTimeout(() => document.getElementById('modal-safety-feedback')?.classList.add('hidden'), 2200);
        } else {
            const data = await res.json().catch(() => ({}));
            if (errorEl) { errorEl.textContent = data.error || 'Submission failed. Please try again.'; errorEl.classList.remove('hidden'); }
            if (btn) { btn.disabled = false; btn.innerHTML = 'Submit Suggestion'; }
        }
    } catch {
        if (errorEl) { errorEl.textContent = 'Network error. Please check your connection and try again.'; errorEl.classList.remove('hidden'); }
        if (btn) { btn.disabled = false; btn.innerHTML = 'Submit Suggestion'; }
    }
};

// ==========================================
// 6. INTEGRATIONS — merged into Connections tab (integrations.js initAssistantConnections)

// ── Autonomous Posting Fallback toggle (US5) ─────────────────────
function _hydrateAutonomousToggle(data) {
    // Default ON when unset: the backend gap-fill treats a missing flag as "fallback enabled"
    // (assistant keeps drafting with AI/stock media), so the switch must reflect that same default.
    const isOn = data.configuration?.appliedDefaults?.autonomousFallback !== false;
    _applyAutonomousToggleState(isOn);
}

function _applyAutonomousToggleState(isOn) {
    const btn = document.getElementById('toggle-autonomous');
    const dot = document.getElementById('toggle-autonomous-dot');
    const onMsg = document.getElementById('autonomous-on-msg');
    const offMsg = document.getElementById('autonomous-off-msg');
    if (!btn) return;

    btn.setAttribute('aria-checked', isOn ? 'true' : 'false');
    btn.className = `relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none mt-1 ${isOn ? 'bg-emerald-500' : 'bg-gray-300'}`;
    if (dot) dot.className = `${isOn ? 'translate-x-5' : 'translate-x-0'} pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`;
    if (onMsg) onMsg.classList.toggle('hidden', !isOn);
    if (offMsg) offMsg.classList.toggle('hidden', isOn);
}

window._toggleAutonomous = async function () {
    const btn = document.getElementById('toggle-autonomous');
    if (!btn) return;
    const currentlyOn = btn.getAttribute('aria-checked') === 'true';
    const newVal = !currentlyOn;
    _applyAutonomousToggleState(newVal);

    // Persist via update-assistant-context — get assistantId from URL/param
    const assistantId = window._currentAssistantId;
    if (!assistantId) return;

    try {
        await fetch('/.netlify/functions/update-assistant-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                assistantId,
                appliedDefaults: { autonomousFallback: newVal },
            }),
        });
    } catch (e) {
        console.warn('Could not save autonomous toggle:', e);
        // Revert on failure
        _applyAutonomousToggleState(currentlyOn);
    }
};