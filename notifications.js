// notifications.js

// --- GLOBAL NOTIFICATION BADGE CONTROLLER ---
window.updateNotificationBadge = async function() {
    try {
        const res = await fetch('/.netlify/functions/notifications?action=count');
        if (res.ok) {
            const data = await res.json();
            const badge = document.getElementById('sidebar-nav-badge');
            if (badge) {
                // Badge reflects open ACTION items + unread UPDATES. Falls back to the older
                // actionCount / unreadCount fields if the server hasn't been updated yet.
                const count = (typeof data.badgeCount === 'number') ? data.badgeCount
                    : (typeof data.actionCount === 'number') ? data.actionCount
                    : (data.unreadCount || 0);
                if (count > 0) {
                    badge.textContent = count;
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }
        }
    } catch (e) {
        console.error("Failed to fetch notification badge count", e);
    }
};

window.initNotifications = async function() {
    const listEl = document.getElementById('notif-list');
    const loadingEl = document.getElementById('notif-loading');
    const emptyStateEl = document.getElementById('notif-empty-state');
    const searchInput = document.getElementById('notif-search');
    const markAllBtn = document.getElementById('btn-mark-all-read');

    if (!listEl) return;

    // Clear badge logic when entering the notifications page
    if (typeof window.updateNotificationBadge === 'function') {
        window.updateNotificationBadge();
    }

    let notificationsData = [];

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
        trial_expiring_soon:           { label: 'Upgrade plan',        run: routeToBilling },
        trial_expired:                 { label: 'Upgrade plan',        run: routeToBilling },
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
        'billing_payment_failed', 'trial_expired', 'run_budget_suspended',
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
        'post_generation_failed', 'trial_expiring_soon', 'trial_expired', 'task_limit_reached',
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
        'trial_expiring_soon', 'trial_expired', 'tier_mismatch', 'assistants_paused_downgrade',
        'task_limit_reached', 'task_limit_warning',
        'social_oauth_revoked', 'instagram_token_refresh_failed', 'integration_alert',
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
    let activeTab = 'action';

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
            <div class="w-10 h-10 rounded-full ${st.ring} border flex items-center justify-center shrink-0">
                ${st.icon}
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                    <p class="text-sm ${seen ? 'font-semibold text-gray-700' : 'font-bold text-gray-900'}">${notif.title}</p>
                    ${critical && !resolved ? '<span class="text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">Urgent</span>' : ''}
                    ${resolved ? '<span class="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">Done</span>' : ''}
                </div>
                ${notif.message ? `<p class="text-sm text-gray-500 mt-0.5 line-clamp-2">${notif.message}</p>` : ''}
                <p class="text-xs text-gray-400 mt-1">${fmtDate(notif.createdAt)}</p>
            </div>
            ${resolved ? '' : `<button type="button" class="action-cta px-4 py-2 ${st.cta} text-white text-sm font-bold rounded-lg transition shrink-0 whitespace-nowrap">${action.label}</button>`}
            ${dismissBtnHTML(notif)}
        `;
        li.querySelector('.action-cta')?.addEventListener('click', (e) => {
            e.stopPropagation();
            // Completion-driven items just navigate + mark seen; the rest close on click.
            if (resolvesClick(notif)) setResolved(notif.id);
            else setRead(notif.id, true);
            action.run();
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
            <div class="w-10 h-10 rounded-full ${st.ring} flex items-center justify-center shrink-0 border">
                ${st.icon}
            </div>
            <div class="flex-1 min-w-0">
                <p class="text-sm ${textClass}">${notif.title}</p>
                ${notif.message ? `<p class="text-sm text-gray-500 mt-1 line-clamp-2">${notif.message}</p>` : ''}
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
        // Open = UNRESOLVED (not merely unread): a setup reminder counts until it's actually done.
        const openActions = actions.filter(n => !isResolved(n)).length;
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

        // Mark-all-read only applies to the Updates tab.
        if (markAllBtn) {
            const showMarkAll = activeTab === 'updates' && updates.some(n => !n.isRead);
            markAllBtn.classList.toggle('hidden', !showMarkAll);
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

        list.forEach(notif => listEl.appendChild(
            activeTab === 'action' ? renderActionItem(notif) : renderUpdateItem(notif)));
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
            // Only clears informational updates; action items are cleared by acting.
            notificationsData.filter(n => kindOf(n) === 'info').forEach(n => n.isRead = true);
            renderList();
            fetch('/.netlify/functions/notifications', { method: 'PUT' })
                .then(() => { if (typeof window.updateNotificationBadge === 'function') window.updateNotificationBadge(); })
                .catch(err => console.error("Bulk sync failed:", err));
        });
    }

    if (tabActionBtn) tabActionBtn.addEventListener('click', () => { activeTab = 'action'; renderList(); });
    if (tabUpdatesBtn) tabUpdatesBtn.addEventListener('click', () => { activeTab = 'updates'; renderList(); });
    if (searchInput) searchInput.addEventListener('input', renderList);

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