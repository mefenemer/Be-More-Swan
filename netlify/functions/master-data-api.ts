// netlify/functions/master-data-api.ts
// US-ADM-1.7.1: Master Data Management — platform reference data CRUD via Admin Portal
//
// All endpoints require admin or super_admin role (aura_session cookie).
// All write operations append a row to admin_audit_log.
//
// Supported resources (via ?resource= query param):
//   master-plans        GET (list) | POST (create) | PATCH ?id=N (update) | DELETE ?id=N
//   plan-prices         GET ?planId=N | POST | PATCH ?id=N | DELETE ?id=N
//   master-assistants   GET (list) | POST | PATCH ?id=N (update fields; systemPrompt → new version)
//   assistant-versions  GET ?assistantId=N | POST (create new version for assistant)
//   feature-flags       GET | POST | PATCH ?key=K | DELETE ?key=K
//   platform-config     GET | POST (upsert) ?key=K | DELETE ?key=K
//
// Business rules:
//   - masterPlan edits do NOT retroactively change existing subscribers' plans.
//   - systemPrompt PATCH on master-assistants creates a new assistantVersions row and
//     updates masterAssistants.currentVersionId.
//   - featureFlag rollout is evaluated via murmurhash32(workspaceId + flagKey) % 100.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq, and, desc } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import {
    users,
    masterPlans,
    planPrices,
    masterAssistants,
    assistantVersions,
    featureFlags,
    platformConfig,
    supportedLanguages,
} from '../../db/schema';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { isAdminRole } from '../../src/utils/rbac';

const jwtSecret = process.env.JWT_SECRET;

// Stripe client for admin-driven product/price creation (US1.1/US1.2). Same init as stripe-webhook.ts.
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;

// Inline murmurhash3 32-bit (no external dependency)
function murmurhash32(str: string, seed = 0): number {
    let h = seed;
    for (let i = 0; i < str.length; i++) {
        let k = str.charCodeAt(i);
        k = Math.imul(k, 0xcc9e2d51);
        k = (k << 15) | (k >>> 17);
        k = Math.imul(k, 0x1b873593);
        h ^= k;
        h = (h << 13) | (h >>> 19);
        h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    }
    h ^= str.length;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0; // unsigned 32-bit
}

/** Returns true if this workspaceId should be included in the rollout percentage. */
export function isInRollout(workspaceId: number, flagKey: string, rolloutPct: number): boolean {
    if (rolloutPct <= 0) return false;
    if (rolloutPct >= 100) return true;
    return murmurhash32(`${workspaceId}${flagKey}`) % 100 < rolloutPct;
}

async function requireAdmin(event: any): Promise<{ adminId: number; role: string } | null> {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try {
        userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return null;
    }
    const db = getDb();
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !isAdminRole(row.role)) return null;
    return { adminId: userId, role: row.role };
}

function unauth() { return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) }; }
function forbidden(msg = 'Forbidden.') { return { statusCode: 403, body: JSON.stringify({ error: msg }) }; }
function badRequest(msg: string) { return { statusCode: 400, body: JSON.stringify({ error: msg }) }; }
function notFound() { return { statusCode: 404, body: JSON.stringify({ error: 'Not found.' }) }; }

// ─────────────────────────────────────────────────────────────────────────────
// Resource handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleMasterPlans(event: any, adminId: number, role: string, ip?: string, ua?: string) {
    const db = getDb();
    const method = event.httpMethod;
    const id = event.queryStringParameters?.id ? Number(event.queryStringParameters.id) : null;

    if (method === 'GET') {
        const rows = await db.select().from(masterPlans).orderBy(masterPlans.monthlyPriceGbp);
        return { statusCode: 200, body: JSON.stringify(rows) };
    }

    if (method === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { tierKey, name, monthlyPriceGbp, assistantLimit, monthlyTaskLimit, monthlyTokenLimit, appConnectionLimit, seatLimit, features } = body;
        const interval = body.interval === 'year' ? 'year' : 'month'; // AC1.1.1 billing cycle
        if (!tierKey || !name || !monthlyPriceGbp) return badRequest('tierKey, name, monthlyPriceGbp required.');

        // Insert the plan first so we have an id; then push to Stripe. If Stripe fails, roll the row back
        // so the DB and Stripe never diverge (AC1.1.4).
        const [row] = await db.insert(masterPlans).values({
            tierKey, name, monthlyPriceGbp, assistantLimit, monthlyTaskLimit, monthlyTokenLimit, appConnectionLimit, seatLimit,
            features: features ?? {},
        }).returning();

        try {
            if (stripe) {
                // AC1.1.2: create the Stripe Product + recurring Price.
                const product = await stripe.products.create({ name, metadata: { tierKey } });
                const price = await stripe.prices.create({
                    product: product.id,
                    unit_amount: Math.round(Number(monthlyPriceGbp) * 100),
                    currency: 'gbp',
                    recurring: { interval },
                });
                // AC1.1.3: store the returned ids — product on the plan, price on the GBP plan_prices row.
                await db.update(masterPlans).set({ stripeProductId: product.id }).where(eq(masterPlans.id, row.id));
                await db.insert(planPrices).values({
                    masterPlanId: row.id, currency: 'GBP', monthlyPriceMajorUnit: monthlyPriceGbp, stripePriceId: price.id,
                }).onConflictDoUpdate({ target: [planPrices.masterPlanId, planPrices.currency], set: { stripePriceId: price.id, monthlyPriceMajorUnit: monthlyPriceGbp } });
                row.stripeProductId = product.id;
            }
        } catch (err: any) {
            // AC1.1.4: roll back so we don't leave an orphan DB plan with no Stripe billing.
            await db.delete(masterPlans).where(eq(masterPlans.id, row.id)).catch(() => {});
            console.error('[master-data] Stripe push failed, rolled back plan:', err?.message);
            return { statusCode: 502, body: JSON.stringify({ error: `Stripe sync failed — plan not created: ${err?.message || 'unknown error'}` }) };
        }

        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'master_plan', targetId: row.id, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_create' });
        return { statusCode: 201, body: JSON.stringify(row) };
    }

    if (method === 'PATCH') {
        if (!id) return badRequest('id required.');
        const body = JSON.parse(event.body || '{}');
        const { name, monthlyPriceGbp, assistantLimit, monthlyTaskLimit, monthlyTokenLimit, appConnectionLimit, seatLimit, isActive, features } = body;
        const [prev] = await db.select().from(masterPlans).where(eq(masterPlans.id, id)).limit(1);
        if (!prev) return notFound();

        const updates: any = {};
        if (name !== undefined) updates.name = name;
        if (monthlyPriceGbp !== undefined) updates.monthlyPriceGbp = monthlyPriceGbp;
        if (assistantLimit !== undefined) updates.assistantLimit = assistantLimit;
        if (monthlyTaskLimit !== undefined) updates.monthlyTaskLimit = monthlyTaskLimit;
        if (monthlyTokenLimit !== undefined) updates.monthlyTokenLimit = monthlyTokenLimit;
        if (appConnectionLimit !== undefined) updates.appConnectionLimit = appConnectionLimit;
        if (seatLimit !== undefined) updates.seatLimit = seatLimit;
        if (isActive !== undefined) updates.isActive = isActive;
        if (features !== undefined) updates.features = features;

        // Stripe sync runs BEFORE the DB write so a failure leaves the DB unchanged.
        const priceChanged = monthlyPriceGbp !== undefined && Number(monthlyPriceGbp) !== Number(prev.monthlyPriceGbp);
        const archiving = isActive === false && prev.isActive === true;
        let newStripePriceId: string | null = null;
        try {
            if (stripe && prev.stripeProductId) {
                if (priceChanged) {
                    // AC1.2.2: mint a NEW price, archive the OLD one — never overwrite (legacy subs keep billing on it).
                    const [gbpPrice] = await db.select().from(planPrices)
                        .where(and(eq(planPrices.masterPlanId, id), eq(planPrices.currency, 'GBP'))).limit(1);
                    const newPrice = await stripe.prices.create({
                        product: prev.stripeProductId,
                        unit_amount: Math.round(Number(monthlyPriceGbp) * 100),
                        currency: 'gbp',
                        recurring: { interval: 'month' },
                    });
                    if (gbpPrice?.stripePriceId) await stripe.prices.update(gbpPrice.stripePriceId, { active: false }).catch(() => {});
                    newStripePriceId = newPrice.id;
                }
                if (archiving) {
                    // AC1.2.1: deactivate the plan's Stripe prices so no new sign-ups can use them.
                    const prices = await db.select().from(planPrices).where(eq(planPrices.masterPlanId, id));
                    for (const p of prices) {
                        if (p.stripePriceId) await stripe.prices.update(p.stripePriceId, { active: false }).catch(() => {});
                    }
                }
            }
        } catch (err: any) {
            console.error('[master-data] Stripe sync failed on plan update:', err?.message);
            return { statusCode: 502, body: JSON.stringify({ error: `Stripe sync failed — no changes saved: ${err?.message || 'unknown error'}` }) };
        }

        const [row] = await db.update(masterPlans).set(updates).where(eq(masterPlans.id, id)).returning();

        // Point the GBP price row at the freshly minted Stripe price (and mark the old DB row inactive).
        if (newStripePriceId) {
            await db.update(planPrices)
                .set({ stripePriceId: newStripePriceId, monthlyPriceMajorUnit: monthlyPriceGbp })
                .where(and(eq(planPrices.masterPlanId, id), eq(planPrices.currency, 'GBP')));
        }
        if (archiving) {
            await db.update(planPrices).set({ isActive: false }).where(eq(planPrices.masterPlanId, id));
        }

        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'master_plan', targetId: id, previousState: prev, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_update' });
        return { statusCode: 200, body: JSON.stringify(row) };
    }

    if (method === 'DELETE') {
        if (role !== 'super_admin') return forbidden('super_admin required to delete master plans.');
        if (!id) return badRequest('id required.');
        const [prev] = await db.select().from(masterPlans).where(eq(masterPlans.id, id)).limit(1);
        if (!prev) return notFound();
        await db.delete(masterPlans).where(eq(masterPlans.id, id));
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'master_plan', targetId: id, previousState: prev, ipAddress: ip, userAgent: ua, reason: 'admin_delete' });
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
}

async function handlePlanPrices(event: any, adminId: number, role: string, ip?: string, ua?: string) {
    const db = getDb();
    const method = event.httpMethod;
    const id = event.queryStringParameters?.id ? Number(event.queryStringParameters.id) : null;
    const planId = event.queryStringParameters?.planId ? Number(event.queryStringParameters.planId) : null;

    if (method === 'GET') {
        const rows = planId
            ? await db.select().from(planPrices).where(eq(planPrices.masterPlanId, planId))
            : await db.select().from(planPrices).orderBy(planPrices.masterPlanId);
        return { statusCode: 200, body: JSON.stringify(rows) };
    }

    if (method === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { masterPlanId, currency, monthlyPriceMajorUnit, stripePriceId } = body;
        if (!masterPlanId || !currency || !monthlyPriceMajorUnit) return badRequest('masterPlanId, currency, monthlyPriceMajorUnit required.');
        const [row] = await db.insert(planPrices).values({ masterPlanId, currency: currency.toUpperCase(), monthlyPriceMajorUnit, stripePriceId }).returning();
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'plan_price', targetId: row.id, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_create' });
        return { statusCode: 201, body: JSON.stringify(row) };
    }

    if (method === 'PATCH') {
        if (!id) return badRequest('id required.');
        const body = JSON.parse(event.body || '{}');
        const [prev] = await db.select().from(planPrices).where(eq(planPrices.id, id)).limit(1);
        if (!prev) return notFound();
        const updates: any = {};
        if (body.monthlyPriceMajorUnit !== undefined) updates.monthlyPriceMajorUnit = body.monthlyPriceMajorUnit;
        if (body.stripePriceId !== undefined) updates.stripePriceId = body.stripePriceId;
        if (body.isActive !== undefined) updates.isActive = body.isActive;
        const [row] = await db.update(planPrices).set(updates).where(eq(planPrices.id, id)).returning();
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'plan_price', targetId: id, previousState: prev, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_update' });
        return { statusCode: 200, body: JSON.stringify(row) };
    }

    if (method === 'DELETE') {
        if (!id) return badRequest('id required.');
        const [prev] = await db.select().from(planPrices).where(eq(planPrices.id, id)).limit(1);
        if (!prev) return notFound();
        await db.delete(planPrices).where(eq(planPrices.id, id));
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'plan_price', targetId: id, previousState: prev, ipAddress: ip, userAgent: ua, reason: 'admin_delete' });
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
}

async function handleMasterAssistants(event: any, adminId: number, ip?: string, ua?: string) {
    const db = getDb();
    const method = event.httpMethod;
    const id = event.queryStringParameters?.id ? Number(event.queryStringParameters.id) : null;

    if (method === 'GET') {
        const rows = await db.select().from(masterAssistants).orderBy(masterAssistants.name);
        return { statusCode: 200, body: JSON.stringify(rows) };
    }

    if (method === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { roleKey, name, description, category, iconKey, iconColor, systemPrompt } = body;
        if (!roleKey || !name) return badRequest('roleKey, name required.');

        const [assistant] = await db.insert(masterAssistants).values({
            roleKey, name, description, category: category || 'Administration',
            iconKey: iconKey || 'document', iconColor: iconColor || 'blue',
        }).returning();

        // Create initial version if systemPrompt provided
        if (systemPrompt) {
            const [version] = await db.insert(assistantVersions).values({
                assistantId: assistant.id, versionNumber: 1, systemPrompt,
                changeNote: 'Initial version', createdBy: adminId,
            }).returning();
            await db.update(masterAssistants).set(withUpdatedAt({ currentVersionId: version.id })).where(eq(masterAssistants.id, assistant.id));
        }

        void insertAdminAuditLog({ adminId, action: 'assistant_state_change', targetType: 'master_assistant', targetId: assistant.id, newState: { ...assistant, systemPromptProvided: !!systemPrompt }, ipAddress: ip, userAgent: ua, reason: 'admin_create' });
        return { statusCode: 201, body: JSON.stringify(assistant) };
    }

    if (method === 'PATCH') {
        if (!id) return badRequest('id required.');
        const body = JSON.parse(event.body || '{}');
        const [prev] = await db.select().from(masterAssistants).where(eq(masterAssistants.id, id)).limit(1);
        if (!prev) return notFound();

        const { systemPrompt, ...otherFields } = body;
        const updates: any = {};
        const allowed = ['name', 'description', 'category', 'iconKey', 'iconColor', 'comingSoon', 'isActive', 'lifecycleState', 'riskClassification', 'milestoneTasksRequired', 'specialCategoryClauseEnabled', 'replacementAssistantId'];
        for (const key of allowed) {
            if (otherFields[key] !== undefined) updates[key] = otherFields[key];
        }
        updates.updatedAt = new Date();

        // systemPrompt edit always creates a new immutable version row
        if (systemPrompt !== undefined) {
            const [lastVersion] = await db
                .select({ versionNumber: assistantVersions.versionNumber })
                .from(assistantVersions)
                .where(eq(assistantVersions.assistantId, id))
                .orderBy(desc(assistantVersions.versionNumber))
                .limit(1);
            const nextVersionNumber = (lastVersion?.versionNumber ?? 0) + 1;
            const [version] = await db.insert(assistantVersions).values({
                assistantId: id,
                versionNumber: nextVersionNumber,
                systemPrompt,
                changeNote: otherFields.changeNote || 'Admin update',
                createdBy: adminId,
            }).returning();
            updates.currentVersionId = version.id;
        }

        const [row] = await db.update(masterAssistants).set(updates).where(eq(masterAssistants.id, id)).returning();
        void insertAdminAuditLog({ adminId, action: 'assistant_state_change', targetType: 'master_assistant', targetId: id, previousState: prev, newState: { ...row, newVersionCreated: systemPrompt !== undefined }, ipAddress: ip, userAgent: ua, reason: 'admin_update' });
        return { statusCode: 200, body: JSON.stringify(row) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
}

async function handleAssistantVersions(event: any, adminId: number, ip?: string, ua?: string) {
    const db = getDb();
    const method = event.httpMethod;
    const assistantId = event.queryStringParameters?.assistantId ? Number(event.queryStringParameters.assistantId) : null;

    if (method === 'GET') {
        const rows = assistantId
            ? await db.select().from(assistantVersions).where(eq(assistantVersions.assistantId, assistantId)).orderBy(desc(assistantVersions.versionNumber))
            : await db.select().from(assistantVersions).orderBy(desc(assistantVersions.versionNumber)).limit(200);
        return { statusCode: 200, body: JSON.stringify(rows) };
    }

    if (method === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { assistantId: aid, systemPrompt, config } = body;
        if (!aid) return badRequest('assistantId required.');
        const [lastVersion] = await db
            .select({ versionNumber: assistantVersions.versionNumber })
            .from(assistantVersions)
            .where(eq(assistantVersions.assistantId, aid))
            .orderBy(desc(assistantVersions.versionNumber))
            .limit(1);
        const nextVersionNumber = (lastVersion?.versionNumber ?? 0) + 1;
        const [version] = await db.insert(assistantVersions).values({
            assistantId: aid, versionNumber: nextVersionNumber, systemPrompt, config,
            changeNote: body.changeNote || 'Admin version', createdBy: adminId,
        }).returning();
        await db.update(masterAssistants).set({ currentVersionId: version.id, updatedAt: new Date() }).where(eq(masterAssistants.id, aid));
        void insertAdminAuditLog({ adminId, action: 'assistant_state_change', targetType: 'assistant_version', targetId: version.id, newState: version, ipAddress: ip, userAgent: ua, reason: 'new_version' });
        return { statusCode: 201, body: JSON.stringify(version) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
}

async function handleFeatureFlags(event: any, adminId: number, role: string, ip?: string, ua?: string) {
    const db = getDb();
    const method = event.httpMethod;
    const key = event.queryStringParameters?.key;

    if (method === 'GET') {
        const rows = await db.select().from(featureFlags);
        return { statusCode: 200, body: JSON.stringify(rows) };
    }

    if (method === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { key: k, description, rolloutPercentage, enabled } = body;
        if (!k) return badRequest('key required.');
        const [row] = await db.insert(featureFlags).values({
            key: k,
            description,
            enabled: enabled ?? false,
            rolloutPercentage: rolloutPercentage ?? 0,
            updatedBy: adminId,
        }).returning();
        void insertAdminAuditLog({ adminId, action: 'feature_flag_toggle', targetType: 'feature_flag', targetId: k, newState: row, ipAddress: ip, userAgent: ua });
        return { statusCode: 201, body: JSON.stringify(row) };
    }

    if (method === 'PATCH') {
        if (!key) return badRequest('key required.');
        const body = JSON.parse(event.body || '{}');
        const [prev] = await db.select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
        if (!prev) return notFound();
        const updates: any = { updatedBy: adminId, updatedAt: new Date() };
        if (body.enabled !== undefined) updates.enabled = body.enabled;
        if (body.rolloutPercentage !== undefined) {
            const pct = Number(body.rolloutPercentage);
            if (isNaN(pct) || pct < 0 || pct > 100) return badRequest('rolloutPercentage must be 0–100.');
            updates.rolloutPercentage = pct;
        }
        if (body.allowedWorkspaceIds !== undefined) updates.allowedWorkspaceIds = body.allowedWorkspaceIds;
        if (body.allowedTiers !== undefined) updates.allowedTiers = body.allowedTiers;
        if (body.description !== undefined) updates.description = body.description;
        const [row] = await db.update(featureFlags).set(updates).where(eq(featureFlags.key, key)).returning();
        void insertAdminAuditLog({ adminId, action: 'feature_flag_toggle', targetType: 'feature_flag', targetId: key, previousState: prev, newState: row, ipAddress: ip, userAgent: ua });
        return { statusCode: 200, body: JSON.stringify(row) };
    }

    if (method === 'DELETE') {
        if (role !== 'super_admin') return forbidden('super_admin required to delete feature flags.');
        if (!key) return badRequest('key required.');
        const [prev] = await db.select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
        if (!prev) return notFound();
        await db.delete(featureFlags).where(eq(featureFlags.key, key));
        void insertAdminAuditLog({ adminId, action: 'feature_flag_toggle', targetType: 'feature_flag', targetId: key, previousState: prev, ipAddress: ip, userAgent: ua });
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
}

async function handlePlatformConfig(event: any, adminId: number, ip?: string, ua?: string) {
    const db = getDb();
    const method = event.httpMethod;
    const key = event.queryStringParameters?.key;

    if (method === 'GET') {
        const rows = key
            ? await db.select().from(platformConfig).where(eq(platformConfig.key, key))
            : await db.select().from(platformConfig);
        return { statusCode: 200, body: JSON.stringify(rows) };
    }

    if (method === 'POST') {
        // Upsert by key
        const body = JSON.parse(event.body || '{}');
        const { key: k, value, reason } = body;
        if (!k || value === undefined) return badRequest('key and value required.');
        const [prev] = await db.select().from(platformConfig).where(eq(platformConfig.key, k)).limit(1);
        const [row] = await db
            .insert(platformConfig)
            .values({ key: k, value, updatedBy: adminId, reason })
            .onConflictDoUpdate({ target: platformConfig.key, set: { value, updatedBy: adminId, updatedAt: new Date(), reason } })
            .returning();
        void insertAdminAuditLog({ adminId, action: 'kill_switch_toggle', targetType: 'platform_config', targetId: k, previousState: prev ?? null, newState: row, reason, ipAddress: ip, userAgent: ua });
        return { statusCode: 200, body: JSON.stringify(row) };
    }

    if (method === 'DELETE') {
        if (!key) return badRequest('key required.');
        const [prev] = await db.select().from(platformConfig).where(eq(platformConfig.key, key)).limit(1);
        if (!prev) return notFound();
        await db.delete(platformConfig).where(eq(platformConfig.key, key));
        void insertAdminAuditLog({ adminId, action: 'kill_switch_toggle', targetType: 'platform_config', targetId: key, previousState: prev, ipAddress: ip, userAgent: ua });
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
}

// ── Supported Languages ────────────────────────────────────────────────────────

async function handleSupportedLanguages(event: any, adminId: number, ip?: string, ua?: string) {
    const db = getDb();
    const method = event.httpMethod;

    if (method === 'GET') {
        const rows = await db.select().from(supportedLanguages).orderBy(supportedLanguages.sortOrder);
        return { statusCode: 200, body: JSON.stringify(rows) };
    }

    if (method === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { code, name, nativeName, isActive, sortOrder } = body;
        if (!code || !name) return badRequest('code and name required.');
        const [row] = await db.insert(supportedLanguages).values({ code, name, nativeName, isActive: isActive ?? true, sortOrder: sortOrder ?? 0 }).returning();
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'supported_language', targetId: code, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_create' });
        return { statusCode: 201, body: JSON.stringify(row) };
    }

    if (method === 'PATCH') {
        const code = event.queryStringParameters?.code;
        if (!code) return badRequest('code required.');
        const body = JSON.parse(event.body || '{}');
        const updates: Partial<typeof supportedLanguages.$inferInsert> = {};
        if (body.name       !== undefined) updates.name       = body.name;
        if (body.nativeName !== undefined) updates.nativeName = body.nativeName;
        if (body.isActive   !== undefined) updates.isActive   = body.isActive;
        if (body.sortOrder  !== undefined) updates.sortOrder  = body.sortOrder;
        const [row] = await db.update(supportedLanguages).set(updates).where(eq(supportedLanguages.code, code)).returning();
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'supported_language', targetId: code, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_update' });
        return { statusCode: 200, body: JSON.stringify(row) };
    }

    if (method === 'DELETE') {
        const code = event.queryStringParameters?.code;
        if (!code) return badRequest('code required.');
        await db.delete(supportedLanguages).where(eq(supportedLanguages.code, code));
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'supported_language', targetId: code, ipAddress: ip, userAgent: ua, reason: 'admin_delete' });
        return { statusCode: 200, body: JSON.stringify({ deleted: true }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export const handler: Handler = async (event) => {
    const auth = await requireAdmin(event);
    if (!auth) return unauth();

    const resource = event.queryStringParameters?.resource;
    const ip = getAdminIp(event.headers);
    const ua = event.headers['user-agent'] || undefined;
    const { adminId, role } = auth;

    switch (resource) {
        case 'master-plans':       return handleMasterPlans(event, adminId, role, ip, ua);
        case 'plan-prices':        return handlePlanPrices(event, adminId, role, ip, ua);
        case 'master-assistants':  return handleMasterAssistants(event, adminId, ip, ua);
        case 'assistant-versions': return handleAssistantVersions(event, adminId, ip, ua);
        case 'feature-flags':        return handleFeatureFlags(event, adminId, role, ip, ua);
        case 'platform-config':      return handlePlatformConfig(event, adminId, ip, ua);
        case 'supported-languages':  return handleSupportedLanguages(event, adminId, ip, ua);
        default:
            return { statusCode: 400, body: JSON.stringify({ error: 'resource param required: master-plans | plan-prices | master-assistants | assistant-versions | feature-flags | platform-config | supported-languages' }) };
    }
};
