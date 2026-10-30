// netlify/functions/linkedin-page-pick.ts
// The Company Page picker, for a member who administers more than one Page. social-oauth-callback.ts
// stores the Pages under linkedInPagePickKey(userId) and sends the browser to
// /workspace.html?linkedin_pick=1, which asks:
//   GET            → { pages: [{ urn, name }] }    (404 when nothing is waiting or it expired)
//   POST { urn }   → binds that Page                (it must be one of the stored ones)
// The token itself never leaves the vault; only the URN chosen comes back from the browser.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { getSecret, deleteSecret } from '../../src/utils/vault';
import { bindLinkedInPage, linkedInPagePickKey, type PendingPagePick } from '../../src/utils/linkedin-page-bind';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db, { mutates: event.httpMethod === 'POST' });
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    const key = linkedInPagePickKey(userId);
    const pending = await getSecret(db, key).catch(() => null) as PendingPagePick | null;
    // Bound to the workspace that started the connect: switching workspace mid-pick must not land
    // the Page in the other one.
    if (!pending || pending.expiresAt < Date.now() || pending.organisationId !== organisationId) {
        return json(404, { error: 'That LinkedIn sign-in has expired. Connect your Company Page again.' });
    }

    if (event.httpMethod === 'GET') {
        return json(200, { pages: pending.pages, assistantId: pending.assistantId });
    }

    let urn = '';
    try { urn = String(JSON.parse(event.body || '{}').urn || ''); } catch { /* fall through */ }
    const page = pending.pages.find(p => p.urn === urn);
    if (!page) return json(400, { error: 'Choose one of the Pages listed.' });

    const bound = await bindLinkedInPage(db, {
        organisationId, userId, assistantId: pending.assistantId, page,
        tokenExpiresAt: pending.tokenExpiresAt ? new Date(pending.tokenExpiresAt) : null,
    });
    await deleteSecret(db, key).catch(() => {});
    if (!bound.ok) return json(409, { error: 'tenant_collision', collision: bound.collisionAttemptId });
    return json(200, { ok: true, page: page.name, assistantId: pending.assistantId });
});
