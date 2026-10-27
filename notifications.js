// notifications.js

// --- GLOBAL NOTIFICATION BADGE CONTROLLER ---
// Issue #156: tracks the previous badge count across polls so we can ding only when it
// *rises* (a new notification arrived) rather than on every poll or on the initial load.
let _lastNotifBadgeCount = null;
// The last needs-you number, so the screen-reader announcement fires on a rise only.
let _lastNeedsYou = null;

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

/**
 * Paint one badge: a red number for what needs the person, else a small grey dot for unread
 * things to read, else nothing. The side-menu Notifications item and the header bell both use
 * this, with the same two numbers, so they can never disagree (they used to show three counts).
 */
function _paintNotifBadge(numEl, dotEl, needsYou, fyi) {
    if (numEl) {
        numEl.textContent = needsYou > 99 ? '99+' : String(needsYou);
        numEl.classList.toggle('hidden', needsYou === 0);
    }
    if (dotEl) {
        const dot = needsYou === 0 && fyi > 0;
        dotEl.classList.toggle('hidden', !dot);
        // `hidden` loses to inline-block utilities on some builds — drive display too.
        dotEl.style.display = dot ? '' : 'none';
    }
}

/** Words for the count, for the bell's label and the screen-reader announcement. */
function _notifCountWords(needsYou, fyi) {
    const parts = [];
    if (needsYou) parts.push(`${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you`);
    if (fyi) parts.push(`${fyi} unread`);
    return parts.length ? parts.join(', ') : 'nothing new';
}

window.updateNotificationBadge = async function() {
    try {
        const res = await fetch('/.netlify/functions/notifications?action=count');
        if (res.ok) {
            const data = await res.json();
            const badge = document.getElementById('sidebar-nav-badge');
            // needsYou = open actions + unanswered Team questions; fyi = unread updates + unread Team
            // messages. Both come from the server, Team included (notifications.ts), so there is one
            // request and one answer. Older servers: fall back to the old single count as needsYou.
            const needsYou = typeof data.needsYou === 'number' ? data.needsYou
                : (typeof data.badgeCount === 'number' ? data.badgeCount : (data.actionCount || data.unreadCount || 0));
            const fyi = typeof data.fyi === 'number' ? data.fyi : 0;
            // `count` drives the arrival sound: anything new, of either kind, rings.
            const count = needsYou + fyi;
            window._notifCounts = { needsYou, fyi, openActions: data.openActions ?? null, teamQuestions: data.teamQuestions ?? 0, teamUnread: data.teamUnread ?? 0, updateUnread: data.updateUnread ?? 0 };

            _paintNotifBadge(document.getElementById('nav-inbox-badge'), document.getElementById('nav-inbox-dot'), needsYou, fyi);
            const bell = document.getElementById('nav-notifications');
            if (bell) bell.setAttribute('aria-label', `Notifications: ${_notifCountWords(needsYou, fyi)}`);
            // Say it out loud only when the needs-you number goes UP — not on every poll.
            const live = document.getElementById('notif-count-live');
            if (live && _lastNeedsYou !== null && needsYou > _lastNeedsYou) live.textContent = _notifCountWords(needsYou, 0);
            _lastNeedsYou = needsYou;
            // An open Notifications page re-reads its tab counts from the same numbers.
            document.dispatchEvent(new CustomEvent('bms:notif-counts', { detail: window._notifCounts }));

            // First refresh after login: run the one-time inbox-focus count-up, then adopt
            // the count as the baseline so the normal rise-ding doesn't also fire for it.
            if (!_inboxFocusAnimating && _lastNotifBadgeCount === null && _consumeFreshLoginFlag() && needsYou > 0) {
                _inboxFocusAnimating = true;
                // The count-up owns the login "sound moment" — silence the Aurora welcome chime
                // so it doesn't play over the counting notification sound. Only when that sound
                // is actually enabled: if notification sound is muted the count-up is silent, so
                // there's nothing to clash with and the welcome chime should still play.
                if (localStorage.getItem('bms_soundOnNotification') !== '0') window._suppressWelcomeSound?.();
                await _animateInboxFocus(badge, needsYou);
                _inboxFocusAnimating = false;
                _lastNotifBadgeCount = count;
                _paintNotifBadge(badge, document.getElementById('sidebar-nav-dot'), needsYou, fyi);
                return;
            }
            // A concurrent poll must not fight the running animation for the badge.
            if (_inboxFocusAnimating) return;

            _paintNotifBadge(badge, document.getElementById('sidebar-nav-dot'), needsYou, fyi);
            if (_lastNotifBadgeCount !== null && count > _lastNotifBadgeCount) {
                // …and the new one pops up as a chat bubble from the assistant that sent it.
                window.AssistantBubbles?.onNotificationsRose?.();
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

    // Only ever open an https link on a platform we publish to — the value comes from notification
    // metadata, and a notification is not a place to hand a stranger an open redirect.
    const POST_HOSTS = /^https:\/\/(www\.)?(linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|youtube\.com|threads\.net)\//;
    function safeLiveUrl(u) { return typeof u === 'string' && POST_HOSTS.test(u) ? u : null; }
    // Mirror of src/utils/post-live-url.ts for notifications written before postUrl was stamped.
    function derivePostUrl(platform, id) {
        id = String(id || '').trim();
        if (!id) return null;
        if (platform === 'linkedin' && id.indexOf('urn:li:') === 0) return 'https://www.linkedin.com/feed/update/' + id + '/';
        if (platform === 'facebook' && /^[\d_]+$/.test(id)) return 'https://www.facebook.com/' + id;
        if ((platform === 'x' || platform === 'twitter') && /^\d+$/.test(id)) return 'https://x.com/i/web/status/' + id;
        if (platform === 'youtube' && /^[\w-]{6,20}$/.test(id)) return 'https://www.youtube.com/watch?v=' + id;
        return null;
    }

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
        // A post that could not be WRITTEN — there is no post to show, so "View content" landed on the
        // media library with nothing explaining anything. Its assistant's Activity tab shows why in
        // plain words, with "Try again" (get-assistant-activity → generation-failure.ts).
        if (notif.type === 'post_generation_failed' && meta.assistantId) {
            return { label: 'See why', run: () => {
                window._assistantDetailInitialTab = 'activity';
                if (meta.jobId) window._activityFocusJobId = String(meta.jobId);
                window.routeToAssistantDetail?.(meta.assistantId);
            } };
        }
        // What a website brought in opens on its own tab of the Website Assistant (owner, 2026-10-16).
        const SITE_TABS = {
            site_enquiry_received: ['Open enquiries', 'siteenquiries'], site_order_received: ['Open orders', 'siteorders'],
            site_payments_ready: ['Open orders', 'siteorders'],
            site_booking_received: ['Open bookings', 'sitebookings'], site_booking_changed: ['Open bookings', 'sitebookings'],
        };
        if (SITE_TABS[notif.type] && meta.assistantId) {
            const [label, tab] = SITE_TABS[notif.type];
            return { label, run: () => {
                window._assistantDetailInitialTab = tab;
                window.routeToAssistantDetail?.(meta.assistantId);
            } };
        }
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
        // The Business Mentor's weekly review (src/utils/mentor-review.ts): the review is in THIS
        // person's chat with the Mentor — open that conversation, not a fresh one (the Chat button starts
        // a new conversation, so without this the review was only reachable through History).
        if (notif.type === 'mentor_weekly_review' && meta.assistantId) {
            return { label: 'Open my review', run: () => {
                if (meta.chatSessionId && window.openAssistantChat) window.openAssistantChat({ assistantId: meta.assistantId, sessionId: meta.chatSessionId });
                else { window._assistantDetailInitialTab = 'mentor'; window.routeToAssistantDetail?.(meta.assistantId); }
            } };
        }
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
                // The Outreach tab's Replied stage (it was the Conversations tab until 2026-10-27).
                // The thread id below picks the stage the lead is actually in by the time it opens.
                window._assistantDetailInitialTab = 'review-queue';
                window._assistantDetailInitialRqStatus = 'replied';
                if (meta.threadId) window._assistantDetailFocusThreadId = meta.threadId;
                window.routeToAssistantDetail?.(meta.assistantId);
            } };
        }
        // Leads about to lapse off the retention clock — the Outreach tab is where the decision is
        // made, so send them there rather than to the All leads table they will end up in.
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
        // "Your assistant is not drafting" — every one of these names a setting the user has to
        // change, and that setting lives on exactly one screen: the assistant's Operational Setup
        // card. None of them had an entry here, so they fell through to the generic action fallback
        // at the bottom, which drops the user on the DASHBOARD with no trail back to the control the
        // message just told them to open. A card that states a fix and then hides it is most of the
        // way to not notifying anyone. (Reported in prod for an Email Marketing Assistant, 20 Aug 2026.)
        if ((notif.type === 'autopilot_schedule_unreadable' || notif.type === 'autopilot_setup_blocked'
            || notif.type === 'content_library_empty') && meta.assistantId) {
            return { label: 'Open settings', run: () => {
                window._assistantDetailInitialTab = 'operation';
                window.routeToAssistantDetail?.(meta.assistantId);
            } };
        }
        // "Post published to LinkedIn — tap to view" offered nothing to tap. The publishers now stamp
        // postUrl (src/utils/post-live-url.ts, and Instagram's permalink); for notifications written
        // before that, the URL is rebuilt here for the platforms whose address is a pure function of
        // the id, and anything else opens the published post in the app (read-only) instead.
        if (notif.type === 'post_published' && (meta.postUrl || meta.platformPostId || meta.postId)) {
            const live = safeLiveUrl(meta.postUrl) || derivePostUrl(meta.platform, meta.platformPostId);
            if (live) return { label: 'View post', run: () => window.open(live, '_blank', 'noopener') };
            if (meta.postId) {
                return { label: 'View post', run: () => {
                    if (typeof window.openPostReview === 'function') return window.openPostReview(meta.postId);
                    return window.loadView?.('calendar');
                } };
            }
        }
        // Opens the post editor modal in place — no detour through the Review page, which cost a
        // full view load before the modal even started. openPostReview (workspace.html) shows the
        // busy cursor itself and fetches the post from a cold cache, so it works from any view.
        // The review-queue route is only the fallback for a page without the workspace shell.
        // post_revised: the redraft of a post the user sent back — the same review, of the new version.
        if ((notif.type === 'post_draft_ready' || notif.type === 'post_revised' || notif.type === 'ai_review') && meta.postId) {
            return { label: 'Review draft', run: () => {
                if (typeof window.openPostReview === 'function') return window.openPostReview(meta.postId);
                return window.loadView?.('review-queue', { postId: meta.postId });
            } };
        }
        // The long-form twin of the above. process-blog-jobs stamps blogPostId (not postId — a blog
        // lives in blog_posts, not scheduled_posts), so the check above never matched and the card
        // rendered with no button at all. Opens the draft in the Blog Studio modal in place, with
        // the standalone page as the fallback outside the workspace shell — as calendar.js does.
        if (notif.type === 'blog_draft_ready' && meta.blogPostId) {
            return { label: 'Review draft', run: () => {
                if (typeof window.openBlogStudio === 'function') {
                    return window.openBlogStudio({ assistantId: meta.assistantId, postId: meta.blogPostId, intent: 'review' });
                }
                window.location.href = '/blog-studio.html?postId=' + encodeURIComponent(meta.blogPostId);
            } };
        }
        // The newsletter twin. The Studio is a VIEW, not a modal, so this routes through the same
        // deep-link hook the calendar chip and the detail Review Queue use (newsletter.js consumes
        // _newsletterInitialIssueId on read). _newsletterAssistantId lets the Studio name the
        // assistant on its buttons — it has no other way to learn who wrote the issue.
        // ⚠️ No standalone fallback, unlike the blog above: newsletter.html is a view FRAGMENT, so
        // outside the workspace router (admin.html) there is nowhere to send the user, and no
        // button beats one that lands on a bare, unstyled half-page.
        if (notif.type === 'newsletter_issue_ready' && meta.newsletterIssueId
            && typeof window.loadView === 'function') {
            return { label: 'Review email', run: () => {
                window._newsletterInitialIssueId = meta.newsletterIssueId;
                window._newsletterAssistantId = meta.assistantId || null;
                window.loadView('newsletter');
            } };
        }
        // Automated emails queued with no way to send. Lands on the Email Studio, whose Sending
        // button is where a domain is verified or a mailbox connected. Same no-fallback rule.
        if (notif.type === 'newsletter_sequence_blocked' && typeof window.loadView === 'function') {
            return { label: 'Set up sending', run: () => {
                window._newsletterAssistantId = meta.assistantId || null;
                window.loadView('newsletter');
            } };
        }
        // Issue #87 — issue status updates need a link back to the reported issue itself,
        // not just a passive FYI. Opens the "Report an Issue" modal on the specific issue.
        if (notif.type === 'issue_update') {
            return { label: 'View issue', run: () => window.routeToIssueReport?.(meta.issueId) };
        }
        if (meta.action === 'view_invoices') return ACTIONS_BY_TYPE.invoice_ready;
        // A ticket notification opens THAT ticket's conversation (metadata.ticketId), not just the tab.
        if (meta.action === 'view_ticket' || notif.type === 'ticket_reply' || notif.type === 'ticket_created') {
            return { label: 'View ticket', run: () => window.routeToSupportTicket?.(meta.ticketId ?? null) };
        }
        if (meta.action === 'open_wizard')   return { label: meta.ctaLabel || 'Open Setup Wizard', run: openWizard };
        if (meta.action === 'getting_started') return ACTIONS_BY_TYPE.onboarding_prompt;
        // Affiliate partners: commission earned / payout sent open the Partner page (partner-notify.ts).
        if (meta.action === 'partner_page')  return { label: 'Open Partner page', run: go('partner') };
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
        critical_action: { ring: 'bg-red-50 text-red-600 border-red-100',       cta: 'btn-primary', icon: ICON.warning },
        suggested_action:{ ring: 'bg-emerald-50 text-emerald-700 border-emerald-100', cta: 'btn-primary', icon: ICON.action },
        state_change:    { ring: 'bg-green-50 text-green-700 border-green-100',  cta: 'btn-primary', icon: ICON.check },
        informational:   { ring: 'bg-gray-100 text-gray-500 border-gray-200',    cta: 'btn-primary', icon: ICON.info },
        celebratory:     { ring: 'bg-amber-50 text-amber-600 border-amber-100',  cta: 'btn-primary', icon: ICON.trophy, celebrate: true },
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

    // Phone layout. A card is one flex row — avatar, text, then the CTA and read toggle, both
    // `shrink-0 whitespace-nowrap`. At 375px those buttons alone are ~260px wide, so the text column
    // was squeezed to a word or two per line and the title ran out under the CTA. Below `sm` the
    // buttons drop to their own line, indented to the text by --notif-indent (set per renderer).
    if (!document.getElementById('notif-row-style')) {
        const s = document.createElement('style');
        s.id = 'notif-row-style';
        s.textContent = '@media (max-width:639px){'
            + '.notif-row{flex-wrap:wrap;align-items:flex-start}'
            + '.notif-row-actions{order:3;flex-basis:100%;padding-left:var(--notif-indent,52px)}'
            + '.notif-title-row{flex-wrap:wrap}}';
        document.head.appendChild(s);
    }

    const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    // Human-readable label for a notif.type, e.g. "billing_payment_failed" -> "Billing Payment Failed".
    const typeLabel = (type) => (type || 'other').split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    // ── Actor identity (who is asking) ─────────────────────────────────────────
    // Every card leads with its actor: the assistant that produced it (avatar = coloured
    // initial + name), or the BMS system (semantic category icon + "Be More Swan"). The
    // server attaches notif.actor = { assistantId, name, jobRole, avatarColor } | null.
    //
    // The colour comes from window.AssistantColors (/assistant-colors.js) — the user's own choice
    // where they've made one, else the same id-derived fallback this file always used. Every actor
    // seen is cached there too, so a surface that renders before its own assistants fetch lands
    // still draws the right colour.
    // The `??` arm covers assistant-colors.js failing to load at all; it is the same neutral grey
    // the module itself returns for an unknown assistant.
    const actorColor = (id, explicit) => window.AssistantColors?.colorFor(id, explicit) ?? '#9ca3af';
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
            const color = actorColor(a.assistantId, a.avatarColor);
            return `<div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-white text-sm font-bold" style="background:${color}" title="${escHtml(a.name)}">${window.AssistantColors ? escHtml(window.AssistantColors.letterFor(a.assistantId, a.name, a.avatarLetter)) : actorInitial(a.name)}</div>`;
        }
        return `<div class="w-10 h-10 rounded-full ${st.ring} border flex items-center justify-center shrink-0">${st.icon}</div>`;
    };
    // The eyebrow line above the title — assistant name in its accent colour, or "Be More Swan".
    const actorEyebrowHTML = (notif) => {
        const a = notif.actor;
        if (a && a.name) {
            return `<p class="text-xs font-bold mb-0.5 truncate" style="color:${actorColor(a.assistantId, a.avatarColor)}">${escHtml(a.name)}</p>`;
        }
        return `<p class="text-xs font-bold mb-0.5 text-gray-400">Be More Swan</p>`;
    };

    return {
        getNotificationAction, styleOf, catOf, prioOf, isResolved, resolvesClick,
        isDismissible, dismissBtnHTML, kindOf, fmtDate, typeLabel,
        avatarHTML, actorEyebrowHTML, actorColor, actorInitial, escHtml, sanitizeText,
    };
})();

/**
 * The Notifications page (notifications.html): three tabs over one count.
 *   needs    — open actions + Team questions nobody has answered. Cleared by DOING, never by reading.
 *   messages — Team Chat (src/components/team-feed.js), mounted in place, unchanged: a conversation.
 *   updates  — things to read. Cleared by reading.
 * `param` (from loadView): { tab?: 'needs'|'messages'|'updates', thread?: {type, id} } — loadView('team')
 * arrives here as { tab: 'messages' }.
 */
window.initNotifications = async function(param) {
    const listEl = document.getElementById('notif-list');
    const loadingEl = document.getElementById('notif-loading');
    const emptyStateEl = document.getElementById('notif-empty-state');
    const searchInput = document.getElementById('notif-search');
    const markAllBtn = document.getElementById('btn-mark-all-read');
    const groupBySelect = document.getElementById('notif-group-by');
    const assistantSelect = document.getElementById('notif-assistant-filter');
    const expandAllBtn = document.getElementById('notif-expand-all');
    const listPanel = document.getElementById('notif-list-panel');
    const messagesPanel = document.getElementById('notif-messages-panel');
    const teamHost = document.getElementById('team-host');

    if (!listEl) return;

    // Clear badge logic when entering the notifications page
    if (typeof window.updateNotificationBadge === 'function') {
        window.updateNotificationBadge();
    }

    let notificationsData = [];
    // Team questions to the person still waiting for an answer (team.ts list openQuestions), and every
    // assistant in the workspace (for faces and the "From" filter).
    let questions = [];
    let teamAssistants = [];
    // Questions answered on this visit stay in Needs you as done rows, with the assistant's reply, so
    // the person sees the answer landed rather than the row just vanishing.
    const answeredHere = [];

    // Shared classification + rendering helpers (single source of truth — see window.NotifKit).
    const {
        getNotificationAction, styleOf, catOf, prioOf, isResolved, resolvesClick,
        dismissBtnHTML, kindOf, fmtDate, typeLabel, avatarHTML, actorEyebrowHTML, sanitizeText,
        actorColor, escHtml,
    } = window.NotifKit;
    const TABS = ['needs', 'messages', 'updates'];
    // null until the first load picks the tab that has something waiting.
    let activeTab = param && TABS.includes(param.tab) ? param.tab : null;
    let teamThread = param && param.thread ? param.thread : null;
    let teamFeed = null;
    // 'none' | 'type' | 'assistant' | 'day'. Remembered per browser: picking a grouping and then navigating
    // away and back used to silently drop you into an ungrouped list, which reads as "grouping does
    // nothing" — the choice is restored below once the select is known to be present.
    const GROUP_BY_STORAGE_KEY = 'bms_notifGroupBy';
    const GROUP_MODES = ['none', 'type', 'assistant', 'day'];
    let groupBy = 'none';
    // "From": 'all' | 'system' | 'a:<assistantId>'. Remembered like the grouping.
    const FROM_STORAGE_KEY = 'bms_notifFrom';
    let fromFilter = 'all';
    // Persists across re-renders so a group stays collapsed while notifications update/resolve.
    // Keys are namespaced by grouping mode, so switching mode can't collapse an unrelated group.
    const collapsedGroups = new Set();
    // The group keys the last render actually drew, so "Collapse all" knows what it is acting on
    // (and can tell "everything is collapsed" from "there are no groups").
    let renderedGroupKeys = [];

    // One control for both directions: it offers "Collapse all" while anything is open and
    // "Expand all" once everything is shut, and hides itself entirely when nothing is grouped.
    const syncExpandAllBtn = () => {
        if (!expandAllBtn) return;
        const hasGroups = renderedGroupKeys.length > 0;
        expandAllBtn.classList.toggle('hidden', !hasGroups);
        // `hidden` loses to the button's own inline-flex utility, so drive display too.
        expandAllBtn.style.display = hasGroups ? '' : 'none';
        if (!hasGroups) return;
        const allCollapsed = renderedGroupKeys.every(k => collapsedGroups.has(k));
        expandAllBtn.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
        expandAllBtn.dataset.action = allCollapsed ? 'expand' : 'collapse';
    };

    const tabBtns = { needs: document.getElementById('tab-needs'), messages: document.getElementById('tab-messages'), updates: document.getElementById('tab-updates') };
    const tabCounts = { needs: document.getElementById('tab-needs-count'), messages: document.getElementById('tab-messages-count'), updates: document.getElementById('tab-updates-count') };

    const setTabStyles = () => {
        const active = 'notif-tab flex items-center gap-1.5 px-3 text-sm font-bold rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800';
        const inactive = 'notif-tab flex items-center gap-1.5 px-3 text-sm font-medium rounded-lg border border-transparent text-gray-500 hover:text-gray-700';
        TABS.forEach((t) => {
            const b = tabBtns[t];
            if (!b) return;
            b.className = activeTab === t ? active : inactive;
            b.setAttribute('aria-selected', String(activeTab === t));
            b.tabIndex = activeTab === t ? 0 : -1;
        });
    };
    const setCount = (tab, n) => {
        const el = tabCounts[tab];
        if (!el) return;
        el.textContent = n > 99 ? '99+' : String(n);
        el.classList.toggle('hidden', !n);
    };
    // Messages' number is the unread Team messages (the badge's own figure); questions are in Needs you.
    const teamUnread = () => Number(window._notifCounts?.teamUnread) || 0;

    // "Group by assistant" used to be REMOVED from the select whenever the workspace had a single
    // assistant, on the reasoning that one assistant means one group. That was wrong on both counts:
    // system notifications ("Be More Swan") are their own bucket, so even a one-assistant workspace
    // gets a real split — and an option that silently vanishes is indistinguishable, to the user,
    // from grouping that does not work. The option now always stands.
    const restoreGroupBy = () => {
        let saved = null;
        try { saved = localStorage.getItem(GROUP_BY_STORAGE_KEY); } catch { saved = null; }
        if (groupBySelect && GROUP_MODES.includes(saved)) { groupBy = saved; groupBySelect.value = saved; }
        try { fromFilter = localStorage.getItem(FROM_STORAGE_KEY) || 'all'; } catch { fromFilter = 'all'; }
    };

    const remember = (key, value) => {
        try { localStorage.setItem(key, value); } catch { /* private mode — in-memory only */ }
    };

    // A question as a row the list can sort, filter and group with the notifications around it.
    const questionItem = (m) => {
        const a = teamAssistants.find(x => Number(x.id) === Number(m.from.id));
        return {
            _q: m, id: `q${m.id}`, type: 'question', kind: 'action', createdAt: m.createdAt,
            title: m.body, message: '',
            actor: m.from.kind === 'assistant' && m.from.id
                ? { assistantId: m.from.id, name: m.from.name, avatarColor: a?.avatarColor ?? null, avatarLetter: a?.avatarLetter ?? null }
                : null,
        };
    };

    /** The "From" choices: every assistant that has something here, or that can be written to. */
    const syncFromOptions = () => {
        if (!assistantSelect) return;
        const seen = new Map();
        [...notificationsData, ...questions.map(questionItem)].forEach((n) => {
            if (n.actor && n.actor.name) seen.set(String(n.actor.assistantId), n.actor.name);
        });
        teamAssistants.forEach(a => { if (!seen.has(String(a.id))) seen.set(String(a.id), a.name); });
        const opts = [['all', 'Everyone'], ...[...seen].map(([id, name]) => [`a:${id}`, name]), ['system', 'Be More Swan']];
        if (!opts.some(([v]) => v === fromFilter)) fromFilter = 'all';
        assistantSelect.innerHTML = opts.map(([v, l]) => `<option value="${escHtml(v)}">${escHtml(l)}</option>`).join('');
        assistantSelect.value = fromFilter;
    };
    const fromLabel = () => assistantSelect?.selectedOptions?.[0]?.textContent || 'them';

    const loadData = async () => {
        try {
            // Both halves at once. A failed Team read is no questions, never a failed page.
            const [response, team] = await Promise.all([
                fetch('/.netlify/functions/notifications'),
                fetch('/.netlify/functions/team', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                    body: JSON.stringify({ action: 'list', openQuestions: true }),
                }).then(r => (r.ok ? r.json() : null)).catch(() => null),
            ]);
            if (team) {
                questions = (team.messages || []).filter(m => m.question && !m.question.answered);
                teamAssistants = team.assistants || [];
                window.AssistantColors?.rememberAll?.(teamAssistants.map(a => ({ assistantId: a.id, name: a.name, avatarColor: a.avatarColor, avatarLetter: a.avatarLetter })));
            }
            if (response.ok) {
                const data = await response.json();
                notificationsData = data.notifications || [];
                // Cache each actor's chosen colour so surfaces that only hold an id (the header
                // popover, group dots) resolve to the same colour the cards draw.
                window.AssistantColors?.rememberAll(notificationsData.map(n => n.actor).filter(Boolean));
                // First visit: open the tab that has something waiting — what needs you, else unread
                // messages, else updates.
                if (!activeTab) {
                    const needs = notificationsData.some(n => kindOf(n) === 'action' && !isResolved(n)) || questions.length > 0;
                    activeTab = needs ? 'needs' : teamUnread() > 0 ? 'messages' : 'updates';
                }
                syncFromOptions();
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

    // QUESTION row: an assistant asking the person something. Answered right here with its own
    // buttons (team.ts `answer`, which runs the question's handler); "Open conversation" goes to that
    // assistant's thread in Messages for anything more than a button.
    const renderQuestionItem = (item) => {
        const m = item._q;
        const done = item._answered || null;
        const st = styleOf(item);
        const li = document.createElement('li');
        li.className = `notif-row flex items-center gap-3 p-4 ${done ? 'opacity-60' : ''}`;
        li.style.setProperty('--notif-indent', '52px');
        const chips = done
            ? '<span class="text-xs font-bold text-green-700 bg-green-50 border border-green-100 px-2 py-0.5 rounded-full">Answered</span>'
            : '<span class="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">Question</span>';
        li.innerHTML = `
            ${avatarHTML(item, st)}
            <div class="flex-1 min-w-0">
                ${actorEyebrowHTML(item)}
                <div class="notif-title-row flex items-center gap-2">${chips}</div>
                <p class="text-sm font-bold text-gray-900 mt-1 whitespace-pre-line break-words">${escHtml(m.body)}</p>
                ${done ? `<p class="text-xs text-gray-500 mt-1">You answered: <span class="font-bold text-gray-700">${escHtml(done.label)}</span></p>
                          ${done.said ? `<p class="text-sm text-gray-700 mt-1"><span class="font-bold">${escHtml(m.from.name)}:</span> ${escHtml(done.said)}</p>` : ''}` : ''}
                <p class="text-xs text-gray-400 mt-1">${fmtDate(m.createdAt)}</p>
                <div class="flex flex-wrap items-center gap-2 mt-2">
                    ${done ? '' : m.question.choices.map(c => `<button type="button" class="q-answer btn-secondary border px-3 text-sm font-bold rounded-lg disabled:opacity-50" style="min-height:44px" data-value="${escHtml(c.value)}" data-label="${escHtml(c.label)}">${escHtml(c.label)}</button>`).join('')}
                    ${m.from.id ? '<button type="button" class="q-open btn-utility px-3 text-sm font-bold rounded-lg" style="min-height:44px">Open conversation</button>' : ''}
                </div>
            </div>`;
        li.querySelectorAll('.q-answer').forEach((btn) => btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            li.querySelectorAll('.q-answer').forEach(b => { b.disabled = true; });
            try {
                const res = await fetch('/.netlify/functions/team', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                    body: JSON.stringify({ action: 'answer', messageId: m.id, value: btn.dataset.value }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || 'That did not work — please try again.');
                questions = questions.filter(q => q.id !== m.id);
                answeredHere.push({ ...questionItem(m), _answered: { label: btn.dataset.label, said: data.said || '' } });
                renderList();
                window.updateNotificationBadge?.();
                // An answer can start work or change a brief: anything showing those re-reads itself.
                document.dispatchEvent(new CustomEvent('campaign:updated', { detail: {} }));
            } catch (err) {
                window.showToast?.(err.message || 'That did not work — please try again.', 'error', { icon: '⚠️' });
                li.querySelectorAll('.q-answer').forEach(b => { b.disabled = false; });
            }
        }));
        li.querySelector('.q-open')?.addEventListener('click', (e) => {
            e.stopPropagation();
            teamThread = { type: 'assistant', id: Number(m.from.id) };
            showTab('messages');
        });
        return li;
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
        li.className = `notif-row flex items-center gap-3 p-4 ${resolved ? 'opacity-60' : (seen ? 'opacity-90' : '')}`;
        li.style.setProperty('--notif-indent', '52px'); // avatar 40 + gap-3 12
        li.innerHTML = `
            ${avatarHTML(notif, st)}
            <div class="flex-1 min-w-0">
                ${actorEyebrowHTML(notif)}
                <div class="notif-title-row flex items-center gap-2">
                    <p class="text-sm ${seen ? 'font-semibold text-gray-700' : 'font-bold text-gray-900'}">${sanitizeText(notif.title)}</p>
                    ${critical && !resolved ? '<span class="text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">Urgent</span>' : ''}
                    ${resolved ? '<span class="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">Done</span>' : ''}
                </div>
                ${notif.message ? `<p class="text-sm text-gray-500 mt-0.5 line-clamp-2">${sanitizeText(notif.message)}</p>` : ''}
                <p class="text-xs text-gray-400 mt-1">${fmtDate(notif.createdAt)}</p>
            </div>
            ${resolved ? '' : `<div class="notif-row-actions flex items-center gap-3 shrink-0">
                <button type="button" class="action-cta px-4 py-2 ${st.cta} text-sm font-bold rounded-lg transition shrink-0 whitespace-nowrap">${action.label}</button>
                <button type="button" class="action-done shrink-0 text-xs font-semibold px-2.5 py-1 rounded-md border border-emerald-200 text-emerald-800 hover:bg-emerald-50 whitespace-nowrap">Mark as done</button>
                <button type="button" class="action-toggle-read shrink-0 text-xs font-semibold px-2.5 py-1 rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 whitespace-nowrap">${notif.isRead ? 'Mark as unread' : 'Mark as read'}</button>
            </div>`}
            ${dismissBtnHTML(notif)}
        `;
        li.querySelector('.action-cta')?.addEventListener('click', (e) => {
            e.stopPropagation();
            // Completion-driven items just navigate + mark seen; the rest close on click.
            if (resolvesClick(notif)) setResolved(notif.id);
            else setRead(notif.id, true);
            action.run();
        });
        // "Mark as done" (owner, 2026-10-27): the person has dealt with it some other way, or decided it
        // needs nothing — e.g. an archived assistant they do NOT want back. Closes it (resolvedAt), so
        // it leaves the Needs you count, without running the button's action and without deleting it.
        li.querySelector('.action-done')?.addEventListener('click', (e) => {
            e.stopPropagation();
            setResolved(notif.id);
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
        li.className = `notif-row group p-5 transition-colors flex gap-4 ${st.celebrate ? 'notif-celebrate' : bgClass}`;
        // avatar 40 + gap-4 16, plus the unread dot 10 + gap-4 16 when it is drawn
        li.style.setProperty('--notif-indent', notif.isRead ? '56px' : '82px');
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
            <div class="notif-row-actions shrink-0 self-start">
                <button type="button" class="update-toggle-read text-xs font-semibold px-2.5 py-1 rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 whitespace-nowrap">
                    ${notif.isRead ? 'Mark as unread' : 'Mark as read'}
                </button>
            </div>
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

    // Messages is Team Chat itself. Mounted only while its tab is open: it polls, and on its
    // "Everything" thread a poll marks what it loaded as read — behind a hidden tab that would read
    // messages nobody saw.
    const syncMessagesPanel = () => {
        const onMessages = activeTab === 'messages';
        if (listPanel) { listPanel.classList.toggle('hidden', onMessages); listPanel.style.display = onMessages ? 'none' : ''; }
        if (messagesPanel) { messagesPanel.classList.toggle('hidden', !onMessages); messagesPanel.style.display = onMessages ? '' : 'none'; }
        if (onMessages && !teamFeed && teamHost && window.TeamFeed) {
            teamFeed = window.TeamFeed.mount(teamHost, { mode: 'page', thread: teamThread || undefined });
        } else if (!onMessages && teamFeed) {
            teamFeed.destroy();
            teamFeed = null;
        }
    };

    // The Business Mentor's suggestions waiting for an answer (§3.13 of docs/business-mentor-plan.md):
    // a strip at the top of Needs you, opening "Review all". A failed read is no strip, never a failed page.
    const mentorStrip = document.getElementById('mentor-needs-strip');
    let mentorOpen = 0;
    const paintMentorStrip = () => {
        if (!mentorStrip) return;
        const show = activeTab === 'needs' && mentorOpen > 0;
        mentorStrip.classList.toggle('hidden', !show);
        mentorStrip.style.display = show ? '' : 'none';
        if (!show) return;
        mentorStrip.innerHTML = `<div class="bg-white rounded-xl border border-pink-200 shadow-sm p-4 flex flex-wrap items-center justify-between gap-3">
            <div class="min-w-0">
                <p class="text-sm font-bold text-gray-900">Your Business Mentor has ${mentorOpen} ${mentorOpen === 1 ? 'suggestion' : 'suggestions'} waiting</p>
                <p class="text-xs text-gray-500 mt-0.5">Review them together and tick the ones you want. Nothing changes until you do.</p>
            </div>
            <button type="button" data-mentor-strip-review class="btn-primary shrink-0 px-4 py-2 text-sm font-bold rounded-lg transition">Review all</button>
        </div>`;
    };
    const loadMentorOpen = async () => {
        if (!mentorStrip) return;
        try {
            const res = await fetch('/.netlify/functions/mentor?only=open', { credentials: 'same-origin' });
            const body = res.ok ? await res.json().catch(() => ({})) : {};
            mentorOpen = Array.isArray(body.open) ? body.open.length : 0;
        } catch { mentorOpen = 0; }
        paintMentorStrip();
    };
    mentorStrip?.addEventListener('click', (e) => {
        if (e.target.closest('[data-mentor-strip-review]')) window.MentorReviewAll?.openDialog();
    });
    // A suggestion answered anywhere (chat, Overview, Review all): re-read. Swapped, not stacked.
    if (window._notifMentorListener) document.removeEventListener('mentor:changed', window._notifMentorListener);
    window._notifMentorListener = () => { if (mentorStrip && document.body.contains(mentorStrip)) loadMentorOpen(); };
    document.addEventListener('mentor:changed', window._notifMentorListener);

    const showTab = (tab) => {
        if (!TABS.includes(tab)) return;
        // A thread asked for while Messages is already open: remount on it.
        if (tab === 'messages' && teamFeed && teamThread) { teamFeed.destroy(); teamFeed = null; }
        activeTab = tab;
        renderList();
        if (tab !== 'messages') teamThread = null;
    };

    const dayOf = (d) => {
        const x = new Date(d);
        const today = new Date();
        const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
        const label = x.toDateString() === today.toDateString() ? 'Today'
            : x.toDateString() === yesterday.toDateString() ? 'Yesterday'
            : x.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
        return { key: `day:${x.toDateString()}`, label };
    };

    const renderList = () => {
        const searchTerm = (searchInput?.value || '').toLowerCase();
        const matchesSearch = (n) => (n.title || '').toLowerCase().includes(searchTerm) || (n.message && n.message.toLowerCase().includes(searchTerm));
        const matchesFrom = (n) => fromFilter === 'all'
            || (fromFilter === 'system' ? !(n.actor && n.actor.name) : !!(n.actor && `a:${n.actor.assistantId}` === fromFilter));

        const actions = notificationsData.filter(n => kindOf(n) === 'action');
        const updates = notificationsData.filter(n => kindOf(n) === 'info');
        const questionItems = questions.map(questionItem);
        // Needs you = open actions (read or not — reading an action does not do it) + open questions.
        // The same two figures the badge counts on the server (notifications.ts needsYou).
        const needsCount = actions.filter(n => !isResolved(n)).length + questionItems.length;
        // Updates are cleared by reading, so their badge counts unread items.
        const unreadUpdates = updates.filter(n => !n.isRead).length;

        setCount('needs', needsCount);
        setCount('messages', teamUnread());
        setCount('updates', unreadUpdates);
        setTabStyles();
        syncMessagesPanel();
        paintMentorStrip();

        // Mark-all-read is an Updates control: an action is cleared by doing it and a question by
        // answering it, so "read" was never what clearing them meant.
        if (markAllBtn) {
            const show = activeTab === 'updates';
            markAllBtn.classList.toggle('hidden', !show);
            markAllBtn.style.display = show ? 'inline-flex' : 'none';
            markAllBtn.disabled = unreadUpdates === 0;
            markAllBtn.style.opacity = unreadUpdates === 0 ? '0.5' : '';
            markAllBtn.style.cursor = unreadUpdates === 0 ? 'not-allowed' : '';
        }
        if (activeTab === 'messages') return;

        const source = activeTab === 'needs' ? [...actions, ...questionItems, ...answeredHere] : updates;
        let list = source.filter(n => matchesSearch(n) && matchesFrom(n));
        // id as tiebreaker: rows can share an identical createdAt (e.g. created in the same
        // DB transaction), so date alone doesn't reliably keep the newest item first.
        const byCreated = (a, b) => new Date(b.createdAt) - new Date(a.createdAt) || String(b.id).localeCompare(String(a.id), undefined, { numeric: true });
        const done = (n) => (n._q ? !!n._answered : isResolved(n));
        if (activeTab === 'needs') {
            // AC2.2/AC2.3: sort by priority weight, then newest first. Open items stay above done
            // ones, so critical_action (priority 1) is pinned to the very top until its completion
            // criteria are met — this tab is about urgency, not recency.
            list.sort((a, b) => (done(a) ? 1 : 0) - (done(b) ? 1 : 0) || prioOf(a) - prioOf(b) || byCreated(a, b));
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
                const link = emptyStateEl.querySelector('[data-empty-link]');
                const filtered = !!searchTerm || fromFilter !== 'all';
                let linkLabel = null;
                if (filtered) {
                    if (title) title.textContent = searchTerm ? 'Nothing matches your search' : `Nothing from ${fromLabel()} here`;
                    if (sub) sub.textContent = activeTab === 'needs' ? 'Other things may still need you.' : 'There may be updates from others.';
                    linkLabel = 'Show everything';
                } else if (activeTab === 'needs') {
                    if (title) title.textContent = 'Nothing needs you';
                    if (sub) sub.textContent = 'When something needs a decision or an answer from you, it appears here.';
                    if (unreadUpdates) linkLabel = `See ${unreadUpdates} unread ${unreadUpdates === 1 ? 'update' : 'updates'}`;
                    else if (teamUnread()) linkLabel = 'Read your messages';
                } else {
                    if (title) title.textContent = 'No updates';
                    if (sub) sub.textContent = "We'll let you know when something happens.";
                }
                if (link) {
                    link.textContent = linkLabel || '';
                    link.classList.toggle('hidden', !linkLabel);
                    link.style.display = linkLabel ? '' : 'none';
                    link.onclick = () => {
                        if (filtered) {
                            if (searchInput) searchInput.value = '';
                            fromFilter = 'all';
                            if (assistantSelect) assistantSelect.value = 'all';
                            remember(FROM_STORAGE_KEY, 'all');
                            renderList();
                        } else showTab(unreadUpdates ? 'updates' : 'messages');
                    };
                }
            }
            // Nothing was drawn, so there is nothing to collapse — otherwise switching to an empty
            // tab while grouped leaves "Collapse all" sitting above the empty state.
            renderedGroupKeys = [];
            syncExpandAllBtn();
            return;
        }
        if (emptyStateEl) emptyStateEl.classList.add('hidden');

        const renderItem = (notif) => notif._q ? renderQuestionItem(notif)
            : activeTab === 'needs' ? renderActionItem(notif) : renderUpdateItem(notif);

        if (groupBy === 'none') {
            list.forEach(notif => listEl.appendChild(renderItem(notif)));
            renderedGroupKeys = [];
            syncExpandAllBtn();
            return;
        }

        // Which bucket a notification falls into. By assistant, the actor IS the group — items with
        // no actor are the system's own (same "Be More Swan" identity the cards use), so they get
        // their own bucket rather than being dropped or lumped under an arbitrary assistant.
        const groupOf = (notif) => {
            if (groupBy === 'assistant') {
                const a = notif.actor;
                return a && a.name
                    ? { key: `assistant:${a.assistantId}`, label: a.name, color: actorColor(a.assistantId, a.avatarColor) }
                    : { key: 'assistant:system', label: 'Be More Swan', color: null };
            }
            if (groupBy === 'day') return { ...dayOf(notif.createdAt), color: null };
            const type = notif.type || 'other';
            return { key: `type:${type}`, label: typeLabel(type), color: null };
        };

        // Group, preserving the existing sort order both across and within groups.
        const groups = new Map();
        list.forEach(notif => {
            const g = groupOf(notif);
            if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] });
            groups.get(g.key).items.push(notif);
        });

        // Each group is ONE <li> holding its own header + nested <ul> of cards, rather than a flat
        // run of sibling <li>s. Two reasons: the list's `divide-y` then draws a rule between GROUPS
        // (not between a header and its first card, which read as an unrelated row), and collapsing
        // is a class toggle on the nested list instead of a full re-render — so the scroll position,
        // focus and any in-flight card state survive a collapse.
        groups.forEach(({ key, label, color, items }) => {
            const isCollapsed = collapsedGroups.has(key);
            const bodyId = `notif-group-body-${key.replace(/[^a-z0-9]+/gi, '-')}`;

            const section = document.createElement('li');
            section.className = 'notif-group';
            section.dataset.groupKey = key;

            // A real <button> so Enter/Space, focus ring and screen-reader semantics come for free.
            // Sticky so the group a card belongs to stays on screen while its items scroll past.
            const header = document.createElement('button');
            header.type = 'button';
            header.className = 'notif-group-header w-full sticky top-0 z-10 px-4 py-2.5 bg-gray-50 border-y border-gray-200 text-xs font-bold text-gray-600 uppercase tracking-wide flex items-center justify-between gap-2 cursor-pointer select-none hover:bg-gray-100 focus:outline-none ring-inset focus-visible:ring-2 focus-visible:ring-emerald-200 transition-colors';
            header.setAttribute('aria-expanded', String(!isCollapsed));
            header.setAttribute('aria-controls', bodyId);
            // The dot repeats the assistant's card colour, so a group reads as the same identity.
            const dot = color ? `<span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${color}"></span>` : '';
            header.innerHTML = `
                <span class="flex items-center gap-2 min-w-0">
                    ${dot}<span class="truncate">${escHtml(label)}</span>
                    <span class="shrink-0 normal-case tracking-normal font-bold text-[11px] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600">${items.length}</span>
                </span>
                <svg class="notif-group-chevron w-4 h-4 text-gray-400 transition-transform shrink-0 ${isCollapsed ? '' : 'rotate-180'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                </svg>`;

            const body = document.createElement('ul');
            body.id = bodyId;
            body.className = 'divide-y divide-gray-100';
            // `hidden` alone loses to the utility classes the cards carry, so drive display directly.
            if (isCollapsed) body.style.display = 'none';
            items.forEach(notif => body.appendChild(renderItem(notif)));

            header.addEventListener('click', () => {
                const nowCollapsed = !collapsedGroups.has(key);
                if (nowCollapsed) collapsedGroups.add(key); else collapsedGroups.delete(key);
                body.style.display = nowCollapsed ? 'none' : '';
                header.setAttribute('aria-expanded', String(!nowCollapsed));
                header.querySelector('.notif-group-chevron')?.classList.toggle('rotate-180', !nowCollapsed);
                syncExpandAllBtn();
            });

            section.appendChild(header);
            section.appendChild(body);
            listEl.appendChild(section);
        });

        // "Collapse all" flips to "Expand all" once everything is shut, so one control covers both.
        renderedGroupKeys = [...groups.keys()];
        syncExpandAllBtn();
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
            // Updates only (the button is hidden elsewhere). We send the exact ids so actions keep
            // their own read state.
            const targets = notificationsData.filter(n => !n.isRead && kindOf(n) === 'info');
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

    TABS.forEach((t) => tabBtns[t]?.addEventListener('click', () => showTab(t)));
    // Arrow keys move between tabs, as in any tablist.
    tabBtns.needs?.parentElement?.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = TABS.indexOf(activeTab);
        const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
        showTab(next);
        tabBtns[next]?.focus();
    });
    if (searchInput) searchInput.addEventListener('input', renderList);
    if (groupBySelect) groupBySelect.addEventListener('change', () => {
        groupBy = GROUP_MODES.includes(groupBySelect.value) ? groupBySelect.value : 'none';
        // Switching mode starts every group open — carrying collapsed keys across modes would hide
        // items under a heading the user has not seen yet.
        collapsedGroups.clear();
        remember(GROUP_BY_STORAGE_KEY, groupBy);
        renderList();
    });
    if (assistantSelect) assistantSelect.addEventListener('change', () => {
        fromFilter = assistantSelect.value || 'all';
        remember(FROM_STORAGE_KEY, fromFilter);
        renderList();
    });

    if (expandAllBtn) expandAllBtn.addEventListener('click', () => {
        if (expandAllBtn.dataset.action === 'collapse') renderedGroupKeys.forEach(k => collapsedGroups.add(k));
        else collapsedGroups.clear();
        renderList();
    });

    // "One post per cross-post" (crosspost-view.js). The server does the combining, so a change
    // is a re-fetch. The inbox view is re-injected on every visit and this init runs each time,
    // so the previous visit's listener is swapped out rather than stacked.
    window.CrossPostView?.hydrate();
    window.CrossPostView?.sync();
    if (window._notifCrossPostListener) window.removeEventListener('bms:crosspost-view', window._notifCrossPostListener);
    window._notifCrossPostListener = () => { if (document.body.contains(listEl)) loadData(); };
    window.addEventListener('bms:crosspost-view', window._notifCrossPostListener);
    // The badge poll found something new, or its numbers moved: re-read while this page is open.
    // Swapped, not stacked, for the same reason as above.
    if (window._notifArrivedListener) document.removeEventListener('bms:notifications-arrived', window._notifArrivedListener);
    window._notifArrivedListener = () => { if (document.body.contains(listEl) && activeTab !== 'messages') loadData(); };
    document.addEventListener('bms:notifications-arrived', window._notifArrivedListener);
    if (window._notifCountsListener) document.removeEventListener('bms:notif-counts', window._notifCountsListener);
    window._notifCountsListener = () => { if (document.body.contains(listEl)) setCount('messages', teamUnread()); };
    document.addEventListener('bms:notif-counts', window._notifCountsListener);
    // Messages needs no notification data to show; open it at once rather than after the fetch.
    if (activeTab === 'messages') renderList();
    restoreGroupBy();
    loadData();
    loadMentorOpen();
};

// Global click handler for routing to the Support area
// Defined by help.js (opens the Tickets tab reliably, after the view has loaded); this is only the
// fallback for a page without it. Never overwrite help.js's version.
if (typeof window.routeToSupportTicket !== 'function') {
    window.routeToSupportTicket = function () {
        if (typeof window.openHelpTab === 'function') return window.openHelpTab('tickets');
        window.loadView && window.loadView('help');
    };
}

// ── Header Action Center popover ──────────────────────────────────────────────
// Quick triage from the workspace bell: two tabs (Needs you / Updates) plus a Team Chat link, compact
// actor-led cards built from the SAME window.NotifKit as the full Notifications page, a single
// primary CTA per item, and "Open all" for the page itself. Needs you holds open actions AND
// unanswered Team questions — the same two things the bell's red number counts. Opening the popover marks
// nothing read/resolved — acting on an item does. Kept deliberately small: no search,
// grouping or read-toggle here — those live on the full page.
window.NotificationPopover = (function () {
    const K = window.NotifKit;
    const MAX_PER_TAB = 5;        // cap the popover; overflow lives behind "Open all".
    let panel = null, listEl = null, tabActionBtn = null, tabUpdatesBtn = null, teamChatBtn = null, markAllBtn = null;
    let anchorEl = null, activeTab = 'action', data = [], questions = [];

    const openInbox = () => {
        close();
        const tab = activeTab === 'action' ? 'needs' : 'updates';
        if (window.loadView) window.loadView('notifications', { tab });
        else window.location.href = 'workspace.html?view=notifications';
    };

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
                        <button type="button" id="notif-pop-inbox" class="text-xs font-bold text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-1">Open all<span aria-hidden="true">&rarr;</span></button>
                    </div>
                </div>
                <div class="flex gap-1 px-3 pt-2 shrink-0">
                    <button type="button" id="notif-pop-tab-action" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg"></button>
                    <button type="button" id="notif-pop-tab-updates" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg"></button>
                    <button type="button" id="notif-pop-team-chat" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg"></button>
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
        // Team Chat is a conversation, not a list — a link to Notifications → Messages, not a popover tab.
        teamChatBtn = panel.querySelector('#notif-pop-team-chat');
        teamChatBtn.addEventListener('click', () => {
            close();
            if (window.loadView) window.loadView('notifications', { tab: 'messages' });
            else window.location.href = 'workspace.html?view=team';
        });
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
        // Right-aligned to the bell, but never past the left edge: on a phone the bell sits well in
        // from the right, and the panel (as wide as the screen allows) hung 40px off the left side.
        const w = panel.firstElementChild ? panel.firstElementChild.getBoundingClientRect().width : 0;
        const right = Math.max(12, window.innerWidth - r.right);
        panel.style.right = `${Math.round(Math.max(12, Math.min(right, window.innerWidth - w - 12)))}px`;
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

    /** Enable/disable "Mark all read" for the open tab, and label it with what it will clear.
     *  Updates only: what needs you is cleared by doing it, not by reading it. */
    const syncMarkAllBtn = () => {
        if (!markAllBtn) return;
        markAllBtn.style.display = activeTab === 'action' ? 'none' : '';
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
                    ${action ? `<button type="button" class="pop-cta px-3 py-1.5 ${st.cta} text-xs font-bold rounded-lg transition whitespace-nowrap">${K.escHtml(action.label)}</button>` : ''}
                    ${isAction ? '<button type="button" class="pop-done text-[11px] font-semibold text-emerald-700 hover:text-emerald-900 whitespace-nowrap">Done</button>' : ''}
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
        // Close an action without doing it — same as "Mark as done" on the page.
        li.querySelector('.pop-done')?.addEventListener('click', (e) => {
            e.stopPropagation();
            n.isRead = true;
            n.resolvedAt = new Date().toISOString();
            render();
            patch(n.id, { resolved: true });
        });
        li.querySelector('.pop-cta')?.addEventListener('click', (e) => {
            e.stopPropagation();
            // Flip locally too — the PATCH only refreshes the badge, so reopening the popover
            // before its next fetch would still show this item as unread.
            n.isRead = true;
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

    // A Team question: answered on the full page, where its buttons and the reply are.
    const questionCard = (n) => {
        const st = K.styleOf(n);
        const li = document.createElement('li');
        li.className = 'flex gap-3 p-3 hover:bg-gray-50 transition-colors';
        li.innerHTML = `
            ${K.avatarHTML(n, st)}
            <div class="flex-1 min-w-0">
                ${K.actorEyebrowHTML(n)}
                <p class="text-sm font-bold text-gray-900 line-clamp-2">${K.escHtml(n.title)}</p>
                <div class="mt-2 flex items-center gap-2">
                    <button type="button" class="pop-answer px-3 py-1.5 btn-primary text-xs font-bold rounded-lg transition whitespace-nowrap">Answer</button>
                    <span class="text-[11px] text-gray-400">${K.fmtDate(n.createdAt)}</span>
                </div>
            </div>`;
        li.querySelector('.pop-answer').addEventListener('click', (e) => { e.stopPropagation(); activeTab = 'action'; openInbox(); });
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
        tabActionBtn.innerHTML = `Needs you${pill(openActions, 'bg-red-100 text-red-700')}`;
        tabUpdatesBtn.innerHTML = `Updates${pill(unreadUpdates, 'bg-gray-100 text-gray-700')}`;
        // The same unread Team figure the page's Messages tab shows.
        teamChatBtn.className = off;
        teamChatBtn.innerHTML = `Team Chat${pill(Number(window._notifCounts?.teamUnread) || 0, 'bg-gray-100 text-gray-700')}<span aria-hidden="true">&rarr;</span>`;
    };

    const render = () => {
        const actions = data.filter(n => K.kindOf(n) === 'action');
        const updates = data.filter(n => K.kindOf(n) === 'info');
        const openActions = actions.filter(n => !K.isResolved(n)).length + questions.length;
        const unreadUpdates = updates.filter(n => !n.isRead).length;
        styleTabs(openActions, unreadUpdates);
        syncMarkAllBtn();

        const byCreated = (a, b) => new Date(b.createdAt) - new Date(a.createdAt) || (b.id - a.id);
        let list = (activeTab === 'action' ? [...actions, ...questions] : updates).slice();
        if (activeTab === 'action') {
            list.sort((a, b) => (K.isResolved(a) ? 1 : 0) - (K.isResolved(b) ? 1 : 0) || K.prioOf(a) - K.prioOf(b) || byCreated(a, b));
        } else {
            list.sort(byCreated);
        }
        const shown = list.slice(0, MAX_PER_TAB);

        listEl.innerHTML = '';
        if (shown.length === 0) {
            listEl.appendChild(emptyRow(activeTab === 'action' ? 'Nothing needs you' : 'No updates yet'));
        } else {
            shown.forEach(n => listEl.appendChild(n._q ? questionCard(n) : compactCard(n)));
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
            const [res, team] = await Promise.all([
                fetch('/.netlify/functions/notifications'),
                // Unanswered questions from the team. A failed read is no questions, never a failed popover.
                fetch('/.netlify/functions/team', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
                    body: JSON.stringify({ action: 'list', openQuestions: true }),
                }).then(r => (r.ok ? r.json() : null)).catch(() => null),
            ]);
            questions = ((team && team.messages) || []).filter(m => m.question && !m.question.answered).map((m) => {
                const a = ((team && team.assistants) || []).find(x => Number(x.id) === Number(m.from.id));
                return {
                    _q: m, id: `q${m.id}`, type: 'question', kind: 'action', createdAt: m.createdAt, title: m.body,
                    actor: m.from.id ? { assistantId: m.from.id, name: m.from.name, avatarColor: a?.avatarColor ?? null, avatarLetter: a?.avatarLetter ?? null } : null,
                };
            });
            if (res.ok) {
                const j = await res.json();
                data = j.notifications || [];
                // Default to whichever tab has something waiting (mirrors the full page).
                activeTab = data.some(n => K.kindOf(n) === 'action' && !K.isResolved(n)) || questions.length ? 'action' : 'updates';
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