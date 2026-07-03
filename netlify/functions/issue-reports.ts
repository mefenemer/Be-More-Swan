// netlify/functions/issue-reports.ts
// Testing-phase "Report an Issue" — user-facing API.
//
// GET   /issue-reports                          → the caller's own reported issues (+ message threads)
// POST  /issue-reports  { description, sourceLocation, sourceUrl, image? }
//                                               → file a new issue; emails the admin owner(s)
// POST  /issue-reports  { issueId, message }    → add a reply (e.g. answer "More info required")
// POST  /issue-reports  { issueId, action:'confirm-fixed' }
//                                               → user confirms the fix worked → status 'closed'
//
// Issues are stored against the user so they can track progress. The location the user was on
// when they pressed the button is captured (sourceLocation/sourceUrl) so the developer knows
// WHERE the issue occurred. An optional screenshot is stored inline (base64 data URL).

import { Handler } from '@netlify/functions';
import { and, eq, desc, asc, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { issueReports, issueReportMessages, users } from '../../db/schema';
import { requireSession } from '../../src/utils/session';
import { resolveActiveOrg } from '../../src/utils/tenant';
import { sendEmail } from '../../src/utils/email';
import { resolveBaseUrl } from '../../src/utils/base-url';
import {
    ISSUE_STATUS_LABEL,
    validateImageDataUrl,
    getAdminRecipients,
} from '../../src/utils/issue-reports';

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
    const db = getDb();

    const session = requireSession(event);
    if ('error' in session) return session.error;
    const userId = session.userId;

    // Org is optional metadata — issue reporting must work even before a user joins an org.
    const org = await resolveActiveOrg(db, userId, session.activeOrganisationId);
    const organisationId = org?.organisationId ?? null;

    // ── GET ?image=<id>: the caller's own screenshot (kept out of the list payload) ──
    if (event.httpMethod === 'GET' && event.queryStringParameters?.image) {
        const imageId = Number(event.queryStringParameters.image);
        const [row] = await db
            .select({ imageData: issueReports.imageData })
            .from(issueReports)
            .where(and(eq(issueReports.id, imageId), eq(issueReports.userId, userId)))
            .limit(1);
        if (!row?.imageData) return json(404, { error: 'No image.' });
        return json(200, { image: row.imageData });
    }

    // ── GET: the caller's own issues + their message threads ─────────────────────
    if (event.httpMethod === 'GET') {
        const issues = await db
            .select({
                id: issueReports.id,
                description: issueReports.description,
                sourceLocation: issueReports.sourceLocation,
                status: issueReports.status,
                hasImage: issueReports.imageMime,
                createdAt: issueReports.createdAt,
                updatedAt: issueReports.updatedAt,
            })
            .from(issueReports)
            .where(eq(issueReports.userId, userId))
            .orderBy(desc(issueReports.createdAt))
            .limit(100);

        const ids = issues.map((i) => i.id);
        const messages = ids.length
            ? await db
                .select()
                .from(issueReportMessages)
                .where(inArray(issueReportMessages.issueId, ids))
                .orderBy(asc(issueReportMessages.createdAt))
            : [];

        const byIssue: Record<number, typeof messages> = {};
        for (const m of messages) (byIssue[m.issueId] ??= [] as any).push(m);

        return json(200, {
            issues: issues.map((i) => ({
                id: i.id,
                description: i.description,
                sourceLocation: i.sourceLocation,
                status: i.status,
                statusLabel: ISSUE_STATUS_LABEL[i.status as keyof typeof ISSUE_STATUS_LABEL] || i.status,
                hasImage: !!i.hasImage,
                createdAt: i.createdAt,
                updatedAt: i.updatedAt,
                messages: (byIssue[i.id] || []).map((m) => ({
                    authorType: m.authorType,
                    body: m.body,
                    status: m.status,
                    createdAt: m.createdAt,
                })),
            })),
        });
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: any;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    // ── POST (existing issue): reply, or confirm the fix ─────────────────────────
    if (typeof body.issueId === 'number') {
        // Confirm ownership before any write.
        const [issue] = await db
            .select({ id: issueReports.id, status: issueReports.status })
            .from(issueReports)
            .where(and(eq(issueReports.id, body.issueId), eq(issueReports.userId, userId)))
            .limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });

        if (body.action === 'confirm-fixed') {
            await db.update(issueReports)
                .set({ status: 'closed', resolvedAt: new Date(), updatedAt: new Date() })
                .where(eq(issueReports.id, issue.id));
            await db.insert(issueReportMessages).values({
                issueId: issue.id, authorType: 'user', authorId: userId,
                body: 'Confirmed the fix works. Thanks!', status: 'closed',
            });
            return json(200, { ok: true, status: 'closed' });
        }

        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) return json(400, { error: 'A message is required.' });

        // A user reply on a "more info" request, or on a fix they've found still broken,
        // re-opens the issue so it lands back in the developer's queue with the reply visible.
        const newStatus = (issue.status === 'more_info_required' || issue.status === 'fixed_ready_to_test')
            ? 'reported'
            : issue.status;
        await db.insert(issueReportMessages).values({
            issueId: issue.id, authorType: 'user', authorId: userId, body: message, status: null,
        });
        await db.update(issueReports)
            .set({ status: newStatus, updatedAt: new Date() })
            .where(eq(issueReports.id, issue.id));
        return json(200, { ok: true, status: newStatus });
    }

    // ── POST (new issue) ─────────────────────────────────────────────────────────
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) return json(400, { error: 'Please describe the issue.' });
    if (description.length > 5000) return json(400, { error: 'Description is too long (5000 char max).' });

    let imageData: string | null = null;
    let imageMime: string | null = null;
    if (typeof body.image === 'string' && body.image) {
        const v = validateImageDataUrl(body.image);
        if ('error' in v) return json(400, { error: v.error });
        imageData = body.image;
        imageMime = v.mime;
    }

    const sourceLocation = typeof body.sourceLocation === 'string' ? body.sourceLocation.slice(0, 200) : null;
    const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.slice(0, 1000) : null;
    const userAgent = (event.headers['user-agent'] || '').slice(0, 500) || null;

    const [created] = await db.insert(issueReports).values({
        organisationId,
        userId,
        description,
        sourceLocation,
        sourceUrl,
        userAgent,
        imageData,
        imageMime,
        status: 'reported',
    }).returning({ id: issueReports.id });

    // Notify the admin owner(s) — non-blocking; never fail the user's submission over email.
    notifyAdmins(db, created.id, userId, description, sourceLocation, sourceUrl, !!imageData, event.headers)
        .catch((e) => console.error('[issue-reports] admin notify failed:', e?.message || e));

    return json(201, { ok: true, id: created.id });
};

async function notifyAdmins(
    db: ReturnType<typeof getDb>,
    issueId: number,
    reporterId: number,
    description: string,
    sourceLocation: string | null,
    sourceUrl: string | null,
    hasImage: boolean,
    headers: Record<string, string | undefined>,
): Promise<void> {
    const recipients = await getAdminRecipients(db);
    if (!recipients.length) return;

    const [reporter] = await db
        .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
        .from(users).where(eq(users.id, reporterId)).limit(1);
    const reporterName = [reporter?.firstName, reporter?.lastName].filter(Boolean).join(' ') || reporter?.email || `User #${reporterId}`;

    const base = resolveBaseUrl(headers) || process.env.BASE_URL || 'https://bemoreswan.com';
    const adminLink = `${base}/admin.html?view=issue-reports`;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const html = `
        <p>A new issue has been reported during testing.</p>
        <table style="border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Issue&nbsp;ID</td><td style="padding:4px 0;"><strong>#${issueId}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Reported&nbsp;by</td><td style="padding:4px 0;">${esc(reporterName)} (${esc(reporter?.email || '')})</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Location</td><td style="padding:4px 0;">${esc(sourceLocation || '—')}${sourceUrl ? ` <span style="color:#9ca3af;">(${esc(sourceUrl)})</span>` : ''}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Screenshot</td><td style="padding:4px 0;">${hasImage ? 'Attached (view in Admin Portal)' : 'None'}</td></tr>
        </table>
        <p style="margin-top:16px;"><strong>Description</strong></p>
        <blockquote style="border-left:3px solid #e5e7eb;margin:0;padding:8px 16px;color:#374151;white-space:pre-wrap;">${esc(description)}</blockquote>
        <p style="margin-top:24px;">
          <a href="${adminLink}" style="background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
            Review in Admin Portal →
          </a>
        </p>`;

    const subject = `🐞 New issue reported #${issueId} — ${description.slice(0, 60)}${description.length > 60 ? '…' : ''}`;
    // De-dupe recipient emails (override can repeat; admin+super_admin sets are disjoint).
    const seen = new Set<string>();
    for (const r of recipients) {
        if (!r.email || seen.has(r.email.toLowerCase())) continue;
        seen.add(r.email.toLowerCase());
        await sendEmail({ to: r.email, subject, html }).catch((e) =>
            console.error(`[issue-reports] email to ${r.email} failed:`, e?.message || e));
    }
}
