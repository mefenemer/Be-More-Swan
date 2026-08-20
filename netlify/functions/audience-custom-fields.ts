// netlify/functions/audience-custom-fields.ts
// The tenant's own columns on a contact — "City", "Plan", "Where we met". Org-scoped.
//
//   GET                         → the org's field definitions
//   POST { action: 'create' }   → define one (key is derived from the label, once)
//   POST { action: 'rename' }   → change the LABEL only
//   POST { action: 'delete' }   → remove the definition
//
// ⚠️ THE KEY IS NEVER RENAMED. It is the JSONB key on every contact row and the value inside every
// saved segment rule, so changing it would orphan the values and silently empty any rule naming it.
// The label is what a human reads and may change as often as they like — which is why 'rename' does
// not accept a key at all rather than accepting and ignoring one.

import { HandlerEvent } from '@netlify/functions';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { audienceContacts, audienceCustomFields } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
});

const WRITE_ROLES = ['owner', 'admin', 'member'];
/** Enough for a tenant's own columns; past this an import mapper becomes unusable. */
const MAX_FIELDS = 20;
const MAX_LABEL = 60;

/**
 * A label → the key it will live under, for ever.
 *
 * Shown to the tenant BEFORE they create the field, because it is the thing they will type inside
 * `{{contact.custom.…}}` and the thing they cannot change afterwards.
 */
export function keyFromLabel(label: string): string {
    const key = String(label || '')
        .trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40)
        .replace(/_+$/, '');
    // Must start with a letter — the CHECK constraint says so, and a key beginning with a digit
    // would also be an awkward merge-tag path.
    return /^[a-z]/.test(key) ? key : `f_${key}`.slice(0, 40).replace(/_+$/, '');
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        try {
            const fields = await db.select().from(audienceCustomFields)
                .where(eq(audienceCustomFields.organisationId, ctx.organisationId))
                .orderBy(asc(audienceCustomFields.label));
            return json(200, { fields });
        } catch (err) {
            // Same contract as the rest of the audience endpoints: "not installed here" is a
            // different answer from "broken", and only one of them is worth a 500.
            const code = (err as { code?: string; cause?: { code?: string } })?.code
                ?? (err as { cause?: { code?: string } })?.cause?.code;
            if (code !== '42P01') throw err;
            return json(200, { fields: [], needsSetup: true });
        }
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const ctx = await requireTenant(event, db, { roles: WRITE_ROLES });
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }
    const action = String(body.action || '');

    if (action === 'create') {
        const label = String(body.label || '').trim().slice(0, MAX_LABEL);
        if (!label) return json(400, { error: 'Give the field a name.' });
        const key = keyFromLabel(label);
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) {
            return json(400, { error: 'Use a name with some letters in it — that is what becomes the field\'s permanent key.' });
        }
        // Only 'text' ships. See db/audience-custom-fields.sql for why numbers and dates are
        // reserved in the schema but refused here.
        if (body.type && body.type !== 'text') {
            return json(400, { error: 'Only text fields are supported at the moment.' });
        }

        const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
            .from(audienceCustomFields).where(eq(audienceCustomFields.organisationId, orgId));
        if (Number(n) >= MAX_FIELDS) {
            return json(400, { error: `You can have at most ${MAX_FIELDS} custom fields.` });
        }

        try {
            const [field] = await db.insert(audienceCustomFields).values({
                organisationId: orgId, key, label, type: 'text', createdBy: ctx.userId,
            }).returning();
            return json(200, { field });
        } catch (err) {
            const code = (err as { code?: string; cause?: { code?: string } })?.code
                ?? (err as { cause?: { code?: string } })?.cause?.code;
            if (code === '23505') {
                return json(409, { error: `You already have a field that would use the key "${key}".` });
            }
            throw err;
        }
    }

    const id = Number(body.id || '');
    if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid field.' });

    if (action === 'rename') {
        const label = String(body.label || '').trim().slice(0, MAX_LABEL);
        if (!label) return json(400, { error: 'Give the field a name.' });
        const [updated] = await db.update(audienceCustomFields)
            .set({ label, updatedAt: new Date() })
            .where(and(eq(audienceCustomFields.id, id), eq(audienceCustomFields.organisationId, orgId)))
            .returning({ id: audienceCustomFields.id, key: audienceCustomFields.key });
        if (!updated) return json(404, { error: 'Field not found.' });
        return json(200, { updated: true, key: updated.key });
    }

    if (action === 'delete') {
        // ⚠️ The DEFINITION goes; the VALUES on each contact stay. Stripping the key from every
        // contact would be a bulk write across the whole audience triggered by a tidy-up, and it is
        // not undoable — where leaving the data costs nothing and re-creating the field with the
        // same key brings it straight back. The count is reported so the decision is informed.
        const [field] = await db.select({ key: audienceCustomFields.key })
            .from(audienceCustomFields)
            .where(and(eq(audienceCustomFields.id, id), eq(audienceCustomFields.organisationId, orgId)))
            .limit(1);
        if (!field) return json(404, { error: 'Field not found.' });

        await db.delete(audienceCustomFields)
            .where(and(eq(audienceCustomFields.id, id), eq(audienceCustomFields.organisationId, orgId)));
        return json(200, { deleted: true, key: field.key });
    }

    if (action === 'usage') {
        // How many contacts hold a value for this field — shown before a delete.
        const [field] = await db.select({ key: audienceCustomFields.key })
            .from(audienceCustomFields)
            .where(and(eq(audienceCustomFields.id, id), eq(audienceCustomFields.organisationId, orgId)))
            .limit(1);
        if (!field) return json(404, { error: 'Field not found.' });
        const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
            .from(audienceContacts)
            .where(and(
                eq(audienceContacts.organisationId, orgId),
                sql`${audienceContacts.customFields} ? ${field.key}`,
            ));
        return json(200, { key: field.key, contacts: Number(n) || 0 });
    }

    return json(400, { error: `Unknown action: ${action}` });
});
