// notifications.js

// --- GLOBAL NOTIFICATION BADGE CONTROLLER ---
// Issue #156: tracks the previous badge count across polls so we can ding only when it
// *rises* (a new notification arrived) rather than on every poll or on the initial load.
let _lastNotifBadgeCount = null;

// ── One-time "focus the inbox" on login ───────────────────────────────────────
// On the first badge refresh after a successful login, count the bell up from 0 to the
// current unread total, retriggering the notification sound on each step, then settle on
// the real number. Runs once per login: verify-account.html sets bms_freshLogin before
// handing off to the workspace, and we consume it here (once), so reloads don't replay it.
let _freshLoginResolved = false;   // have we checked the flag yet this page load?
let _isFreshLogin = false;         // …and what did it say
let _inboxFocusAnimating = false;  // owns the badge while the count-up runs (polls stand off)
function _consumeFreshLoginFlag() {
    if (_freshLoginResolved) return _isFreshLogin;
    _freshLoginResolved = true;
    try {
        _isFreshLogin = sessionStorage.getItem('bms_freshLogin') === '1';
        if (_isFreshLogin) sessionStorage.removeItem('bms_freshLogin');
    } catch { _isFreshLogin = false; }
    return _isFreshLogin;
}
function _animateInboxFocus(badge, total) {
    return new Promise((resolve) => {
        if (!badge || total <= 0) return resolve();
        badge.textContent = '0';
        badge.classList.remove('hidden');
        // Pace the whole run to land around ~1.6s regardless of the total, clamped so a
        // small inbox still feels deliberate and a large one doesn't drag. Each step
        // restarts the short notification sound (same <audio> element), giving a rapid
        // "counting" chatter that ends on one clean final play at the total.
        const stepMs = Math.min(320, Math.max(80, Math.round(1600 / total)));
        let n = 0;
        const tick = () => {
            n += 1;
            badge.textContent = String(n);
            window._playNotificationSound?.();
            if (n >= total) return resolve();   // reached the total → no further steps or sound
            setTimeout(tick, stepMs);
        };
        setTimeout(tick, stepMs);
    });
}

window.updateNotificationBadge = async function() {
    try {
        const res = await fetch('/.netlify/functions/notifications?action=count');
        if (res.ok) {
            const data = await res.json();
            const badge = document.getElementById('sidebar-nav-badge');
            // Badge reflects open ACTION items + unread UPDATES. Falls back to the older
            // actionCount / unreadCount fields if the server hasn't been updated yet.
            const count = (typeof data.badgeCount === 'number') ? data.badgeCount
                : (typeof data.actionCount === 'number') ? data.actionCount
                : (data.unreadCount || 0);

            // The side-menu Inbox item mirrors the bell's count (same inbox, two entry points).
            const inboxNavBadge = document.getElementById('nav-inbox-badge');
            const setInboxNavBadge = (n) => {
                if (!inboxNavBadge) return;
                if (n > 0) { inboxNavBadge.textContent = n; inboxNavBadge.classList.remove('hidden'); }
                else inboxNavBadge.classList.add('hidden');
            };
            setInboxNavBadge(count);

            // First refresh after login: run the one-time inbox-focus count-up, then adopt
            // the count as the baseline so the normal rise-ding doesn't also fire for it.
            if (!_inboxFocusAnimating && _lastNotifBadgeCount === null && _consumeFreshLoginFlag() && count > 0) {
                _inboxFocusAnimating = true;
                // The count-up owns the login "sound moment" — silence the Aurora welcome chime
                // so it doesn't play over the counting notification sound. Only when that sound
                // is actually enabled: if notification sound is muted the count-up is silent, so
                // there's nothing to clash with and the welcome chime should still play.
                if (localStorage.getItem('bms_soundOnNotification') !== '0') window._suppressWelcomeSound?.();
                await _animateInboxFocus(badge, count);
                _inboxFocusAnimating = false;
                _lastNotifBadgeCount = count;
                return;
            }
            // A concurrent poll must not fight the running animation for the badge.
            if (_inboxFocusAnimating) return;

            if (badge) {
                if (count > 0) {
                    badge.textContent = count;
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }
            if (_lastNotifBadgeCount !== null && count > _lastNotifBadgeCount) {
                // Sound choice by the newly-arrived notification's type. The two "achievement"
                // moments — a milestone reached, or an assistant becoming ready to work
                // (provisioning_complete) — play the celebratory Aurora chime, gated by the
                // "sound on milestone" preference. Every other notification plays the softer
                // bubbling-water alert, gated by the "sound on notification" preference. Each
                // helper self-gates on its own preference (My Account → Sounds).
                const MILESTONE_TYPES = new Set(['milestone', 'milestone_unlock', 'roi_milestone', 'provisioning_complete']);
                if (MILESTONE_TYPES.has(data.latestType)) {
                    window._playMilestoneSound?.();
                } else {
                    window._playNotificationSound?.();
                }
                // Something new arrived. Any view showing derived lists (the Assistant Detail
                // Review Queue, the workspace queue) was rendered before it existed and is now
                // stale — telling the user "your assistant drafted 3 posts" and then showing them
                // an unchanged, empty Review tab is the worst of both. Broadcast so open views can
                // re-read themselves; listeners are responsible for being cheap and idempotent.
                document.dispatchEvent(new CustomEvent('bms:notifications-arrived', {
                    detail: { count, previous: _lastNotifBadgeCount, latestType: data.latestType },
                }));
            }
            _lastNotifBadgeCount = count;
        }
    } catch (e) {
        console.error("Failed to fetch notification badge count", e);
    }
};


// ── NotifKit — shared, stateless notification logic ───────────────────────────
// Lifted from initNotifications so BOTH the full inbox page AND the header Action
// Center popover build cards from ONE source of truth (classification, type->CTA
// mapping, category styling, actor identity). Everything here depends only on
// window.*/document — never on page-local state — so it is safe at module scope.
window.NotifKit = (function () {
    // Navigate to Invoice History inside the workspace shell (billing is a VIEW fragment).
    // Falls back to a deep-link if loadView isn't available (e.g. viewed outside the workspace).
    const routeToBilling = () => {
        if (typeof window.loadView === 'function') {
            Promise.resolve(window.loadView('billing')).then(() => {
                document.getElementById('invoice-history-section')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        } else {
            window.location.href = 'workspace.html?view=billing';
        }
    };

    // Resolve a notification's "click for more information" destination, if any.
    // Returns { label, run } for actionable notifications, or null for passive ones.
    // The label drives the visible affordance so users can tell which rows go somewhere.
    const go = (view) => () => window.loadView?.(view);

    // The new onboarding lives in the Setup Wizard slide-over (window.SetupWizard).
    // Fall back to the legacy getting-started checklist if the wizard isn't mounted.
    const openWizard = () => {
        if (window.SetupWizard && typeof window.SetupWizard.open === 'function') window.SetupWizard.open();
        else window.loadView?.('getting-started');
    };

    // type → primary call-to-action. Action-kind types should all resolve to a CTA so
    // every action card has one clear next step; info types are mostly passive.
    const ACTIONS_BY_TYPE = {
        invoice_ready:                 { label: 'View invoice',        run: routeToBilling },
        ticket_created:                { label: 'View ticket',         run: () => window.routeToSupportTicket?.() },
        ticket_reply:                  { label: 'View ticket',         run: () => window.routeToSupportTicket?.() },
        onboarding_prompt:             { label: 'Open Setup Wizard',   run: openWizard },
        onboarding_incomplete:         { label: 'Resume setup',        run: openWizard },
        welcome:                       { label: 'Get started',         run: openWizard },
        setup_complete:                { label: 'Go to dashboard',     run: go('dashboard') },
        // Approvals — folds the review queue into the action surface.
        hitl_approval_required:        { label: 'Review post',         run: go('review-queue') },
        review_red_urgency:            { label: 'Review post',         run: go('review-queue') },
        // Billing / plan actions.
        billing_payment_failed:        { label: 'Update payment',      run: routeToBilling },
        missing_stripe_sub:            { label: 'Go to billing',       run: routeToBilling },
        stripe_cancelled_but_db_active:{ label: 'Go to billing',       run: routeToBilling },
        tier_mismatch:                 { label: 'Go to billing',       run: routeToBilling },
        subscription_paused:           { label: 'Go to billing',       run: routeToBilling },
        assistants_paused_downgrade:   { label: 'Go to billing',       run: routeToBilling },
        task_limit_warning:            { label: 'Upgrade plan',        run: routeToBilling },
        task_limit_reached:            { label: 'Upgrade plan',        run: routeToBilling },
        run_cost_warning:              { label: 'Review usage',        run: routeToBilling },
        run_budget_suspended:          { label: 'Review usage',        run: routeToBilling },
        // Connection actions. Connections live in each assistant's Connections tab now,
        // so route to the assistants list where the user opens the relevant assistant.
        social_oauth_revoked:          { label: 'Reconnect',           run: go('assistants') },
        instagram_token_refresh_failed:{ label: 'Reconnect',           run: go('assistants') },
        integration_alert:             { label: 'Reconnect',           run: go('assistants') },
        // Content actions.
        post_publish_failed:           { label: 'View content',        run: go('my-content') },
        post_missed:                   { label: 'View content',        run: go('my-content') },
        post_generation_failed:        { label: 'View content',        run: go('my-content') },
        // AI media generation complete (image/video added to My Content). State-change /
        // celebratory info item, but still carries a "View content" deep link so the user
        // can jump straight to the asset (notifications.js renders the CTA on info rows too).
        media_ready:                   { label: 'View content',        run: go('my-content') },
    };

    const getNotificationAction = (notif) => {
        const meta = notif.metadata || {};
        // US2 AC2.3: a workspace owner invites the person who hit a connection collision.
        // If the owner's plan has no free seat, the server already flagged this in metadata —
        // point them at billing instead of an invite that would just fail on seat limit.
        if (notif.type === 'workspace_access_request') {
            if (meta.seatLimitReached) return { label: 'Upgrade plan', run: routeToBilling };
            return { label: 'Invite User', run: () => window._inviteFromAccessRequest?.(meta.requestingEmail, notif.id) };
        }
        // AI media ready — deep-link straight to the generated asset in My Content.
        if (notif.type === 'media_ready') {
            return { label: 'View content', run: () => window.loadView?.('my-content', meta.assetId ? { assetId: meta.assetId } : null) };
        }
        // Issue #191 — archived assistant: deep-link straight to its detail page, where the
        // reinstate banner (and 14-day deletion countdown) lives.
        if (notif.type === 'assistant_archived' && meta.assistantId) {
            return { label: 'View & Reinstate', run: () => window.routeToAssistantDetail?.(meta.assistantId) };
        }
        // Draft post ready to review (incl. the media-needed/out-of-credits variant of ai_review) —
        // deep-link straight to that post's review modal instead of dropping the user on the
        // queue list to hunt for it.
        // A post that failed to publish — deep-link to the post itself in its assistant's Content
        // Library, where the row opens with the failure reason and the re-queue actions. Needs the
        // assistant to route to; without it there's no page that can show the single post, so fall
        // through to the generic "View content" CTA below.
        if (notif.type === 'post_publish_failed' && meta.postId && meta.assistantId) {
            return { label: 'View failed post', run: () => {
                window._assistantDetailInitialTab = 'datahub';
                window._assistantDetailFocusPostId = meta.postId;
                window.routeToAssistantDetail?.(meta.assistantId);
            } };
        }
        // A campaign decision lives in the Campaign Assistant's Review Queue tab ("Decisions"), not
        // on any global page — there is no route that can show it otherwise. Without this the
        // generic action fallback at the bottom drops the user on the dashboard to go and find it,
        // which for a card that expires in as little as two days is most of the way to not
        // notifying them at all.
        if (notif.type === 'campaign_decision_pending' && meta.assistantId) {
            return { label: 'Review decision', run: () => {
                window._assistantDetailInitialTab = 'review-queue';
                window.routeToAssistantDetail?.(meta.assistantId);
            } };
        }
        // A prospect replied. The reply lives on ONE screen — its assistant's Conversations tab —
        // and no global page can show it, so without this the generic fallback below drops the user
        // on the dashboard to go and find the warmest lead they have. Opens the thread directly
        // where we know which one it was.
        if (notif.type === 'lead_reply_received' && meta.assistantId) {
            return { label: 'Read the reply', run: () => {
                window._assistantDetailInitialTab = 'conversations';
                if (meta.threadId) window._assistantDetailFocusThreadId = meta.threadId;
                window.routeToAssistantDetail?.(meta.assistantId);
            } };
        }
        // Leads about to lapse off the retention clock — the Outreach tab is where the decision is
        // made, so send them there rather than to the Enrichment table they will end up in.
        if (notif.type === 'leads_expiring_soon' && meta.assistantId) {
            return { label: 'Review leads', run: () => {
                window._assistantDetailInitialTab = 'review-queue';
                window.routeToAssistantDetail?.(meta.assistantId);
            } };
        }
        // A company excluded from every search because someone erased a prospect we held no address
        // for. An UPDATE item, so it would render button-less by default — but its own message ends
        // "you can undo this in the search's own settings", and those live on exactly one screen:
        // the Searches tab, whose campaign editor owns the excluded-domains field. A card that names
        // a consequence and offers no way to inspect it is how a wrong block goes uncorrected.
        if (notif.type === 'lead_company_blocked' && meta.assistantId) {
            return { label: 'Open your searches', run: () => {
                window._assistantDetailInitialTab = 'signals';
                window.routeToAssistantDetail?.(meta.assistantId);
            } };
        }
        if ((notif.type === 'post_draft_ready' || notif.type === 'ai_review') && meta.postId) {
            return { label: 'Review draft', run: () => window.loadView?.('review-queue', { postId: meta.postId }) };
        }
        // Issue #87 — issue status updates need a link back to the reported issue itself,
        // not just a passive FYI. Opens the "Report an Issue" modal on the specific issue.
        if (notif.type === 'issue_update') {
            return { label: 'View issue', run: () => window.routeToIssueReport?.(meta.issueId) };
        }
        if (meta.action === 'view_invoices') return ACTIONS_BY_TYPE.invoice_ready;
        if (meta.action === 'view_ticket')   return ACTIONS_BY_TYPE.ticket_created;
        if (meta.action === 'open_wizard')   return { label: meta.ctaLabel || 'Open Setup Wizard', run: openWizard };
        if (meta.action === 'getting_started') return ACTIONS_BY_TYPE.onboarding_prompt;
        if (ACTIONS_BY_TYPE[notif.type]) return ACTIONS_BY_TYPE[notif.type];
        // Any remaining action-kind item still needs a way in — default to the dashboard.
        if (notif.kind === 'action') return { label: 'Review', run: go('dashboard') };
        return null;
    };

    // Urgent action types get a red accent (vs the default emerald) so the most
    // pressing items read as pressing.
    const URGENT_TYPES = new Set([
        'billing_payment_failed', 'run_budget_suspended',
        'post_publish_failed', 'post_missed', 'post_generation_failed',
        'security', 'agent_anomaly', 'social_oauth_revoked', 'instagram_token_refresh_failed',
        'task_limit_reached', 'subscription_paused', 'assistants_paused_downgrade',
    ]);

    // Client fallback if the server response predates kind annotation.
    const ACTION_TYPES_FALLBACK = new Set([
        'onboarding_prompt', 'onboarding_incomplete', 'hitl_approval_required', 'review_red_urgency',
        'billing_payment_failed', 'missing_stripe_sub', 'stripe_cancelled_but_db_active', 'tier_mismatch',
        'subscription_paused', 'assistants_paused_downgrade', 'social_oauth_revoked',
        'instagram_token_refresh_failed', 'integration_alert', 'post_publish_failed', 'post_missed',
        'post_generation_failed', 'task_limit_reached',
        'task_limit_warning', 'run_budget_suspended', 'run_cost_warning', 'security', 'agent_anomaly',
        'risk_assessment_submitted',
    ]);
    const kindOf = (n) => n.kind || (ACTION_TYPES_FALLBACK.has(n.type) ? 'action' : 'info');

    // ── Category model (mirrors src/utils/notification-actions.ts) ─────────────
    // The server annotates each notification with category/priority/isDismissible/
    // resolvesOnClick; these fallbacks keep the UI sane for older/partial responses.
    const PRIORITY_BY_CATEGORY = { critical_action: 1, suggested_action: 2, state_change: 3, celebratory: 3, informational: 4 };
    const COMPLETION_RESOLVED_FALLBACK = new Set([
        'onboarding_prompt', 'onboarding_incomplete',
        'billing_payment_failed', 'missing_stripe_sub', 'stripe_cancelled_but_db_active', 'subscription_paused',
        'tier_mismatch', 'assistants_paused_downgrade',
        'task_limit_reached', 'task_limit_warning',
        'social_oauth_revoked', 'instagram_token_refresh_failed', 'integration_alert',
        // Issue #191 follow-up: mirrors src/utils/notification-actions.ts's COMPLETION_RESOLVED_TYPES —
        // reinstating is a separate action, so viewing the notification must not resolve it.
        'assistant_archived',
    ]);
    const catOf = (n) => n.category || (kindOf(n) === 'action' ? (URGENT_TYPES.has(n.type) ? 'critical_action' : 'suggested_action') : 'informational');
    const prioOf = (n) => (typeof n.priority === 'number' ? n.priority : PRIORITY_BY_CATEGORY[catOf(n)] ?? 4);
    // resolvedAt is the true "closed" signal — NOT isRead. "Done" shows only when resolved.
    const isResolved = (n) => !!n.resolvedAt;
    // Clicking the CTA closes the item only when no completion hook exists; completion-driven
    // types (onboarding/billing/connection) just navigate and stay open until truly resolved.
    const resolvesClick = (n) => (typeof n.resolvesOnClick === 'boolean')
        ? n.resolvesOnClick
        : (kindOf(n) === 'action' && !COMPLETION_RESOLVED_FALLBACK.has(n.type));

    // AC1.3: category-driven border + icon. Icons use currentColor so the avatar ring's text-* wins.
    const ICON = {
        warning: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>`,
        action:  `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>`,
        check:   `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
        info:    `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>`,
        trophy:  `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>`,
    };
    const CATEGORY_STYLE = {
        critical_action: { ring: 'bg-red-50 text-red-600 border-red-100',       cta: 'bg-red-600 hover:bg-red-700',         icon: ICON.warning },
        suggested_action:{ ring: 'bg-emerald-50 text-emerald-700 border-emerald-100', cta: 'bg-emerald-600 hover:bg-emerald-700', icon: ICON.action },
        state_change:    { ring: 'bg-green-50 text-green-700 border-green-100',  cta: 'bg-emerald-600 hover:bg-emerald-700', icon: ICON.check },
        informational:   { ring: 'bg-gray-100 text-gray-500 border-gray-200',    cta: 'bg-emerald-600 hover:bg-emerald-700', icon: ICON.info },
        celebratory:     { ring: 'bg-amber-50 text-amber-600 border-amber-100',  cta: 'bg-emerald-600 hover:bg-emerald-700', icon: ICON.trophy, celebrate: true },
    };
    const styleOf = (n) => CATEGORY_STYLE[catOf(n)] || CATEGORY_STYLE.informational;

    // AC3.2/3.3: dismissible unless the server says otherwise; critical_action is never dismissible.
    const isDismissible = (n) => (typeof n.isDismissible === 'boolean') ? n.isDismissible : (catOf(n) !== 'critical_action');
    // The "X" close affordance — rendered only when the item is dismissible.
    const dismissBtnHTML = (n) => isDismissible(n)
        ? `<button type="button" class="dismiss-btn shrink-0 self-start text-gray-300 hover:text-gray-600 transition" title="Dismiss" aria-label="Dismiss notification">
               <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
           </button>`
        : '';

    // Celebratory animated gradient border (AC1.3). Injected once; style.css is prebuilt so
    // arbitrary Tailwind classes won't compile — a plain <style> tag is the reliable route.
    if (!document.getElementById('notif-celebrate-style')) {
        const s = document.createElement('style');
        s.id = 'notif-celebrate-style';
        s.textContent = '@keyframes notifCelebrate{0%{background-position:0% 50%}100%{background-position:200% 50%}}'
            + '.notif-celebrate{border:2px solid transparent;border-radius:0.75rem;'
            + 'background:linear-gradient(#fff,#fff) padding-box,linear-gradient(90deg,#fbbf24,#34d399,#60a5fa,#fbbf24) border-box;'
            + 'background-size:200% 100%;animation:notifCelebrate 4s linear infinite}';
        document.head.appendChild(s);
    }

    const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    // Human-readable label for a notif.type, e.g. "billing_payment_failed" -> "Billing Payment Failed".
    const typeLabel = (type) => (type || 'other').split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    // ── Actor identity (who is asking) ─────────────────────────────────────────
    // Every card leads with its actor: the assistant that produced it (avatar = coloured
    // initial + name), or the BMS system (semantic category icon + "Be More Swan"). The
    // server attaches notif.actor = { assistantId, name, jobRole } | null. The palette mirrors
    // calendar.js so an assistant reads the same colour across the app; colour is derived from
    // the id (stable, load-order-independent) rather than stored per assistant.
    const ASSISTANT_PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#3b82f6'];
    const actorColor = (id) => (id == null ? '#9ca3af' : ASSISTANT_PALETTE[Math.abs(Number(id)) % ASSISTANT_PALETTE.length]);
    const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // Allow-list sanitiser for stored notification title/message before they hit innerHTML.
    // Notification copy is authored server-side as: admin template markup + HTML-ESCAPED user
    // values (see src/utils/notify.ts). We must NOT re-escape here (that would double-escape a
    // value like "Acme &amp; Co"); instead we parse into an inert <template>, drop any element
    // that isn't on the small formatting allow-list (replacing it with its text — this also
    // neutralises <script>/<img onerror>), strip ALL attributes from the survivors (kills
    // on*=/href/src vectors), and re-serialise. Legacy rows written before notify.ts existed
    // carried RAW user values; the same parse+strip makes those safe too.
    const SANITIZE_ALLOWED = new Set(['B', 'STRONG', 'EM', 'I', 'U', 'BR', 'SPAN']);
    const sanitizeText = (s) => {
        const tpl = document.createElement('template');
        tpl.innerHTML = String(s ?? '');
        const walk = (node) => {
            for (const child of Array.from(node.childNodes)) {
                if (child.nodeType !== 1) continue; // keep text/entities as-is
                if (!SANITIZE_ALLOWED.has(child.tagName)) {
                    child.replaceWith(document.createTextNode(child.textContent || ''));
                } else {
                    for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name);
                    walk(child);
                }
            }
        };
        walk(tpl.content);
        return tpl.innerHTML;
    };
    const actorInitial = (name) => (escHtml(name).trim().charAt(0) || '?').toUpperCase();
    // Assistant → coloured initial avatar; system → the category-semantic icon (unchanged).
    const avatarHTML = (notif, st) => {
        const a = notif.actor;
        if (a && a.name) {
            const color = actorColor(a.assistantId);
            return `<div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-white text-sm font-bold" style="background:${color}" title="${escHtml(a.name)}">${actorInitial(a.name)}</div>`;
        }
        return `<div class="w-10 h-10 rounded-full ${st.ring} border flex items-center justify-center shrink-0">${st.icon}</div>`;
    };
    // The eyebrow line above the title — assistant name in its accent colour, or "Be More Swan".
    const actorEyebrowHTML = (notif) => {
        const a = notif.actor;
        if (a && a.name) {
            return `<p class="text-xs font-bold mb-0.5 truncate" style="color:${actorColor(a.assistantId)}">${escHtml(a.name)}</p>`;
        }
        return `<p class="text-xs font-bold mb-0.5 text-gray-400">Be More Swan</p>`;
    };

    return {
        getNotificationAction, styleOf, catOf, prioOf, isResolved, resolvesClick,
        isDismissible, dismissBtnHTML, kindOf, fmtDate, typeLabel,
        avatarHTML, actorEyebrowHTML, actorColor, actorInitial, escHtml, sanitizeText,
    };
})();

window.initNotifications = async function() {
    const listEl = document.getElementById('notif-list');
    const loadingEl = document.getElementById('notif-loading');
    const emptyStateEl = document.getElementById('notif-empty-state');
    const searchInput = document.getElementById('notif-search');
    const markAllBtn = document.getElementById('btn-mark-all-read');
    const groupByTypeToggle = document.getElementById('notif-group-by-type');

    if (!listEl) return;

    // Clear badge logic when entering the notifications page
    if (typeof window.updateNotificationBadge === 'function') {
        window.updateNotificationBadge();
    }

    let notificationsData = [];

    // Shared classification + rendering helpers (single source of truth — see window.NotifKit).
    const {
        getNotificationAction, styleOf, catOf, prioOf, isResolved, resolvesClick,
        dismissBtnHTML, kindOf, fmtDate, typeLabel, avatarHTML, actorEyebrowHTML, sanitizeText,
    } = window.NotifKit;
    let activeTab = 'action';
    let groupByType = false;
    // Persists across re-renders so a group stays collapsed while notifications update/resolve.
    const collapsedGroups = new Set();

    const tabActionBtn = document.getElementById('tab-action');
    const tabUpdatesBtn = document.getElementById('tab-updates');
    const tabActionCount = document.getElementById('tab-action-count');
    const tabUpdatesCount = document.getElementById('tab-updates-count');

    const setTabStyles = () => {
        const active = 'flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800';
        const inactive = 'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-transparent text-gray-500 hover:text-gray-700';
        if (tabActionBtn) tabActionBtn.className = activeTab === 'action' ? active : inactive;
        if (tabUpdatesBtn) tabUpdatesBtn.className = activeTab === 'updates' ? active : inactive;
    };

    const loadData = async () => {
        try {
            const response = await fetch('/.netlify/functions/notifications');
            if (response.ok) {
                const data = await response.json();
                notificationsData = data.notifications || [];
                // Open the tab that has something waiting: unresolved actions first, else updates.
                activeTab = notificationsData.some(n => kindOf(n) === 'action' && !isResolved(n)) ? 'action' : 'updates';
                renderList();
                // A plan change happened in-session → refresh the header plan pill (force re-fetch).
                if (notificationsData.some(n => n.type === 'plan_upgraded' || n.type === 'plan_activated')
                    && typeof window.refreshPlanPill === 'function') {
                    window.refreshPlanPill(true);
                }
            }
        } catch (error) {
            console.error('Failed to load notifications:', error);
            if (loadingEl) loadingEl.textContent = "Failed to load notifications. Please try again.";
        }
    };

    // ACTION card: a bounded card with one clear CTA. "Done" appears only when the item is
    // truly resolved (resolvedAt) — never from a click. Reading just mutes it.
    const renderActionItem = (notif) => {
        const action = getNotificationAction(notif) || { label: 'Review', run: () => window.loadView?.('dashboard') };
        const st = styleOf(notif);
        const critical = catOf(notif) === 'critical_action';
        const resolved = isResolved(notif);
        const seen = notif.isRead && !resolved; // clicked/seen but not yet completed
        const li = document.createElement('li');
        li.className = `flex items-center gap-3 p-4 ${resolved ? 'opacity-60' : (seen ? 'opacity-90' : '')}`;
        li.innerHTML = `
            ${avatarHTML(notif, st)}
            <div class="flex-1 min-w-0">
                ${actorEyebrowHTML(notif)}
                <div class="flex items-center gap-2">
                    <p class="text-sm ${seen ? 'font-semibold text-gray-700' : 'font-bold text-gray-900'}">${sanitizeText(notif.title)}</p>
                    ${critical && !resolved ? '<span class="text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">Urgent</span>' : ''}
                    ${resolved ? '<span class="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">Done</span>' : ''}
                </div>
                ${notif.message ? `<p class="text-sm text-gray-500 mt-0.5 line-clamp-2">${sanitizeText(notif.message)}</p>` : ''}
                <p class="text-xs text-gray-400 mt-1">${fmtDate(notif.createdAt)}</p>
            </div>
            ${resolved ? '' : `<button type="button" class="action-cta px-4 py-2 ${st.cta} text-white text-sm font-bold rounded-lg transition shrink-0 whitespace-nowrap">${action.label}</button>`}
            ${resolved ? '' : `<button type="button" class="action-toggle-read shrink-0 text-xs font-semibold px-2.5 py-1 rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 whitespace-nowrap">${notif.isRead ? 'Mark as unread' : 'Mark as read'}</button>`}
            ${dismissBtnHTML(notif)}
        `;
        li.querySelector('.action-cta')?.addEventListener('click', (e) => {
            e.stopPropagation();
            // Completion-driven items just navigate + mark seen; the rest close on click.
            if (resolvesClick(notif)) setResolved(notif.id);
            else setRead(notif.id, true);
            action.run();
        });
        // Mute-only acknowledge: marking an action read greys it but keeps it in the tab — the row
        // stays open (and still counted) until it's truly resolved. Mirrors the Updates read toggle
        // so an item you can't action right now can still be quietened. resolvedAt is untouched.
        li.querySelector('.action-toggle-read')?.addEventListener('click', (e) => {
            e.stopPropagation();
            setRead(notif.id, !notif.isRead);
        });
        li.querySelector('.dismiss-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            dismiss(notif.id);
        });
        return li;
    };

    // UPDATE row: informational, read/unread. Some info items still carry a useful link
    // (e.g. invoice_ready → "View invoice", ticket_reply → "View ticket") — those keep a
    // visible CTA even though they live in Updates. Read state is toggled with an explicit
    // button so it's obvious (no more "click the row and hope").
    const renderUpdateItem = (notif) => {
        const li = document.createElement('li');
        const action = getNotificationAction(notif); // null for purely passive updates
        const st = styleOf(notif);
        const bgClass = notif.isRead ? 'bg-white hover:bg-gray-50' : 'bg-emerald-50/30 hover:bg-emerald-50/50';
        const textClass = notif.isRead ? 'text-gray-600 font-normal' : 'text-gray-900 font-bold';
        const dot = notif.isRead ? '' : `<div class="w-2.5 h-2.5 rounded-full bg-emerald-600 shrink-0 mt-1.5"></div>`;
        // Celebratory items get the animated gradient border (AC1.3).
        li.className = `group p-5 transition-colors flex gap-4 ${st.celebrate ? 'notif-celebrate' : bgClass}`;
        li.innerHTML = `
            ${dot}
            ${avatarHTML(notif, st)}
            <div class="flex-1 min-w-0">
                ${actorEyebrowHTML(notif)}
                <p class="text-sm ${textClass}">${sanitizeText(notif.title)}</p>
                ${notif.message ? `<p class="text-sm text-gray-500 mt-1 line-clamp-4">${sanitizeText(notif.message)}</p>` : ''}
                <p class="text-xs text-gray-400 mt-2">${fmtDate(notif.createdAt)}</p>
                ${action ? `<button type="button" class="update-cta mt-2 inline-flex items-center gap-1 text-sm font-bold text-emerald-700 hover:text-emerald-800">${action.label}<span aria-hidden="true">&rarr;</span></button>` : ''}
            </div>
            <button type="button" class="update-toggle-read shrink-0 self-start text-xs font-semibold px-2.5 py-1 rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 whitespace-nowrap">
                ${notif.isRead ? 'Mark as unread' : 'Mark as read'}
            </button>
            ${dismissBtnHTML(notif)}
        `;
        // Actionable updates (invoice, ticket) keep their link — navigate, and mark read since acting implies seen.
        li.querySelector('.update-cta')?.addEventListener('click', (e) => {
            e.stopPropagation();
            setRead(notif.id, true);
            action.run();
        });
        // Explicit read/unread toggle.
        li.querySelector('.update-toggle-read').addEventListener('click', (e) => {
            e.stopPropagation();
            setRead(notif.id, !notif.isRead);
        });
        li.querySelector('.dismiss-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            dismiss(notif.id);
        });
        return li;
    };

    const renderList = () => {
        const searchTerm = (searchInput?.value || '').toLowerCase();
        const matchesSearch = (n) => n.title.toLowerCase().includes(searchTerm) || (n.message && n.message.toLowerCase().includes(searchTerm));

        const actions = notificationsData.filter(n => kindOf(n) === 'action');
        const updates = notificationsData.filter(n => kindOf(n) === 'info');
        // Count = UNREAD, unresolved actions. Marking an action read (mute) drops it from the count
        // but keeps it in the list (greyed) until it's truly resolved — read controls the number, the
        // resolvedAt flag controls list membership. Resolved items are auto-read, so they never count.
        const openActions = actions.filter(n => !isResolved(n) && !n.isRead).length;
        // Updates are cleared by reading, so their badge counts unread items (mirrors the action badge).
        const unreadUpdates = updates.filter(n => !n.isRead).length;

        if (tabActionCount) {
            tabActionCount.textContent = openActions;
            tabActionCount.classList.toggle('hidden', openActions === 0);
        }
        if (tabUpdatesCount) {
            tabUpdatesCount.textContent = unreadUpdates;
            tabUpdatesCount.classList.toggle('hidden', unreadUpdates === 0);
        }
        setTabStyles();

        // Mark-all-read acts on whichever tab is open: it clears the unread items in that tab. The
        // button stays visible but is disabled + greyed when the current tab has nothing unread, so
        // its state always reflects "is there anything here to mark read?".
        if (markAllBtn) {
            const currentUnread = activeTab === 'action'
                ? actions.filter(n => !isResolved(n) && !n.isRead).length
                : updates.filter(n => !n.isRead).length;
            markAllBtn.disabled = currentUnread === 0;
            markAllBtn.style.opacity = currentUnread === 0 ? '0.5' : '';
            markAllBtn.style.cursor = currentUnread === 0 ? 'not-allowed' : '';
        }

        let list = (activeTab === 'action' ? actions : updates).filter(matchesSearch).slice();
        // id as tiebreaker: rows can share an identical createdAt (e.g. created in the same
        // DB transaction), so date alone doesn't reliably keep the newest item first.
        const byCreated = (a, b) => new Date(b.createdAt) - new Date(a.createdAt) || (b.id - a.id);
        if (activeTab === 'action') {
            // AC2.2/AC2.3: sort by priority weight, then newest first. Unresolved items stay
            // above resolved ones, so critical_action (priority 1) is pinned to the very top
            // until its completion criteria are met — this tab is about urgency, not recency.
            list.sort((a, b) => (isResolved(a) ? 1 : 0) - (isResolved(b) ? 1 : 0) || prioOf(a) - prioOf(b) || byCreated(a, b));
        } else {
            // Updates has no urgency tiers worth burying recency for — the newest update should
            // always be first, regardless of category (informational vs state_change etc.).
            list.sort(byCreated);
        }

        listEl.innerHTML = '';
        if (list.length === 0) {
            if (emptyStateEl) {
                emptyStateEl.classList.remove('hidden');
                const title = emptyStateEl.querySelector('[data-empty-title]');
                const sub = emptyStateEl.querySelector('[data-empty-sub]');
                if (title) title.textContent = activeTab === 'action' ? "You're all caught up" : 'No updates';
                if (sub) sub.textContent = activeTab === 'action' ? 'Nothing needs your attention right now.' : "We'll let you know when something happens.";
            }
            return;
        }
        if (emptyStateEl) emptyStateEl.classList.add('hidden');

        const renderItem = (notif) => activeTab === 'action' ? renderActionItem(notif) : renderUpdateItem(notif);

        if (!groupByType) {
            list.forEach(notif => listEl.appendChild(renderItem(notif)));
            return;
        }

        // Group by type, preserving the existing sort order both across and within groups.
        const groups = new Map();
        list.forEach(notif => {
            const key = notif.type || 'other';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(notif);
        });
        groups.forEach((items, type) => {
            const isCollapsed = collapsedGroups.has(type);
            const header = document.createElement('li');
            header.className = 'px-4 pt-4 pb-1 bg-gray-50 text-xs font-bold text-gray-500 uppercase tracking-wide flex items-center justify-between cursor-pointer select-none hover:bg-gray-100 transition-colors';
            header.setAttribute('role', 'button');
            header.setAttribute('tabindex', '0');
            header.setAttribute('aria-expanded', String(!isCollapsed));
            header.innerHTML = `
                <span>${typeLabel(type)} (${items.length})</span>
                <svg class="w-4 h-4 text-gray-400 transition-transform ${isCollapsed ? '' : 'rotate-180'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                </svg>`;
            const toggle = () => {
                if (collapsedGroups.has(type)) collapsedGroups.delete(type); else collapsedGroups.add(type);
                renderList();
            };
            header.addEventListener('click', toggle);
            header.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
            });
            listEl.appendChild(header);
            if (!isCollapsed) items.forEach(notif => listEl.appendChild(renderItem(notif)));
        });
    };

    const setRead = async (id, isRead) => {
        const notif = notificationsData.find(n => n.id === id);
        if (!notif || notif.isRead === isRead) return;

        notif.isRead = isRead;
        renderList();

        fetch('/.netlify/functions/notifications', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notificationId: id, isRead })
        }).then(() => {
            if (typeof window.updateNotificationBadge === 'function') window.updateNotificationBadge();
        }).catch(err => console.error("Sync failed:", err));
    };

    // Resolve = mark truly Done (sets resolvedAt server-side). Used for action items that have
    // no completion hook, so clicking the CTA is what closes them.
    const setResolved = async (id) => {
        const notif = notificationsData.find(n => n.id === id);
        if (!notif || notif.resolvedAt) return;

        notif.resolvedAt = new Date().toISOString();
        notif.isRead = true;
        renderList();

        fetch('/.netlify/functions/notifications', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notificationId: id, resolved: true })
        }).then(() => {
            if (typeof window.updateNotificationBadge === 'function') window.updateNotificationBadge();
        }).catch(err => console.error("Sync failed:", err));
    };

    // Dismiss = user hides the notification (US3). Optimistically removes it; the server rejects
    // (403) attempts to dismiss non-dismissible items, in which case we restore it.
    const dismiss = async (id) => {
        const idx = notificationsData.findIndex(n => n.id === id);
        if (idx === -1) return;
        const [removed] = notificationsData.splice(idx, 1);
        renderList();

        fetch('/.netlify/functions/notifications', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notificationId: id, dismiss: true })
        }).then((res) => {
            if (!res.ok) { notificationsData.splice(idx, 0, removed); renderList(); return; }
            if (typeof window.updateNotificationBadge === 'function') window.updateNotificationBadge();
        }).catch(err => {
            console.error("Dismiss failed:", err);
            notificationsData.splice(idx, 0, removed); renderList();
        });
    };

    if (markAllBtn) {
        markAllBtn.addEventListener('click', () => {
            if (markAllBtn.disabled) return;
            // Scope to the open tab: mute all unread actions (read, not resolved) on the Action tab, or
            // clear all unread updates on the Updates tab. We send the exact ids so the other tab's
            // unread state is left untouched.
            const isAction = activeTab === 'action';
            const targets = notificationsData.filter(n =>
                !n.isRead && (isAction ? (kindOf(n) === 'action' && !isResolved(n)) : kindOf(n) === 'info'));
            if (!targets.length) return;
            const ids = targets.map(n => n.id);
            targets.forEach(n => n.isRead = true);
            renderList();
            fetch('/.netlify/functions/notifications', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids }),
            }).then(() => { if (typeof window.updateNotificationBadge === 'function') window.updateNotificationBadge(); })
              .catch(err => console.error("Bulk sync failed:", err));
        });
    }

    if (tabActionBtn) tabActionBtn.addEventListener('click', () => { activeTab = 'action'; renderList(); });
    if (tabUpdatesBtn) tabUpdatesBtn.addEventListener('click', () => { activeTab = 'updates'; renderList(); });
    if (searchInput) searchInput.addEventListener('input', renderList);
    if (groupByTypeToggle) groupByTypeToggle.addEventListener('change', () => { groupByType = groupByTypeToggle.checked; renderList(); });

    loadData();
};

// Global click handler for routing to the Support area
window.routeToSupportTicket = function() {
    loadView('help');
    setTimeout(() => {
        const ticketTab = document.getElementById('tab-btn-tickets');
        if (ticketTab) ticketTab.click();
    }, 100);
};

// ── Header Action Center popover ──────────────────────────────────────────────
// Quick triage from the workspace bell: two tabs (Action required / Updates), compact
// actor-led cards built from the SAME window.NotifKit as the full inbox page, a single
// primary CTA per item, and "Open inbox" for batch processing. Opening the popover marks
// nothing read/resolved — acting on an item does. Kept deliberately small: no search,
// grouping or read-toggle here — those live on the full page.
window.NotificationPopover = (function () {
    const K = window.NotifKit;
    const MAX_PER_TAB = 5;        // cap the popover; overflow lives behind "Open inbox".
    let panel = null, listEl = null, tabActionBtn = null, tabUpdatesBtn = null, markAllBtn = null;
    let anchorEl = null, activeTab = 'action', data = [];

    const openInbox = () => { close(); (window.loadView ? window.loadView('notifications') : (window.location.href = 'workspace.html?view=notifications')); };

    const ensurePanel = () => {
        if (panel) return;
        panel = document.createElement('div');
        panel.id = 'notif-popover';
        panel.style.cssText = 'display:none;position:fixed;z-index:80;';
        panel.innerHTML = `
            <div class="bg-white rounded-xl border border-gray-200 shadow-2xl overflow-hidden" style="width:400px;max-width:calc(100vw - 24px);max-height:min(70vh,560px);display:flex;flex-direction:column;">
                <div class="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
                    <span class="text-sm font-bold text-gray-900">Notifications</span>
                    <div class="flex items-center gap-3">
                        <button type="button" id="notif-pop-mark-all" class="text-xs font-semibold text-gray-500 hover:text-gray-800 disabled:opacity-40 disabled:cursor-not-allowed">Mark all read</button>
                        <button type="button" id="notif-pop-inbox" class="text-xs font-bold text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-1">Open inbox<span aria-hidden="true">&rarr;</span></button>
                    </div>
                </div>
                <div class="flex gap-1 px-3 pt-2 shrink-0">
                    <button type="button" id="notif-pop-tab-action" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg"></button>
                    <button type="button" id="notif-pop-tab-updates" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg"></button>
                </div>
                <ul id="notif-pop-list" class="overflow-y-auto divide-y divide-gray-100 mt-1" style="flex:1 1 auto;"></ul>
            </div>`;
        document.body.appendChild(panel);
        listEl = panel.querySelector('#notif-pop-list');
        tabActionBtn = panel.querySelector('#notif-pop-tab-action');
        tabUpdatesBtn = panel.querySelector('#notif-pop-tab-updates');
        markAllBtn = panel.querySelector('#notif-pop-mark-all');
        panel.querySelector('#notif-pop-inbox').addEventListener('click', openInbox);
        markAllBtn.addEventListener('click', markAllRead);
        tabActionBtn.addEventListener('click', () => { activeTab = 'action'; render(); });
        tabUpdatesBtn.addEventListener('click', () => { activeTab = 'updates'; render(); });
        // Dismiss on outside-click / Esc. Registered once; guarded by panel visibility.
        document.addEventListener('click', (e) => {
            if (panel.style.display === 'none') return;
            if (panel.contains(e.target) || (anchorEl && anchorEl.contains(e.target))) return;
            close();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    };

    const position = () => {
        if (!anchorEl) return;
        const r = anchorEl.getBoundingClientRect();
        panel.style.top = `${Math.round(r.bottom + 8)}px`;
        panel.style.right = `${Math.round(Math.max(12, window.innerWidth - r.right))}px`;
    };

    const patch = (id, body) => fetch('/.netlify/functions/notifications', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationId: id, ...body }),
    }).then(() => window.updateNotificationBadge && window.updateNotificationBadge())
      .catch(err => console.error('Popover sync failed:', err));

    /**
     * Mark every unread item in the CURRENTLY OPEN tab as read. Scoped to the open tab (matching
     * the full inbox page's behaviour) so clearing Updates never silently buries an unactioned
     * Action-required item. PUT accepts an explicit id list; refreshing the badge afterwards also
     * updates the side-menu Inbox count, which mirrors it.
     */
    const markAllRead = async () => {
        if (!markAllBtn || markAllBtn.disabled) return;
        const ids = data
            .filter(n => K.kindOf(n) === (activeTab === 'action' ? 'action' : 'info') && !n.isRead)
            .map(n => n.id);
        if (!ids.length) return;
        markAllBtn.disabled = true;
        // Optimistic: flip locally and re-render so the popover reacts instantly.
        data.forEach(n => { if (ids.includes(n.id)) n.isRead = true; });
        render();
        try {
            await fetch('/.netlify/functions/notifications', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids }),
            });
        } catch (err) {
            console.error('Mark all read failed:', err);
        }
        // Badge + side-menu Inbox count both come from this one call.
        await window.updateNotificationBadge?.();
    };

    /** Enable/disable "Mark all read" for the open tab, and label it with what it will clear. */
    const syncMarkAllBtn = () => {
        if (!markAllBtn) return;
        const unread = data.filter(n => K.kindOf(n) === (activeTab === 'action' ? 'action' : 'info') && !n.isRead).length;
        markAllBtn.disabled = unread === 0;
        markAllBtn.textContent = unread > 0 ? `Mark ${unread} read` : 'Mark all read';
    };

    const compactCard = (n) => {
        const st = K.styleOf(n);
        const isAction = K.kindOf(n) === 'action';
        // Action-kind items always get a CTA (fallback to a generic Review); info-kind items only
        // show a CTA when they carry a real destination — passive FYIs stay button-less, as on
        // the full page. So "post published" links out, but "maintenance" is just informational.
        const rawAction = K.getNotificationAction(n);
        const action = rawAction || (isAction ? { label: 'Review', run: () => window.loadView?.('dashboard') } : null);
        const li = document.createElement('li');
        li.className = 'flex gap-3 p-3 hover:bg-gray-50 transition-colors';
        li.innerHTML = `
            ${K.avatarHTML(n, st)}
            <div class="flex-1 min-w-0">
                ${K.actorEyebrowHTML(n)}
                <p class="text-sm font-bold text-gray-900 truncate">${K.sanitizeText(n.title)}</p>
                ${n.message ? `<p class="text-xs text-gray-500 mt-0.5 line-clamp-2">${K.sanitizeText(n.message)}</p>` : ''}
                <div class="mt-2 flex items-center gap-2">
                    ${action ? `<button type="button" class="pop-cta px-3 py-1.5 ${st.cta} text-white text-xs font-bold rounded-lg transition whitespace-nowrap">${K.escHtml(action.label)}</button>` : ''}
                    ${n.isRead ? '' : '<button type="button" class="pop-read text-[11px] font-semibold text-gray-400 hover:text-gray-700 whitespace-nowrap">Mark read</button>'}
                    <span class="text-[11px] text-gray-400">${K.fmtDate(n.createdAt)}</span>
                </div>
            </div>`;
        // Dismiss a single item without acting on it — the popover previously offered no way to
        // clear anything, so the badge could only ever be reduced by opening the full inbox.
        li.querySelector('.pop-read')?.addEventListener('click', (e) => {
            e.stopPropagation();
            n.isRead = true;
            render();
            patch(n.id, { isRead: true });
        });
        li.querySelector('.pop-cta')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isAction) {
                if (K.resolvesClick(n)) patch(n.id, { resolved: true }); else patch(n.id, { isRead: true });
            } else {
                patch(n.id, { isRead: true });
            }
            close();
            action.run();
        });
        return li;
    };

    const emptyRow = (msg) => {
        const li = document.createElement('li');
        li.className = 'px-4 py-10 text-center text-sm text-gray-400';
        li.textContent = msg;
        return li;
    };

    const styleTabs = (openActions, unreadUpdates) => {
        const on = 'flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800';
        const off = 'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-transparent text-gray-500 hover:text-gray-700';
        const pill = (n, cls) => n > 0 ? `<span class="${cls} text-[10px] font-bold px-1.5 py-0.5 rounded-full">${n}</span>` : '';
        tabActionBtn.className = activeTab === 'action' ? on : off;
        tabUpdatesBtn.className = activeTab === 'updates' ? on : off;
        tabActionBtn.innerHTML = `Action required${pill(openActions, 'bg-red-100 text-red-700')}`;
        tabUpdatesBtn.innerHTML = `Updates${pill(unreadUpdates, 'bg-emerald-100 text-emerald-700')}`;
    };

    const render = () => {
        const actions = data.filter(n => K.kindOf(n) === 'action');
        const updates = data.filter(n => K.kindOf(n) === 'info');
        const openActions = actions.filter(n => !K.isResolved(n)).length;
        const unreadUpdates = updates.filter(n => !n.isRead).length;
        styleTabs(openActions, unreadUpdates);
        syncMarkAllBtn();

        const byCreated = (a, b) => new Date(b.createdAt) - new Date(a.createdAt) || (b.id - a.id);
        let list = (activeTab === 'action' ? actions : updates).slice();
        if (activeTab === 'action') {
            list.sort((a, b) => (K.isResolved(a) ? 1 : 0) - (K.isResolved(b) ? 1 : 0) || K.prioOf(a) - K.prioOf(b) || byCreated(a, b));
        } else {
            list.sort(byCreated);
        }
        const shown = list.slice(0, MAX_PER_TAB);

        listEl.innerHTML = '';
        if (shown.length === 0) {
            listEl.appendChild(emptyRow(activeTab === 'action' ? "You're all caught up" : 'No updates yet'));
        } else {
            shown.forEach(n => listEl.appendChild(compactCard(n)));
            if (list.length > shown.length) {
                const li = document.createElement('li');
                li.className = 'px-4 py-2.5 text-center';
                li.innerHTML = `<button type="button" class="text-xs font-bold text-emerald-700 hover:text-emerald-800">View all ${list.length} in inbox &rarr;</button>`;
                li.querySelector('button').addEventListener('click', openInbox);
                listEl.appendChild(li);
            }
        }
    };

    const fetchAndRender = async () => {
        listEl.innerHTML = '';
        listEl.appendChild(emptyRow('Loading…'));
        try {
            const res = await fetch('/.netlify/functions/notifications');
            if (res.ok) {
                const j = await res.json();
                data = j.notifications || [];
                // Default to whichever tab has something waiting (mirrors the full page).
                activeTab = data.some(n => K.kindOf(n) === 'action' && !K.isResolved(n)) ? 'action' : 'updates';
                render();
            } else {
                listEl.innerHTML = '';
                listEl.appendChild(emptyRow('Could not load notifications'));
            }
        } catch (e) {
            console.error('Popover load failed:', e);
            listEl.innerHTML = '';
            listEl.appendChild(emptyRow('Could not load notifications'));
        }
    };

    const open = (anchor) => {
        ensurePanel();
        anchorEl = anchor || document.getElementById('nav-notifications');
        panel.style.display = 'block';
        position();
        fetchAndRender();
    };
    const close = () => { if (panel) panel.style.display = 'none'; };
    const isOpen = () => !!panel && panel.style.display !== 'none';
    const toggle = (anchor) => { ensurePanel(); isOpen() ? close() : open(anchor); };

    window.addEventListener('resize', () => { if (isOpen()) position(); });

    return { open, close, toggle, isOpen };
})();