// netlify/functions/api-keys.ts
// The tenant's own list of API keys. Session-authenticated (NOT key-authenticated) — a key must
// never be able to mint another key, or a single leak becomes permanent.
//
//   GET                          → this org's keys (prefix, name, last used, revoked)
//   POST { action: 'create' }    → mint one; the key itself is in THIS RESPONSE AND NOWHERE ELSE
//   POST { action: 'revoke' }    → turn one off, keeping the row
//
// ⚠️ Creating and revoking are owner/admin only. A key can subscribe people to a list that is
// emailed from the tenant's own domain, which puts it in the same class of decision as approving a
// send rather than the same class as editing a draft.

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { apiKeys } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { mintApiKey } from '../../src/utils/tenant-api-auth';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
});

const MANAGE_ROLES = ['owner', 'admin'];
/** More than a handful is a sign of keys being minted instead of rotated. */
const MAX_ACTIVE_KEYS = 10;

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        try {
            const keys = await db
                .select({
                    id: apiKeys.id,
                    name: apiKeys.name,
                    // ⚠️ The prefix, never the key. There is no endpoint anywhere that returns a
                    // whole key after creation, because the stored form is a hash — this is not a
                    // policy that could be relaxed later, it is arithmetic.
                    keyPrefix: apiKeys.keyPrefix,
                    scopes: apiKeys.scopes,
                    lastUsedAt: apiKeys.lastUsedAt,
                    revokedAt: apiKeys.revokedAt,
                    createdAt: apiKeys.createdAt,
                })
                .from(apiKeys)
                .where(eq(apiKeys.organisationId, ctx.organisationId))
                .orderBy(desc(apiKeys.createdAt));
            return json(200, { keys });
        } catch (err) {
            const code = (err as { code?: string; cause?: { code?: string } })?.code
                ?? (err as { cause?: { code?: string } })?.cause?.code;
            if (code !== '42P01') throw err;
            return json(200, { keys: [], needsSetup: true });
        }
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const ctx = await requireTenant(event, db, { roles: MANAGE_ROLES });
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }
    const action = String(body.action || '');

    if (action === 'create') {
        const active = await db.select({ id: apiKeys.id })
            .from(apiKeys)
            .where(and(eq(apiKeys.organisationId, orgId), isNull(apiKeys.revokedAt)));
        if (active.length >= MAX_ACTIVE_KEYS) {
            return json(400, { error: `You already have ${MAX_ACTIVE_KEYS} active keys. Revoke one before creating another.` });
        }

        const minted = mintApiKey();
        const [row] = await db.insert(apiKeys).values({
            organisationId: orgId,
            name: String(body.name || '').trim().slice(0, 60) || 'API key',
            keyHash: minted.hash,
            keyPrefix: minted.prefix,
            createdBy: ctx.userId,
        }).returning({ id: apiKeys.id, keyPrefix: apiKeys.keyPrefix, name: apiKeys.name, createdAt: apiKeys.createdAt });

        // ⚠️ The ONLY time the key itself exists outside the caller's system. Not logged here, not
        // returned by any other endpoint, not recoverable by support — the row holds a hash.
        return json(200, { key: minted.key, keyRecord: row, shownOnce: true });
    }

    if (action === 'revoke') {
        const id = Number(body.id || '');
        if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid key.' });
        // Revoked, not deleted: "this key existed and was turned off on the 3rd" is the question
        // asked after something goes wrong.
        const [updated] = await db.update(apiKeys)
            .set({ revokedAt: new Date() })
            .where(and(eq(apiKeys.id, id), eq(apiKeys.organisationId, orgId), isNull(apiKeys.revokedAt)))
            .returning({ id: apiKeys.id });
        if (!updated) return json(404, { error: 'Key not found, or already revoked.' });
        return json(200, { revoked: true });
    }

    return json(400, { error: `Unknown action: ${action}` });
});
