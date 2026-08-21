// netlify/functions/audience-contacts.ts
// The shared Audience — the organisation's own contacts, owned by the tenant and usable by every
// assistant it hires (docs/newsletter-assistant-plan.md). Org-scoped via requireTenant.
//
//   GET    ?id=<n>                → one contact + its segments + its consent timeline + its issues
//   GET    [?status=&segmentId=&q=]  → the list, plus per-status counts for the header
//   POST   { action: 'create' }   → add one contact by hand
//   POST   { action: 'update' }   → edit name/company/phone
//   POST   { action: 'status' }   → unsubscribe / resubscribe (writes the consent event too)
//   POST   { action: 'segment' }  → add/remove contacts to a segment (bulk)
//   POST   { action: 'import' }   → one chunk of a CSV import
//   DELETE ?id=<n>                → remove a contact — see THE DELETE RULE below
//
// ⚠️ THE DELETE RULE. Deleting a contact who UNSUBSCRIBED would delete the block: the address
// becomes unknown again, the next capture-form submission re-adds them, and the person who asked
// to be left alone gets mailed. Same self-undoing shape as src/utils/prospect-erasure.ts, which
// solved it by keeping the opt-out. So a delete of a contact in a terminal state writes a
// lead_opt_outs row FIRST (address grain, org-scoped, no removal path) and only then removes the
// contact. A delete of a plain subscriber writes nothing extra — they can be re-added freely,
// which is what "remove from my list" means for someone who never objected.

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    audienceConsentEvents, audienceContactSegments, audienceContacts, audienceImportJobs,
    audienceSegments, leadOptOuts, newsletterIssues, newsletterSends,
} from '../../db/schema';
import { cleanName, looksLikeEmail, normaliseEmail } from '../../src/utils/audience-contacts';
import {
    addToSegment, bulkUpsertContacts, recordConsentEvent, recordConsentEvents, removeFromSegment,
    setContactStatus, upsertContact, type BulkUpsertRow, type ContactStatus,
} from '../../src/utils/audience-store';
import { resolveImportStatus } from '../../src/config/audience-import-status';
import { haltEnrolmentsForContact } from '../../src/utils/newsletter-sequence';
import { SKIP_REASON_LABEL, type AudienceSkipReason } from '../../src/utils/audience-consent';
import { buildSegmentCondition } from '../../src/utils/audience-segment-rules';
import { audienceCustomFields } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
});

/** Roles allowed to change the audience. A viewer can read it and nothing else. */
const WRITE_ROLES = ['owner', 'admin', 'member'];
const DESTRUCTIVE_ROLES = ['owner', 'admin'];

// ⚠️ A deliberate exception to the "lists are client-paged, never a server LIMIT" rule, and the
// reason is scale: every other list in this product is tens or hundreds of rows, and an audience is
// the first that can be tens of thousands. Shipping 50,000 contacts to the browser to page them
// there is not a slow page, it is a dead tab. So the list is capped and says so — `truncated` plus
// the real `total` — and the UI narrows with filters rather than scrolling forever.
const LIST_CAP = 2000;
/** One chunk of a CSV import. The client splits the file; this bounds one request's work. */
const IMPORT_CHUNK_MAX = 500;

/**
 * Keep only the custom values whose key this organisation has defined, trimmed and bounded.
 *
 * ⚠️ An allow-list, not a filter of "obviously bad" keys. The values arrive from the browser, and
 * the alternative is arbitrary keys written into every contact's JSONB where nothing lists them and
 * nothing can clean them up.
 */
export function pickDefined(raw: unknown, allowed: Set<string>): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!allowed.has(k)) continue;
        const value = String(v ?? '').trim().slice(0, 500);
        // An empty cell is not a value. Storing '' would make "has a city" true for somebody whose
        // city column was blank.
        if (value) out[k] = value;
    }
    return out;
}

/** How many issues one contact's drawer shows. A long-standing subscriber has hundreds. */
const SEND_HISTORY_LIMIT = 100;

/**
 * Every issue this address was sent, or deliberately not sent — the ledger, not a summary.
 *
 * The consent timeline beside it answers "why is this person on my list"; this answers "what have
 * we actually sent them", which until now existed only in newsletter_sends and was readable by the
 * send worker and nobody else. A tenant asked what someone had received and the honest answer was
 * a single `last_sent_at` date.
 *
 * ⚠️ Matched on contactId OR the address, exactly like the consent timeline above, and for the same
 * reason: `contact_id` is ON DELETE SET NULL, so a removed-and-re-added subscriber keeps their
 * history on the email alone.
 *
 * ⚠️ `skipLabel` is resolved HERE rather than in the browser. SKIP_REASON_LABEL lives in
 * audience-consent.ts, the module every assistant asks, and it is not in the generated client
 * mirror — sending the label rather than the key is what stops audience.js becoming a second copy
 * of that vocabulary. See [[client-constants-generated]] for what the copies cost.
 *
 * ⚠️ `engagementTracked` is carried per ROW because it is a property of the SEND, not of the
 * contact: an issue that went through a connected mailbox rewrote no links and embedded no pixel,
 * so "not opened" there is a statement about our instrumentation. The drawer says so instead.
 */
async function sendHistory(db: ReturnType<typeof getDb>, orgId: number, contactId: number, email: string) {
    try {
        return await db
            .select({
                sendId: newsletterSends.id,
                issueId: newsletterSends.issueId,
                subject: newsletterIssues.subject,
                subjectB: newsletterIssues.subjectB,
                purpose: newsletterIssues.purpose,
                status: newsletterSends.status,
                skipReason: newsletterSends.skipReason,
                error: newsletterSends.error,
                variant: newsletterSends.variant,
                sentAt: newsletterSends.sentAt,
                dueAt: newsletterSends.dueAt,
                openedAt: newsletterSends.openedAt,
                clickedAt: newsletterSends.clickedAt,
                openCount: newsletterSends.openCount,
                clickCount: newsletterSends.clickCount,
                lastClickedUrl: newsletterSends.lastClickedUrl,
                engagementTracked: newsletterIssues.engagementTracked,
                createdAt: newsletterSends.createdAt,
            })
            .from(newsletterSends)
            .innerJoin(newsletterIssues, eq(newsletterIssues.id, newsletterSends.issueId))
            .where(and(
                eq(newsletterSends.organisationId, orgId),
                or(eq(newsletterSends.contactId, contactId), eq(newsletterSends.email, email)),
            ))
            .orderBy(desc(sql`COALESCE(${newsletterSends.sentAt}, ${newsletterSends.createdAt})`))
            .limit(SEND_HISTORY_LIMIT)
            .then((rows) => rows.map(({ subjectB, ...r }) => ({
                ...r,
                // ⚠️ The subject THEY were sent, not the issue's. Under an A/B test half the list
                // received subject_b, and showing the issue's own line would tell the tenant this
                // person got an email they never saw.
                subject: r.variant === 'B' && subjectB ? subjectB : r.subject,
                skipLabel: r.skipReason ? SKIP_REASON_LABEL[r.skipReason as AudienceSkipReason] ?? null : null,
            })));
    } catch (err) {
        // ⚠️ Its own guard, not the drawer's. An environment without db/newsletter.sql still has a
        // contact worth looking at, and a 42P01 here must not take the consent history down with it.
        const code = (err as { code?: string; cause?: { code?: string } })?.code
            ?? (err as { cause?: { code?: string } })?.cause?.code;
        if (code !== '42P01') throw err;
        return [];
    }
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    // ── Read ────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        const orgId = ctx.organisationId;
        const idParam = event.queryStringParameters?.id;

        if (idParam) {
            const id = Number(idParam);
            if (!Number.isFinite(id)) return json(400, { error: 'Invalid contact id.' });

            const [contact] = await db
                .select()
                .from(audienceContacts)
                .where(and(eq(audienceContacts.id, id), eq(audienceContacts.organisationId, orgId)))
                .limit(1);
            if (!contact) return json(404, { error: 'Contact not found.' });

            const segments = await db
                .select({ id: audienceSegments.id, name: audienceSegments.name })
                .from(audienceContactSegments)
                .innerJoin(audienceSegments, eq(audienceSegments.id, audienceContactSegments.segmentId))
                .where(eq(audienceContactSegments.contactId, id));

            // Matched on contactId OR the address: events survive the contact row on purpose
            // (ON DELETE SET NULL), and a re-added subscriber should still show what came before.
            const timeline = await db
                .select({
                    id: audienceConsentEvents.id,
                    event: audienceConsentEvents.event,
                    channel: audienceConsentEvents.channel,
                    sourceUrl: audienceConsentEvents.sourceUrl,
                    evidence: audienceConsentEvents.evidence,
                    createdAt: audienceConsentEvents.createdAt,
                })
                .from(audienceConsentEvents)
                .where(and(
                    eq(audienceConsentEvents.organisationId, orgId),
                    or(eq(audienceConsentEvents.contactId, id), eq(audienceConsentEvents.email, contact.email)),
                ))
                .orderBy(desc(audienceConsentEvents.createdAt))
                .limit(200);

            const newsletters = await sendHistory(db, orgId, id, contact.email);

            return json(200, { contact, segments, timeline, newsletters });
        }

        // ⚠️ The card on an assistant's Overview wants the SHAPE of the list — how many subscribed,
        // how many left, how many never confirmed — and none of the contacts. Without this it had
        // to fetch a capped page of up to LIST_CAP rows and throw every one of them away, on a
        // dashboard that loads on every visit.
        if (event.queryStringParameters?.countsOnly === '1') {
            try {
                const rows = await db
                    .select({ status: audienceContacts.status, n: sql<number>`count(*)::int` })
                    .from(audienceContacts)
                    .where(eq(audienceContacts.organisationId, orgId))
                    .groupBy(audienceContacts.status);
                const byStatus: Record<string, number> = {};
                let all = 0;
                for (const c of rows) { byStatus[c.status] = c.n; all += c.n; }

                // Growth over the last 30 days, subscribed only. ⚠️ Joined on created_at, not on
                // confirmed_at: somebody who signed up three weeks ago and confirmed yesterday is a
                // subscriber this month either way, and the two dates disagree by design under
                // double opt-in.
                const [recent] = await db
                    .select({ n: sql<number>`count(*)::int` })
                    .from(audienceContacts)
                    .where(and(
                        eq(audienceContacts.organisationId, orgId),
                        eq(audienceContacts.status, 'subscribed'),
                        sql`${audienceContacts.createdAt} > now() - interval '30 days'`,
                    ));

                return json(200, { counts: byStatus, total: all, newLast30Days: recent?.n ?? 0 });
            } catch (err) {
                const code = (err as { code?: string; cause?: { code?: string } })?.code
                    ?? (err as { cause?: { code?: string } })?.cause?.code;
                if (code !== '42P01') throw err;
                return json(200, { counts: {}, total: 0, newLast30Days: 0, needsSetup: true });
            }
        }

        const status = (event.queryStringParameters?.status || '').trim();
        const segmentId = Number(event.queryStringParameters?.segmentId || '');
        const q = (event.queryStringParameters?.q || '').trim();

        const filters = [eq(audienceContacts.organisationId, orgId)];
        if (status) filters.push(eq(audienceContacts.status, status));
        if (q) {
            const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
            const match = or(
                ilike(audienceContacts.email, like),
                ilike(audienceContacts.firstName, like),
                ilike(audienceContacts.lastName, like),
                ilike(audienceContacts.company, like),
            );
            if (match) filters.push(match);
        }

        const base = db
            .select({
                id: audienceContacts.id,
                email: audienceContacts.email,
                firstName: audienceContacts.firstName,
                lastName: audienceContacts.lastName,
                company: audienceContacts.company,
                status: audienceContacts.status,
                source: audienceContacts.source,
                consentBasis: audienceContacts.consentBasis,
                confirmedAt: audienceContacts.confirmedAt,
                lastSentAt: audienceContacts.lastSentAt,
                createdAt: audienceContacts.createdAt,
            })
            .from(audienceContacts);

        // ⚠️ An environment where db/audience.sql has not been applied yet answers every one of
        // these with 42P01. That is a real misconfiguration and the page says so — but a raw 500
        // with a Postgres message in it tells a customer nothing and looks like an outage.
        // Reported, not hidden: `needsSetup` is what the UI renders.
        // Browsing a DYNAMIC segment asks its rule, not the join table — the same compiler the send
        // uses, so "who is in this segment" and "who would this reach" can never be two answers.
        let dynamicRule: ReturnType<typeof buildSegmentCondition> = null;
        let segmentIsDynamic = false;
        if (Number.isFinite(segmentId) && segmentId) {
            try {
                const [seg] = await db
                    .select({ kind: audienceSegments.kind, rules: audienceSegments.rules })
                    .from(audienceSegments)
                    .where(and(eq(audienceSegments.id, segmentId), eq(audienceSegments.organisationId, orgId)))
                    .limit(1);
                if (seg?.kind === 'dynamic') {
                    segmentIsDynamic = true;
                    dynamicRule = buildSegmentCondition(orgId, seg.rules);
                }
            } catch { /* the 42P01 path below reports it */ }
        }
        // Rules that will not compile list NOBODY rather than everybody. Showing the whole audience
        // under a segment's name is how somebody sends to a list they believe is filtered.
        if (segmentIsDynamic && !dynamicRule) {
            return json(200, {
                contacts: [], counts: {}, total: 0, truncated: false, cap: LIST_CAP,
                segmentRulesError: 'The rules for this segment could not be read, so nobody is being shown. Edit the segment to fix them.',
            });
        }

        let rows;
        try {
            rows = segmentIsDynamic && dynamicRule
                ? await base
                    .where(and(...filters, dynamicRule))
                    .orderBy(desc(audienceContacts.createdAt))
                    .limit(LIST_CAP + 1)
                : Number.isFinite(segmentId) && segmentId
                ? await base
                    .innerJoin(audienceContactSegments, eq(audienceContactSegments.contactId, audienceContacts.id))
                    .where(and(...filters, eq(audienceContactSegments.segmentId, segmentId)))
                    .orderBy(desc(audienceContacts.createdAt))
                    .limit(LIST_CAP + 1)
                : await base
                    .where(and(...filters))
                    .orderBy(desc(audienceContacts.createdAt))
                    .limit(LIST_CAP + 1);
        } catch (err) {
            const code = (err as { code?: string; cause?: { code?: string } })?.code
                ?? (err as { cause?: { code?: string } })?.cause?.code;
            if (code !== '42P01') throw err;
            console.error('[audience-contacts] audience tables are missing — db/audience.sql has not been applied here', { orgId });
            return json(200, { contacts: [], counts: {}, total: 0, truncated: false, cap: LIST_CAP, needsSetup: true });
        }

        // Header counts are computed over the WHOLE audience, never over the capped page — a
        // "1,204 subscribed" that silently means "of the 2,000 we shipped you" is worse than no
        // number at all.
        const counts = await db
            .select({ status: audienceContacts.status, n: sql<number>`count(*)::int` })
            .from(audienceContacts)
            .where(eq(audienceContacts.organisationId, orgId))
            .groupBy(audienceContacts.status);

        const byStatus: Record<string, number> = {};
        let total = 0;
        for (const c of counts) { byStatus[c.status] = c.n; total += c.n; }

        return json(200, {
            contacts: rows.slice(0, LIST_CAP),
            truncated: rows.length > LIST_CAP,
            cap: LIST_CAP,
            counts: byStatus,
            total,
        });
    }

    // ── Delete ──────────────────────────────────────────────────────────────
    if (event.httpMethod === 'DELETE') {
        const ctx = await requireTenant(event, db, { roles: DESTRUCTIVE_ROLES });
        if ('error' in ctx) return ctx.error;
        const orgId = ctx.organisationId;

        const id = Number(event.queryStringParameters?.id || '');
        if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid contact id.' });

        const [contact] = await db
            .select({ id: audienceContacts.id, email: audienceContacts.email, status: audienceContacts.status })
            .from(audienceContacts)
            .where(and(eq(audienceContacts.id, id), eq(audienceContacts.organisationId, orgId)))
            .limit(1);
        if (!contact) return json(404, { error: 'Contact not found.' });

        // THE DELETE RULE (see the header). The opt-out is written FIRST and a failure to write it
        // aborts the delete: removing the person's data while leaving nothing to stop the next
        // capture-form submission is the one outcome worse than not deleting at all.
        const terminal = ['unsubscribed', 'complained', 'bounced', 'suppressed'].includes(contact.status);
        let optOutRetained = false;
        if (terminal) {
            try {
                await db.insert(leadOptOuts).values({
                    organisationId: orgId,
                    email: contact.email,
                    reason: `audience_${contact.status}`,
                    source: 'manual',
                    matchedRule: 'audience_contact_deleted',
                    evidence: `Contact deleted from the Audience while '${contact.status}'; the block is kept so the address cannot be re-added silently.`,
                }).onConflictDoNothing();
                optOutRetained = true;
            } catch (err) {
                console.error('[audience-contacts] refusing to delete: the opt-out could not be retained', { orgId, id }, err);
                return json(500, { error: 'Could not delete this contact safely. Nothing was removed — please try again.' });
            }
        }

        // The consent events survive (contact_id ON DELETE SET NULL) — the evidence of what this
        // person agreed to must outlive the row.
        await db.delete(audienceContacts).where(and(
            eq(audienceContacts.id, id),
            eq(audienceContacts.organisationId, orgId),
        ));

        try {
            await recordConsentEvent(db, {
                organisationId: orgId,
                contactId: null,
                email: contact.email,
                event: 'erased',
                channel: 'admin',
                evidence: optOutRetained
                    ? 'Contact deleted; opt-out retained so the address cannot be re-subscribed silently.'
                    : 'Contact deleted from the Audience.',
            });
        } catch (err) {
            // The delete already happened; losing its event is bad but not worth failing a
            // completed destructive action the caller would then repeat.
            console.error('[audience-contacts] contact deleted but the erasure event was not recorded', { orgId, id }, err);
        }

        return json(200, { deleted: true, optOutRetained });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    // ── Write ───────────────────────────────────────────────────────────────
    const ctx = await requireTenant(event, db, { roles: WRITE_ROLES });
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }
    const action = String(body.action || '');

    if (action === 'create') {
        const email = normaliseEmail(body.email);
        if (!looksLikeEmail(email)) return json(400, { error: 'Enter a valid email address.' });

        // A hand-added contact is 'subscribed' on the tenant's own say-so — they are asserting they
        // have a relationship with this person. That assertion is recorded as 'manual_entry', which
        // is deliberately NOT the same basis as a confirmed double opt-in.
        const res = await upsertContact(db, {
            organisationId: orgId,
            email,
            firstName: body.firstName,
            lastName: body.lastName,
            company: body.company,
            phone: body.phone,
            status: 'subscribed',
            source: 'manual',
            consentBasis: 'manual_entry',
            confirmedAt: new Date(),
            sourceDetail: { addedBy: ctx.userId },
        });

        await recordConsentEvent(db, {
            organisationId: orgId,
            contactId: res.id,
            email,
            event: res.created ? 'manual_added' : 'resubscribed',
            channel: 'admin',
            evidence: `Added by user ${ctx.userId} from the Audience page.`,
        });

        const segId = Number(body.segmentId || '');
        if (Number.isFinite(segId) && segId) {
            const [seg] = await db.select({ id: audienceSegments.id }).from(audienceSegments)
                .where(and(eq(audienceSegments.id, segId), eq(audienceSegments.organisationId, orgId))).limit(1);
            if (seg) await addToSegment(db, res.id, segId, ctx.userId);
        }

        return json(200, { contact: res });
    }

    if (action === 'update') {
        const id = Number(body.id || '');
        if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid contact id.' });

        // Only the descriptive fields. Status changes go through 'status' so they can never happen
        // without a consent event beside them.
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if ('firstName' in body) patch.firstName = cleanName(body.firstName);
        if ('lastName' in body) patch.lastName = cleanName(body.lastName);
        if ('company' in body) patch.company = cleanName(body.company);
        if ('phone' in body) patch.phone = cleanName(body.phone);

        // The tenant's own columns. MERGED into what is already there, through the same allow-list
        // the import uses — sending one field must not erase the others, and a key nobody defined
        // must not be writable at all.
        if (body.custom && typeof body.custom === 'object') {
            const customKeys = new Set<string>();
            try {
                const defs = await db.select({ key: audienceCustomFields.key })
                    .from(audienceCustomFields).where(eq(audienceCustomFields.organisationId, orgId));
                for (const d of defs) customKeys.add(d.key);
            } catch { /* nothing defined here — nothing to write */ }
            const clean = pickDefined(body.custom, customKeys);
            // ⚠️ A key sent as EMPTY is a deletion, and pickDefined drops empties — so the two are
            // handled separately: merge what has a value, remove what was explicitly blanked.
            const cleared = Object.entries(body.custom as Record<string, unknown>)
                .filter(([k, v]) => customKeys.has(k) && !String(v ?? '').trim())
                .map(([k]) => k);
            if (Object.keys(clean).length || cleared.length) {
                patch.customFields = sql`(COALESCE(${audienceContacts.customFields}, '{}'::jsonb) || ${JSON.stringify(clean)}::jsonb)`;
                for (const k of cleared) {
                    patch.customFields = sql`(${patch.customFields as never}) - ${k}`;
                }
            }
        }

        const [updated] = await db.update(audienceContacts).set(patch)
            .where(and(eq(audienceContacts.id, id), eq(audienceContacts.organisationId, orgId)))
            .returning({ id: audienceContacts.id });
        if (!updated) return json(404, { error: 'Contact not found.' });
        return json(200, { updated: true });
    }

    if (action === 'status') {
        const status = String(body.status || '') as ContactStatus;
        if (!['subscribed', 'unsubscribed'].includes(status)) {
            // 'bounced'/'complained' are written by the provider webhook, never by a person, and
            // 'suppressed' is derived. Letting the UI set them would forge delivery evidence.
            return json(400, { error: 'Only subscribed and unsubscribed can be set here.' });
        }
        const emails: string[] = Array.isArray(body.emails) ? body.emails : (body.email ? [body.email] : []);
        if (!emails.length) return json(400, { error: 'No contacts selected.' });
        if (emails.length > IMPORT_CHUNK_MAX) return json(400, { error: `Change at most ${IMPORT_CHUNK_MAX} contacts at a time.` });

        let changed = 0;
        for (const raw of emails) {
            const res = await setContactStatus(db, {
                organisationId: orgId,
                email: raw,
                status,
                event: status === 'unsubscribed' ? 'unsubscribed' : 'resubscribed',
                channel: 'admin',
                evidence: `Set to ${status} by user ${ctx.userId} from the Audience page.`,
            });
            if (res.changed) changed++;

            // Keep the welcome series in step with the status change. ⚠️ Unsubscribing HALTS; being
            // marked subscribed by hand does NOT enrol — the unique index would refuse a second
            // enrolment anyway, but the reason matters: a person added by an admin has not just
            // raised their hand, and a "welcome, thanks for subscribing" arriving because somebody
            // tidied a spreadsheet is a message the recipient never asked for.
            if (status === 'unsubscribed' && res.contactId) {
                await haltEnrolmentsForContact(db, {
                    organisationId: orgId,
                    contactId: res.contactId,
                    reason: 'unsubscribed',
                });
            }
        }
        return json(200, { changed });
    }

    if (action === 'segment') {
        const segmentId = Number(body.segmentId || '');
        const contactIds: number[] = Array.isArray(body.contactIds) ? body.contactIds.map(Number).filter(Number.isFinite) : [];
        const remove = body.remove === true;
        if (!Number.isFinite(segmentId) || !segmentId) return json(400, { error: 'Invalid segment.' });
        if (!contactIds.length) return json(400, { error: 'No contacts selected.' });

        const [seg] = await db.select({ id: audienceSegments.id, kind: audienceSegments.kind, name: audienceSegments.name })
            .from(audienceSegments)
            .where(and(eq(audienceSegments.id, segmentId), eq(audienceSegments.organisationId, orgId))).limit(1);
        if (!seg) return json(404, { error: 'Segment not found.' });
        // ⚠️ Membership rows are not read for a dynamic segment, so writing one would be a button
        // that reports success and changes nothing — the tenant then sends to a segment they
        // believe contains somebody it does not.
        if (seg.kind === 'dynamic') {
            return json(409, {
                error: `"${seg.name}" decides its own members from its rules, so people cannot be added to it by hand. Edit the rules, or use a manual segment.`,
            });
        }

        // Re-check every id against the org. contactIds arrive from the browser, and a segment
        // membership row carries no organisation_id of its own — the tenancy check has to happen
        // here or a crafted request could file another org's contact into this org's segment.
        const owned = await db.select({ id: audienceContacts.id }).from(audienceContacts)
            .where(and(eq(audienceContacts.organisationId, orgId), inArray(audienceContacts.id, contactIds.slice(0, IMPORT_CHUNK_MAX))));

        for (const c of owned) {
            if (remove) await removeFromSegment(db, c.id, segmentId);
            else await addToSegment(db, c.id, segmentId, ctx.userId);
        }
        return json(200, { affected: owned.length });
    }

    if (action === 'import') {
        const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
        if (!rows.length) return json(400, { error: 'No rows to import.' });
        if (rows.length > IMPORT_CHUNK_MAX) return json(400, { error: `Send at most ${IMPORT_CHUNK_MAX} rows per request.` });

        // ⚠️ The declaration is the ONLY lawful basis an imported list has. No box ticked, no
        // import — and the tick is recorded against a named user and a timestamp, not assumed.
        if (body.declaredConsent !== true) {
            return json(400, { error: 'Confirm that you have permission to email these contacts before importing.' });
        }

        let jobId = Number(body.importJobId || '');
        if (!Number.isFinite(jobId) || !jobId) {
            const [job] = await db.insert(audienceImportJobs).values({
                organisationId: orgId,
                filename: String(body.filename || '').slice(0, 200) || null,
                status: 'running',
                declaredConsent: true,
                createdBy: ctx.userId,
            }).returning({ id: audienceImportJobs.id });
            jobId = job.id;
        }

        const segmentId = Number(body.segmentId || '');

        // ⚠️ READ THE STATUS COLUMN. A Mailchimp/Kit export carries the people who UNSUBSCRIBED
        // alongside everyone else. Importing them as subscribed — which this did until 2026-08-20 —
        // re-mails people who opted out, from the tenant's own domain. An unrecognised value is
        // REFUSED rather than guessed: see src/config/audience-import-status.ts.
        // The org's own columns, read once per chunk. A file may carry a "City" column; only a
        // tenant who has defined `city` gets it stored.
        const customKeys = new Set<string>();
        try {
            const defs = await db.select({ key: audienceCustomFields.key })
                .from(audienceCustomFields).where(eq(audienceCustomFields.organisationId, orgId));
            for (const d of defs) customKeys.add(d.key);
        } catch { /* no definitions table here yet — the import proceeds without custom fields */ }

        const prepared: BulkUpsertRow[] = [];
        const unreadable: string[] = [];
        let unsubscribedRows = 0;

        for (const r of rows) {
            const verdict = resolveImportStatus(r.status);
            if (verdict.unrecognised) {
                unreadable.push(String(r.status ?? '').slice(0, 40));
                continue;
            }
            const status = verdict.status;
            if (status && status !== 'subscribed') unsubscribedRows++;
            prepared.push({
                email: r.email,
                firstName: r.firstName,
                lastName: r.lastName,
                company: r.company,
                phone: r.phone,
                // ⚠️ Only keys this org has DEFINED are kept. The browser sends whatever the mapper
                // produced, and an unchecked object here would let a crafted request write
                // arbitrary keys into every contact's JSONB — invisible in the UI, and impossible
                // to clean up because nothing would list them.
                ...(customKeys.size ? { customFields: pickDefined(r.custom, customKeys) } : {}),
                // No status column, or an empty cell → the import's own default, which is what a
                // plain "here are some people to add" list means.
                ...(status ? { status } : {}),
                // Somebody who arrives already unsubscribed claims no consent basis. Stamping
                // 'imported_declared' on them would record "they told us we could email them"
                // against a person who had said the opposite.
                ...(status && status !== 'subscribed' ? { consentBasis: null } : {}),
            });
        }

        if (!prepared.length) {
            return json(400, {
                error: unreadable.length
                    ? 'None of these rows could be read — the status column contains values we do not recognise.'
                    : 'No rows to import.',
                unreadableStatuses: [...new Set(unreadable)].slice(0, 10),
            });
        }

        const { contacts, invalid } = await bulkUpsertContacts(db, {
            organisationId: orgId,
            rows: prepared,
            status: 'subscribed',
            source: 'csv_import',
            consentBasis: 'imported_declared',
            sourceDetail: { importJobId: jobId, importedBy: ctx.userId },
        });

        // The event says what the row actually was. An address imported as unsubscribed gets an
        // 'unsubscribed' event, not an 'imported' one — otherwise the consent timeline would show
        // "imported" against somebody we are never allowed to email, with nothing to explain why.
        const statusByEmail = new Map(prepared.map((r) => [String(r.email).trim().toLowerCase(), r.status]));
        await recordConsentEvents(db, contacts.map((c) => {
            const rowStatus = statusByEmail.get(c.email);
            const optedOut = !!rowStatus && rowStatus !== 'subscribed';
            return {
                organisationId: orgId,
                contactId: c.id,
                email: c.email,
                event: optedOut ? ('unsubscribed' as const) : ('imported' as const),
                channel: 'admin',
                evidence: optedOut
                    ? `CSV import #${jobId}: this address was already ${rowStatus} in the file it came from, and will not be emailed.`
                    : `CSV import #${jobId} by user ${ctx.userId}; the importer declared they hold consent.`,
            };
        }));

        if (Number.isFinite(segmentId) && segmentId) {
            const [seg] = await db.select({ id: audienceSegments.id }).from(audienceSegments)
                .where(and(eq(audienceSegments.id, segmentId), eq(audienceSegments.organisationId, orgId))).limit(1);
            if (seg) {
                // Only the mailable ones. A segment whose count includes people we may never email
                // overstates every send built from it.
                for (const c of contacts) {
                    if (c.status === 'subscribed') await addToSegment(db, c.id, segmentId, ctx.userId);
                }
            }
        }

        // A contact the ratchet held at 'unsubscribed' counts as SKIPPED, not imported. Reporting
        // it as imported would tell the tenant they have subscribers they are never allowed to
        // email — the number on the screen has to mean what it says.
        const imported = contacts.filter((c) => c.status === 'subscribed').length;
        const skipped = contacts.length - imported;

        await db.update(audienceImportJobs).set({
            rowCount: sql`${audienceImportJobs.rowCount} + ${rows.length}`,
            imported: sql`${audienceImportJobs.imported} + ${imported}`,
            skipped: sql`${audienceImportJobs.skipped} + ${skipped}`,
            failed: sql`${audienceImportJobs.failed} + ${invalid.length}`,
            status: body.final === true ? 'completed' : 'running',
            completedAt: body.final === true ? new Date() : null,
            errorSummary: invalid.length ? sql`${audienceImportJobs.errorSummary} || ${JSON.stringify(invalid.slice(0, 20))}::jsonb` : undefined,
        }).where(and(eq(audienceImportJobs.id, jobId), eq(audienceImportJobs.organisationId, orgId)));

        return json(200, {
            importJobId: jobId,
            imported,
            skipped,
            failed: invalid.length + unreadable.length,
            invalid: invalid.slice(0, 20),
            // Reported separately from `skipped`, which also covers people we already held as
            // unsubscribed. These two numbers answer different questions and a tenant migrating a
            // list needs both: what came over as opted out, and what we could not read at all.
            unsubscribedFromFile: unsubscribedRows,
            unreadableStatuses: [...new Set(unreadable)].slice(0, 10),
        });
    }

    return json(400, { error: `Unknown action: ${action}` });
});
