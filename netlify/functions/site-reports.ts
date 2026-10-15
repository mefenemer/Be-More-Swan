// netlify/functions/site-reports.ts
// "Report this site" — the link in the footer of every hosted Website Assistant site leads to
// /report-site.html?site=<slug>, which posts here. PUBLIC (no sign-in): anyone who lands on a site we
// host must be able to tell us about it. docs/website-assistant-plan.md §7 (abuse controls).
//
// POST { site, reason, details?, email?, website? (honeypot), startedAt }
//   → 200 { ok: true }   — also returned to a bot that trips the honeypot or fill-time check, so
//                          it learns nothing.
//
// Stored in site_reports and emailed to NOTIFY_EMAIL; reviewed on Admin ▸ Trust ▸ Hosted Sites
// (admin-sites.ts), where a site can be taken offline. Rate-limited per IP.

import { eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { siteReports, sites } from '../../db/schema';
import { checkRateLimit, getClientIp } from '../../src/utils/rate-limit';
import { sendEmail } from '../../src/utils/email';
import { esc } from '../../src/utils/site-render';
import { cleanSiteSlugInput, isReportReason, REPORT_REASONS, siteOrigin } from '../../src/utils/site-hosting';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const LIMIT = { maxAttempts: 5, windowSecs: 3600 };
/** A person takes longer than this to read the form and pick a reason. */
const MIN_FILL_MS = 2500;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || process.env.FROM_EMAIL || 'hello@bemoreswan.com';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }

    // A bot: the hidden field filled in, or the form sent faster than anyone could read it.
    const startedAt = Number(body.startedAt);
    if (String(body.website || '').trim() || !Number.isFinite(startedAt) || Date.now() - startedAt < MIN_FILL_MS) return json(200, { ok: true });

    const slug = cleanSiteSlugInput(body.site);
    if (!isReportReason(body.reason)) return json(400, { error: 'Choose what is wrong with the site.' });
    const details = typeof body.details === 'string' ? body.details.trim().slice(0, 2000) : '';
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 200) : '';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'That email address doesn\'t look right — or leave it empty.' });

    const db = getDb();
    const ip = getClientIp(event.headers as Record<string, string | undefined>);
    const limited = await checkRateLimit(db, 'site_report_ip', ip, LIMIT);
    if (!limited.allowed) return json(429, { error: 'Thank you — we have your reports. Please try again later if there is more.' });

    const [site] = slug ? await db.select({ id: sites.id, slug: sites.slug }).from(sites).where(eq(sites.slug, slug)).limit(1) : [];
    if (!site) return json(404, { error: 'We couldn\'t find that site. Check the address in the link you followed.' });

    const [row] = await db.insert(siteReports).values({ siteId: site.id, reason: body.reason, details: details || null, reporterEmail: email || null }).returning({ id: siteReports.id });

    const url = siteOrigin(slug);
    await sendEmail({
        to: NOTIFY_EMAIL,
        subject: `Site reported: ${slug} — ${REPORT_REASONS[body.reason]}`,
        html: `<p>A hosted site was reported (report #${row.id}).</p>
<p><strong>Site:</strong> <a href="${esc(url)}">${esc(url)}</a><br><strong>Reason:</strong> ${esc(REPORT_REASONS[body.reason])}<br><strong>Reporter:</strong> ${email ? esc(email) : 'not given'}</p>
${details ? `<p><strong>Details:</strong><br>${esc(details).replace(/\n/g, '<br>')}</p>` : ''}
<p>Review it on Admin ▸ Trust ▸ Hosted Sites, where the site can be taken offline.</p>`,
        ...(email ? { replyTo: email } : {}),
    }).catch((err: unknown) => console.error('[site-reports] email failed', err instanceof Error ? err.message : err));

    return json(200, { ok: true });
});
