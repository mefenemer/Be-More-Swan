// netlify/functions/master-data-api.ts
// US-ADM-1.7.1: Master Data Management — platform reference data CRUD via Admin Portal
//
// All endpoints require admin or super_admin role (aura_session cookie).
// All write operations append a row to admin_audit_log.
//
// Supported resources (via ?resource= query param):
//   master-plans        GET (list) | POST (create) | PATCH ?id=N (update) | DELETE ?id=N
//   plan-prices         GET ?planId=N | POST | PATCH ?id=N | DELETE ?id=N
//   plan-price-change   POST { planId, newPriceGbp, effectiveFrom? } — single-source price change
//                       (immediate or scheduled); writes dated plan_price_history + syncs Stripe.
//   plan-price-history  GET ?planId=N — dated price audit trail (newest first)
//   master-assistants   GET (list) | POST | PATCH ?id=N (update fields; systemPrompt → new version)
//   assistant-versions  GET ?assistantId=N | POST (create new version for assistant)
//   assistant-feature-defs   GET | POST | PATCH ?id=N | DELETE ?id=N — capability catalog (metadata)
//   assistant-feature-values GET | PATCH { updates[] } — the per-assistant capability matrix
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
import { eq, and, desc, asc, ne, inArray, isNull } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import {
    users,
    masterPlans,
    planPrices,
    planPriceHistory,
    planFeatures,
    plans,
    masterAssistants,
    assistantVersions,
    assistantFeatureDefs,
    assistantFeatures,
    featureFlags,
    platformConfig,
    supportedLanguages,
} from '../../db/schema';
import { applyPlanPrice } from '../../src/utils/plan-pricing';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { isAdminRole, requirePermission } from '../../src/utils/rbac';
import { withLambda } from '@netlify/aws-lambda-compat';

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
        const { tierKey, name, monthlyPriceGbp, assistantLimit, monthlyTaskLimit, monthlyTokenLimit, appConnectionLimit, seatLimit, features,
            tierDescription, description, isMostPopular } = body;
        const interval = body.interval === 'year' ? 'year' : 'month'; // AC1.1.1 billing cycle
        if (!tierKey || !name || !monthlyPriceGbp) return badRequest('tierKey, name, monthlyPriceGbp required.');

        // Insert the plan first so we have an id; then push to Stripe. If Stripe fails, roll the row back
        // so the DB and Stripe never diverge (AC1.1.4).
        const [row] = await db.insert(masterPlans).values({
            tierKey, name, monthlyPriceGbp, assistantLimit, monthlyTaskLimit, monthlyTokenLimit, appConnectionLimit, seatLimit,
            features: features ?? {},
            tierDescription: tierDescription || null,
            description: description || null,
            isMostPopular: !!isMostPopular,
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

        // At most one plan may hold the "Most Popular" pill — clear it on every other plan.
        // Runs only after the Stripe push succeeds so a rollback can't strand the previous flag.
        if (isMostPopular) {
            await db.update(masterPlans).set({ isMostPopular: false }).where(ne(masterPlans.id, row.id));
        }

        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'master_plan', targetId: row.id, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_create' });
        return { statusCode: 201, body: JSON.stringify(row) };
    }

    if (method === 'PATCH') {
        if (!id) return badRequest('id required.');
        const body = JSON.parse(event.body || '{}');
        const { name, monthlyPriceGbp, assistantLimit, monthlyTaskLimit, monthlyTokenLimit, appConnectionLimit, seatLimit, isActive, features,
            tierDescription, description, isMostPopular } = body;
        const [prev] = await db.select().from(masterPlans).where(eq(masterPlans.id, id)).limit(1);
        if (!prev) return notFound();

        // Price changes go through the shared applyPlanPrice() helper (mints a new Stripe price,
        // archives the old, writes dated plan_price_history) — see handlePlanPriceChange for the
        // scheduling-aware entry point. Here we keep the plain Edit modal working: an inline price
        // edit applies immediately. monthly_price_gbp is written by the helper, not in `updates`.
        const updates: any = {};
        if (name !== undefined) updates.name = name;
        if (assistantLimit !== undefined) updates.assistantLimit = assistantLimit;
        if (monthlyTaskLimit !== undefined) updates.monthlyTaskLimit = monthlyTaskLimit;
        if (monthlyTokenLimit !== undefined) updates.monthlyTokenLimit = monthlyTokenLimit;
        if (appConnectionLimit !== undefined) updates.appConnectionLimit = appConnectionLimit;
        if (seatLimit !== undefined) updates.seatLimit = seatLimit;
        if (isActive !== undefined) updates.isActive = isActive;
        if (features !== undefined) updates.features = features;
        if (tierDescription !== undefined) updates.tierDescription = tierDescription || null;
        if (description !== undefined) updates.description = description || null;
        if (isMostPopular !== undefined) updates.isMostPopular = !!isMostPopular;

        const priceChanged = monthlyPriceGbp !== undefined && Number(monthlyPriceGbp) !== Number(prev.monthlyPriceGbp);
        const archiving = isActive === false && prev.isActive === true;

        // Stripe sync runs BEFORE the DB write so a failure leaves the DB unchanged.
        try {
            if (priceChanged) {
                // Immediate change: seed a history row then promote it live (DB + Stripe) via the helper.
                const [histRow] = await db.insert(planPriceHistory).values({
                    masterPlanId: id, currency: 'GBP', monthlyPriceMajorUnit: String(monthlyPriceGbp),
                    effectiveFrom: new Date(), status: 'active', createdBy: adminId,
                }).returning();
                await applyPlanPrice(db, stripe, {
                    plan: { id, tierKey: prev.tierKey, stripeProductId: prev.stripeProductId },
                    currency: 'GBP', newPriceGbp: monthlyPriceGbp, historyRowId: histRow.id,
                });
            }
            if (archiving && stripe && prev.stripeProductId) {
                // AC1.2.1: deactivate the plan's Stripe prices so no new sign-ups can use them.
                const prices = await db.select().from(planPrices).where(eq(planPrices.masterPlanId, id));
                for (const p of prices) {
                    if (p.stripePriceId) await stripe.prices.update(p.stripePriceId, { active: false }).catch(() => {});
                }
            }
        } catch (err: any) {
            console.error('[master-data] Stripe sync failed on plan update:', err?.message);
            return { statusCode: 502, body: JSON.stringify({ error: `Stripe sync failed — no changes saved: ${err?.message || 'unknown error'}` }) };
        }

        const [row] = Object.keys(updates).length
            ? await db.update(masterPlans).set(updates).where(eq(masterPlans.id, id)).returning()
            : await db.select().from(masterPlans).where(eq(masterPlans.id, id)).limit(1);

        if (archiving) {
            await db.update(planPrices).set({ isActive: false }).where(eq(planPrices.masterPlanId, id));
        }

        // At most one plan may hold the "Most Popular" pill — clear it on every other plan.
        if (updates.isMostPopular === true) {
            await db.update(masterPlans).set({ isMostPopular: false }).where(ne(masterPlans.id, id));
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

// ── Plan price change + history (single-source price management) ──────────────
// POST plan-price-change { planId, newPriceGbp, effectiveFrom? } — immediate or scheduled.
// GET  plan-price-history ?planId=N — dated audit trail (newest first).

async function handlePlanPriceChange(event: any, adminId: number, ip?: string, ua?: string) {
    const db = getDb();
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const body = JSON.parse(event.body || '{}');
    const planId = Number(body.planId);
    const newPriceGbp = Number(body.newPriceGbp);
    if (!planId || !Number.isFinite(newPriceGbp) || newPriceGbp <= 0) {
        return badRequest('planId and a positive newPriceGbp are required.');
    }

    const [plan] = await db.select().from(masterPlans).where(eq(masterPlans.id, planId)).limit(1);
    if (!plan) return notFound();

    // Blank / past effectiveFrom → apply now; a future timestamp → schedule it.
    const now = new Date();
    let effectiveFrom = now;
    if (body.effectiveFrom) {
        const parsed = new Date(body.effectiveFrom);
        if (isNaN(parsed.getTime())) return badRequest('effectiveFrom is not a valid date.');
        effectiveFrom = parsed;
    }
    const scheduled = effectiveFrom.getTime() > now.getTime() + 30_000; // >30s out = future

    if (scheduled) {
        // One pending change at a time per plan+currency — replace any existing scheduled row.
        await db.delete(planPriceHistory).where(and(
            eq(planPriceHistory.masterPlanId, planId),
            eq(planPriceHistory.currency, 'GBP'),
            eq(planPriceHistory.status, 'scheduled'),
        ));
        const [row] = await db.insert(planPriceHistory).values({
            masterPlanId: planId, currency: 'GBP', monthlyPriceMajorUnit: String(newPriceGbp),
            effectiveFrom, status: 'scheduled', createdBy: adminId,
        }).returning();
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'plan_price', targetId: row.id, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_update' });
        return { statusCode: 201, body: JSON.stringify({ scheduled: true, row }) };
    }

    // Immediate: seed a history row then promote it live (DB + Stripe) via the shared helper.
    const [histRow] = await db.insert(planPriceHistory).values({
        masterPlanId: planId, currency: 'GBP', monthlyPriceMajorUnit: String(newPriceGbp),
        effectiveFrom: now, status: 'active', createdBy: adminId,
    }).returning();
    try {
        await applyPlanPrice(db, stripe, {
            plan: { id: planId, tierKey: plan.tierKey, stripeProductId: plan.stripeProductId },
            currency: 'GBP', newPriceGbp, historyRowId: histRow.id,
        });
    } catch (err: any) {
        // Roll the just-inserted history row back so a Stripe failure leaves no orphan.
        await db.delete(planPriceHistory).where(eq(planPriceHistory.id, histRow.id)).catch(() => {});
        console.error('[master-data] plan-price-change Stripe sync failed:', err?.message);
        return { statusCode: 502, body: JSON.stringify({ error: `Stripe sync failed — price not changed: ${err?.message || 'unknown error'}` }) };
    }
    void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'plan_price', targetId: histRow.id, newState: { planId, newPriceGbp }, ipAddress: ip, userAgent: ua, reason: 'admin_update' });
    return { statusCode: 200, body: JSON.stringify({ scheduled: false, planId, newPriceGbp }) };
}

async function handlePlanPriceHistory(event: any) {
    const db = getDb();
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    const planId = event.queryStringParameters?.planId ? Number(event.queryStringParameters.planId) : null;
    const rows = planId
        ? await db.select().from(planPriceHistory).where(eq(planPriceHistory.masterPlanId, planId)).orderBy(desc(planPriceHistory.effectiveFrom))
        : await db.select().from(planPriceHistory).orderBy(desc(planPriceHistory.effectiveFrom)).limit(200);
    return { statusCode: 200, body: JSON.stringify(rows) };
}

// ── Master Assistants ───────────────────────────────────────────────────────────
// master_assistants is the single source of truth for assistant copy. The detail page used to read
// src/config/assistant-role-content.js instead, which re-declared these fields and drifted; the copy
// columns below (tagline/keyFeatures/integrations/video) replaced it. See db/assistant-content.sql.

/**
 * Normalise a list field (keyFeatures / integrations / worksWith) from the admin form.
 * The textarea posts one item per line; the API also accepts a JSON array. Blank lines are dropped.
 */
function normaliseStringList(raw: unknown): string[] | null {
    const items = typeof raw === 'string' ? raw.split('\n')
        : Array.isArray(raw) ? raw
        : null;
    if (!items) return null;
    return items.map(i => String(i).trim()).filter(Boolean);
}

/** Normalise the video slot. A blank url is kept as null so the modal renders its placeholder. */
function normaliseVideo(raw: unknown): { url: string | null; title: string; poster?: string } | null {
    if (raw == null || raw === '') return null;
    if (typeof raw !== 'object') return null;
    const v = raw as Record<string, unknown>;
    const url = typeof v.url === 'string' && v.url.trim() ? v.url.trim() : null;
    const title = typeof v.title === 'string' ? v.title.trim() : '';
    const poster = typeof v.poster === 'string' && v.poster.trim() ? v.poster.trim() : undefined;
    if (!url && !title && !poster) return null;   // fully blank = no video slot at all
    return poster ? { url, title, poster } : { url, title };
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
        const { roleKey, name, description, category, iconKey, iconColor, tagline, systemPrompt } = body;
        if (!roleKey || !name) return badRequest('roleKey, name required.');

        const [assistant] = await db.insert(masterAssistants).values({
            roleKey, name, description, category: category || 'Administration',
            iconKey: iconKey || 'document', iconColor: iconColor || 'blue',
            tagline: tagline || null,
            keyFeatures: normaliseStringList(body.keyFeatures) ?? [],
            integrations: normaliseStringList(body.integrations) ?? [],
            worksWith: normaliseStringList(body.worksWith) ?? [],
            video: normaliseVideo(body.video),
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
        // roleKey is deliberately absent: it's the join key across ai_assistants.configuration->>'type',
        // the cron role lists and the onboarding schemas, so renaming it would strand hired assistants.
        // It's set once at create and read-only thereafter (the form disables it on edit).
        const allowed = ['name', 'description', 'tagline', 'category', 'iconKey', 'iconColor', 'comingSoon', 'isActive', 'lifecycleState', 'riskClassification', 'milestoneTasksRequired', 'specialCategoryClauseEnabled', 'replacementAssistantId'];
        for (const key of allowed) {
            if (otherFields[key] !== undefined) updates[key] = otherFields[key];
        }

        // List/object copy fields need normalising rather than a straight copy.
        // worksWith entries are 'standalone' or another role_key — deliberately NOT validated
        // against master_assistants here: an unknown entry renders verbatim (see
        // AssistantContent.resolveWorksWith), so a typo degrades to a plain pill instead of
        // rejecting the whole save. See db/assistant-works-with.sql for the vocabulary.
        for (const key of ['keyFeatures', 'integrations', 'worksWith']) {
            if (otherFields[key] === undefined) continue;
            const list = normaliseStringList(otherFields[key]);
            if (!list) return badRequest(`${key} must be an array of strings or a newline-separated string.`);
            updates[key] = list;
        }
        if (otherFields.video !== undefined) updates.video = normaliseVideo(otherFields.video);

        updates.updatedAt = new Date();

        // systemPrompt edit always creates a new immutable version row. The form's textarea is never
        // populated from assistant_versions, so it posts '' on every unrelated save — guard on
        // non-empty or each copy edit would mint a spurious empty version.
        if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
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
        void insertAdminAuditLog({ adminId, action: 'assistant_state_change', targetType: 'master_assistant', targetId: id, previousState: prev, newState: { ...row, newVersionCreated: updates.currentVersionId !== undefined }, ipAddress: ip, userAgent: ua, reason: 'admin_update' });
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

// ── Plan Features (DB-driven pricing feature catalog + per-plan value editor) ────
// Hybrid storage: the catalog (plan_features) is metadata only. Values live in master_plans —
// capacity as typed columns, everything else in the features jsonb. A change can be applied
// retroactively (edit master_plans, clear snapshots) or to NEW subscribers only (freeze existing
// subscribers in plans.feature_overrides first, then edit master_plans).

// Only these master_plans columns may be written via a 'column'-storage feature (guards against
// arbitrary column writes coming from a catalog row's column_name).
const PLAN_LIMIT_COLUMNS = new Set([
    'assistantLimit', 'monthlyTaskLimit', 'monthlyTokenLimit',
    'appConnectionLimit', 'seatLimit', 'storageLimitBytes',
]);

/** Coerce an admin-supplied cell value to the storage type declared by the feature definition. */
function coerceFeatureValue(valueType: string, raw: unknown): unknown {
    if (valueType === 'boolean') return raw === true || raw === 'true';
    if (valueType === 'number') {
        if (raw === '' || raw === null || raw === undefined) return null;      // blank = unlimited
        if (typeof raw === 'string' && raw.trim().toLowerCase() === 'unlimited') return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    }
    return raw == null ? null : String(raw);                                    // text
}

/** Build the frozen snapshot for a subscription from a master plan's current live values. */
function snapshotFromMasterPlan(mp: typeof masterPlans.$inferSelect) {
    return {
        assistantLimit: mp.assistantLimit,
        monthlyTaskLimit: mp.monthlyTaskLimit,
        monthlyTokenLimit: mp.monthlyTokenLimit,
        appConnectionLimit: mp.appConnectionLimit,
        seatLimit: mp.seatLimit,
        storageLimitBytes: mp.storageLimitBytes,
        features: (mp.features as Record<string, unknown>) ?? {},
    };
}

async function handlePlanFeatureDefs(event: any, adminId: number, role: string, ip?: string, ua?: string) {
    const db = getDb();
    const method = event.httpMethod;
    const id = event.queryStringParameters?.id ? Number(event.queryStringParameters.id) : null;

    if (method === 'GET') {
        const rows = await db.select().from(planFeatures).orderBy(asc(planFeatures.category), asc(planFeatures.displayOrder));
        return { statusCode: 200, body: JSON.stringify(rows) };
    }

    if (method === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { key, label, category } = body;
        if (!key || !label || !category) return badRequest('key, label, category required.');
        const [row] = await db.insert(planFeatures).values({
            key, label, category,
            description: body.description ?? null,
            valueType: body.valueType ?? 'boolean',
            storageTarget: body.storageTarget ?? 'feature',
            columnName: body.columnName ?? null,
            unlimitedLabel: body.unlimitedLabel ?? null,
            enterpriseValue: body.enterpriseValue ?? null,
            displayOrder: body.displayOrder ?? 0,
            isEnabled: body.isEnabled ?? true,
        }).returning();
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'plan_feature', targetId: row.id, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_create' });
        return { statusCode: 201, body: JSON.stringify(row) };
    }

    if (method === 'PATCH') {
        if (!id) return badRequest('id required.');
        const body = JSON.parse(event.body || '{}');
        const [prev] = await db.select().from(planFeatures).where(eq(planFeatures.id, id)).limit(1);
        if (!prev) return notFound();
        const updates: any = { updatedAt: new Date() };
        for (const k of ['label', 'description', 'category', 'valueType', 'storageTarget', 'columnName', 'unlimitedLabel', 'enterpriseValue', 'displayOrder', 'isEnabled']) {
            if (body[k] !== undefined) updates[k] = body[k];
        }
        const [row] = await db.update(planFeatures).set(updates).where(eq(planFeatures.id, id)).returning();
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'plan_feature', targetId: id, previousState: prev, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_update' });
        return { statusCode: 200, body: JSON.stringify(row) };
    }

    if (method === 'DELETE') {
        if (role !== 'super_admin') return forbidden('super_admin required to delete plan features.');
        if (!id) return badRequest('id required.');
        const [prev] = await db.select().from(planFeatures).where(eq(planFeatures.id, id)).limit(1);
        if (!prev) return notFound();
        await db.delete(planFeatures).where(eq(planFeatures.id, id));
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'plan_feature', targetId: id, previousState: prev, ipAddress: ip, userAgent: ua, reason: 'admin_delete' });
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
}

async function handlePlanFeatureValues(event: any, adminId: number, ip?: string, ua?: string) {
    const db = getDb();
    const method = event.httpMethod;

    // Column definitions (metadata) shared by GET (rendering) and PATCH (write routing).
    const defs = await db.select().from(planFeatures).orderBy(asc(planFeatures.category), asc(planFeatures.displayOrder));
    // Editable plan columns = active, non-trial master plans ordered by price (mirrors pricing.html).
    const planRows = await db.select().from(masterPlans)
        .where(and(eq(masterPlans.isActive, true), ne(masterPlans.tierKey, 'trial')))
        .orderBy(asc(masterPlans.monthlyPriceGbp));

    const readValue = (mp: typeof masterPlans.$inferSelect, def: typeof planFeatures.$inferSelect) => {
        if (def.storageTarget === 'column' && def.columnName) return (mp as any)[def.columnName] ?? null;
        return ((mp.features as Record<string, unknown>) ?? {})[def.key] ?? null;
    };

    if (method === 'GET') {
        const values: Record<number, Record<string, unknown>> = {};
        for (const mp of planRows) {
            values[mp.id] = {};
            for (const def of defs) values[mp.id][def.key] = readValue(mp, def);
        }
        return { statusCode: 200, body: JSON.stringify({
            features: defs,
            plans: planRows.map(p => ({ id: p.id, tierKey: p.tierKey, name: p.name, monthlyPriceGbp: p.monthlyPriceGbp })),
            values,
        }) };
    }

    if (method === 'PATCH') {
        const body = JSON.parse(event.body || '{}');
        const applyMode = body.applyMode === 'new' ? 'new' : body.applyMode === 'retroactive' ? 'retroactive' : null;
        const updates: Array<{ planId: number; key: string; value: unknown }> = Array.isArray(body.updates) ? body.updates : [];
        if (!applyMode) return badRequest("applyMode must be 'new' or 'retroactive'.");
        if (!updates.length) return badRequest('updates[] required.');

        const defByKey = new Map(defs.map(d => [d.key, d]));
        const planById = new Map(planRows.map(p => [p.id, p]));
        // Group updates per plan.
        const byPlan = new Map<number, Array<{ def: typeof planFeatures.$inferSelect; value: unknown }>>();
        for (const u of updates) {
            const def = defByKey.get(u.key);
            const plan = planById.get(Number(u.planId));
            if (!def || !plan) return badRequest(`Unknown plan or feature in update: plan ${u.planId}, key ${u.key}.`);
            if (def.storageTarget === 'column' && !PLAN_LIMIT_COLUMNS.has(def.columnName || '')) {
                return badRequest(`Feature '${def.key}' has an invalid column mapping.`);
            }
            if (!byPlan.has(plan.id)) byPlan.set(plan.id, []);
            byPlan.get(plan.id)!.push({ def, value: coerceFeatureValue(def.valueType, u.value) });
        }

        let affectedSubscribers = 0;
        for (const [planId, cells] of byPlan) {
            const mp = planById.get(planId)!;

            // 'new' → freeze the EXISTING cohort at the current (old) values BEFORE editing master_plans.
            // Only stamp subscribers that aren't already frozen (a prior new-only change wins).
            if (applyMode === 'new') {
                const snapshot = snapshotFromMasterPlan(mp);
                const frozen = await db.update(plans)
                    .set({ featureOverrides: snapshot, updatedAt: new Date() })
                    .where(and(
                        eq(plans.masterPlanId, planId),
                        inArray(plans.status, ['active', 'past_due']),
                        isNull(plans.featureOverrides), // don't re-freeze an already-frozen (older cohort) subscriber
                    ))
                    .returning({ id: plans.id });
                affectedSubscribers += frozen.length;
            }

            // Apply the new values to master_plans (column updates + features jsonb merge).
            const colUpdates: Record<string, unknown> = {};
            const featurePatch: Record<string, unknown> = { ...((mp.features as Record<string, unknown>) ?? {}) };
            for (const { def, value } of cells) {
                if (def.storageTarget === 'column' && def.columnName) colUpdates[def.columnName] = value;
                else featurePatch[def.key] = value;
            }
            const setObj: Record<string, unknown> = { ...colUpdates };
            if (cells.some(c => c.def.storageTarget !== 'column')) setObj.features = featurePatch;
            const [updatedPlan] = await db.update(masterPlans).set(setObj).where(eq(masterPlans.id, planId)).returning();

            // 'retroactive' → everyone reads live: clear any frozen snapshots for this plan.
            if (applyMode === 'retroactive') {
                await db.update(plans)
                    .set({ featureOverrides: null, updatedAt: new Date() })
                    .where(eq(plans.masterPlanId, planId));
            }

            void insertAdminAuditLog({
                adminId, action: 'record_delete', targetType: 'master_plan', targetId: planId,
                previousState: { features: mp.features }, newState: { applyMode, changes: cells.map(c => ({ key: c.def.key, value: c.value })), plan: updatedPlan },
                ipAddress: ip, userAgent: ua, reason: applyMode === 'new' ? 'admin_update' : 'admin_update',
            });
        }

        return { statusCode: 200, body: JSON.stringify({ ok: true, applied: updates.length, applyMode, affectedSubscribers }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
}

// ── Assistant Features (DB-driven capability catalog + per-assistant matrix) ─────
// Mirrors the Plan Features pair above: assistant_feature_defs is the catalog (metadata only),
// the VALUES live in assistant_features (one row per master_assistant × key; absent row = off).
// Replaces the hardcoded ASSISTANT_FEATURES list, so a new capability no longer needs a deploy.
// Unlike plan features there is no applyMode — capabilities have no subscriber cohort to freeze.

async function handleAssistantFeatureDefs(event: any, adminId: number, role: string, ip?: string, ua?: string) {
    const permErr = requirePermission(role, 'feature_flags');
    if (permErr) return permErr;

    const db = getDb();
    const method = event.httpMethod;
    const id = event.queryStringParameters?.id ? Number(event.queryStringParameters.id) : null;

    if (method === 'GET') {
        const rows = await db.select().from(assistantFeatureDefs)
            .orderBy(asc(assistantFeatureDefs.category), asc(assistantFeatureDefs.displayOrder));
        return { statusCode: 200, body: JSON.stringify(rows) };
    }

    if (method === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { key, label, category } = body;
        if (!key || !label || !category) return badRequest('key, label, category required.');
        const [row] = await db.insert(assistantFeatureDefs).values({
            key, label, category,
            description: body.description ?? null,
            displayOrder: body.displayOrder ?? 0,
            isEnabled: body.isEnabled ?? true,
        }).returning();
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'assistant_feature_def', targetId: row.id, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_create' });
        return { statusCode: 201, body: JSON.stringify(row) };
    }

    if (method === 'PATCH') {
        if (!id) return badRequest('id required.');
        const body = JSON.parse(event.body || '{}');
        const [prev] = await db.select().from(assistantFeatureDefs).where(eq(assistantFeatureDefs.id, id)).limit(1);
        if (!prev) return notFound();
        const updates: any = { updatedAt: new Date() };
        // `key` is omitted: it's the join key into assistant_features, so renaming it would orphan
        // every stored value. Delete and re-create instead.
        for (const k of ['label', 'description', 'category', 'displayOrder', 'isEnabled']) {
            if (body[k] !== undefined) updates[k] = body[k];
        }
        const [row] = await db.update(assistantFeatureDefs).set(updates).where(eq(assistantFeatureDefs.id, id)).returning();
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'assistant_feature_def', targetId: id, previousState: prev, newState: row, ipAddress: ip, userAgent: ua, reason: 'admin_update' });
        return { statusCode: 200, body: JSON.stringify(row) };
    }

    if (method === 'DELETE') {
        if (role !== 'super_admin') return forbidden('super_admin required to delete assistant features.');
        if (!id) return badRequest('id required.');
        const [prev] = await db.select().from(assistantFeatureDefs).where(eq(assistantFeatureDefs.id, id)).limit(1);
        if (!prev) return notFound();
        // Drop the stored values too — an orphaned assistant_features row would silently resurrect the
        // capability if the key were ever re-created.
        await db.delete(assistantFeatures).where(eq(assistantFeatures.featureKey, prev.key));
        await db.delete(assistantFeatureDefs).where(eq(assistantFeatureDefs.id, id));
        void insertAdminAuditLog({ adminId, action: 'record_delete', targetType: 'assistant_feature_def', targetId: id, previousState: prev, ipAddress: ip, userAgent: ua, reason: 'admin_delete' });
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
}

async function handleAssistantFeatureValues(event: any, adminId: number, role: string, ip?: string, ua?: string) {
    const permErr = requirePermission(role, 'feature_flags');
    if (permErr) return permErr;

    const db = getDb();
    const method = event.httpMethod;

    const defs = await db.select().from(assistantFeatureDefs)
        .orderBy(asc(assistantFeatureDefs.category), asc(assistantFeatureDefs.displayOrder));

    if (method === 'GET') {
        const assistants = await db.select({
            id: masterAssistants.id,
            name: masterAssistants.name,
            roleKey: masterAssistants.roleKey,
            lifecycleState: masterAssistants.lifecycleState,
        }).from(masterAssistants).where(eq(masterAssistants.isActive, true)).orderBy(masterAssistants.name);

        const rows = await db.select({
            masterAssistantId: assistantFeatures.masterAssistantId,
            featureKey: assistantFeatures.featureKey,
            enabled: assistantFeatures.enabled,
        }).from(assistantFeatures);

        const byAssistant = new Map<number, Record<string, boolean>>();
        for (const r of rows) {
            const m = byAssistant.get(r.masterAssistantId) || {};
            m[r.featureKey] = r.enabled;
            byAssistant.set(r.masterAssistantId, m);
        }

        // Absent row = disabled — backfill every known key so the UI renders a full grid.
        const values: Record<number, Record<string, boolean>> = {};
        for (const a of assistants) {
            values[a.id] = Object.fromEntries(defs.map(d => [d.key, byAssistant.get(a.id)?.[d.key] ?? false]));
        }

        return { statusCode: 200, body: JSON.stringify({ features: defs, assistants, values }) };
    }

    if (method === 'PATCH') {
        const body = JSON.parse(event.body || '{}');
        const updates: Array<{ assistantId: number; key: string; value: unknown }> = Array.isArray(body.updates) ? body.updates : [];
        if (!updates.length) return badRequest('updates[] required.');

        const defByKey = new Map(defs.map(d => [d.key, d]));
        for (const u of updates) {
            if (!defByKey.has(u.key)) return badRequest(`Unknown feature key: ${u.key}.`);
            if (!Number.isInteger(Number(u.assistantId))) return badRequest(`Invalid assistantId: ${u.assistantId}.`);
        }

        for (const u of updates) {
            const enabled = u.value === true || u.value === 'true';
            await db.insert(assistantFeatures)
                .values({ masterAssistantId: Number(u.assistantId), featureKey: u.key, enabled, updatedBy: adminId })
                .onConflictDoUpdate({
                    target: [assistantFeatures.masterAssistantId, assistantFeatures.featureKey],
                    set: { enabled, updatedBy: adminId, updatedAt: new Date() },
                });
        }

        void insertAdminAuditLog({
            adminId, action: 'record_delete', targetType: 'assistant_features', targetId: 0,
            newState: { changes: updates.map(u => ({ assistantId: u.assistantId, key: u.key, value: u.value === true || u.value === 'true' })) },
            ipAddress: ip, userAgent: ua, reason: 'admin_update',
        });

        return { statusCode: 200, body: JSON.stringify({ ok: true, applied: updates.length }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export default withLambda(async (event) => {
    const auth = await requireAdmin(event);
    if (!auth) return unauth();

    const resource = event.queryStringParameters?.resource;
    const ip = getAdminIp(event.headers);
    const ua = event.headers['user-agent'] || undefined;
    const { adminId, role } = auth;

    switch (resource) {
        case 'master-plans':       return handleMasterPlans(event, adminId, role, ip, ua);
        case 'plan-prices':        return handlePlanPrices(event, adminId, role, ip, ua);
        case 'plan-price-change':  return handlePlanPriceChange(event, adminId, ip, ua);
        case 'plan-price-history': return handlePlanPriceHistory(event);
        case 'plan-feature-defs':   return handlePlanFeatureDefs(event, adminId, role, ip, ua);
        case 'plan-feature-values': return handlePlanFeatureValues(event, adminId, ip, ua);
        case 'assistant-feature-defs':   return handleAssistantFeatureDefs(event, adminId, role, ip, ua);
        case 'assistant-feature-values': return handleAssistantFeatureValues(event, adminId, role, ip, ua);
        case 'master-assistants':  return handleMasterAssistants(event, adminId, ip, ua);
        case 'assistant-versions': return handleAssistantVersions(event, adminId, ip, ua);
        case 'feature-flags':        return handleFeatureFlags(event, adminId, role, ip, ua);
        case 'platform-config':      return handlePlatformConfig(event, adminId, ip, ua);
        case 'supported-languages':  return handleSupportedLanguages(event, adminId, ip, ua);
        default:
            return { statusCode: 400, body: JSON.stringify({ error: 'resource param required: master-plans | plan-prices | plan-price-change | plan-price-history | plan-feature-defs | plan-feature-values | master-assistants | assistant-versions | feature-flags | platform-config | supported-languages' }) };
    }
});
