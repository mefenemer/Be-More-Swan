// src/utils/tenant-api-auth.ts
// Who is calling the tenant-facing API, and may they?
//
// ⚠️ AN API KEY HERE CAN SUBSCRIBE PEOPLE. That is what makes it worth more than a read token: the
// damage from a leaked one is not "somebody saw a list", it is "somebody added addresses to a list
// that then gets emailed from the tenant's own domain". Everything below follows from that.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { apiKeys } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** Live keys only for now; the prefix exists so a test-mode key is a value and not a migration. */
export const KEY_PREFIX = 'bms_live_';
/** 32 bytes of randomness. Long enough that guessing is not a threat model. */
const KEY_BYTES = 32;

export interface MintedKey {
    /** Shown to the tenant ONCE. Never stored, never logged, never recoverable. */
    key: string;
    hash: string;
    prefix: string;
}

export function mintApiKey(): MintedKey {
    const key = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString('hex')}`;
    return { key, hash: hashApiKey(key), prefix: key.slice(0, KEY_PREFIX.length + 6) };
}

/**
 * ⚠️ A plain sha256, deliberately, where a password would want bcrypt.
 *
 * A password is short, human-chosen and guessable, so its hash must be slow. This is 32 bytes of
 * CSPRNG output: there is nothing to brute-force, and a slow hash on the hot path of an API that a
 * tenant's checkout calls would be a self-inflicted rate limit. The property that matters is that
 * the stored value cannot be USED, and a one-way hash gives that.
 */
export function hashApiKey(key: string): string {
    return createHash('sha256').update(String(key)).digest('hex');
}

export type ApiAuthResult =
    | { ok: true; organisationId: number; keyId: number; scopes: string[] }
    | { ok: false; status: number; error: string; code: string };

/** Pull the bearer token out of the header, accepting the two shapes people actually send. */
export function readBearer(headers: Record<string, string | undefined>): string {
    const raw = String(headers.authorization ?? headers.Authorization ?? '').trim();
    if (!raw) return '';
    const m = raw.match(/^Bearer\s+(.+)$/i);
    return (m ? m[1] : raw).trim();
}

/**
 * Resolve a request to an organisation, or say why not.
 *
 * ⚠️ EVERY FAILURE IS THE SAME 401 with the same body. "That key exists but is revoked" tells a
 * holder of a stolen key that it was real, and "no such key" tells them to keep looking — neither
 * is worth the diagnostic value, which the tenant gets from their own key list instead.
 */
export async function authenticateApiKey(
    db: Db,
    headers: Record<string, string | undefined>,
): Promise<ApiAuthResult> {
    const denied: ApiAuthResult = {
        ok: false, status: 401, code: 'unauthorized',
        error: 'Provide a valid API key as `Authorization: Bearer <key>`.',
    };

    const presented = readBearer(headers);
    if (!presented || !presented.startsWith(KEY_PREFIX)) return denied;

    const hash = hashApiKey(presented);
    const [row] = await db
        .select({
            id: apiKeys.id,
            organisationId: apiKeys.organisationId,
            keyHash: apiKeys.keyHash,
            scopes: apiKeys.scopes,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
        .limit(1);
    if (!row) return denied;

    // The lookup already matched on the hash, so this compares two identical strings — kept because
    // it is the line that stops a future refactor from switching to a prefix lookup plus a `===`,
    // which is where a timing side-channel would actually appear.
    const a = Buffer.from(row.keyHash, 'utf8');
    const b = Buffer.from(hash, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return denied;

    // Best effort: a failure to record usage must not fail the call the tenant made.
    void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id))
        .catch((err) => console.error('[tenant-api-auth] last_used_at not recorded', { keyId: row.id }, err));

    return {
        ok: true,
        organisationId: row.organisationId,
        keyId: row.id,
        scopes: String(row.scopes || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
}

/** Redact a key for a log line. Never log the whole thing, including on an error path. */
export const redactKey = (key: string): string =>
    key ? `${key.slice(0, KEY_PREFIX.length + 6)}…` : '(none)';

/** How many rows a list endpoint will return however hard it is asked. */
export const API_PAGE_MAX = 100;

/** Per key: generous for a checkout, low enough that a runaway loop is capped. */
export const API_RATE = { maxAttempts: 600, windowSecs: 60 };
