// src/utils/webhooks.ts
// Telling a tenant's own systems what just happened in their audience.
//
// ── ⚠️ WHY THIS WAS DEFERRED TWICE, AND WHAT CHANGED ────────────────────────────────────────────
// Outbound webhooks need retries; retries need something on a schedule; and a schedule whose
// failure is SILENT has taken two features out in this codebase already. So the retry story is the
// design, not an afterthought:
//
//   1. THE FIRST ATTEMPT IS INLINE, at the event. Most succeed there, so the queue holds failures
//      rather than traffic — which makes a backlog mean something.
//   2. RETRIES DRAIN ON AN EXISTING SWEEP (process-newsletter-sends, every five minutes). Nothing
//      new to stop running.
//   3. A FAILING ENDPOINT BECOMES THE TENANT'S PROBLEM, VISIBLY: after MAX_CONSECUTIVE_FAILURES it
//      is disabled and they are told. The failure mode is not "deliveries quietly stop".
//
// ── ⚠️ AND THE PART THAT IS NOT ABOUT RELIABILITY AT ALL ────────────────────────────────────────
// We are about to make our own servers POST to a URL a tenant typed. That is a server-side request
// forgery primitive if it is not fenced: `http://169.254.169.254/…` is the cloud metadata service,
// and `http://localhost:5432` is somebody's database. isDeliverableUrl below is not a validation
// nicety — it is the fence.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { webhookDeliveries, webhookEndpoints } from '../../db/schema';
import { getSecret, storeSecret } from './vault';

type Db = ReturnType<typeof getDb>;

/** The closed list. A receiver writing a switch statement needs it to stay closed. */
export const WEBHOOK_EVENTS = [
    'contact.subscribed',
    'contact.unsubscribed',
    'contact.bounced',
    'contact.complained',
    'newsletter.sent',
] as const;
export type WebhookEvent = typeof WEBHOOK_EVENTS[number];

/** Attempts, then the endpoint is left alone until it succeeds again or is disabled. */
export const MAX_ATTEMPTS = 6;
/** Consecutive failed DELIVERIES before the endpoint itself is switched off and the tenant told. */
export const MAX_CONSECUTIVE_FAILURES = 20;
/** A receiver that has not answered in this long is not going to. */
export const DELIVERY_TIMEOUT_MS = 5000;

/** 1m, 5m, 25m, 2h, 10h — bounded so a broken receiver is not hammered. */
export function backoffMs(attempt: number): number {
    return Math.min(60_000 * Math.pow(5, Math.max(0, attempt - 1)), 10 * 60 * 60 * 1000);
}

export const vaultRefFor = (endpointId: number) => `webhook:${endpointId}`;

export function mintSigningSecret(): string {
    return `whsec_${randomBytes(24).toString('hex')}`;
}

/**
 * The signature a receiver checks.
 *
 * ⚠️ The TIMESTAMP is inside the signed string, not just a header beside it. Signing the body alone
 * lets anyone who captured one request replay it for ever; signing `timestamp.body` means a
 * receiver can reject anything older than a few minutes and the signature still covers it.
 */
export function signPayload(secret: string, timestamp: number, body: string): string {
    return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Provided so our own tests — and a tenant reading them — verify the way a receiver would. */
export function verifySignature(secret: string, timestamp: number, body: string, signature: string): boolean {
    const expected = signPayload(secret, timestamp, body);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature || ''), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * ⚠️ THE SSRF FENCE. Everything here is a refusal, and each one has a specific attack behind it.
 *
 * Refused: anything but https (a plaintext webhook carries subscriber addresses across the open
 * internet); loopback and link-local (169.254.169.254 is the cloud metadata endpoint, and
 * 127.0.0.1:5432 is a database); RFC1918 and unique-local ranges (a tenant's URL should not be able
 * to make OUR network scan itself); and a bare hostname with no dot (which resolves inside a
 * container's search domain).
 *
 * A hostname that RESOLVES to a private address is not caught here — that needs a DNS lookup at
 * delivery time and is a genuine residual gap, named rather than assumed away. It is narrowed by
 * the https requirement, since obtaining a valid certificate for a name pointing at 10.x is not
 * something a casual attacker does.
 */
export function isDeliverableUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
    let parsed: URL;
    try { parsed = new URL(String(raw || '').trim()); }
    catch { return { ok: false, reason: 'That is not a URL we can call.' }; }

    if (parsed.protocol !== 'https:') {
        return { ok: false, reason: 'The URL must start with https:// — these messages carry your subscribers\' email addresses.' };
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
        return { ok: false, reason: 'That address is not reachable from the internet.' };
    }
    // Literal IPs in the ranges that are ours, theirs, or the cloud's.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        const p = host.split('.').map(Number);
        const isPrivate =
            p[0] === 10 ||
            p[0] === 127 ||
            (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
            (p[0] === 192 && p[1] === 168) ||
            (p[0] === 169 && p[1] === 254) ||
            p[0] === 0 || p[0] >= 224;
        if (isPrivate) return { ok: false, reason: 'That address is on a private or reserved network.' };
    }
    if (host.includes(':') || parsed.hostname.startsWith('[')) {
        // IPv6 literals — unique-local (fc00::/7) and loopback are the same class of problem, and
        // an IPv6 literal in a tenant-typed webhook URL is far more likely to be an attack than a
        // legitimate configuration.
        return { ok: false, reason: 'Use a hostname rather than an IPv6 address.' };
    }
    return { ok: true, url: parsed.toString() };
}

export interface EmitArgs {
    organisationId: number;
    event: WebhookEvent;
    data: Record<string, unknown>;
}

/**
 * Queue an event for every endpoint that asked for it, and try the first delivery immediately.
 *
 * ⚠️ NEVER THROWS. It is called from the middle of unsubscribing somebody and from the end of a
 * send; a webhook failing must not fail either. Every error is swallowed and logged, and the
 * delivery row is what remembers to try again.
 */
export async function emitWebhook(db: Db, args: EmitArgs): Promise<number> {
    try {
        const endpoints = await db
            .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
            .from(webhookEndpoints)
            .where(and(
                eq(webhookEndpoints.organisationId, args.organisationId),
                eq(webhookEndpoints.isActive, true),
            ));

        const wanted = endpoints.filter((e) =>
            String(e.events || '').split(',').map((s) => s.trim()).includes(args.event));
        if (!wanted.length) return 0;

        const payload = {
            event: args.event,
            createdAt: new Date().toISOString(),
            data: args.data,
        };

        const rows = await db.insert(webhookDeliveries).values(
            wanted.map((e) => ({
                organisationId: args.organisationId,
                endpointId: e.id,
                event: args.event,
                payload,
                status: 'pending',
                nextAttemptAt: new Date(),
            })),
        ).returning({ id: webhookDeliveries.id });

        // The first attempt, now. Most succeed here, which is what keeps the queue meaningful.
        await deliverPending(db, { ids: rows.map((r) => r.id) });
        return rows.length;
    } catch (err) {
        console.error('[webhooks] could not queue an event', { event: args.event, orgId: args.organisationId }, err);
        return 0;
    }
}

export interface DrainResult {
    attempted: number;
    delivered: number;
    failed: number;
    disabled: number;
}

/**
 * Send whatever is pending and due (or a specific set of ids, for the inline first attempt).
 *
 * Called from the newsletter send sweep — see the header for why it does not have a schedule of its
 * own. Never throws.
 */
export async function deliverPending(
    db: Db,
    opts: { ids?: number[]; limit?: number; now?: Date } = {},
): Promise<DrainResult> {
    const out: DrainResult = { attempted: 0, delivered: 0, failed: 0, disabled: 0 };
    const now = opts.now ?? new Date();

    try {
        const due = await db
            .select({
                id: webhookDeliveries.id,
                endpointId: webhookDeliveries.endpointId,
                event: webhookDeliveries.event,
                payload: webhookDeliveries.payload,
                attempts: webhookDeliveries.attempts,
                organisationId: webhookDeliveries.organisationId,
            })
            .from(webhookDeliveries)
            .where(opts.ids?.length
                ? inArray(webhookDeliveries.id, opts.ids)
                : and(
                    eq(webhookDeliveries.status, 'pending'),
                    lte(webhookDeliveries.nextAttemptAt, now),
                ))
            .limit(opts.limit ?? 50);
        if (!due.length) return out;

        // One lookup for the endpoints involved, rather than one per delivery.
        const endpointIds = [...new Set(due.map((d) => d.endpointId))];
        const endpoints = await db
            .select()
            .from(webhookEndpoints)
            .where(inArray(webhookEndpoints.id, endpointIds));
        const byId = new Map(endpoints.map((e) => [e.id, e]));

        for (const delivery of due) {
            const endpoint = byId.get(delivery.endpointId);
            if (!endpoint || !endpoint.isActive) {
                await db.update(webhookDeliveries)
                    .set({ status: 'failed', lastError: 'The endpoint was removed or switched off.' })
                    .where(eq(webhookDeliveries.id, delivery.id));
                continue;
            }

            out.attempted++;
            const attempt = delivery.attempts + 1;
            const body = JSON.stringify(delivery.payload);
            const timestamp = Math.floor(Date.now() / 1000);

            let secret = '';
            try {
                const stored = await getSecret(db as never, endpoint.secretRef);
                secret = String((stored as { secret?: string } | null)?.secret ?? '');
            } catch (err) {
                console.error('[webhooks] signing secret unreadable', { endpointId: endpoint.id }, err);
            }
            if (!secret) {
                // Unsigned delivery is not an option: a receiver that cannot verify has no way to
                // tell our request from anybody else's.
                await recordFailure(db, delivery.id, attempt, null, 'The signing secret could not be read.', out);
                continue;
            }

            const guard = isDeliverableUrl(endpoint.url);
            if (!guard.ok) {
                await recordFailure(db, delivery.id, MAX_ATTEMPTS, null, guard.reason, out);
                continue;
            }

            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
                const res = await fetch(guard.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'BeMoreSwan-Webhooks/1',
                        'X-BMS-Event': delivery.event,
                        // The idempotency key. At-least-once delivery is the honest promise, so a
                        // receiver needs something stable to deduplicate on.
                        'X-BMS-Delivery-Id': String(delivery.id),
                        'X-BMS-Timestamp': String(timestamp),
                        'X-BMS-Signature': signPayload(secret, timestamp, body),
                    },
                    body,
                    signal: controller.signal,
                }).finally(() => clearTimeout(timer));

                if (res.ok) {
                    await db.update(webhookDeliveries).set({
                        status: 'delivered', attempts: attempt, responseStatus: res.status,
                        deliveredAt: new Date(), lastError: null,
                    }).where(eq(webhookDeliveries.id, delivery.id));
                    await db.update(webhookEndpoints).set({
                        consecutiveFailures: 0, lastSuccessAt: new Date(), lastError: null, updatedAt: new Date(),
                    }).where(eq(webhookEndpoints.id, endpoint.id));
                    out.delivered++;
                    continue;
                }
                await recordFailure(db, delivery.id, attempt, res.status, `The endpoint answered ${res.status}.`, out);
            } catch (err) {
                const message = (err as Error)?.name === 'AbortError'
                    ? `No answer within ${DELIVERY_TIMEOUT_MS / 1000} seconds.`
                    : String((err as Error)?.message ?? err).slice(0, 300);
                await recordFailure(db, delivery.id, attempt, null, message, out);
            }

            // ⚠️ The endpoint's own health, counted across deliveries. This is what turns "your
            // webhooks stopped working" from something a tenant discovers weeks later into
            // something we tell them.
            const [updated] = await db.update(webhookEndpoints).set({
                consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
                lastError: 'The last delivery failed.',
                updatedAt: new Date(),
            }).where(eq(webhookEndpoints.id, endpoint.id))
                .returning({ failures: webhookEndpoints.consecutiveFailures });

            if ((updated?.failures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
                await db.update(webhookEndpoints).set({
                    isActive: false,
                    disabledAt: new Date(),
                    disabledReason: `Switched off automatically after ${MAX_CONSECUTIVE_FAILURES} failed deliveries in a row.`,
                }).where(eq(webhookEndpoints.id, endpoint.id));
                out.disabled++;
                console.error('[webhooks] endpoint auto-disabled', { endpointId: endpoint.id, orgId: delivery.organisationId });
            }
        }
    } catch (err) {
        console.error('[webhooks] drain failed', err);
    }
    return out;
}

async function recordFailure(
    db: Db,
    deliveryId: number,
    attempt: number,
    responseStatus: number | null,
    error: string,
    out: DrainResult,
): Promise<void> {
    const exhausted = attempt >= MAX_ATTEMPTS;
    await db.update(webhookDeliveries).set({
        status: exhausted ? 'failed' : 'pending',
        attempts: attempt,
        responseStatus,
        lastError: error.slice(0, 300),
        nextAttemptAt: new Date(Date.now() + backoffMs(attempt)),
    }).where(eq(webhookDeliveries.id, deliveryId));
    out.failed++;
}

/** Create an endpoint and its secret together — one is useless without the other. */
export async function createEndpoint(
    db: Db,
    args: { organisationId: number; url: string; events: string[]; description?: string | null; createdBy?: number | null },
): Promise<{ endpointId: number; secret: string }> {
    const [row] = await db.insert(webhookEndpoints).values({
        organisationId: args.organisationId,
        url: args.url,
        description: args.description ?? null,
        events: args.events.join(','),
        // Filled immediately below; the ref needs the id, and the id needs the row.
        secretRef: 'pending',
        createdBy: args.createdBy ?? null,
    }).returning({ id: webhookEndpoints.id });

    const secret = mintSigningSecret();
    const ref = vaultRefFor(row.id);
    await storeSecret(db as never, ref, { secret });
    await db.update(webhookEndpoints).set({ secretRef: ref }).where(eq(webhookEndpoints.id, row.id));
    return { endpointId: row.id, secret };
}
