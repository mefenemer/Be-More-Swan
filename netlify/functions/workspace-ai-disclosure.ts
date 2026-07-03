// netlify/functions/workspace-ai-disclosure.ts
// US-LEGAL-3.1: EU AI Act Art.50 — workspace AI disclosure footer settings
//
// GET  → returns { enabled, text, isEuJurisdiction }
// PATCH → updates { enabled, text }
//
// For EU-jurisdiction workspaces (Stripe billing country in EU), enabled defaults to true.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { users, organisations, plans, userOrganisations } from '../../db/schema';
import { and } from 'drizzle-orm';
import Stripe from 'stripe';
import { DISCLOSURE, isEuCountry } from '../../src/config/compliance';

const jwtSecret = process.env.JWT_SECRET;
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;

// Default disclosure copy + EU jurisdiction list live in src/config/compliance.ts (AC4.1).
const DEFAULT_FOOTER_TEXT = DISCLOSURE.workspaceFooterDefault;

async function getOrgBillingCountry(stripeCustomerId: string | null | undefined): Promise<string | null> {
    if (!stripe || !stripeCustomerId) return null;
    try {
        const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
        return customer.address?.country ?? null;
    } catch {
        return null;
    }
}

export const handler: Handler = async (event) => {
    if (!['GET', 'PATCH'].includes(event.httpMethod)) {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;
    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(token, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    const [user] = await db.select({
        organisationId: userOrganisations.organisationId,
    }).from(userOrganisations).where(eq(userOrganisations.userId, userId)).limit(1);

    if (!user?.organisationId) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Organisation not found.' }) };
    }

    const orgId = user.organisationId;

    if (event.httpMethod === 'GET') {
        const [org] = await db.select({
            aiDisclosureFooterEnabled: organisations.aiDisclosureFooterEnabled,
            aiDisclosureFooterText: organisations.aiDisclosureFooterText,
        }).from(organisations).where(eq(organisations.id, orgId)).limit(1);

        if (!org) return { statusCode: 404, body: JSON.stringify({ error: 'Organisation not found.' }) };

        // Check EU jurisdiction via Stripe billing country — query by org, not userId (userId nullable on org-level plans)
        const [plan] = await db.select({ stripeCustomerId: plans.stripeCustomerId })
            .from(plans)
            .where(and(eq(plans.organisationId, orgId), eq(plans.status, 'active')))
            .limit(1);

        const billingCountry = await getOrgBillingCountry(plan?.stripeCustomerId);
        const isEuJurisdiction = isEuCountry(billingCountry);

        // Auto-enable disclosure footer for EU orgs that haven't explicitly opted in yet
        if (isEuJurisdiction && !org.aiDisclosureFooterEnabled) {
            await db.update(organisations)
                .set(withUpdatedAt({ aiDisclosureFooterEnabled: true }))
                .where(eq(organisations.id, orgId));
            org.aiDisclosureFooterEnabled = true;
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                enabled: org.aiDisclosureFooterEnabled,
                text: org.aiDisclosureFooterText ?? DEFAULT_FOOTER_TEXT,
                isEuJurisdiction,
                defaultText: DEFAULT_FOOTER_TEXT,
            }),
        };
    }

    // PATCH — update settings
    let body: { enabled?: boolean; text?: string };
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const updates: Partial<typeof organisations.$inferInsert> = {};
    if (typeof body.enabled === 'boolean') updates.aiDisclosureFooterEnabled = body.enabled;
    if (typeof body.text === 'string') updates.aiDisclosureFooterText = body.text.slice(0, 500) || null;

    if (Object.keys(updates).length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No fields to update.' }) };
    }

    await db.update(organisations).set(withUpdatedAt(updates)).where(eq(organisations.id, orgId));

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
