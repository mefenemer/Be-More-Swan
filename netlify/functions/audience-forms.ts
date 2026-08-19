// netlify/functions/audience-forms.ts
// The tenant's embeddable sign-up forms — the snippet they paste onto their own website.
// Org-scoped via requireTenant. Public ingress lives in audience-public.ts.
//
//   GET                          → the org's forms
//   POST { action: 'create' }    → new form with a fresh aud_ key
//   POST { action: 'update' }    → name, segment, double opt-in, fields, theme, copy, origins
//   POST { action: 'rotate' }    → mint a new public key (the old snippet stops working)
//   POST { action: 'delete' }    → disable the form (never destroyed — see below)
//
// ⚠️ 'delete' DISABLES rather than removes. audience_consent_events.form_id points at these rows,
// and that evidence is the answer to "which form did this person sign up through, and what did it
// say at the time". Deleting the form to tidy up a settings page would quietly cut the one link
// between a subscriber and the wording they agreed to.

import { HandlerEvent } from '@netlify/functions';
import { randomBytes } from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { audienceForms, audienceSegments } from '../../db/schema';
import {
    normaliseOrigin, sanitiseFields, validateFormTheme, validateRedirectUrl,
    DEFAULT_CONSENT_TEXT, DEFAULT_SUCCESS_MESSAGE,
} from '../../src/utils/audience-forms';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
});

// Theming and origin allowlists change what runs on the customer's own website, so they follow
// save-widget-config.ts and stay with owner/admin.
const WRITE_ROLES = ['owner', 'admin'];
const newPublicKey = () => 'aud_' + randomBytes(12).toString('hex');
const MAX_ORIGINS = 20;

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        const forms = await db
            .select()
            .from(audienceForms)
            .where(eq(audienceForms.organisationId, ctx.organisationId))
            .orderBy(desc(audienceForms.createdAt));
        return json(200, { forms });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const ctx = await requireTenant(event, db, { roles: WRITE_ROLES });
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }
    const action = String(body.action || '');

    if (action === 'create') {
        const [form] = await db.insert(audienceForms).values({
            organisationId: orgId,
            publicKey: newPublicKey(),
            name: String(body.name || 'Website sign-up').trim().slice(0, 80) || 'Website sign-up',
            consentText: DEFAULT_CONSENT_TEXT,
            successMessage: DEFAULT_SUCCESS_MESSAGE,
            createdBy: ctx.userId,
        }).returning();
        return json(200, { form });
    }

    const id = Number(body.id || '');
    if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid form.' });

    const [existing] = await db.select({ id: audienceForms.id })
        .from(audienceForms)
        .where(and(eq(audienceForms.id, id), eq(audienceForms.organisationId, orgId)))
        .limit(1);
    if (!existing) return json(404, { error: 'Form not found.' });

    if (action === 'rotate') {
        const [form] = await db.update(audienceForms)
            .set({ publicKey: newPublicKey(), updatedAt: new Date() })
            .where(and(eq(audienceForms.id, id), eq(audienceForms.organisationId, orgId)))
            .returning({ publicKey: audienceForms.publicKey });
        // Say it plainly: the snippet already on their site is now dead until they re-paste it.
        return json(200, { publicKey: form.publicKey, snippetMustBeReplaced: true });
    }

    if (action === 'delete') {
        await db.update(audienceForms)
            .set({ status: 'disabled', updatedAt: new Date() })
            .where(and(eq(audienceForms.id, id), eq(audienceForms.organisationId, orgId)));
        return json(200, { disabled: true });
    }

    if (action === 'update') {
        const patch: Record<string, unknown> = { updatedAt: new Date() };

        if ('name' in body) patch.name = String(body.name || '').trim().slice(0, 80) || 'Website sign-up';
        if ('doubleOptIn' in body) patch.doubleOptIn = body.doubleOptIn !== false;
        if ('status' in body) patch.status = body.status === 'disabled' ? 'disabled' : 'active';
        if ('fields' in body) patch.fields = sanitiseFields(body.fields);
        if ('consentText' in body) patch.consentText = String(body.consentText || '').trim().slice(0, 500) || DEFAULT_CONSENT_TEXT;
        if ('successMessage' in body) patch.successMessage = String(body.successMessage || '').trim().slice(0, 300) || DEFAULT_SUCCESS_MESSAGE;

        if ('redirectUrl' in body) {
            const url = validateRedirectUrl(body.redirectUrl);
            if (body.redirectUrl && !url) return json(400, { error: 'The redirect must be a full http(s) URL.' });
            patch.redirectUrl = url;
        }

        if ('theme' in body) {
            const theme = validateFormTheme(body.theme);
            if ('error' in theme) return json(400, { error: theme.error });
            // ⚠️ Stored WHOLESALE, like the blog widget's theme — a partial object deletes the keys
            // it omits. Clients must send the complete theme, not a patch.
            patch.theme = theme.theme;
        }

        if ('segmentId' in body) {
            const segId = Number(body.segmentId || '');
            if (Number.isFinite(segId) && segId) {
                const [seg] = await db.select({ id: audienceSegments.id }).from(audienceSegments)
                    .where(and(eq(audienceSegments.id, segId), eq(audienceSegments.organisationId, orgId))).limit(1);
                if (!seg) return json(404, { error: 'Segment not found.' });
                patch.segmentId = segId;
            } else {
                patch.segmentId = null;
            }
        }

        if ('allowedOrigins' in body) {
            // null = any origin; [] = nothing allowed. Both are legitimate and they are NOT the
            // same — see originAllowed(). An unparseable entry is rejected rather than dropped,
            // because a silently-discarded origin looks like a working allowlist that is not.
            if (body.allowedOrigins === null) {
                patch.allowedOrigins = null;
            } else if (Array.isArray(body.allowedOrigins)) {
                const list = body.allowedOrigins.slice(0, MAX_ORIGINS).map((o: unknown) => normaliseOrigin(String(o ?? '')));
                if (list.some((o: string | null) => o === null)) {
                    return json(400, { error: 'Each allowed website must be a full address, e.g. https://example.com' });
                }
                patch.allowedOrigins = [...new Set(list as string[])];
            } else {
                return json(400, { error: 'allowedOrigins must be a list of website addresses, or null for any.' });
            }
        }

        const [form] = await db.update(audienceForms).set(patch)
            .where(and(eq(audienceForms.id, id), eq(audienceForms.organisationId, orgId)))
            .returning();
        return json(200, { form });
    }

    return json(400, { error: `Unknown action: ${action}` });
});
