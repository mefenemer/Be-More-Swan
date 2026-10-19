// netlify/functions/partner-apply.ts
// The public partner application (partners.html) — docs/affiliate-partner-programme-plan.md §4.6.
//
//   POST { name, email, channels[], audience, links, message, consent: true, hp, ms }
//   → 200 { ok: true }   — the same reply for a new application and a repeat, so the form never
//                          reveals whether an address is already a partner
//
// Creates NO account (owner decision 2026-10-18): sign-ups may be locked, and a rejected applicant
// should never hold one. Approval emails a private account link (src/utils/partner-applications.ts).
// A signed-in customer applying here is linked to their account straight away.
//
// Abuse: a honeypot field and a minimum fill time (a bot gets the success reply and nothing is
// stored), then per-IP and per-email limits — the same shape as site-audit-public.ts.

import jwt from 'jsonwebtoken';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { checkRateLimit, getClientIp } from '../../src/utils/rate-limit';
import { APPLY_LIMITS, recordApplication, sendApplicationEmails, validateApplication } from '../../src/utils/partner-applications';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** The signed-in user, if any. Impersonation sessions never apply on someone's behalf. */
function signedInUserId(cookieHeader: string | undefined): number | null {
    const secret = process.env.JWT_SECRET;
    const m = (cookieHeader || '').match(/aura_session=([^;]+)/);
    if (!secret || !m) return null;
    try {
        const tok = jwt.verify(m[1], secret) as { userId: number; scope?: string };
        return tok.scope === 'impersonate' ? null : tok.userId;
    } catch { return null; }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }

    // A person, not a script: same reply as success, nothing stored.
    const ms = Number(body.ms);
    if ((typeof body.hp === 'string' && body.hp.trim()) || !Number.isFinite(ms) || ms < APPLY_LIMITS.minFillMs) {
        return json(200, { ok: true });
    }

    const checked = validateApplication(body);
    if (!checked.ok) return json(400, { error: checked.error });
    const v = checked.value;

    const db = getDb();
    const ip = getClientIp(event.headers as Record<string, string | undefined>);
    const [byIp, byEmail] = await Promise.all([
        checkRateLimit(db, 'partner_apply_ip', ip, APPLY_LIMITS.perIp),
        checkRateLimit(db, 'partner_apply_email', v.email, APPLY_LIMITS.perEmail),
    ]);
    if (!byIp.allowed || !byEmail.allowed) {
        return json(429, { error: 'We’ve had a few applications from you already — we’ll be in touch. If something went wrong, email hello@bemoreswan.com.' });
    }

    const { outcome, partnerId } = await recordApplication(db, v, signedInUserId(event.headers.cookie));
    if (outcome === 'created' && partnerId) await sendApplicationEmails(v, partnerId);
    return json(200, { ok: true });
});
