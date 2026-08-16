// src/utils/web-push.ts
// Delivering a notification to a user's devices as a Web Push message.
//
// This is the third delivery channel, alongside the in-app bell (notify.ts writes `notifications`)
// and email (notification-email-fallback.ts). It is the one that reaches someone who does not have
// the app open: a Service Worker wakes on the push and raises an OS-level notification, which on
// both Android and iOS looks and behaves like a native app alert with no App Store presence.
//
// ── Configuration ───────────────────────────────────────────────────────────────────────────────
// Needs three env vars. Generate the pair with `node scripts/gen-vapid-keys.mjs`:
//   VAPID_PUBLIC_KEY   — also served to the browser; safe to expose, it is a public key
//   VAPID_PRIVATE_KEY  — secret
//   VAPID_SUBJECT      — a mailto: or https: URL identifying the sender (RFC 8292 requires it)
//
// ⚠️ The keypair is IDENTITY, not just credentials. Every existing subscription is bound to the
// public key it was created with, so rotating the pair silently invalidates every subscription in
// push_subscriptions — users stop receiving alerts and nothing reports an error, because the push
// service answers 403 per-message rather than telling us the key changed. Rotate only deliberately,
// and expire the table when you do.
//
// ── Never throws ────────────────────────────────────────────────────────────────────────────────
// Same contract as notify.ts: a push failure must never break the flow that triggered the
// notification. Everything here resolves, logs and swallows.

import { and, eq, isNull } from 'drizzle-orm';
import webpush from 'web-push';
import { pushSubscriptions } from '../../db/schema';

type Db = any;

/** After this many consecutive failures a subscription is retired. */
const MAX_FAILURES = 5;

let configured: boolean | null = null;

/**
 * Configure web-push from the environment, once per cold start.
 *
 * Returns false when the keys are absent, which is the normal state of any environment that has
 * not had them set yet — the caller then skips push entirely rather than logging an error per
 * notification. This is what lets the feature deploy dark and be switched on by setting env vars.
 */
export function isPushConfigured(): boolean {
    if (configured !== null) return configured;
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:hello@bemoreswan.com';
    if (!publicKey || !privateKey) {
        configured = false;
        return false;
    }
    try {
        webpush.setVapidDetails(subject, publicKey, privateKey);
        configured = true;
    } catch (err) {
        // A malformed key is a deploy-time mistake, not a per-notification one — log it loudly
        // once, then behave as if push is switched off.
        console.error('[web-push] VAPID keys present but invalid; push disabled', err);
        configured = false;
    }
    return configured;
}

/** The public key the browser needs to create a subscription. Null when push is not configured. */
export function vapidPublicKey(): string | null {
    return isPushConfigured() ? (process.env.VAPID_PUBLIC_KEY?.trim() || null) : null;
}

export interface PushPayload {
    title: string;
    body: string;
    /** Where clicking the notification should take the user. Relative to the site root. */
    url?: string;
    /**
     * Collapse key. Two notifications sharing a tag replace each other on the lock screen instead
     * of stacking — the right behaviour for "3 posts awaiting approval" superseding "2 posts
     * awaiting approval", and the wrong behaviour for two unrelated alerts.
     */
    tag?: string;
    /** The notifications row this came from, so a click can mark it read. */
    notificationId?: number;
}

export interface PushResult {
    sent: number;
    failed: number;
    /** Subscriptions retired during this send (dead endpoints). */
    retired: number;
}

/**
 * Send one payload to every live subscription a user has.
 *
 * ── Why 404/410 must retire the row, not just count a failure ────────────────────────────────────
 * A push service returns 404 or 410 when the subscription no longer exists — the user cleared site
 * data, uninstalled the PWA, or the browser rotated it. That is permanent. Left in the table, every
 * future notification pays an HTTP request to learn the same thing again, forever, for every user
 * who has ever unsubscribed. Retiring on those two codes is what keeps the fan-out bounded.
 *
 * Anything else (a 500 from the push service, a timeout) is transient and only increments
 * failure_count, so a bad afternoon at Google does not permanently unsubscribe an entire user base.
 */
export async function sendPushToUser(
    db: Db, userId: number, payload: PushPayload,
): Promise<PushResult> {
    const result: PushResult = { sent: 0, failed: 0, retired: 0 };
    if (!isPushConfigured()) return result;

    let subs: { id: number; endpoint: string; p256dh: string; auth: string; failureCount: number }[];
    try {
        subs = await db
            .select({
                id: pushSubscriptions.id,
                endpoint: pushSubscriptions.endpoint,
                p256dh: pushSubscriptions.p256dh,
                auth: pushSubscriptions.auth,
                failureCount: pushSubscriptions.failureCount,
            })
            .from(pushSubscriptions)
            .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.expiredAt)));
    } catch (err) {
        // Pre-migration environments have no table. Not an error worth shouting about per
        // notification — the same tolerance notify.ts has for a missing templates table.
        console.error('[web-push] could not load subscriptions (is db/push-notifications.sql applied?)', err);
        return result;
    }
    if (!subs.length) return result;

    const body = JSON.stringify({
        title: payload.title,
        body: payload.body,
        url: payload.url ?? '/workspace.html',
        tag: payload.tag,
        notificationId: payload.notificationId,
    });

    await Promise.all(subs.map(async (sub) => {
        try {
            await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                body,
                {
                    // Hold for up to a day if the device is offline; past that the alert is stale
                    // enough that delivering it is worse than dropping it.
                    TTL: 60 * 60 * 24,
                    urgency: 'normal',
                },
            );
            result.sent++;
            await db.update(pushSubscriptions)
                .set({ lastSuccessAt: new Date(), failureCount: 0, updatedAt: new Date() })
                .where(eq(pushSubscriptions.id, sub.id))
                .catch(() => {});
        } catch (err) {
            const status = (err as { statusCode?: number })?.statusCode;
            const dead = status === 404 || status === 410;
            const nextCount = sub.failureCount + 1;
            const retire = dead || nextCount >= MAX_FAILURES;
            result.failed++;
            if (retire) result.retired++;
            try {
                await db.update(pushSubscriptions)
                    .set({
                        failureCount: nextCount,
                        ...(retire ? { expiredAt: new Date() } : {}),
                        updatedAt: new Date(),
                    })
                    .where(eq(pushSubscriptions.id, sub.id));
            } catch { /* bookkeeping only */ }
            if (!dead) {
                console.error('[web-push] delivery failed', { subscriptionId: sub.id, status });
            }
        }
    }));

    return result;
}
