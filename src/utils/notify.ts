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

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { notifications, notificationTemplates } from '../../db/schema';
import { renderMergeVars, type MergeContext } from './email-template';
import { getNotificationDefault } from './notification-templates-catalog';

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
    /** Nested merge context, e.g. { assistant: { name: 'Aura' } }. */
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

        await db.insert(notifications).values(buildRow(tpl, opts.userId, opts));
        return true;
    } catch (err: any) {
        console.warn(`[notify] insert failed for "${templateKey}" (non-blocking):`, err?.message || err);
        return false;
    }
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
