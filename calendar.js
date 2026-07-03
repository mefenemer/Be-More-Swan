// calendar.js — Interactive Content Calendar & Post Governance
// Wrapped in IIFE to avoid global scope collisions with other view controllers.
(function () {

// ── Config ────────────────────────────────────────────────────────
// SVG brand logos for each platform, sized for chip use (16×16).
const PLATFORM_LOGOS = {
    facebook: `<svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full"><path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97h-1.513c-1.491 0-1.956.93-1.956 1.874v2.25h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/></svg>`,
    instagram: `<svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>`,
    linkedin:  `<svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,
    x:         `<svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
};

const PLATFORM_META = {
    facebook:  { label: 'Facebook',    bg: '#1877F2', text: 'text-white' },
    instagram: { label: 'Instagram',   bg: 'linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)', text: 'text-white' },
    linkedin:  { label: 'LinkedIn',    bg: '#0A66C2', text: 'text-white' },
    x:         { label: 'X (Twitter)', bg: '#000000', text: 'text-white' },
};

// Returns a platform logo rendered in a sized container (inline SVG).
function _platLogo(platform, size = 'sm') {
    const svg = PLATFORM_LOGOS[platform];
    const px = size === 'lg' ? '20px' : size === 'md' ? '16px' : '13px';
    if (!svg) return `<span style="font-size:${px}">📣</span>`;
    return `<span style="display:inline-flex;width:${px};height:${px};color:#fff;flex-shrink:0">${svg}</span>`;
}

// Returns a circular platform avatar (logo on brand bg) for list/panel use.
function _platAvatar(platform, sizePx = 36) {
    const meta = PLATFORM_META[platform];
    const logo = PLATFORM_LOGOS[platform];
    const bg = meta ? meta.bg : '#9ca3af';
    const inner = logo
        ? `<span style="display:flex;width:${Math.round(sizePx*0.5)}px;height:${Math.round(sizePx*0.5)}px;color:#fff">${logo}</span>`
        : `<span style="font-size:${Math.round(sizePx*0.45)}px;color:#fff">📣</span>`;
    return `<div style="width:${sizePx}px;height:${sizePx}px;border-radius:10px;background:${bg};display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,.15)">${inner}</div>`;
}

const STATUS_META = {
    draft:           { label: 'Draft',       badge: 'bg-gray-100 text-gray-600 border-gray-300',   chipBorder: 'border-gray-400',    dot: 'bg-gray-400' },
    pending_approval:{ label: 'Pending',     badge: 'bg-amber-100 text-amber-700 border-amber-300', chipBorder: 'border-amber-400',   dot: 'bg-amber-400' },
    in_review:       { label: 'In Review',   badge: 'bg-amber-100 text-amber-700 border-amber-300', chipBorder: 'border-amber-400',   dot: 'bg-amber-400' },
    approved:        { label: 'Approved',    badge: 'bg-blue-100 text-blue-700 border-blue-300',   chipBorder: 'border-blue-500',    dot: 'bg-blue-500' },
    scheduled:       { label: 'Scheduled',   badge: 'bg-yellow-100 text-yellow-700 border-yellow-300', chipBorder: 'border-yellow-500', dot: 'bg-yellow-500' },
    publishing:      { label: 'Publishing',  badge: 'bg-blue-100 text-blue-700 border-blue-300',   chipBorder: 'border-blue-500',    dot: 'bg-blue-500' },
    published:       { label: 'Published',   badge: 'bg-emerald-100 text-emerald-700 border-emerald-300', chipBorder: 'border-emerald-500', dot: 'bg-emerald-500' },
    paused:          { label: 'Paused',      badge: 'bg-gray-100 text-gray-500 border-gray-300',   chipBorder: 'border-gray-400',    dot: 'bg-gray-400' },
    failed:          { label: 'Failed',      badge: 'bg-red-100 text-red-700 border-red-300',      chipBorder: 'border-red-500',     dot: 'bg-red-500' },
    missed:          { label: 'Missed',      badge: 'bg-orange-100 text-orange-700 border-orange-300', chipBorder: 'border-orange-300', dot: 'bg-amber-500' },
    rejected:        { label: 'Rejected',    badge: 'bg-red-100 text-red-700 border-red-300',      chipBorder: 'border-red-500',     dot: 'bg-red-500' },
    cancelled:       { label: 'Cancelled',   badge: 'bg-gray-100 text-gray-400 border-gray-200',   chipBorder: 'border-gray-300',    dot: 'bg-gray-300' },
};

// A post is "overdue" when its scheduled time has passed but the publisher hasn't
// confirmed it live yet. This is the case the calendar must make visible — otherwise
// it looks identical to a normal scheduled post sitting on a past date.
function _isOverdue(post) {
    if (!post?.publishDate) return false;
    if (post.status !== 'scheduled') return false;
    return new Date(post.publishDate) < new Date();
}

const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── State ─────────────────────────────────────────────────────────
let _view = 'month';             // 'month' | 'week' | 'list'
let _anchor = new Date();        // date anchor for current view
_anchor.setHours(0, 0, 0, 0);
let _posts = [];                 // all loaded posts
let _openPostId = null;          // currently open panel post id
let _editMode = false;           // panel edit mode
let _dragPostId = null;          // drag source
let _dragTargetDate = null;      // drop target
let _pendingReschedule = null;   // { postId, newDate }
let _pendingApproveId = null;    // postId awaiting past-date modal decision
let _listFilter = 'all';         // 'all' | 'pending' | 'approved' | 'published'
// #3/#4: assistant activity + per-assistant colour-coding + filter
let _activities = [];            // completed task runs (get-calendar-activity)
let _assistants = [];            // org assistants for names + colour assignment
let _assistantFilter = 'all';    // 'all' | <assistantId>
let _platformFilter  = 'all';    // 'all' | 'facebook' | 'instagram' | 'linkedin' | 'x'

// Stable colour palette assigned to assistants by load order (inline styles → no Tailwind
// arbitrary-class compile issues). Null/unknown assistant → neutral grey.
const ASSISTANT_PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#3b82f6'];
function _assistantColor(id) {
    if (id == null) return '#9ca3af';
    const idx = _assistants.findIndex(a => a.id === id);
    const i = idx >= 0 ? idx : (Math.abs(Number(id)) % ASSISTANT_PALETTE.length);
    return ASSISTANT_PALETTE[i % ASSISTANT_PALETTE.length];
}
function _assistantName(id) {
    if (id == null) return 'Unassigned';
    const a = _assistants.find(a => a.id === id);
    return a ? (a.name || `Assistant #${id}`) : `Assistant #${id}`;
}
function _matchesAssistantFilter(assistantId) {
    return _assistantFilter === 'all' || String(assistantId) === String(_assistantFilter);
}
function _matchesPlatformFilter(platform) {
    return _platformFilter === 'all' || platform === _platformFilter;
}

// ── Init ──────────────────────────────────────────────────────────
window.initCalendar = async function () {
    document.getElementById('cal-btn-prev')?.addEventListener('click', _navPrev);
    document.getElementById('cal-btn-next')?.addEventListener('click', _navNext);
    document.getElementById('cal-btn-today')?.addEventListener('click', _navToday);
    document.querySelectorAll('.cal-view-btn').forEach(btn => {
        btn.addEventListener('click', () => _setView(btn.dataset.view));
    });
    await _loadAndRender();
};

// ── Navigation ────────────────────────────────────────────────────
function _navPrev() {
    if (_view === 'month') _anchor.setMonth(_anchor.getMonth() - 1);
    else if (_view === 'week') _anchor.setDate(_anchor.getDate() - 7);
    else _anchor.setMonth(_anchor.getMonth() - 1);
    _render();
}
function _navNext() {
    if (_view === 'month') _anchor.setMonth(_anchor.getMonth() + 1);
    else if (_view === 'week') _anchor.setDate(_anchor.getDate() + 7);
    else _anchor.setMonth(_anchor.getMonth() + 1);
    _render();
}
function _navToday() {
    _anchor = new Date(); _anchor.setHours(0,0,0,0);
    _render();
}
function _setView(v) {
    _view = v;
    document.querySelectorAll('.cal-view-btn').forEach(btn => {
        const active = btn.dataset.view === v;
        btn.className = `cal-view-btn px-3 py-1.5 text-sm font-bold rounded-lg transition cursor-pointer ${active ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`;
    });
    _render();
}

// ── Load posts + assistant activity from API ──────────────────────
async function _loadAndRender() {
    try {
        const { from, to } = _getDateRange();
        // Posts, completed assistant activity, and the assistant list (for colours/filter) in parallel.
        const [postsRes, actRes, asstRes] = await Promise.all([
            fetch(`/.netlify/functions/scheduled-posts?from=${from.toISOString()}&to=${to.toISOString()}`),
            fetch(`/.netlify/functions/get-calendar-activity?from=${from.toISOString()}&to=${to.toISOString()}`),
            _assistants.length ? Promise.resolve(null) : fetch('/.netlify/functions/get-assistants'),
        ]);

        if (postsRes.ok) {
            _posts = (await postsRes.json()).posts || [];
        } else if (postsRes.status === 403) {
            // US3 AC3.3: onboarding guard rejected this — surface it gracefully, don't crash.
            const body = await postsRes.json().catch(() => ({}));
            if (body.error === 'onboarding_incomplete') {
                window.showToast?.(body.message || 'Please complete your onboarding checklist to unlock this feature.');
            }
            _posts = [];
        }

        if (actRes && actRes.ok) _activities = (await actRes.json()).activities || [];
        if (asstRes && asstRes.ok) _assistants = (await asstRes.json()).assistants || [];
    } catch (e) { console.warn('Calendar load error:', e); }
    // Always (re)populate the toolbar controls — the calendar.html fragment (and its fresh
    // <select>) is re-injected on every view entry, even though _assistants is cached here.
    _renderAssistantControls();
    _render();
}

// Populate the assistant + platform filter dropdowns and colour legend.
function _renderAssistantControls() {
    const sel = document.getElementById('cal-assistant-filter');
    if (sel) {
        sel.innerHTML = `<option value="all">All assistants</option>` +
            _assistants.map(a => `<option value="${a.id}">${_escHtml(a.name || ('Assistant #' + a.id))}</option>`).join('');
        sel.value = String(_assistantFilter);
        if (!sel.dataset.bound) {
            sel.dataset.bound = '1';
            sel.addEventListener('change', () => { _assistantFilter = sel.value; _render(); });
        }
    }

    const psel = document.getElementById('cal-platform-filter');
    if (psel && !psel.dataset.bound) {
        psel.dataset.bound = '1';
        psel.addEventListener('change', () => { _platformFilter = psel.value; _render(); });
    }
    if (psel) psel.value = _platformFilter;

    const legend = document.getElementById('cal-legend');
    if (legend) {
        legend.innerHTML = _assistants.map(a =>
            `<span class="inline-flex items-center gap-1.5 text-xs text-gray-500">
                <span class="w-2.5 h-2.5 rounded-full" style="background:${_assistantColor(a.id)}"></span>${_escHtml(a.name || ('Assistant #' + a.id))}
            </span>`).join('');
        legend.classList.toggle('hidden', _assistants.length === 0);
    }
}

function _getDateRange() {
    if (_view === 'week') {
        const weekStart = _weekStart(_anchor);
        const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6); weekEnd.setHours(23,59,59,999);
        return { from: weekStart, to: weekEnd };
    }
    // Month and list: whole month
    const from = new Date(_anchor.getFullYear(), _anchor.getMonth(), 1);
    const to   = new Date(_anchor.getFullYear(), _anchor.getMonth() + 1, 0, 23, 59, 59, 999);
    return { from, to };
}

// ── Master render ─────────────────────────────────────────────────
function _render() {
    // Chips are about to be torn down and rebuilt — drop any open hover preview
    // so it doesn't linger detached from its (now-removed) anchor chip.
    if (_previewEl) { _previewEl.classList.remove('is-open'); }
    _previewReqToken++;

    // Update title
    const titleEl = document.getElementById('cal-title');
    if (titleEl) {
        if (_view === 'month' || _view === 'list') {
            titleEl.textContent = `${MONTH_NAMES[_anchor.getMonth()]} ${_anchor.getFullYear()}`;
        } else {
            const ws = _weekStart(_anchor);
            const we = new Date(ws); we.setDate(we.getDate() + 6);
            titleEl.textContent = `${ws.getDate()} ${MONTH_NAMES[ws.getMonth()]} – ${we.getDate()} ${MONTH_NAMES[we.getMonth()]} ${we.getFullYear()}`;
        }
    }

    const main = document.getElementById('cal-main');
    if (!main) return;

    if (_view === 'month') main.innerHTML = _renderMonth();
    else if (_view === 'week') main.innerHTML = _renderWeek();
    else main.innerHTML = _renderList();

    _attachDragDrop();
}

// ── Month View ────────────────────────────────────────────────────
function _renderMonth() {
    const year = _anchor.getFullYear(), month = _anchor.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date(); today.setHours(0,0,0,0);

    // Day headers
    let html = `<div class="sticky top-0 z-10 grid grid-cols-7 bg-white border-b border-gray-200">`;
    DAY_NAMES_SHORT.forEach(d => {
        html += `<div class="py-2 text-center text-xs font-bold text-gray-400 uppercase tracking-wide">${d}</div>`;
    });
    html += `</div><div class="grid grid-cols-7 auto-rows-[minmax(100px,auto)] border-l border-gray-200">`;

    // Blank cells before month start
    for (let i = 0; i < firstDay; i++) {
        html += `<div class="border-r border-b border-gray-100 bg-gray-50/50"></div>`;
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const dateKey = _dateKey(date);
        const isToday = _dateKey(today) === dateKey;
        const dayPosts = _postsOnDate(date);

        const tdClass = `relative border-r border-b border-gray-100 ${isToday ? 'bg-emerald-50/40' : 'bg-white hover:bg-gray-50/60'} transition p-1.5`;

        html += `<div class="${tdClass}" data-date="${dateKey}"
            ondragover="window._calDragOver(event, '${dateKey}')"
            ondragleave="window._calDragLeave(event)"
            ondrop="window._calDrop(event, '${dateKey}')">`;
        html += `<div class="flex items-center justify-end mb-1">
            <span class="${isToday ? 'w-6 h-6 bg-emerald-600 text-white rounded-full flex items-center justify-center text-xs font-extrabold' : 'text-xs font-bold text-gray-500 px-1'}">${day}</span>
        </div>`;
        const dayActs = _activitiesOnDate(date);
        html += `<div class="space-y-1">${dayPosts.map(p => _postChip(p, 'month')).join('')}${dayActs.map(a => _activityChip(a, 'month')).join('')}</div>`;
        html += `</div>`;
    }

    html += `</div>`;
    return html;
}

// ── Week View ─────────────────────────────────────────────────────
function _renderWeek() {
    const ws = _weekStart(_anchor);
    const today = new Date(); today.setHours(0,0,0,0);

    let html = `<div class="grid grid-cols-7 sticky top-0 z-10 bg-white border-b border-gray-200">`;
    for (let i = 0; i < 7; i++) {
        const d = new Date(ws); d.setDate(d.getDate() + i);
        const isToday = _dateKey(d) === _dateKey(today);
        html += `<div class="py-3 text-center border-r border-gray-100 last:border-0">
            <p class="text-xs font-bold text-gray-400 uppercase">${DAY_NAMES_SHORT[d.getDay()]}</p>
            <p class="${isToday ? 'w-7 h-7 bg-emerald-600 text-white rounded-full flex items-center justify-center text-sm font-extrabold mx-auto mt-0.5' : 'text-lg font-extrabold text-gray-800 mt-0.5'}">${d.getDate()}</p>
        </div>`;
    }
    html += `</div>`;

    html += `<div class="grid grid-cols-7 border-l border-gray-200">`;
    for (let i = 0; i < 7; i++) {
        const d = new Date(ws); d.setDate(d.getDate() + i);
        const dateKey = _dateKey(d);
        const dayPosts = _postsOnDate(d);
        html += `<div class="border-r border-b border-gray-100 min-h-[300px] p-2 space-y-1.5 bg-white hover:bg-gray-50/40 transition"
            data-date="${dateKey}"
            ondragover="window._calDragOver(event, '${dateKey}')"
            ondragleave="window._calDragLeave(event)"
            ondrop="window._calDrop(event, '${dateKey}')">
            ${dayPosts.map(p => _postChip(p, 'week')).join('')}${_activitiesOnDate(d).map(a => _activityChip(a, 'week')).join('')}
        </div>`;
    }
    html += `</div>`;
    return html;
}

// ── List View ─────────────────────────────────────────────────────
function _renderList() {
    const year = _anchor.getFullYear(), month = _anchor.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Filter tabs
    const tabs = [
        { key: 'all',       label: 'All' },
        { key: 'pending',   label: 'Pending Review' },
        { key: 'approved',  label: 'Approved & Scheduled' },
        { key: 'published', label: 'Published' },
    ];
    let html = `<div class="sticky top-0 z-10 bg-white border-b border-gray-200 px-4 flex gap-1 overflow-x-auto">`;
    tabs.forEach(t => {
        const active = _listFilter === t.key;
        html += `<button type="button" onclick="window._calSetListFilter('${t.key}')"
            class="shrink-0 px-3 py-2.5 text-xs font-bold border-b-2 transition ${active ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-gray-500 hover:text-gray-700'}">
            ${t.label}
        </button>`;
    });
    html += `</div>`;

    // Apply filter
    const statusSets = {
        all:       null,
        pending:   new Set(['draft', 'in_review']),
        approved:  new Set(['approved', 'scheduled']),
        published: new Set(['published']),
    };
    const allowedStatuses = statusSets[_listFilter];

    const groups = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, month, d);
        let posts = _postsOnDate(date);
        if (allowedStatuses) posts = posts.filter(p => allowedStatuses.has(p.status));
        if (posts.length > 0) groups.push({ date, posts });
    }

    if (groups.length === 0) {
        html += `<div class="flex flex-col items-center justify-center py-24 text-gray-400 gap-3">
            <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            <p class="text-sm font-medium">No posts${_listFilter !== 'all' ? ' in this filter' : ''} this month.</p>
        </div>`;
        return html;
    }

    html += `<div class="max-w-3xl mx-auto px-4 py-6 space-y-8">`;
    groups.forEach(({ date, posts }) => {
        const today = new Date(); today.setHours(0,0,0,0);
        const isToday = _dateKey(date) === _dateKey(today);
        html += `<div>
            <div class="flex items-center gap-3 mb-3">
                <span class="text-sm font-extrabold ${isToday ? 'text-emerald-700' : 'text-gray-700'}">
                    ${date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                    ${isToday ? '<span class="ml-2 text-[10px] bg-emerald-100 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full font-bold">Today</span>' : ''}
                </span>
                <div class="flex-1 h-px bg-gray-200"></div>
            </div>
            <div class="space-y-2">${posts.map(p => _listRow(p)).join('')}</div>
        </div>`;
    });
    html += `</div>`;
    return html;
}

window._calSetListFilter = function (key) {
    _listFilter = key;
    _render();
};

// ── Post chip (month/week) ────────────────────────────────────────
function _postChip(post, viewType) {
    const plat = PLATFORM_META[post.platform] || { label: post.platform, bg: '#9ca3af', text: 'text-white' };
    const sm = STATUS_META[post.status] || STATUS_META.draft;
    const posted = post.status === 'published';
    const publishing = post.status === 'publishing';
    const overdue = _isOverdue(post);
    // Posted posts show when they actually went live (publishedAt); everything else
    // shows the scheduled time.
    const stamp = posted && post.publishedAt ? new Date(post.publishedAt) : new Date(post.publishDate);
    const time = stamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const isDraggable = ['draft', 'in_review', 'approved', 'scheduled'].includes(post.status);

    const revisedBadge = post.isRevised ? `<span class="text-[9px] font-bold text-violet-600 bg-violet-50 border border-violet-200 px-1 rounded shrink-0">Revised</span>` : '';
    // #4: left border = assistant colour; status stays glanceable via the right-hand marker.
    const asstColor = _assistantColor(post.assistantId);
    const asstName = _assistantName(post.assistantId);

    // Right-hand status marker + chip tint give instant confirmation of *actual* state:
    //  • posted     → emerald tint + ✓  ("this really went out")
    //  • publishing → pulsing blue dot   ("going out right now")
    //  • overdue    → amber tint + pulsing amber dot ("should have posted, hasn't")
    //  • otherwise  → the normal status dot.
    let chipBg = 'bg-white hover:bg-gray-50', timeColor = 'text-gray-700', marker, titleSuffix = '';
    if (posted) {
        chipBg = 'bg-emerald-50 hover:bg-emerald-100';
        timeColor = 'text-emerald-700';
        marker = `<span class="text-emerald-600 text-xs font-extrabold shrink-0" title="Posted ${time}">✓</span>`;
        titleSuffix = ` · ✓ Posted ${time}`;
    } else if (publishing) {
        timeColor = 'text-blue-700';
        marker = `<span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" title="Publishing now…"></span>`;
        titleSuffix = ' · Publishing now…';
    } else if (overdue) {
        chipBg = 'bg-amber-50 hover:bg-amber-100';
        timeColor = 'text-amber-700';
        marker = `<span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" title="Overdue — not yet posted"></span>`;
        titleSuffix = ' · ⚠ Overdue — not yet posted';
    } else {
        marker = `<span class="w-1.5 h-1.5 rounded-full ${sm.dot} shrink-0" title="${sm.label}"></span>`;
    }

    const summary = post.caption || plat.label || post.platform || '';

    return `<div
        onclick="window._calOpenPost(${post.id})"
        onmouseenter="window._calShowPreview(event, ${post.id})"
        onmouseleave="window._calHidePreview()"
        ${isDraggable ? `draggable="true" ondragstart="window._calDragStart(event, ${post.id})"` : ''}
        data-post-id="${post.id}"
        class="group flex items-center gap-1.5 px-2 py-1 rounded-lg ${chipBg} shadow-sm cursor-pointer transition select-none text-left w-full"
        style="border-left:3px solid ${asstColor}"
        aria-label="${_escHtml(asstName)} · ${_escHtml(post.caption || post.platform)}${titleSuffix}">
        ${_platLogo(post.platform, 'sm')}
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold ${timeColor} truncate">${overdue ? '⚠ ' : ''}${time}</p>
            <p class="text-[11px] text-gray-500 truncate leading-tight">${_escHtml(summary.substring(0, 40))}</p>
        </div>
        ${revisedBadge}
        ${marker}
    </div>`;
}

// ── Hover preview popover ────────────────────────────────────────
// Calendar chips only have room for a time + short title, so hovering a chip
// pops a small card with the full caption and (if attached) the post image —
// "quicker to view" than opening the full side panel. Styles are injected at
// runtime (not added to style.css) because style.css is prebuilt Tailwind output
// and won't compile new arbitrary classes — same technique as explainers.js.
const _previewCache = new Map(); // postId -> { post, assets }
let _previewEl = null;
let _previewShowTimer = null;
let _previewHideTimer = null;
let _previewReqToken = 0;

function _injectPreviewStyles() {
    if (document.getElementById('cal-preview-styles')) return;
    const style = document.createElement('style');
    style.id = 'cal-preview-styles';
    style.textContent = [
        '.cal-hover-preview{position:fixed;z-index:100000;width:260px;max-width:calc(100vw - 24px);',
        '  background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 18px 40px -12px rgba(31,30,27,.28);',
        '  overflow:hidden;opacity:0;transform:translateY(4px);transition:opacity .12s ease,transform .12s ease;',
        '  pointer-events:none;}',
        '.cal-hover-preview.is-open{opacity:1;transform:translateY(0);pointer-events:auto;}',
        '.cal-hover-preview-img{display:block;width:100%;height:140px;object-fit:cover;background:#f3f4f6;}',
        '.cal-hover-preview-body{padding:10px 12px;}',
        '.cal-hover-preview-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#374151;margin-bottom:4px;}',
        '.cal-hover-preview-caption{font-size:12px;line-height:1.4;color:#4b5563;max-height:110px;overflow:hidden;white-space:pre-wrap;word-break:break-word;}',
        '@media (prefers-reduced-motion:reduce){.cal-hover-preview{transition:none;}}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
}

function _ensurePreviewEl() {
    if (_previewEl) return _previewEl;
    _previewEl = document.createElement('div');
    _previewEl.className = 'cal-hover-preview';
    _previewEl.addEventListener('mouseenter', () => {
        if (_previewHideTimer) { clearTimeout(_previewHideTimer); _previewHideTimer = null; }
    });
    _previewEl.addEventListener('mouseleave', () => window._calHidePreview());
    document.body.appendChild(_previewEl);
    return _previewEl;
}

function _positionPreview(anchorEl) {
    const el = _previewEl;
    const r = anchorEl.getBoundingClientRect();
    const pr = el.getBoundingClientRect();
    const gap = 8, margin = 8;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const below = (r.bottom + gap + pr.height) <= vh;
    const top = below ? r.bottom + gap : Math.max(margin, r.top - gap - pr.height);
    const left = Math.max(margin, Math.min(r.left, vw - pr.width - margin));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
}

function _renderPreviewContent(post, assets) {
    const plat = PLATFORM_META[post.platform] || { label: post.platform || '' };
    const img = (assets || []).find(a => a.assetType === 'image' && a.storageUrl);
    const caption = post.caption || '(No caption)';
    return `
        ${img ? `<img src="${img.storageUrl}" alt="" class="cal-hover-preview-img">` : ''}
        <div class="cal-hover-preview-body">
            <div class="cal-hover-preview-head">${_platAvatar(post.platform, 18)}<span>${_escHtml(plat.label)}</span></div>
            <p class="cal-hover-preview-caption">${_escHtml(caption)}</p>
        </div>`;
}

// Hover-intent delay avoids firing a fetch for every chip the cursor sweeps past.
window._calShowPreview = function (event, postId) {
    const anchorEl = event.currentTarget;
    if (_previewShowTimer) clearTimeout(_previewShowTimer);
    if (_previewHideTimer) { clearTimeout(_previewHideTimer); _previewHideTimer = null; }
    _previewShowTimer = setTimeout(async () => {
        _injectPreviewStyles();
        const el = _ensurePreviewEl();
        const token = ++_previewReqToken;
        let cached = _previewCache.get(postId);
        if (!cached) {
            const localPost = _posts.find(p => p.id === postId) || {};
            el.innerHTML = _renderPreviewContent(localPost, []);
            el.classList.add('is-open');
            _positionPreview(anchorEl);
            try {
                const res = await fetch(`/.netlify/functions/scheduled-posts?id=${postId}`);
                if (res.ok) {
                    const data = await res.json();
                    cached = { post: data.post, assets: data.assets || [] };
                    _previewCache.set(postId, cached);
                }
            } catch (e) { /* keep the local-data fallback already shown */ }
        }
        if (token !== _previewReqToken) return; // hovered away before the fetch resolved
        if (cached) {
            el.innerHTML = _renderPreviewContent(cached.post, cached.assets);
            el.classList.add('is-open');
            _positionPreview(anchorEl);
        }
    }, 180);
};

window._calHidePreview = function () {
    if (_previewShowTimer) { clearTimeout(_previewShowTimer); _previewShowTimer = null; }
    _previewReqToken++; // invalidate any in-flight fetch render
    if (_previewHideTimer) clearTimeout(_previewHideTimer);
    _previewHideTimer = setTimeout(() => {
        if (_previewEl) _previewEl.classList.remove('is-open');
    }, 100);
};

// #3: read-only chip for a completed assistant task, coloured by assistant.
function _activityChip(act, viewType) {
    const color = _assistantColor(act.assistantId);
    const name = _assistantName(act.assistantId);
    const time = new Date(act.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `<div
        class="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-50 text-left w-full select-none"
        style="border-left:3px solid ${color}"
        title="${_escHtml(name)} — task completed at ${time}">
        <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${color}"></span>
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-semibold text-gray-600 truncate">✓ ${_escHtml(name)}</p>
            ${viewType === 'week' ? `<p class="text-[10px] text-gray-400 truncate leading-tight">${time} · task done</p>` : ''}
        </div>
    </div>`;
}

// ── List row ──────────────────────────────────────────────────────
function _listRow(post) {
    const plat = PLATFORM_META[post.platform] || { label: post.platform, bg: '#9ca3af', text: 'text-white' };
    const sm = STATUS_META[post.status] || STATUS_META.draft;
    const posted = post.status === 'published';
    const overdue = _isOverdue(post);
    const dt = new Date(post.publishDate);
    const time = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    // The scheduled time is the headline; for posted/overdue we add a second line
    // confirming what actually happened.
    const postedAt = posted && post.publishedAt ? new Date(post.publishedAt) : null;
    const statusLine = posted
        ? `<p class="text-xs font-bold text-emerald-600 mt-1">✓ Posted${postedAt ? ' ' + postedAt.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</p>`
        : overdue
        ? `<p class="text-xs font-bold text-amber-700 mt-1">⚠ Overdue — scheduled time passed, not yet posted</p>`
        : '';

    // The right-hand badge: posted gets a check, overdue is recoloured so a past
    // date never reads as a calm "Scheduled".
    const badge = posted
        ? `<span class="text-xs font-bold px-2.5 py-1 rounded-full border bg-emerald-100 text-emerald-700 border-emerald-300 shrink-0 mt-1">✓ Posted</span>`
        : overdue
        ? `<span class="text-xs font-bold px-2.5 py-1 rounded-full border bg-amber-100 text-amber-700 border-amber-300 shrink-0 mt-1">Overdue</span>`
        : `<span class="text-xs font-bold px-2.5 py-1 rounded-full border ${sm.badge} shrink-0 mt-1">${sm.label}</span>`;

    return `<div onclick="window._calOpenPost(${post.id})"
        class="flex items-start gap-4 bg-white border border-gray-200 rounded-xl px-5 py-4 hover:border-emerald-300 hover:shadow-sm cursor-pointer transition">
        ${_platAvatar(post.platform, 36)}
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-extrabold text-gray-900">${plat.label}</span>
                <span class="text-xs font-bold text-gray-400">${time}</span>
                ${post.isAutonomous ? `<span class="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded-full">100% AI</span>` : ''}
            </div>
            <p class="text-sm text-gray-600 truncate">${_escHtml((post.caption || '').substring(0, 120) || '(No caption)')}</p>
            ${post.hashtags ? `<p class="text-xs text-blue-500 mt-1 truncate">${_escHtml(post.hashtags.substring(0, 80))}</p>` : ''}
            ${statusLine}
        </div>
        ${badge}
    </div>`;
}

// ── Open Format panel ────────────────────────────────────────
window._calOpenPost = async function (postId) {
    _openPostId = postId;
    _editMode = false;
    window._calHidePreview();

    const panel = document.getElementById('aura-panel');
    panel.classList.remove('hidden');

    // Load post detail (includes enriched assets)
    let post = _posts.find(p => p.id === postId);
    let assets = [];
    try {
        const res = await fetch(`/.netlify/functions/scheduled-posts?id=${postId}`);
        if (res.ok) {
            const data = await res.json();
            post = data.post;
            assets = data.assets || [];
            // Update cached copy
            const idx = _posts.findIndex(p => p.id === postId);
            if (idx >= 0) _posts[idx] = post;
        }
    } catch (e) { /* use cached */ }

    if (!post) return;

    const plat = PLATFORM_META[post.platform] || { emoji: '📣', label: post.platform, bg: 'bg-gray-500', text: 'text-white' };
    const sm = STATUS_META[post.status] || STATUS_META.draft;
    const dt = new Date(post.publishDate);

    // ── Header ────────────────────────────────────────────────────
    const iconEl = document.getElementById('panel-platform-icon');
    iconEl.className = 'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-sm overflow-hidden';
    iconEl.style.background = plat.bg || '#9ca3af';
    iconEl.innerHTML = `<span style="display:flex;width:20px;height:20px;color:#fff">${PLATFORM_LOGOS[post.platform] || '📣'}</span>`;
    document.getElementById('panel-platform-name').textContent = plat.label;
    const overdue = _isOverdue(post);
    const subEl = document.getElementById('panel-publish-date');
    if (post.status === 'published' && post.publishedAt) {
        // Strongest possible confirmation: show when it actually went live, not when it was scheduled.
        subEl.textContent = `✓ Posted ${new Date(post.publishedAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
        subEl.className = 'text-xs font-bold text-emerald-600 mt-0.5';
    } else if (overdue) {
        subEl.textContent = `⚠ Overdue — was due ${dt.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
        subEl.className = 'text-xs font-bold text-amber-700 mt-0.5';
    } else {
        subEl.textContent = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
        subEl.className = 'text-xs text-gray-500 mt-0.5';
    }
    const badgeEl = document.getElementById('panel-status-badge');
    if (overdue) {
        badgeEl.textContent = 'Overdue';
        badgeEl.className = 'text-xs font-bold px-2.5 py-1 rounded-full border bg-amber-100 text-amber-700 border-amber-300';
    } else {
        badgeEl.textContent = post.status === 'published' ? '✓ Published' : sm.label;
        badgeEl.className = `text-xs font-bold px-2.5 py-1 rounded-full border ${sm.badge}`;
    }

    // ── Section 1: Logistics ──────────────────────────────────────
    document.getElementById('panel-logistics-platform').textContent = plat.label;
    document.getElementById('panel-logistics-datetime').textContent = dt.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    document.getElementById('panel-logistics-format').textContent = (post.postFormat || '').replace(/_/g, ' ');

    // ── Section 2: Content ────────────────────────────────────────
    const captionDisplay = document.getElementById('panel-caption-display');
    const captionEdit = document.getElementById('panel-caption-edit');
    captionDisplay.textContent = post.caption || '(No caption)';
    captionEdit.value = post.caption || '';
    captionDisplay.classList.remove('hidden');
    captionEdit.classList.add('hidden');

    // Assets
    const assetsList = document.getElementById('panel-assets-list');
    const assetsWrap = document.getElementById('panel-assets-wrap');
    const assetsHint = document.getElementById('panel-assets-hint');
    const isEditable = !['published', 'cancelled', 'rejected'].includes(post.status);

    if (assetsHint) {
        isEditable && assets.length > 0 ? assetsHint.classList.remove('hidden') : assetsHint.classList.add('hidden');
    }

    // SC2/SC4: always show Creative Assets section
    assetsWrap.classList.remove('hidden');

    // SC5: no-media warning for non-published editable posts
    const noMediaWarning = document.getElementById('panel-assets-no-media-warning');
    if (noMediaWarning) {
        noMediaWarning.classList.toggle('hidden', assets.length > 0 || !isEditable);
    }

    if (assets.length > 0) {
        assetsList.innerHTML = assets.map(a => {
            const detachBtn = isEditable
                ? `<button type="button"
                    onclick="window._calDetachAsset(${a.id})"
                    title="Remove from post"
                    class="absolute top-1 right-1 w-5 h-5 bg-white/90 border border-gray-300 rounded-full flex items-center justify-center text-gray-500 hover:text-red-600 hover:border-red-300 shadow-sm transition text-xs font-bold z-10"
                    >✕</button>`
                : '';
            if (a.assetType === 'image' && a.storageUrl) {
                return `<div class="relative aspect-square rounded-xl overflow-hidden border border-gray-200 bg-gray-100">
                    <img src="${a.storageUrl}" alt="${_escHtml(a.name)}" class="w-full h-full object-cover">
                    ${detachBtn}
                </div>`;
            }
            if (a.assetType === 'video') {
                return `<div class="relative aspect-square rounded-xl border border-gray-200 bg-gray-100 flex flex-col items-center justify-center gap-1 text-gray-400">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.72v6.56a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                    <p class="text-[10px] text-center px-2 truncate w-full text-center">${_escHtml(a.name)}</p>
                    ${detachBtn}
                </div>`;
            }
            if (a.externalUrl) {
                return `<div class="relative aspect-square">
                    <a href="${a.externalUrl}" target="_blank" rel="noopener"
                        class="block w-full h-full rounded-xl border border-blue-200 bg-blue-50 flex flex-col items-center justify-center gap-1 text-blue-600 hover:bg-blue-100 transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
                        <p class="text-[10px] px-2 truncate w-full text-center">${_escHtml(a.name)}</p>
                    </a>
                    ${detachBtn}
                </div>`;
            }
            return '';
        }).join('');
    } else if (isEditable) {
        // SC1: Attach Media CTA placeholder when no assets on an editable post
        assetsList.innerHTML = `<div class="col-span-2 flex flex-col items-center justify-center gap-2 py-6 border-2 border-dashed border-gray-200 rounded-xl text-gray-400 cursor-pointer hover:border-emerald-400 hover:text-emerald-600 transition" onclick="window._calOpenAssetPicker && window._calOpenAssetPicker()">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            <span class="text-xs font-semibold">Attach Media</span>
            <span class="text-[10px] text-center px-4">Add an image or video to boost engagement</span>
        </div>`;
    } else {
        // SC4: read-only empty state for published posts
        assetsList.innerHTML = `<p class="col-span-2 text-xs text-gray-400 italic py-3 text-center">No media attached to this post.</p>`;
    }

    // Links
    const linksWrap = document.getElementById('panel-links-wrap');
    const linksContent = document.getElementById('panel-links-content');
    if (post.linkUrl || post.ctaText) {
        linksWrap.classList.remove('hidden');
        linksContent.innerHTML = '';
        if (post.linkUrl) {
            linksContent.innerHTML += `<a href="${_escHtml(post.linkUrl)}" target="_blank" rel="noopener" class="flex items-center gap-1 text-xs text-blue-600 hover:underline truncate">
                <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
                ${_escHtml(post.linkUrl)}
            </a>`;
        }
        if (post.ctaText) {
            linksContent.innerHTML += `<p class="text-xs text-gray-700 mt-1">CTA: <span class="font-bold">${_escHtml(post.ctaText)}</span></p>`;
        }
        if (post.utmParams) {
            linksContent.innerHTML += `<p class="text-xs text-gray-400 mt-0.5 font-mono truncate">${_escHtml(post.utmParams)}</p>`;
        }
    } else { linksWrap.classList.add('hidden'); }

    // Tags
    const tagsWrap = document.getElementById('panel-tags-wrap');
    const tagsContent = document.getElementById('panel-tags-content');
    const tagText = [post.hashtags, post.mentions].filter(Boolean).join('  ');
    if (tagText) {
        tagsWrap.classList.remove('hidden');
        tagsContent.textContent = tagText;
    } else { tagsWrap.classList.add('hidden'); }

    // ── Section 3: Governance ─────────────────────────────────────
    document.getElementById('panel-gov-status').textContent = sm.label;
    document.getElementById('panel-gov-owner').textContent = post.ownerLabel || 'Be More Swan';
    document.getElementById('panel-gov-campaign').textContent = post.campaign || '—';
    document.getElementById('panel-gov-pillar').textContent = post.pillar || '—';

    const autoRow = document.getElementById('panel-gov-autonomous-row');
    post.isAutonomous ? autoRow.classList.remove('hidden') : autoRow.classList.add('hidden');

    const rejRow = document.getElementById('panel-rejection-reason');
    if (post.status === 'rejected' && post.rejectionReason) {
        rejRow.textContent = `Rejected: ${post.rejectionReason}`;
        rejRow.classList.remove('hidden');
    } else { rejRow.classList.add('hidden'); }

    // ── Revised-post diff — US-SMM-2.2.2 ────────────────────────
    const diffSection = document.getElementById('panel-revision-diff');
    if (diffSection) {
        if (post.isRevised && post.revisedFromPostId) {
            // Fetch original rejected post to show what feedback was given
            const origPost = _posts.find(p => p.id === post.revisedFromPostId);
            if (origPost) {
                diffSection.classList.remove('hidden');
                diffSection.innerHTML = `
                    <h4 class="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-3">Revision History</h4>
                    <div class="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-xs space-y-2">
                        <p class="font-bold text-violet-700">Revised from rejected post</p>
                        ${origPost.rejectionReason ? `<div class="bg-white border border-violet-100 rounded-lg px-3 py-2">
                            <p class="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Rejection feedback</p>
                            <p class="text-gray-700 leading-relaxed">${_escHtml(origPost.rejectionReason)}</p>
                        </div>` : ''}
                        ${origPost.caption && origPost.caption !== post.caption ? `<div class="bg-white border border-violet-100 rounded-lg px-3 py-2">
                            <p class="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Original caption</p>
                            <p class="text-gray-500 line-through leading-relaxed">${_escHtml(origPost.caption.substring(0, 200))}</p>
                        </div>` : ''}
                    </div>`;
            } else {
                diffSection.classList.add('hidden');
            }
        } else {
            diffSection.classList.add('hidden');
        }
    }

    // ── Platform post preview — US-SMM-2.1.1 ─────────────────────
    const previewContainer = document.getElementById('panel-platform-preview');
    let approveCharGated = false; // any platform over its character limit?
    if (previewContainer && window.PlatformPostPreview) {
        const previewResult = window.PlatformPostPreview.render(previewContainer, {
            post,
            assets,
            platforms: post.crossPostPlatforms?.length ? post.crossPostPlatforms : undefined,
        });
        approveCharGated = !!previewResult.approveBlocked;
    }

    // ── Footer actions ────────────────────────────────────────────
    const publishedActions = document.getElementById('panel-actions-published');
    const editableActions = document.getElementById('panel-actions-editable');
    const saveBtn = document.getElementById('btn-panel-save');

    if (post.status === 'published') {
        publishedActions.classList.remove('hidden');
        editableActions.classList.add('hidden');
        const liveLink = document.getElementById('panel-live-link');
        if (post.platformPostUrl) {
            liveLink.href = post.platformPostUrl;
            liveLink.classList.remove('pointer-events-none', 'opacity-50');
        } else {
            liveLink.href = '#';
            liveLink.classList.add('pointer-events-none', 'opacity-50');
        }
    } else if (['cancelled', 'rejected'].includes(post.status)) {
        publishedActions.classList.add('hidden');
        editableActions.classList.add('hidden');
    } else {
        publishedActions.classList.add('hidden');
        editableActions.classList.remove('hidden');
        if (saveBtn) saveBtn.classList.add('hidden');
    }

    // Update Approve button label contextually. A post that's already been
    // approved is either parked at 'approved' or (SMM flow) auto-scheduled into
    // an optimal slot → 'scheduled'. Both mean "no longer awaiting approval", so
    // the button must read as done and be disabled; the user's remaining actions
    // (edit copy / reject) stay available via the other footer buttons.
    const approveBtn = document.getElementById('btn-panel-approve');
    if (approveBtn) {
        if (post.status === 'scheduled') { approveBtn.textContent = '✓ Scheduled'; approveBtn.disabled = true; approveBtn.classList.add('opacity-50'); approveBtn.title = ''; }
        else if (post.status === 'approved') { approveBtn.textContent = '✓ Approved'; approveBtn.disabled = true; approveBtn.classList.add('opacity-50'); approveBtn.title = ''; }
        else { approveBtn.textContent = '✓ Approve'; approveBtn.disabled = false; approveBtn.classList.remove('opacity-50'); approveBtn.title = ''; }
        // Char-limit gate has the final say for still-approvable posts: an
        // over-limit post must stay blocked even though it's in_review/draft.
        if (approveCharGated && !approveBtn.disabled) {
            approveBtn.disabled = true;
            approveBtn.title = 'Fix character limit issues before approving.';
            approveBtn.classList.add('opacity-50');
        }
    }

    // ── Next Post navigator (Pending Review only) ─────────────────
    const pendingPosts = _posts
        .filter(p => p.status === 'in_review')
        .sort((a, b) => new Date(a.publishDate) - new Date(b.publishDate));
    const pendingIdx = pendingPosts.findIndex(p => p.id === postId);
    const navEl = document.getElementById('panel-review-nav');
    if (navEl) {
        if (pendingPosts.length > 0 && pendingIdx >= 0) {
            const current = pendingIdx + 1;
            const total = pendingPosts.length;
            const hasPrev = pendingIdx > 0;
            const hasNext = pendingIdx < total - 1;
            navEl.classList.remove('hidden');
            navEl.innerHTML = `
                <div class="flex items-center justify-between gap-2">
                    <button type="button" onclick="window._calNavPost(-1)"
                        ${hasPrev ? '' : 'disabled'}
                        class="p-1.5 rounded-lg text-gray-400 ${hasPrev ? 'hover:bg-gray-100 hover:text-gray-700 cursor-pointer' : 'opacity-30 cursor-not-allowed'} transition">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
                    </button>
                    <span class="text-xs font-bold text-gray-500">Reviewing <span class="text-gray-900">${current}</span> of <span class="text-gray-900">${total}</span> pending</span>
                    <button type="button" onclick="window._calNavPost(1)"
                        ${hasNext ? '' : 'disabled'}
                        class="p-1.5 rounded-lg text-gray-400 ${hasNext ? 'hover:bg-gray-100 hover:text-gray-700 cursor-pointer' : 'opacity-30 cursor-not-allowed'} transition">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                    </button>
                </div>`;
        } else {
            navEl.classList.add('hidden');
        }
    }

    // SC1: Show quality review section and trigger load
    const qualitySection = document.getElementById('panel-quality-section');
    if (qualitySection) {
        qualitySection.classList.remove('hidden');
        _loadPostQuality(postId);
    }
};

// SC1/SC7/SC8: Load quality review for a post
async function _loadPostQuality(postId) {
    const loadingEl = document.getElementById('panel-quality-loading');
    const scoreWrap = document.getElementById('panel-quality-score-wrap');
    const scoreEl = document.getElementById('panel-quality-score');
    const warningsWrap = document.getElementById('panel-quality-warnings-wrap');
    const warningsEl = document.getElementById('panel-quality-warnings');
    const approveBlock = document.getElementById('panel-quality-approve-block');
    const suggestionsWrap = document.getElementById('panel-quality-suggestions-wrap');
    const suggestionsList = document.getElementById('panel-quality-suggestions');
    const tierGate = document.getElementById('panel-quality-tier-gate');

    // Reset
    [scoreWrap, warningsWrap, suggestionsWrap, approveBlock, tierGate].forEach(el => el?.classList.add('hidden'));
    if (loadingEl) loadingEl.classList.remove('hidden');

    try {
        const res = await fetch('/.netlify/functions/review-post-quality', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId }),
        });
        if (loadingEl) loadingEl.classList.add('hidden');

        if (res.status === 403) {
            const data = await res.json().catch(() => ({}));
            if (data.error === 'tier_required') { tierGate?.classList.remove('hidden'); return; }
        }
        if (!res.ok) return;

        const data = await res.json();

        // SC4: Brand voice score badge with colour coding
        if (scoreEl && scoreWrap) {
            const score = data.brandVoiceScore ?? 0;
            const colour = score >= 75 ? 'text-emerald-600' : score >= 50 ? 'text-amber-500' : 'text-red-500';
            scoreEl.className = `text-sm font-extrabold ${colour}`;
            scoreEl.textContent = `${score}/100`;
            scoreWrap.classList.remove('hidden');
        }

        // SC5: Compliance warnings
        if (warningsEl && warningsWrap) {
            const warnings = data.complianceWarnings || [];
            if (warnings.length > 0) {
                warningsEl.innerHTML = warnings.map(w =>
                    `<span class="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-red-50 text-red-700 border border-red-200">${_escHtml(w)}</span>`
                ).join('');
                warningsWrap.classList.remove('hidden');
                if (approveBlock) approveBlock.classList.remove('hidden');
                // Gate the approve button
                const btn = document.getElementById('btn-panel-approve');
                if (btn) { btn.disabled = true; btn.title = 'Resolve compliance warnings first.'; btn.classList.add('opacity-50'); }
            }
        }

        // SC6: Suggestions
        if (suggestionsList && suggestionsWrap) {
            const suggestions = data.suggestions || [];
            if (suggestions.length > 0) {
                suggestionsList.innerHTML = suggestions.map(s =>
                    `<li class="flex items-start gap-2"><span class="text-emerald-500 shrink-0 mt-0.5">•</span><span>${_escHtml(s)}</span></li>`
                ).join('');
                suggestionsWrap.classList.remove('hidden');
            }
        }
    } catch {
        if (loadingEl) loadingEl.classList.add('hidden');
    }
}

function toggleQualityPanel() {
    const body = document.getElementById('panel-quality-body');
    const chevron = document.getElementById('panel-quality-chevron');
    if (!body) return;
    const hidden = body.classList.toggle('hidden');
    if (chevron) chevron.textContent = hidden ? '▼' : '▲';
}

window._calNavPost = function (direction) {
    const pendingPosts = _posts
        .filter(p => p.status === 'in_review')
        .sort((a, b) => new Date(a.publishDate) - new Date(b.publishDate));
    const idx = pendingPosts.findIndex(p => p.id === _openPostId);
    if (idx < 0) return;
    const next = pendingPosts[idx + direction];
    if (next) window._calOpenPost(next.id);
};

window._calClosePanel = function () {
    document.getElementById('aura-panel')?.classList.add('hidden');
    _openPostId = null;
    _editMode = false;
};

// ── Asset detachment ──────────────────────────────────────────────
window._calDetachAsset = async function (assetId) {
    if (!_openPostId) return;
    if (!confirm('Remove this asset from the post? The asset will be returned to Pending status.')) return;

    try {
        const res = await fetch(`/.netlify/functions/scheduled-posts?id=${_openPostId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ detachAssetId: assetId }),
        });
        const data = await res.json();
        if (!res.ok) {
            alert(data.error || 'Failed to remove asset. Please try again.');
            return;
        }

        // Update local cache
        _updateLocalPost(data.post);

        // Scenario 2: warn if post needs attention
        if (data.requiresAttention) {
            // Show a brief attention banner inside the panel
            const panel = document.getElementById('aura-panel');
            if (panel) {
                const banner = document.createElement('div');
                banner.className = 'mx-5 mb-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700 font-semibold flex items-start gap-2';
                banner.innerHTML = `<svg class="w-4 h-4 shrink-0 mt-0.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M12 3C7.029 3 3 7.029 3 12s4.029 9 9 9 9-4.029 9-9-4.029-9-9-9z"/></svg>
                    <span>${_escHtml(data.message)}</span>`;
                const footer = document.getElementById('panel-footer');
                if (footer) footer.parentNode.insertBefore(banner, footer);
                setTimeout(() => banner.remove(), 6000);
            }
        }

        // Refresh the panel to reflect removed asset
        await window._calOpenPost(_openPostId);
        _render(); // re-render chips in case status changed
    } catch (e) {
        alert('Connection failed. Please try again.');
    }
};

// ── Edit mode ─────────────────────────────────────────────────────
window._calToggleEdit = function () {
    _editMode = !_editMode;
    document.getElementById('panel-caption-display').classList.toggle('hidden', _editMode);
    document.getElementById('panel-caption-edit').classList.toggle('hidden', !_editMode);
    document.getElementById('btn-panel-save').classList.toggle('hidden', !_editMode);
    const editBtn = document.getElementById('btn-panel-edit');
    if (editBtn) editBtn.textContent = _editMode ? '✕ Cancel Edit' : '✏ Edit Copy';
};

window._calSaveEdits = async function () {
    if (!_openPostId) return;
    const newCaption = document.getElementById('panel-caption-edit').value;
    try {
        const res = await fetch(`/.netlify/functions/scheduled-posts?id=${_openPostId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ caption: newCaption }),
        });
        if (res.ok) {
            const { post } = await res.json();
            _updateLocalPost(post);
            // Refresh panel
            window._calToggleEdit();
            document.getElementById('panel-caption-display').textContent = newCaption || '(No caption)';
        }
    } catch (e) { alert('Save failed. Please try again.'); }
};

// ── Governance actions ────────────────────────────────────────────
window._calApprovePost = async function () {
    if (!_openPostId) return;
    const post = _posts.find(p => p.id === _openPostId);
    if (post && new Date(post.publishDate) < new Date()) {
        // Scheduled time has passed — show resolution modal
        _pendingApproveId = _openPostId;
        const dt = new Date(post.publishDate);
        const label = dt.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const msgEl = document.getElementById('approve-past-msg');
        if (msgEl) msgEl.textContent = `The scheduled time for this post (${label}) has passed. Choose an option below:`;
        // Pre-fill reschedule input with current time + 1h
        const newDefault = new Date(Date.now() + 3600000);
        const pad = n => String(n).padStart(2, '0');
        const defaultVal = `${newDefault.getFullYear()}-${pad(newDefault.getMonth()+1)}-${pad(newDefault.getDate())}T${pad(newDefault.getHours())}:${pad(newDefault.getMinutes())}`;
        const dtInput = document.getElementById('approve-reschedule-dt');
        if (dtInput) dtInput.value = defaultVal;
        document.getElementById('modal-approve-past')?.classList.remove('hidden');
        return;
    }
    await _patchStatus(_openPostId, 'approved');
    _showApprovalConfirmation();
};

window._calApprovePastPublishNow = async function () {
    document.getElementById('modal-approve-past')?.classList.add('hidden');
    if (!_pendingApproveId) return;
    await _patchStatus(_pendingApproveId, 'approved', { publishDate: new Date().toISOString() });
    _pendingApproveId = null;
    _showApprovalConfirmation();
};

window._calApprovePastReschedule = async function () {
    const dtInput = document.getElementById('approve-reschedule-dt');
    const val = dtInput?.value;
    if (!val) { alert('Please select a new date and time.'); return; }
    const newDate = new Date(val);
    if (isNaN(newDate)) { alert('Invalid date selected.'); return; }
    document.getElementById('modal-approve-past')?.classList.add('hidden');
    if (!_pendingApproveId) return;
    await _patchStatus(_pendingApproveId, 'approved', { publishDate: newDate.toISOString() });
    _pendingApproveId = null;
    _showApprovalConfirmation();
};

window._calDismissApprovalModal = function () {
    document.getElementById('modal-approve-past')?.classList.add('hidden');
    _pendingApproveId = null;
};

function _showApprovalConfirmation() {
    const post = _openPostId ? _posts.find(p => p.id === _openPostId) : null;
    if (!post) return;
    const dt = new Date(post.publishDate);
    const plat = PLATFORM_META[post.platform]?.label || post.platform;
    const dateLabel = dt.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const banner = document.createElement('div');
    banner.className = 'mx-5 mb-2 p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 font-semibold flex items-start gap-2';
    banner.innerHTML = `<svg class="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
        <span>Post approved. Scheduled for ${dateLabel} on ${_escHtml(plat)}.</span>`;
    const footer = document.getElementById('panel-footer');
    if (footer) footer.parentNode.insertBefore(banner, footer);
    setTimeout(() => banner.remove(), 5000);
}

window._calCancelPost = async function () {
    if (!_openPostId) return;
    if (!confirm('Remove this post from the queue? It will be cancelled.')) return;
    await _patchStatus(_openPostId, 'cancelled');
    window._calClosePanel();
};

// ── Rejection flow — US-SMM-2.2.2 ────────────────────────────────
window._calOpenRejectPanel = function () {
    const feedbackEl = document.getElementById('reject-feedback-text');
    const toggleEl   = document.getElementById('reject-rule-toggle');
    const scopeEl    = document.getElementById('reject-rule-scope');
    const errEl      = document.getElementById('reject-feedback-error');
    if (feedbackEl) feedbackEl.value = '';
    if (toggleEl)   { toggleEl.checked = false; }
    if (scopeEl)    scopeEl.classList.add('hidden');
    if (errEl)      errEl.classList.add('hidden');
    document.getElementById('modal-reject-post')?.classList.remove('hidden');

    // Wire toggle to show/hide scope selector
    const toggle = document.getElementById('reject-rule-toggle');
    if (toggle) {
        toggle.onchange = () => {
            document.getElementById('reject-rule-scope')?.classList.toggle('hidden', !toggle.checked);
        };
    }
};

window._calDismissRejectModal = function () {
    document.getElementById('modal-reject-post')?.classList.add('hidden');
};

window._calSubmitRejection = async function () {
    const feedbackText = (document.getElementById('reject-feedback-text')?.value || '').trim();
    const errEl = document.getElementById('reject-feedback-error');
    if (!feedbackText) {
        errEl?.classList.remove('hidden');
        return;
    }
    errEl?.classList.add('hidden');

    const applyAsRule = !!(document.getElementById('reject-rule-toggle')?.checked);
    const platform = applyAsRule ? (document.getElementById('reject-rule-platform')?.value || '') : '';

    document.getElementById('modal-reject-post')?.classList.add('hidden');

    try {
        const res = await fetch('/.netlify/functions/reject-post', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId: _openPostId, feedbackText, applyAsRule, platform: platform || undefined }),
        });
        const data = await res.json();
        if (!res.ok) { alert(data.error || 'Rejection failed. Please try again.'); return; }

        // Update local cache — mark post as rejected
        const post = _posts.find(p => p.id === _openPostId);
        if (post) { post.status = 'rejected'; post.rejectionReason = feedbackText; }

        // If rule was saved, show confirmation banner in panel
        if (data.ruleId && data.ruleText) {
            const banner = document.createElement('div');
            banner.className = 'mx-5 mb-2 p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800 font-semibold flex items-start gap-2';
            banner.innerHTML = `<svg class="w-4 h-4 shrink-0 mt-0.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                <span>Rule added to Content Rules Library: <em>${_escHtml(data.ruleText)}</em></span>`;
            const footer = document.getElementById('panel-footer');
            if (footer) footer.parentNode.insertBefore(banner, footer);
            setTimeout(() => banner.remove(), 7000);
        }

        // Add revised draft to local posts cache so it appears on the calendar
        if (data.revisedPostId) {
            // Reload posts to pick up the new draft
            await _loadAndRender();
        } else {
            _render();
        }

        // Refresh panel showing rejection state
        await window._calOpenPost(_openPostId);
    } catch (e) {
        alert('Connection failed. Please try again.');
    }
};

async function _patchStatus(postId, status, extra = {}) {
    try {
        const res = await fetch(`/.netlify/functions/scheduled-posts?id=${postId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, ...extra }),
        });
        if (res.ok) {
            const { post } = await res.json();
            _updateLocalPost(post);
            // Refresh panel with new status
            await window._calOpenPost(postId);
            _render(); // re-render chips
        }
    } catch (e) { alert('Action failed. Please try again.'); }
}

// ── Drag & Drop rescheduling ──────────────────────────────────────
window._calDragStart = function (e, postId) {
    _dragPostId = postId;
    e.dataTransfer.effectAllowed = 'move';
    e.target.classList.add('opacity-50');
    setTimeout(() => e.target.classList.add('opacity-50'), 0);
};

window._calDragOver = function (e, dateKey) {
    e.preventDefault();
    _dragTargetDate = dateKey;
    const cell = e.currentTarget;
    cell.classList.add('ring-2', 'ring-emerald-400', 'ring-inset');
};

window._calDragLeave = function (e) {
    e.currentTarget.classList.remove('ring-2', 'ring-emerald-400', 'ring-inset');
};

window._calDrop = function (e, dateKey) {
    e.preventDefault();
    e.currentTarget.classList.remove('ring-2', 'ring-emerald-400', 'ring-inset');
    if (!_dragPostId) return;

    const post = _posts.find(p => p.id === _dragPostId);
    if (!post) { _dragPostId = null; return; }

    const [y, m, d] = dateKey.split('-').map(Number);
    const original = new Date(post.publishDate);
    const newDate = new Date(y, m - 1, d, original.getHours(), original.getMinutes());

    if (_dateKey(original) === dateKey) { _dragPostId = null; return; } // same day

    const oldLabel = original.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const newLabel = newDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

    const msgEl = document.getElementById('reschedule-msg');
    if (msgEl) msgEl.textContent = `Move "${post.caption?.substring(0,40) || 'this post'}" from ${oldLabel} to ${newLabel}?`;

    _pendingReschedule = { postId: _dragPostId, newDate };
    document.getElementById('modal-reschedule')?.classList.remove('hidden');
    _dragPostId = null;
};

window._calCancelReschedule = function () {
    _pendingReschedule = null;
    document.getElementById('modal-reschedule')?.classList.add('hidden');
    _render(); // restore opacity
};

window._calConfirmReschedule = async function () {
    if (!_pendingReschedule) return;
    const { postId, newDate } = _pendingReschedule;
    document.getElementById('modal-reschedule')?.classList.add('hidden');
    _pendingReschedule = null;

    try {
        const res = await fetch(`/.netlify/functions/scheduled-posts?id=${postId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publishDate: newDate.toISOString() }),
        });
        if (res.ok) {
            const { post } = await res.json();
            _updateLocalPost(post);
            // Reload range to include new date if needed
            await _loadAndRender();
        }
    } catch (e) { alert('Reschedule failed. Please try again.'); }
};

function _attachDragDrop() {
    // After DOM render, add dragend listeners to chips to clean up opacity
    document.querySelectorAll('[data-post-id]').forEach(el => {
        el.addEventListener('dragend', () => {
            el.classList.remove('opacity-50');
        });
    });
}

// ── Helpers ───────────────────────────────────────────────────────
function _postsOnDate(date) {
    const key = _dateKey(date);
    return _posts.filter(p => {
        if (!p.publishDate) return false;
        if (!_matchesAssistantFilter(p.assistantId)) return false;
        if (!_matchesPlatformFilter(p.platform)) return false;
        return _dateKey(new Date(p.publishDate)) === key;
    });
}

// #3: completed assistant activity on a given day (respects the assistant filter).
function _activitiesOnDate(date) {
    const key = _dateKey(date);
    return _activities.filter(a => {
        if (!a.at) return false;
        if (!_matchesAssistantFilter(a.assistantId)) return false;
        return _dateKey(new Date(a.at)) === key;
    });
}

function _dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function _weekStart(date) {
    const d = new Date(date);
    const day = d.getDay(); // 0=Sun
    d.setDate(d.getDate() - day);
    d.setHours(0,0,0,0);
    return d;
}

function _escHtml(str) {
    return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _updateLocalPost(updated) {
    const idx = _posts.findIndex(p => p.id === updated.id);
    if (idx >= 0) _posts[idx] = updated;
    else _posts.push(updated);
}

})(); // end IIFE
