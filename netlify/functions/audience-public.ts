// netlify/functions/audience-public.ts
// The PUBLIC front door of the audience layer — the only place an anonymous browser on someone
// else's website can write into a tenant's data. Behind a netlify.toml rewrite:
//   /api/audience/*  →  /.netlify/functions/audience-public
//
//   GET  /s/:key                   → the HOSTED sign-up page, for tenants with no website
//   GET  /api/audience/form/:key   → the form's public config (what subscribe.js renders)
//   POST /api/audience/subscribe   → a sign-up  { key, email, firstName?, lastName?, company?, timezone?, hp, ms, url }
//   GET  /api/audience/confirm?t=  → the confirmation PAGE (renders a form; changes nothing)
//   POST /api/audience/confirm     → the confirmation itself
//
// ⚠️ WHY GET DOES NOT CONFIRM. Mail scanners, corporate link rewriters and antivirus proxies fetch
// every URL in an email. If the GET completed the subscription, those clients would confirm on the
// recipient's behalf and double opt-in would be decorative. So GET renders a page with a button and
// the POST does the work. lead-unsubscribe.ts has the mirror-image rule (HEAD must not opt out) for
// the same reason, in the other direction.
//
// ⚠️ WHY EVERY OUTCOME LOOKS THE SAME. "That address is already subscribed" tells anyone holding the
// snippet whether a given person is on a tenant's list. Every non-input error returns the identical
// body, and so do the honeypot and timing rejections — a bot that can tell it was caught is a bot
// that adapts.

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    audienceConfirmations, audienceContacts, audienceFormSubmissions, audienceForms, organisations,
} from '../../db/schema';
import { looksLikeEmail, normaliseEmail, cleanName } from '../../src/utils/audience-contacts';
import { addToSegment, applyTagsByName, recordConsentEvent, setContactStatus, upsertContact } from '../../src/utils/audience-store';
import { bindConversion } from '../../src/utils/campaign-attribution-store';
import { enrolAfterSignup, enrolInWelcomeSequence } from '../../src/utils/newsletter-sequence';
import {
    FORM_KEY_RE, MIN_FILL_MS, originAllowed,
    DEFAULT_CONSENT_TEXT, DEFAULT_SUCCESS_MESSAGE, SINGLE_OPT_IN_SUCCESS_MESSAGE,
} from '../../src/utils/audience-forms';
import {
    CONFIRM_RESEND_COOLDOWN_MS, CONFIRM_TTL_DAYS, MAX_CONFIRM_SENDS,
    hashConfirmToken, mintConfirmToken, sendConfirmationEmail,
} from '../../src/utils/audience-email';
import { checkRateLimit, getClientIp } from '../../src/utils/rate-limit';
import { pseudonymiseIp } from '../../src/utils/ip-pseudonymise';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { isValidTimezone } from '../../src/utils/newsletter-schedule';
import {
    definitionHash, legacyToDefinition, normaliseFormDefinition, publicDefinition, validateAnswers, SLUG_RE,
    type FormDefinition,
} from '../../src/utils/form-definition';
import { signAssetId } from '../../src/utils/newsletter-media-url';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Per-IP: a person signs up once. Ten a minute is already a script. */
const IP_LIMIT = { maxAttempts: 10, windowSecs: 60 };
/** Per-form: bounds one key's total damage even from a rotating address pool. */
const KEY_LIMIT = { maxAttempts: 200, windowSecs: 3600 };

const esc = (s: string): string => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A page that is off, or a key that never was, answer identically. */
export function hostedMissing() {
    return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
        body: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Page not found</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;padding:4rem 1rem;color:#374151">
<p style="font-size:2rem;margin:0 0 1rem">🔍</p><h1 style="font-size:1.15rem;margin:0 0 .5rem">This sign-up page is not available</h1>
<p style="color:#6b7280">The link may be old, or the page may have been turned off.</p></body></html>`,
    };
}

/** The columns every public read needs to resolve a form's definition. */
const FORM_COLUMNS = {
    id: audienceForms.id,
    organisationId: audienceForms.organisationId,
    publicKey: audienceForms.publicKey,
    name: audienceForms.name,
    fields: audienceForms.fields,
    theme: audienceForms.theme,
    consentText: audienceForms.consentText,
    successMessage: audienceForms.successMessage,
    doubleOptIn: audienceForms.doubleOptIn,
    redirectUrl: audienceForms.redirectUrl,
    status: audienceForms.status,
    allowedOrigins: audienceForms.allowedOrigins,
    segmentId: audienceForms.segmentId,
    hostedEnabled: audienceForms.hostedEnabled,
    hostedHeadline: audienceForms.hostedHeadline,
    hostedIntro: audienceForms.hostedIntro,
    definition: audienceForms.definition,
    sequenceId: audienceForms.sequenceId,
    orgName: organisations.name,
};

/**
 * A form's definition, whatever era it was saved in. A row with a stored definition goes through the
 * normaliser again on the way OUT — the gate is cheap, and a definition written by an older build
 * must not reach a stranger's browser on the strength of having once been valid.
 */
export function resolveDefinition(row: Parameters<typeof legacyToDefinition>[0] & { definition?: unknown }): FormDefinition {
    return row.definition ? normaliseFormDefinition(row.definition).definition : legacyToDefinition(row);
}

/** Path-only (same origin as whatever serves it): the renderer refuses any logo from elsewhere. */
function logoPath(def: FormDefinition): string | null {
    const id = def.style.logo?.assetId;
    if (!id) return null;
    try { return `/api/newsletter/media?a=${id}&s=${signAssetId(id)}`; }
    catch { return null; }   // no signing secret in this environment — the form simply has no logo
}

/**
 * JSON that is safe inside a <script> element. JSON.stringify leaves `</script>` intact, which closes
 * the element and turns everything after it into markup — on OUR domain, written by a tenant.
 */
export function inlineJson(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * The hosted sign-up page — /f/<slug> or /s/<key>.
 *
 * A shell: the definition is inlined as JSON and drawn by /subscribe.js, the SAME renderer that draws
 * the form on a customer's own website and in the form builder's preview. One renderer is one set of
 * escaping rules, one set of style tokens and one honeypot — two renderers is how the hosted page
 * once lacked protections the embed had.
 *
 * ⚠️ NOINDEX, deliberately. The value here is a link somebody puts in a bio, on a poster or behind a
 * QR code — being found by search adds nothing a form page could realistically rank for, while an
 * abandoned or half-configured page indexed under our domain, carrying a tenant's name, is a real
 * cost. The link works exactly as well either way.
 *
 * ⚠️ It carries the SAME anti-bot pair as the embeddable widget — the renderer's honeypot and its
 * minimum fill time. A public url on our own domain is a more attractive target than a form on one
 * small business's website, not a less attractive one.
 */
export function hostedPage(target: { key?: string; slug?: string }, def: ReturnType<typeof publicDefinition>, orgName: string) {
    const title = def.content.headline || 'Sign up';
    const bg = /^#[0-9a-f]{6}$/i.test(def.style.pageBackground) ? def.style.pageBackground : '#f9fafb';
    const attr = target.slug ? `data-bms-slug="${esc(target.slug)}"` : `data-bms-key="${esc(target.key || '')}"`;
    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex',
            // Our own script and API. Images: the signed media proxy is ours but 302s to a fresh presigned
            // storage URL, and CSP checks every redirect hop — hence https: (the renderer only ever asks for
            // a logo on our own origin).
            // style-src stays 'unsafe-inline' for the renderer's shadow-root <style>; every value in
            // it is a validated token.
            'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https:; connect-src 'self'; base-uri 'none'; form-action 'none'",
            'Referrer-Policy': 'no-referrer',
        },
        body: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — ${esc(orgName)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;box-sizing:border-box;background:${bg}}
#bms-form{width:100%;max-width:28rem}</style>
</head>
<body>
<div id="bms-form"></div>
<noscript><p style="font-family:sans-serif;text-align:center">This form needs JavaScript. Please contact ${esc(orgName)} directly to sign up.</p></noscript>
<script type="application/json" id="bms-def">${inlineJson(def)}</script>
<script src="/subscribe.js" data-bms-hosted ${attr}></script>
</body>
</html>`,
    };
}

function corsHeaders(origin: string | null, methods = 'POST, OPTIONS') {
    return {
        // Reflected, not '*': a reflected origin is what lets a locked-down form stay locked down
        // while an open one still works from any site.
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': methods,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
    };
}

const json = (statusCode: number, obj: unknown, origin: string | null = null, extra: Record<string, string> = {}) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...extra },
    body: JSON.stringify(obj),
});

function page(statusCode: number, heading: string, bodyHtml: string, icon = '✅') {
    return {
        statusCode,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        body: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(heading)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;padding:1rem}
.card{background:#fff;border-radius:1rem;padding:2.5rem;max-width:460px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#6b7280;font-size:.925rem;line-height:1.6;margin:.5rem 0}
button{cursor:pointer;background:#059669;color:#fff;border:none;font-size:.95rem;font-weight:700;padding:.75rem 1.25rem;border-radius:.6rem;margin-top:1rem}</style></head>
<body><div class="card">
  <div style="font-size:2rem;margin-bottom:1rem">${icon}</div>
  <h1>${esc(heading)}</h1>
  ${bodyHtml}
</div></body></html>`,
    };
}

export default withLambda(async (event: HandlerEvent) => {
    const method = event.httpMethod;
    const origin = event.headers?.origin || event.headers?.Origin || null;

    // A link scanner pre-fetching with HEAD must never change anything.
    if (method === 'HEAD') return { statusCode: 200, body: '' };
    if (method === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin, 'GET, POST, OPTIONS'), body: '' };

    const path = (event.rawUrl ? new URL(event.rawUrl).pathname : event.path || '');
    const db = getDb();

    // ── The widget's own config ─────────────────────────────────────────────
    const cfgMatch = path.match(/\/api\/audience\/form\/([^/]+)/);
    if (cfgMatch && method === 'GET') {
        const key = cfgMatch[1];
        if (!FORM_KEY_RE.test(key)) return json(404, { error: 'Form not found.' }, origin);

        const [form] = await db.select(FORM_COLUMNS).from(audienceForms)
            .leftJoin(organisations, eq(organisations.id, audienceForms.organisationId))
            .where(eq(audienceForms.publicKey, key)).limit(1);

        if (!form || form.status !== 'active') return json(404, { error: 'Form not found.' }, origin);
        const def = resolveDefinition(form);
        // The embed can be switched off while the hosted page stays on.
        if (!def.delivery.embed.enabled) return json(404, { error: 'Form not found.' }, origin);

        return json(200, {
            definition: publicDefinition(def, { logoUrl: logoPath(def), senderName: form.orgName || '' }),
            // ⚠️ The pre-definition shape, kept for copies of the old subscribe.js still sitting in
            // browser caches on customers' sites. Derived from the same definition, so they agree.
            name: def.name,
            fields: def.fields.filter((f) => f.target.kind === 'contact').map((f) => (f.target as { column: string }).column),
            theme: { accent: def.style.accent, layout: def.style.layout, buttonLabel: def.content.buttonLabel },
            consentText: def.consent.text,
            successMessage: def.content.successMessage,
            doubleOptIn: def.audience.doubleOptIn,
            redirectUrl: def.content.redirectUrl,
            senderName: form.orgName || '',
        }, origin);
    }

    // ── The hosted sign-up page ─────────────────────────────────────────────
    // /f/<slug> (a name the tenant chose) or /s/<key> (the original, random). For the customers who
    // have no website to embed a form in. Same form, same consent text, same double opt-in setting —
    // a second description of what somebody agreed to is the one that drifts from the one they saw.
    const slugMatch = path.match(/^\/f\/([^/?#]+)/);
    const hostedMatch = path.match(/^\/s\/([^/?#]+)/);
    if ((slugMatch || hostedMatch) && method === 'GET') {
        const slug = slugMatch ? decodeURIComponent(slugMatch[1]).toLowerCase() : '';
        const key = hostedMatch ? hostedMatch[1] : '';
        // Validated BEFORE it reaches a query or the page. Neither value is ever interpolated raw.
        if (slugMatch ? !SLUG_RE.test(slug) : !FORM_KEY_RE.test(key)) return hostedMissing();

        const [form] = await db.select(FORM_COLUMNS).from(audienceForms)
            .leftJoin(organisations, eq(organisations.id, audienceForms.organisationId))
            .where(slugMatch ? sql`lower(${audienceForms.slug}) = ${slug}` : eq(audienceForms.publicKey, key))
            .limit(1);

        // A page that is switched off answers exactly like one that never existed. Whether a given
        // tenant has a sign-up page is not something a stranger with a url should learn.
        if (!form || form.status !== 'active' || !form.hostedEnabled) return hostedMissing();
        const def = resolveDefinition(form);
        const orgName = form.orgName || 'this business';
        const pub = publicDefinition(def, { logoUrl: logoPath(def), senderName: orgName });
        if (!pub.content.headline) pub.content.headline = def.name;
        return hostedPage(slugMatch ? { slug } : { key }, pub, orgName);
    }

    // ── Confirmation ────────────────────────────────────────────────────────
    if (path.includes('/api/audience/confirm')) {
        const token = (event.queryStringParameters?.t
            || (method === 'POST' ? new URLSearchParams(event.body || '').get('t') : '')
            || '').trim();

        if (!token || token.length < 16 || token.length > 128) {
            return page(400, 'This link is not valid', '<p>The confirmation link looks incomplete. Please sign up again and we will send a fresh one.</p>', '⚠️');
        }

        if (method === 'GET') {
            // Renders, records nothing. The button below is the consent action.
            return page(200, 'Confirm your subscription',
                `<p>Click the button to confirm you want to receive these emails.</p>
                 <form method="POST" action="/api/audience/confirm">
                   <input type="hidden" name="t" value="${esc(token)}">
                   <button type="submit">Yes, confirm my subscription</button>
                 </form>`, '📬');
        }
        if (method !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

        try {
            const [row] = await db
                .select({
                    id: audienceConfirmations.id,
                    organisationId: audienceConfirmations.organisationId,
                    contactId: audienceConfirmations.contactId,
                    formId: audienceConfirmations.formId,
                    expiresAt: audienceConfirmations.expiresAt,
                    confirmedAt: audienceConfirmations.confirmedAt,
                    email: audienceContacts.email,
                    status: audienceContacts.status,
                    senderName: organisations.name,
                })
                .from(audienceConfirmations)
                .leftJoin(audienceContacts, eq(audienceContacts.id, audienceConfirmations.contactId))
                .leftJoin(organisations, eq(organisations.id, audienceConfirmations.organisationId))
                .where(eq(audienceConfirmations.tokenHash, hashConfirmToken(token)))
                .limit(1);

            if (!row || !row.email) {
                return page(404, 'We could not find that request',
                    '<p>This link may have already been used or has expired. Sign up again and we will send a fresh one.</p>', '⚠️');
            }

            const who = esc(row.senderName || 'them');

            // Idempotent: a second click, or a click after the mail client pre-fetched, lands here.
            if (row.confirmedAt || row.status === 'subscribed') {
                return page(200, 'You are already subscribed', `<p>Nothing more to do — you will hear from ${who} soon.</p>`);
            }
            if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
                return page(410, 'This link has expired',
                    `<p>Confirmation links last ${CONFIRM_TTL_DAYS} days. Please sign up again and we will send a new one.</p>`, '⏳');
            }
            // A complaint or a hard bounce is terminal, and a confirmation click does not undo it.
            if (row.status === 'complained' || row.status === 'bounced') {
                return page(200, 'Thanks — nothing to confirm',
                    '<p>This address is not able to receive these emails. If that is a mistake, contact the sender directly.</p>', 'ℹ️');
            }

            await setContactStatus(db, {
                organisationId: row.organisationId,
                email: row.email,
                status: 'subscribed',
                // 'resubscribed' when they had previously opted out and chose to come back; the
                // distinction is what tells a later reader that an opt-out was reversed by the
                // person themselves rather than by an import.
                event: row.status === 'unsubscribed' ? 'resubscribed' : 'confirmed',
                channel: 'email_link',
                formId: row.formId,
                evidence: 'Confirmed by clicking the link in the double opt-in email.',
            });

            await db.update(audienceConfirmations)
                .set({ confirmedAt: new Date() })
                .where(eq(audienceConfirmations.id, row.id));

            // Segment membership is applied at CONFIRMATION, not at sign-up: an unconfirmed address
            // sitting inside "Weekly newsletter" makes every segment count overstate what a send
            // will actually reach.
            if (row.formId && row.contactId) {
                const [form] = await db.select({ segmentId: audienceForms.segmentId })
                    .from(audienceForms).where(eq(audienceForms.id, row.formId)).limit(1);
                if (form?.segmentId) {
                    try { await addToSegment(db, row.contactId, form.segmentId, null); }
                    catch (err) { console.error('[audience-public] confirmed but segment assignment failed', { formId: row.formId }, err); }
                }
                // Tags wait for confirmation for the same reason segments do.
                try {
                    const pendingTags = await db.select({ id: audienceFormSubmissions.id, tags: audienceFormSubmissions.tags })
                        .from(audienceFormSubmissions)
                        .where(and(eq(audienceFormSubmissions.contactId, row.contactId), eq(audienceFormSubmissions.formId, row.formId), isNull(audienceFormSubmissions.tagsAppliedAt)));
                    const names = [...new Set(pendingTags.flatMap((p) => (Array.isArray(p.tags) ? p.tags as string[] : [])))];
                    if (names.length) await applyTagsByName(db, row.organisationId, row.contactId, names);
                    if (pendingTags.length) {
                        await db.update(audienceFormSubmissions).set({ tagsAppliedAt: new Date() })
                            .where(and(eq(audienceFormSubmissions.contactId, row.contactId), eq(audienceFormSubmissions.formId, row.formId), isNull(audienceFormSubmissions.tagsAppliedAt)));
                    }
                } catch (err) { console.error('[audience-public] confirmed but tagging failed', { formId: row.formId }, err); }
            }

            // The moment of maximum interest. Best-effort by design: enrolInWelcomeSequence never
            // throws, because a confirmation that 500s over a welcome email would leave somebody
            // who just clicked "confirm" believing they had failed to subscribe.
            // ⚠️ enrolInWelcomeSequence is still the floor (a contact confirmed through a form that has
            // since been deleted gets the welcome sequence); enrolAfterSignup adds the form's own campaign.
            if (row.contactId) {
                const [src] = row.formId
                    ? await db.select({ definition: audienceForms.definition, sequenceId: audienceForms.sequenceId })
                        .from(audienceForms).where(eq(audienceForms.id, row.formId)).limit(1)
                    : [];
                if (src) {
                    await enrolAfterSignup(db, {
                        organisationId: row.organisationId, contactId: row.contactId, email: row.email,
                        formSequenceId: src.sequenceId ?? null,
                        skipWelcome: src.definition ? normaliseFormDefinition(src.definition).definition.campaign.skipWelcome : false,
                    });
                } else {
                    await enrolInWelcomeSequence(db, {
                        organisationId: row.organisationId,
                        contactId: row.contactId,
                        email: row.email,
                    });
                }
            }

            return page(200, 'You are subscribed', `<p>Thanks — you will hear from ${who} soon. Every email carries an unsubscribe link.</p>`);
        } catch (err) {
            // Never a stack trace to a member of the public, and never a retry loop for a mail
            // client. Log loudly: an unrecorded confirmation is a subscriber who never gets mail.
            console.error('[audience-public] confirmation failed', err);
            return page(500, 'Something went wrong',
                '<p>We could not confirm your subscription just now. Please try the link again in a few minutes.</p>', '⚠️');
        }
    }

    // ── Sign-up ─────────────────────────────────────────────────────────────
    if (!path.includes('/api/audience/subscribe')) return json(404, { error: 'Not found.' }, origin);
    if (method !== 'POST') return json(405, { error: 'Method Not Allowed' }, origin);

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid request.' }, origin); }

    // A form is addressed by its public key (the embed, /s/<key>) or its slug (/f/<slug>).
    const key = String(body.key || '');
    const slugIn = String(body.slug || '').toLowerCase();
    const byKey = FORM_KEY_RE.test(key);
    if (!byKey && !SLUG_RE.test(slugIn)) return json(404, { error: 'Form not found.' }, origin);

    const [form] = await db
        .select({ ...FORM_COLUMNS, senderName: organisations.name })
        .from(audienceForms)
        .leftJoin(organisations, eq(organisations.id, audienceForms.organisationId))
        .where(byKey ? eq(audienceForms.publicKey, key) : sql`lower(${audienceForms.slug}) = ${slugIn}`)
        .limit(1);

    if (!form || form.status !== 'active') return json(404, { error: 'Form not found.' }, origin);
    // ⚠️ A slug only ever addresses the HOSTED page. Without this, a form whose page is switched off
    // could still be posted to by anyone who learned its slug.
    if (!byKey && !form.hostedEnabled) return json(404, { error: 'Form not found.' }, origin);
    const def = resolveDefinition(form);
    const surface: 'embed' | 'hosted' = body.surface === 'hosted' ? 'hosted' : 'embed';

    // The one error this endpoint states plainly: it is the tenant's own misconfiguration, it
    // leaks nothing about any subscriber, and a silent failure here is a form that "just does
    // nothing" on their website with no way to diagnose it.
    // ⚠️ OUR OWN PAGE IS AN ALLOWED ORIGIN ONLY WHEN THE TENANT SWITCHED IT ON. A form locked to
    // the tenant's website would otherwise refuse the hosted page we serve for them — and relaxing
    // the check for our origin unconditionally would mean any form, including one deliberately
    // locked down, could be posted to from a page anyone can open.
    const fromHostedPage = form.hostedEnabled && !!origin && origin === resolveBaseUrl(event.headers as Record<string, string | undefined>);
    if (!fromHostedPage && !originAllowed(form.allowedOrigins, origin)) {
        return json(403, {
            error: 'This website is not on the allowed list for this sign-up form.',
            code: 'origin_not_allowed',
        }, origin);
    }

    const successBody = {
        ok: true,
        message: form.successMessage
            || (form.doubleOptIn ? DEFAULT_SUCCESS_MESSAGE : SINGLE_OPT_IN_SUCCESS_MESSAGE),
        redirectUrl: form.redirectUrl || null,
    };

    // Honeypot and timing. Both answer with the SAME success body — a bot that learns it was
    // caught is a bot that comes back without the tell.
    if (String(body.hp || '').trim()) return json(200, successBody, origin);
    const elapsed = Number(body.ms);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS) return json(200, successBody, origin);

    const ip = getClientIp((event.headers || {}) as Record<string, string | undefined>);
    try {
        const perIp = await checkRateLimit(db, 'audience_subscribe', ip, IP_LIMIT);
        if (!perIp.allowed) {
            return json(429, { error: 'Too many sign-ups from this connection. Please try again shortly.' }, origin,
                { 'Retry-After': String(perIp.retryAfterSecs) });
        }
        const perKey = await checkRateLimit(db, 'audience_subscribe_key', form.publicKey, KEY_LIMIT);
        if (!perKey.allowed) {
            return json(429, { error: 'This form is temporarily busy. Please try again shortly.' }, origin,
                { 'Retry-After': String(perKey.retryAfterSecs) });
        }
    } catch (err) {
        // The limiter is not the feature. A limiter outage must not take a customer's sign-up form
        // down with it — the other controls (origin, honeypot, timing, double opt-in) still stand.
        console.error('[audience-public] rate limiter unavailable — allowing the request', err);
    }

    // ⚠️ The answers are checked against the STORED definition — required questions, the options a
    // choice may take, the shape of a phone number. The browser's copy of the form is never trusted.
    // A submission with no `answers` is an older cached subscribe.js posting the flat shape; it is
    // mapped onto the definition's contact fields and checked exactly the same way.
    const rawAnswers = body.answers && typeof body.answers === 'object' ? body.answers : (() => {
        const flat: Record<string, unknown> = { email: body.email, first_name: body.firstName, last_name: body.lastName, company: body.company };
        const out: Record<string, unknown> = {};
        for (const f of def.fields) if (f.target.kind === 'contact') out[f.id] = flat[f.target.column];
        return out;
    })();
    const checked = validateAnswers(def, rawAnswers);
    if (!checked.ok) return json(400, { error: checked.error }, origin);
    const answers = checked.answers;

    const email = normaliseEmail(answers.email);
    if (!looksLikeEmail(email)) return json(400, { error: 'Enter a valid email address.' }, origin);

    const orgId = form.organisationId;
    const ipHash = pseudonymiseIp(ip);
    const userAgent = event.headers?.['user-agent'] || null;
    const sourceUrl = String(body.url || '').slice(0, 500) || null;
    // ⚠️ Separate from sourceUrl, and deliberately capped LONGER. sourceUrl is consent evidence and
    // 500 chars is plenty to identify a page; this one is parsed for the ?bmsc= click ref, which
    // sits at the END of the query string and would be silently truncated away on any long URL —
    // producing a campaign that mysteriously attributes nothing on exactly the pages that carry
    // the most tracking parameters. 2000 is the practical URL ceiling browsers agree on.
    const pageUrl = String(body.url || '').slice(0, 2000) || null;

    try {
        const [existing] = await db
            .select({ id: audienceContacts.id, status: audienceContacts.status })
            .from(audienceContacts)
            .where(and(eq(audienceContacts.organisationId, orgId), eq(audienceContacts.email, email)))
            .limit(1);

        // ⚠️ TERMINAL STATES. A hard bounce or a spam complaint is not reversible by a form
        // submission — anyone can type anyone's address into a form, and "they signed up again" is
        // exactly what a resubscribe attack looks like. Answer with the normal success body so the
        // page behaves identically and reveals nothing, and write nothing.
        if (existing && (existing.status === 'bounced' || existing.status === 'complained' || existing.status === 'suppressed')) {
            return json(200, successBody, origin);
        }

        // An UNSUBSCRIBED address may come back — but only through the confirmation email, which
        // only the person holding the inbox can act on. The contact row is left untouched here;
        // the POST /confirm handler is the only thing that flips it, and it records 'resubscribed'.
        const returning = !!existing && existing.status === 'unsubscribed';
        if (returning && !form.doubleOptIn) {
            // Without double opt-in there is nothing that proves the person asked, so an opt-out
            // stands. Same silent success.
            return json(200, successBody, origin);
        }

        let contactId: number;
        if (returning) {
            contactId = existing!.id;
        } else {
            const res = await upsertContact(db, {
                organisationId: orgId,
                email,
                firstName: cleanName(answers.contact.first_name),
                lastName: cleanName(answers.contact.last_name),
                company: cleanName(answers.contact.company),
                phone: cleanName(answers.contact.phone),
                customFields: answers.custom,
                status: form.doubleOptIn ? 'pending' : 'subscribed',
                source: 'web_form',
                consentBasis: form.doubleOptIn ? 'double_opt_in' : 'single_opt_in',
                confirmedAt: form.doubleOptIn ? null : new Date(),
                sourceDetail: { formId: form.id, page: sourceUrl },
                // ⚠️ The subscriber's own zone, as their BROWSER reports it — validated here, not
                // trusted: anyone can post anything to this endpoint, and an unknown zone reaching
                // Intl inside the send worker would throw and fail a whole batch over one row.
                // Absent or unrecognised simply means we do not know, which is a first-class answer
                // (they are sent at the sender's time). It is never inferred from the IP: a guess
                // presented as a fact is worse here than an honest gap, because being wrong means
                // arriving at three in the morning.
                timezone: isValidTimezone(body.timezone) ? body.timezone : null,
            });
            contactId = res.id;
        }

        // The evidence, written before anything is sent. A subscription we cannot account for is
        // one we should not have taken.
        await recordConsentEvent(db, {
            organisationId: orgId,
            contactId,
            email,
            event: 'subscribe_requested',
            channel: 'web_form',
            sourceUrl,
            ipHash,
            userAgent,
            formId: form.id,
            evidence: returning ? 'Signed up again after previously unsubscribing.' : null,
        });

        // What this form asked and what they answered — the consent evidence a form builder makes
        // necessary (the form can change tomorrow; this records the one they saw), and the tags
        // their confirmation will apply. Best effort: a missing table must not stop a sign-up.
        let submissionTags: string[] = answers.tags;
        try {
            await db.insert(audienceFormSubmissions).values({
                organisationId: orgId,
                formId: form.id,
                contactId,
                definitionHash: definitionHash(def),
                consentText: def.consent.text,
                answers: answers.stored,
                tags: answers.tags,
                pageUrl: sourceUrl,
                surface,
            });
        } catch (err) {
            console.error('[audience-public] submission record failed — has db/form-builder.sql been applied?', { formId: form.id }, err);
        }

        // Which advert, post or email brought this person here — if any.
        //
        // Placed here, above the double opt-in branch, so BOTH paths bind: attribution is a fact
        // about where somebody came from, and a pending contact who never confirms still came from
        // somewhere. Deferring it to confirmation would lose the signal entirely, because the
        // confirmation arrives from an email client with no page URL and no cookie.
        //
        // Never throws, and its result is deliberately ignored: a person who filled in this form
        // must end up subscribed whether or not we can work out which campaign sent them. It sits
        // after recordConsentEvent for the same reason — consent is the load-bearing write.
        //
        // ⚠️ Awaited, not fire-and-forget. An un-awaited promise here would be killed the moment
        // the handler returns its response, so the binding would land only when the function
        // happened to stay warm — which is the worst kind of bug, because it works locally and
        // attributes a random subset in production. It returns before touching the database when
        // there is no click ref and no cookie, which is most sign-ups.
        await bindConversion(db, {
            organisationId: orgId,
            subjectType: 'audience_contact',
            subjectId: contactId,
            pageUrl,
            cookieHeader: event.headers?.cookie || null,
        });

        if (!form.doubleOptIn) {
            // Single opt-in: no email to wait for, so the segment is applied now.
            if (form.segmentId) {
                try { await addToSegment(db, contactId, form.segmentId, null); }
                catch (err) { console.error('[audience-public] subscribed but segment assignment failed', { formId: form.id }, err); }
            }
            if (submissionTags.length) {
                try {
                    await applyTagsByName(db, orgId, contactId, submissionTags);
                    await db.update(audienceFormSubmissions).set({ tagsAppliedAt: new Date() })
                        .where(and(eq(audienceFormSubmissions.contactId, contactId), eq(audienceFormSubmissions.formId, form.id), isNull(audienceFormSubmissions.tagsAppliedAt)));
                } catch (err) { console.error('[audience-public] subscribed but tagging failed', { formId: form.id }, err); }
            }
            // ⚠️ Single opt-in subscribes NOW, so this is the moment of maximum interest too. Before the
            // form builder only the confirmation click enrolled anybody, and a single opt-in form's
            // subscribers silently never received the welcome sequence at all.
            await enrolAfterSignup(db, {
                organisationId: orgId, contactId, email,
                formSequenceId: form.sequenceId ?? null,
                skipWelcome: def.campaign.skipWelcome,
            });
            return json(200, successBody, origin);
        }

        // ── Double opt-in: mint, store the HASH, send ───────────────────────
        // The NEWEST outstanding confirmation for this contact. Newest, not oldest: it carries the
        // live throttle state, and it is the row a resend has to replace.
        const [pending] = await db
            .select({
                id: audienceConfirmations.id,
                sentCount: audienceConfirmations.sentCount,
                lastSentAt: audienceConfirmations.lastSentAt,
                confirmedAt: audienceConfirmations.confirmedAt,
            })
            .from(audienceConfirmations)
            .where(eq(audienceConfirmations.contactId, contactId))
            .orderBy(desc(audienceConfirmations.id))
            .limit(1);

        if (pending && !pending.confirmedAt) {
            // Throttle. An unthrottled "send it again" keyed on an arbitrary address is an
            // email-bombing tool aimed at strangers, from our own sending domain. Answered with the
            // ordinary success body: the person who genuinely signed up twice should see the same
            // thing either way, and be looking in their inbox for the mail we already sent.
            const tooSoon = Date.now() - (pending.lastSentAt?.getTime() ?? 0) < CONFIRM_RESEND_COOLDOWN_MS;
            const tooMany = (pending.sentCount ?? 0) >= MAX_CONFIRM_SENDS;
            if (tooSoon || tooMany) return json(200, successBody, origin);
        }

        const baseUrl = resolveBaseUrl((event.headers || {}) as Record<string, string | undefined>);
        if (!baseUrl) {
            console.error('[audience-public] no base URL — cannot build a confirmation link', { orgId });
            return json(500, { error: 'We could not send the confirmation email. Please try again shortly.' }, origin);
        }

        const token = mintConfirmToken();
        const expires = new Date(Date.now() + CONFIRM_TTL_DAYS * 24 * 60 * 60 * 1000);

        // One live link per contact. A resend REPLACES the outstanding row rather than adding a
        // second: two valid tokens for one subscription is a credential we did not need to mint,
        // and it makes the throttle count meaningless.
        if (pending && !pending.confirmedAt) {
            await db.update(audienceConfirmations).set({
                tokenHash: hashConfirmToken(token),
                formId: form.id,
                expiresAt: expires,
                sentCount: (pending.sentCount ?? 0) + 1,
                lastSentAt: new Date(),
            }).where(eq(audienceConfirmations.id, pending.id));
        } else {
            await db.insert(audienceConfirmations).values({
                organisationId: orgId,
                contactId,
                formId: form.id,
                tokenHash: hashConfirmToken(token),
                expiresAt: expires,
            });
        }

        try {
            await sendConfirmationEmail({
                to: email,
                firstName: cleanName(answers.contact.first_name),
                senderName: form.senderName || 'the sender',
                sourceUrl,
                baseUrl,
                token,
            });
        } catch (err) {
            // The contact stays 'pending', which is unmailable — safe, but the visitor thinks they
            // subscribed and never hears anything. Tell them it failed so they can try again.
            console.error('[audience-public] confirmation email failed to send', { orgId, formId: form.id }, err);
            return json(502, { error: 'We could not send the confirmation email. Please try again shortly.' }, origin);
        }

        return json(200, successBody, origin);
    } catch (err) {
        console.error('[audience-public] sign-up failed', { orgId, formId: form.id }, err);
        return json(500, { error: 'We could not complete your sign-up. Please try again shortly.' }, origin);
    }
});
