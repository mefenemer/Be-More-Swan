// netlify/functions/refresh-social-tokens.ts
// Task 4 — silent OAuth token renewal for X (Twitter) and LinkedIn so connections
// never expire and the user is never asked to reconnect.
//
//   • X (Twitter) access tokens are short-lived (~2h) but ship with an `offline.access`
//     refresh token that rotates on every use. Refreshed when < 90 minutes remain.
//   • LinkedIn access tokens are long-lived (~60 days) with a 1-year refresh token
//     (captured at callback when the app is enrolled in LinkedIn's refresh-token
//     programme). Refreshed when < 14 days remain.
//
// Scheduled every 30 minutes (netlify.toml) — frequent enough to keep the 2h X tokens
// warm. Mirrors refresh-meta-tokens.ts for failure side-effects (pause posts + notify).

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, scheduledPosts, users, auditLogs, userOrganisations } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { storeSecret, getSecret } from '../../src/utils/vault';
import { sendEmail } from '../../src/utils/email';
import { resolveActionNotifications, CONNECTION_RESTORED_TYPES } from '../../src/utils/notification-actions';
import { systemPauseWorkingAssistants } from '../../src/utils/assistant-lifecycle';
import { reconnectUrl } from '../../src/utils/connection-recovery';
import { withLambda } from '@netlify/aws-lambda-compat';

const CONCURRENCY = 25;

// How close to expiry (ms) before we proactively refresh, per platform.
const REFRESH_WINDOW_MS: Record<string, number> = {
    x:        90 * 60 * 1000,             // 90 minutes (tokens last ~2h)
    linkedin: 14 * 24 * 60 * 60 * 1000,  // 14 days
};

const LABELS: Record<string, string> = { x: 'X (Twitter)', linkedin: 'LinkedIn' };

type Conn = {
    id: number;
    organisationId: number;
    assistantId: number | null;
    serviceName: string;
    vaultRefKey: string | null;
    tokenExpiresAt: Date | null;
};

export default withLambda(async () => {
    const db = getDb();

    const connections = await db
        .select({
            id: systemConnections.id,
            organisationId: systemConnections.organisationId,
            assistantId: systemConnections.assistantId,
            serviceName: systemConnections.serviceName,
            vaultRefKey: systemConnections.vaultRefKey,
            tokenExpiresAt: systemConnections.tokenExpiresAt,
        })
        .from(systemConnections)
        .where(and(
            inArray(systemConnections.serviceName, ['x', 'linkedin']),
            eq(systemConnections.status, 'active'),
        ));

    // Only refresh those approaching expiry within their platform's window.
    const now = Date.now();
    const due = connections.filter((c) => {
        const window = REFRESH_WINDOW_MS[c.serviceName];
        if (!window) return false;
        // No expiry recorded → refresh to establish one.
        if (!c.tokenExpiresAt) return true;
        return new Date(c.tokenExpiresAt).getTime() - now < window;
    });

    if (!due.length) return { statusCode: 200, body: 'no social tokens to refresh' };

    for (let i = 0; i < due.length; i += CONCURRENCY) {
        const chunk = due.slice(i, i + CONCURRENCY);
        await Promise.allSettled(chunk.map((conn) => refreshConnection(db, conn)));
    }

    return { statusCode: 200, body: `refreshed up to ${due.length} social token(s)` };
});

// ── Failure taxonomy ────────────────────────────────────────────────────────────
// Three outcomes, three responses. This function used to have one: ANY throw condemned the
// connection, paused every scheduled post and halted the dependent assistants.
//
// On 2026-08-04 a prod database outage (141 CONNECT_TIMEOUTs across ~20 functions in one
// window) landed in the 5 seconds between X issuing a rotated refresh token and our writing
// it to the vault. X had already retired the old token; its replacement existed only in this
// function's memory and died with the failed INSERT. The failure handler then tried to record
// the problem — in the same dead database — threw again, and was swallowed by Promise.allSettled,
// so nothing was logged, the status stayed 'active' and the user was told nothing.
//
// Thirty minutes later the next run presented the retired token, X said "Value passed for the
// token was invalid.", and the user was emailed that their X account needed reconnecting. True,
// but the cause was our database, not their token — and a five-second blip had permanently
// destroyed a working connection.
//
// So: a failure that touched nothing must leave the connection alone to be retried, and a
// failure that lost a rotated credential must say so.

/** Nothing irreversible happened — we never reached the provider, or it was briefly unavailable. */
export class TransientRefreshError extends Error {
    constructor(message: string) { super(message); this.name = 'TransientRefreshError'; }
}

/** The provider rotated the token but the replacement could not be stored. Unrecoverable. */
export class TokenLostError extends Error {
    constructor(message: string) { super(message); this.name = 'TokenLostError'; }
}

// How long to keep trying to store a rotated credential before admitting it is lost.
//
// A DEADLINE, not an attempt count, because each failed attempt costs an unknown amount of wall
// clock — anywhere from milliseconds (a constraint violation) to the pool's full connect_timeout,
// which is 15s (db/client.ts). A fixed list of backoffs can therefore silently add up to far more
// than it looks. This function has no `timeout` override in netlify.toml, so it runs on the
// scheduled-function budget — overrunning it means a hard kill with no catch, no condemn and no
// email, which is precisely the silent failure this whole taxonomy exists to stop.
//
// 18s: enough for one attempt that fully absorbs a cold-start connect (the case that actually
// matters — see the connect_timeout note in db/client.ts), while leaving the provider call before
// it and the failure handling after it inside the budget.
const PERSIST_DEADLINE_MS = 18_000;
const PERSIST_RETRY_WAIT_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Postgres failures arrive wrapped: `err.message` is a generic "Failed query: …" and the real
 * cause (CONNECT_TIMEOUT, a constraint name) hides in `err.cause`. Logging only the message is
 * why the 10:00 outage above read as an opaque insert failure.
 */
function describeError(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const cause = (err as { cause?: unknown }).cause;
    const code = (cause as { code?: string } | undefined)?.code
        ?? (err as { code?: string }).code;
    return code ? `${err.message} (${code})` : err.message;
}

async function refreshConnection(db: ReturnType<typeof getDb>, conn: Conn) {
    if (!conn.vaultRefKey) return;

    try {
        let stored;
        try {
            stored = await getSecret(db, conn.vaultRefKey);
        } catch (err) {
            // A vault READ failure has cost us nothing — the stored token is untouched.
            throw new TransientRefreshError(`vault read failed: ${describeError(err)}`);
        }

        const refreshToken = stored?.refreshToken as string | undefined;
        if (!refreshToken) {
            // No refresh token on file (e.g. a legacy connection captured before we
            // stored one). Can't renew silently — leave it for the health-check/expiry
            // path to surface a reconnect prompt. Skip without flipping status.
            console.warn(`[refresh-social-tokens] conn ${conn.id} (${conn.serviceName}) has no refresh token — skipping`);
            return;
        }

        // ⚠️ The point of no return. Once this resolves, the provider has retired the refresh
        // token we just sent and the only copy of its replacement is in `refreshed`.
        const refreshed = conn.serviceName === 'x'
            ? await refreshX(refreshToken)
            : await refreshLinkedIn(refreshToken);

        await persistRotatedToken(db, conn, {
            token: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? refreshToken,
        });

        // Past this line the credential is safe on disk. Everything below is bookkeeping: if it
        // fails, the next run finds a stale token_expires_at, reads the connection as due and
        // simply refreshes again. That costs one extra rotation, not a connection.
        try {
            const newExpiry = new Date(Date.now() + refreshed.expiresInSec * 1000);
            await db.update(systemConnections).set({
                tokenExpiresAt: newExpiry,
                status: 'active',
                updatedAt: new Date(),
            }).where(eq(systemConnections.id, conn.id));

            await db.insert(auditLogs).values({
                actionType: `${conn.serviceName}_token_refreshed`,
                resourceType: 'system_connections',
                resourceId: String(conn.id),
                newState: { organisationId: conn.organisationId, newExpiry },
            });

            // Token healthy again — clear any open "reconnect" prompt for this org's user.
            const [refreshedUser] = await db.select({ id: users.id }).from(users)
                .innerJoin(userOrganisations, eq(users.id, userOrganisations.userId))
                .where(eq(userOrganisations.organisationId, conn.organisationId)).limit(1);
            if (refreshedUser) await resolveActionNotifications(db, refreshedUser.id, CONNECTION_RESTORED_TYPES);
        } catch (err) {
            throw new TransientRefreshError(`post-refresh bookkeeping failed: ${describeError(err)}`);
        }

    } catch (err) {
        if (err instanceof TransientRefreshError) {
            // Deliberately leave status 'active' and touch nothing else. The connection is fine;
            // the next run in 30 minutes tries again. Condemning here is what turned a database
            // blip into a dead connection and a "reconnect your account" email.
            console.warn(`[refresh-social-tokens] conn ${conn.id} (${conn.serviceName}) transient, will retry: ${err.message}`);
            return;
        }
        console.error(`[refresh-social-tokens] conn ${conn.id} (${conn.serviceName}) failed:`, describeError(err));
        await handleRefreshFailure(db, conn, describeError(err), err instanceof TokenLostError ? 'token_lost' : 'rejected');
    }
}

/**
 * Store the rotated credential, retrying hard.
 *
 * This is the one write in the whole function that cannot be redone: the provider has already
 * retired the previous refresh token, so if this never lands the connection is gone and only a
 * human reconnect brings it back. Everything else here is safe to lose and retry next cycle.
 */
async function persistRotatedToken(
    db: ReturnType<typeof getDb>,
    conn: Conn,
    payload: { token: string; refreshToken: string },
): Promise<void> {
    const deadline = Date.now() + PERSIST_DEADLINE_MS;
    let lastErr: unknown;
    let attempt = 0;

    // Always makes at least one attempt, then keeps probing while the budget allows.
    //
    // The retry gate measures how long the LAST attempt took and only goes again if that much time
    // remains. Without it, a 15s cold-start attempt starting at t=15s would run to t=30s and blow
    // the function budget — a deadline alone does not bound total time when a single attempt can
    // consume most of it. Measuring instead of assuming also keeps fast failures (a constraint
    // violation, say) retrying many times, which is the case where retrying is actually cheap.
    do {
        attempt++;
        const started = Date.now();
        try {
            await storeSecret(db, conn.vaultRefKey!, payload);
            if (attempt > 1) {
                console.warn(`[refresh-social-tokens] conn ${conn.id} vault write succeeded on attempt ${attempt}`);
            }
            return;
        } catch (err) {
            lastErr = err;
            const cost = Date.now() - started;
            const remaining = deadline - Date.now();
            console.warn(
                `[refresh-social-tokens] conn ${conn.id} vault write attempt ${attempt} failed after ${cost}ms ` +
                `(${describeError(err)}) — ${Math.max(0, remaining)}ms of budget left`,
            );
            if (remaining < cost + PERSIST_RETRY_WAIT_MS) break;
            await sleep(PERSIST_RETRY_WAIT_MS);
        }
    } while (Date.now() < deadline);

    throw new TokenLostError(
        `rotated ${conn.serviceName} token could not be stored in ${PERSIST_DEADLINE_MS}ms (${attempt} attempt(s)) ` +
        `— the previous refresh token is already retired at the provider: ${describeError(lastErr)}`,
    );
}

/**
 * POST a refresh-token grant and classify the outcome.
 *
 * The distinction that matters: an unreachable or overloaded provider has NOT retired anything,
 * so the connection is still perfectly good and must be left alone for the next run. Only a
 * 4xx — the provider looking at our grant and rejecting it — means reconnect. Treating the two
 * alike is how a 30-second outage at X's end would take a workspace's posting offline.
 */
export async function requestGrant(
    label: string,
    url: string,
    body: URLSearchParams,
    headers: Record<string, string>,
) {
    let res: Response;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
            body,
        });
    } catch (err) {
        // DNS, TLS, connection reset, timeout — the request may never have been processed.
        throw new TransientRefreshError(`${label} unreachable: ${describeError(err)}`);
    }

    // 5xx = their problem; 429 = ours but temporary. Neither is a verdict on the grant.
    if (res.status >= 500 || res.status === 429) {
        throw new TransientRefreshError(`${label} returned ${res.status}`);
    }

    let data: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    try {
        data = await res.json();
    } catch (err) {
        // A non-JSON body on a 2xx/4xx is an edge/proxy page, not the provider's answer.
        throw new TransientRefreshError(`${label} returned unparseable body (${res.status}): ${describeError(err)}`);
    }

    if (!data.access_token) {
        throw new Error(data.error_description || data.error || `${label} token refresh failed (${res.status})`);
    }

    return data;
}

// ── X (Twitter) — OAuth2 refresh token grant (confidential client) ──────────────
async function refreshX(refreshToken: string) {
    const clientId     = process.env.X_CLIENT_ID!;
    const clientSecret = process.env.X_CLIENT_SECRET!;
    const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const data = await requestGrant(
        'X',
        'https://api.twitter.com/2/oauth2/token',
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
        { Authorization: `Basic ${credentials}` },
    );

    return {
        accessToken: data.access_token!,
        refreshToken: data.refresh_token ?? null, // X rotates the refresh token
        expiresInSec: data.expires_in ?? 7200,
    };
}

// ── LinkedIn — OAuth2 refresh token grant ───────────────────────────────────────
async function refreshLinkedIn(refreshToken: string) {
    const clientId     = process.env.LINKEDIN_CLIENT_ID!;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET!;

    const data = await requestGrant(
        'LinkedIn',
        'https://www.linkedin.com/oauth/v2/accessToken',
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
        {},
    );

    return {
        accessToken: data.access_token!,
        refreshToken: data.refresh_token ?? null, // LinkedIn may rotate the refresh token
        expiresInSec: data.expires_in ?? 60 * 24 * 60 * 60,
    };
}

/**
 * Shared failure handling: mark unhealthy, pause posts, and prompt a reconnect.
 *
 * Every step is individually guarded and the whole thing never throws. It used to be a bare
 * sequence of awaits called from a catch block inside Promise.allSettled — so when the database
 * that caused the failure was still down, the very first write threw, the rest never ran, and the
 * rejection was swallowed by allSettled. The result was a connection that had just been destroyed
 * and absolutely no trace of it: no log line, no audit row, no email, status left 'active'.
 *
 * A failure to RECORD a failure must still leave something behind.
 */
async function handleRefreshFailure(
    db: ReturnType<typeof getDb>,
    conn: Conn,
    msg: string,
    kind: 'rejected' | 'token_lost',
) {
    const label = LABELS[conn.serviceName] || conn.serviceName;

    // Emitted before anything that can fail, so the log survives a total database outage. This
    // line is the one thing that was missing on 2026-08-04.
    console.error(
        `[refresh-social-tokens] CONDEMNING conn ${conn.id} (${conn.serviceName}, org ${conn.organisationId}) ` +
        `kind=${kind}: ${msg}`,
    );

    // Best-effort wrapper: one dead step must not cancel the others. Pausing posts still matters
    // even if the status flip failed, and the user still needs the email either way.
    const step = async (name: string, fn: () => Promise<unknown>) => {
        try { await fn(); } catch (err) {
            console.error(`[refresh-social-tokens] conn ${conn.id} failure-handling step "${name}" failed:`, describeError(err));
        }
    };

    await step('flip status', () => db.update(systemConnections).set({
        status: 'token_refresh_failed',
        updatedAt: new Date(),
    }).where(eq(systemConnections.id, conn.id)));

    await step('pause posts', () => db.update(scheduledPosts).set({ status: 'paused', updatedAt: new Date() })
        .where(and(eq(scheduledPosts.connectionId, conn.id), eq(scheduledPosts.status, 'scheduled'))));

    let orgUser: { id: number; email: string } | undefined;
    await step('resolve org user', async () => {
        [orgUser] = await db.select({ id: users.id, email: users.email }).from(users)
            .innerJoin(userOrganisations, eq(users.id, userOrganisations.userId))
            .where(eq(userOrganisations.organisationId, conn.organisationId)).limit(1);
    });

    if (orgUser) {
        const recipient = orgUser;
        await step('notify', () => createNotification(db, 'social_token_refresh_failed', {
            userId: recipient.id,
            // Computed type so resolve-on-reconnect can match a single platform (see notify.ts).
            typeOverride: `${conn.serviceName}_token_refresh_failed`,
            context: { platform: { label } },
            metadata: { connectionId: conn.id, kind },
        }));

        // `token_lost` is our fault, not the user's: the provider issued a replacement credential
        // and we failed to store it. Saying "your token could not be refreshed" there would be a
        // lie by omission — the reconnect is real, but nothing was wrong with their account.
        const cause = kind === 'token_lost'
            ? `<p>A problem on our side interrupted the automatic renewal of your ${label} connection before the new credentials could be saved. Reconnecting takes a few seconds and fixes it.</p>`
            : `<p>Your ${label} account connected to Be More Swan needs to be reconnected — its access token could not be automatically refreshed.</p>`;

        await step('email', () => sendEmail({
            to: recipient.email,
            subject: `Action required: Reconnect your ${label} account`,
            html: `${cause}
                   <p>Any scheduled posts have been paused and will resume once you reconnect.</p>
                   <p><a href="${reconnectUrl(conn.serviceName, conn.assistantId)}">Reconnect ${label} →</a></p>`,
        }));
    }

    await step('audit', () => db.insert(auditLogs).values({
        actionType: `${conn.serviceName}_token_refresh_failed`,
        resourceType: 'system_connections',
        resourceId: String(conn.id),
        newState: { error: msg, kind },
    }));

    // US5 AC5.1(a): a required OAuth token expired and could not be refreshed → force the
    // dependent working assistant(s) into system_paused. Scoped to the assistant when the
    // connection is assistant-scoped, else the whole org (shared connection pool).
    await step('pause assistants', () => systemPauseWorkingAssistants(
        db,
        { organisationId: conn.organisationId, assistantId: conn.assistantId },
        `token_refresh_failed:${conn.serviceName}`,
    ));
}
