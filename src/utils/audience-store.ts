// src/utils/audience-store.ts
// The ONLY writers for the shared audience layer (db/audience.sql).
//
// Four different things can add a contact — the public capture form, a CSV import, a manual add in
// the Audience page, and promotion from a lead record — and they must all produce the same row and
// the same evidence. Where four call sites each write their own INSERT, the third one forgets the
// consent event, and the first time anyone notices is when a recipient asks "when did I agree to
// this?" and the answer is a row with no history. So the writes live here and the endpoints call
// them.
//
// ⚠️ Reads are NOT here. "May we email this person" is src/utils/audience-consent.ts, and it is the
// only thing allowed to answer that question.

import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { audienceConsentEvents, audienceContactSegments, audienceContacts } from '../../db/schema';
import { cleanName, looksLikeEmail, normaliseEmail } from './audience-contacts';

type Db = ReturnType<typeof getDb>;

export type ContactStatus = 'pending' | 'subscribed' | 'unsubscribed' | 'bounced' | 'complained' | 'suppressed';
export type ContactSource = 'web_form' | 'csv_import' | 'manual' | 'lead_promotion' | 'api';
export type ConsentBasis = 'double_opt_in' | 'single_opt_in' | 'imported_declared' | 'soft_opt_in' | 'manual_entry';
export type ConsentEventName =
    | 'subscribe_requested' | 'confirmed' | 'unsubscribed' | 'bounced' | 'complained'
    | 'imported' | 'promoted' | 'manual_added' | 'erased' | 'resubscribed'
    // Preference-centre decisions. Evidence, not settings: "they asked for a pause on 3 May" is
    // the same kind of fact as "they unsubscribed on 3 May", and belongs in the same table.
    | 'paused' | 'resumed' | 'frequency_changed';

export interface ConsentEventInput {
    organisationId: number;
    contactId?: number | null;
    email: string;
    event: ConsentEventName;
    channel?: string | null;
    sourceUrl?: string | null;
    /** Already pseudonymised — pass pseudonymiseIp(getClientIp(headers)), never the raw address. */
    ipHash?: string | null;
    userAgent?: string | null;
    formId?: number | null;
    issueId?: number | null;
    evidence?: string | null;
}

/**
 * Append one consent event. Deliberately THROWS on failure.
 *
 * Every other audit-ish write in this codebase swallows its errors so the real work still lands.
 * This one must not: the event IS the lawful basis for mailing someone, and a subscription
 * recorded without it is a contact we cannot justify holding. The callers that can afford to
 * continue (a status change we already made) catch it themselves and say so in the log; the caller
 * that cannot (a new subscription) lets it fail the request so the visitor can try again.
 */
export async function recordConsentEvent(db: Db, ev: ConsentEventInput): Promise<void> {
    await db.insert(audienceConsentEvents).values({
        organisationId: ev.organisationId,
        contactId: ev.contactId ?? null,
        email: normaliseEmail(ev.email),
        event: ev.event,
        channel: ev.channel ?? null,
        sourceUrl: ev.sourceUrl ? String(ev.sourceUrl).slice(0, 500) : null,
        ipHash: ev.ipHash ?? null,
        userAgent: ev.userAgent ? String(ev.userAgent).slice(0, 300) : null,
        formId: ev.formId ?? null,
        issueId: ev.issueId ?? null,
        evidence: ev.evidence ? String(ev.evidence).slice(0, 1000) : null,
    });
}

export interface UpsertContactInput {
    organisationId: number;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    phone?: string | null;
    status: ContactStatus;
    source: ContactSource;
    sourceDetail?: Record<string, unknown>;
    consentBasis?: ConsentBasis | null;
    confirmedAt?: Date | null;
    customFields?: Record<string, unknown>;
}

export interface UpsertContactResult {
    id: number;
    email: string;
    /** The status the row ended up with — NOT necessarily the one you asked for. See below. */
    status: string;
    /** False when the address was already in the audience. */
    created: boolean;
}

/**
 * Create or update one contact, on the (organisation_id, email) grain.
 *
 * ⚠️ THE STATUS RULE. An upsert never RAISES a contact out of a terminal state. Someone who
 * unsubscribed, hard-bounced or hit the spam button must not be resurrected by a CSV import or by
 * a stray form submission — that is precisely how a suppression list stops meaning anything, and
 * the person on the other end experiences it as "I unsubscribed and they emailed me again". The
 * only route back is a deliberate resubscribe (setContactStatus with event 'resubscribed'), which
 * a human has to choose and which leaves its own evidence.
 *
 * Names and company fill in blanks but never overwrite what is already there: a form that collects
 * only an email must not blank a name typed by the tenant.
 */
export async function upsertContact(db: Db, input: UpsertContactInput): Promise<UpsertContactResult> {
    const email = normaliseEmail(input.email);
    if (!looksLikeEmail(email)) throw new Error(`Refusing to store an unusable address: ${JSON.stringify(input.email)}`);

    const [row] = await db
        .insert(audienceContacts)
        .values({
            organisationId: input.organisationId,
            email,
            firstName: cleanName(input.firstName),
            lastName: cleanName(input.lastName),
            company: cleanName(input.company),
            phone: cleanName(input.phone),
            status: input.status,
            source: input.source,
            sourceDetail: input.sourceDetail ?? {},
            consentBasis: input.consentBasis ?? null,
            confirmedAt: input.confirmedAt ?? null,
            customFields: input.customFields ?? {},
        })
        .onConflictDoUpdate({
            target: [audienceContacts.organisationId, audienceContacts.email],
            set: {
                // COALESCE(existing, new): fill gaps, never clobber.
                firstName: sql`COALESCE(${audienceContacts.firstName}, EXCLUDED.first_name)`,
                lastName: sql`COALESCE(${audienceContacts.lastName}, EXCLUDED.last_name)`,
                company: sql`COALESCE(${audienceContacts.company}, EXCLUDED.company)`,
                phone: sql`COALESCE(${audienceContacts.phone}, EXCLUDED.phone)`,
                // The one-way ratchet. 'pending' may become 'subscribed'; nothing escapes
                // unsubscribed/bounced/complained/suppressed without an explicit human decision.
                status: sql`CASE
                    WHEN ${audienceContacts.status} IN ('unsubscribed','bounced','complained','suppressed')
                        THEN ${audienceContacts.status}
                    ELSE EXCLUDED.status END`,
                consentBasis: sql`COALESCE(${audienceContacts.consentBasis}, EXCLUDED.consent_basis)`,
                // Keep the ORIGINAL confirmation timestamp — it is the moment consent was given.
                confirmedAt: sql`COALESCE(${audienceContacts.confirmedAt}, EXCLUDED.confirmed_at)`,
                updatedAt: new Date(),
            },
        })
        .returning({
            id: audienceContacts.id,
            email: audienceContacts.email,
            status: audienceContacts.status,
            createdAt: audienceContacts.createdAt,
            updatedAt: audienceContacts.updatedAt,
        });

    // A row whose updatedAt still equals its createdAt was inserted by this call. Cheaper and more
    // reliable than a pre-flight SELECT, which races with a concurrent form submission.
    const created = !!row && row.createdAt?.getTime() === row.updatedAt?.getTime();
    return { id: row.id, email: row.email, status: row.status, created };
}

/**
 * Move a contact to a new status and record why, as one unit.
 *
 * A status change without its event is a lie by omission: the Audience page would show
 * "Unsubscribed" with an empty history, and nobody could say whether the person asked, a bounce
 * did it, or an admin clicked the wrong row. Both writes go in one transaction for that reason.
 */
export async function setContactStatus(
    db: Db,
    args: {
        organisationId: number;
        email: string;
        status: ContactStatus;
        event: ConsentEventName;
        channel?: string | null;
        evidence?: string | null;
        issueId?: number | null;
        formId?: number | null;
        sourceUrl?: string | null;
        ipHash?: string | null;
        userAgent?: string | null;
    },
): Promise<{ changed: boolean; contactId: number | null }> {
    const email = normaliseEmail(args.email);
    const now = new Date();
    // The raw COALESCE below binds this, not `now`. A JS Date binds as timestamptz and confirmed_at
    // is a plain TIMESTAMP, so the value written would depend on the server's TimeZone; an ISO
    // string is cast straight to timestamp, matching every other write on this row.
    const nowIso = now.toISOString();

    return db.transaction(async (tx: any) => {
        const [updated] = await tx
            .update(audienceContacts)
            .set({
                status: args.status,
                unsubscribedAt: args.status === 'unsubscribed' ? now : undefined,
                confirmedAt: args.status === 'subscribed' ? sql`COALESCE(${audienceContacts.confirmedAt}, ${nowIso})` : undefined,
                updatedAt: now,
            })
            .where(and(
                eq(audienceContacts.organisationId, args.organisationId),
                eq(audienceContacts.email, email),
            ))
            .returning({ id: audienceContacts.id });

        // No row is NOT an error. An unsubscribe for an address we do not hold still deserves its
        // event — it is evidence that the request was received, and the alternative is a support
        // conversation with nothing to point at.
        await tx.insert(audienceConsentEvents).values({
            organisationId: args.organisationId,
            contactId: updated?.id ?? null,
            email,
            event: args.event,
            channel: args.channel ?? null,
            sourceUrl: args.sourceUrl ?? null,
            ipHash: args.ipHash ?? null,
            userAgent: args.userAgent ? String(args.userAgent).slice(0, 300) : null,
            formId: args.formId ?? null,
            issueId: args.issueId ?? null,
            evidence: args.evidence ? String(args.evidence).slice(0, 1000) : null,
        });

        return { changed: !!updated, contactId: updated?.id ?? null };
    });
}

/** Put a contact in a segment. Idempotent — adding twice is not an error anyone should see. */
export async function addToSegment(db: Db, contactId: number, segmentId: number, addedBy?: number | null): Promise<void> {
    await db
        .insert(audienceContactSegments)
        .values({ contactId, segmentId, addedBy: addedBy ?? null })
        .onConflictDoNothing();
}

export async function removeFromSegment(db: Db, contactId: number, segmentId: number): Promise<void> {
    await db
        .delete(audienceContactSegments)
        .where(and(
            eq(audienceContactSegments.contactId, contactId),
            eq(audienceContactSegments.segmentId, segmentId),
        ));
}

export interface BulkUpsertRow {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    phone?: string | null;
    customFields?: Record<string, unknown>;
    /**
     * Per-row state, overriding the batch default.
     *
     * ⚠️ THE WHOLE REASON THIS IS PER ROW. A Mailchimp or Kit export carries the people who
     * unsubscribed alongside the people who did not. Writing one status for the batch turned every
     * one of them back into a subscriber — see src/config/audience-import-status.ts.
     */
    status?: ContactStatus;
    /** Per-row basis. Null for a row that did not consent — an unsubscribe has no lawful basis to claim. */
    consentBasis?: ConsentBasis | null;
}

export interface BulkUpsertResult {
    /** Rows the database accepted, keyed by normalised email. */
    contacts: { id: number; email: string; status: string }[];
    /** Addresses rejected before the query — never sent, never stored. */
    invalid: string[];
}

/**
 * Import many contacts in ONE round trip.
 *
 * The per-row upsertContact() would issue two queries per contact; a 5,000-row CSV would then be
 * 10,000 round trips against a serverless connection with `max: 1`, which is not a slow import, it
 * is a timeout. Same conflict rules as upsertContact — including the status ratchet, so an import
 * can never resurrect someone who unsubscribed.
 *
 * Callers are responsible for chunking (500 is the size the endpoints use) and for writing the
 * consent events; recordConsentEvents below does the matching batch write.
 */
export async function bulkUpsertContacts(
    db: Db,
    args: {
        organisationId: number;
        rows: BulkUpsertRow[];
        status: ContactStatus;
        source: ContactSource;
        consentBasis: ConsentBasis;
        sourceDetail?: Record<string, unknown>;
    },
): Promise<BulkUpsertResult> {
    const invalid: string[] = [];
    const seen = new Set<string>();
    const values = [];

    for (const r of args.rows) {
        const email = normaliseEmail(r.email);
        if (!looksLikeEmail(email)) { invalid.push(String(r.email ?? '').slice(0, 120)); continue; }
        // A CSV that lists the same person twice would otherwise make Postgres raise
        // "ON CONFLICT DO UPDATE command cannot affect row a second time" and lose the whole chunk.
        if (seen.has(email)) continue;
        seen.add(email);
        values.push({
            organisationId: args.organisationId,
            email,
            firstName: cleanName(r.firstName),
            lastName: cleanName(r.lastName),
            company: cleanName(r.company),
            phone: cleanName(r.phone),
            status: r.status ?? args.status,
            source: args.source,
            sourceDetail: args.sourceDetail ?? {},
            // A row that arrives already unsubscribed claims no consent, so it carries no basis.
            // `?? args.consentBasis` would quietly stamp "they told us we could" on somebody who
            // had explicitly said the opposite.
            consentBasis: r.consentBasis === null ? null : (r.consentBasis ?? args.consentBasis),
            customFields: r.customFields ?? {},
        });
    }

    if (!values.length) return { contacts: [], invalid };

    const contacts = await db
        .insert(audienceContacts)
        .values(values)
        .onConflictDoUpdate({
            target: [audienceContacts.organisationId, audienceContacts.email],
            set: {
                firstName: sql`COALESCE(${audienceContacts.firstName}, EXCLUDED.first_name)`,
                lastName: sql`COALESCE(${audienceContacts.lastName}, EXCLUDED.last_name)`,
                company: sql`COALESCE(${audienceContacts.company}, EXCLUDED.company)`,
                phone: sql`COALESCE(${audienceContacts.phone}, EXCLUDED.phone)`,
                // The ratchet, and it works in BOTH directions now that rows carry their own state:
                // an existing terminal state is never raised, and an incoming 'unsubscribed' still
                // lands on a contact we currently hold as subscribed — because EXCLUDED.status is
                // that row's own value. Importing somebody's opt-out must be able to STOP mail we
                // would otherwise have sent.
                status: sql`CASE
                    WHEN ${audienceContacts.status} IN ('unsubscribed','bounced','complained','suppressed')
                        THEN ${audienceContacts.status}
                    ELSE EXCLUDED.status END`,
                consentBasis: sql`COALESCE(${audienceContacts.consentBasis}, EXCLUDED.consent_basis)`,
                updatedAt: new Date(),
            },
        })
        .returning({ id: audienceContacts.id, email: audienceContacts.email, status: audienceContacts.status });

    return { contacts, invalid };
}

/** Batch form of recordConsentEvent. Same contract: it throws rather than losing the evidence. */
export async function recordConsentEvents(db: Db, events: ConsentEventInput[]): Promise<void> {
    if (!events.length) return;
    await db.insert(audienceConsentEvents).values(events.map((ev) => ({
        organisationId: ev.organisationId,
        contactId: ev.contactId ?? null,
        email: normaliseEmail(ev.email),
        event: ev.event,
        channel: ev.channel ?? null,
        sourceUrl: ev.sourceUrl ? String(ev.sourceUrl).slice(0, 500) : null,
        ipHash: ev.ipHash ?? null,
        userAgent: ev.userAgent ? String(ev.userAgent).slice(0, 300) : null,
        formId: ev.formId ?? null,
        issueId: ev.issueId ?? null,
        evidence: ev.evidence ? String(ev.evidence).slice(0, 1000) : null,
    })));
}
