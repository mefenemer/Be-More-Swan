// netlify/functions/accept-dpa.ts
// US-GDPR-1.1.1: Record DPA acceptance for an organisation.
// POST /.netlify/functions/accept-dpa
//   Cookie: aura_session (authenticated owner or admin of the active organisation)
//
// Inserts an append-only row into dpa_acceptances, always against CURRENT_DPA_VERSION — the server
// decides what was accepted, never the client (the modal used to post a hard-coded '1.0').
// Returns { accepted: true, version, organisationId }

import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, dpaAcceptances } from '../../db/schema';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { retryBlockedAssistants } from '../../src/utils/retry-provisioning';
import { pseudonymiseIp } from '../../src/utils/ip-pseudonymise';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

// The text of each version lives in get-dpa-content.ts. Bumping this asks every workspace owner to
// accept again at their next login (workspace.html) — see the note above DPA_1_1_HTML.
export const CURRENT_DPA_VERSION = '1.1';

/**
 * Versions that still satisfy the "has this organisation accepted the DPA?" gates (hire, onboarding,
 * provisioning, opening an assistant). 1.1 changed no obligation the customer relies on to keep
 * working, so an organisation on 1.0 keeps running while its owner is asked to accept 1.1 — bumping
 * the version must never lock every existing customer out of their assistants. A future change that
 * must be accepted before work continues drops the old version from this list.
 */
export const DPA_VERSIONS_STILL_VALID = ['1.0', '1.1'];
export const dpaAcceptedVersionClause = () => inArray(dpaAcceptances.version, DPA_VERSIONS_STILL_VALID);

/** An agreement made on behalf of the organisation — only someone who can bind it may accept. */
export const DPA_ACCEPT_ROLES = ['owner', 'admin'];

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    if (!DPA_ACCEPT_ROLES.includes(ctx.role)) {
        return {
            statusCode: 403,
            body: JSON.stringify({ error: 'Only the workspace owner or an admin can accept the Data Processing Agreement for your organisation.', code: 'DPA_ROLE' }),
        };
    }

    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId)).limit(1);
    if (!user?.email) return { statusCode: 400, body: JSON.stringify({ error: 'Account not found.' }) };

    // Truncated, never stored whole — the privacy policy promises it (src/utils/ip-pseudonymise.ts).
    const ipAddress = pseudonymiseIp(event.headers['x-nf-client-connection-ip']
        || event.headers['x-forwarded-for']?.split(',')[0]?.trim());
    const userAgent = event.headers['user-agent'] || null;

    await db.insert(dpaAcceptances).values({
        organisationId: ctx.organisationId,
        version: CURRENT_DPA_VERSION,
        ipAddress,
        userAgent,
        email: user.email,
    });

    // Re-trigger any assistants this org blocked on a DPA gate (best-effort; re-evaluates all gates).
    const baseUrl = resolveBaseUrl(event.headers);
    if (baseUrl) {
        await retryBlockedAssistants(db, { baseUrl, organisationId: ctx.organisationId }).catch(() => {});
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accepted: true, version: CURRENT_DPA_VERSION, organisationId: ctx.organisationId }),
    };
});
