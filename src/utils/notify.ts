// src/utils/notify.ts
// US-COMMS-2: the ONE way to write an in-app notification.
//
// Every call site goes through createNotification()/createNotifications() so the copy lives
// in an admin-editable template (notification_templates, defaulting to
// notification-templates-catalog.ts) instead of being hardcoded at the insert.
//
//   await createNotification(db, 'assistant_hired', {
//       userId,
//       context: { assistant: { name: master.name } },
//       metadata: { assistantId: created.id },
//   });
//
// ── Escaping contract (this is load-bearing — read before changing) ──────────
// renderMergeVars(..., escape=true) escapes the RESOLVED VALUES but leaves the template text
// untouched. So a stored title/message is:  admin-authored markup + HTML-escaped user data.
// That's what makes it safe for an admin to use inline formatting in copy that also
// interpolates user-controlled values (assistant names, org names, ticket subjects).
// The client renders these through the shared sanitiser in notifications.js — which also
// protects legacy rows written before this module existed, whose values are NOT escaped.
//
// ── Never throws ─────────────────────────────────────────────────────────────
// Notification inserts were uniformly best-effort at the call sites (.catch(() => {}) or a
// try/catch) because a failed notification must never break the flow that triggered it.
// This module preserves that: it resolves, logs and swallows. Callers need no try/catch.
//
// ── One documented exception to "always template-keyed" ──────────────────────
// createAdminMessage() at the bottom of this file takes literal copy instead of a templateKey.
// It is not an oversight — see the comment there for why an admin typing to one user has no
// template to key on, and why it is deliberately kept narrow rather than generalised.

import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { notifications, notificationTemplates, userProfiles } from '../../db/schema';
import { escapeHtml, renderMergeVars, type MergeContext } from './email-template';
import { getNotificationDefault } from './notification-templates-catalog';
import { isPushEnabledFor } from './notification-prefs';
import { isPushConfigured, sendPushToUser } from './web-push';

/**
 * Minimal structural type for a drizzle handle. Accepts both the top-level db from getDb()
 * and a transaction handle (db.transaction(async (tx) => ...)), which are different types
 * but share the insert() shape this module uses.
 */
type Inserter = {
    insert: (table: typeof notifications) => { values: (rows: any) => PromiseLike<unknown> };
};

export interface NotifyOptions {
    userId: number;
    /** Nested merge context, e.g. { assistant: { name: 'Social Media Assistant' } }. */
    context?: MergeContext;
    metadata?: Record<string, unknown> | null;
    /** Denormalised assistant link, where the notifications row carries one. */
    assistantId?: number | null;
    /**
     * Explicit category override. Normally derived by the DB trigger from `type`
     * (db/notifications-categorization.sql); only pass this where the call site already did.
     */
    category?: string;
    /**
     * Overrides the catalog's `type` for templates whose call site stamps a computed type
     * (e.g. refresh-social-tokens uses `${serviceName}_token_refresh_failed` so that
     * resolve-on-reconnect can match a single platform). Use sparingly — `type` drives
     * routing, so an unrecognised value silently falls back to the 'informational' category.
     */
    typeOverride?: string;
    isRead?: boolean;
}

interface ResolvedTemplate {
    type: string;
    title: string;
    message: string;
    isActive: boolean;
}

/**
 * Resolve a template's copy: admin-edited DB row first, in-code catalog otherwise.
 * Tolerates the table not existing yet (pre-migration) so a missing migration degrades to
 * catalog copy rather than dropping the notification.
 */
async function loadTemplate(templateKey: string): Promise<ResolvedTemplate | null> {
    const def = getNotificationDefault(templateKey);

    try {
        const db = getDb();
        const [row] = await db
            .select({
                title: notificationTemplates.title,
                message: notificationTemplates.message,
                isActive: notificationTemplates.isActive,
            })
            .from(notificationTemplates)
            .where(eq(notificationTemplates.templateKey, templateKey))
            .limit(1);
        if (row?.title) {
            return {
                // `type` is never taken from the DB — routing stays code-owned.
                type: def?.type ?? 'system',
                title: row.title,
                message: row.message ?? '',
                isActive: row.isActive,
            };
        }
    } catch (err: any) {
        const msg: string = err?.message || '';
        if (!(msg.includes('relation') && msg.includes('does not exist'))) {
            console.error(`[notify] DB template read failed for "${templateKey}":`, msg);
        }
        // fall through to catalog
    }

    if (!def) return null;
    return { type: def.type, title: def.title, message: def.message, isActive: true };
}

/** Build the row payload for one recipient. */
function buildRow(tpl: ResolvedTemplate, userId: number, opts: NotifyOptions) {
    const ctx = opts.context ?? {};
    return {
        userId,
        type: opts.typeOverride ?? tpl.type,
        title: renderMergeVars(tpl.title, ctx),
        message: renderMergeVars(tpl.message, ctx) || null,
        ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
        ...(opts.assistantId !== undefined ? { assistantId: opts.assistantId } : {}),
        ...(opts.category !== undefined ? { category: opts.category } : {}),
        ...(opts.isRead !== undefined ? { isRead: opts.isRead } : {}),
    };
}

/**
 * Render a template and insert one in-app notification. Best-effort: logs and returns false
 * on any failure (unknown key, deactivated template, DB error) rather than throwing.
 */
export async function createNotification(
    db: Inserter,
    templateKey: string,
    opts: NotifyOptions,
): Promise<boolean> {
    try {
        const tpl = await loadTemplate(templateKey);
        if (!tpl) {
            console.error(`[notify] Unknown template "${templateKey}" — notification NOT created.`);
            return false;
        }
        if (!tpl.isActive) return false; // admin switched this notification off

        const row = buildRow(tpl, opts.userId, opts);
        await db.insert(notifications).values(row);
        // Third channel. Deliberately AFTER the insert and deliberately not awaited into the
        // return value: the in-app row is the source of truth, and a push that fails must never
        // turn a successfully-recorded notification into a reported failure.
        void deliverPush(db, [opts.userId], row);
        return true;
    } catch (err: any) {
        console.warn(`[notify] insert failed for "${templateKey}" (non-blocking):`, err?.message || err);
        return false;
    }
}

/**
 * Fan a written notification out to the Web Push channel.
 *
 * ── Why the gating lives here and not at the call sites ─────────────────────────────────────────
 * 106 call sites write notifications. Asking each to decide whether to also push would guarantee
 * drift, and the in-app/email channels already learned that lesson — this module is the ONE write
 * path precisely so a channel can be added in one place. A call site that knows nothing about push
 * gets correct push behaviour for free.
 *
 * Preference resolution mirrors the email fallback: the per-category push preference, honouring a
 * per-assistant override when the row is assistant-attributed. Push is never locked, so unlike
 * inApp/email a user really can turn every category off — which is the point.
 *
 * Never throws, never blocks. A user with no subscriptions costs one indexed query.
 */
async function deliverPush(db: Inserter, userIds: number[], row: ReturnType<typeof buildRow>): Promise<void> {
    try {
        // Cheapest possible exit: environments without VAPID keys skip the query entirely, which
        // is every environment until push is switched on.
        if (!isPushConfigured()) return;

        const anyDb = db as any;
        if (typeof anyDb.select !== 'function') return; // a transaction shape we cannot read from

        const profiles = await anyDb
            .select({
                userId: userProfiles.userId,
                pushPrefs: userProfiles.pushPreferences,
                assistantPrefs: userProfiles.assistantNotifPrefs,
            })
            .from(userProfiles)
            .where(inArray(userProfiles.userId, userIds));

        // A user with no profile row has never set a preference, so the category defaults apply —
        // resolved by passing null, exactly as isEmailEnabledFor does.
        const byUser = new Map<number, { pushPrefs: any; assistantPrefs: any }>(
            profiles.map((p: any) => [p.userId, { pushPrefs: p.pushPrefs, assistantPrefs: p.assistantPrefs }]),
        );

        await Promise.all(userIds.map(async (userId) => {
            const p = byUser.get(userId);
            if (!isPushEnabledFor(p?.pushPrefs ?? null, p?.assistantPrefs ?? null, row.assistantId ?? null, row.type)) {
                return;
            }
            await sendPushToUser(anyDb, userId, {
                title: stripMarkup(row.title),
                body: stripMarkup(row.message ?? ''),
                url: '/workspace.html?view=notifications',
                notificationId: undefined,
            });
        }));
    } catch (err: any) {
        // Includes the pre-migration case (no push_preferences column / no push_subscriptions
        // table). Warn, never throw — the notification itself already landed.
        console.warn('[notify] push delivery skipped (non-blocking):', err?.message || err);
    }
}

/**
 * Template copy may contain the inline markup admins are allowed to use (b/strong/em/i/u/br/span —
 * see the escaping contract at the top of this file). The in-app feed renders that through a
 * sanitiser; an OS notification is plain text and would show the tags literally, so strip them.
 */
function stripMarkup(s: string): string {
    return String(s ?? '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Fan one template out to many recipients. Loads the template once and inserts in batches of
 * 100 (the batch size the existing fan-out call sites used to stay under DB limits).
 * Returns the number of rows written.
 */
export async function createNotifications(
    db: Inserter,
    templateKey: string,
    userIds: number[],
    opts: Omit<NotifyOptions, 'userId'> = {},
): Promise<number> {
    if (!userIds.length) return 0;
    try {
        const tpl = await loadTemplate(templateKey);
        if (!tpl) {
            console.error(`[notify] Unknown template "${templateKey}" — ${userIds.length} notification(s) NOT created.`);
            return 0;
        }
        if (!tpl.isActive) return 0;

        const rows = userIds.map((userId) => buildRow(tpl, userId, { ...opts, userId }));
        for (let i = 0; i < rows.length; i += 100) {
            await db.insert(notifications).values(rows.slice(i, i + 100));
        }
        // Every row in a fan-out shares one template, so title/message/type/assistantId are
        // identical — one representative row carries all the push needs, and preferences are
        // still resolved per user inside deliverPush.
        if (rows.length) void deliverPush(db, userIds, rows[0]);
        return rows.length;
    } catch (err: any) {
        console.warn(`[notify] fan-out failed for "${templateKey}" (non-blocking):`, err?.message || err);
        return 0;
    }
}

/**
 * Render a template's copy without inserting. For call sites that need the resolved strings
 * for a second channel (e.g. an email that must match the in-app wording).
 */
export async function renderNotification(
    templateKey: string,
    context: MergeContext = {},
): Promise<{ title: string; message: string } | null> {
    const tpl = await loadTemplate(templateKey);
    if (!tpl) return null;
    return {
        title: renderMergeVars(tpl.title, context),
        message: renderMergeVars(tpl.message, context),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ad-hoc admin → user message (the documented exception noted in the header)
// ─────────────────────────────────────────────────────────────────────────────
// Everything above renders copy an admin edited AHEAD of time, keyed by templateKey, so the
// wording of an automated notification is reviewable before it ever fires. An admin writing
// directly to ONE user has no template to key on: the message is composed in the moment and
// is the copy. Hence a separate, deliberately narrow entry point — literal title/message, one
// recipient, one type, no merge context. Do not widen it into a back door for automated
// notifications; those still belong in notification-templates-catalog.ts, where they can be
// reviewed and switched off.
//
// Escaping is STRICTER here than on the template path, and the asymmetry is the point.
// Template text is admin-authored markup that may legitimately carry inline formatting, with
// only the interpolated user values escaped. This body is a person typing a sentence, so it is
// escaped WHOLE and only newlines become markup. That way the admin sees exactly what the user
// sees — rather than typing a <div> or an <a href> that the client-side allow-list in
// notifications.js silently swallows (it permits only b/strong/em/i/u/br/span, and strips every
// attribute, so links cannot render in a notification body at all).
//
// `category`/`priority`/`is_dismissible` are left to the DB trigger
// (db/notifications-categorization.sql). 'admin_message' is absent from its CASE, so it lands
// on the 'informational' default — dismissible, unpinned — which is what an FYI from the team
// should be. src/utils/notification-actions.ts defaults it the same way.

/** The notifications.type stamped on every ad-hoc admin message. */
export const ADMIN_MESSAGE_TYPE = 'admin_message';

/** Escape human-typed text, then promote newlines to the one tag the client will render. */
function escapeAdminText(s: string): string {
    return escapeHtml(s).replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * Insert a one-off, admin-composed in-app message for a single user.
 *
 * Best-effort like the rest of this module — returns false rather than throwing. NOTE that
 * unlike the automated call sites, this one has a human waiting on the result, so the caller
 * should surface a false as a failure instead of ignoring it.
 */
export async function createAdminMessage(
    db: Inserter,
    opts: { userId: number; title: string; message: string },
): Promise<boolean> {
    try {
        await db.insert(notifications).values({
            userId: opts.userId,
            type: ADMIN_MESSAGE_TYPE,
            title: escapeHtml(opts.title),
            message: escapeAdminText(opts.message),
        });
        return true;
    } catch (err: any) {
        console.error('[notify] admin message insert failed:', err?.message || err);
        return false;
    }
}
