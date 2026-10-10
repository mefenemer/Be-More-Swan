// netlify/functions/product-updates.ts
// The weekly "What's new at Be More Swan" email — upload, review, approve.
//
// Machine routes (Authorization: Bearer $PRODUCT_UPDATES_INGEST_TOKEN — the weekly Claude task):
//   GET  ?resource=last                 → { commitTo, periodEnd } of the latest non-discarded email,
//                                         so next week's run starts where this one stopped
//   POST ?resource=ingest               → a new draft (copy + base64 screenshots); emails the reminder
//                                         to the business inbox. Never sends anything to customers.
//
// Admin routes (aura_session cookie, `manage_comms_templates`):
//   GET   ?resource=list                → every email, newest first
//   GET   ?resource=digest&id=N         → one email + its screenshots + a rendered preview + who would
//                                         receive it right now
//   PATCH ?resource=digest&id=N         → { subject?, preheader?, intro?, items? } — only while 'ready'
//   POST  ?resource=test-send&id=N      → send it to the signed-in admin only
//   POST  ?resource=approve&id=N        → ready → sending, then the background worker delivers it
//   POST  ?resource=resume&id=N         → re-trigger a worker for an email stuck in 'sending'
//   POST  ?resource=discard&id=N        → ready → discarded
//
// See docs/weekly-product-update.md. ⚠️ Approve is the ONLY path that emails customers, and it is
// cookie-authenticated: the machine token can create a draft but can never send one.

import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, productUpdateDigests, productUpdateImages, productUpdateSends } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { adminInbox } from '../../src/utils/admin-inbox';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { sendEmail } from '../../src/utils/email';
import {
    normaliseDraft, normaliseEdit, renderProductUpdateEmail, renderReminderEmail,
    productUpdateImageUrl, whatsNewUnsubscribeUrl, DraftError, type StoredItem,
} from '../../src/utils/product-update-email';
import { countRecipients } from '../../src/utils/product-update-recipients';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
});

/** The weekly task's credential. Constant-time compare; an unset token disables the machine routes. */
function isMachine(event: any): boolean {
    const expected = process.env.PRODUCT_UPDATES_INGEST_TOKEN;
    if (!expected || expected.length < 32) return false;
    const header = event.headers.authorization || event.headers.Authorization || '';
    const m = /^Bearer\s+(.+)$/.exec(header);
    if (!m) return false;
    const a = Buffer.from(m[1].trim());
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

async function requireAdmin(event: any): Promise<{ id: number; email: string; firstName: string | null } | null> {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], secret) as { userId: number }).userId; } catch { return null; }
    const db = getDb();
    const [row] = await db.select({ role: users.role, email: users.email, firstName: users.firstName })
        .from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !hasPermission(row.role, 'manage_comms_templates')) return null;
    return { id: userId, email: row.email, firstName: row.firstName };
}

/** Fire the delivery worker. Awaited with a short cap: an un-awaited fetch is frozen with the lambda. */
async function triggerWorker(baseUrl: string, digestId: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/send-product-update-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ digestId }),
            signal: controller.signal,
        });
        return res.ok;
    } catch (err) {
        console.error('[product-updates] failed to trigger the send worker for digest', digestId, err);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

export default withLambda(async (event) => {
    const db = getDb();
    const q = event.queryStringParameters || {};
    const resource = q.resource || '';
    const method = event.httpMethod;
    const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>);
    if (!baseUrl) return json(500, { error: 'BASE_URL is not configured.' });

    // ── Machine routes ──────────────────────────────────────────────────────────────────────
    if (resource === 'last' || resource === 'ingest') {
        if (!isMachine(event)) return json(401, { error: 'Unauthorised' });

        if (resource === 'last' && method === 'GET') {
            const [row] = await db.select({
                id: productUpdateDigests.id, commitTo: productUpdateDigests.commitTo,
                periodEnd: productUpdateDigests.periodEnd, status: productUpdateDigests.status,
            }).from(productUpdateDigests)
                .where(ne(productUpdateDigests.status, 'discarded'))
                .orderBy(desc(productUpdateDigests.createdAt)).limit(1);
            return json(200, { last: row ?? null });
        }

        if (resource === 'ingest' && method === 'POST') {
            let draft;
            try { draft = normaliseDraft(JSON.parse(event.body || '{}')); }
            catch (err) {
                if (err instanceof DraftError || err instanceof SyntaxError) return json(400, { error: err.message });
                throw err;
            }

            // One draft waiting at a time: a second upload while the first is unreviewed would put two
            // "ready" emails in front of the admin covering overlapping weeks.
            const [pending] = await db.select({ id: productUpdateDigests.id }).from(productUpdateDigests)
                .where(eq(productUpdateDigests.status, 'ready')).limit(1);
            if (pending && q.replace !== '1') {
                return json(409, { error: `Draft #${pending.id} is still waiting for review. Approve or discard it first, or upload with ?replace=1 to discard it.`, pendingId: pending.id });
            }

            const id = await db.transaction(async (tx) => {
                if (pending) {
                    await tx.update(productUpdateDigests).set({ status: 'discarded', updatedAt: new Date() })
                        .where(and(eq(productUpdateDigests.id, pending.id), eq(productUpdateDigests.status, 'ready')));
                }
                const [digest] = await tx.insert(productUpdateDigests).values({
                    subject: draft.subject, preheader: draft.preheader, intro: draft.intro, items: [],
                    commitFrom: draft.commitFrom, commitTo: draft.commitTo,
                    periodStart: draft.periodStart, periodEnd: draft.periodEnd,
                }).returning({ id: productUpdateDigests.id });

                const items: StoredItem[] = [];
                for (const it of draft.items) {
                    let imageId: number | null = null;
                    if (it.image) {
                        const [img] = await tx.insert(productUpdateImages).values({
                            digestId: digest.id, mime: it.image.mime, dataB64: it.image.dataB64,
                            width: it.image.width, height: it.image.height,
                        }).returning({ id: productUpdateImages.id });
                        imageId = img.id;
                    }
                    items.push({ heading: it.heading, body: it.body, imageId });
                }
                await tx.update(productUpdateDigests).set({ items }).where(eq(productUpdateDigests.id, digest.id));
                return digest.id;
            });

            // The reminder. A failure here must not lose the draft — it is already saved and visible
            // in the portal — so it is logged and reported back to the uploader, not thrown.
            let reminded = false;
            try {
                const r = renderReminderEmail({
                    baseUrl, digestId: id, subject: draft.subject, itemCount: draft.items.length,
                    periodStart: draft.periodStart, periodEnd: draft.periodEnd,
                });
                for (const to of adminInbox()) await sendEmail({ to, subject: r.subject, html: r.html, text: r.text });
                await db.update(productUpdateDigests).set({ reminderSentAt: new Date() }).where(eq(productUpdateDigests.id, id));
                reminded = true;
            } catch (err) {
                console.error('[product-updates] draft saved but the reminder email failed for digest', id, err);
            }
            return json(201, { id, reminded, reviewUrl: `${baseUrl}/admin.html?view=product-updates&id=${id}` });
        }
        return json(405, { error: 'Method Not Allowed' });
    }

    // ── Admin routes ────────────────────────────────────────────────────────────────────────
    const admin = await requireAdmin(event);
    if (!admin) return json(401, { error: 'Unauthorised' });

    if (resource === 'list' && method === 'GET') {
        const rows = await db.select({
            id: productUpdateDigests.id, status: productUpdateDigests.status, subject: productUpdateDigests.subject,
            items: productUpdateDigests.items, periodStart: productUpdateDigests.periodStart,
            periodEnd: productUpdateDigests.periodEnd, createdAt: productUpdateDigests.createdAt,
            approvedAt: productUpdateDigests.approvedAt, sentAt: productUpdateDigests.sentAt,
            recipientCount: productUpdateDigests.recipientCount, sentCount: productUpdateDigests.sentCount,
            failedCount: productUpdateDigests.failedCount, approverEmail: users.email,
        }).from(productUpdateDigests)
            .leftJoin(users, eq(users.id, productUpdateDigests.approvedBy))
            .orderBy(desc(productUpdateDigests.createdAt)).limit(100);
        return json(200, { digests: rows.map(({ items, ...r }) => ({ ...r, itemCount: (items || []).length })) });
    }

    const id = Number(q.id);
    if (!Number.isInteger(id) || id <= 0) return json(400, { error: 'id is required' });
    const [digest] = await db.select().from(productUpdateDigests).where(eq(productUpdateDigests.id, id)).limit(1);
    if (!digest) return json(404, { error: 'Not found' });

    const ip = getAdminIp(event.headers as Record<string, string | undefined>);
    const ua = event.headers['user-agent'];

    if (resource === 'digest' && method === 'GET') {
        const images = await db.select({ id: productUpdateImages.id, width: productUpdateImages.width, height: productUpdateImages.height })
            .from(productUpdateImages).where(eq(productUpdateImages.digestId, id));
        const preview = renderProductUpdateEmail(digest, { baseUrl, firstName: admin.firstName });
        const recipients = digest.status === 'ready' ? await countRecipients(db) : digest.recipientCount;
        const [progress] = await db.select({
            sent: sql<number>`count(*) filter (where ${productUpdateSends.status} = 'sent')::int`,
            failed: sql<number>`count(*) filter (where ${productUpdateSends.status} = 'failed')::int`,
        }).from(productUpdateSends).where(eq(productUpdateSends.digestId, id));
        return json(200, {
            digest,
            images: images.map(i => ({ ...i, url: productUpdateImageUrl(baseUrl, i.id) })),
            previewHtml: preview.html,
            recipients,
            progress,
        });
    }

    if (resource === 'digest' && method === 'PATCH') {
        if (digest.status !== 'ready') return json(409, { error: `This email is ${digest.status} and can no longer be edited.` });
        const images = await db.select({ id: productUpdateImages.id }).from(productUpdateImages).where(eq(productUpdateImages.digestId, id));
        let edit;
        try { edit = normaliseEdit(JSON.parse(event.body || '{}'), images.map(i => i.id)); }
        catch (err) {
            if (err instanceof DraftError || err instanceof SyntaxError) return json(400, { error: err.message });
            throw err;
        }
        const [updated] = await db.update(productUpdateDigests).set({ ...edit, updatedAt: new Date() })
            .where(and(eq(productUpdateDigests.id, id), eq(productUpdateDigests.status, 'ready'))).returning();
        if (!updated) return json(409, { error: 'This email changed status while you were editing it. Reload the page.' });
        await insertAdminAuditLog({
            adminId: admin.id, action: 'product_update_edit', targetType: 'product_update_digest', targetId: id,
            previousState: { subject: digest.subject, preheader: digest.preheader, intro: digest.intro, items: digest.items },
            newState: { subject: updated.subject, preheader: updated.preheader, intro: updated.intro, items: updated.items },
            ipAddress: ip, userAgent: ua,
        });
        return json(200, { digest: updated });
    }

    if (resource === 'test-send' && method === 'POST') {
        const email = renderProductUpdateEmail(digest, {
            baseUrl, firstName: admin.firstName, unsubscribeUrl: whatsNewUnsubscribeUrl(baseUrl, admin.id),
        });
        try {
            await sendEmail({ to: admin.email, subject: `[TEST] ${email.subject}`, html: email.html, text: email.text });
        } catch (err: any) {
            return json(502, { error: `The test email could not be sent: ${err?.message || err}` });
        }
        return json(200, { sentTo: admin.email });
    }

    if (resource === 'approve' && method === 'POST') {
        if (digest.status !== 'ready') return json(409, { error: `This email is already ${digest.status}.` });
        const recipients = await countRecipients(db);
        if (recipients === 0) return json(409, { error: 'There is nobody to send this to.' });
        // The status change IS the lock: only one approve can move 'ready' → 'sending'.
        const [claimed] = await db.update(productUpdateDigests).set({
            status: 'sending', approvedBy: admin.id, approvedAt: new Date(), recipientCount: recipients, updatedAt: new Date(),
        }).where(and(eq(productUpdateDigests.id, id), eq(productUpdateDigests.status, 'ready'))).returning({ id: productUpdateDigests.id });
        if (!claimed) return json(409, { error: 'Someone else has just approved or discarded this email.' });
        await insertAdminAuditLog({
            adminId: admin.id, action: 'product_update_approve', targetType: 'product_update_digest', targetId: id,
            newState: { subject: digest.subject, preheader: digest.preheader, intro: digest.intro, items: digest.items, recipients },
            ipAddress: ip, userAgent: ua,
        });
        const dispatched = await triggerWorker(baseUrl, id);
        return json(200, { status: 'sending', recipients, dispatched });
    }

    if (resource === 'resume' && method === 'POST') {
        if (digest.status !== 'sending') return json(409, { error: 'Only an email that is sending can be resumed.' });
        const dispatched = await triggerWorker(baseUrl, id);
        return json(200, { status: 'sending', dispatched });
    }

    if (resource === 'discard' && method === 'POST') {
        const [discarded] = await db.update(productUpdateDigests).set({ status: 'discarded', updatedAt: new Date() })
            .where(and(eq(productUpdateDigests.id, id), eq(productUpdateDigests.status, 'ready'))).returning({ id: productUpdateDigests.id });
        if (!discarded) return json(409, { error: `This email is ${digest.status} and cannot be discarded.` });
        await insertAdminAuditLog({
            adminId: admin.id, action: 'product_update_discard', targetType: 'product_update_digest', targetId: id,
            previousState: { status: digest.status, subject: digest.subject }, ipAddress: ip, userAgent: ua,
        });
        return json(200, { status: 'discarded' });
    }

    return json(405, { error: 'Method Not Allowed' });
});
