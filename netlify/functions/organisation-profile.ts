// organisation-profile.ts
// GET  → returns the org's business profile (business name + assistant-facing context)
// POST → updates the business profile on the organisation
//
// Business name maps to organisations.name (also set at registration). Legal/tax/
// registered-address details are NOT here — they live in billingInformation
// (see billing-information.ts), surfaced on the same Business Information page.

import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations, users } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { businessDomainOf } from '../../src/utils/email-domain';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const clip = (v: unknown, max: number): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, max) : null;
};

// The caller's email (for deriving their business domain when the org has none stored yet).
async function callerEmail(db: ReturnType<typeof getDb>, userId: number): Promise<string | null> {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    return u?.email ?? null;
}

// Future-proof set of social platforms whose handles/URLs are captured on Business
// Information. Only a subset are connectable today (see integrations.js catalogue);
// the rest are accepted now so the handle is ready the moment a connector ships.
const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'x', 'tiktok', 'youtube', 'pinterest', 'threads'];

// Sanitise the per-platform handles object: keep only known slugs, trim, cap length,
// drop blanks. Returns null when nothing usable was supplied.
const cleanHandles = (v: unknown): Record<string, string> | null => {
    if (!v || typeof v !== 'object') return null;
    const src = v as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const p of SOCIAL_PLATFORMS) {
        const raw = src[p];
        const s = typeof raw === 'string' ? raw.trim().slice(0, 300) : '';
        if (s) out[p] = s;
    }
    return Object.keys(out).length ? out : null;
};

export const handler: Handler = async (event) => {
    if (!['GET', 'POST'].includes(event.httpMethod || '')) return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    if (event.httpMethod === 'GET') {
        try {
            const [org] = await db.select({
                businessName:        organisations.name,
                industry:            organisations.industry,
                businessDescription: organisations.businessDescription,
                websiteUrl:          organisations.websiteUrl,
                socialLinks:         organisations.socialLinks,
                socialHandles:       organisations.socialHandles,
                targetAudience:      organisations.targetAudience,
                businessDomain:      organisations.businessDomain,
                allowDomainJoin:     organisations.allowDomainJoin,
            }).from(organisations).where(eq(organisations.id, orgId)).limit(1);

            // #2 domain-join: surface the effective domain (stored, or derived from the
            // caller's business email) + whether the caller may manage the setting.
            const canManageDomainJoin = ctx.role === 'owner' || ctx.role === 'admin';
            const effectiveDomain = org?.businessDomain || businessDomainOf(await callerEmail(db, ctx.userId));

            return json(200, { profile: org ? { ...org, effectiveDomain, canManageDomainJoin } : null });
        } catch (err) {
            console.error('[organisation-profile GET]', err);
            return json(500, { error: 'Failed to load business profile.' });
        }
    }

    // POST
    try {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(event.body || '{}'); } catch { /* empty */ }

        // #2: domain-join toggle (owner/admin only). Handled standalone so the UI can send
        // just { allowDomainJoin } without re-submitting the whole business profile.
        if ('allowDomainJoin' in body) {
            if (ctx.role !== 'owner' && ctx.role !== 'admin') {
                return json(403, { error: 'Only an owner or admin can change this setting.' });
            }
            const enable = body.allowDomainJoin === true;
            if (enable) {
                // Must have a business (non-public) domain to enable. Use the stored one, else
                // derive from the caller's email. Enabling = owner attestation → set verified too.
                const [org] = await db.select({ businessDomain: organisations.businessDomain })
                    .from(organisations).where(eq(organisations.id, orgId)).limit(1);
                const domain = org?.businessDomain || businessDomainOf(await callerEmail(db, ctx.userId));
                if (!domain) {
                    return json(400, { error: 'Domain join needs a business email address — public providers (gmail, outlook, …) are not eligible.', code: 'NO_BUSINESS_DOMAIN' });
                }
                await db.update(organisations)
                    .set({ businessDomain: domain, domainVerified: true, allowDomainJoin: true, updatedAt: new Date() })
                    .where(eq(organisations.id, orgId));
                return json(200, { success: true, allowDomainJoin: true, businessDomain: domain });
            }
            await db.update(organisations)
                .set({ allowDomainJoin: false, updatedAt: new Date() })
                .where(eq(organisations.id, orgId));
            return json(200, { success: true, allowDomainJoin: false });
        }

        const businessName = clip(body.businessName, 200);
        if (!businessName) return json(400, { error: 'Business name is required.' });

        const values = {
            name:                businessName,
            industry:            clip(body.industry, 120),
            businessDescription: clip(body.businessDescription, 2000),
            websiteUrl:          clip(body.websiteUrl, 500),
            socialLinks:         clip(body.socialLinks, 1000),
            socialHandles:       cleanHandles(body.socialHandles),
            targetAudience:      clip(body.targetAudience, 1000),
            updatedAt:           new Date(),
        };

        const [saved] = await db.update(organisations)
            .set(values).where(eq(organisations.id, orgId))
            .returning({
                businessName:        organisations.name,
                industry:            organisations.industry,
                businessDescription: organisations.businessDescription,
                websiteUrl:          organisations.websiteUrl,
                socialLinks:         organisations.socialLinks,
                socialHandles:       organisations.socialHandles,
                targetAudience:      organisations.targetAudience,
            });

        return json(200, { success: true, profile: saved });
    } catch (err) {
        console.error('[organisation-profile POST]', err);
        return json(500, { error: 'Failed to save business profile.' });
    }
};
