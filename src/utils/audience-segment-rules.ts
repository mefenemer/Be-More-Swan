// src/utils/audience-segment-rules.ts
// Dynamic segments: a saved rule instead of a hand-maintained list.
//
// ── Why rules are evaluated, never stored ───────────────────────────────────────────────────────
// A materialised membership table would need something to refresh it, and a refresh that stops
// running leaves a segment quietly describing last month — the tenant sends "everyone who opened
// something recently" to people who have not opened anything since March. This codebase has already
// had two nightly sweeps that never ran once. So there is no membership: the rule is compiled to a
// WHERE clause and asked at the moment somebody needs the answer. A dynamic segment cannot be stale
// because there is nothing to be stale.
//
// ── ⚠️ EVERY REFUSAL HERE POINTS THE SAME WAY ──────────────────────────────────────────────────
// This compiles the audience of a SEND. The failure that matters is not "the segment is wrong" —
// it is "the segment is wider than the tenant believes". Two rules follow, and both are the
// opposite of what an ordinary parser does:
//
//   1. NO CONDITIONS IS NOT "EVERYONE". An empty rule set is refused. A tenant who deletes their
//      last condition and presses save has not asked to email their entire list.
//   2. AN UNREADABLE CONDITION FAILS THE WHOLE RULE. Skipping the condition we cannot parse is the
//      dangerous default: dropping "has opened something in 90 days" from a three-condition rule
//      silently triples the audience. Better to refuse the segment and say which condition.
//
// Same reasoning as src/config/audience-import-status.ts: never guess in the direction of emailing
// more people.

import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { audienceContacts, audienceContactSegments, audienceSegments, newsletterSends } from '../../db/schema';

/** A whole rule set. `match: 'all'` is AND, `'any'` is OR. */
export interface SegmentRules {
    match: 'all' | 'any';
    conditions: SegmentCondition[];
}

export interface SegmentCondition {
    field: RuleField;
    op: string;
    /** Number of days for the time fields, a keyword for the rest. Never free text that reaches SQL. */
    value?: string | number;
}

export type RuleField = 'source' | 'form' | 'joined' | 'opened' | 'emailed' | 'email_domain' | 'tag';

/** What a tenant may filter on, and how. Data-driven so validation and the UI cannot disagree. */
export const RULE_FIELDS: Record<RuleField, { label: string; ops: string[]; needsValue: boolean }> = {
    source:       { label: 'How they joined',   ops: ['is', 'is_not'],        needsValue: true },
    form:         { label: 'Signed up through', ops: ['is'],                  needsValue: true },
    joined:       { label: 'Joined',            ops: ['within', 'not_within'], needsValue: true },
    opened:       { label: 'Opened an email',   ops: ['within', 'not_within'], needsValue: true },
    emailed:      { label: 'Has been emailed',  ops: ['never', 'ever'],       needsValue: false },
    email_domain: { label: 'Email domain',      ops: ['is', 'is_not'],        needsValue: true },
    // ⚠️ Composing a TAG into a rule is what makes tags worth having: "tagged 'bought something'
    // and has not opened an email in 60 days" is Kit's model reached with the tables we already
    // have. The value is an audience_segments.id whose kind is 'tag' or 'manual' — the API refuses
    // a reference to a DYNAMIC segment, because a rule over a rule is a cycle waiting to happen.
    tag:          { label: 'Tagged',            ops: ['in', 'not_in'],        needsValue: true },
};

/** Mirrors audience_contacts.source — the CHECK constraint is the authority. */
export const SOURCE_VALUES = ['web_form', 'csv_import', 'manual', 'lead_promotion', 'api'] as const;

export const SOURCE_LABEL: Record<string, string> = {
    web_form:       'a sign-up form',
    csv_import:     'an import',
    manual:         'being added by hand',
    lead_promotion: 'the Lead Generator',
    api:            'the API',
};

/** A rule nobody can read is a rule nobody can check. Ten conditions is already a lot. */
export const MAX_CONDITIONS = 10;
/** Ten years. Beyond that a "within N days" rule is just "everyone", said at length. */
export const MAX_DAYS = 3650;

export type ParseResult =
    | { ok: true; rules: SegmentRules }
    | { ok: false; error: string };

/**
 * Validate whatever arrived — from a form, from the database, from an older version of this file.
 *
 * ⚠️ Called on READ as well as on write. A rule set that was legal when it was saved can stop being
 * legal (a field removed, a source value retired), and the send path must refuse it rather than
 * compile a partial version of it.
 */
export function parseRules(raw: unknown): ParseResult {
    const obj = (raw ?? {}) as Partial<SegmentRules>;
    const match = obj.match === 'any' ? 'any' : 'all';
    const list = Array.isArray(obj.conditions) ? obj.conditions : [];

    if (!list.length) {
        // ⚠️ THE IMPORTANT ONE. Empty must never compile to TRUE.
        return { ok: false, error: 'A dynamic segment needs at least one condition — without one it would match your whole audience.' };
    }
    if (list.length > MAX_CONDITIONS) {
        return { ok: false, error: `A segment can have at most ${MAX_CONDITIONS} conditions.` };
    }

    const conditions: SegmentCondition[] = [];
    for (const [i, c] of list.entries()) {
        const where = `Condition ${i + 1}`;
        const field = String((c as SegmentCondition)?.field ?? '') as RuleField;
        const spec = RULE_FIELDS[field];
        if (!spec) return { ok: false, error: `${where} uses a filter we do not recognise (${field || 'blank'}).` };

        const op = String((c as SegmentCondition)?.op ?? '');
        if (!spec.ops.includes(op)) return { ok: false, error: `${where} uses a comparison we do not recognise (${op || 'blank'}).` };

        if (!spec.needsValue) { conditions.push({ field, op }); continue; }

        const rawValue = (c as SegmentCondition)?.value;
        if (field === 'joined' || field === 'opened') {
            const days = Number(rawValue);
            if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) {
                return { ok: false, error: `${where} needs a number of days between 1 and ${MAX_DAYS}.` };
            }
            conditions.push({ field, op, value: Math.floor(days) });
            continue;
        }
        if (field === 'source') {
            const v = String(rawValue ?? '');
            if (!SOURCE_VALUES.includes(v as typeof SOURCE_VALUES[number])) {
                return { ok: false, error: `${where} names a way of joining we do not recognise (${v || 'blank'}).` };
            }
            conditions.push({ field, op, value: v });
            continue;
        }
        if (field === 'tag') {
            const id = Number(rawValue);
            if (!Number.isFinite(id) || id < 1) return { ok: false, error: `${where} needs a tag.` };
            conditions.push({ field, op, value: Math.floor(id) });
            continue;
        }
        if (field === 'form') {
            const id = Number(rawValue);
            if (!Number.isFinite(id) || id < 1) return { ok: false, error: `${where} needs a sign-up form.` };
            conditions.push({ field, op, value: Math.floor(id) });
            continue;
        }
        // email_domain. Bounded shape rather than free text — it is compared as a bound parameter,
        // but a rule a human cannot read back is a rule nobody audits.
        const domain = String(rawValue ?? '').trim().toLowerCase();
        if (!/^[a-z0-9.-]{3,253}\.[a-z]{2,}$/.test(domain)) {
            return { ok: false, error: `${where} needs a domain like "gmail.com".` };
        }
        conditions.push({ field, op, value: domain });
    }

    return { ok: true, rules: { match, conditions } };
}

/** Days → an ISO timestamp. Never a Date: raw templates bind those as timestamptz. */
const daysAgoIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

/**
 * One condition → SQL over audience_contacts.
 *
 * The engagement conditions are EXISTS subqueries against the send ledger rather than a join, so a
 * contact who opened four issues is one row here and not four.
 */
function conditionSql(organisationId: number, c: SegmentCondition): SQL {
    switch (c.field) {
        case 'source':
            return c.op === 'is'
                ? eq(audienceContacts.source, String(c.value))
                : ne(audienceContacts.source, String(c.value));

        case 'form':
            // Written by the capture form into source_detail. ->> so a missing key is NULL, not an
            // error, and the comparison is against text on both sides.
            return sql`(${audienceContacts.sourceDetail} ->> 'formId') = ${String(c.value)}`;

        case 'joined':
            return c.op === 'within'
                ? sql`${audienceContacts.createdAt} >= ${daysAgoIso(Number(c.value))}`
                : sql`${audienceContacts.createdAt} < ${daysAgoIso(Number(c.value))}`;

        case 'emailed':
            return c.op === 'never'
                ? isNull(audienceContacts.lastSentAt)
                : sql`${audienceContacts.lastSentAt} IS NOT NULL`;

        case 'email_domain': {
            // Anchored on the '@' so "notgmail.com" cannot match "gmail.com".
            const suffix = `%@${String(c.value)}`;
            return c.op === 'is'
                ? sql`${audienceContacts.email} LIKE ${suffix}`
                : sql`${audienceContacts.email} NOT LIKE ${suffix}`;
        }

        case 'tag': {
            // ⚠️ The organisation is re-asserted INSIDE the subquery, through the segment row. A
            // rule carrying another tenant's segment id would otherwise be answered by their
            // membership table — it would match nobody today, because membership is written
            // org-checked on both sides, but "safe because of what another file does" is not a
            // guarantee this file should rely on.
            const tagged = sql`EXISTS (
                SELECT 1 FROM ${audienceContactSegments}
                  JOIN ${audienceSegments} ON ${audienceSegments.id} = ${audienceContactSegments.segmentId}
                 WHERE ${audienceContactSegments.contactId} = ${audienceContacts.id}
                   AND ${audienceContactSegments.segmentId} = ${Number(c.value)}
                   AND ${audienceSegments.organisationId} = ${organisationId})`;
            return c.op === 'in' ? tagged : sql`NOT ${tagged}`;
        }

        case 'opened': {
            // Named ...Iso deliberately: tests/raw-sql-date-params.test.ts flags a bare `since` in a
            // raw template on its name alone, and it is right to — a Date bound there is coerced
            // through the server's TimeZone against a plain TIMESTAMP column.
            const sinceIso = daysAgoIso(Number(c.value));
            // ⚠️ Org-scoped INSIDE the subquery as well as outside. newsletter_sends carries its own
            // organisation_id, and a segment that could see another tenant's ledger would be a
            // cross-tenant read in the one place nobody would think to look for one.
            const opened = sql`EXISTS (
                SELECT 1 FROM ${newsletterSends}
                 WHERE ${newsletterSends.contactId} = ${audienceContacts.id}
                   AND ${newsletterSends.organisationId} = ${organisationId}
                   AND ${newsletterSends.openedAt} IS NOT NULL
                   AND ${newsletterSends.openedAt} >= ${sinceIso})`;
            return c.op === 'within' ? opened : sql`NOT ${opened}`;
        }
    }
}

/**
 * A whole rule set → one SQL condition, or null when it cannot be compiled.
 *
 * ⚠️ NULL MEANS REFUSE, NEVER "MATCH EVERYONE". Every caller must treat it as a hard stop — the
 * send path fails the issue with a reason rather than falling back to the whole audience.
 */
export function buildSegmentCondition(organisationId: number, raw: unknown): SQL | null {
    const parsed = parseRules(raw);
    if (!parsed.ok) return null;
    const parts = parsed.rules.conditions.map((c) => conditionSql(organisationId, c));
    return parsed.rules.match === 'any' ? or(...parts)! : and(...parts)!;
}

/**
 * The one check that needs the database: does every tag this rule names exist, here, and is it
 * something a rule may point at?
 *
 * ⚠️ A rule may not reference a DYNAMIC segment. A rule over a rule is a cycle waiting to be
 * written, and the first one would be found by whichever send hit it. Refused with a sentence
 * rather than left to compile into an EXISTS over a membership table that is always empty — which
 * would match nobody, quietly, for a reason the tenant could not see.
 *
 * Returns null when the rule is fine, or the message to show.
 */
export async function checkRuleReferences(
    db: { select: (...args: never[]) => never } | any,
    organisationId: number,
    raw: unknown,
): Promise<string | null> {
    const parsed = parseRules(raw);
    if (!parsed.ok) return parsed.error;

    const tagIds = parsed.rules.conditions
        .filter((c) => c.field === 'tag')
        .map((c) => Number(c.value));
    if (!tagIds.length) return null;

    const rows = await db
        .select({ id: audienceSegments.id, kind: audienceSegments.kind, name: audienceSegments.name })
        .from(audienceSegments)
        .where(and(
            eq(audienceSegments.organisationId, organisationId),
            inArray(audienceSegments.id, [...new Set(tagIds)]),
        ));
    const byId = new Map<number, { kind: string; name: string }>(
        (rows as { id: number; kind: string; name: string }[]).map((r) => [r.id, { kind: r.kind, name: r.name }]),
    );

    for (const id of tagIds) {
        const found = byId.get(id);
        if (!found) return 'This rule points at a tag that no longer exists. Remove that condition or choose another tag.';
        if (found.kind === 'dynamic') {
            return `"${found.name}" is itself a rule-based segment, so a rule cannot be built on top of it. Point at a tag or a manual segment instead.`;
        }
    }
    return null;
}

/**
 * The rule as an English sentence, for the segment list and the send preview.
 *
 * A count on its own is not checkable — "412 people" looks equally right whatever the rule says.
 * The sentence is what lets a tenant notice that their segment means something other than they
 * intended BEFORE they send to it.
 */
export function describeRules(
    raw: unknown,
    formNames?: Map<number, string>,
    tagNames?: Map<number, string>,
): string {
    const parsed = parseRules(raw);
    if (!parsed.ok) return parsed.error;

    const bits = parsed.rules.conditions.map((c) => {
        switch (c.field) {
            case 'source':
                return `${c.op === 'is' ? 'joined through' : 'did not join through'} ${SOURCE_LABEL[String(c.value)] ?? String(c.value)}`;
            case 'form':
                return `signed up through ${formNames?.get(Number(c.value)) ?? `form #${c.value}`}`;
            case 'joined':
                return c.op === 'within' ? `joined in the last ${c.value} days` : `joined more than ${c.value} days ago`;
            case 'opened':
                return c.op === 'within' ? `opened an email in the last ${c.value} days` : `has not opened an email in the last ${c.value} days`;
            case 'emailed':
                return c.op === 'never' ? 'has never been emailed' : 'has been emailed before';
            case 'email_domain':
                return `${c.op === 'is' ? 'uses' : 'does not use'} an @${c.value} address`;
            case 'tag':
                return `${c.op === 'in' ? 'is tagged' : 'is not tagged'} ${tagNames?.get(Number(c.value)) ?? `#${c.value}`}`;
        }
    });

    const joiner = parsed.rules.match === 'all' ? ' and ' : ' or ';
    return `Everyone subscribed who ${bits.join(joiner)}.`;
}
