// netlify/functions/audience-api.ts
// The tenant-facing API: a shop, a booking system or a Zapier step writing into their own audience.
// Behind a netlify.toml rewrite:  /api/v1/*  →  /.netlify/functions/audience-api
//
//   GET    /api/v1                      → what this API can do (self-describing, no auth)
//   POST   /api/v1/contacts             → add or update one subscriber
//   GET    /api/v1/contacts/:email      → their status, source and consent basis
//   POST   /api/v1/contacts/:email/unsubscribe → opt them out
//   DELETE /api/v1/contacts/:email      → erase them (the opt-out is KEPT — see below)
//
// ⚠️ THE ONE RULE THIS API EXISTS TO NOT BREAK: A CALL CAN NEVER RESURRECT AN UNSUBSCRIBE.
// The failure mode of every tenant-facing subscriber API is a nightly sync from a CRM that does not
// know who opted out, posting the whole customer table as `subscribed` every night and quietly
// re-subscribing everyone who left. upsertContact's status ratchet already refuses that, and this
// endpoint goes further: it REPORTS the refusal, returning the status the contact actually has, so
// the caller's own system can see that its request was declined rather than assuming it landed.
//
// ⚠️ CONSENT IS DECLARED PER CALL, not configured once. `consent.basis` is required on every write —
// the same rule the CSV import applies, for the same reason: the question "who said these people
// agreed?" has to have an answer attached to the act, not to a setting somebody ticked in March.

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { audienceContacts } from '../../db/schema';
import { looksLikeEmail, normaliseEmail, cleanName } from '../../src/utils/audience-contacts';
import {
    recordConsentEvent, setContactStatus, upsertContact,
    type ConsentBasis, type ContactStatus,
} from '../../src/utils/audience-store';
import { loadCustomFieldKeys } from '../../src/utils/audience-custom-fields';
import { isValidTimezone } from '../../src/utils/newsletter-schedule';
import { API_RATE, authenticateApiKey } from '../../src/utils/tenant-api-auth';
import { checkRateLimit } from '../../src/utils/rate-limit';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
});

const fail = (statusCode: number, code: string, error: string, extra: Record<string, unknown> = {}) =>
    json(statusCode, { error, code, ...extra });

/**
 * What a caller may declare, and what each one means.
 *
 * ⚠️ NOT free text. A basis this product cannot explain later is not evidence — the point of the
 * column is that "why were we allowed to email this person" has an answer drawn from a closed list
 * that the audience UI and the export both know how to render.
 */
const CONSENT_BASES: ConsentBasis[] = ['double_opt_in', 'single_opt_in', 'imported_declared', 'soft_opt_in', 'manual_entry'];

/** Only keys within the tenant's own defined custom fields are stored — same allow-list as import. */
function pickCustom(raw: unknown, allowed: Set<string>): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!allowed.has(k)) continue;
        const value = String(v ?? '').trim().slice(0, 500);
        if (value) out[k] = value;
    }
    return out;
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    const method = event.httpMethod;
    const path = (event.rawUrl ? new URL(event.rawUrl).pathname : event.path || '');

    if (method === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            },
            body: '',
        };
    }

    // The index answers without a key. A developer with the base url and no credentials should be
    // able to find out what to ask for — it lists shapes, never data.
    if (method === 'GET' && /\/api\/v1\/?$/.test(path)) {
        return json(200, {
            version: 1,
            auth: 'Authorization: Bearer <your API key>',
            endpoints: [
                { method: 'POST', path: '/api/v1/contacts', body: { email: 'jane@example.com', firstName: 'Jane', consent: { basis: CONSENT_BASES, text: 'what they agreed to', source: 'https://…' } } },
                { method: 'GET', path: '/api/v1/contacts/{email}' },
                { method: 'POST', path: '/api/v1/contacts/{email}/unsubscribe' },
                { method: 'DELETE', path: '/api/v1/contacts/{email}' },
            ],
            notes: [
                'A write can never move somebody out of unsubscribed, bounced, complained or suppressed. The response returns the status they actually have.',
                'consent.basis is required on every write.',
            ],
        });
    }

    const auth = await authenticateApiKey(db, (event.headers || {}) as Record<string, string | undefined>);
    if (!auth.ok) return fail(auth.status, auth.code, auth.error);
    const orgId = auth.organisationId;

    // Per KEY, not per IP: a tenant's server has one address and may legitimately be busy, while a
    // runaway loop is what this actually bounds.
    const limit = await checkRateLimit(db, 'audience-api', `key:${auth.keyId}`, API_RATE);
    if (!limit.allowed) {
        return fail(429, 'rate_limited', 'Too many requests. Slow down and try again shortly.');
    }

    const emailMatch = path.match(/\/api\/v1\/contacts\/([^/]+)(\/unsubscribe)?$/);
    const pathEmail = emailMatch ? normaliseEmail(decodeURIComponent(emailMatch[1])) : '';

    // ── GET one contact ─────────────────────────────────────────────────────
    if (method === 'GET' && emailMatch && !emailMatch[2]) {
        if (!looksLikeEmail(pathEmail)) return fail(400, 'invalid_email', 'That is not a valid email address.');
        const [row] = await db
            .select({
                email: audienceContacts.email,
                firstName: audienceContacts.firstName,
                lastName: audienceContacts.lastName,
                company: audienceContacts.company,
                status: audienceContacts.status,
                source: audienceContacts.source,
                consentBasis: audienceContacts.consentBasis,
                confirmedAt: audienceContacts.confirmedAt,
                unsubscribedAt: audienceContacts.unsubscribedAt,
                customFields: audienceContacts.customFields,
                createdAt: audienceContacts.createdAt,
            })
            .from(audienceContacts)
            .where(and(eq(audienceContacts.organisationId, orgId), eq(audienceContacts.email, pathEmail)))
            .limit(1);
        if (!row) return fail(404, 'not_found', 'No contact with that address.');
        return json(200, { contact: row });
    }

    // ── Unsubscribe ─────────────────────────────────────────────────────────
    if (method === 'POST' && emailMatch && emailMatch[2]) {
        if (!looksLikeEmail(pathEmail)) return fail(400, 'invalid_email', 'That is not a valid email address.');
        const res = await setContactStatus(db, {
            organisationId: orgId,
            email: pathEmail,
            status: 'unsubscribed',
            event: 'unsubscribed',
            channel: 'api',
            evidence: `Unsubscribed through the API by key #${auth.keyId}.`,
        });
        // Not found is not an error here. "Make sure this person is not subscribed" is satisfied by
        // an address we have never held, and returning 404 would push callers into ignoring it.
        return json(200, { email: pathEmail, status: 'unsubscribed', changed: res.changed });
    }

    // ── DELETE ──────────────────────────────────────────────────────────────
    if (method === 'DELETE' && emailMatch && !emailMatch[2]) {
        if (!looksLikeEmail(pathEmail)) return fail(400, 'invalid_email', 'That is not a valid email address.');
        // ⚠️ Refused, deliberately, and this is the one place the API says no to something the
        // dashboard allows. Erasing through the dashboard writes a lead_opt_outs row FIRST so the
        // address stays blocked (see THE DELETE RULE in audience-contacts.ts); doing that silently
        // from an automated nightly sync would leave a tenant with a growing opt-out list they
        // never chose and cannot see the reason for. Erasure is a decision, not a sync artefact.
        return fail(405, 'use_dashboard',
            'Deleting a contact also records a permanent block on that address, so it is done from the Audience page rather than through the API. Use POST /unsubscribe to stop emailing somebody.');
    }

    // ── Create or update ────────────────────────────────────────────────────
    if (method === 'POST' && /\/api\/v1\/contacts\/?$/.test(path)) {
        let body: Record<string, unknown>;
        try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
        catch { return fail(400, 'invalid_json', 'The request body is not valid JSON.'); }

        const email = normaliseEmail(String(body.email ?? ''));
        if (!looksLikeEmail(email)) return fail(400, 'invalid_email', 'Provide a valid `email`.');

        const consent = (body.consent ?? {}) as Record<string, unknown>;
        const basis = String(consent.basis ?? '') as ConsentBasis;
        if (!CONSENT_BASES.includes(basis)) {
            return fail(400, 'consent_required',
                `Every write must declare how this person agreed: set consent.basis to one of ${CONSENT_BASES.join(', ')}.`,
                { allowed: CONSENT_BASES });
        }

        const wanted = String(body.status ?? 'subscribed');
        if (!['subscribed', 'pending'].includes(wanted)) {
            // Every other status is something that HAPPENED to a contact (a bounce, a complaint) or
            // a decision they made. A caller announcing one would be writing a fact it cannot know.
            return fail(400, 'invalid_status', 'status must be "subscribed" or "pending". Use the unsubscribe endpoint to opt somebody out.');
        }

        const customKeys = new Set(await loadCustomFieldKeys(db, orgId));
        const res = await upsertContact(db, {
            organisationId: orgId,
            email,
            firstName: cleanName(String(body.firstName ?? '')),
            lastName: cleanName(String(body.lastName ?? '')),
            company: cleanName(String(body.company ?? '')),
            phone: cleanName(String(body.phone ?? '')),
            status: wanted as ContactStatus,
            source: 'api',
            consentBasis: basis,
            confirmedAt: wanted === 'subscribed' ? new Date() : null,
            timezone: isValidTimezone(body.timezone) ? String(body.timezone) : null,
            customFields: pickCustom(body.custom, customKeys),
            sourceDetail: { apiKeyId: auth.keyId, consentSource: String(consent.source ?? '').slice(0, 500) || null },
        });

        await recordConsentEvent(db, {
            organisationId: orgId,
            contactId: res.id,
            email,
            // The event says what actually happened to the row, not what was asked for.
            event: res.status === 'subscribed' ? 'confirmed' : 'subscribe_requested',
            channel: 'api',
            sourceUrl: String(consent.source ?? '').slice(0, 500) || null,
            evidence: String(consent.text ?? '').slice(0, 1000)
                || `Declared ${basis} through the API by key #${auth.keyId}.`,
        });

        // ⚠️ THE STATUS WE RETURN IS THE ONE THEY HAVE, not the one that was asked for. A nightly
        // sync posting its whole customer table as `subscribed` gets `unsubscribed` back for the
        // people who left — visibly, so the caller's own system can stop trying.
        const honoured = res.status === wanted;
        return json(res.created ? 201 : 200, {
            contact: { email, status: res.status },
            created: res.created,
            statusHonoured: honoured,
            ...(honoured ? {} : {
                note: 'This contact has already opted out, bounced or been suppressed, so the requested status was not applied. Nothing here can undo that except the person themselves.',
            }),
        });
    }

    return fail(404, 'not_found', 'Unknown endpoint. GET /api/v1 lists what this API can do.');
});
