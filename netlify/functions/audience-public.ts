// netlify/functions/audience-public.ts
// The PUBLIC front door of the audience layer — the only place an anonymous browser on someone
// else's website can write into a tenant's data. Behind a netlify.toml rewrite:
//   /api/audience/*  →  /.netlify/functions/audience-public
//
//   GET  /s/:key                   → the HOSTED sign-up page, for tenants with no website
//   GET  /api/audience/form/:key   → the form's public config (what subscribe.js renders)
//   POST /api/audience/subscribe   → a sign-up  { key, email, firstName?, lastName?, company?, hp, ms, url }
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
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    audienceConfirmations, audienceContacts, audienceForms, organisations,
} from '../../db/schema';
import { looksLikeEmail, normaliseEmail, cleanName } from '../../src/utils/audience-contacts';
import { addToSegment, recordConsentEvent, setContactStatus, upsertContact } from '../../src/utils/audience-store';
import { enrolInWelcomeSequence } from '../../src/utils/newsletter-sequence';
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

export interface HostedPageContent {
    orgName: string;
    headline: string;
    intro: string;
    fields: string[];
    consentText: string;
    doubleOptIn: boolean;
}

/**
 * The hosted sign-up page.
 *
 * ⚠️ NOINDEX, deliberately. The value here is a link somebody puts in a bio, on a poster or behind a
 * QR code — being found by search adds nothing a form page could realistically rank for, while an
 * abandoned or half-configured page indexed under our domain, carrying a tenant's name, is a real
 * cost. The link works exactly as well either way.
 *
 * ⚠️ It carries the SAME anti-bot pair as the embeddable widget: a honeypot field and a minimum
 * fill time. A public url on our own domain is a more attractive target than a form on one small
 * business's website, not a less attractive one — so the protections cannot be the ones the embed
 * happens to have and this page happens to skip.
 */
export function hostedPage(key: string, c: HostedPageContent) {
    const field = (name: string, label: string, type = 'text') => `
      <label>${esc(label)}
        <input type="${type}" name="${esc(name)}" ${name === 'email' ? 'required autocomplete="email"' : ''}>
      </label>`;

    const inputs = [
        field('email', 'Email address', 'email'),
        c.fields.includes('first_name') ? field('first_name', 'First name') : '',
        c.fields.includes('last_name') ? field('last_name', 'Last name') : '',
        c.fields.includes('company') ? field('company', 'Company') : '',
    ].filter(Boolean).join('');

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex',
            // The page posts to our own origin only, loads no third-party anything, and embeds no
            // remote script — so the policy can say exactly that.
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
            'Referrer-Policy': 'no-referrer',
        },
        body: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(c.headline)} — ${esc(c.orgName)}</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;color:#111827;margin:0;
  display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1.5rem;line-height:1.5}
.card{background:#fff;border-radius:1rem;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:2rem;max-width:26rem;width:100%}
h1{font-size:1.35rem;margin:0 0 .35rem}
.who{color:#6b7280;font-size:.85rem;margin:0 0 1rem}
.intro{color:#374151;font-size:.95rem;margin:0 0 1.25rem;white-space:pre-line}
label{display:block;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:#6b7280;margin-bottom:.75rem}
input{display:block;width:100%;margin-top:.3rem;padding:.7rem .75rem;font-size:1rem;border:1px solid #d1d5db;border-radius:.6rem;
  font-family:inherit;color:#111827;background:#fff}
input:focus{outline:2px solid #059669;outline-offset:1px;border-color:#059669}
button{width:100%;margin-top:.5rem;padding:.8rem 1rem;font-size:1rem;font-weight:700;color:#fff;background:#059669;border:none;
  border-radius:.6rem;cursor:pointer;font-family:inherit}
button:hover{background:#047857}button[disabled]{opacity:.6;cursor:default}
.consent{color:#6b7280;font-size:.78rem;margin:1rem 0 0}
.msg{margin-top:1rem;padding:.75rem .85rem;border-radius:.6rem;font-size:.9rem;display:none}
.ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46}
.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.foot{text-align:center;color:#9ca3af;font-size:.72rem;margin-top:1.25rem}
</style>
</head>
<body>
<div class="card">
  <h1>${esc(c.headline)}</h1>
  <p class="who">from ${esc(c.orgName)}</p>
  ${c.intro ? `<p class="intro">${esc(c.intro)}</p>` : ''}
  <form id="f" novalidate>
    ${inputs}
    <div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="hp" tabindex="-1" autocomplete="off"></label></div>
    <button type="submit" id="b">Subscribe</button>
  </form>
  <p class="consent">${esc(c.consentText)}</p>
  <div class="msg ok" id="ok"></div>
  <div class="msg err" id="err"></div>
  <noscript><p class="msg err" style="display:block">This form needs JavaScript. Please email ${esc(c.orgName)} directly to subscribe.</p></noscript>
  <p class="foot">Powered by Be More Swan</p>
</div>
<script>
(function () {
  var started = Date.now();
  var f = document.getElementById('f'), b = document.getElementById('b');
  var ok = document.getElementById('ok'), err = document.getElementById('err');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    err.style.display = 'none';
    var data = new FormData(f), payload = { key: ${JSON.stringify(key)}, ms: Date.now() - started, url: location.href };
    data.forEach(function (v, k) { payload[k] = v; });
    // Sent as the API's own field names, so this page and the embeddable widget are two callers of
    // one endpoint rather than two contracts.
    payload.firstName = payload.first_name || '';
    payload.lastName = payload.last_name || '';
    b.disabled = true;
    fetch('/api/audience/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }).then(function (r) { return r.json().then(function (d) { return { r: r, d: d }; }); })
      .then(function (res) {
        if (!res.r.ok) throw new Error(res.d && res.d.error ? res.d.error : 'Something went wrong. Please try again.');
        if (res.d.redirectUrl) { location.href = res.d.redirectUrl; return; }
        f.style.display = 'none';
        ok.textContent = res.d.message || 'Thanks — check your email.';
        ok.style.display = 'block';
      })
      .catch(function (e2) { b.disabled = false; err.textContent = e2.message; err.style.display = 'block'; });
  });
})();
</script>
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

        const [form] = await db
            .select({
                name: audienceForms.name,
                fields: audienceForms.fields,
                theme: audienceForms.theme,
                consentText: audienceForms.consentText,
                successMessage: audienceForms.successMessage,
                doubleOptIn: audienceForms.doubleOptIn,
                redirectUrl: audienceForms.redirectUrl,
                status: audienceForms.status,
                allowedOrigins: audienceForms.allowedOrigins,
                orgName: organisations.name,
            })
            .from(audienceForms)
            .leftJoin(organisations, eq(organisations.id, audienceForms.organisationId))
            .where(eq(audienceForms.publicKey, key))
            .limit(1);

        if (!form || form.status !== 'active') return json(404, { error: 'Form not found.' }, origin);

        return json(200, {
            name: form.name,
            fields: form.fields,
            theme: form.theme,
            consentText: form.consentText || DEFAULT_CONSENT_TEXT,
            successMessage: form.successMessage
                || (form.doubleOptIn ? DEFAULT_SUCCESS_MESSAGE : SINGLE_OPT_IN_SUCCESS_MESSAGE),
            doubleOptIn: form.doubleOptIn,
            redirectUrl: form.redirectUrl,
            senderName: form.orgName || '',
        }, origin);
    }

    // ── The hosted sign-up page ─────────────────────────────────────────────
    // For the customers who have no website to embed a form in. Same form, same consent text, same
    // double opt-in setting — a second description of what somebody agreed to is the one that
    // drifts from the one they were actually shown.
    const hostedMatch = path.match(/^\/s\/([^/?#]+)/);
    if (hostedMatch && method === 'GET') {
        const key = hostedMatch[1];
        if (!FORM_KEY_RE.test(key)) return hostedMissing();

        const [form] = await db
            .select({
                name: audienceForms.name,
                fields: audienceForms.fields,
                consentText: audienceForms.consentText,
                doubleOptIn: audienceForms.doubleOptIn,
                status: audienceForms.status,
                hostedEnabled: audienceForms.hostedEnabled,
                hostedHeadline: audienceForms.hostedHeadline,
                hostedIntro: audienceForms.hostedIntro,
                orgName: organisations.name,
            })
            .from(audienceForms)
            .leftJoin(organisations, eq(organisations.id, audienceForms.organisationId))
            .where(eq(audienceForms.publicKey, key))
            .limit(1);

        // A page that is switched off answers exactly like a key that never existed. Whether a
        // given tenant has a sign-up page is not something a stranger with a url should learn.
        if (!form || form.status !== 'active' || !form.hostedEnabled) return hostedMissing();

        return hostedPage(key, {
            orgName: form.orgName || 'this business',
            headline: form.hostedHeadline || form.name || 'Subscribe',
            intro: form.hostedIntro || '',
            fields: Array.isArray(form.fields) ? (form.fields as string[]) : ['email'],
            consentText: form.consentText || DEFAULT_CONSENT_TEXT,
            doubleOptIn: form.doubleOptIn,
        });
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
            }

            // The moment of maximum interest. Best-effort by design: enrolInWelcomeSequence never
            // throws, because a confirmation that 500s over a welcome email would leave somebody
            // who just clicked "confirm" believing they had failed to subscribe.
            if (row.contactId) {
                await enrolInWelcomeSequence(db, {
                    organisationId: row.organisationId,
                    contactId: row.contactId,
                    email: row.email,
                });
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

    const key = String(body.key || '');
    if (!FORM_KEY_RE.test(key)) return json(404, { error: 'Form not found.' }, origin);

    const [form] = await db
        .select({
            id: audienceForms.id,
            organisationId: audienceForms.organisationId,
            allowedOrigins: audienceForms.allowedOrigins,
            segmentId: audienceForms.segmentId,
            doubleOptIn: audienceForms.doubleOptIn,
            successMessage: audienceForms.successMessage,
            redirectUrl: audienceForms.redirectUrl,
            status: audienceForms.status,
            hostedEnabled: audienceForms.hostedEnabled,
            senderName: organisations.name,
        })
        .from(audienceForms)
        .leftJoin(organisations, eq(organisations.id, audienceForms.organisationId))
        .where(eq(audienceForms.publicKey, key))
        .limit(1);

    if (!form || form.status !== 'active') return json(404, { error: 'Form not found.' }, origin);

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
        const perKey = await checkRateLimit(db, 'audience_subscribe_key', key, KEY_LIMIT);
        if (!perKey.allowed) {
            return json(429, { error: 'This form is temporarily busy. Please try again shortly.' }, origin,
                { 'Retry-After': String(perKey.retryAfterSecs) });
        }
    } catch (err) {
        // The limiter is not the feature. A limiter outage must not take a customer's sign-up form
        // down with it — the other controls (origin, honeypot, timing, double opt-in) still stand.
        console.error('[audience-public] rate limiter unavailable — allowing the request', err);
    }

    const email = normaliseEmail(body.email);
    if (!looksLikeEmail(email)) return json(400, { error: 'Enter a valid email address.' }, origin);

    const orgId = form.organisationId;
    const ipHash = pseudonymiseIp(ip);
    const userAgent = event.headers?.['user-agent'] || null;
    const sourceUrl = String(body.url || '').slice(0, 500) || null;

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
                firstName: cleanName(body.firstName),
                lastName: cleanName(body.lastName),
                company: cleanName(body.company),
                status: form.doubleOptIn ? 'pending' : 'subscribed',
                source: 'web_form',
                consentBasis: form.doubleOptIn ? 'double_opt_in' : 'single_opt_in',
                confirmedAt: form.doubleOptIn ? null : new Date(),
                sourceDetail: { formId: form.id, page: sourceUrl },
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

        if (!form.doubleOptIn) {
            // Single opt-in: no email to wait for, so the segment is applied now.
            if (form.segmentId) {
                try { await addToSegment(db, contactId, form.segmentId, null); }
                catch (err) { console.error('[audience-public] subscribed but segment assignment failed', { formId: form.id }, err); }
            }
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
                firstName: cleanName(body.firstName),
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
