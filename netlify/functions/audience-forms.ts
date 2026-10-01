// netlify/functions/audience-forms.ts
// The tenant's embeddable sign-up forms — the snippet they paste onto their own website.
// Org-scoped via requireTenant. Public ingress lives in audience-public.ts.
//
//   GET                          → the org's forms
//   POST { action: 'create' }    → new form with a fresh aud_ key
//   POST { action: 'update' }    → name, segment, double opt-in, fields, theme, copy, origins
//   POST { action: 'rotate' }    → mint a new public key (the old snippet stops working)
//   POST { action: 'delete' }    → disable the form (never destroyed — see below)
//
// ⚠️ 'delete' DISABLES rather than removes. audience_consent_events.form_id points at these rows,
// and that evidence is the answer to "which form did this person sign up through, and what did it
// say at the time". Deleting the form to tidy up a settings page would quietly cut the one link
// between a subscriber and the wording they agreed to.

import { HandlerEvent } from '@netlify/functions';
import { randomBytes } from 'crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { audienceCustomFields, audienceForms, audienceSegments, contentAssets, newsletterSequences } from '../../db/schema';
import {
    normaliseOrigin, sanitiseFields, validateFormTheme, validateRedirectUrl,
    DEFAULT_CONSENT_TEXT, DEFAULT_SUCCESS_MESSAGE,
} from '../../src/utils/audience-forms';
import { requireTenant } from '../../src/utils/tenant';
import {
    columnsFromDefinition, legacyToDefinition, normaliseFormDefinition, SLUG_RE, RESERVED_SLUGS,
    type FormDefinition,
} from '../../src/utils/form-definition';
import { loadBrandNewsletterTheme } from '../../src/utils/brand-theme';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
});

// Theming and origin allowlists change what runs on the customer's own website, so they follow
// save-widget-config.ts and stay with owner/admin.
const WRITE_ROLES = ['owner', 'admin'];
const newPublicKey = () => 'aud_' + randomBytes(12).toString('hex');
const MAX_ORIGINS = 20;


type Db = ReturnType<typeof getDb>;

/**
 * Everything a definition has to pass before it is stored, beyond what the normaliser can know on its
 * own: that the segment, the email campaign and the logo belong to THIS organisation, that each
 * allowed website is a real origin, and that the page address is not someone else's.
 *
 * `strictSlug`: the builder wants a clear "that address is taken" (409) so the person picks another;
 * a chat card would rather save the form without the address and say so.
 */
async function prepareDefinition(db: Db, orgId: number, raw: unknown, opts: { formId?: number; strictSlug: boolean }):
    Promise<{ definition: FormDefinition; warnings: string[] } | { error: string; status: number }> {
    const brand = await loadBrandNewsletterTheme(db, orgId);
    const { definition: def, warnings } = normaliseFormDefinition(raw, { brand: { accent: brand.accent, text: brand.text } });

    if (def.audience.segmentId) {
        const [seg] = await db.select({ id: audienceSegments.id }).from(audienceSegments)
            .where(and(eq(audienceSegments.id, def.audience.segmentId), eq(audienceSegments.organisationId, orgId))).limit(1);
        if (!seg) { def.audience.segmentId = null; warnings.push('The chosen segment no longer exists, so it was cleared.'); }
    }
    if (def.campaign.sequenceId) {
        const [seq] = await db.select({ id: newsletterSequences.id }).from(newsletterSequences)
            .where(and(eq(newsletterSequences.id, def.campaign.sequenceId), eq(newsletterSequences.organisationId, orgId))).limit(1);
        if (!seq) { def.campaign = { sequenceId: null, skipWelcome: false }; warnings.push('The chosen email campaign no longer exists, so the form was unlinked.'); }
    }
    if (def.style.logo) {
        // ⚠️ The logo is drawn through a SIGNED, permanent, public URL. Signing an asset id that
        // belongs to another tenant would publish their image — so ownership is checked here, once.
        const [asset] = await db.select({ id: contentAssets.id }).from(contentAssets)
            .where(and(eq(contentAssets.id, def.style.logo.assetId), eq(contentAssets.organisationId, orgId))).limit(1);
        if (!asset) { def.style.logo = null; warnings.push('The logo could not be found in your library, so it was removed.'); }
    }
    if (def.delivery.embed.allowedOrigins) {
        const list = def.delivery.embed.allowedOrigins.map((o) => normaliseOrigin(o));
        if (list.some((o) => o === null)) return { error: 'Each allowed website must be a full address, e.g. https://example.com', status: 400 };
        def.delivery.embed.allowedOrigins = [...new Set(list as string[])].slice(0, MAX_ORIGINS);
    }
    const slug = def.delivery.hosted.slug;
    if (slug) {
        const [taken] = await db.select({ id: audienceForms.id }).from(audienceForms)
            .where(and(sql`lower(${audienceForms.slug}) = ${slug}`, opts.formId ? ne(audienceForms.id, opts.formId) : sql`true`)).limit(1);
        if (taken) {
            if (opts.strictSlug) return { error: `bemoreswan.com/f/${slug} is already taken — try another address.`, status: 409 };
            def.delivery.hosted.slug = null;
            warnings.push(`bemoreswan.com/f/${slug} is already taken, so the page address was left blank.`);
        }
    }
    return { definition: def, warnings };
}

/** A custom field a form writes to must exist, or the Audience page cannot show what was collected. */
async function ensureCustomFields(db: Db, orgId: number, def: FormDefinition, userId: number) {
    for (const f of def.fields) {
        if (f.target.kind !== 'custom') continue;
        await db.insert(audienceCustomFields)
            .values({ organisationId: orgId, key: f.target.key, label: f.label.slice(0, 60), type: 'text', createdBy: userId })
            .onConflictDoNothing();
    }
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        try {
            const forms = await db
                .select()
                .from(audienceForms)
                .where(eq(audienceForms.organisationId, ctx.organisationId))
                .orderBy(desc(audienceForms.createdAt));
            // How each form is doing: sign-ups recorded, and how many of those people are subscribed now.
            // Best effort — a database without db/form-builder.sql applied has no submissions table,
            // and the list must still open.
            const stats = new Map<number, { submissions: number; subscribed: number; last30: number }>();
            try {
                const rows = await db.execute(sql`
                    SELECT s.form_id AS "formId",
                           count(*)::int AS submissions,
                           count(*) FILTER (WHERE s.created_at > now() - interval '30 days')::int AS last30,
                           count(DISTINCT s.contact_id) FILTER (WHERE c.status = 'subscribed')::int AS subscribed
                      FROM audience_form_submissions s
                      LEFT JOIN audience_contacts c ON c.id = s.contact_id
                     WHERE s.organisation_id = ${ctx.organisationId}
                     GROUP BY s.form_id`);
                for (const r of (rows as unknown as { rows?: any[] }).rows ?? (rows as unknown as any[])) {
                    stats.set(Number(r.formId), { submissions: Number(r.submissions), subscribed: Number(r.subscribed), last30: Number(r.last30) });
                }
            } catch (err) {
                console.error('[audience-forms] form stats unavailable', err);
            }
            // Every form carries a definition, whatever era it was saved in, so the builder has one shape.
            return json(200, {
                forms: forms.map((f) => ({
                    ...f,
                    definition: f.definition ? normaliseFormDefinition(f.definition).definition : legacyToDefinition(f),
                    stats: stats.get(f.id) ?? { submissions: 0, subscribed: 0, last30: 0 },
                })),
            });
        } catch (err) {
            // db/audience.sql not applied here. Same contract as audience-contacts.ts.
            const code = (err as { code?: string; cause?: { code?: string } })?.code
                ?? (err as { cause?: { code?: string } })?.cause?.code;
            if (code !== '42P01') throw err;
            console.error('[audience-forms] audience tables are missing — db/audience.sql has not been applied here',
                { orgId: ctx.organisationId });
            return json(200, { forms: [], needsSetup: true });
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

    // Is a page address free? The builder asks as the person types.
    if (action === 'checkSlug') {
        const slug = String(body.slug || '').trim().toLowerCase();
        if (!SLUG_RE.test(slug)) return json(200, { available: false, reason: 'Use 3–48 lower-case letters, numbers and dashes.' });
        if (RESERVED_SLUGS.has(slug)) return json(200, { available: false, reason: 'That address is reserved.' });
        const formId = Number(body.formId || '') || 0;
        const [taken] = await db.select({ id: audienceForms.id }).from(audienceForms)
            .where(and(sql`lower(${audienceForms.slug}) = ${slug}`, formId ? ne(audienceForms.id, formId) : sql`true`)).limit(1);
        return json(200, taken ? { available: false, reason: 'That address is already taken.' } : { available: true });
    }

    if (action === 'create') {
        // With a definition (the form builder, or a chat card's Save) or without (the old "new form"
        // button, which gets the defaults). Either way the row is born with a definition.
        const prepared = await prepareDefinition(db, orgId,
            body.definition ?? { name: String(body.name || 'Website sign-up') },
            { strictSlug: !!body.strictSlug });
        if ('error' in prepared) return json(prepared.status, { error: prepared.error });
        const assistantId = Number(body.assistantId || '') || null;
        await ensureCustomFields(db, orgId, prepared.definition, ctx.userId);
        const [form] = await db.insert(audienceForms).values({
            organisationId: orgId,
            publicKey: newPublicKey(),
            ...columnsFromDefinition(prepared.definition),
            // A form saved from a CHAT card is born switched off: the person publishes it from the
            // builder, having seen it. The builder's own "new form" is born live.
            status: body.status === 'disabled' ? 'disabled' : 'active',
            assistantId,
            createdBy: ctx.userId,
        }).returning();
        return json(200, { form, warnings: prepared.warnings });
    }

    const id = Number(body.id || '');
    if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid form.' });

    const [existing] = await db.select()
        .from(audienceForms)
        .where(and(eq(audienceForms.id, id), eq(audienceForms.organisationId, orgId)))
        .limit(1);
    if (!existing) return json(404, { error: 'Form not found.' });

    // The form builder's save: the whole definition, every time.
    if (action === 'save') {
        const prepared = await prepareDefinition(db, orgId, body.definition, { formId: id, strictSlug: true });
        if ('error' in prepared) return json(prepared.status, { error: prepared.error });
        await ensureCustomFields(db, orgId, prepared.definition, ctx.userId);
        const [form] = await db.update(audienceForms)
            .set({ ...columnsFromDefinition(prepared.definition), ...(body.status === 'disabled' || body.status === 'active' ? { status: body.status } : {}), updatedAt: new Date() })
            .where(and(eq(audienceForms.id, id), eq(audienceForms.organisationId, orgId)))
            .returning();
        return json(200, { form, warnings: prepared.warnings });
    }

    if (action === 'rotate') {
        const [form] = await db.update(audienceForms)
            .set({ publicKey: newPublicKey(), updatedAt: new Date() })
            .where(and(eq(audienceForms.id, id), eq(audienceForms.organisationId, orgId)))
            .returning({ publicKey: audienceForms.publicKey });
        // Say it plainly: the snippet already on their site is now dead until they re-paste it.
        return json(200, { publicKey: form.publicKey, snippetMustBeReplaced: true });
    }

    if (action === 'delete') {
        await db.update(audienceForms)
            .set({ status: 'disabled', updatedAt: new Date() })
            .where(and(eq(audienceForms.id, id), eq(audienceForms.organisationId, orgId)));
        return json(200, { disabled: true });
    }

    if (action === 'update') {
        const patch: Record<string, unknown> = { updatedAt: new Date() };

        if ('name' in body) patch.name = String(body.name || '').trim().slice(0, 80) || 'Website sign-up';
        if ('doubleOptIn' in body) patch.doubleOptIn = body.doubleOptIn !== false;
        if ('status' in body) patch.status = body.status === 'disabled' ? 'disabled' : 'active';
        if ('fields' in body) patch.fields = sanitiseFields(body.fields);
        if ('consentText' in body) patch.consentText = String(body.consentText || '').trim().slice(0, 500) || DEFAULT_CONSENT_TEXT;
        if ('successMessage' in body) patch.successMessage = String(body.successMessage || '').trim().slice(0, 300) || DEFAULT_SUCCESS_MESSAGE;

        // The hosted page. ⚠️ Switching it on is what makes /s/<key> answer AND what lets that page
        // past allowed_origins — so it is an explicit field rather than something inferred from a
        // headline being filled in.
        if ('hostedEnabled' in body) patch.hostedEnabled = body.hostedEnabled === true;
        if ('hostedHeadline' in body) patch.hostedHeadline = String(body.hostedHeadline || '').trim().slice(0, 120) || null;
        if ('hostedIntro' in body) patch.hostedIntro = String(body.hostedIntro || '').trim().slice(0, 600) || null;

        if ('redirectUrl' in body) {
            const url = validateRedirectUrl(body.redirectUrl);
            if (body.redirectUrl && !url) return json(400, { error: 'The redirect must be a full http(s) URL.' });
            patch.redirectUrl = url;
        }

        if ('theme' in body) {
            const theme = validateFormTheme(body.theme);
            if ('error' in theme) return json(400, { error: theme.error });
            // ⚠️ Stored WHOLESALE, like the blog widget's theme — a partial object deletes the keys
            // it omits. Clients must send the complete theme, not a patch.
            patch.theme = theme.theme;
        }

        if ('segmentId' in body) {
            const segId = Number(body.segmentId || '');
            if (Number.isFinite(segId) && segId) {
                const [seg] = await db.select({ id: audienceSegments.id }).from(audienceSegments)
                    .where(and(eq(audienceSegments.id, segId), eq(audienceSegments.organisationId, orgId))).limit(1);
                if (!seg) return json(404, { error: 'Segment not found.' });
                patch.segmentId = segId;
            } else {
                patch.segmentId = null;
            }
        }

        if ('allowedOrigins' in body) {
            // null = any origin; [] = nothing allowed. Both are legitimate and they are NOT the
            // same — see originAllowed(). An unparseable entry is rejected rather than dropped,
            // because a silently-discarded origin looks like a working allowlist that is not.
            if (body.allowedOrigins === null) {
                patch.allowedOrigins = null;
            } else if (Array.isArray(body.allowedOrigins)) {
                const list = body.allowedOrigins.slice(0, MAX_ORIGINS).map((o: unknown) => normaliseOrigin(String(o ?? '')));
                if (list.some((o: string | null) => o === null)) {
                    return json(400, { error: 'Each allowed website must be a full address, e.g. https://example.com' });
                }
                patch.allowedOrigins = [...new Set(list as string[])];
            } else {
                return json(400, { error: 'allowedOrigins must be a list of website addresses, or null for any.' });
            }
        }

        // ⚠️ The definition is the source of truth, so the old settings panel's edits are folded into
        // it rather than written beside it — otherwise the next builder save would silently undo them.
        const merged = { ...existing, ...patch } as typeof existing;
        const base: FormDefinition = existing.definition
            ? normaliseFormDefinition(existing.definition).definition
            : legacyToDefinition(existing);
        const fromCols = legacyToDefinition(merged);
        const next = {
            ...base,
            name: fromCols.name,
            content: { ...base.content, headline: fromCols.content.headline, intro: fromCols.content.intro,
                buttonLabel: fromCols.content.buttonLabel, successMessage: fromCols.content.successMessage, redirectUrl: fromCols.content.redirectUrl },
            consent: { ...base.consent, text: fromCols.consent.text },
            style: 'theme' in patch ? { ...base.style, accent: fromCols.style.accent, layout: fromCols.style.layout, useBrandKit: fromCols.style.useBrandKit } : base.style,
            fields: 'fields' in patch ? mergeLegacyFields(base, fromCols) : base.fields,
            delivery: { embed: { ...base.delivery.embed, allowedOrigins: fromCols.delivery.embed.allowedOrigins },
                hosted: { ...base.delivery.hosted, enabled: fromCols.delivery.hosted.enabled } },
            audience: { ...base.audience, doubleOptIn: fromCols.audience.doubleOptIn, segmentId: fromCols.audience.segmentId },
        };
        const def = normaliseFormDefinition(next).definition;
        const [form] = await db.update(audienceForms).set({ ...patch, ...columnsFromDefinition(def) })
            .where(and(eq(audienceForms.id, id), eq(audienceForms.organisationId, orgId)))
            .returning();
        return json(200, { form });
    }

    return json(400, { error: `Unknown action: ${action}` });
});

/**
 * The old panel's field checkboxes (email / first name / last name / company) applied to a definition
 * that may also hold builder-made questions: the contact-column fields follow the checkboxes, and
 * every other question is kept exactly where it was.
 */
function mergeLegacyFields(base: FormDefinition, fromCols: FormDefinition) {
    const wanted = new Set(fromCols.fields.filter((f) => f.target.kind === 'contact').map((f) => (f.target as { column: string }).column));
    const kept = base.fields.filter((f) => f.target.kind !== 'contact' || wanted.has((f.target as { column: string }).column));
    const have = new Set(kept.filter((f) => f.target.kind === 'contact').map((f) => (f.target as { column: string }).column));
    const added = fromCols.fields.filter((f) => f.target.kind === 'contact' && !have.has((f.target as { column: string }).column));
    return [...kept, ...added];
}
