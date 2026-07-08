// netlify/functions/agency-attribution.ts
// US-AUD-5.3.1: Manage agency attribution opt-in setting + public powered-by lookup
import { HandlerEvent } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { organisations, users, plans, masterPlans, referralAttribution, userOrganisations } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

// ── Helper: resolve authenticated user + their org ─────────────────────────
async function resolveUser(event: HandlerEvent): Promise<{ userId: number; orgId: number | null } | null> {
    if (!jwtSecret) return null;
    const rawCookies = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookies.split(';').map(c => {
            const [k, ...v] = c.trim().split('=');
            return [k, decodeURIComponent(v.join('='))];
        }).filter(([k]) => k !== '')
    );
    const sessionToken = cookies['aura_session'];
    if (!sessionToken) return null;
    try {
        const decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
        const db = getDb();
        const [user] = await db
            .select({ id: users.id, organisationId: userOrganisations.organisationId })
            .from(users)
            .leftJoin(userOrganisations, eq(users.id, userOrganisations.userId))
            .where(eq(users.id, decoded.userId));
        return user ? { userId: user.id, orgId: user.organisationId ?? null } : null;
    } catch {
        return null;
    }
}

// ── Helper: check if org is on Tier 2+ (SC7) ──────────────────────────────
async function isAgencyEligible(orgId: number): Promise<boolean> {
    const db = getDb();
    try {
        const [plan] = await db
            .select({ monthlyPriceGbp: masterPlans.monthlyPriceGbp })
            .from(plans)
            .innerJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
            .where(and(eq(plans.organisationId, orgId), eq(plans.status, 'active')))
            .limit(1);
        if (!plan) return false;
        // Tier 2+ = any plan that isn't the cheapest solo plan
        const [cheapest] = await db
            .select({ monthlyPriceGbp: masterPlans.monthlyPriceGbp })
            .from(masterPlans)
            .where(eq(masterPlans.isActive, true))
            .orderBy(masterPlans.monthlyPriceGbp)
            .limit(1);
        const cheapestPrice = cheapest?.monthlyPriceGbp ? parseFloat(String(cheapest.monthlyPriceGbp)) : 0;
        const orgPrice = parseFloat(String(plan.monthlyPriceGbp));
        return orgPrice > cheapestPrice;
    } catch {
        return false;
    }
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    const path = event.path || '';

    // ── Public GET: /agency-attribution?slug=<slug> → powered-by lookup ──────
    // Used by powered-by.html to fetch co-branded org data
    if (event.httpMethod === 'GET' && event.queryStringParameters?.slug) {
        const slug = event.queryStringParameters.slug.trim();
        try {
            const [org] = await db
                .select({ id: organisations.id, name: organisations.name, slug: organisations.slug, enabled: organisations.agencyAttributionEnabled })
                .from(organisations)
                .where(eq(organisations.slug, slug))
                .limit(1);
            if (!org || !org.enabled) {
                return { statusCode: 404, body: JSON.stringify({ error: 'Attribution page not found.' }) };
            }
            return {
                statusCode: 200,
                body: JSON.stringify({ name: org.name, slug: org.slug }),
            };
        } catch (err) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load attribution page.' }) };
        }
    }

    // ── Auth required for all other routes ────────────────────────────────────
    const auth = await resolveUser(event);
    if (!auth) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }
    const { userId, orgId } = auth;
    if (!orgId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No organisation found for this account.' }) };
    }

    // ── GET: Return current attribution setting ────────────────────────────────
    if (event.httpMethod === 'GET') {
        try {
            const eligible = await isAgencyEligible(orgId);
            const [org] = await db
                .select({ slug: organisations.slug, agencyAttributionEnabled: organisations.agencyAttributionEnabled })
                .from(organisations)
                .where(eq(organisations.id, orgId));
            return {
                statusCode: 200,
                body: JSON.stringify({
                    agencyAttributionEnabled: org?.agencyAttributionEnabled ?? false,
                    slug: org?.slug ?? null,
                    eligible,
                }),
            };
        } catch {
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch attribution setting.' }) };
        }
    }

    // ── PATCH: Toggle attribution on/off ──────────────────────────────────────
    if (event.httpMethod === 'PATCH') {
        try {
            // SC7: Tier gate
            const eligible = await isAgencyEligible(orgId);
            if (!eligible) {
                return { statusCode: 403, body: JSON.stringify({ error: 'Agency attribution requires a Tier 2 or higher plan.' }) };
            }
            const body = JSON.parse(event.body || '{}');
            const enabled = Boolean(body.enabled);
            await db
                .update(organisations)
                .set({ agencyAttributionEnabled: enabled, updatedAt: new Date() })
                .where(eq(organisations.id, orgId));
            return { statusCode: 200, body: JSON.stringify({ success: true, agencyAttributionEnabled: enabled }) };
        } catch {
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update attribution setting.' }) };
        }
    }

    // ── POST: Record referral attribution (called during signup) ──────────────
    // Body: { orgSlug } — the referring agency slug from the attribution link
    if (event.httpMethod === 'POST') {
        try {
            const body = JSON.parse(event.body || '{}');
            const { orgSlug } = body;
            if (!orgSlug) return { statusCode: 400, body: JSON.stringify({ error: 'orgSlug required.' }) };

            const [referrerOrg] = await db
                .select({ id: organisations.id })
                .from(organisations)
                .where(and(eq(organisations.slug, orgSlug), eq(organisations.agencyAttributionEnabled, true)))
                .limit(1);
            if (!referrerOrg) {
                return { statusCode: 404, body: JSON.stringify({ error: 'Referrer organisation not found.' }) };
            }

            // SC5: Record referral attribution
            await db.insert(referralAttribution).values({
                referrerOrgId: referrerOrg.id,
                newUserId: userId,
                sourceType: 'agency_badge',
            });

            // SC5: in-app notification to referrer org members (owners/admins) — best-effort
            // (Full in-app notification system is a separate epic; this stores the record)

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        } catch {
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to record referral.' }) };
        }
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
});
