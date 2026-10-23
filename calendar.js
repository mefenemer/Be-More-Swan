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
    newsletter:{ label: 'Email',       bg: '#0d9488', text: 'text-white' },
};

// Returns a circular platform avatar (logo on brand bg) for list/panel use.
// Each logo once, as a <symbol>, referenced by <use>. A month grid inlined the full path data in
// every chip (the Instagram mark alone is ~1.4KB) and rebuilt all of it on every repaint.
function _ensureLogoSprite() {
    if (document.getElementById('cal-logo-sprite')) return;
    const symbols = Object.entries(PLATFORM_LOGOS).map(([key, svg]) => {
        const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
        const viewBox = (svg.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 24 24';
        return `<symbol id="cal-logo-${key}" viewBox="${viewBox}">${inner}</symbol>`;
    }).join('');
    const holder = document.createElement('div');
    holder.innerHTML = `<svg id="cal-logo-sprite" xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">${symbols}</svg>`;
    document.body.appendChild(holder.firstChild);
}

function _platAvatar(platform, sizePx = 36) {
    const meta = PLATFORM_META[platform];
    if (PLATFORM_LOGOS[platform]) _ensureLogoSprite();
    const logo = PLATFORM_LOGOS[platform]
        ? `<svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full" aria-hidden="true"><use href="#cal-logo-${platform}"/></svg>`
        : null;
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
    // Blue, as on the Review page: booked and on its way. It was yellow here, so the same post was a
    // different colour on each page, and yellow sat among the ambers that mean "needs you".
    scheduled:       { label: 'Scheduled',   badge: 'bg-blue-100 text-blue-700 border-blue-300',   chipBorder: 'border-blue-500',    dot: 'bg-blue-500' },
    publishing:      { label: 'Publishing',  badge: 'bg-blue-100 text-blue-700 border-blue-300',   chipBorder: 'border-blue-500',    dot: 'bg-blue-500' },
    // Posted = GREEN, never emerald: emerald-* is the brand pink here (input.css), so "posted" used to
    // render pink beside a green tick on the same chip.
    published:       { label: 'Posted',      badge: 'bg-green-100 status-posted border-green-300', chipBorder: 'border-green-500', dot: 'bg-green-500' },
    // Amber with the reason, like the Review card: grey "Paused" read as "I paused it", when it means
    // a connection died and nothing will go out until it is reconnected.
    paused:          { label: 'Paused · reconnect', badge: 'bg-amber-100 text-amber-800 border-amber-300', chipBorder: 'border-amber-400', dot: 'bg-amber-500' },
    // The X quota park. Amber, not grey: unlike 'paused' this one is waiting on something the user
    // may need to act on, and it resumes by itself only when the quota resets. Without an entry
    // here every lookup falls back to STATUS_META.draft, so a committed post parked on quota would
    // render on the calendar labelled "Draft" — the one word that is certainly wrong.
    paused_credits:  { label: 'Paused · X limit', badge: 'bg-amber-100 text-amber-700 border-amber-300', chipBorder: 'border-amber-400', dot: 'bg-amber-500' },
    // Newsletter issue states. ⚠️ Without an entry here each falls back to STATUS_META.draft, so a
    // SENT issue would render on the calendar labelled "Draft" — exactly the failure recorded for
    // paused_credits above. 'sending' is blue like 'publishing', its social twin: in flight, no
    // action needed. 'sent' is emerald like 'published': done and correct.
    sending:         { label: 'Sending',     badge: 'bg-blue-100 text-blue-700 border-blue-300',   chipBorder: 'border-blue-500',    dot: 'bg-blue-500' },
    sent:            { label: 'Sent',        badge: 'bg-green-100 status-posted border-green-300', chipBorder: 'border-green-500', dot: 'bg-green-500' },
    failed:          { label: 'Failed to post', badge: 'bg-red-100 text-red-700 border-red-300',      chipBorder: 'border-red-500',     dot: 'bg-red-500' },
    missed:          { label: 'Missed',      badge: 'bg-orange-100 text-orange-700 border-orange-300', chipBorder: 'border-orange-300', dot: 'bg-amber-500' },
    rejected:        { label: 'Rejected',    badge: 'bg-red-100 text-red-700 border-red-300',      chipBorder: 'border-red-500',     dot: 'bg-red-500' },
    cancelled:       { label: 'Cancelled',   badge: 'bg-gray-100 text-gray-500 border-gray-200',   chipBorder: 'border-gray-300',    dot: 'bg-gray-300' },
};

// The word for a state. Read from the generated constants (src/config/post-status.ts
// POST_STATUS_LABELS) so this page and Review say the same thing; STATUS_META's label is only the
// fallback for a page loaded without them.
function _statusLabel(status) {
    const pc = window.PlatformConstants;
    if (pc && typeof pc.postStatusLabel === 'function') return pc.postStatusLabel(status);
    return (STATUS_META[status] || STATUS_META.draft).label;
}

// Narrow screens get the List view, and never the seven-column Week (~48px a day).
function _isPhone() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 639px)').matches);
}

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

// Weeks start on MONDAY — the audience is UK businesses (every date here is en-GB). Column order is
// DAY_NAMES_SHORT; _dayShort names a real Date whatever column it sits in.
const DAY_NAMES_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function _dayShort(d) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]; }
// Monday = 0 … Sunday = 6.
function _mondayIndex(d) { return (d.getDay() + 6) % 7; }
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
// 'upcoming' = today + the next 13 days, across a month boundary — what a phone opens on, because
// "what's going out tomorrow?" should not take a scroll past the 1st or a tap on Next.
let _listFilter = 'all';         // 'upcoming' | 'all' | 'scheduled' | 'published' | 'attention'
let _listFilterChosen = false;   // the user picked a list tab — stop choosing one for them
// Drafts waiting for review, on their PROPOSED slot (scheduled-posts.ts `awaiting=1`). Drawn outlined
// and never draggable: nothing is committed until the draft is approved in Review.
let _awaiting = [];
// Loading / failure state for the range on screen. A failed load used to leave an empty grid that
// read "Nothing scheduled this month" — an all-clear from a server that simply didn't answer.
let _loading = false;
let _loadError = false;
let _scrolledToTodayFor = null;  // list view jumps to today once per month shown, not on every repaint
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
// Whether the platform filter means anything. False for a role that publishes to ONE channel (the
// Email Marketing Assistant: its emails still load, but an Instagram/YouTube/Blog dropdown over them
// filtered nothing). Defaults to _publishesContent, so every other caller is unchanged.
let _platformFilterOn = true;
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

// Dated items for a records/briefs assistant (opts.datedItems): an AR Clerk's invoices on their due
// date, a Minute Taker's meetings on their own date, a Brand Designer's briefs on their deadline.
// Before this those calendars showed only completed runs — never one invoice, meeting or brief.
// Read-only chips: the date belongs to the record, so moving it here would be editing a fact.
// Shape: { key, kind, title, at: Date, derived, tab }.
let _datedItems = [];
let _datedSource = null;   // 'records' | 'briefs' | 'checks' | 'campaigns' | null
// The locked assistant's roleKey (opts.roleKey) — only for wording the legend and the empty month.
let _roleKey = null;
const DATED_KIND_META = {
    invoice_due: { icon: '💷', label: 'Invoice due' },
    meeting:     { icon: '🗓', label: 'Meeting' },
    notes_taken: { icon: '📝', label: 'Notes taken' },
    brief_due:   { icon: '🎨', label: 'Brief due' },
    site_check:  { icon: '🔍', label: 'Website check' },
    campaign_start: { icon: '🚀', label: 'Campaign starts' },
    campaign_end:   { icon: '🏁', label: 'Campaign ends' },
};

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
// opts.platformFilter (optional, default = publishesContent) — false hides the platform dropdown
// and says "Sent" for a single-channel publisher; see _platformFilterOn.
// opts.datedItems (optional) — 'records' (invoices, meetings) or 'briefs' (Brand Designer); see
// _datedItems. From the dashboard registry's calendarItems.
window.initCalendar = async function (opts = {}) {
    if (opts.assistantId != null) {
        _assistantFilter = String(opts.assistantId);
        _lockedAssistant = true;
        _publishesContent = opts.publishesContent !== false;
        _platformFilterOn = _publishesContent && opts.platformFilter !== false;
        _leadOutreach = opts.leadOutreach === true;
        _datedSource = ['records', 'briefs', 'checks', 'campaigns'].includes(opts.datedItems) ? opts.datedItems : null;
        _roleKey = typeof opts.roleKey === 'string' ? opts.roleKey : null;
    } else {
        _datedSource = null;
        _roleKey = null;
        _assistantFilter = 'all';
        _lockedAssistant = false;
        _publishesContent = true;
        _platformFilterOn = true;
        // The global Content Calendar spans every assistant and has no single lead context to
        // reschedule against, so pending outreach stays off there.
        _leadOutreach = false;
    }
    _renderStatusLegend();
    _calResolveCreate();
    document.getElementById('cal-btn-prev')?.addEventListener('click', _navPrev);
    document.getElementById('cal-btn-next')?.addEventListener('click', _navNext);
    document.getElementById('cal-btn-today')?.addEventListener('click', _navToday);
    document.querySelectorAll('.cal-view-btn').forEach(btn => {
        btn.addEventListener('click', () => _setView(btn.dataset.view));
    });
    // On a phone a seven-column month or week is ~50px a day — every chip truncates to nothing. Open
    // on the List view there instead, on "Coming up" (today onwards) unless the user has picked a
    // tab. Set before the first load so it is one load, not a month load followed by a list load.
    if (_isPhone()) {
        if (_view === 'month' || _view === 'week') _view = 'list';
        if (!_listFilterChosen) _listFilter = 'upcoming';
    }
    // Review's "See it on the calendar" asks for the month a post was just booked into. A whole-month
    // view is what shows it in context, so "Coming up" steps aside for this one visit.
    if (window._calInitialAnchor instanceof Date && !Number.isNaN(window._calInitialAnchor.getTime())) {
        _anchor = new Date(window._calInitialAnchor); _anchor.setHours(0, 0, 0, 0);
        if (_listFilter === 'upcoming') _listFilter = 'all';
        _scrolledToTodayFor = null;
    }
    window._calInitialAnchor = null;
    document.getElementById('cal-key-toggle')?.addEventListener('click', _toggleKey);
    // The toolbar markup is re-injected on every visit with Month highlighted, while _view survives
    // from the last visit — so a return visit showed the Week or List grid under a Month button.
    // Always paint the buttons from the view actually being rendered.
    _paintViewButtons();
    // Coming back to the Calendar (from Review, say) reuses the month already fetched, then re-checks.
    _loading = !_rangeCached();
    await _loadAndRender({ fromCache: true });
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
    // Marked loading BEFORE the interim paint, so the empty new range reads "Loading…" and never
    // "Nothing scheduled" for the second or so it takes to arrive. A range already in the cache
    // skips the interim paint: _loadAndRender paints it synchronously, before its first await.
    if (!_rangeCached()) {
        _loading = true;
        _render();
    }
    void _loadAndRender({ fromCache: true });
}
window._calRetry = function () { _navRefresh(); };

// The view toggle's look AND its state for assistive tech — the active view was colour-only.
function _paintViewButtons() {
    document.querySelectorAll('.cal-view-btn').forEach(btn => {
        const active = btn.dataset.view === _view;
        btn.className = `cal-view-btn focus-ring tap-target px-3 py-1.5 text-sm font-bold rounded-lg transition cursor-pointer ${active ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}${btn.dataset.view === 'week' || btn.dataset.view === 'month' ? ' phone-hidden' : ''}`;
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

// Phone only: the two legend strips fold behind a "Key" button so the posts start higher up.
// The phone's "Filter" button: shown on a phone when there is a filter to show, with how many are on.
function _syncFilterToggle() {
    const btn = document.getElementById('cal-filter-toggle');
    if (!btn) return;
    const shown = ['cal-platform-filter', 'cal-assistant-filter']
        .filter(id => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); });
    btn.classList.toggle('hidden', !shown.length || !_isPhone());
    const on = (_platformFilterOn && _platformFilter !== 'all' ? 1 : 0) + (!_lockedAssistant && _assistantFilter !== 'all' ? 1 : 0);
    const count = document.getElementById('cal-filter-count');
    if (count) count.textContent = on ? ` (${on} on)` : '';
    if (!btn.dataset.bound) {
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
            const open = btn.getAttribute('aria-expanded') !== 'true';
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            document.getElementById('cal-filters')?.classList.toggle('phone-hidden', !open);
        });
    }
}

function _toggleKey() {
    const btn = document.getElementById('cal-key-toggle');
    const open = btn?.getAttribute('aria-expanded') !== 'true';
    btn?.setAttribute('aria-expanded', open ? 'true' : 'false');
    ['cal-legend', 'cal-status-legend'].forEach(id => document.getElementById(id)?.classList.toggle('phone-hidden', !open));
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
// "Coming up" is a rolling window from today, not a month — stepping from it lands on the month
// before or after the current one, as a whole-month list.
function _leaveUpcoming() {
    if (_view === 'list' && _listFilter === 'upcoming') {
        _listFilter = 'all';
        _anchor = new Date(); _anchor.setHours(0, 0, 0, 0);
        return true;
    }
    return false;
}
function _navPrev() {
    _leaveUpcoming();
    if (_view === 'week') _anchor.setDate(_anchor.getDate() - 7);
    else _stepMonth(-1);
    _navRefresh();
}
function _navNext() {
    _leaveUpcoming();
    if (_view === 'week') _anchor.setDate(_anchor.getDate() + 7);
    else _stepMonth(1);
    _navRefresh();
}
function _navToday() {
    _anchor = new Date(); _anchor.setHours(0,0,0,0);
    _scrolledToTodayFor = null;
    _navRefresh();
}
function _setView(v) {
    // Month and Week are seven ~48px columns on a phone, where chips spill into the next day and
    // can't be dragged anyway; the toggle hides both there, and this catches a stale choice carried
    // over from a wider window.
    _view = ((v === 'week' || v === 'month') && _isPhone()) ? 'list' : v;
    _paintViewButtons();
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

// Which assistants have dated work of their own for the sidebar Calendar, and what kind — from the
// same dashboard registry the assistant Calendar tab reads (assistant-calendar.js), so the two
// calendars can never disagree about what a role puts on a date.
function _globalExtraTargets(list) {
    const reg = window.AssistantDashboardRegistry;
    if (!reg || !Array.isArray(list)) return [];
    const out = [];
    for (const a of list) {
        if (a.lifecycleStatus === 'archived' || a.status === 'cancelled') continue;
        const cfg = reg.get(a.roleKey) || {};
        const mods = cfg.modules || {};
        const datedSource = ['records', 'briefs', 'checks', 'campaigns'].includes(cfg.calendarItems) ? cfg.calendarItems : null;
        const leadOutreach = mods.hasLeadOutreach === true;
        const records = mods.hasPostingSchedule === false;   // the records roles, as on their own tab
        if (records || leadOutreach || datedSource) out.push({ id: a.id, records, leadOutreach, datedSource });
    }
    return out;
}

// One assistant's scheduled records, pending follow-ups and dated items, each tagged _assistantId.
// Every feed is swallowed on failure: a calendar that shows everything else beats one that shows
// nothing (an un-migrated environment answers 503 for sequence_enrolments, for one).
function _calPost(fn, body) {
    return fetch(`/.netlify/functions/${fn}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body),
    });
}
async function _loadRoleExtras(t, from, to) {
    const tag = (x) => ({ ...x, _assistantId: t.id });
    const [records, followUps, dated] = await Promise.all([
        // Scheduled Data Hub records, so "Approve & Schedule" in the Review Queue shows up here.
        !t.records ? [] : fetch(`/.netlify/functions/assistant-records?scheduled=1&assistantId=${t.id}&from=${from.toISOString()}&to=${to.toISOString()}`)
            .then(async (r) => (r.ok ? ((await r.json()).records || []) : [])).catch(() => []),
        // Lead roles: the follow-up emails due in this range.
        !t.leadOutreach ? [] : _calPost('lead-threads', { action: 'calendar', assistantId: t.id, from: from.toISOString(), to: to.toISOString() })
            .then(async (r) => (r.ok ? ((await r.json()).followUps || []) : [])).catch(() => []),
        _loadDatedItems(t, from, to).catch(() => []),
    ]);
    return { records: records.map(tag), followUps: followUps.map(tag), dated: dated.map(tag) };
}

// Dated items (records or briefs): an AR Clerk's invoices, a Minute Taker's meetings, campaign
// dates, website checks, brief deadlines.
async function _loadDatedItems(t, from, to) {
    if (t.datedSource === 'records') {
        const dr = await fetch(`/.netlify/functions/assistant-records?dated=1&assistantId=${t.id}&from=${from.toISOString()}&to=${to.toISOString()}`);
        const items = dr.ok ? ((await dr.json()).items || []) : [];
        return items.map((i) => ({ key: `r${i.id}`, kind: i.kind, title: i.title, at: new Date(i.at), derived: !!i.derived, tab: 'datahub' }));
    }
    if (t.datedSource === 'campaigns') {
        // Campaign Orchestrator: each campaign's start and end, from the same list the Campaigns tab
        // reads. Its calendar held nothing else of its own (review, 2026-10-22).
        const cr = await _calPost('campaigns', { action: 'list', assistantId: t.id });
        const list = cr.ok ? ((await cr.json()).campaigns || []) : [];
        const out = [];
        for (const c of list) {
            const title = c.objective || c.name || 'Campaign';
            const done = c.status === 'finished';
            for (const [kind, iso] of [['campaign_start', c.startsAt], ['campaign_end', c.endsAt]]) {
                const at = iso ? new Date(iso) : null;
                if (at && !Number.isNaN(at.getTime()) && at >= from && at < to) {
                    out.push({ key: `${kind}-${c.id}`, kind, title, at, derived: false, tab: 'campaigns', done: kind === 'campaign_end' && done });
                }
            }
        }
        return out;
    }
    if (t.datedSource === 'checks') {
        // Mystery Shopper: the checks it ran, on the day they ran (site-audits.ts `calendar`).
        const cr = await _calPost('site-audits', { action: 'calendar', assistantId: t.id, from: from.toISOString(), to: to.toISOString() });
        const items = cr.ok ? ((await cr.json()).items || []) : [];
        return items.map((i) => ({ key: `c${i.id}`, kind: 'site_check', title: i.title, at: new Date(i.at), derived: false, tab: 'website', done: i.done }));
    }
    if (t.datedSource === 'briefs') {
        const br = await _calPost('brand-briefs', { action: 'calendar', assistantId: t.id, from: _dateKey(from), to: _dateKey(to) });
        const items = br.ok ? ((await br.json()).items || []) : [];
        // A DATE column: noon local, so it can never slip a day across a timezone.
        return items.map((i) => ({ key: `b${i.id}`, kind: 'brief_due', title: i.title, at: new Date(`${i.dueDate}T12:00:00`), derived: false, tab: 'briefs', done: i.status === 'approved' }));
    }
    return [];
}

// Everything the grid shows for one date range, as data. Changes nothing on the page, so it can run
// ahead of time (the next month) or for a range that is no longer on screen. Throws on a network
// failure; a non-OK feed comes back as `failed: true` with that feed left null.
async function _fetchRange(from, to) {
    // Posts, completed assistant activity, and the assistant list (for colours/filter) in parallel.
    // An assistant that publishes nothing owns no posts, blog posts or emails — fetching all three
    // on every month change was three round trips to a database across the Atlantic for rows the
    // filter then threw away. `[]`-shaped empty answers keep the rest of the code unchanged.
    const skipPublishing = _lockedAssistant && !_publishesContent;
    const none = (key) => Promise.resolve({ ok: true, json: async () => ({ [key]: [] }) });
    // Each assistant's own dated work waited for the batch below to finish before it was even
    // asked for. Once the assistant list is known (every visit after the first), start it now.
    const earlyExtras = !_lockedAssistant && _assistants.length
        ? Promise.all(_globalExtraTargets(_assistants).map((t) => _loadRoleExtras(t, from, to)))
        : null;
    const [postsRes, actRes, asstRes, blogRes, nlRes] = await Promise.all([
        skipPublishing ? none('posts') : fetch(`/.netlify/functions/scheduled-posts?awaiting=1&from=${from.toISOString()}&to=${to.toISOString()}`),
        fetch(`/.netlify/functions/get-calendar-activity?from=${from.toISOString()}&to=${to.toISOString()}`),
        _assistants.length ? Promise.resolve(null) : (window.bmsCachedFetch ? window.bmsCachedFetch.assistants() : fetch('/.netlify/functions/get-assistants')),
        skipPublishing ? none('posts') : fetch(`/.netlify/functions/blog-posts?from=${from.toISOString()}&to=${to.toISOString()}`),
        // The from/to branch of newsletter-issues.ts, NOT its list response — that one carries
        // segments, custom fields, templates and the brand theme, and this refetches on every
        // month change.
        skipPublishing ? none('issues') : fetch(`/.netlify/functions/newsletter-issues?from=${from.toISOString()}&to=${to.toISOString()}`),
    ]);

    // null = "no definitive answer" (a 500, say) — leave the previous value alone rather than
    // blanking the grid on a transient failure. [] is a real, empty answer.
    let posts = null, activities = null, assistants = null, blogPosts = null, newsletterIssues = null, awaiting = null;
    // Did a feed the grid depends on fail? Kept apart from "empty": an empty month is an answer,
    // a 500 is not, and the two used to render identically. The newsletter feed is excluded on
    // purpose — an environment without its schema answers with an error by design (see below).
    let failed = false;

    if (postsRes.ok) {
        const pj = await postsRes.json();
        posts = pj.posts || [];
        awaiting = pj.awaiting || [];
    } else if (postsRes.status === 403) {
        // US3 AC3.3: onboarding guard rejected this — surface it gracefully, don't crash.
        const body = await postsRes.json().catch(() => ({}));
        if (body.error === 'onboarding_incomplete') {
            window.showToast?.(body.message || 'Please complete your onboarding checklist to unlock this feature.');
        }
        posts = [];
    } else {
        failed = true;
    }

    if (actRes && actRes.ok) activities = (await actRes.json()).activities || [];
    else if (actRes) failed = true;
    if (asstRes && asstRes.ok) assistants = (await asstRes.json()).assistants || [];
    if (blogRes && blogRes.ok) blogPosts = (await blogRes.json()).posts || [];
    else if (blogRes) failed = true;
    // Left null on any non-OK answer, per the rule above: an environment without the newsletter
    // schema applied answers with an error, and blanking every OTHER kind of entry on the grid
    // because of it would be a worse calendar than one issue short.
    if (nlRes && nlRes.ok) newsletterIssues = (await nlRes.json()).issues || [];

    // Each assistant's own kind of dated work: scheduled records, a Lead Generator's follow-up
    // emails, a Campaign Assistant's start and end dates, a Mystery Shopper's checks, a Brand
    // Designer's brief deadlines. The assistant Calendar tab loads its one assistant's; the
    // sidebar Calendar loads every assistant's (review, 2026-10-22 — it used to show none of
    // them, so those assistants looked idle there). Every item carries _assistantId, so the
    // assistant filter and colours apply to it like to a post.
    const extraTargets = _lockedAssistant
        ? (_assistantFilter !== 'all'
            ? [{ id: Number(_assistantFilter), records: true, leadOutreach: _leadOutreach, datedSource: _datedSource }]
            : [])
        : _globalExtraTargets(assistants || _assistants);
    const extras = earlyExtras && !assistants ? await earlyExtras : await Promise.all(extraTargets.map((t) => _loadRoleExtras(t, from, to)));
    const records = extras.flatMap((e) => e.records);
    const followUps = extras.flatMap((e) => e.followUps);
    const dated = extras.flatMap((e) => e.dated);

    return { posts, awaiting, activities, assistants, blogPosts, newsletterIssues, records, followUps, dated, failed };
}

// Put one range's data on the page.
function _applyRange(d) {
    _datedItems = d.dated;
    _loadError = d.failed;
    // A failed answer leaves the PREVIOUS range's data, which can't land on this range's dates —
    // so clear it rather than let a stale month's chips pass for this one's.
    _posts = d.posts || [];
    _awaiting = d.awaiting || [];
    if (d.activities) _activities = d.activities;
    if (d.assistants) {
        _assistants = d.assistants;
        // Seed the shared colour cache so chips/dots that only carry an assistantId resolve to
        // the user's chosen colour rather than the id-derived fallback.
        window.AssistantColors?.rememberAll(d.assistants);
    }
    if (d.blogPosts) _blogPosts = d.blogPosts;
    if (d.newsletterIssues) _newsletterIssues = d.newsletterIssues;
    _scheduledRecords = d.records;
    _followUps = d.followUps;
}

// ── Range cache ──────────────────────────────────────────────────
// Every month change and every visit fetched the whole range again — four to a dozen requests —
// so stepping back to last month, or returning to the Calendar from Review, showed "Loading…" for
// data already seen seconds before. Each range's answer (or its in-flight request) is kept for a
// few minutes: a cached month paints at once and is re-checked quietly if it is more than a few
// seconds old, and the next month is fetched ahead while the user reads this one.
// Any change made here (a move, an edit, a record changed) clears the lot: _loadAndRender() with
// no options is the "something changed" path, and a moved post can land in any cached month.
const _RANGE_CACHE_MS = 5 * 60 * 1000;
const _RANGE_RECHECK_MS = 15 * 1000;
const _rangeCache = new Map();   // key → { at, promise, data }

function _rangeKey(from, to) {
    // The same dates fetch different things on an assistant's own tab, so its scope is in the key.
    return [from.toISOString(), to.toISOString(), _lockedAssistant ? _assistantFilter : 'all',
        _publishesContent ? 1 : 0, _leadOutreach ? 1 : 0, _datedSource || ''].join('|');
}

function _rangeEntry(from, to, { fresh = false } = {}) {
    const key = _rangeKey(from, to);
    const hit = _rangeCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < _RANGE_CACHE_MS) return hit;
    const entry = { at: Date.now(), promise: null, data: null };
    entry.promise = _fetchRange(from, to).then((d) => {
        entry.data = d;
        // Never keep a failed answer: the next visit should ask again, not replay the error.
        if (d.failed && _rangeCache.get(key) === entry) _rangeCache.delete(key);
        return d;
    }, (err) => {
        if (_rangeCache.get(key) === entry) _rangeCache.delete(key);
        throw err;
    });
    _rangeCache.set(key, entry);
    return entry;
}

/** Is the range on screen already in hand (so navigating needs no "Loading…")? */
function _rangeCached() {
    const { from, to } = _getDateRange();
    const hit = _rangeCache.get(_rangeKey(from, to));
    return !!(hit && hit.data && Date.now() - hit.at < _RANGE_CACHE_MS);
}

// The next range along, fetched while the user reads this one (most navigation is "next").
function _prefetchNext() {
    const saved = _anchor;
    try {
        const next = new Date(_anchor);
        if (_view === 'week') next.setDate(next.getDate() + 7);
        else if (!(_view === 'list' && _listFilter === 'upcoming')) next.setMonth(next.getMonth() + 1, 1);
        else return;
        _anchor = next;
        const { from, to } = _getDateRange();
        _rangeEntry(from, to).promise.catch(() => {});
    } finally {
        _anchor = saved;
    }
}

async function _loadAndRender({ fromCache = false } = {}) {
    const token = ++_loadToken;
    if (!fromCache) _rangeCache.clear();
    const { from, to } = _getDateRange();
    const paint = () => {
        _loading = false;
        // Always (re)populate the toolbar controls — the calendar.html fragment (and its fresh
        // <select>) is re-injected on every view entry, even though _assistants is cached here.
        _renderAssistantControls();
        _render();
    };
    let entry = _rangeEntry(from, to);
    // In hand already: paint it now, then re-check it quietly if it has been sitting a while.
    if (entry.data) {
        _applyRange(entry.data);
        paint();
        if (Date.now() - entry.at < _RANGE_RECHECK_MS) { _prefetchNext(); return; }
        entry = _rangeEntry(from, to, { fresh: true });
    }
    try {
        const d = await entry.promise;
        if (token !== _loadToken) return;   // superseded by a newer navigation
        _applyRange(d);
    } catch (e) {
        console.warn('Calendar load error:', e);
        if (token !== _loadToken) return;
        _loadError = true;
    }
    paint();
    if (!_loadError) _prefetchNext();
}

// ── The assistant picker ─────────────────────────────────────────────────────────────────────────
// Looks like the header's assistant quick switcher (workspace.html): a colour tile with the
// assistant's letter, its name, and its role underneath — the tile is the colour its chips wear on
// the grid, so the picker doubles as the key. The fragment is re-injected on every view entry, so
// the button/panel handlers bind per element (dataset.bound); the close-on-outside-click and Escape
// listeners bind ONCE, on document.
function _assistantPickerOpen(open) {
    const panel = document.getElementById('cal-assistant-filter-panel');
    const btn = document.getElementById('cal-assistant-filter-btn');
    if (!panel || !btn) return;
    panel.classList.toggle('hidden', !open);
    panel.style.display = open ? '' : 'none';
    btn.setAttribute('aria-expanded', String(open));
}

function _paintAssistantPicker() {
    const btn = document.getElementById('cal-assistant-filter-btn');
    const list = document.getElementById('cal-assistant-filter-list');
    if (!btn || !list) return;
    const C = window.AssistantColors;
    const tile = (a) => {
        const color = a ? (C ? C.colorFor(a.id, a.avatarColor) : _assistantColor(a.id)) : null;
        const letter = a ? (C ? C.letterFor(a.id, a.name, a.avatarLetter) : String(a.name || 'A')[0]) : '';
        return a
            ? { style: `background:${color}`, html: _escHtml(letter) }
            // "All": a neutral tile with the team icon, so the row lines up with the others.
            : { style: 'background:#e5e7eb;color:#4b5563', html: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>' };
    };
    const current = _assistants.find(a => String(a.id) === String(_assistantFilter)) || null;
    const t = tile(current);
    const sw = document.getElementById('cal-assistant-filter-swatch');
    if (sw) { sw.setAttribute('style', t.style); sw.innerHTML = t.html; }
    const label = document.getElementById('cal-assistant-filter-label');
    if (label) label.textContent = current ? (current.name || ('Assistant #' + current.id)) : 'All assistants';

    const row = (a) => {
        const value = a ? String(a.id) : 'all';
        const on = String(_assistantFilter) === value;
        const tt = tile(a);
        return `<button type="button" role="option" aria-selected="${on}" data-cal-assistant="${_escHtml(value)}"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 cursor-pointer ${on ? 'bg-gray-50' : ''}">
            <span class="w-8 h-8 rounded-lg text-white flex items-center justify-center text-sm font-bold shrink-0" style="${tt.style}">${tt.html}</span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-bold text-gray-900 truncate">${a ? _escHtml(a.name || ('Assistant #' + a.id)) : 'All assistants'}</span>
              <span class="block text-xs text-gray-500 truncate">${a ? _escHtml(a.role || '') : 'Everything on your calendar'}</span>
            </span>
            ${on ? '<svg class="w-4 h-4 text-gray-700 shrink-0" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>' : ''}
          </button>`;
    };
    const sorted = [..._assistants].sort((x, y) => String(x.name || '').localeCompare(String(y.name || '')));
    list.innerHTML = row(null) + sorted.map(row).join('');

    if (!btn.dataset.bound) {
        btn.dataset.bound = '1';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const panel = document.getElementById('cal-assistant-filter-panel');
            _assistantPickerOpen(!!panel && panel.classList.contains('hidden'));
        });
        list.addEventListener('click', (e) => {
            const pick = e.target.closest('[data-cal-assistant]');
            if (!pick) return;
            _assistantFilter = pick.getAttribute('data-cal-assistant');
            _assistantPickerOpen(false);
            _paintAssistantPicker();
            _syncFilterToggle();
            _render();
        });
    }
}

if (!window._calAssistantPickerDocBound) {
    window._calAssistantPickerDocBound = true;
    document.addEventListener('click', (e) => { if (!e.target.closest?.('#cal-assistant-filter')) _assistantPickerOpen(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _assistantPickerOpen(false); });
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
            _paintAssistantPicker();
        }
    }

    // Platform filter — publishing roles only. A non-publishing assistant has no posts to filter,
    // so the dropdown offered Instagram/YouTube/Blog over a grid that can only hold scheduled
    // records and completed task runs. Hidden the same way as the locked assistant picker above;
    // the filter is also reset to 'all' so a stale selection made on the global page can't travel
    // in and silently filter this grid down to nothing with no visible control to undo it.
    const psel = document.getElementById('cal-platform-filter');
    if (!_platformFilterOn) _platformFilter = 'all';
    if (psel) {
        psel.classList.toggle('hidden', !_platformFilterOn);
        if (!psel.dataset.bound) {
            psel.dataset.bound = '1';
            psel.addEventListener('change', () => { _platformFilter = psel.value; _syncFilterToggle(); _render(); });
        }
        psel.value = _platformFilter;
    }
    _syncFilterToggle();

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
        `<span class="inline-flex items-center gap-1.5 text-xs text-gray-600"><span aria-hidden="true" class="inline-flex">${marker}</span> ${label}</span>`;
    // The dated kinds this assistant's grid can actually contain — listed only when it has them.
    const datedLegend = () => {
        const kinds = _datedSource === 'briefs' ? ['brief_due'] : _datedSource === 'campaigns' ? ['campaign_start', 'campaign_end']
            : _datedSource === 'records' ? ['invoice_due', 'meeting', 'notes_taken'] : [];
        const role = _roleKey || '';
        const relevant = kinds.filter((k) => _datedSource === 'briefs' || _datedSource === 'campaigns'
            || (role === 'accounts_receivable_clerk' ? k === 'invoice_due' : role === 'meeting_note_taker' ? k !== 'invoice_due' : true));
        return relevant.map((k) => item(`<span>${DATED_KIND_META[k].icon}</span>`, DATED_KIND_META[k].label)).join('');
    };
    // The pending-outreach marker, lead roles only. It is listed FIRST because it is the only
    // thing on this grid that will act on a third party by itself — the reminder and the completed
    // run are both records of what a person did or has to do.
    const outreachItem = _leadOutreach
        ? item('<span class="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>', 'Email to be sent')
        : '';
    strip.innerHTML = _publishesContent
        // Same words as the chips and as Review. "Failed" has its own marker now — it used to be a red
        // dot, which is what this strip said "Overdue" looks like.
        ? item('<span class="status-posted-tick font-extrabold">✓</span>', _platformFilterOn ? _statusLabel('published') : 'Sent') +
          item('<span class="w-2.5 h-2.5 rounded-full bg-blue-500"></span>', _statusLabel('scheduled')) +
          item('<span class="w-3 h-2.5 rounded border border-dashed border-amber-400 bg-white"></span>', `${_statusLabel('pending_approval')} (not booked yet)`) +
          item('<span class="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse"></span>', 'Overdue') +
          item('<span class="w-3.5 h-3.5 rounded-full bg-red-600 text-white text-[10px] font-extrabold leading-none flex items-center justify-center">!</span>', `${_statusLabel('failed')} — open it to see why`) +
          item('<span class="w-2.5 h-2.5 rounded-full bg-amber-500"></span>', 'Paused — needs you')
        : outreachItem + datedLegend() +
          // The Brand Designer schedules nothing: no records queue, so no yellow chip can ever appear.
          (_datedSource === 'briefs' || _datedSource === 'campaigns' ? '' : item('<span class="w-2.5 h-2.5 rounded-full bg-yellow-500"></span>', _leadOutreach ? 'Chase reminder' : 'Scheduled')) +
          item('<span class="text-gray-600 font-extrabold">✓</span>', 'Completed');
}

function _upcomingDays() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return Array.from({ length: 14 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
}

function _getDateRange() {
    if (_view === 'list' && _listFilter === 'upcoming') {
        const days = _upcomingDays();
        const to = new Date(days[days.length - 1]); to.setHours(23, 59, 59, 999);
        return { from: days[0], to };
    }
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

// ── Creating from the calendar ────────────────────────────────────
// The assistants that can start a social post (the same resolver Review's create button uses).
// null until resolved; [] when none can, which keeps the button hidden and day clicks inert.
let _calPosters = null;

async function _calResolveCreate() {
    _calPosters = null;
    // A records role's calendar (invoices, meetings, follow-ups) has nothing to post.
    if (_lockedAssistant && !_publishesContent) return;
    const list = typeof window.resolvePostingAssistants === 'function' ? await window.resolvePostingAssistants().catch(() => []) : [];
    _calPosters = Array.isArray(list) ? list : [];
    if (!_calCreateAssistantId()) return;
    const btn = document.getElementById('cal-new-post');
    // Both: `hidden` alone loses to a display utility (memory: hidden-class-loses-to-inline-flex).
    if (btn) { btn.classList.remove('hidden'); btn.classList.add('inline-flex'); }
}

/** Who a post started here belongs to: the assistant on screen, else the first that can post. */
function _calCreateAssistantId() {
    if (!_calPosters || !_calPosters.length) return null;
    if (_assistantFilter !== 'all') {
        const hit = _calPosters.find(a => String(a.id) === String(_assistantFilter));
        // On an assistant's own calendar, only that assistant — never someone else's post there.
        if (hit) return hit.id;
        if (_lockedAssistant) return null;
    }
    return _calPosters[0].id;
}

/**
 * Start a post. With a day, the draft is proposed for that day at 09:00 — or, for today once 09:00
 * has passed, the next whole hour — and approving it is still what books it (create-manual-post
 * takes the date as the draft's suggestion).
 */
window._calNewPost = function (dateKey) {
    const id = _calCreateAssistantId();
    if (!id || typeof window.openGeneratePostSheet !== 'function') return;
    let at = null;
    if (dateKey) {
        const [y, m, d] = String(dateKey).split('-').map(Number);
        at = new Date(y, m - 1, d, 9, 0, 0, 0);
        const soon = new Date(); soon.setMinutes(0, 0, 0); soon.setHours(soon.getHours() + 1);
        if (at < soon) at = soon;
    }
    window._gpPrefillPublishDate = at ? at.toISOString() : null;
    window.openGeneratePostSheet(id);
};

const _MONTH_CELL_MAX = 3;

/** "+N more": the List view on that day, scrolled to it. */
window._calShowDay = function (dateKey) {
    const [y, m, d] = String(dateKey).split('-').map(Number);
    _anchor = new Date(y, m - 1, d);
    _listFilter = 'all';
    _listFilterChosen = true;
    _scrolledToTodayFor = `${y}-${m - 1}`;   // don't let the "scroll to today" pass win
    _pendingScrollDate = dateKey;   // _render scrolls there once the list has loaded
    _setView('list');
};
let _pendingScrollDate = null;

/** True when nothing at all falls on a day of the month or week on screen. */
function _gridIsEmpty() {
    const { from, to } = _getDateRange();
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        const date = new Date(d);
        if (_postsOnDate(date).length || _awaitingOnDate(date).length || _blogPostsOnDate(date).length
            || _newsletterIssuesOnDate(date).length || _scheduledRecordsOnDate(date).length
            || _followUpsOnDate(date).length || _datedItemsOnDate(date).length || _activitiesOnDate(date).length) return false;
    }
    return true;
}

// ── Master render ─────────────────────────────────────────────────
function _render() {
    // Chips are about to be torn down and rebuilt — drop any open hover preview
    // so it doesn't linger detached from its (now-removed) anchor chip.
    if (_previewEl) { _previewEl.classList.remove('is-open'); }
    _previewReqToken++;

    _renderBuckets = null;   // rebuilt once per paint (see _byDay)

    // Update title
    const titleEl = document.getElementById('cal-title');
    if (titleEl) {
        if (_view === 'list' && _listFilter === 'upcoming') {
            titleEl.textContent = 'Coming up';
        } else if (_view === 'month' || _view === 'list') {
            titleEl.textContent = `${MONTH_NAMES[_anchor.getMonth()]} ${_anchor.getFullYear()}`;
        } else {
            const ws = _weekStart(_anchor);
            const we = new Date(ws); we.setDate(we.getDate() + 6);
            titleEl.textContent = `${ws.getDate()} ${MONTH_NAMES[ws.getMonth()]} – ${we.getDate()} ${MONTH_NAMES[we.getMonth()]} ${we.getFullYear()}`;
        }
    }

    // Icon-only arrows had no accessible name; say what they step by.
    const unit = _view === 'week' ? 'week' : 'month';
    document.getElementById('cal-btn-prev')?.setAttribute('aria-label', `Previous ${unit}`);
    document.getElementById('cal-btn-next')?.setAttribute('aria-label', `Next ${unit}`);

    const main = document.getElementById('cal-main');
    if (!main) return;

    const body = _view === 'month' ? _renderMonth() : _view === 'week' ? _renderWeek() : _renderList();
    main.setAttribute('aria-busy', _loading ? 'true' : 'false');
    // Error first: it says the grid below may be incomplete. Loading dims the grid rather than
    // blanking it, so the title and days move under the click and fill in when the data lands.
    const banner = _loadError && !_loading
        ? `<div role="alert" class="mx-4 mt-4 mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center gap-3 flex-wrap">
              <p class="text-sm text-red-700 flex-1 min-w-0">We couldn't load everything for these dates, so some posts may be missing. Nothing has been changed.</p>
              <button type="button" onclick="window._calRetry()" class="btn-secondary focus-ring tap-target px-3 py-1.5 text-sm font-bold rounded-lg border">Try again</button>
           </div>`
        : _loading
        ? `<div class="sticky top-0 z-20 flex justify-center pointer-events-none"><span role="status" class="mt-2 inline-flex items-center gap-2 rounded-full bg-white/70 border border-gray-200 shadow-sm px-3 py-1 text-xs font-bold text-gray-600">${window.bmsSpinnerHtml ? window.bmsSpinnerHtml(14) : ''}Loading…</span></div>`
        : (_view !== 'list' && _gridIsEmpty())
        // The grids had no empty state: a new owner saw a month of blank cells and no next step.
        // Same words and hand-off as the List view, above the grid rather than instead of it.
        ? (() => {
            const filtered = _assistantFilter !== 'all' || _platformFilter !== 'all';
            const period = _view === 'week' ? 'this week' : 'this month';
            const msg = filtered ? `Nothing matches these filters ${period}.` : _emptyMonthMessage().replace('this month', period);
            const toReview = !filtered && (!_lockedAssistant || _publishesContent)
                ? `<button type="button" onclick="window.loadView && window.loadView('review-queue')" class="btn-primary focus-ring tap-target px-3 py-1.5 text-sm font-bold rounded-lg">Go to Review</button>`
                : '';
            return `<div role="status" class="mx-4 mt-4 mb-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 flex items-center gap-3 flex-wrap">
              <p class="text-sm text-gray-700 flex-1 min-w-0">${msg}</p>${toReview}
           </div>`;
        })()
        : '';
    main.innerHTML = banner + (_loading ? `<div class="opacity-60">${body}</div>` : body);
    // Fingers can't drag here (HTML drag and drop is mouse-only), so on a touch screen every chip that
    // could be dragged also gets the List view's "Move…" button.
    if (_view !== 'list' && window.matchMedia && window.matchMedia('(hover: none)').matches) {
        main.querySelectorAll('[data-cal-move]').forEach((chip) => {
            const [kind, id] = chip.dataset.calMove.split(':');
            chip.classList.add('flex-wrap');
            chip.insertAdjacentHTML('beforeend', `<span class="w-full">${_moveButton(kind, Number(id))}</span>`);
        });
    }
    _renderBuckets = null;

    // Month list of the CURRENT month: start at today, not the 1st — once per month shown, so a
    // background refresh never yanks the scroll back.
    if (_view === 'list' && _listFilter !== 'upcoming' && !_loading) {
        const key = `${_anchor.getFullYear()}-${_anchor.getMonth()}`;
        const todayEl = main.querySelector('[data-cal-today]');
        if (todayEl && _scrolledToTodayFor !== key) { _scrolledToTodayFor = key; todayEl.scrollIntoView({ block: 'start' }); }
    }
    if (_view === 'list' && _pendingScrollDate && !_loading) {
        main.querySelector(`[data-list-date="${_pendingScrollDate}"]`)?.scrollIntoView({ block: 'start' });
        _pendingScrollDate = null;
    }
}

// ── Per-paint day buckets ─────────────────────────────────────────
// Every day cell used to re-filter every array (and build a Date per item) — O(days × items) per
// paint, and a paint happens on every filter click. Each list is now bucketed by day ONCE per paint.
let _renderBuckets = null;
function _byDay(name, items, when, keep) {
    if (!_renderBuckets) _renderBuckets = {};
    let m = _renderBuckets[name];
    if (!m) {
        m = new Map();
        for (const it of items) {
            const w = when(it);
            if (!w || (keep && !keep(it))) continue;
            const k = _dateKey(new Date(w));
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(it);
        }
        _renderBuckets[name] = m;
    }
    return m;
}
function _onDay(name, items, when, keep, date) {
    return _byDay(name, items, when, keep).get(_dateKey(date)) || [];
}

// ── Month View ────────────────────────────────────────────────────
function _renderMonth() {
    const year = _anchor.getFullYear(), month = _anchor.getMonth();
    const firstDay = _mondayIndex(new Date(year, month, 1));
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date(); today.setHours(0,0,0,0);

    // Day headers
    let html = `<div class="sticky top-0 z-10 grid grid-cols-7 bg-white border-b border-gray-200">`;
    DAY_NAMES_SHORT.forEach(d => {
        html += `<div class="py-2 text-center text-xs font-bold text-gray-500 uppercase tracking-wide">${d}</div>`;
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

        const tdClass = `relative border-r border-b border-gray-100 ${isToday ? 'bg-emerald-50' : 'bg-white hover:bg-gray-50/60'} transition p-1.5`;

        html += `<div class="${tdClass}" data-date="${dateKey}"
            ondragover="window._calDragOver(event, '${dateKey}')"
            ondragleave="window._calDragLeave(event)"
            ondrop="window._calDrop(event, '${dateKey}')">`;
        html += `<div class="flex items-center justify-end mb-1">
            <span class="${isToday ? 'w-6 h-6 brand-today rounded-full flex items-center justify-center text-xs font-extrabold' : 'text-xs font-bold text-gray-500 px-1'}"${isToday ? ' aria-label="Today"' : ''}>${day}</span>
        </div>`;
        const dayActs = _activitiesOnDate(date);
        const dayBlogs = _blogPostsOnDate(date);
        const dayIssues = _newsletterIssuesOnDate(date);
        const dayRecords = _scheduledRecordsOnDate(date);
        const dayFollowUps = _followUpsOnDate(date);
        // Pending outreach sits ABOVE the reminders and the completed runs: it is the only entry
        // in the cell that is going to do something on its own.
        const entries = [
            ...dayGroups.map(g => _postChip(g, 'month')), ..._awaitingOnDate(date).map(g => _awaitingChip(g)),
            ...dayBlogs.map(b => _blogChip(b, 'month')), ...dayIssues.map(_issueChip),
            ...dayFollowUps.map(f => _followUpChip(f, 'month')), ...dayRecords.map(r => _recordChip(r, 'month')),
            ..._datedItemsOnDate(date).map(_datedChip), ...dayActs.map(a => _activityChip(a, 'month')),
        ];
        // At most three per cell: one busy day used to stretch its whole week's row. The rest are a
        // click away, on that day in the List view.
        const more = entries.length - _MONTH_CELL_MAX;
        html += `<div class="space-y-1">${(more > 0 ? entries.slice(0, _MONTH_CELL_MAX) : entries).join('')}${more > 0
            ? `<button type="button" onclick="window._calShowDay('${dateKey}')" class="btn-utility focus-ring w-full text-left px-2 py-0.5 text-[11px] font-bold rounded-lg">+${more} more</button>`
            : ''}</div>`;
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
            <p class="text-xs font-bold text-gray-500 uppercase">${_dayShort(d)}</p>
            <p class="${isToday ? 'w-7 h-7 brand-today rounded-full flex items-center justify-center text-sm font-extrabold mx-auto mt-0.5' : 'text-lg font-extrabold text-gray-800 mt-0.5'}">${d.getDate()}</p>
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
            ${dayGroups.map(g => _postChip(g, 'week')).join('')}${_awaitingOnDate(d).map(g => _awaitingChip(g)).join('')}${_blogPostsOnDate(d).map(b => _blogChip(b, 'week')).join('')}${_newsletterIssuesOnDate(d).map(_issueChip).join('')}${_followUpsOnDate(d).map(f => _followUpChip(f, 'week')).join('')}${_scheduledRecordsOnDate(d).map(r => _recordChip(r, 'week')).join('')}${_datedItemsOnDate(d).map(_datedChip).join('')}${_activitiesOnDate(d).map(a => _activityChip(a, 'week')).join('')}
        </div>`;
    }
    html += `</div>`;
    return html;
}

// ── List View ─────────────────────────────────────────────────────
function _renderList() {
    const upcoming = _listFilter === 'upcoming';
    const year = _anchor.getFullYear(), month = _anchor.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const dates = upcoming
        ? _upcomingDays()
        : Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1));

    // Filter tabs. "Coming up" is a rolling two weeks from today (the phone default); the rest are
    // the month on screen. Drafts waiting for review show under All and Coming up, outlined, on
    // the day they're proposed for — approving them in Review is what commits that date.
    const tabs = [
        { key: 'upcoming',  label: 'Coming up' },
        { key: 'all',       label: 'All' },
        { key: 'scheduled', label: 'Scheduled' },
        { key: 'published', label: 'Posted' },
        { key: 'attention', label: 'Needs attention' },
    ];
    let html = `<div role="tablist" aria-label="Show" class="sticky top-0 z-10 bg-white border-b border-gray-200 px-4 flex gap-1 overflow-x-auto">`;
    tabs.forEach(t => {
        const active = _listFilter === t.key;
        // Roving tabindex + arrow keys (bound once at load), as on Review's tabs: five separate Tab
        // stops claiming to be a tablist was the opposite of what a screen reader announces.
        html += `<button type="button" role="tab" aria-selected="${active}" tabindex="${active ? 0 : -1}" aria-controls="cal-main" data-cal-list-tab="${t.key}" onclick="window._calSetListFilter('${t.key}')"
            class="focus-ring tap-target shrink-0 px-3 py-2.5 text-xs font-bold border-b-2 transition ${active ? 'border-brand text-emerald-800' : 'border-transparent text-gray-500 hover:text-gray-700'}">
            ${t.label}
        </button>`;
    });
    html += `</div>`;
    // This tab only covers the month on screen; something that failed on the 30th vanished on the
    // 1st. Review's Needs attention is not tied to dates, so say so and link there.
    if (_listFilter === 'attention') {
        html += `<div class="mx-4 mt-3 flex items-center gap-3 flex-wrap rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
            <p class="text-xs text-gray-600 flex-1 min-w-0">Showing ${_anchor.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}. Review lists everything that needs fixing, from any date.</p>
            <button type="button" onclick="window._rqInitialStatus='attention'; window.loadView && window.loadView('review-queue')" class="btn-utility focus-ring tap-target px-3 py-1 text-xs font-bold rounded-lg">Open in Review</button>
        </div>`;
    }

    // Apply filter
    const attention = (window.PlatformConstants && window.PlatformConstants.needsAttentionStatuses) || ['failed', 'paused', 'paused_credits'];
    const statusSets = {
        upcoming:  null,
        all:       null,
        // ⚠️ These sets span posts, blog posts AND newsletter issues, which use different words for
        // the same two moments: an issue is 'sending' where a post is 'publishing', and 'sent'
        // where a post is 'published'. Omitting either would drop every newsletter issue out of
        // the tab it belongs in while leaving it in All — a silent disappearance of exactly the
        // kind the paused_credits note below records.
        scheduled: new Set(['approved', 'scheduled', 'publishing', 'sending']),
        published: new Set(['published', 'sent']),
        // The same list Review's "Needs attention" tab uses (post-status.ts NEEDS_ATTENTION_STATUSES):
        // failed, plus the two parked states. 'paused_credits' is committed but parked on spent X
        // quota, which is the definition of needing attention. A failed BLOG post lands here too.
        attention: new Set(attention),
    };
    const allowedStatuses = statusSets[_listFilter];
    const unfiltered = _listFilter === 'all' || upcoming;

    const days = [];
    for (const date of dates) {
        let postGroups = _postsOnDate(date);
        let blogs = _blogPostsOnDate(date);
        let issues = _newsletterIssuesOnDate(date);
        const awaiting = unfiltered ? _awaitingOnDate(date) : [];
        // Scheduled Data Hub records are approval_status='scheduled', so they only
        // belong under the unfiltered tabs and "Scheduled".
        let records = (unfiltered || _listFilter === 'scheduled') ? _scheduledRecordsOnDate(date) : [];
        // Pending follow-ups belong under the same tabs for the same reason records do —
        // they are future work, never a published or failed thing.
        let followUps = (unfiltered || _listFilter === 'scheduled') ? _followUpsOnDate(date) : [];
        // Dated items are facts, not states — they belong under the unfiltered tabs only.
        const dated = unfiltered ? _datedItemsOnDate(date) : [];
        if (allowedStatuses) {
            // Filter INSIDE each cross-post group, then drop groups the filter emptied — a post
            // whose Instagram sibling failed still belongs under "Needs attention", showing only
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
        if (postGroups.length || awaiting.length || blogs.length || issues.length || records.length || followUps.length || dated.length) {
            days.push({ date, postGroups, awaiting, blogs, issues, records, followUps, dated });
        }
    }

    if (days.length === 0) {
        // Never an all-clear while the answer is still coming, or when it didn't come.
        if (_loading) {
            html += `<div class="flex items-center justify-center py-24 text-gray-500 text-sm gap-3" role="status">${window.bmsSpinnerHtml ? window.bmsSpinnerHtml(20) : ''}Loading…</div>`;
            return html;
        }
        if (_loadError) {
            html += `<p class="py-16 text-center text-sm text-gray-600">Nothing could be loaded for these dates.</p>`;
            return html;
        }
        const msg = unfiltered ? (upcoming ? _emptyUpcomingMessage() : _emptyMonthMessage()) : (upcoming ? 'Nothing in this filter in the next two weeks.' : 'Nothing in this filter this month.');
        // Publishing calendars hand off to Review, where the drafts are — named as the page is named.
        const toReview = unfiltered && (!_lockedAssistant || _publishesContent)
            ? `<button type="button" onclick="window.loadView && window.loadView('review-queue')" class="btn-primary focus-ring tap-target mt-1 px-4 py-2 text-sm font-bold rounded-lg">Go to Review</button>`
            : '';
        html += `<div class="flex flex-col items-center justify-center py-24 text-gray-500 gap-3 px-4 text-center">
            <svg class="w-10 h-10 text-gray-400" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            <p class="text-sm font-medium">${msg}</p>
            ${toReview}
        </div>`;
        return html;
    }

    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    html += `<div class="max-w-3xl mx-auto px-4 py-6 space-y-8">`;
    days.forEach(({ date, postGroups, awaiting, blogs, issues, records, followUps, dated }) => {
        const isToday = _dateKey(date) === _dateKey(today);
        const isTomorrow = _dateKey(date) === _dateKey(tomorrow);
        const pill = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : '';
        html += `<div${isToday ? ' data-cal-today' : ''} data-list-date="${_dateKey(date)}" style="scroll-margin-top:3.5rem">
            <div class="flex items-center gap-3 mb-3">
                <h3 class="text-sm font-extrabold ${isToday ? 'text-emerald-800' : 'text-gray-700'}">
                    ${date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                    ${pill ? `<span class="ml-2 text-[11px] bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded-full font-bold">${pill}</span>` : ''}
                </h3>
                <div class="flex-1 h-px bg-gray-200"></div>
            </div>
            <div class="space-y-2">${postGroups.map(g => _listRow(g)).join('')}${awaiting.map(g => _awaitingChip(g, 'list')).join('')}${(blogs || []).map(b => _blogChip(b, 'list')).join('')}${(issues || []).map(_issueChip).join('')}${(followUps || []).map(_listFollowUpRow).join('')}${(records || []).map(_listRecordRow).join('')}${(dated || []).map(_datedChip).join('')}</div>
        </div>`;
    });
    html += `</div>`;
    return html;
}

window._calSetListFilter = function (key) {
    const wasUpcoming = _listFilter === 'upcoming';
    _listFilter = key;
    _listFilterChosen = true;
    // "Coming up" is its own date range; switching into or out of it is a reload, not a re-filter.
    if (wasUpcoming !== (key === 'upcoming')) {
        if (wasUpcoming) { _anchor = new Date(); _anchor.setHours(0, 0, 0, 0); }
        _navRefresh();
        return;
    }
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
    const failedPost = status === 'failed';
    const parked = status === 'paused' || status === 'paused_credits';
    const overdue = members.some(_isOverdue);
    // Why it failed, in the platform-neutral words the Review card uses (scheduled-posts.ts →
    // diagnosePostFailure). Read off the failed sibling, not the representative.
    const failedMember = members.find(m => m.status === 'failed');
    const failWhy = failedMember && failedMember.failure && failedMember.failure.title ? failedMember.failure.title : '';
    // Posted posts show when they actually went live (publishedAt); everything else
    // shows the scheduled time.
    const stamp = posted && post.publishedAt ? new Date(post.publishedAt) : new Date(post.publishDate);
    const time = stamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const isDraggable = ['approved', 'scheduled'].includes(status);

    const revisedBadge = post.isRevised ? `<span class="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-1 rounded shrink-0">Revised</span>` : '';
    // #4: left border = assistant colour; status stays glanceable via the right-hand marker.
    const asstColor = _assistantColor(post.assistantId);
    const asstName = _assistantName(post.assistantId);

    // Right-hand status marker + chip tint give instant confirmation of *actual* state:
    //  • posted     → green tint + ✓  ("this really went out")
    //  • failed     → red tint + "!"   ("this did NOT go out — open it to see why"). It used to be a
    //                 white chip with a red dot, which the legend said meant "Overdue".
    //  • paused     → amber tint + "Paused · reconnect" (or the X limit) — waiting on the owner
    //  • publishing → pulsing blue dot   ("going out right now")
    //  • overdue    → amber tint + pulsing red dot ("should have posted, hasn't")
    //  • otherwise  → the normal status dot.
    let chipBg = 'bg-white hover:bg-gray-50', timeColor = 'text-gray-700', marker, titleSuffix = '';
    if (posted) {
        chipBg = 'bg-green-50';
        timeColor = 'status-posted';
        marker = `<span class="status-posted-tick text-xs font-extrabold shrink-0" aria-hidden="true" title="Posted ${time}">✓</span>`;
        titleSuffix = ` · Posted ${time}`;
    } else if (failedPost) {
        chipBg = 'bg-red-50 hover:bg-red-100';
        timeColor = 'text-red-700';
        marker = `<span class="w-3.5 h-3.5 rounded-full bg-red-600 text-white text-[10px] font-extrabold leading-none flex items-center justify-center shrink-0" aria-hidden="true">!</span>`;
        titleSuffix = ` · ${_statusLabel('failed')}${failWhy ? ': ' + failWhy : ''}`;
    } else if (parked) {
        chipBg = 'bg-amber-50 hover:bg-amber-100';
        timeColor = 'text-amber-800';
        marker = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true"></span>`;
        titleSuffix = ` · ${_statusLabel(status)}`;
    } else if (publishing) {
        timeColor = 'text-blue-700';
        marker = `<span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" aria-hidden="true" title="${_statusLabel('publishing')}"></span>`;
        titleSuffix = ` · ${_statusLabel('publishing')}`;
    } else if (overdue) {
        chipBg = 'bg-amber-50 hover:bg-amber-100';
        timeColor = 'text-amber-700';
        marker = `<span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" aria-hidden="true" title="Overdue — not yet posted"></span>`;
        titleSuffix = ' · Overdue — not yet posted';
    } else {
        marker = `<span class="w-1.5 h-1.5 rounded-full ${sm.dot} shrink-0" aria-hidden="true" title="${_statusLabel(status)}"></span>`;
        titleSuffix = ` · ${_statusLabel(status)}`;
    }

    // The one-line identity of the chip. A cross-post reads "Multiple" rather than naming one of its
    // platforms — the whole point of collapsing the group is that no single platform is the answer.
    const platLabel = multi ? `Multiple (${members.length})` : plat.label;
    const summary = post.caption || platLabel || post.platform || '';
    const platNames = _platformNames(group.platforms);

    // role="button" + tabindex rather than a <button>: Firefox will not start a drag on a button, and
    // these chips drag. Enter/Space are handled once, at document level (see _calKeyActivate).
    return `<div role="button" tabindex="0" data-cal-activate
        onclick="window._calOpenPost(${post.id})"
        onmouseenter="window._calShowPreview(event, ${post.id})"
        onmouseleave="window._calHidePreview()"
        ${isDraggable ? `draggable="true" ondragstart="window._calDragStart(event, ${post.id})" data-cal-move="post:${post.id}" aria-keyshortcuts="M"` : ''}
        data-post-id="${post.id}"
        class="group focus-ring flex items-center gap-1.5 px-2 py-1 rounded-lg ${chipBg} shadow-sm cursor-pointer transition select-none text-left w-full"
        style="border-left:3px solid ${asstColor}"
        aria-label="${time} · ${_escHtml(asstName)} · ${_escHtml(platLabel)}${multi ? ` (${_escHtml(platNames)})` : ''} · ${_escHtml((post.caption || '').substring(0, 80))}${_escHtml(titleSuffix)}">
        ${multi ? _multiAvatar(16) : _platAvatar(post.platform, 16)}
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold ${timeColor} truncate">${overdue ? '<span aria-hidden="true">⚠ </span>' : ''}${time}${multi ? ` · <span class="font-extrabold">Multiple</span>` : ''}</p>
            <p class="text-[11px] ${failedPost && failWhy ? 'text-red-700' : 'text-gray-500'} truncate leading-tight">${_escHtml((failedPost && failWhy ? failWhy : summary).substring(0, 40))}</p>
        </div>
        ${revisedBadge}
        ${marker}
    </div>`;
}

// ── Waiting-for-review chip ───────────────────────────────────────
// A draft on the slot it is PROPOSED for. Dashed and never draggable: the date isn't committed until
// the draft is approved, so it can't be "moved" here — opening it is the action, and the editor's
// Approve commits the slot. Lets the owner see "Thursday has a post if I approve it".
function _awaitingChip(group, viewType) {
    const post = group.rep;
    const multi = group.members.length > 1;
    const time = new Date(post.publishDate).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const label = _statusLabel('pending_approval');
    const platLabel = multi ? `Multiple (${group.members.length})` : ((PLATFORM_META[post.platform] || {}).label || post.platform || '');
    const caption = (post.caption || '').trim();
    if (viewType === 'list') {
        return `<div role="button" tabindex="0" data-cal-activate onclick="window._calOpenPost(${post.id})"
            class="focus-ring flex items-start gap-4 bg-white border-2 border-dashed border-amber-300 rounded-xl px-5 py-4 cursor-pointer transition hover:bg-amber-50"
            aria-label="${time} · ${_escHtml(platLabel)} · ${label}: ${_escHtml(caption.substring(0, 80))}">
            ${multi ? _multiAvatar(36) : _platAvatar(post.platform, 36)}
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                    <span class="text-sm font-extrabold text-gray-900">${_escHtml(multi ? 'Multiple' : platLabel)}</span>
                    <span class="text-xs font-bold text-gray-500">${time}</span>
                </div>
                <p class="text-sm text-gray-600 truncate">${_escHtml(caption.substring(0, 120) || '(No caption)')}</p>
                <p class="text-xs text-gray-600 mt-1">Not booked yet — open it to approve it for this time.</p>
            </div>
            <span class="text-xs font-bold px-2.5 py-1 rounded-full border bg-amber-50 text-amber-800 border-amber-300 shrink-0 mt-1">${label}</span>
        </div>`;
    }
    return `<div role="button" tabindex="0" data-cal-activate
        onclick="window._calOpenPost(${post.id})"
        class="focus-ring flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/70 border border-dashed border-amber-400 cursor-pointer transition select-none text-left w-full"
        aria-label="${time} · ${_escHtml(platLabel)} · ${label}, not booked yet: ${_escHtml(caption.substring(0, 80))}">
        ${multi ? _multiAvatar(16) : _platAvatar(post.platform, 16)}
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold text-amber-800 truncate">${time} · ${label}</p>
            <p class="text-[11px] text-gray-500 truncate leading-tight">${_escHtml((caption || platLabel).substring(0, 40))}</p>
        </div>
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
    // A tooltip for the focused chip (aria-describedby is set on focus, below).
    _previewEl.id = 'cal-hover-preview';
    _previewEl.setAttribute('role', 'tooltip');
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
    // On a touch screen a tap fires mouseenter too, which started a preview fetch while the editor
    // was already opening on the same tap.
    if (event.type === 'mouseenter' && window.matchMedia && window.matchMedia('(hover: none)').matches) return;
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
            <p class="text-[11px] font-semibold text-gray-600 truncate"><span aria-hidden="true">✓ </span>${_escHtml(name)}<span class="sr-only"> finished a task at ${time}</span></p>
            ${viewType === 'week' ? `<p class="text-[11px] text-gray-500 truncate leading-tight">${time} · task done</p>` : ''}
        </div>
    </div>`;
}

// Scheduled Data Hub record chip (assistant Calendar tab) — future work, not a completed run,
// so it reads "🗓 scheduled" rather than the activity "✓ done" chip.
// What an empty month should say depends on what this calendar can hold. "Approve a draft in the
// Review Queue" was shown to every assistant, including ones that draft nothing.
function _emptyUpcomingMessage() {
    if (!_lockedAssistant || _publishesContent) return 'Nothing going out in the next two weeks. Approve a draft in Review to put it on the calendar.';
    return 'Nothing in the next two weeks.';
}
function _emptyMonthMessage() {
    if (!_lockedAssistant || _publishesContent) return 'Nothing scheduled this month. Approve a draft in Review to put it on the calendar.';
    if (_datedSource === 'briefs') return 'Nothing this month. Briefs with a due date appear here on that date.';
    if (_datedSource === 'campaigns') return 'Nothing this month. Each campaign appears on the day it starts and the day it ends.';
    const role = _roleKey || '';
    if (role === 'accounts_receivable_clerk') return 'Nothing this month. Invoices appear on their due date once your assistant has them.';
    if (role === 'meeting_note_taker') return 'Nothing this month. Meetings appear on their date once your assistant has taken notes.';
    if (_leadOutreach) return 'Nothing this month. Follow-up emails and chase reminders appear here once leads are contacted.';
    return 'Nothing this month. Anything you schedule from Review appears here, with completed work.';
}

function _datedItemsOnDate(date) {
    return _onDay('dated', _datedItems, i => i.at, i => _matchesAssistantFilter(i._assistantId), date);
}
// Read-only: the date is a fact about the record (an invoice's due date, a meeting's time), so it is
// not draggable. Clicking opens the tab where the item lives.
function _datedChip(it) {
    const meta = DATED_KIND_META[it.kind] || { icon: '•', label: '' };
    const note = it.derived ? ' — worked out from how overdue it was when recorded' : (it.done ? ' — done' : '');
    return `<div role="button" tabindex="0" data-cal-activate onclick='window._calOpenDated(${JSON.stringify(String(it.key))}, ${Number(it._assistantId) || "null"})'
        class="focus-ring flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-50 hover:bg-gray-100 shadow-sm cursor-pointer text-left w-full"
        style="border-left:3px solid ${_lockedAssistant ? '#6b7280' : _assistantColor(it._assistantId)}" title="${_escHtml(meta.label + ': ' + (it.title || '') + note)}"
        aria-label="${_escHtml(meta.label + ': ' + (it.title || '') + note)}">
        <span class="text-xs shrink-0" aria-hidden="true">${meta.icon}</span>
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold text-gray-700 truncate">${_escHtml(meta.label)}${it.done ? ' ✓' : ''}</p>
            <p class="text-[11px] text-gray-500 truncate leading-tight">${_escHtml(String(it.title || '').substring(0, 40))}</p>
        </div>
    </div>`;
}

// On the assistant's own page the tab is right there; from the sidebar Calendar, open that
// assistant on the tab where the item lives.
window._calOpenDated = function (key, assistantId) {
    const it = _datedItems.find((x) => String(x.key) === String(key) && (assistantId == null || x._assistantId === assistantId));
    if (!it) return;
    if (_lockedAssistant) { window._activateMainTab && window._activateMainTab(it.tab); return; }
    window._assistantDetailInitialTab = it.tab;
    window.routeToAssistantDetail && window.routeToAssistantDetail(it._assistantId);
};

function _scheduledRecordsOnDate(date) {
    return _onDay('records', _scheduledRecords, r => r.scheduledFor, r => _matchesAssistantFilter(r._assistantId), date);
}
// Clicking opens the item's detail (LeadCalendarModal); dragging moves its due date. Both were
// added in the same change and for the same reason: this chip was previously inert with a comment
// saying "records open from the Data Hub", which asked the user to leave the calendar, find the
// right tab and search for a row by name to answer "what IS this?".
function _recordChip(rec, viewType) {
    const color = _assistantColor(rec._assistantId ?? (_assistantFilter === 'all' ? null : Number(_assistantFilter)));
    const time = new Date(rec.scheduledFor).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    // "Chase reminder" only for the lead roles, where that is what scheduled_for provably is
    // (lead-generation.ts stamps it after a send). Every other records role uses the generic word,
    // because their scheduled_for means whatever their own flow put there.
    const kindWord = _leadOutreach ? 'chase reminder' : 'scheduled';
    return `<div role="button" tabindex="0" data-cal-activate
        onclick="window._calOpenRecord(${rec.id})"
        draggable="true"
        ondragstart="window._calDragStart(event, { kind: 'record', id: ${rec.id} })"
        ${viewType === 'list' ? '' : `data-cal-move="record:${rec.id}" aria-keyshortcuts="M"`}
        data-cal-record-id="${rec.id}"
        class="focus-ring flex items-center gap-1.5 px-2 py-1 rounded-lg bg-yellow-50 hover:bg-yellow-100 cursor-pointer transition text-left w-full select-none"
        style="border-left:3px solid ${color}"
        title="${_escHtml(rec.title || '')} — ${kindWord} ${time} · ${_escHtml(rec.recordType || '')}"
        aria-label="${_escHtml(rec.title || '')} — ${kindWord} ${time}">
        <span class="w-1.5 h-1.5 rounded-full shrink-0 bg-yellow-500" aria-hidden="true"></span>
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-semibold text-gray-600 truncate"><span aria-hidden="true">🗓 </span>${_escHtml(rec.title || rec.recordType || 'Scheduled')}</p>
            ${viewType === 'week' ? `<p class="text-[11px] text-gray-500 truncate leading-tight">${time} · ${kindWord}</p>` : ''}
        </div>
    </div>`;
}

// ── Pending outreach (lead roles) ────────────────────────────────────────────
// One chip per follow-up email the cadence is going to send. Indigo and ✉, deliberately unlike
// the yellow 🗓 reminder beside it: a user who cannot tell these two apart at a glance cannot tell
// "you owe this lead a call" from "we are emailing this stranger on Thursday".
function _followUpsOnDate(date) {
    return _onDay('followups', _followUps, f => f.nextSendAt, f => _matchesAssistantFilter(f._assistantId), date);
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
    return `<div role="button" tabindex="0" data-cal-activate
        onclick="window._calOpenFollowUp(${f.threadId})"
        ${blocked || !_lockedAssistant ? '' : `draggable="true" ondragstart="window._calDragStart(event, { kind: 'followup', id: ${f.threadId} })" data-cal-move="followup:${f.threadId}" aria-keyshortcuts="M"`}
        data-cal-followup-thread="${f.threadId}"
        class="focus-ring flex items-center gap-1.5 px-2 py-1 rounded-lg ${tone.bg} cursor-pointer transition text-left w-full select-none"
        style="border-left:3px solid ${tone.edge}"
        title="${_escHtml(title)}" aria-label="${_escHtml(title)}">
        <span class="w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}" aria-hidden="true"></span>
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold ${tone.text} truncate"><span aria-hidden="true">✉ </span>${time}${blocked ? ' · on hold' : ''}</p>
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
    const movable = !blocked && _lockedAssistant;
    return `<div class="relative flex items-start gap-4 ${shell} border rounded-xl px-5 py-4 transition"
        style="border-left:3px solid ${blocked ? '#9ca3af' : '#6366f1'}">
        ${_rowOpener(`window._calOpenFollowUp(${f.threadId})`, `${f.title || 'Lead'}, follow-up ${f.nextStep} at ${time}${blocked ? ', on hold' : ''}`)}
        <span class="w-9 h-9 rounded-full ${blocked ? 'bg-gray-100' : 'bg-indigo-100'} flex items-center justify-center text-base shrink-0" aria-hidden="true">✉</span>
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-extrabold text-gray-900 truncate">${_escHtml(f.title || 'Lead')}</span>
                <span class="text-xs font-bold text-gray-500">${time}</span>
            </div>
            <p class="text-xs text-gray-500">Follow-up #${f.nextStep}${f.contactEmail ? ` · ${_escHtml(f.contactEmail)}` : ''}</p>
            ${movable ? _moveButton('followup', f.threadId) : ''}
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
    const color = _assistantColor(rec._assistantId ?? (_assistantFilter === 'all' ? null : Number(_assistantFilter)));
    const time = new Date(rec.scheduledFor).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `<div class="relative flex items-start gap-4 bg-yellow-50 border border-yellow-200 hover:border-yellow-300 rounded-xl px-5 py-4 transition"
        style="border-left:3px solid ${color}">
        ${_rowOpener(`window._calOpenRecord(${rec.id})`, `${rec.title || rec.recordType || 'Scheduled'}, ${_leadOutreach ? 'chase reminder' : 'scheduled'} at ${time}`)}
        <span class="w-9 h-9 rounded-full bg-yellow-100 flex items-center justify-center text-base shrink-0" aria-hidden="true">🗓</span>
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-extrabold text-gray-900 truncate">${_escHtml(rec.title || rec.recordType || 'Scheduled')}</span>
                <span class="text-xs font-bold text-gray-500">${time}</span>
            </div>
            ${rec.recordType ? `<p class="text-xs text-gray-500 capitalize">${_escHtml(rec.recordType)}</p>` : ''}
            ${_moveButton('record', rec.id)}
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
    const failedMember = members.find(m => m.status === 'failed');
    const failWhy = failedMember && failedMember.failure && failedMember.failure.title ? failedMember.failure.title : '';
    const statusLine = posted
        ? `<p class="text-xs font-bold status-posted mt-1"><span aria-hidden="true">✓ </span>Posted${postedAt ? ' ' + postedAt.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</p>`
        : failedMember
        ? `<p class="text-xs font-bold text-red-700 mt-1">${_escHtml(failWhy || 'It did not go out.')} Open it to see what to do.</p>`
        : overdue
        ? `<p class="text-xs font-bold text-amber-800 mt-1"><span aria-hidden="true">⚠ </span>Overdue — scheduled time passed, not yet posted</p>`
        : '';

    // The right-hand badge: posted gets a check, overdue is recoloured so a past
    // date never reads as a calm "Scheduled".
    const badge = posted
        ? `<span class="text-xs font-bold px-2.5 py-1 rounded-full border bg-green-100 status-posted border-green-300 shrink-0 mt-1">${_statusLabel('published')}</span>`
        : overdue
        ? `<span class="text-xs font-bold px-2.5 py-1 rounded-full border bg-amber-100 text-amber-800 border-amber-300 shrink-0 mt-1">Overdue</span>`
        : `<span class="text-xs font-bold px-2.5 py-1 rounded-full border ${sm.badge} shrink-0 mt-1">${_statusLabel(status)}</span>`;
    const movable = ['approved', 'scheduled'].includes(status);

    // Grouped rows name themselves "Multiple" and then SHOW the platforms — the list view has the
    // width the month chip doesn't, so the user gets the answer without opening anything.
    const platStrip = multi
        ? `<span class="flex items-center gap-1 shrink-0" title="${_escHtml(_platformNames(group.platforms))}">
               ${members.map(m => _platAvatar(m.platform, 18)).join('')}
           </span>`
        : '';

    return `<div class="relative flex items-start gap-4 ${failedMember ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'} border rounded-xl px-5 py-4 hover:border-emerald-200 hover:shadow-sm transition">
        ${_rowOpener(`window._calOpenPost(${post.id})`, `${multi ? 'Multiple platforms' : plat.label}, ${time}, ${_statusLabel(status)}: ${(post.caption || '').substring(0, 80)}`)}
        ${multi ? _multiAvatar(36) : _platAvatar(post.platform, 36)}
        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1 flex-wrap">
                <span class="text-sm font-extrabold text-gray-900">${multi ? 'Multiple' : plat.label}</span>
                ${platStrip}
                <span class="text-xs font-bold text-gray-500">${time}</span>
                ${post.isAutonomous ? `<span class="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded-full">Created by ${_escHtml(post.assistantId != null ? _assistantName(post.assistantId) : 'your assistant')}</span>` : ''}
            </div>
            <p class="text-sm text-gray-600 truncate">${_escHtml((post.caption || '').substring(0, 120) || '(No caption)')}</p>
            ${post.hashtags ? `<p class="text-xs text-blue-500 mt-1 truncate">${_escHtml(post.hashtags.substring(0, 80))}</p>` : ''}
            ${statusLine}
            ${movable ? _moveButton('post', post.id) : ''}
        </div>
        ${badge}
    </div>`;
}

// "Move…" — the way to reschedule without dragging. A drag needs a mouse: it does nothing on a
// phone (which opens on the List view, where there are no drop targets at all) or from a keyboard.
// Same rules and endpoints as a drop; the date/time dialog is its own confirmation.
function _moveButton(kind, id) {
    return `<button type="button" onclick="event.stopPropagation(); window._calMove('${kind}', ${Number(id)})"
        class="relative z-10 btn-secondary focus-ring tap-target mt-2 px-2.5 py-1 text-xs font-bold rounded-lg border">Move…</button>`;
}

// A list row's "open" action: a real button laid over the whole row, underneath "Move…" (which is
// z-10). The row used to BE a role="button" with Move… inside it — a button within a button, which
// screen readers flatten into one long label and phones mis-tap. Now they are siblings: Tab reaches
// "open" (with a short name of its own) and then "Move…".
function _rowOpener(onclick, label) {
    return `<button type="button" onclick="${onclick}" aria-label="${_escHtml(label)}"
        class="focus-ring absolute inset-0 w-full h-full rounded-xl cursor-pointer"></button>`;
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
        assistantId: _scheduledRecords.find(r => r.id === recordId)?._assistantId ?? Number(_assistantFilter),
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
        assistantId: f?._assistantId ?? Number(_assistantFilter),
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
//   post     → scheduled_posts.publish_date   (confirm dialog, then PATCH per cross-post sibling; past refused)
//   record   → assistant_records.scheduled_for (a chase reminder / due date — moves immediately)
//   followup → sequence_enrolments.next_send_at (a real send — moves immediately, past refused)
//   blog     → blog_posts.publish_date        (moves immediately, past refused)
//
// Each kind has one _move* function that takes the NEW INSTANT. A drop works out that instant from
// the target day (keeping the time of day) and calls it; "Move…" (_calMove) asks for a date and time
// and calls the same function — so both routes share one set of past-date rules and messages.
//
// `_dragItem` is the general form; `_dragPostId` is kept as-is because the post path already reads
// it in several places.
let _dragItem = null;

// A drag whose source is a post is called with a bare id (the post chips predate this and pass
// `${post.id}`); everything else passes { kind, id }. Normalising here rather than at each call
// site keeps the post chip's signature untouched.
window._calDragStart = function (e, arg) {
    const item = (arg && typeof arg === 'object') ? arg : { kind: 'post', id: arg };
    _dragItem = item;
    _dragPostId = item.kind === 'post' ? item.id : null;
    e.dataTransfer.effectAllowed = 'move';
    // Deferred so the browser snapshots the drag image at full opacity first.
    setTimeout(() => e.target.classList.add('opacity-50'), 0);
};

window._calDragOver = function (e, dateKey) {
    e.preventDefault();
    _dragTargetDate = dateKey;
    const cell = e.currentTarget;
    cell.classList.add('drop-target');
};

window._calDragLeave = function (e) {
    e.currentTarget.classList.remove('drop-target');
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
    e.currentTarget.classList.remove('drop-target');

    const item = _dragItem;
    if (item && item.kind === 'followup') { _dragItem = null; void _dropFollowUp(item.id, dateKey); return; }
    if (item && item.kind === 'record')   { _dragItem = null; void _dropRecord(item.id, dateKey); return; }
    if (item && item.kind === 'blog')     { _dragItem = null; void _dropBlog(item.id, dateKey); return; }
    _dragItem = null;

    if (!_dragPostId) return;
    const post = _posts.find(p => p.id === _dragPostId);
    _dragPostId = null;
    if (!post) return;
    if (_dateKey(new Date(post.publishDate)) === dateKey) return; // same day
    void _movePost(post, _dropTarget(dateKey, post.publishDate), { confirm: true });
};

// Can't go back in time. A committed post with a past time is the publisher's "overdue" case and
// would go out on its next run — i.e. straight away, as the silent result of a mis-aimed drag. Blog
// posts, follow-ups and reminders already refused this; social posts were the one kind that didn't.
// Compared as INSTANTS, like the blog path: today is fine if the post's time hasn't gone by. The
// server refuses the same (scheduled-posts.ts PATCH, code PAST_DATE).
async function _refusePast(newDate, what, originalIso, howToNow) {
    if (newDate.getTime() > Date.now()) return false;
    const original = new Date(originalIso);
    await (window.alertModal
        ? window.alertModal(
            `That time has already passed. <strong>${_escHtml(what)}</strong> stays where it was, on `
            + `${_escHtml(_dayLabel(original))} at ${_escHtml(original.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}.`
            + (howToNow ? `<br><br>${howToNow}` : ''),
            { title: `Can't move it to ${_dayLabel(newDate)}` })
        : Promise.resolve(window.showToast?.('That time has already passed.', { icon: '⚠️' })));
    _render();   // snap the chip back
    return true;
}

// "Undo" on a move's toast: the same move back to where it was, through the same path (so a time
// that has passed since is refused like any other).
function _undoMove(back) {
    return { label: 'Undo', onClick: back };
}

async function _movePost(post, newDate, { confirm = false } = {}) {
    const was = new Date(post.publishDate);   // for Undo, taken before anything can change it
    const what = (post.caption || '').trim().substring(0, 40) || 'This post';
    if (await _refusePast(newDate, what, post.publishDate, 'To post it now, open it and choose <strong>Post now</strong>.')) return;

    // The chip is one logical post, so a move takes every platform it goes to — leaving siblings
    // behind would silently split a cross-post across two dates.
    const siblings = _siblingsOf(post);
    const scope = siblings.length > 1 ? ` on ${_platformNames(siblings.map(s => s.platform))}` : '';
    const newLabel = `${_dayLabel(newDate)} at ${newDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

    if (confirm) {
        const ok = await window.confirmModal(
            `Move <strong>${_escHtml(what)}</strong>${_escHtml(scope)} from ${_escHtml(_dayLabel(new Date(post.publishDate)))} to ${_escHtml(newLabel)}?`,
            { title: 'Reschedule post?', confirmLabel: 'Reschedule', tone: 'primary' });
        if (!ok) { _render(); return; }
    }

    try {
        // Every sibling of the group moves to the same instant — that shared slot is what makes
        // them one post.
        const results = await Promise.all(siblings.map(sib =>
            fetch(`/.netlify/functions/scheduled-posts?id=${sib.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ publishDate: newDate.toISOString() }),
            })
        ));
        const failed = results.filter(r => !r.ok);
        if (failed.length) {
            const first = await failed[0].json().catch(() => ({}));
            window.showToast?.(failed.length === results.length
                ? (first.error || 'Reschedule failed. Please try again.')
                : `Rescheduled, but ${failed.length} of ${results.length} platforms could not be moved. Please check the calendar.`,
                { icon: '⚠️' });
        } else {
            window.showToast?.(`Moved to ${newLabel}.`, { icon: '📅', duration: 8000, action: _undoMove(() => {
                const now = _posts.find(x => x.id === post.id);
                if (now) _movePost(now, was);
            }) });
        }
    } catch (e) { window.showToast?.('Reschedule failed. Please try again.', { icon: '⚠️' }); }
    await _loadAndRender();
}

// ── "Move…" — reschedule without a drag ──────────────────────────────────────
// A local date-time string for <input type="datetime-local"> (it takes no timezone).
function _localInputValue(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

window._calMove = async function (kind, id) {
    window._calHidePreview?.();
    const find = {
        post:     () => { const p = _posts.find(x => x.id === id); return p && { at: p.publishDate, name: (p.caption || '').trim().substring(0, 60) || 'this post' }; },
        blog:     () => { const p = _blogPosts.find(x => x.id === id); return p && { at: p.publishDate, name: p.title || 'this article' }; },
        record:   () => { const r = _scheduledRecords.find(x => x.id === id); return r && { at: r.scheduledFor, name: r.title || 'this item' }; },
        followup: () => { const f = _followUps.find(x => x.threadId === id); return f && { at: f.nextSendAt, name: `the follow-up to ${f.title || 'this lead'}` }; },
    }[kind];
    const item = find && find();
    if (!item || !item.at || typeof window.promptModal !== 'function') return;

    const value = await window.promptModal(`New date and time for <strong>${_escHtml(item.name)}</strong>.`, {
        title: 'Move to…', confirmLabel: 'Move', inputType: 'datetime-local', inputLabel: 'New date and time',
        value: _localInputValue(new Date(item.at)), min: _localInputValue(new Date()), required: true,
    });
    if (value == null) return;
    const newDate = new Date(value);   // "YYYY-MM-DDTHH:MM" parses as LOCAL time
    if (Number.isNaN(newDate.getTime())) { window.showToast?.('That is not a date and time.', { icon: '⚠️' }); return; }
    if (newDate.getTime() === new Date(item.at).getTime()) return;

    if (kind === 'post') return _movePost(_posts.find(x => x.id === id), newDate);
    if (kind === 'blog') return _moveBlog(id, newDate);
    if (kind === 'record') return _moveRecord(id, newDate);
    if (kind === 'followup') return _moveFollowUp(id, newDate);
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
    await _moveFollowUp(threadId, newDate);
}

async function _moveFollowUp(threadId, newDate) {
    const f = _followUps.find(x => x.threadId === threadId);
    if (!f) return;
    const was = new Date(f.nextSendAt);
    // "Move…" can pick a time earlier today, which the day-level check above can't see.
    if (await _refusePast(newDate, `The follow-up to ${f.title || 'this lead'}`, f.nextSendAt, '')) return;

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
        window.showToast?.(`Follow-up to ${f.title || 'this lead'} moved to ${_dayLabel(newDate)}.`, { duration: 8000, action: _undoMove(() => _moveFollowUp(threadId, was)) });
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
    await _moveRecord(recordId, newDate);
}

async function _moveRecord(recordId, newDate) {
    const rec = _scheduledRecords.find(r => r.id === recordId);
    if (!rec) return;
    const was = new Date(rec.scheduledFor);
    // Same rule as the drop, at day level: a reminder set for earlier today is still today's.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (newDate < today) {
        await _refusePast(newDate, rec.title || 'This item', rec.scheduledFor, '');
        return;
    }

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
        window.showToast?.(`${rec.title || 'Item'} moved to ${_dayLabel(newDate)}.`, { duration: 8000, action: _undoMove(() => _moveRecord(recordId, was)) });
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

    await _moveBlog(blogId, _dropTarget(dateKey, post.publishDate));
}

async function _moveBlog(blogId, newDate) {
    const post = _blogPosts.find(p => p.id === blogId);
    if (!post || !post.publishDate) return;
    const original = new Date(post.publishDate);
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
        window.showToast?.(`${post.title || 'Post'} moved to ${_dayLabel(newDate)}.`, { duration: 8000, action: _undoMove(() => _moveBlog(blogId, original)) });
    } catch (err) {
        window.showToast?.(err.message || 'Could not move that post.', { icon: '⚠️' });
    }
    await _loadAndRender();
}

// One delegated listener each, bound once at load — never from a render path (re-binding on every
// paint stacked a listener per chip per repaint).
//  • dragend: a cancelled drag leaves its chip at 50% opacity, which looks exactly like mid-save.
//  • Enter / Space on a chip opens it, as a click would: the chips are role="button" divs (so they
//    can still be dragged in Firefox), which a keyboard otherwise can't activate.
if (!window._calDelegatesBound) {
    window._calDelegatesBound = true;
    document.addEventListener('dragend', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('[draggable]') : null;
        if (el) el.classList.remove('opacity-50');
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target;
        if (!el || !el.matches || !el.matches('[data-cal-activate]')) return;
        e.preventDefault();
        el.click();
    });
    // The caption-and-picture preview was mouse-only. A post chip that gains keyboard focus shows it
    // too, described by it, and loses it with focus.
    document.addEventListener('focusin', (e) => {
        const chip = e.target && e.target.matches && e.target.matches('#cal-main [data-post-id][onmouseenter]') ? e.target : null;
        if (!chip) return;
        chip.setAttribute('aria-describedby', 'cal-hover-preview');
        window._calShowPreview({ type: 'focus', currentTarget: chip }, Number(chip.dataset.postId));
    });
    document.addEventListener('focusout', (e) => {
        if (e.target && e.target.matches && e.target.matches('#cal-main [data-post-id][onmouseenter]')) window._calHidePreview();
    });
    // M on a focused chip that can be dragged opens "Move to…" — the same dialog and save path as
    // the List view's "Move…" button. Dragging was the ONLY way to reschedule on the grids, so the
    // keyboard (and a screen reader, via aria-keyshortcuts) had no way to do it there.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'm' && e.key !== 'M') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const chip = e.target && e.target.matches && e.target.matches('[data-cal-move]') ? e.target : null;
        if (!chip) return;
        const [kind, id] = chip.dataset.calMove.split(':');
        e.preventDefault();
        window._calMove(kind, Number(id));
    });
    // A click on the empty part of a future day starts a post for that day. Chips and buttons keep
    // their own clicks; past days are ignored (a post can't be suggested for yesterday). Keyboard
    // users have the toolbar's "New post", so cells stay out of the Tab order.
    document.addEventListener('click', (e) => {
        const cell = e.target && e.target.closest ? e.target.closest('#cal-main [data-date]') : null;
        if (!cell || e.target.closest('button, a, [role="button"], [draggable="true"]')) return;
        if (!_calCreateAssistantId()) return;
        const [y, m, d] = cell.dataset.date.split('-').map(Number);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        if (new Date(y, m - 1, d) < today) return;
        window._calNewPost(cell.dataset.date);
    });
    // Left/right between the List view's tabs. The list re-renders on a switch, so focus is put on
    // the new active tab by key afterwards.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const tab = e.target && e.target.closest ? e.target.closest('[data-cal-list-tab]') : null;
        if (!tab) return;
        const tabs = Array.from(tab.parentNode.querySelectorAll('[data-cal-list-tab]'));
        const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        e.preventDefault();
        const key = next.dataset.calListTab;
        window._calSetListFilter(key);
        document.querySelector(`[data-cal-list-tab="${key}"]`)?.focus();
    });
}

// ── Helpers ───────────────────────────────────────────────────────
// Returns GROUPS ({ members, rep, platforms }), not posts — a cross-posted post is one entry here
// however many platforms it fans out to. The status guard is the client half of the rule the server
// enforces in scheduled-posts.ts: it keeps a post that was just rejected or cancelled in the panel
// from lingering on the grid until the next reload.
function _postsOnDate(date) {
    const onDay = _onDay('posts', _posts, p => p.publishDate, p =>
        _scheduleActive(p.status) && _matchesAssistantFilter(p.assistantId)
        // Filtering by platform narrows a group to its matching sibling, so a cross-post shows as
        // that one platform rather than as "Multiple" the user then has to open to understand.
        && _matchesPlatformFilter(p.platform), date);
    return _groupPosts(onDay);
}

// Drafts waiting for review on their proposed day, grouped like posts. Same filters.
function _awaitingOnDate(date) {
    const onDay = _onDay('awaiting', _awaiting, p => p.publishDate, p =>
        _matchesAssistantFilter(p.assistantId) && _matchesPlatformFilter(p.platform), date);
    return _groupPosts(onDay);
}

// #3: completed assistant activity on a given day (respects the assistant filter).
function _activitiesOnDate(date) {
    return _onDay('acts', _activities, a => a.at, a => _matchesAssistantFilter(a.assistantId), date);
}

function _dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

// Blog posts bucketed to a day: published shows on publishedAt, scheduled on publishDate.
// Respects the assistant filter and the 'blog' platform filter (hidden when a social platform is picked).
function _blogPostsOnDate(date) {
    if (!_matchesPlatformFilter('blog')) return [];
    return _onDay('blogs', _blogPosts,
        p => (p.status === 'published' ? (p.publishedAt || p.publishDate) : p.publishDate),
        p => _matchesAssistantFilter(p.assistantId), date);
}

// Newsletter issues falling on a date. Mirrors _blogPostsOnDate: a SENT issue is plotted on the day
// it actually went out, everything else on the day it is due.
//
// ⚠️ `sending` reads its date from scheduledFor, not sentAt — sentAt is not stamped until the last
// recipient is done, and an issue spreading a local-time send over 24 hours would otherwise vanish
// from the calendar for the whole day it is being sent.
function _newsletterIssuesOnDate(date) {
    if (!_matchesPlatformFilter('newsletter')) return [];
    return _onDay('issues', _newsletterIssues,
        i => (i.status === 'sent' ? (i.sentAt || i.scheduledFor) : i.scheduledFor),
        i => _matchesAssistantFilter(i.assistantId), date);
}

// Read-only newsletter chip. Same treatment as the blog chip below and for the same reason: issues
// are managed in the Email Studio, so this is not draggable and does not open the social
// governance panel — clicking opens the Studio on that issue.
function _issueChip(issue) {
    const sm = STATUS_META[issue.status] || STATUS_META.draft;
    const sent = issue.status === 'sent';
    const when = sent ? (issue.sentAt || issue.scheduledFor) : issue.scheduledFor;
    const time = new Date(when).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const chipBg = sent ? 'bg-green-50' : 'bg-teal-50 hover:bg-teal-100';
    const timeColor = sent ? 'status-posted' : 'text-teal-700';
    // The recipient count is the one fact worth the space on a sent issue — it is the answer to
    // "did that go out, and to how many people".
    const marker = sent
        ? `<span class="status-posted-tick text-xs font-extrabold shrink-0" aria-hidden="true" title="Sent ${time}${issue.recipientCount ? ` to ${issue.recipientCount}` : ''}">✓</span>`
        : `<span class="w-1.5 h-1.5 rounded-full ${sm.dot} shrink-0" aria-hidden="true" title="${_statusLabel(issue.status)}"></span>`;
    const subject = issue.subject || 'Untitled email';
    return `<div role="button" tabindex="0" data-cal-activate
        onclick="window._calOpenIssue(${issue.id})"
        data-issue-id="${issue.id}"
        class="group focus-ring flex items-center gap-1.5 px-2 py-1 rounded-lg ${chipBg} shadow-sm cursor-pointer transition select-none text-left w-full"
        style="border-left:3px solid #0d9488"
        aria-label="${time} · Email · ${_escHtml(subject)} · ${_statusLabel(issue.status)}">
        ${_platAvatar('newsletter', 16)}
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold ${timeColor} truncate">${time}</p>
            <p class="text-[11px] text-gray-500 truncate leading-tight">${_escHtml(subject.substring(0, 40))}</p>
        </div>
        ${marker}
    </div>`;
}

// Open the clicked issue in the Email Studio. _newsletterInitialIssueId is the existing
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
    const failedBlog = post.status === 'failed';
    const chipBg = posted ? 'bg-green-50' : failedBlog ? 'bg-red-50 hover:bg-red-100' : 'bg-violet-50 hover:bg-violet-100';
    const timeColor = posted ? 'status-posted' : failedBlog ? 'text-red-700' : 'text-violet-700';
    const marker = posted
        ? `<span class="status-posted-tick text-xs font-extrabold shrink-0" aria-hidden="true" title="Posted ${time}">✓</span>`
        : failedBlog
        ? `<span class="w-3.5 h-3.5 rounded-full bg-red-600 text-white text-[10px] font-extrabold leading-none flex items-center justify-center shrink-0" aria-hidden="true">!</span>`
        : `<span class="w-1.5 h-1.5 rounded-full ${sm.dot} shrink-0" aria-hidden="true" title="${_statusLabel(post.status)}"></span>`;
    const title = post.title || 'Untitled';
    // A SCHEDULED blog is the only one that moves, and only on the grids. The calendar feed
    // (blog-posts.ts) returns 'scheduled', 'published' and 'failed' — written as the positive test,
    // which is why widening the feed to failed articles did not make them (or a LIVE one) draggable. The list view is excluded because only the
    // month and week grids carry drop targets; a draggable chip there could be picked up and never
    // put down. Dragging moves the DATE and keeps the time of day, exactly as a post chip does —
    // the time of day itself is changed in Blog Studio.
    const isDraggable = post.status === 'scheduled' && viewType !== 'list';
    // In the list view a scheduled article gets the "Move…" button instead of a drag.
    const movableInList = post.status === 'scheduled' && viewType === 'list';
    // With "Move…" inside it (the List view), the chip is a plain box over a _rowOpener, so the two
    // buttons are siblings rather than one nested in the other.
    const blogLabel = `${time} · Blog · ${title} · ${_statusLabel(post.status)}${failedBlog && post.failureReason ? ': ' + post.failureReason : ''}`;
    return `<div ${movableInList ? '' : 'role="button" tabindex="0" data-cal-activate'}
        ${movableInList ? '' : `onclick="window._calOpenBlog(${post.id})"`}
        ${isDraggable ? `draggable="true" ondragstart="window._calDragStart(event, { kind: 'blog', id: ${post.id} })" data-cal-move="blog:${post.id}" aria-keyshortcuts="M"` : ''}
        data-blog-id="${post.id}"
        ${isDraggable ? `data-cal-blog-id="${post.id}"` : ''}
        class="group ${movableInList ? 'relative flex-wrap' : 'focus-ring cursor-pointer'} flex items-center gap-1.5 px-2 py-1 rounded-lg ${chipBg} shadow-sm transition select-none text-left w-full"
        style="border-left:3px solid #7c3aed"
        ${movableInList ? '' : `aria-label="${_escHtml(blogLabel)}"`}
        ${failedBlog && post.failureReason ? `title="${_escHtml(post.failureReason)}"` : ''}>
        ${movableInList ? _rowOpener(`window._calOpenBlog(${post.id})`, blogLabel) : ''}
        ${_platAvatar('blog', 16)}
        <div class="flex-1 min-w-0">
            <p class="text-[11px] font-bold ${timeColor} truncate">${time}${failedBlog ? ` · ${_statusLabel('failed')}` : ''}</p>
            <p class="text-[11px] text-gray-500 truncate leading-tight">${_escHtml(title.substring(0, 40))}</p>
            ${failedBlog && post.failureReason && viewType === 'list' ? `<p class="text-xs text-red-700 truncate mt-0.5">${_escHtml(post.failureReason)}</p>` : ''}
        </div>
        ${marker}
        ${movableInList ? `<span class="w-full">${_moveButton('blog', post.id)}</span>` : ''}
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
    d.setDate(d.getDate() - _mondayIndex(d));   // back to Monday
    d.setHours(0,0,0,0);
    return d;
}

function _escHtml(str) {
    return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

})(); // end IIFE
