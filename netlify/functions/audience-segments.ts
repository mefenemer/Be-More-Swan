// netlify/functions/audience-segments.ts
// Segments of the shared Audience — "Weekly newsletter", "Trial signups", "Lapsed customers".
// Org-scoped via requireTenant. See docs/newsletter-assistant-plan.md.
//
//   GET                            → the org's segments, each with its SUBSCRIBED member count
//   POST { action: 'create' }      → new segment, or a TAG (kind: 'tag')
//   POST { action: 'rename' }      → rename / re-describe
//   POST { action: 'delete' }      → remove the segment (membership rows cascade; contacts stay)
//   POST { action: 'preview' }     → how many people a rule matches, and what it says in English
//   POST { action: 'setRules' }    → turn a segment into a rule, or change the rule
//
// ⚠️ A DYNAMIC SEGMENT HAS NO MEMBERSHIP ROWS. It is a saved rule compiled to a WHERE clause at the
// moment somebody asks — see src/utils/audience-segment-rules.ts for why nothing is materialised.
//
// ⚠️ Deleting a segment must never delete contacts. The join table cascades, the people do not —
// a tenant tidying up their labels has not asked to lose their audience.

import { HandlerEvent } from '@netlify/functions';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    audienceContactSegments, audienceContacts, audienceCustomFields, audienceForms, audienceSegments,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import {
    buildSegmentCondition, checkRuleReferences, describeRules, parseRules,
} from '../../src/utils/audience-segment-rules';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
});

const WRITE_ROLES = ['owner', 'admin', 'member'];
const MAX_NAME = 80;

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;

        // The count that matters is SENDABLE members, not members. A segment reading "1,400
        // contacts" that mails 900 people is the number a tenant plans a campaign around and then
        // has to explain. (This still excludes only the audience-side states — the opt-out and
        // suppression checks happen per send, in audience-consent.ts.)
        // Same 42P01 contract as audience-contacts.ts: on an environment where db/audience.sql has
        // not been applied, say so rather than 500ing with a Postgres message the customer cannot
        // act on. Any other error still throws — "not installed" and "broken" must stay distinct.
        let rows;
        try {
            rows = await db
            .select({
                id: audienceSegments.id,
                name: audienceSegments.name,
                description: audienceSegments.description,
                kind: audienceSegments.kind,
                rules: audienceSegments.rules,
                createdAt: audienceSegments.createdAt,
                memberCount: sql<number>`count(${audienceContactSegments.contactId})::int`,
                subscribedCount: sql<number>`count(*) FILTER (WHERE ${audienceContacts.status} = 'subscribed')::int`,
            })
            .from(audienceSegments)
            .leftJoin(audienceContactSegments, eq(audienceContactSegments.segmentId, audienceSegments.id))
            .leftJoin(audienceContacts, eq(audienceContacts.id, audienceContactSegments.contactId))
            .where(eq(audienceSegments.organisationId, ctx.organisationId))
            .groupBy(audienceSegments.id)
            .orderBy(audienceSegments.name);
        } catch (err) {
            const code = (err as { code?: string; cause?: { code?: string } })?.code
                ?? (err as { cause?: { code?: string } })?.cause?.code;
            if (code !== '42P01') throw err;
            console.error('[audience-segments] audience tables are missing — db/audience.sql has not been applied here',
                { orgId: ctx.organisationId });
            return json(200, { segments: [], needsSetup: true });
        }

        // ⚠️ A DYNAMIC SEGMENT HAS NO MEMBERSHIP ROWS, so the join above counts 0 for it — which
        // would read as "this segment is empty" for a rule matching four hundred people. Counted
        // here through the same compiler the send uses, one query per dynamic segment (a tenant has
        // a handful, not thousands).
        // Form names, so a "signed up through …" rule reads as the form's name rather than "form #3".
        // One query for the org, not one per segment.
        const tagNames = new Map<number, string>(rows.map((r) => [r.id, r.name] as const));
        const fieldLabels = new Map<string, string>();
        try {
            const defs = await db.select({ key: audienceCustomFields.key, label: audienceCustomFields.label })
                .from(audienceCustomFields).where(eq(audienceCustomFields.organisationId, ctx.organisationId));
            for (const d of defs) fieldLabels.set(d.key, d.label);
        } catch { /* the description falls back to the raw key */ }
        const formNames = new Map<number, string>();
        try {
            const forms = await db.select({ id: audienceForms.id, name: audienceForms.name })
                .from(audienceForms).where(eq(audienceForms.organisationId, ctx.organisationId));
            for (const f of forms) formNames.set(f.id, f.name);
        } catch { /* the description degrades to "form #3"; not worth failing the list over */ }

        const segments = [];
        for (const r of rows) {
            if (r.kind !== 'dynamic') { segments.push({ ...r, rulesError: null, description: null }); continue; }
            const parsed = parseRules(r.rules);
            const rule = parsed.ok ? buildSegmentCondition(ctx.organisationId, r.rules) : null;
            if (!rule) {
                // Named, not hidden. A segment whose rules stopped making sense must say so here,
                // because the alternative is a tenant discovering it when a send fails.
                segments.push({ ...r, memberCount: 0, subscribedCount: 0, description: null, rulesError: parsed.ok ? 'These rules could not be read.' : parsed.error });
                continue;
            }
            const [count] = await db
                .select({ n: sql<number>`count(*)::int` })
                .from(audienceContacts)
                .where(and(
                    eq(audienceContacts.organisationId, ctx.organisationId),
                    eq(audienceContacts.status, 'subscribed'),
                    rule,
                ));
            segments.push({
                ...r,
                memberCount: count?.n ?? 0,
                subscribedCount: count?.n ?? 0,
                // The sentence, next to the number. A count alone is not checkable — "412 people"
                // looks equally right whatever the rule says.
                description: describeRules(r.rules, formNames, tagNames, fieldLabels),
                rulesError: null,
            });
        }

        return json(200, { segments });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const ctx = await requireTenant(event, db, { roles: WRITE_ROLES });
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }
    const action = String(body.action || '');

    // How many people a rule matches, and what it says in English — before it is saved. The count
    // and the send come from one compiler, so this is a preview of the real audience rather than an
    // estimate of it.
    if (action === 'preview') {
        const parsed = parseRules(body.rules);
        if (!parsed.ok) return json(400, { error: parsed.error });
        const refError = await checkRuleReferences(db, orgId, body.rules);
        if (refError) return json(400, { error: refError });
        const rule = buildSegmentCondition(orgId, body.rules)!;
        const [count] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(audienceContacts)
            .where(and(
                eq(audienceContacts.organisationId, orgId),
                eq(audienceContacts.status, 'subscribed'),
                rule,
            ));
        const previewForms = new Map<number, string>();
        try {
            const forms = await db.select({ id: audienceForms.id, name: audienceForms.name })
                .from(audienceForms).where(eq(audienceForms.organisationId, orgId));
            for (const f of forms) previewForms.set(f.id, f.name);
        } catch { /* degrades to "form #3" */ }
        const previewTags = new Map<number, string>();
        try {
            const tags = await db.select({ id: audienceSegments.id, name: audienceSegments.name })
                .from(audienceSegments).where(eq(audienceSegments.organisationId, orgId));
            for (const t of tags) previewTags.set(t.id, t.name);
        } catch { /* degrades to "#3" */ }
        const previewFields = new Map<string, string>();
        try {
            const defs = await db.select({ key: audienceCustomFields.key, label: audienceCustomFields.label })
                .from(audienceCustomFields).where(eq(audienceCustomFields.organisationId, orgId));
            for (const d of defs) previewFields.set(d.key, d.label);
        } catch { /* falls back to the raw key */ }
        return json(200, {
            matches: count?.n ?? 0,
            description: describeRules(body.rules, previewForms, previewTags, previewFields),
        });
    }

    if (action === 'create') {
        const name = String(body.name || '').trim().slice(0, MAX_NAME);
        if (!name) return json(400, { error: 'Give the segment a name.' });

        // ⚠️ Rules are validated BEFORE the row exists. A dynamic segment saved with rules that do
        // not compile is a segment that looks selectable in the newsletter's audience picker and
        // fails the issue at send time.
        const dynamic = body.kind === 'dynamic';
        // A tag is a manual segment shown separately — same membership table, same writes. See
        // db/audience-tags.sql for why it is not a table of its own.
        const kind = dynamic ? 'dynamic' : body.kind === 'tag' ? 'tag' : 'manual';
        const parsed = dynamic ? parseRules(body.rules) : null;
        if (parsed && !parsed.ok) return json(400, { error: parsed.error });
        if (dynamic) {
            const refError = await checkRuleReferences(db, orgId, body.rules);
            if (refError) return json(400, { error: refError });
        }

        try {
            const [seg] = await db.insert(audienceSegments).values({
                organisationId: orgId,
                name,
                description: String(body.description || '').trim().slice(0, 300) || null,
                kind,
                rules: parsed?.ok ? parsed.rules : {},
                createdBy: ctx.userId,
            }).returning({ id: audienceSegments.id, name: audienceSegments.name, kind: audienceSegments.kind });
            return json(200, { segment: seg });
        } catch (err) {
            // audience_segments_org_name_unique is case-insensitive — "Newsletter" and "newsletter"
            // as two segments is a support ticket, not a feature.
            const code = (err as { code?: string; cause?: { code?: string } })?.code
                ?? (err as { cause?: { code?: string } })?.cause?.code;
            if (code === '23505') return json(409, { error: 'You already have a segment with that name.' });
            throw err;
        }
    }

    // Editing the rule of an existing dynamic segment. Kept separate from 'rename' because they are
    // different decisions: renaming is cosmetic, and changing a rule changes who gets emailed.
    if (action === 'setRules') {
        const id = Number(body.id || '');
        if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid segment.' });
        const parsed = parseRules(body.rules);
        if (!parsed.ok) return json(400, { error: parsed.error });
        const refError = await checkRuleReferences(db, orgId, body.rules);
        if (refError) return json(400, { error: refError });

        const [updated] = await db.update(audienceSegments)
            .set({ kind: 'dynamic', rules: parsed.rules, updatedAt: new Date() })
            .where(and(eq(audienceSegments.id, id), eq(audienceSegments.organisationId, orgId)))
            .returning({ id: audienceSegments.id });
        if (!updated) return json(404, { error: 'Segment not found.' });
        return json(200, { updated: true, description: describeRules(parsed.rules) });
    }

    if (action === 'rename') {
        const id = Number(body.id || '');
        const name = String(body.name || '').trim().slice(0, MAX_NAME);
        if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid segment.' });
        if (!name) return json(400, { error: 'Give the segment a name.' });

        const [updated] = await db.update(audienceSegments)
            .set({
                name,
                description: 'description' in body ? (String(body.description || '').trim().slice(0, 300) || null) : undefined,
                updatedAt: new Date(),
            })
            .where(and(eq(audienceSegments.id, id), eq(audienceSegments.organisationId, orgId)))
            .returning({ id: audienceSegments.id });
        if (!updated) return json(404, { error: 'Segment not found.' });
        return json(200, { updated: true });
    }

    if (action === 'delete') {
        const id = Number(body.id || '');
        if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid segment.' });

        const [deleted] = await db.delete(audienceSegments)
            .where(and(eq(audienceSegments.id, id), eq(audienceSegments.organisationId, orgId)))
            .returning({ id: audienceSegments.id });
        if (!deleted) return json(404, { error: 'Segment not found.' });
        // Contacts are untouched by design — only their membership rows cascade away.
        return json(200, { deleted: true });
    }

    return json(400, { error: `Unknown action: ${action}` });
});
