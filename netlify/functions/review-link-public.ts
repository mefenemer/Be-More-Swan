// netlify/functions/review-link-public.ts
// The guest's side of a review link (src/utils/review-links.ts). No login. POST only.
//
// { action:'view', token }                         → what the page draws. Records nothing.
// { action:'opened', token }                       → a person touched the page. Counts a view.
// { action:'respond', token, name, decision, body?, hp, ms } → records their sign-off. Nothing else.
// { action:'trial_click', token }                  → they took the trial offer.
//
// ⚠️ Email scanners open links AND run page script, so 'view' must stay read-only. The page sends
// 'opened' only after a real pointer, key or scroll event.
//
// The organisation and item come only from the link row. Every dead link gets the same reply, so a
// guest can't tell whether it expired, was revoked, or its workspace lapsed. A caught bot gets the
// same reply as a person.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { isRegistrationLocked } from '../../src/utils/platform-config';
import { checkRateLimit, getClientIp } from '../../src/utils/rate-limit';
import {
    guestView, recordOpened, recordResponse, recordTrialClick, resolveReviewLink, validateResponse,
} from '../../src/utils/review-links';

/** Faster than this and a person can't have read the post. */
const MIN_RESPOND_MS = 1500;
const IP_LIMIT = { maxAttempts: 60, windowSecs: 60 };
const RESPOND_LIMIT = { maxAttempts: 10, windowSecs: 600 };

// Netlify's [[headers]] skip function responses, so this function sets its own.
const HEADERS: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
};
const json = (statusCode: number, body: unknown) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });
const DEAD = () => json(404, { error: 'This link is no longer active. Ask the person who sent it for a new one.' });

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: 'Method Not Allowed' };

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }
    if (!body || typeof body !== 'object') return json(400, { error: 'Invalid request.' });

    const db = getDb();
    const ip = getClientIp(event.headers);
    const perIp = await checkRateLimit(db, 'review_link_public', ip, IP_LIMIT);
    if (!perIp.allowed) return json(429, { error: 'Please wait a moment and try again.' });

    const resolved = await resolveReviewLink(db, body.token);
    if (!resolved) return DEAD();
    const linkId = resolved.link.id;

    switch (body.action) {
        case 'view': {
            const locked = await isRegistrationLocked().catch(() => true);
            return json(200, { ...(await guestView(db, resolved)), trialOffer: !locked });
        }
        case 'opened':
            await recordOpened(db, linkId);
            return json(200, { ok: true });
        case 'trial_click':
            await recordTrialClick(db, linkId);
            return json(200, { ok: true });
        case 'respond': {
            const elapsed = Number(body.ms);
            const looksLikeBot = !!body.hp || (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_RESPOND_MS);
            const checked = validateResponse({ name: body.name, decision: body.decision, body: body.body });
            if (!checked.ok) return json(400, { error: checked.error });
            if (looksLikeBot) return json(200, { ok: true });
            const perLink = await checkRateLimit(db, 'review_link_respond', `${linkId}:${ip}`, RESPOND_LIMIT);
            if (!perLink.allowed) return json(429, { error: 'Please wait a moment and try again.' });
            const saved = await recordResponse(db, resolved, { name: checked.name, decision: checked.decision, body: checked.body });
            return saved.ok ? json(200, { ok: true }) : json(409, { error: saved.error });
        }
        default:
            return json(400, { error: 'Invalid request.' });
    }
});
