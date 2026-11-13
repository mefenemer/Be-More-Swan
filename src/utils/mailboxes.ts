// src/utils/mailboxes.ts — the Email Assistant's mailboxes: scopes, tokens, ownership, disconnect.
// docs/email-assistant-plan.md §3.2–3.3 and §7.5. Phase 1 is Outlook only, read-only.
//
// A mailbox belongs to ONE person (mailboxes.user_id). Every read here takes the caller's user id and
// workspace, and an admin viewing a workspace through impersonation never gets email content
// (mailboxAccess()).
//
// Tokens live in the vault under the mailbox's own key (`mailbox:<uuid>`), never one per workspace +
// provider: a shared key once let one connection overwrite another's token (meta-vault-key-collides-per-org).

import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { mailboxes } from '../../db/schema';
import { deleteSecret, getSecret, storeSecret } from './vault';
import { singleFlight } from './single-flight';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The feature flag every mailbox endpoint checks (db/z-mailboxes.sql). */
export const EMAIL_ASSISTANT_FLAG = 'email_assistant';
export const EMAIL_ASSISTANT_ROLE = 'email_assistant';

/**
 * Microsoft Graph delegated scope for the Email Assistant (plan §3.2). The SAME Azure app as Outlook
 * sending (OUTLOOK_CLIENT_ID), a third, separate grant: connecting a mailbox never widens the outreach
 * send grant, or the booking calendar's. Sent identically on authorize, code exchange and refresh —
 * Microsoft narrows the grant when refresh omits a scope.
 *
 * Mail.ReadWrite is asked for now, in Phase 1, even though Phase 1 writes nothing: asking for it later
 * would send every connected user through a second consent screen. Mail.Send is the same.
 */
export const OUTLOOK_MAILBOX_SCOPE = 'offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read';

/**
 * Google scope for the Email Assistant (plan §3.1) — the SEPARATE "Be More Swan Mail" Google project
 * (GMAIL_MAIL_CLIENT_ID / _SECRET), never the approved send-only project (GMAIL_CLIENT_ID). gmail.modify
 * is restricted: until Google approves it only the project's listed test users can connect.
 *
 * ⚠️ Must match the consent screen's scopes exactly (docs/email-assistant-phase0.md §6.2) — the
 * 2026-08-26 rejection was a code/console mismatch. No gmail.send: gmail.modify covers send and drafts.
 */
export const GMAIL_MAILBOX_SCOPE = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify';

/** Gmail can be connected on this site: the mail project's client is configured. */
export function gmailMailboxConfigured(): boolean {
    return Boolean(process.env.GMAIL_MAIL_CLIENT_ID && process.env.GMAIL_MAIL_CLIENT_SECRET);
}

export type MailboxRow = typeof mailboxes.$inferSelect;
export type MailboxKind = 'business' | 'personal';

export class MailboxError extends Error {
    constructor(public code: 'not_found' | 'needs_reconnect' | 'not_configured', message: string, public status = 409) {
        super(message);
    }
}

/** A fresh vault key for a new mailbox. */
export function newMailboxVaultKey(): string {
    return `mailbox:${randomUUID()}`;
}

/** What a caller may see. Impersonating support staff see that mailboxes exist, never their email. Pure. */
export function mailboxAccess(ctx: { impersonation?: unknown }): 'owner' | 'counts_only' {
    return ctx.impersonation ? 'counts_only' : 'owner';
}

/** The caller's own mailboxes in this workspace, newest first. */
export async function listOwnMailboxes(db: Db, organisationId: number, userId: number): Promise<MailboxRow[]> {
    return db.select().from(mailboxes)
        .where(and(eq(mailboxes.organisationId, organisationId), eq(mailboxes.userId, userId)))
        .orderBy(mailboxes.createdAt);
}

/** One of the caller's own mailboxes, or null — never someone else's, even in the same workspace. */
export async function getOwnMailbox(db: Db, organisationId: number, userId: number, mailboxId: number): Promise<MailboxRow | null> {
    const [row] = await db.select().from(mailboxes)
        .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.organisationId, organisationId), eq(mailboxes.userId, userId)))
        .limit(1);
    return row ?? null;
}

interface MailboxToken { accessToken: string; refreshToken: string | null; expiresAt: number | null }

/** Save a token for a mailbox (connect, refresh). expiresAt is ms since epoch. */
export async function storeMailboxToken(db: Db | Tx, vaultRefKey: string, token: MailboxToken): Promise<void> {
    await storeSecret(db as never, vaultRefKey, { ...token });
}

const REFRESH_SKEW_MS = 2 * 60 * 1000;

/** Exchange a refresh token at Microsoft. Throws MailboxError('needs_reconnect') on a rejected grant. */
async function refreshOutlookMailboxToken(refreshToken: string): Promise<MailboxToken> {
    const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: process.env.OUTLOOK_CLIENT_ID ?? '',
            client_secret: process.env.OUTLOOK_CLIENT_SECRET ?? '',
            refresh_token: refreshToken,
            scope: OUTLOOK_MAILBOX_SCOPE,
        }),
    });
    const data: { access_token?: string; refresh_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
        // 400 invalid_grant = revoked / expired / password changed: the user must reconnect. Anything
        // else (5xx, network) is transient and must NOT mark the mailbox broken.
        if (res.status === 400 || res.status === 401) throw new MailboxError('needs_reconnect', 'Outlook asked for this mailbox to be connected again.');
        throw new Error(`Outlook token refresh failed (${res.status}).`);
    }
    return {
        accessToken: data.access_token,
        // Microsoft ROTATES refresh tokens: keep the new one or the next refresh fails.
        refreshToken: data.refresh_token ?? refreshToken,
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    };
}

/** Exchange a refresh token at Google (the mail project). Google does NOT rotate refresh tokens. */
async function refreshGmailMailboxToken(refreshToken: string): Promise<MailboxToken> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: process.env.GMAIL_MAIL_CLIENT_ID ?? '',
            client_secret: process.env.GMAIL_MAIL_CLIENT_SECRET ?? '',
            refresh_token: refreshToken,
        }),
    });
    const data: { access_token?: string; expires_in?: number } = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
        // 400 invalid_grant: revoked, password changed, or (while unverified) the 7-day test-user token
        // expiry. The user must reconnect. 5xx / network: transient, never marks the mailbox broken.
        if (res.status === 400 || res.status === 401) throw new MailboxError('needs_reconnect', 'Gmail asked for this mailbox to be connected again.');
        throw new Error(`Gmail token refresh failed (${res.status}).`);
    }
    return { accessToken: data.access_token, refreshToken, expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null };
}

/**
 * A usable access token for a mailbox, refreshing it when it is about to expire.
 *
 * Same shape as workspace-integrations getFreshAccessToken: singleFlight for callers in this process
 * (the pool is max:1, so a second transaction would just queue), and a FOR UPDATE row lock for callers
 * in other instances. Under the lock the token is re-read: a refresh that already happened must not be
 * repeated with the now-spent refresh token (the X double-refresh of 2026-11-11).
 */
export async function getMailboxAccessToken(db: Db, mailbox: Pick<MailboxRow, 'id' | 'vaultRefKey' | 'provider'>): Promise<string> {
    const secret = await getSecret(db as never, mailbox.vaultRefKey).catch(() => null) as MailboxToken | null;
    if (!secret?.accessToken) throw new MailboxError('needs_reconnect', 'This mailbox needs to be connected again.');
    if (!secret.expiresAt || secret.expiresAt - REFRESH_SKEW_MS > Date.now()) return secret.accessToken;
    if (mailbox.provider !== 'outlook' && mailbox.provider !== 'gmail') throw new MailboxError('not_configured', 'This kind of mailbox can\'t be read.');

    return singleFlight(`mailbox-refresh:${mailbox.id}`, async () => {
        try {
            return await db.transaction(async (tx) => {
                await tx.execute(sqlLockTimeout);
                const [row] = await tx.select({ id: mailboxes.id, vaultRefKey: mailboxes.vaultRefKey, status: mailboxes.status })
                    .from(mailboxes).where(eq(mailboxes.id, mailbox.id)).limit(1).for('update');
                if (!row || row.status === 'disconnected') throw new MailboxError('not_found', 'This mailbox is no longer connected.', 404);
                const now = await getSecret(tx as never, row.vaultRefKey).catch(() => null) as MailboxToken | null;
                if (!now?.accessToken) throw new MailboxError('needs_reconnect', 'This mailbox needs to be connected again.');
                if (now.expiresAt && now.expiresAt - REFRESH_SKEW_MS > Date.now()) return now.accessToken;
                if (!now.refreshToken) throw new MailboxError('needs_reconnect', 'This mailbox needs to be connected again.');
                const fresh = mailbox.provider === 'gmail'
                    ? await refreshGmailMailboxToken(now.refreshToken)
                    : await refreshOutlookMailboxToken(now.refreshToken);
                await storeMailboxToken(tx, row.vaultRefKey, fresh);
                return fresh.accessToken;
            });
        } catch (err) {
            // Written after the transaction, so it survives the rollback.
            if (err instanceof MailboxError && err.code === 'needs_reconnect') {
                await db.update(mailboxes).set({ status: 'needs_reconnect', lastError: err.message, updatedAt: new Date() })
                    .where(eq(mailboxes.id, mailbox.id)).catch(() => undefined);
            }
            throw err;
        }
    });
}

const sqlLockTimeout = sql`SET LOCAL lock_timeout = '10s'`;

/**
 * Disconnect a mailbox: forget its token and DELETE everything stored from it (plan §7.5).
 * The row goes, and mailbox_messages with it (ON DELETE CASCADE). Microsoft has no per-app revoke
 * endpoint for a delegated grant, so the user is told where to remove the app themselves.
 *
 * Only the owner can do this — the caller passes their own ids, and a mailbox that isn't theirs is
 * "not found".
 */
export async function disconnectMailbox(db: Db, organisationId: number, userId: number, mailboxId: number): Promise<boolean> {
    const row = await getOwnMailbox(db, organisationId, userId, mailboxId);
    if (!row) return false;
    // Google: revoke the grant at Google too, so the app disappears from the user's Google account at
    // once. Microsoft has no per-app revoke for a delegated grant (the user is told where to remove it).
    if (row.provider === 'gmail') {
        const tok = await getSecret(db as never, row.vaultRefKey).catch(() => null) as MailboxToken | null;
        const token = tok?.refreshToken ?? tok?.accessToken;
        if (token) {
            await fetch('https://oauth2.googleapis.com/revoke', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }),
            }).catch(() => undefined); // best effort: deleting our copy below is what matters
        }
    }
    await deleteSecret(db as never, row.vaultRefKey).catch((err) => {
        console.error('[mailboxes] vault delete failed on disconnect', { mailboxId, err: err instanceof Error ? err.message : err });
    });
    await db.delete(mailboxes).where(and(eq(mailboxes.id, row.id), eq(mailboxes.userId, userId)));
    return true;
}

/** Settings stored on a mailbox (mailboxes.settings). Pure parse; unknown shapes become defaults. */
export interface MailboxSettings {
    /** Sender address or @domain → category, learned when the user moves an email. */
    senderRules: Record<string, string>;
    /** Addresses or @domains whose email is never sent to an AI model, not even the subject. */
    privateSenders: string[];
}

export function parseMailboxSettings(raw: unknown): MailboxSettings {
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const rules: Record<string, string> = {};
    if (o.senderRules && typeof o.senderRules === 'object') {
        for (const [k, v] of Object.entries(o.senderRules as Record<string, unknown>)) {
            if (typeof v === 'string' && k.length <= 320) rules[k.toLowerCase()] = v;
        }
    }
    const privateSenders = Array.isArray(o.privateSenders)
        ? (o.privateSenders as unknown[]).filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase().trim()).filter(Boolean).slice(0, 200)
        : [];
    return { senderRules: rules, privateSenders };
}
