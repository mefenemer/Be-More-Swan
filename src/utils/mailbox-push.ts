// src/utils/mailbox-push.ts — new mail read within seconds, by push (docs/email-assistant-plan.md §4.2–4.3,
// Phase 3b). Polling stays as the safety net.
//
//   ensureWatches()   every poll run (poll-mailboxes.ts): any active mailbox whose watch is missing or
//                     ends within a day gets a new or renewed one. So in practice once a day per mailbox.
//   mail-push-gmail   Pub/Sub's push for a Gmail mailbox: OIDC token checked here (verifyPubSubToken),
//                     then recordPush() → the background reader.
//   mail-push-graph   Graph's notification for an Outlook mailbox: our clientState checked here
//                     (clientStateMatches), then recordPush().
//   stopWatch()       on disconnect.
//
// Push is OFF on a site until its settings are there (pushConfigured): Gmail needs GMAIL_PUBSUB_TOPIC,
// GMAIL_PUSH_AUDIENCE and GMAIL_PUSH_SERVICE_ACCOUNT; Outlook needs GRAPH_NOTIFY_SECRET. Without them
// nothing here runs and every mailbox is polled every 10 minutes, as before.
//
// ⚠️ A notification carries no email content, and nothing from one is logged beyond mailbox ids.

import { createHmac, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { mailboxes } from '../../db/schema';
import { resolveBaseUrl } from './base-url';
import { isFeatureEnabled } from './feature-flags';
import { EMAIL_ASSISTANT_FLAG, getMailboxAccessToken, type MailboxRow } from './mailboxes';
import { providerHttpError } from './mail-reader';
import { createGraphSubscription, deleteGraphSubscription, renewGraphSubscription, startGmailWatch } from './mail-reader/watch';
import { triggerMailboxSync } from './mailbox-sync';

type Db = ReturnType<typeof getDb>;

/** A watch is renewed once it has less than this left. Watches last 6–7 days, so about once a day. */
export const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000;
/** Watches started or renewed per poll run (the rest wait 10 minutes). */
const WATCHES_PER_RUN = 20;
/**
 * After a watch fails to start, or for a workspace without the Email Assistant, wait this long before
 * trying that mailbox again — so they never fill the per-run places ahead of mailboxes that can be watched.
 */
export const WATCH_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * Put a mailbox to the back of the queue for WATCH_RETRY_MS. ⚠️ Written as watch_expires_at = now +
 * RENEW_WITHIN_MS + WATCH_RETRY_MS, so the renewal query picks it up again after WATCH_RETRY_MS. That
 * date does NOT mean push works: polling goes by last_push_at (mailbox-sync.ts mailboxesDueForSync),
 * which is cleared here so the mailbox is back on the 10-minute poll at once. If an older watch is in
 * fact still delivering, its next push sets last_push_at again.
 */
async function retryWatchLater(db: Db, mailboxId: number): Promise<void> {
    await db.update(mailboxes)
        .set({ watchExpiresAt: sql`now() + make_interval(secs => ${(RENEW_WITHIN_MS + WATCH_RETRY_MS) / 1000})`, lastPushAt: null })
        .where(eq(mailboxes.id, mailboxId)).catch(() => undefined);
}

/** The path Graph posts to (also its lifecycle URL). */
export const GRAPH_PUSH_PATH = '/.netlify/functions/mail-push-graph';

/** Whether push is set up on this site for a provider. Pure (reads env). */
export function pushConfigured(provider: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (provider === 'gmail') return !!(env.GMAIL_PUBSUB_TOPIC && env.GMAIL_PUSH_AUDIENCE && env.GMAIL_PUSH_SERVICE_ACCOUNT);
    if (provider === 'outlook') return !!env.GRAPH_NOTIFY_SECRET;
    return false;
}

// ── Graph: clientState ────────────────────────────────────────────────────────────────────────────

/**
 * The secret Graph echoes back on every notification for this mailbox, derived from
 * GRAPH_NOTIFY_SECRET so nothing extra is stored. A notification without it is ignored. Pure.
 */
export function graphClientState(mailboxId: number, secret: string | undefined = process.env.GRAPH_NOTIFY_SECRET): string {
    if (!secret) throw new Error('GRAPH_NOTIFY_SECRET is not set');
    return createHmac('sha256', secret).update(`mailbox:${mailboxId}`).digest('base64url');
}

/** Constant-time check of a notification's clientState. Pure. */
export function clientStateMatches(mailboxId: number, given: unknown, secret: string | undefined = process.env.GRAPH_NOTIFY_SECRET): boolean {
    if (!secret || typeof given !== 'string') return false;
    const a = Buffer.from(graphClientState(mailboxId, secret));
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
}

export interface GraphNotification { subscriptionId: string; clientState: string | null; lifecycleEvent: string | null }

/** Graph's POST body → its notifications. Unknown shapes give []. Pure. */
export function parseGraphNotifications(body: unknown): GraphNotification[] {
    const value = (body as { value?: unknown } | null)?.value;
    if (!Array.isArray(value)) return [];
    return value.slice(0, 100).flatMap((v) => {
        const n = v as Record<string, unknown>;
        if (typeof n?.subscriptionId !== 'string' || !n.subscriptionId) return [];
        return [{
            subscriptionId: n.subscriptionId,
            clientState: typeof n.clientState === 'string' ? n.clientState : null,
            lifecycleEvent: typeof n.lifecycleEvent === 'string' ? n.lifecycleEvent : null,
        }];
    });
}

// ── Gmail: Pub/Sub ────────────────────────────────────────────────────────────────────────────────

/** Pub/Sub's push body → Gmail's `{ emailAddress, historyId }`, or null. Pure. */
export function parsePubSubPush(body: unknown): { emailAddress: string; historyId: string } | null {
    const data = (body as { message?: { data?: unknown } } | null)?.message?.data;
    if (typeof data !== 'string' || data.length > 4096) return null;
    try {
        const p = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as Record<string, unknown>;
        if (typeof p.emailAddress !== 'string' || !/@/.test(p.emailAddress)) return null;
        return { emailAddress: p.emailAddress.trim().toLowerCase(), historyId: String(p.historyId ?? '') };
    } catch {
        return null;
    }
}

type CertFetcher = () => Promise<Record<string, string>>;
let certCache: { at: number; certs: Record<string, string> } | null = null;

/** Google's current signing certificates (kid → PEM), cached for an hour. */
const googleCerts: CertFetcher = async () => {
    if (certCache && Date.now() - certCache.at < 60 * 60 * 1000) return certCache.certs;
    const res = await fetch('https://www.googleapis.com/oauth2/v1/certs');
    if (!res.ok) throw new Error(`Google certs ${res.status}`);
    const certs = await res.json() as Record<string, string>;
    certCache = { at: Date.now(), certs };
    return certs;
};

/**
 * The push really came from OUR Pub/Sub subscription: a Google-signed OIDC token whose audience is
 * GMAIL_PUSH_AUDIENCE and whose email is GMAIL_PUSH_SERVICE_ACCOUNT (the account the subscription
 * signs as). ⚠️ The email check matters: any Google Cloud account can mint a token for any audience.
 */
export async function verifyPubSubToken(authHeader: string | undefined, opts: {
    audience?: string; serviceAccount?: string; certs?: CertFetcher;
} = {}): Promise<boolean> {
    const audience = opts.audience ?? process.env.GMAIL_PUSH_AUDIENCE;
    const serviceAccount = (opts.serviceAccount ?? process.env.GMAIL_PUSH_SERVICE_ACCOUNT ?? '').toLowerCase();
    if (!audience || !serviceAccount) return false;
    const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return false;
    try {
        const decoded = jwt.decode(token, { complete: true });
        const kid = decoded && typeof decoded === 'object' ? decoded.header.kid : undefined;
        if (!kid) return false;
        const pem = (await (opts.certs ?? googleCerts)())[kid];
        if (!pem) return false;
        const claims = jwt.verify(token, pem, {
            algorithms: ['RS256'], audience, issuer: ['https://accounts.google.com', 'accounts.google.com'],
        }) as { email?: string; email_verified?: boolean };
        return claims.email_verified === true && (claims.email || '').toLowerCase() === serviceAccount;
    } catch {
        return false;
    }
}

// ── Recording a push ──────────────────────────────────────────────────────────────────────────────

/**
 * A push arrived for these mailboxes: note it and wake the reader for each one not already being read.
 * One mid-run is read again when its run ends (mailbox-sync-background.ts sees last_push_at moved), so
 * a burst of pushes during a long first read costs one extra run, not one function call per push.
 */
export async function recordPush(db: Db, mailboxIds: number[]): Promise<{ recorded: number; dispatched: number }> {
    const ids = [...new Set(mailboxIds)].filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return { recorded: 0, dispatched: 0 };
    const rows = await db.update(mailboxes).set({ lastPushAt: new Date() })
        .where(and(inArray(mailboxes.id, ids), eq(mailboxes.status, 'active')))
        .returning({ id: mailboxes.id, organisationId: mailboxes.organisationId, lockedUntil: mailboxes.syncLockUntil });
    // A workspace without the Email Assistant isn't read at all: don't wake a function just to find that out.
    // (One Gmail address can be connected in several workspaces, only some with the flag.)
    const flagOn = new Map<number, Promise<boolean>>();
    const on = (orgId: number) => {
        if (!flagOn.has(orgId)) flagOn.set(orgId, isFeatureEnabled(orgId, EMAIL_ASSISTANT_FLAG).catch(() => false));
        return flagOn.get(orgId)!;
    };
    const allowed = (await Promise.all(rows.map(async (r) => (await on(r.organisationId)) ? r : null))).filter((r) => r !== null);
    // In parallel: Graph wants its answer within about 3 seconds.
    const free = allowed.filter((r) => !(r.lockedUntil && r.lockedUntil.getTime() > Date.now()));
    const sent = await Promise.all(free.map((r) => triggerMailboxSync(r.id)));
    return { recorded: rows.length, dispatched: sent.filter(Boolean).length };
}

/** Active Gmail mailboxes for an address (one address can be connected by several people). */
export async function gmailMailboxIdsFor(db: Db, emailAddress: string): Promise<number[]> {
    const rows = await db.select({ id: mailboxes.id }).from(mailboxes)
        .where(and(eq(mailboxes.provider, 'gmail'), eq(mailboxes.status, 'active'), sql`lower(${mailboxes.address}) = ${emailAddress.toLowerCase()}`))
        .limit(20);
    return rows.map((r) => r.id);
}

/** The mailbox a Graph subscription belongs to. */
export async function mailboxForSubscription(db: Db, subscriptionId: string): Promise<{ id: number; status: string } | null> {
    const [row] = await db.select({ id: mailboxes.id, status: mailboxes.status }).from(mailboxes)
        .where(and(isNotNull(mailboxes.watchId), eq(mailboxes.watchId, subscriptionId))).limit(1);
    return row ?? null;
}

/** Forget a mailbox's watch, so the next poll run creates a new one (Graph removed it). */
export async function clearWatch(db: Db, mailboxId: number): Promise<void> {
    await db.update(mailboxes).set({ watchId: null, watchExpiresAt: null }).where(eq(mailboxes.id, mailboxId));
}

// ── Starting and renewing ─────────────────────────────────────────────────────────────────────────

export type WatchOutcome = 'started' | 'renewed' | 'off' | 'failed';

/** Start or renew one mailbox's watch. Never throws. */
export async function ensureWatch(db: Db, box: MailboxRow): Promise<WatchOutcome> {
    if (box.status !== 'active' || !pushConfigured(box.provider)) return 'off';
    try {
        const token = await getMailboxAccessToken(db, box);
        if (box.provider === 'gmail') {
            const { expiresAt } = await startGmailWatch(token, process.env.GMAIL_PUBSUB_TOPIC as string);
            await db.update(mailboxes).set({ watchExpiresAt: expiresAt, watchId: null }).where(eq(mailboxes.id, box.id));
            return box.watchExpiresAt ? 'renewed' : 'started';
        }
        if (box.watchId) {
            try {
                const { expiresAt } = await renewGraphSubscription(token, box.watchId);
                await db.update(mailboxes).set({ watchExpiresAt: expiresAt }).where(eq(mailboxes.id, box.id));
                return 'renewed';
            } catch (err) {
                if (providerHttpError(err)?.status !== 404) throw err; // gone: make a new one below
            }
        }
        const base = resolveBaseUrl();
        if (!base) return 'off';
        const sub = await createGraphSubscription(token, { notificationUrl: `${base}${GRAPH_PUSH_PATH}`, clientState: graphClientState(box.id) });
        await db.update(mailboxes).set({ watchId: sub.id, watchExpiresAt: sub.expiresAt }).where(eq(mailboxes.id, box.id));
        return 'started';
    } catch (err) {
        // The mailbox keeps being polled; the next run tries again. Token problems surface through the sync.
        console.error('[mailbox-push] watch failed', { mailboxId: box.id, status: providerHttpError(err)?.status ?? null, err: err instanceof Error ? err.message : err });
        await retryWatchLater(db, box.id);
        return 'failed';
    }
}

/** Active mailboxes whose watch is missing or ends within RENEW_WITHIN_MS, on providers with push set up. */
export async function mailboxesNeedingWatch(db: Db): Promise<MailboxRow[]> {
    const providers = ['gmail', 'outlook'].filter((p) => pushConfigured(p));
    if (!providers.length) return [];
    // ⚠️ No JS Date inside raw sql (tests/raw-sql-date-params): the window is computed in SQL.
    return db.select().from(mailboxes)
        .where(and(eq(mailboxes.status, 'active'), inArray(mailboxes.provider, providers),
            sql`(${mailboxes.watchExpiresAt} IS NULL OR ${mailboxes.watchExpiresAt} < now() + make_interval(secs => ${RENEW_WITHIN_MS / 1000}))`))
        .orderBy(sql`${mailboxes.watchExpiresAt} ASC NULLS FIRST`).limit(WATCHES_PER_RUN);
}

/** How long ensureWatches may spend when its caller gives no deadline. */
export const WATCH_BUDGET_MS = 12_000;

/**
 * Every poll run: start or renew what is due, until `deadline` (the run itself has a time limit, and a
 * Graph subscription waits for Graph's check of our URL). What is left over is counted as `deferred`
 * and is first in line next run (the query orders by expiry). Never throws.
 */
export async function ensureWatches(db: Db, deadline: number = Date.now() + WATCH_BUDGET_MS): Promise<Record<WatchOutcome | 'deferred', number>> {
    const out: Record<WatchOutcome | 'deferred', number> = { started: 0, renewed: 0, off: 0, failed: 0, deferred: 0 };
    const due = await mailboxesNeedingWatch(db).catch((err) => {
        console.error('[mailbox-push] could not list mailboxes', err instanceof Error ? err.message : err);
        return [] as MailboxRow[];
    });
    for (const box of due) {
        if (Date.now() > deadline) { out.deferred++; continue; }
        // A workspace without the Email Assistant gets no push (its mailbox isn't read at all); asked again later.
        if (!(await isFeatureEnabled(box.organisationId, EMAIL_ASSISTANT_FLAG).catch(() => false))) { out.off++; await retryWatchLater(db, box.id); continue; }
        out[await ensureWatch(db, box)]++;
    }
    return out;
}

/** Stop a mailbox's watch at the provider (on disconnect). Best effort; never throws. */
export async function stopWatch(db: Db, box: Pick<MailboxRow, 'id' | 'vaultRefKey' | 'provider' | 'watchId' | 'watchExpiresAt'>): Promise<void> {
    if (box.provider !== 'outlook' || !box.watchId) return;
    try {
        const token = await getMailboxAccessToken(db, box);
        // ⚠️ Not Gmail's users.stop: it ends the watch for the whole Google account, and someone else in
        // another workspace may have connected the same address. The disconnect's Google revoke ends a
        // watch that was only ours, and pushes for an address with no mailbox are ignored.
        if (box.provider === 'outlook' && box.watchId) await deleteGraphSubscription(token, box.watchId);
    } catch {
        // A watch nobody renews ends by itself within 7 days, and its pushes find no mailbox.
    }
}
