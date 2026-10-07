// netlify/functions/request-meta-tester.ts
// A customer asks to be added as a Meta App Tester so they can connect Facebook/Instagram while
// Meta's business verification is still pending.
//
// ── Why ─────────────────────────────────────────────────────────────────────────────────────────
// Business verification was rejected 2026-09-02 (D-U-N-S since obtained, resubmission pending), so
// every one of our 8 Meta permissions sits at Standard access: only people holding a role on the
// app can connect. Everyone else is sent to Meta and dead-ends on Meta's own error page. Until
// verification clears, the only way a customer can connect is for us to add them as a Tester by
// hand, so the connect modal (integrations.js `_intOpenPreConnect`) collects what we need for that.
//
// ── What it records ─────────────────────────────────────────────────────────────────────────────
// A support_tickets row (category 'Technical', so it shows in the admin helpdesk's existing filter)
// AND a founder email. The ticket is the durable record; the email is the nudge. A failed email
// does not fail the request, because the ticket already holds it.
//
// ⚠️ The identifier MUST be the account the person LOGS IN with: facebook.com/me while signed in.
// A share link (facebook.com/share/…) resolves to their PAGE, which cannot hold an app role, so the
// invite sits Pending forever with nothing to accept on their side (cost a long hunt 2026-09-06).
// Share links are refused here with that explanation rather than accepted and silently useless.
//
// POST { platform: 'facebook'|'instagram', profileUrl } → 200 { ok } | 400 { error }

import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, supportTickets, userOrganisations, organisations } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { withLambda } from '@netlify/aws-lambda-compat';

const FOUNDER_EMAIL = process.env.FOUNDER_ALERT_EMAIL || 'hello@bemoreswan.com';
const META_APP_ID = '27729961169942617';

export type ProfileCheck = { ok: true; value: string } | { ok: false; error: string };

/** Pure: is this something we can invite as a Tester? Accepts a facebook.com profile URL or a bare numeric id. */
export function checkFacebookProfile(input: unknown): ProfileCheck {
    const raw = String(input ?? '').trim();
    if (!raw) return { ok: false, error: 'Paste the link from facebook.com/me.' };
    if (raw.length > 300) return { ok: false, error: 'That link is too long — paste just the address from facebook.com/me.' };
    if (/^\d{5,20}$/.test(raw)) return { ok: true, value: raw };

    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
    catch { return { ok: false, error: 'That does not look like a Facebook link. Open facebook.com/me and copy the address bar.' }; }

    const host = url.hostname.toLowerCase().replace(/^(www|m|web)\./, '');
    if (host !== 'facebook.com' && host !== 'fb.com') {
        return { ok: false, error: 'That is not a facebook.com link. Open facebook.com/me while signed in and copy the address bar.' };
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (/^\/share(\/|$)/i.test(path)) {
        return { ok: false, error: 'Share links point at your Page, not your login. Open facebook.com/me while signed in and copy the address bar instead.' };
    }
    if (!path || path === '/me') {
        return { ok: false, error: 'Open facebook.com/me while signed in. Facebook will jump to your own profile; copy THAT address.' };
    }
    if (/^\/profile\.php$/i.test(path) && !/^\d+$/.test(url.searchParams.get('id') || '')) {
        return { ok: false, error: 'That profile link is missing its id. Copy the full address from facebook.com/me.' };
    }
    return { ok: true, value: `https://www.facebook.com${path}${url.search}` };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const sessionToken = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    let userId: number;
    try { userId = (jwt.verify(sessionToken, jwtSecret) as { userId: number }).userId; }
    catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) }; }

    let body: { platform?: string; profileUrl?: string };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request.' }) }; }
    const platform = body.platform === 'instagram' ? 'Instagram' : 'Facebook';
    const profile = checkFacebookProfile(body.profileUrl);
    if (!profile.ok) return { statusCode: 400, body: JSON.stringify({ error: profile.error }) };

    try {
        const db = getDb();
        const [user] = await db.select({
            id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName,
            organisationId: userOrganisations.organisationId, organisationName: organisations.name,
        }).from(users)
            .leftJoin(userOrganisations, eq(users.id, userOrganisations.userId))
            .leftJoin(organisations, eq(organisations.id, userOrganisations.organisationId))
            .where(eq(users.id, userId));
        if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

        const who = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
        const steps = [
            `1. Meta App Dashboard → app ${META_APP_ID} → App roles → Roles → Add people → Testers.`,
            `2. Paste: ${profile.value}`,
            `3. Watch the Testers "N of 50" counter go up once they accept: that is the only reliable sign.`,
            `4. Reply to ${user.email}: accept the invite from your Facebook notifications (or Business Suite → Settings → Requests → Received), then press Connect ${platform} again.`,
        ];
        const description = `${who} (${user.email}) wants to connect ${platform} while Meta verification is pending.\n\n`
            + `Login profile: ${profile.value}\nOrganisation: ${user.organisationName ?? '—'} (#${user.organisationId ?? '—'})\n\n${steps.join('\n')}`;

        await db.insert(supportTickets).values({
            userId: user.id,
            organisationId: user.organisationId ?? null,
            subject: `Meta tester access: ${who} (${platform})`,
            category: 'Technical',
            description,
            status: 'open',
            priority: 'high',
        });

        const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        try {
            await sendEmail({
                to: FOUNDER_EMAIL,
                replyTo: user.email,
                subject: `[Be More Swan] Add a Meta tester: ${who} (${platform})`,
                html: `<p>${esc(description).replace(/\n/g, '<br>')}</p>`,
                text: description,
            });
        } catch (err) {
            // The ticket already holds the request; a missed email just means it is found in the helpdesk.
            console.error('[request-meta-tester] founder email failed — request is in support_tickets', err);
        }
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    } catch (err) {
        console.error('[request-meta-tester] failed', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not send your request. Please try again.' }) };
    }
});
