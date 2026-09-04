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
    threads:   `<svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 013.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 00-2.215-.221z"/></svg>`,
    tiktok:    `<svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full"><path d="M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>`,
    youtube:   `<svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`,
    blog:      `<svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full"><path d="M5 3h11a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zm2 4v2h7V7H7zm0 4v2h7v-2H7zm0 4v2h5v-2H7z"/></svg>`,
    newsletter:`<svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full"><path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 4.24l-8 4.62-8-4.62V6l8 4.62L20 6v2.24z"/></svg>`,
};

const PLATFORM_META = {
    facebook:  { label: 'Facebook',    bg: '#1877F2', text: 'text-white' },
    instagram: { label: 'Instagram',   bg: 'linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)', text: 'text-white' },
    linkedin:  { label: 'LinkedIn',    bg: '#0A66C2', text: 'text-white' },
    x:         { label: 'X (Twitter)', bg: '#000000', text: 'text-white' },
    threads:   { label: 'Threads',     bg: '#000000', text: 'text-white' },
    tiktok:    { label: 'TikTok',      bg: '#010101', text: 'text-white' },
    youtube:   { label: 'YouTube',     bg: '#FF0000', text: 'text-white' },
    blog:      { label: 'Blog',        bg: '#7c3aed', text: 'text-white' },
    // ⚠️ Not a social platform, and neither is 'blog' — this map is the calendar's vocabulary for
    // "where a piece of content goes", which is what the platform filter actually filters on.
    newsletter:{ label: 'Newsletter',  bg: '#0d9488', text: 'text-white' },
};

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
    // The X quota park. Amber, not grey: unlike 'paused' this one is waiting on something the user
    // may need to act on, and it resumes by itself only when the quota resets. Without an entry
    // here every lookup falls back to STATUS_META.draft, so a committed post parked on quota would
    // render on the calendar labelled "Draft" — the one word that is certainly wrong.
    paused_credits:  { label: 'Paused · X credits', badge: 'bg-amber-100 text-amber-700 border-amber-300', chipBorder: 'border-amber-400', dot: 'bg-amber-500' },
    // Newsletter issue states. ⚠️ Without an entry here each falls back to STATUS_META.draft, so a
    // SENT issue would render on the calendar labelled "Draft" — exactly the failure recorded for
    // paused_credits above. 'sending' is blue like 'publishing', its social twin: in flight, no
    // action needed. 'sent' is emerald like 'published': done and correct.
    sending:         { label: 'Sending',     badge: 'bg-blue-100 text-blue-700 border-blue-300',   chipBorder: 'border-blue-500',    dot: 'bg-blue-500' },
    sent:            { label: 'Sent',        badge: 'bg-emerald-100 text-emerald-700 border-emerald-300', chipBorder: 'border-emerald-500', dot: 'bg-emerald-500' },
    failed:          { label: 'Failed',      badge: 'bg-red-100 text-red-700 border-red-300',      chipBorder: 'border-red-500',     dot: 'bg-red-500' },
    missed:          { label: 'Missed',      badge: 'bg-orange-100 text-orange-700 border-orange-300', chipBorder: 'border-orange-300', dot: 'bg-amber-500' },
    rejected:        { label: 'Rejected',    badge: 'bg-red-100 text-red-700 border-red-300',      chipBorder: 'border-red-500',     dot: 'bg-red-500' },
    cancelled:       { label: 'Cancelled',   badge: 'bg-gray-100 text-gray-400 border-gray-200',   chipBorder: 'border-gray-300',    dot: 'bg-gray-300' },
};

// Stacked-layers glyph for a cross-post group — one logical post going to several platforms.
// Deliberately NOT one of the platform logos: the chip is claiming "more than one network", and
// borrowing (say) the Instagram mark for that would misreport where the post is going.
const MULTI_PLATFORM_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`;

// Avatar for a grouped post. Same footprint as _platAvatar so chips stay aligned whether or not
// they're cross-posted.
function _multiAvatar(sizePx = 36) {
    const inner = `<span style="display:flex;width:${Math.round(sizePx*0.55)}px;height:${Math.round(sizePx*0.55)}px;color:#fff">${MULTI_PLATFORM_ICON}</span>`;
    return `<div style="width:${sizePx}px;height:${sizePx}px;border-radius:10px;background:linear-gradient(135deg,#334155,#64748b);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,.15)">${inner}</div>`;
}

// The generated mirror of src/config/post-status.ts, loaded ahead of this file in workspace.html.
// A draft carries a proposed publish_date from the moment it's created; only pressing Schedule
// commits it. Never retype the status list here — a hand copy is exactly what drifts out of step
// with the server filter in scheduled-posts.ts.
function _scheduleActive(status) {
    return !!(window.PlatformConstants && window.PlatformConstants.isScheduleActive(status));
}

// ── Cross-post grouping ───────────────────────────────────────────
// A post the user cross-posts is fanned out into one scheduled_posts row per platform, every
// sibling carrying the same crosspost_group_id. Rendering those rows individually filled a day cell
// with four near-identical chips, which is the clutter this collapses away — the same collapse the
// Review Queue already does. Rows with no group id (standalone, or legacy) key by their own id and
// therefore always stand alone.
function _groupKey(post) {
    return post.crosspostGroupId ? `g:${post.crosspostGroupId}` : `id:${post.id}`;
}

// Catalogue order, read from the generated constants rather than a hand-written list — the
// hand-written one in the Review Queue had four entries, which sorted Threads and YouTube to the
// end of every group.
function _platformRank(platform) {
    const order = (window.PlatformConstants && window.PlatformConstants.all) || [];
    const i = order.findIndex(p => p.id === platform);
    return i < 0 ? 99 : i;
}

// Collapse a flat post list into one entry per logical post: { members, rep, platforms }.
function _groupPosts(posts) {
    const byKey = new Map();
    posts.forEach(p => {
        const k = _groupKey(p);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(p);
    });
    const groups = [];
    byKey.forEach(members => {
        members.sort((a, b) => _platformRank(a.platform) - _platformRank(b.platform));
        groups.push({ members, rep: members[0], platforms: members.map(m => m.platform) });
    });
    groups.sort((a, b) => new Date(a.rep.publishDate) - new Date(b.rep.publishDate));
    return groups;
}

// The status a grouped chip reports. Ordered "needs attention first, done last" so a group is never
// shown as finished while a sibling is still queued, and a single failed platform is never hidden
// behind three successes.
const _GROUP_STATUS_PRIORITY = ['failed', 'paused', 'paused_credits', 'publishing', 'scheduled', 'approved', 'published'];
function _groupStatus(members) {
    for (const s of _GROUP_STATUS_PRIORITY) {
        if (members.some(m => m.status === s)) return s;
    }
    return members[0] ? members[0].status : 'scheduled';
}

// Every row of the logical post this one belongs to, in catalogue order. Siblings always share a
// publish slot, so they are loaded together in any range that contains one of them.
function _siblingsOf(post) {
    if (!post) return [];
    if (!post.crosspostGroupId) return [post];
    const sibs = _posts.filter(p => p.crosspostGroupId === post.crosspostGroupId);
    if (!sibs.some(p => p.id === post.id)) sibs.push(post);
    sibs.sort((a, b) => _platformRank(a.platform) - _platformRank(b.platform));
    return sibs;
}

// Human list of the platforms in a group ("Instagram, LinkedIn and X").
function _platformNames(platforms) {
    const labels = platforms.map(p => (PLATFORM_META[p] || {}).label || p);
    if (labels.length <= 1) return labels[0] || '';
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

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
let _posts = [];                 // all loaded posts (social — scheduled_posts)
let _blogPosts = [];             // long-form blog posts (blog_posts) surfaced read-only on the calendar
// Newsletter issues (newsletter_issues), read-only, same treatment as blog posts above. Only
// scheduled/sending/sent ever arrive — the server refuses to plot a draft, which has no agreed date.
let _newsletterIssues = [];
let _openPostId = null;          // post currently open in the editor, so a refresh can clear it
let _dragPostId = null;          // drag source
let _dragTargetDate = null;      // drop target
let _pendingReschedule = null;   // { postIds, newDate }
let _listFilter = 'all';         // 'all' | 'scheduled' | 'published' | 'attention'
// #3/#4: assistant activity + per-assistant colour-coding + filter
let _activities = [];            // completed task runs (get-calendar-activity)
let _assistants = [];            // org assistants for names + colour assignment
let _assistantFilter = 'all';    // 'all' | <assistantId>
let _platformFilter  = 'all';    // 'all' | 'facebook' | 'instagram' | 'linkedin' | 'x'
// When the calendar is embedded in the assistant-detail Calendar tab it is LOCKED to one
// assistant: the assistant filter is preset + hidden, and the colour legend is suppressed.
let _lockedAssistant = false;
// Does the locked assistant PUBLISH? Social/blog roles post to platforms; the records roles
// (Lead Generator, AR Clerk, Support, …) never do — their calendar holds scheduled records and
// completed task runs only. False strips the publishing-only chrome: the platform filter and the
// posted/overdue status legend. Always true for the global Content Calendar page, which spans
// every assistant. See _renderStatusLegend + _renderAssistantControls.
let _publishesContent = true;
// Scheduled Data Hub records (leads/invoices/tickets/… with approval_status='scheduled') for the
// locked assistant — only fetched in the assistant Calendar tab, rendered as timeline chips.
let _scheduledRecords = [];
// ── Pending outreach (lead roles only) ───────────────────────────────────────
// The follow-up emails this assistant's cadence is GOING TO SEND — sequence_enrolments.next_send_at
// via lead-threads.ts `calendar`. Switched on per role by modules.hasLeadOutreach.
//
// ⚠️ Read this next to _scheduledRecords above, because on a Lead Generator's calendar the two sit
// side by side and mean nearly opposite things:
//   • a RECORD chip (🗓, yellow) is a lead whose outreach has ALREADY gone out. `scheduled_for` is
//     the chase reminder left behind for a human. Nothing sends on that date.
//   • a FOLLOW-UP chip (✉, indigo) is an email that WILL be delivered on that date, by the worker,
//     to a third party, unless a reply/suppression/do-not-contact gate stops it first.
// That distinction is the whole reason the past-date rule exists on one and not the other, and it
// is why they are separate arrays rather than one merged "scheduled things" list.
let _followUps = [];
let _leadOutreach = false;

// An assistant's identity colour — the user's own choice where they've made one, otherwise the
// stable id-derived fallback. Resolved through window.AssistantColors (/assistant-colors.js) so the
// calendar, the My Assistants cards, the detail hero and the notification inbox all agree.
//
// ⚠️ This used to key the palette by the assistant's INDEX in _assistants (load order), while
// notifications.js keyed the same palette by `id % length`. Both files claimed to mirror the other;
// they only agreed when load order happened to match id order, so one assistant could be indigo in
// the inbox and amber here. Inline styles, not Tailwind classes — arbitrary colour classes don't
// compile. Null/unknown assistant → neutral grey.
function _assistantColor(id) {
    if (id == null) return window.AssistantColors?.NEUTRAL || '#9ca3af';
    const a = _assistants.find(x => x.id === id);
    return window.AssistantColors?.colorFor(id, a && a.avatarColor) || '#9ca3af';
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
// opts.assistantId (optional) — scope the calendar to a single assistant (the assistant-detail
// Calendar tab). Omitted → the global, all-assistants Content Calendar page.
// opts.publishesContent (optional, default true) — false for roles that publish nothing, which
// removes the platform filter and rewrites the status legend. Only meaningful alongside
// assistantId: the global page always spans publishing and non-publishing assistants at once.
// opts.leadOutreach (optional, default false) — true for the lead roles, which adds the pending
// follow-up email chips and their drag-to-reschedule. Opt-in; see _followUps.
window.initCalendar = async function (opts = {}) {
    if (opts.assistantId != null) {
        _assistantFilter = String(opts.assistantId);
        _lockedAssistant = true;
        _publishesContent = opts.publishesContent !== false;
        _leadOutreach = opts.leadOutreach === true;
    } else {
        _assistantFilter = 'all';
        _lockedAssistant = false;
        _publishesContent = true;
        // The global Content Calendar spans every assistant and has no single lead context to
        // reschedule against, so pending outreach stays off there.
        _leadOutreach = false;
    }
    _renderStatusLegend();
    document.getElementById('cal-btn-prev')?.addEventListener('click', _navPrev);
    document.getElementById('cal-btn-next')?.addEventListener('click', _navNext);
    document.getElementById('cal-btn-today')?.addEventListener('click', _navToday);
    document.querySelectorAll('.cal-view-btn').forEach(btn => {
        btn.addEventListener('click', () => _setView(btn.dataset.view));
    });
    await _loadAndRender();
};

// ── Navigation ────────────────────────────────────────────────────
// Changing the anchor or the view changes the DATE RANGE, and the range is what every loader is
// keyed on: _loadAndRender fetches exactly _getDateRange(), so _posts/_activities/_blogPosts only
// ever hold the one month (or week) that was last fetched. Navigating with a bare _render()
// therefore drew the new range out of data that could not contain it — the grid came up empty,
// most visibly on the FUTURE months, which is precisely where scheduled work lives. Every nav
// control has to reload.
//
// Order matters: paint first so the title and grid move under the user's click without waiting on
// the network, then fill in when the fetch lands. The interim paint can only ever be empty for the
// new range (chips are matched by date key), never wrong.
function _navRefresh() {
    _render();
    void _loadAndRender();
}
// Month steps land on the 1st rather than doing setMonth() in place. setMonth() keeps the day of
// month, so from an anchor sitting on the 29th/30th/31st it OVERFLOWS: on the 31st of July,
// setMonth(8) asks for "31 September", which JS rolls forward to 1 October — September is skipped
// and never renders at all. The anchor's day is meaningless in month/list view (only its year and
// month are read), so normalising it here costs nothing; week view steps by 7 days, which cannot
// overflow, and keeps its exact date.
function _stepMonth(delta) {
    _anchor = new Date(_anchor.getFullYear(), _anchor.getMonth() + delta, 1);
    _anchor.setHours(0, 0, 0, 0);
}
function _navPrev() {
    if (_view === 'week') _anchor.setDate(_anchor.getDate() - 7);
    else _stepMonth(-1);
    _navRefresh();
}
function _navNext() {
    if (_view === 'week') _anchor.setDate(_anchor.getDate() + 7);
    else _stepMonth(1);
    _navRefresh();
}
function _navToday() {
    _anchor = new Date(); _anchor.setHours(0,0,0,0);
    _navRefresh();
}
function _setView(v) {
    _view = v;
    document.querySelectorAll('.cal-view-btn').forEach(btn => {
        const active = btn.dataset.view === v;
        btn.className = `cal-view-btn px-3 py-1.5 text-sm font-bold rounded-lg transition cursor-pointer ${active ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`;
    });
    // Month/list ⇄ week are different ranges (a week view of a month-loaded range is a subset, but
    // week→month is not), so this reloads too rather than guessing which direction is safe.
    _navRefresh();
}

// ── Load posts + assistant activity from API ──────────────────────
// Now that every nav control reloads, a user clicking "next" three times has three loads in flight
// for three different ranges. Each one stamps a token and only commits to module state if it is
// still the newest — otherwise a slow response for March could land after February's and repaint
// the grid with the wrong month's posts.
let _loadToken = 0;

async function _loadAndRender() {
    const token = ++_loadToken;
    try {
        const { from, to } = _getDateRange();
        // Posts, completed assistant activity, and the assistant list (for colours/filter) in parallel.
        const [postsRes, actRes, asstRes, blogRes, nlRes] = await Promise.all([
            fetch(`/.netlify/functions/scheduled-posts?from=${from.toISOString()}&to=${to.toISOString()}`),
            fetch(`/.netlify/functions/get-calendar-activity?from=${from.toISOString()}&to=${to.toISOString()}`),
            _assistants.length ? Promise.resolve(null) : fetch('/.netlify/functions/get-assistants'),
            fetch(`/.netlify/functions/blog-posts?from=${from.toISOString()}&to=${to.toISOString()}`),
            // The from/to branch of newsletter-issues.ts, NOT its list response — that one carries
            // segments, custom fields, templates and the brand theme, and this refetches on every
            // month change.
            fetch(`/.netlify/functions/newsletter-issues?from=${from.toISOString()}&to=${to.toISOString()}`),
        ]);

        // null = "no definitive answer" (a 500, say) — leave the previous value alone rather than
        // blanking the grid on a transient failure. [] is a real, empty answer.
        let posts = null, activities = null, assistants = null, blogPosts = null, newsletterIssues = null, records = [], followUps = [];

        if (postsRes.ok) {
            posts = (await postsRes.json()).posts || [];
        } else if (postsRes.status === 403) {
            // US3 AC3.3: onboarding guard rejected this — surface it gracefully, don't crash.
            const body = await postsRes.json().catch(() => ({}));
            if (body.error === 'onboarding_incomplete') {
                window.showToast?.(body.message || 'Please complete your onboarding checklist to unlock this feature.');
            }
            posts = [];
        }

        if (actRes && actRes.ok) activities = (await actRes.json()).activities || [];
        if (asstRes && asstRes.ok) assistants = (await asstRes.json()).assistants || [];
        if (blogRes && blogRes.ok) blogPosts = (await blogRes.json()).posts || [];
        // Left null on any non-OK answer, per the rule above: an environment without the newsletter
        // schema applied answers with an error, and blanking every OTHER kind of entry on the grid
        // because of it would be a worse calendar than one issue short.
        if (nlRes && nlRes.ok) newsletterIssues = (await nlRes.json()).issues || [];

        // Assistant Calendar tab only: overlay this assistant's scheduled Data Hub records so
        // "Approve & Schedule" in the Review Queue shows up here as scheduled work.
        if (_lockedAssistant && _assistantFilter !== 'all') {
            try {
                const rr = await fetch(`/.netlify/functions/assistant-records?scheduled=1&assistantId=${_assistantFilter}&from=${from.toISOString()}&to=${to.toISOString()}`);
                records = rr.ok ? ((await rr.json()).records || []) : [];
            } catch { records = []; }
        }

        // Lead roles only: the follow-up emails due in this range. Swallowed on failure like the
        // records fetch above — an un-migrated environment (sequence_enrolments arrives with a
        // manual db/outreach-sequences.sql) answers 503, and a calendar that renders everything
        // else is better than one that renders nothing.
        if (_leadOutreach && _lockedAssistant && _assistantFilter !== 'all') {
            try {
                const fr = await fetch('/.netlify/functions/lead-threads', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        action: 'calendar',
                        assistantId: Number(_assistantFilter),
                        from: from.toISOString(),
                        to: to.toISOString(),
                    }),
                });
                followUps = fr.ok ? ((await fr.json()).followUps || []) : [];
            } catch { followUps = []; }
        }

        if (token !== _loadToken) return;   // superseded by a newer navigation

        if (posts) _posts = posts;
        if (activities) _activities = activities;
        if (assistants) {
            _assistants = assistants;
            // Seed the shared colour cache so chips/dots that only carry an assistantId resolve to
            // the user's chosen colour rather than the id-derived fallback.
            window.AssistantColors?.rememberAll(assistants);
        }
        if (blogPosts) _blogPosts = blogPosts;
        if (newsletterIssues) _newsletterIssues = newsletterIssues;
        _scheduledRecords = records;
        _followUps = followUps;
    } catch (e) { console.warn('Calendar load error:', e); }
    if (token !== _loadToken) return;
    // Always (re)populate the toolbar controls — the calendar.html fragment (and its fresh
    // <select>) is re-injected on every view entry, even though _assistants is cached here.
    _renderAssistantControls();
    _render();
}

// Populate the assistant + platform filter dropdowns and colour legend.
function _renderAssistantControls() {
    const sel = document.getElementById('cal-assistant-filter');
    if (sel) {
        // Locked to one assistant (detail Calendar tab): hide the picker, keep the preset filter.
        if (_lockedAssistant) {
            sel.classList.add('hidden');
        } else {
            sel.classList.remove('hidden');
            sel.innerHTML = `<option value="all">All assistants</option>` +
                _assistants.map(a => `<option value="${a.id}">${_escHtml(a.name || ('Assistant #' + a.id))}</option>`).join('');
            sel.value = String(_assistantFilter);
            if (!sel.dataset.bound) {
                sel.dataset.bound = '1';
                sel.addEventListener('change', () => { _assistantFilter = sel.value; _render(); });
            }
        }
    }

    // Platform filter — publishing roles only. A non-publishing assistant has no posts to filter,
    // so the dropdown offered Instagram/YouTube/Blog over a grid that can only hold scheduled
    // records and completed task runs. Hidden the same way as the locked assistant picker above;
    // the filter is also reset to 'all' so a stale selection made on the global page can't travel
    // in and silently filter this grid down to nothing with no visible control to undo it.
    const psel = document.getElementById('cal-platform-filter');
    if (!_publishesContent) _platformFilter = 'all';
    if (psel) {
        psel.classList.toggle('hidden', !_publishesContent);
        if (!psel.dataset.bound) {
            psel.dataset.bound = '1';
            psel.addEventListener('change', () => { _platformFilter = psel.value; _render(); });
        }
        psel.value = _platformFilter;
    }

    const legend = document.getElementById('cal-legend');
    if (legend) {
        legend.innerHTML = _assistants.map(a =>
            `<span class="inline-flex items-center gap-1.5 text-xs text-gray-500">
                <span class="w-2.5 h-2.5 rounded-full" style="background:${_assistantColor(a.id)}"></span>${_escHtml(a.name || ('Assistant #' + a.id))}
            </span>`).join('');
        legend.classList.toggle('hidden', _lockedAssistant || _assistants.length === 0);
    }

    _renderStatusLegend();
}

// Status legend strip. The publishing variant (posted / scheduled / overdue) is the markup's
// default and is what the global Content Calendar and every social/blog assistant sees. A
// non-publishing assistant gets the two markers its grid can actually contain — the yellow 🗓
// chip (_recordChip: a scheduled record, e.g. a lead chase reminder) and the ✓ chip
// (_activityChip: a completed task run). "Posted (live)" and "Overdue" are dropped: nothing on
// this grid is ever published, and _recordChip has no overdue state to explain.
//
// Written in BOTH directions rather than only rewriting the non-publishing case, so it stays
// correct if it is ever called twice against the same (already-rewritten) node.
function _renderStatusLegend() {
    const strip = document.getElementById('cal-status-legend');
    if (!strip) return;
    const item = (marker, label) =>
        `<span class="inline-flex items-center gap-1.5 text-xs text-gray-500">${marker} ${label}</span>`;
    // The pending-outreach marker, lead roles only. It is listed FIRST because it is the only
    // thing on this grid that will act on a third party by itself — the reminder and the completed
    // run are both records of what a person did or has to do.
    const outreachItem = _leadOutreach
        ? item('<span class="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>', 'Email to be sent')
        : '';
    strip.innerHTML = _publishesContent
        ? item('<span class="text-emerald-600 font-extrabold">✓</span>', 'Posted (live)') +
          item('<span class="w-2.5 h-2.5 rounded-full bg-yellow-500"></span>', 'Scheduled') +
          item('<span class="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse"></span>', 'Overdue')
        : outreachItem +
          item('<span class="w-2.5 h-2.5 rounded-full bg-yellow-500"></span>', _leadOutreach ? 'Chase reminder' : 'Scheduled') +
          item('<span class="text-gray-500 font-extrabold">✓</span>', 'Completed');
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
        const dayGroups = _postsOnDate(date);

        const tdClass = `relative border-r border-b border-gray-100 ${isToday ? 'bg-emerald-50/40' : 'bg-white hover:bg-gray-50/60'} transition p-1.5`;

        html += `<div class="${tdClass}" data-date="${dateKey}"
            ondragover="window._calDragOver(event, '${dateKey}')"
            ondragleave="window._calDragLeave(event)"
            ondrop="window._calDrop(event, '${dateKey}')">`;
        html += `<div class="flex items-center justify-end mb-1">
            <span class="${isToday ? 'w-6 h-6 bg-emerald-600 text-white rounded-full flex items-center justify-center text-xs font-extrabold' : 'text-xs font-bold text-gray-500 px-1'}">${day}</span>
        </div>`;
        const dayActs = _activitiesOnDate(date);
        const dayBlogs = _blogPostsOnDate(date);
        const dayIssues = _newsletterIssuesOnDate(date);
        const dayRecords = _scheduledRecordsOnDate(date);
        const dayFollowUps = _followUpsOnDate(date);
        // Pending outreach sits ABOVE the reminders and the completed runs: it is the only entry
        // in the cell that is going to do something on its own.
        html += `<div class="space-y-1">${dayGroups.map(g => _postChip(g, 'month')).join('')}${dayBlogs.map(b => _blogChip(b, 'month')).join('')}${dayIssues.map(_issueChip).join('')}${dayFollowUps.map(f => _followUpChip(f, 'month')).join('')}${dayRecords.map(r => _recordChip(r, 'month')).join('')}${dayActs.map(a => _activityChip(a, 'month')).join('')}</div>`;
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
        const dayGroups = _postsOnDate(d);
        html += `<div class="border-r border-b border-gray-100 min-h-[300px] p-2 space-y-1.5 bg-white hover:bg-gray-50/40 transition"
            data-date="${dateKey}"
            ondragover="window._calDragOver(event, '${dateKey}')"
            ondragleave="window._calDragLeave(event)"
            ondrop="window._calDrop(event, '${dateKey}')">
            ${dayGroups.map(g => _postChip(g, 'week')).join('')}${_blogPostsOnDate(d).map(b => _blogChip(b, 'week')).join('')}${_newsletterIssuesOnDate(d).map(_issueChip).join('')}${_followUpsOnDate(d).map(f => _followUpChip(f, 'week')).join('')}${_scheduledRecordsOnDate(d).map(r => _recordChip(r, 'week')).join('')}${_activitiesOnDate(d).map(a => _activityChip(a, 'week')).join('')}
        </div>`;
    }
    html += `</div>`;
    return html;
}

// ── List View ─────────────────────────────────────────────────────
function _renderList() {
    const year = _anchor.getFullYear(), month = _anchor.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Filter tabs. There is no "Pending Review" tab: unapproved drafts never reach the calendar, so
    // it could only ever have rendered an empty list. They live in the Review Queue.
    const tabs = [
        { key: 'all',       label: 'All' },
        { key: 'scheduled', label: 'Scheduled' },
        { key: 'published', label: 'Published' },
        { key: 'attention', label: 'Needs Attention' },
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
        // ⚠️ These sets span posts, blog posts AND newsletter issues, which use different words for
        // the same two moments: an issue is 'sending' where a post is 'publishing', and 'sent'
        // where a post is 'published'. Omitting either would drop every newsletter issue out of
        // the tab it belongs in while leaving it in All — a silent disappearance of exactly the
        // kind the paused_credits note below records.
        scheduled: new Set(['approved', 'scheduled', 'publishing', 'sending']),
        published: new Set(['published', 'sent']),
        // 'paused_credits' belongs here, not under Scheduled: the post is committed but parked on
        // spent X quota, which is the definition of needing attention. Omitting it left a parked
        // post reachable only from the All tab — the same silent disappearance that the status
        // itself caused before it was added to SCHEDULE_ACTIVE_STATUSES.
        attention: new Set(['failed', 'paused', 'paused_credits']),
    };
    const allowedStatuses = statusSets[_listFilter];

    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, month, d);
        let postGroups = _postsOnDate(date);
        let blogs = _blogPostsOnDate(date);
        let issues = _newsletterIssuesOnDate(date);
        // Scheduled Data Hub records are approval_status='scheduled', so they only
        // belong under the "All" and "Scheduled" filters.
        let records = (_listFilter === 'all' || _listFilter === 'scheduled') ? _scheduledRecordsOnDate(date) : [];
        // Pending follow-ups belong under "All" and "Scheduled" for the same reason records do —
        // they are future work, never a published or failed thing.
        let followUps = (_listFilter === 'all' || _listFilter === 'scheduled') ? _followUpsOnDate(date) : [];
        if (allowedStatuses) {
            // Filter INSIDE each cross-post group, then drop groups the filter emptied — a post
            // whose Instagram sibling failed still belongs under "Needs Attention", showing only
            // the sibling that needs it.
            postGroups = postGroups
                .map(g => {
                    const members = g.members.filter(p => allowedStatuses.has(p.status));
                    return members.length ? { members, rep: members[0], platforms: members.map(m => m.platform) } : null;
                })
                .filter(Boolean);
            blogs = blogs.filter(p => allowedStatuses.has(p.status));
            issues = issues.filter(i => allowedStatuses.has(i.status));
        }
        if (postGroups.length > 0 || blogs.length > 0 || issues.length > 0 || records.length > 0 || followUps.length > 0) {
            days.push({ date, postGroups, blogs, issues, records, followUps });
        }
    }

    if (days.length === 0) {
        html += `<div class="flex flex-col items-center justify-center py-24 text-gray-400 gap-3">
            <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            <p class="text-sm font-medium">${_listFilter === 'all' ? 'Nothing scheduled this month. Approve a draft in the Review Queue to put it on the calendar.' : 'No posts in this filter this month.'}</p>
        </div>`;
        return html;
    }

    html += `<div class="max-w-3xl mx-auto px-4 py-6 space-y-8">`;
    days.forEach(({ date, postGroups, blogs, issues, records, followUps }) => {
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
            <div class="space-y-2">${postGroups.map(g => _listRow(g)).join('')}${(blogs || []).map(b => _blogChip(b, 'list')).join('')}${(issues || []).map(_issueChip).join('')}${(followUps || []).map(_listFollowUpRow).join('')}${(records || []).map(_listRecordRow).join('')}</div>
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
// Takes a GROUP from _postsOnDate. A cross-post renders as one chip labelled "Multiple"; opening it
// gives per-platform tabs.
function _postChip(group, viewType) {
    const post = group.rep;
    const members = group.members;
    const multi = members.length > 1;
    const plat = PLATFORM_META[post.platform] || { label: post.platform, bg: '#9ca3af', text: 'text-white' };
    const status = _groupStatus(members);
    const sm = STATUS_META[status] || STATUS_META.draft;
    const posted = status === 'published';
    const publishing = status === 'publishing';
    const overdue = members.some(_isOverdue);
    // Posted posts show when they actually went live (publishedAt); everything else
    // shows the scheduled time.
    const stamp = posted && post.publishedAt ? new Date(post.publishedAt) : new Date(post.publishDate);
    const time = stamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const isDraggable = ['approved', 'scheduled'].includes(status);

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

    // The one-line identity of the chip. A cross-post reads "Multiple" rather than naming one of its
    // platforms — the whole point of collapsing the group is that no single platform is the answer.
    const platLabel = multi ? `Multiple (${members.length})` : plat.label;
    const summary = post.caption || platLabel || post.platform || '';
    const platNames = _platformNames(group.platforms);

    return `<div
        onclick="window._calOpenPost(${post.id})"
        onmouseenter="window._calShowPreview(event, ${post.id})"
        onmouseleave="window._calHidePreview()"
        ${isDraggable ? `draggable="true" ondragstart="window._calDragStart(event, ${post.id})"` : ''}
        data-post-id="${post.id}"
        class="group flex items-center gap-1.5 px-2 py-1 rounded-lg ${chipBg} shadow-sm cursor-pointer transition select-none text-left w-full"
        style="border-left:3px solid ${asstColor}"
        aria-label="${_escHtml(asstName)} · ${_escHtml(platLabel)}${multi ? ` (${_escHtml(platNames)})` : ''} · ${_escHtml(post.caption || '')}${titleSuffix}">
        ${multi ? _multiAvatar(16) : _platAvatar(post.platform, 16)}
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold ${timeColor} truncate">${overdue ? '⚠ ' : ''}${time}${multi ? ` · <span class="font-extrabold">Multiple</span>` : ''}</p>
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
    const img = (assets || []).find(a => a.assetType === 'image' && a.storageUrl);
    const caption = post.caption || '(No caption)';
    // Hovering a "Multiple" chip should answer "which platforms?" without a click, so the header
    // lists every sibling's logo rather than repeating the representative's.
    const siblings = _siblingsOf(post);
    const head = siblings.length > 1
        ? `${siblings.map(s => _platAvatar(s.platform, 18)).join('')}<span>${_escHtml(_platformNames(siblings.map(s => s.platform)))}</span>`
        : `${_platAvatar(post.platform, 18)}<span>${_escHtml((PLATFORM_META[post.platform] || {}).label || post.platform || '')}</span>`;
    return `
        ${img ? `<img src="${img.storageUrl}" alt="" class="cal-hover-preview-img">` : ''}
        <div class="cal-hover-preview-body">
            <div class="cal-hover-preview-head">${head}</div>
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

// Scheduled Data Hub record chip (assistant Calendar tab) — future work, not a completed run,
// so it reads "🗓 scheduled" rather than the activity "✓ done" chip.
function _scheduledRecordsOnDate(date) {
    const key = _dateKey(date);
    return _scheduledRecords.filter(r => r.scheduledFor && _dateKey(new Date(r.scheduledFor)) === key);
}
// Clicking opens the item's detail (LeadCalendarModal); dragging moves its due date. Both were
// added in the same change and for the same reason: this chip was previously inert with a comment
// saying "records open from the Data Hub", which asked the user to leave the calendar, find the
// right tab and search for a row by name to answer "what IS this?".
function _recordChip(rec, viewType) {
    const color = _assistantColor(_assistantFilter === 'all' ? null : Number(_assistantFilter));
    const time = new Date(rec.scheduledFor).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    // "Chase reminder" only for the lead roles, where that is what scheduled_for provably is
    // (lead-generation.ts stamps it after a send). Every other records role uses the generic word,
    // because their scheduled_for means whatever their own flow put there.
    const kindWord = _leadOutreach ? 'chase reminder' : 'scheduled';
    return `<div
        onclick="window._calOpenRecord(${rec.id})"
        draggable="true"
        ondragstart="window._calDragStart(event, { kind: 'record', id: ${rec.id} })"
        data-cal-record-id="${rec.id}"
        class="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-yellow-50 hover:bg-yellow-100 cursor-pointer transition text-left w-full select-none"
        style="border-left:3px solid ${color}"
        title="${_escHtml(rec.title || '')} — ${kindWord} ${time} · ${_escHtml(rec.recordType || '')}">
        <span class="w-1.5 h-1.5 rounded-full shrink-0 bg-yellow-500"></span>
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-semibold text-gray-600 truncate">🗓 ${_escHtml(rec.title || rec.recordType || 'Scheduled')}</p>
            ${viewType === 'week' ? `<p class="text-[10px] text-gray-400 truncate leading-tight">${time} · ${kindWord}</p>` : ''}
        </div>
    </div>`;
}

// ── Pending outreach (lead roles) ────────────────────────────────────────────
// One chip per follow-up email the cadence is going to send. Indigo and ✉, deliberately unlike
// the yellow 🗓 reminder beside it: a user who cannot tell these two apart at a glance cannot tell
// "you owe this lead a call" from "we are emailing this stranger on Thursday".
function _followUpsOnDate(date) {
    const key = _dateKey(date);
    return _followUps.filter(f => f.nextSendAt && _dateKey(new Date(f.nextSendAt)) === key);
}

// The worker refuses to send into a thread that is no longer 'open' — Phase 2a's reply detection
// acting as 2b's stop condition. A chip for one of those is still drawn (the row IS due, and
// hiding it would make the follow-up look cancelled when the enrolment is still active), but drawn
// greyed and NOT draggable: moving the date of a send that is going to be refused is busywork.
function _followUpBlocked(f) {
    return f.threadState && f.threadState !== 'open';
}

function _followUpChip(f, viewType) {
    const time = new Date(f.nextSendAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const blocked = _followUpBlocked(f);
    const label = `Follow-up #${f.nextStep}`;
    const tone = blocked
        ? { bg: 'bg-gray-50 hover:bg-gray-100', dot: 'bg-gray-400', text: 'text-gray-500', edge: '#9ca3af' }
        : { bg: 'bg-indigo-50 hover:bg-indigo-100', dot: 'bg-indigo-500', text: 'text-indigo-700', edge: '#6366f1' };
    const title = blocked
        ? `${f.title || ''} — ${label} due ${time}, on hold: they have replied`
        : `${f.title || ''} — ${label} sends ${time}`;
    return `<div
        onclick="window._calOpenFollowUp(${f.threadId})"
        ${blocked ? '' : `draggable="true" ondragstart="window._calDragStart(event, { kind: 'followup', id: ${f.threadId} })"`}
        data-cal-followup-thread="${f.threadId}"
        class="flex items-center gap-1.5 px-2 py-1 rounded-lg ${tone.bg} cursor-pointer transition text-left w-full select-none"
        style="border-left:3px solid ${tone.edge}"
        title="${_escHtml(title)}">
        <span class="w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}"></span>
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold ${tone.text} truncate">✉ ${time}${blocked ? ' · on hold' : ''}</p>
            <p class="text-[11px] text-gray-500 truncate leading-tight">${_escHtml((f.title || 'Lead').substring(0, 40))}</p>
        </div>
    </div>`;
}

// Full-width list-view row for a pending follow-up. Mirrors _listRecordRow's shape so the two
// read as one list, tinted to match its own chip.
function _listFollowUpRow(f) {
    const time = new Date(f.nextSendAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const blocked = _followUpBlocked(f);
    const shell = blocked
        ? 'bg-gray-50 border-gray-200'
        : 'bg-indigo-50 border-indigo-200 hover:border-indigo-300';
    return `<div onclick="window._calOpenFollowUp(${f.threadId})"
        class="flex items-start gap-4 ${shell} border rounded-xl px-5 py-4 cursor-pointer transition"
        style="border-left:3px solid ${blocked ? '#9ca3af' : '#6366f1'}">
        <span class="w-9 h-9 rounded-full ${blocked ? 'bg-gray-100' : 'bg-indigo-100'} flex items-center justify-center text-base shrink-0">✉</span>
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-extrabold text-gray-900 truncate">${_escHtml(f.title || 'Lead')}</span>
                <span class="text-xs font-bold text-gray-400">${time}</span>
            </div>
            <p class="text-xs text-gray-500">Follow-up #${f.nextStep}${f.contactEmail ? ` · ${_escHtml(f.contactEmail)}` : ''}</p>
        </div>
        <span class="text-xs font-bold px-2.5 py-1 rounded-full border shrink-0 mt-1 ${
            blocked ? 'bg-gray-100 text-gray-500 border-gray-300' : 'bg-indigo-100 text-indigo-700 border-indigo-300'
        }">${blocked ? 'On hold' : 'Sending'}</span>
    </div>`;
}

// Scheduled Data Hub record as a full-width list row (assistant Calendar list view).
// Mirrors _listRow's layout but tinted yellow like _recordChip so it reads as
// "scheduled work", not a social post. Opens the same detail modal the chip does.
function _listRecordRow(rec) {
    const color = _assistantColor(_assistantFilter === 'all' ? null : Number(_assistantFilter));
    const time = new Date(rec.scheduledFor).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `<div
        onclick="window._calOpenRecord(${rec.id})"
        class="flex items-start gap-4 bg-yellow-50 border border-yellow-200 hover:border-yellow-300 rounded-xl px-5 py-4 cursor-pointer transition"
        style="border-left:3px solid ${color}">
        <span class="w-9 h-9 rounded-full bg-yellow-100 flex items-center justify-center text-base shrink-0">🗓</span>
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-extrabold text-gray-900 truncate">${_escHtml(rec.title || rec.recordType || 'Scheduled')}</span>
                <span class="text-xs font-bold text-gray-400">${time}</span>
            </div>
            ${rec.recordType ? `<p class="text-xs text-gray-500 capitalize">${_escHtml(rec.recordType)}</p>` : ''}
        </div>
        <span class="text-xs font-bold px-2.5 py-1 rounded-full border bg-yellow-100 text-yellow-700 border-yellow-300 shrink-0 mt-1">${_leadOutreach ? 'Chase reminder' : 'Scheduled'}</span>
    </div>`;
}

// ── List row ──────────────────────────────────────────────────────
// Takes a GROUP (see _postsOnDate) — a cross-post is one row reading "Multiple", with its platform
// logos shown inline since the list view has the width for them.
function _listRow(group) {
    const post = group.rep;
    const members = group.members;
    const multi = members.length > 1;
    const plat = PLATFORM_META[post.platform] || { label: post.platform, bg: '#9ca3af', text: 'text-white' };
    const status = _groupStatus(members);
    const sm = STATUS_META[status] || STATUS_META.draft;
    const posted = status === 'published';
    const overdue = members.some(_isOverdue);
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

    // Grouped rows name themselves "Multiple" and then SHOW the platforms — the list view has the
    // width the month chip doesn't, so the user gets the answer without opening anything.
    const platStrip = multi
        ? `<span class="flex items-center gap-1 shrink-0" title="${_escHtml(_platformNames(group.platforms))}">
               ${members.map(m => _platAvatar(m.platform, 18)).join('')}
           </span>`
        : '';

    return `<div onclick="window._calOpenPost(${post.id})"
        class="flex items-start gap-4 bg-white border border-gray-200 rounded-xl px-5 py-4 hover:border-emerald-300 hover:shadow-sm cursor-pointer transition">
        ${multi ? _multiAvatar(36) : _platAvatar(post.platform, 36)}
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-extrabold text-gray-900">${multi ? 'Multiple' : plat.label}</span>
                ${platStrip}
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
// ── Opening a post ────────────────────────────────────────────────
// Hands the post to the real editor rather than showing one of its own.
//
// The calendar used to carry a slide-out panel of its own: Publishing Logistics (platform, format),
// an Edit Copy textarea, its own Approve / Reject / Remove-from-queue buttons, its own quality
// panel and its own past-schedule modal. It was a second, older post surface — the one the editor
// amalgamation never reached — so the same post offered different controls depending on where you
// clicked it, and the calendar's version had none of the format picker, layers, text-on-image or
// sound work. All of that is deleted; this is the whole of what used to be ~650 lines.
//
// openPostReview is defined in workspace.html, which hosts this view (and the assistant-detail
// Calendar tab). It resolves the cross-post group itself, so passing the representative id is
// enough — the editor's own platform tabs take it from there.
window._calOpenPost = async function (postId) {
    window._calHidePreview();
    if (typeof window.openPostReview !== 'function') {
        // Only reachable if calendar.js is ever loaded outside the workspace shell.
        window.showToast?.('The post editor is not available on this page.');
        return;
    }
    _openPostId = postId;
    await window.openPostReview(postId);
};

// ── Opening a record / follow-up chip ────────────────────────────────────────
// Both hand off to LeadCalendarModal (src/components/lead-calendar-modal.js), which owns the
// layout and does its own fetching — the calendar knows which thing was clicked and nothing more.
// A missing component degrades to a toast rather than a dead chip: this file is also loaded by the
// global Content Calendar page, where the modal is present, but the guard costs nothing and the
// failure it covers (a script that 404'd) is otherwise silent.
window._calOpenRecord = function (recordId) {
    if (!window.LeadCalendarModal) { window.showToast?.('Details are not available on this page.'); return; }
    window.LeadCalendarModal.open({
        kind: 'record',
        recordId,
        assistantId: Number(_assistantFilter),
        onChanged: () => { void _loadAndRender(); },
    });
};

window._calOpenFollowUp = function (threadId) {
    if (!window.LeadCalendarModal) { window.showToast?.('Details are not available on this page.'); return; }
    const f = _followUps.find(x => x.threadId === threadId) || null;
    window.LeadCalendarModal.open({
        kind: 'followup',
        threadId,
        // The chip's own row, passed through so the modal can name the step and the due date
        // before its fetches land — the calendar already holds both.
        followUp: f,
        recordId: f ? f.assistantRecordId : null,
        assistantId: Number(_assistantFilter),
        onChanged: () => { void _loadAndRender(); },
    });
};

// The editor saves through its own endpoints, so the calendar's copy of a post goes stale the
// moment someone edits, approves, reschedules or rejects one. workspace.html calls this when the
// editor closes; reloading the range also drops anything that is no longer schedule-active (a post
// just rejected in the editor, say) without the user having to refresh.
window._calRefreshAfterEdit = async function () {
    _openPostId = null;
    _previewCache.clear();
    await _loadAndRender();
};

// ── Drag & Drop rescheduling ──────────────────────────────────────
// FOUR kinds of thing are draggable on this grid and they move four different columns:
//   post     → scheduled_posts.publish_date   (confirm modal, then PATCH per cross-post sibling)
//   record   → assistant_records.scheduled_for (a chase reminder / due date — moves immediately)
//   followup → sequence_enrolments.next_send_at (a real send — moves immediately, past refused)
//   blog     → blog_posts.publish_date        (moves immediately, past refused)
//
// `_dragItem` is the general form; `_dragPostId` is kept as-is because the post path already reads
// it in several places and rewriting that flow was not what this change is for.
let _dragItem = null;

// A drag whose source is a post is called with a bare id (the post chips predate this and pass
// `${post.id}`); everything else passes { kind, id }. Normalising here rather than at each call
// site keeps the post chip's signature untouched.
window._calDragStart = function (e, arg) {
    const item = (arg && typeof arg === 'object') ? arg : { kind: 'post', id: arg };
    _dragItem = item;
    _dragPostId = item.kind === 'post' ? item.id : null;
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

// Is this date key strictly before today? Compared at DAY granularity, deliberately: a chip
// dropped on today keeps its own time of day, and that time may already have passed — which is
// fine for a reminder and is caught server-side for a send (lead-threads.ts refuses anything more
// than a minute old). Comparing at minute granularity here would instead reject a legitimate drop
// onto today for reasons the user cannot see on a month grid.
function _isPastDateKey(dateKey) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(y, m - 1, d) < today;
}

// The date a dropped chip lands on, keeping its original time of day.
function _dropTarget(dateKey, originalIso) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const original = new Date(originalIso);
    return new Date(y, m - 1, d, original.getHours(), original.getMinutes());
}

function _dayLabel(date) {
    return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

window._calDrop = function (e, dateKey) {
    e.preventDefault();
    e.currentTarget.classList.remove('ring-2', 'ring-emerald-400', 'ring-inset');

    const item = _dragItem;
    if (item && item.kind === 'followup') { _dragItem = null; void _dropFollowUp(item.id, dateKey); return; }
    if (item && item.kind === 'record')   { _dragItem = null; void _dropRecord(item.id, dateKey); return; }
    if (item && item.kind === 'blog')     { _dragItem = null; void _dropBlog(item.id, dateKey); return; }
    _dragItem = null;

    if (!_dragPostId) return;

    const post = _posts.find(p => p.id === _dragPostId);
    if (!post) { _dragPostId = null; return; }

    const [y, m, d] = dateKey.split('-').map(Number);
    const original = new Date(post.publishDate);
    const newDate = new Date(y, m - 1, d, original.getHours(), original.getMinutes());

    if (_dateKey(original) === dateKey) { _dragPostId = null; return; } // same day

    const oldLabel = original.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const newLabel = newDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

    // The chip is one logical post, so the drag moves every platform it goes to — leaving siblings
    // behind would silently split a cross-post across two dates.
    const siblings = _siblingsOf(post);
    const scope = siblings.length > 1 ? ` on ${_platformNames(siblings.map(s => s.platform))}` : '';

    const msgEl = document.getElementById('reschedule-msg');
    if (msgEl) msgEl.textContent = `Move "${post.caption?.substring(0,40) || 'this post'}"${scope} from ${oldLabel} to ${newLabel}?`;

    _pendingReschedule = { postIds: siblings.map(s => s.id), newDate };
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
    const { postIds, newDate } = _pendingReschedule;
    document.getElementById('modal-reschedule')?.classList.add('hidden');
    _pendingReschedule = null;

    try {
        // Every sibling of the group moves to the same instant — that shared slot is what makes
        // them one post.
        const results = await Promise.all(postIds.map(id =>
            fetch(`/.netlify/functions/scheduled-posts?id=${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ publishDate: newDate.toISOString() }),
            })
        ));
        const failed = results.filter(r => !r.ok).length;
        if (failed) {
            window.showToast?.(failed === results.length
                ? 'Reschedule failed. Please try again.'
                : `Rescheduled, but ${failed} of ${results.length} platforms could not be moved. Please check the calendar.`,
                { icon: '⚠️' });
        }
        // Reload range to include new date if needed
        await _loadAndRender();
    } catch (e) { window.showToast?.('Reschedule failed. Please try again.', { icon: '⚠️' }); }
};

// ── Dropping a pending follow-up ─────────────────────────────────────────────
// The past is refused, and the dialog is the point of the refusal rather than a nicety: dropping
// an email onto last Tuesday would otherwise mean "send it on the next worker tick", i.e. NOW, to
// a stranger, as the silent consequence of a mis-aimed drag. The server enforces the same rule
// (lead-threads.ts `reschedule_follow_up`, code PAST_DATE) — this is the half that explains it.
//
// "Put it back" is a re-render, not an undo: nothing has been written at the point the guard
// fires, so the chip has never actually left the day it is drawn on.
async function _dropFollowUp(threadId, dateKey) {
    const f = _followUps.find(x => x.threadId === threadId);
    if (!f) return;

    if (_isPastDateKey(dateKey)) {
        const [y, m, d] = dateKey.split('-').map(Number);
        await (window.alertModal
            ? window.alertModal(
                `An email can't be sent in the past. <strong>${_escHtml(f.title || 'This follow-up')}</strong> `
                + `stays where it was, on ${_escHtml(_dayLabel(new Date(f.nextSendAt)))}.`,
                { title: `Can't move it to ${_dayLabel(new Date(y, m - 1, d))}` })
            : Promise.resolve(window.showToast?.('An email cannot be sent in the past.', { icon: '⚠️' })));
        _render();   // snap the chip back
        return;
    }

    const newDate = _dropTarget(dateKey, f.nextSendAt);
    if (_dateKey(new Date(f.nextSendAt)) === dateKey) return;   // same day, nothing to do

    try {
        const res = await fetch('/.netlify/functions/lead-threads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                action: 'reschedule_follow_up',
                assistantId: Number(_assistantFilter),
                threadId,
                nextSendAt: newDate.toISOString(),
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not move that follow-up.');
        window.showToast?.(`Follow-up to ${f.title || 'this lead'} moved to ${_dayLabel(newDate)}.`);
    } catch (err) {
        window.showToast?.(err.message || 'Could not move that follow-up.', { icon: '⚠️' });
    }
    await _loadAndRender();
}

// ── Dropping a scheduled record (a chase reminder) ───────────────────────────
// Same past-date rule, different wording. A reminder in the past is not dangerous the way a send
// is — nothing fires — it is simply a prompt you can never act on in time, so it is refused for
// consistency and explained honestly rather than borrowed from the email copy.
async function _dropRecord(recordId, dateKey) {
    const rec = _scheduledRecords.find(r => r.id === recordId);
    if (!rec) return;

    if (_isPastDateKey(dateKey)) {
        const [y, m, d] = dateKey.split('-').map(Number);
        const noun = _leadOutreach ? 'A chase reminder' : 'A reminder';
        await (window.alertModal
            ? window.alertModal(
                `${noun} can't be set in the past. <strong>${_escHtml(rec.title || 'This item')}</strong> `
                + `stays where it was, on ${_escHtml(_dayLabel(new Date(rec.scheduledFor)))}.`,
                { title: `Can't move it to ${_dayLabel(new Date(y, m - 1, d))}` })
            : Promise.resolve(window.showToast?.('That date has already passed.', { icon: '⚠️' })));
        _render();
        return;
    }

    const newDate = _dropTarget(dateKey, rec.scheduledFor);
    if (_dateKey(new Date(rec.scheduledFor)) === dateKey) return;

    try {
        // Date only — no approvalStatus. See the assistant-records PATCH branch for why this is a
        // separate shape from the Review Queue's "Approve & Schedule".
        const res = await fetch('/.netlify/functions/assistant-records', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ id: recordId, scheduledFor: newDate.toISOString() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not move that item.');
        window.showToast?.(`${rec.title || 'Item'} moved to ${_dayLabel(newDate)}.`);
    } catch (err) {
        window.showToast?.(err.message || 'Could not move that item.', { icon: '⚠️' });
    }
    await _loadAndRender();
}

// ── Dropping a scheduled blog post ───────────────────────────────────────────
// Long-form was the one thing on this grid that could be SEEN but not MOVED: blog chips carried no
// draggable attribute at all, so a user who wanted next Tuesday's article on Thursday had to open
// Blog Studio and re-pick the date. It moves like a record — immediately, no confirm modal — rather
// than like a post, because there are no cross-post siblings to warn about: a blog post is one
// artifact on one date.
//
// The past is refused HERE as well as on the server. schedule-blog.ts rejects a non-future
// publishDate with a 400, so without this the only feedback would be a bare "Could not move" toast
// for something the user could have been told plainly. Note the rule is finer-grained than the
// record path's: dropping onto TODAY is legitimate, but only if the post's own time of day has not
// already gone by — the server compares instants, so the client must too or the two disagree about
// the same drop.
async function _dropBlog(blogId, dateKey) {
    const post = _blogPosts.find(p => p.id === blogId);
    if (!post || !post.publishDate) return;

    const original = new Date(post.publishDate);
    if (_dateKey(original) === dateKey) return;   // same day — nothing to do

    const newDate = _dropTarget(dateKey, post.publishDate);
    if (newDate.getTime() <= Date.now()) {
        const title = post.title || 'This post';
        await (window.alertModal
            ? window.alertModal(
                `A blog post can't be scheduled in the past. <strong>${_escHtml(title)}</strong> stays `
                + `where it was, on ${_escHtml(_dayLabel(original))} at `
                + `${_escHtml(original.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}.`
                + `<br><br>To publish it sooner than that, open it in Blog Studio and publish it now.`,
                { title: `Can't move it to ${_dayLabel(newDate)}` })
            : Promise.resolve(window.showToast?.('That time has already passed.', { icon: '⚠️' })));
        _render();
        return;
    }

    try {
        const res = await fetch('/.netlify/functions/schedule-blog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ id: blogId, publishDate: newDate.toISOString() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not move that post.');
        window.showToast?.(`${post.title || 'Post'} moved to ${_dayLabel(newDate)}.`);
    } catch (err) {
        window.showToast?.(err.message || 'Could not move that post.', { icon: '⚠️' });
    }
    await _loadAndRender();
}

function _attachDragDrop() {
    // After DOM render, add dragend listeners to chips to clean up opacity. Covers all four
    // draggable kinds — a record, follow-up or blog chip left at 50% after a cancelled drag looks
    // exactly like one that is mid-save.
    document.querySelectorAll('[data-post-id], [data-cal-record-id], [data-cal-followup-thread], [data-cal-blog-id]').forEach(el => {
        el.addEventListener('dragend', () => {
            el.classList.remove('opacity-50');
        });
    });
}

// ── Helpers ───────────────────────────────────────────────────────
// Returns GROUPS ({ members, rep, platforms }), not posts — a cross-posted post is one entry here
// however many platforms it fans out to. The status guard is the client half of the rule the server
// enforces in scheduled-posts.ts: it keeps a post that was just rejected or cancelled in the panel
// from lingering on the grid until the next reload.
function _postsOnDate(date) {
    const key = _dateKey(date);
    const onDay = _posts.filter(p => {
        if (!p.publishDate) return false;
        if (!_scheduleActive(p.status)) return false;
        if (!_matchesAssistantFilter(p.assistantId)) return false;
        // Filtering by platform narrows a group to its matching sibling, so a cross-post shows as
        // that one platform rather than as "Multiple" the user then has to open to understand.
        if (!_matchesPlatformFilter(p.platform)) return false;
        return _dateKey(new Date(p.publishDate)) === key;
    });
    return _groupPosts(onDay);
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

// Blog posts bucketed to a day: published shows on publishedAt, scheduled on publishDate.
// Respects the assistant filter and the 'blog' platform filter (hidden when a social platform is picked).
function _blogPostsOnDate(date) {
    const key = _dateKey(date);
    if (!_matchesPlatformFilter('blog')) return [];
    return _blogPosts.filter(p => {
        const when = p.status === 'published' ? (p.publishedAt || p.publishDate) : p.publishDate;
        if (!when) return false;
        if (!_matchesAssistantFilter(p.assistantId)) return false;
        return _dateKey(new Date(when)) === key;
    });
}

// Newsletter issues falling on a date. Mirrors _blogPostsOnDate: a SENT issue is plotted on the day
// it actually went out, everything else on the day it is due.
//
// ⚠️ `sending` reads its date from scheduledFor, not sentAt — sentAt is not stamped until the last
// recipient is done, and an issue spreading a local-time send over 24 hours would otherwise vanish
// from the calendar for the whole day it is being sent.
function _newsletterIssuesOnDate(date) {
    const key = _dateKey(date);
    if (!_matchesPlatformFilter('newsletter')) return [];
    return _newsletterIssues.filter(i => {
        const when = i.status === 'sent' ? (i.sentAt || i.scheduledFor) : i.scheduledFor;
        if (!when) return false;
        if (!_matchesAssistantFilter(i.assistantId)) return false;
        return _dateKey(new Date(when)) === key;
    });
}

// Read-only newsletter chip. Same treatment as the blog chip below and for the same reason: issues
// are managed in the Newsletter Studio, so this is not draggable and does not open the social
// governance panel — clicking opens the Studio on that issue.
function _issueChip(issue) {
    const sm = STATUS_META[issue.status] || STATUS_META.draft;
    const sent = issue.status === 'sent';
    const when = sent ? (issue.sentAt || issue.scheduledFor) : issue.scheduledFor;
    const time = new Date(when).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const chipBg = sent ? 'bg-emerald-50 hover:bg-emerald-100' : 'bg-teal-50 hover:bg-teal-100';
    const timeColor = sent ? 'text-emerald-700' : 'text-teal-700';
    // The recipient count is the one fact worth the space on a sent issue — it is the answer to
    // "did that go out, and to how many people".
    const marker = sent
        ? `<span class="text-emerald-600 text-xs font-extrabold shrink-0" title="Sent ${time}${issue.recipientCount ? ` to ${issue.recipientCount}` : ''}">✓</span>`
        : `<span class="w-1.5 h-1.5 rounded-full ${sm.dot} shrink-0" title="${sm.label}"></span>`;
    const subject = issue.subject || 'Untitled issue';
    return `<div
        onclick="window._calOpenIssue(${issue.id})"
        data-issue-id="${issue.id}"
        class="group flex items-center gap-1.5 px-2 py-1 rounded-lg ${chipBg} shadow-sm cursor-pointer transition select-none text-left w-full"
        style="border-left:3px solid #0d9488"
        aria-label="Newsletter · ${_escHtml(subject)}">
        ${_platAvatar('newsletter', 16)}
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold ${timeColor} truncate">${time}</p>
            <p class="text-[11px] text-gray-500 truncate leading-tight">${_escHtml(subject.substring(0, 40))}</p>
        </div>
        ${marker}
    </div>`;
}

// Open the clicked issue in the Newsletter Studio. _newsletterInitialIssueId is the existing
// deep-link hook the Review Queue's "Open in Studio" already uses, and newsletter.js consumes it
// on read so a later visit does not silently reopen an issue the user has moved on from.
window._calOpenIssue = function (id) {
    window._newsletterInitialIssueId = id;
    if (typeof window.loadView === 'function') window.loadView('newsletter');
    else window.open('/newsletter.html', '_blank');
};

// Read-only blog chip (month/week/list). Blog posts are managed in Blog Studio, so — unlike social
// chips — these aren't draggable and don't open the social governance panel; clicking opens the studio.
function _blogChip(post, viewType) {
    const sm = STATUS_META[post.status] || STATUS_META.draft;
    const posted = post.status === 'published';
    const when = posted ? (post.publishedAt || post.publishDate) : post.publishDate;
    const time = new Date(when).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const chipBg = posted ? 'bg-emerald-50 hover:bg-emerald-100' : 'bg-violet-50 hover:bg-violet-100';
    const timeColor = posted ? 'text-emerald-700' : 'text-violet-700';
    const marker = posted
        ? `<span class="text-emerald-600 text-xs font-extrabold shrink-0" title="Published ${time}">✓</span>`
        : `<span class="w-1.5 h-1.5 rounded-full ${sm.dot} shrink-0" title="${sm.label}"></span>`;
    const title = post.title || 'Untitled';
    // A SCHEDULED blog is the only one that moves, and only on the grids. The calendar feed
    // (blog-posts.ts) returns 'scheduled' and 'published' only, so the status test is really
    // "everything but published" — written as the positive test so that widening the feed later
    // cannot silently make a LIVE article draggable. The list view is excluded because only the
    // month and week grids carry drop targets; a draggable chip there could be picked up and never
    // put down. Dragging moves the DATE and keeps the time of day, exactly as a post chip does —
    // the time of day itself is changed in Blog Studio.
    const isDraggable = post.status === 'scheduled' && viewType !== 'list';
    return `<div
        onclick="window._calOpenBlog(${post.id})"
        ${isDraggable ? `draggable="true" ondragstart="window._calDragStart(event, { kind: 'blog', id: ${post.id} })"` : ''}
        data-blog-id="${post.id}"
        ${isDraggable ? `data-cal-blog-id="${post.id}"` : ''}
        class="group flex items-center gap-1.5 px-2 py-1 rounded-lg ${chipBg} shadow-sm cursor-pointer transition select-none text-left w-full"
        style="border-left:3px solid #7c3aed"
        aria-label="Blog · ${_escHtml(title)}">
        ${_platAvatar('blog', 16)}
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold ${timeColor} truncate">${time}</p>
            <p class="text-[11px] text-gray-500 truncate leading-tight">${_escHtml(title.substring(0, 40))}</p>
        </div>
        ${marker}
    </div>`;
}

// Open the clicked blog post in the native Blog Studio modal (falls back to the standalone page
// only if the modal module didn't load).
window._calOpenBlog = function (id) {
    if (typeof window.openBlogStudio === 'function') window.openBlogStudio({ postId: id });
    else window.open('/blog-studio.html?postId=' + encodeURIComponent(id), '_blank');
};

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

})(); // end IIFE
