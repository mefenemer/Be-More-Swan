// netlify/functions/booking-settings.ts
// Business Information ▸ Opening hours & bookings. Workspace-wide: the business's opening hours and
// booking rules, and who or what can be booked. docs/booking-plan.md.
//
//   GET                          → { exists, settings, resources, services }
//   PUT    { ...settings }       → { settings }   only the fields sent change (booking-settings.ts)
//   POST   { name, kind, … }     → { resource }   add someone / something that can be booked
//   PATCH  { id, ... }           → { resource }   edit, archive / restore (status), reorder (sortOrder)
//   DELETE ?id=N                 → { ok: true }   remove for good (past bookings keep its name)
//
// Services are NOT here: they are Business Information products with a length (org-products.ts).
// Tenant-scoped on every statement.

import { and, asc, eq, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { bookableResources, bookingSettings } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { cleanBookingSettings, cleanResource } from '../../src/utils/booking-settings';
import { loadBookingSetup } from '../../src/utils/bookings';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const MAX_RESOURCES = 100;

export default withLambda(async (event) => {
    const method = event.httpMethod || '';
    if (!['GET', 'PUT', 'POST', 'PATCH', 'DELETE'].includes(method)) return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    try {
        if (method === 'GET') {
            const setup = await loadBookingSetup(db, orgId);
            const resources = await db.select().from(bookableResources).where(eq(bookableResources.organisationId, orgId))
                .orderBy(asc(bookableResources.sortOrder), asc(bookableResources.id));
            return json(200, { exists: setup.exists, settings: setup.settings, resources, services: setup.services });
        }

        let body: Record<string, unknown> = {};
        if (method !== 'DELETE') {
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Invalid body.' });
        }

        if (method === 'PUT') {
            const r = cleanBookingSettings(body);
            if (!r.ok) return json(400, { error: r.error });
            const values = { ...r.value, updatedAt: new Date() };
            const [row] = await db.insert(bookingSettings).values({ organisationId: orgId, ...values })
                .onConflictDoUpdate({ target: bookingSettings.organisationId, set: values }).returning();
            return json(200, { settings: row });
        }

        if (method === 'POST') {
            const r = cleanResource(body, false);
            if (!r.ok) return json(400, { error: r.error });
            const [{ n, maxOrder }] = await db.select({ n: sql<number>`count(*)::int`, maxOrder: sql<number>`coalesce(max(${bookableResources.sortOrder}), -1)::int` })
                .from(bookableResources).where(eq(bookableResources.organisationId, orgId));
            if (n >= MAX_RESOURCES) return json(409, { error: `Up to ${MAX_RESOURCES} can be added.` });
            const [resource] = await db.insert(bookableResources).values({ ...(r.value as { name: string }), organisationId: orgId, sortOrder: maxOrder + 1 }).returning();
            return json(201, { resource });
        }

        if (method === 'PATCH') {
            const id = Number(body.id);
            if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
            const r = cleanResource(body, true);
            if (!r.ok) return json(400, { error: r.error });
            const extra: Record<string, unknown> = {};
            if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
                const so = Number(body.sortOrder);
                if (!Number.isInteger(so) || so < 0 || so > 100_000) return json(400, { error: 'Invalid order.' });
                extra.sortOrder = so;
            }
            const values = { ...r.value, ...extra };
            if (!Object.keys(values).length) return json(400, { error: 'Nothing to change.' });
            const [resource] = await db.update(bookableResources).set({ ...values, updatedAt: new Date() })
                .where(and(eq(bookableResources.id, id), eq(bookableResources.organisationId, orgId))).returning();
            return resource ? json(200, { resource }) : json(404, { error: 'Not found.' });
        }

        const id = Number(event.queryStringParameters?.id);
        if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
        const gone = await db.delete(bookableResources).where(and(eq(bookableResources.id, id), eq(bookableResources.organisationId, orgId))).returning({ id: bookableResources.id });
        return gone.length ? json(200, { ok: true }) : json(404, { error: 'Not found.' });
    } catch (err) {
        console.error('[booking-settings]', method, err);
        return json(500, { error: 'That couldn\'t be saved right now. Please try again.' });
    }
});
