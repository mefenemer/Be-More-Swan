// src/utils/audience-segment-preview.ts
// How many SUBSCRIBED people a rule matches right now, and what it says in plain English — before
// it is saved. Shared by the Audience page's rule builder (audience-segments `preview`) and the
// Email Marketing chat's segment card (src/utils/chat-audience.ts), so the number on the card and
// the number in the builder come from one compiler, and both are the real audience of a send rather
// than an estimate of it.
//
// ⚠️ Never throws for a bad rule: it returns { ok: false, error } with the same sentence the
// builder shows. A database failure still throws — callers decide what that means for them.

import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { audienceContacts, audienceCustomFields, audienceForms, audienceSegments } from '../../db/schema';
import { buildSegmentCondition, checkRuleReferences, describeRules, parseRules } from './audience-segment-rules';

type Db = ReturnType<typeof getDb>;

export type SegmentPreview =
    | { ok: true; matches: number; description: string }
    | { ok: false; error: string };

export async function previewSegmentRules(db: Db, organisationId: number, rules: unknown): Promise<SegmentPreview> {
    const parsed = parseRules(rules);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const refError = await checkRuleReferences(db, organisationId, rules);
    if (refError) return { ok: false, error: refError };
    const rule = buildSegmentCondition(organisationId, rules)!;
    const [count] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(audienceContacts)
        .where(and(
            eq(audienceContacts.organisationId, organisationId),
            eq(audienceContacts.status, 'subscribed'),
            rule,
        ));
    const forms = new Map<number, string>();
    try {
        const rows = await db.select({ id: audienceForms.id, name: audienceForms.name })
            .from(audienceForms).where(eq(audienceForms.organisationId, organisationId));
        for (const f of rows) forms.set(f.id, f.name);
    } catch { /* degrades to "form #3" */ }
    const tags = new Map<number, string>();
    try {
        const rows = await db.select({ id: audienceSegments.id, name: audienceSegments.name })
            .from(audienceSegments).where(eq(audienceSegments.organisationId, organisationId));
        for (const t of rows) tags.set(t.id, t.name);
    } catch { /* degrades to "#3" */ }
    const fields = new Map<string, string>();
    try {
        const rows = await db.select({ key: audienceCustomFields.key, label: audienceCustomFields.label })
            .from(audienceCustomFields).where(eq(audienceCustomFields.organisationId, organisationId));
        for (const d of rows) fields.set(d.key, d.label);
    } catch { /* falls back to the raw key */ }
    return { ok: true, matches: count?.n ?? 0, description: describeRules(rules, forms, tags, fields) };
}
