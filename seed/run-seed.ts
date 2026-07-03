// seed/run-seed.ts
// Epic: Superadmin Environment Management — US5 (Master Data Seeding) + US6 (Source Control).
//
// Shared seed core used by BOTH the CLI (npm run db:seed) and the in-app
// sandbox-seed function. It:
//   1. Reads the version-controlled JSON in seed/data/
//   2. Validates every file against the Zod schemas (US6.2) BEFORE any insert
//   3. Upserts master/reference rows by NATURAL KEY (idempotent — safe to re-run)
//   4. Optionally syncs Stripe Products/Prices using the env's key (US5.3)
//
// Routing: this module uses the env-aware getDb()/getStripe(). Callers MUST set the
// AsyncLocalStorage context (runWithEnvironment) so it targets the right database +
// Stripe account. The CLI runner below sets it explicitly from an argv flag.

import * as fs from 'fs';
import * as path from 'path';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { getStripe, stripeKeyAvailable, STRIPE_API_VERSION } from '../src/utils/stripe';
import { masterPlans, planPrices, masterAssistants, platformConfig } from '../db/schema';
import {
    MasterPlansFile,
    PlanPricesFile,
    MasterAssistantsFile,
    BenchmarksFile,
} from './schemas';

const DATA_DIR = path.resolve(__dirname, 'data');

function readJson(file: string): unknown {
    const full = path.join(DATA_DIR, file);
    return JSON.parse(fs.readFileSync(full, 'utf8'));
}

export interface SeedResult {
    plans: number;
    prices: number;
    assistants: number;
    benchmarks: number;
    stripeProducts: number;
    stripePrices: number;
    stripeSynced: boolean;
}

export interface SeedOptions {
    /** Sync Stripe Products/Prices for the active env's key (US5.3). Default: true. */
    syncStripe?: boolean;
    /** Optional logger; defaults to console.log. */
    log?: (msg: string) => void;
    /** users.id to stamp on platform_config audit columns. */
    actorId?: number | null;
}

/**
 * Run the master-data seed against the database for the ACTIVE environment context.
 * Validates all JSON first (throws ZodError with a readable path on a bad file).
 */
export async function runSeed(opts: SeedOptions = {}): Promise<SeedResult> {
    const log = opts.log ?? ((m: string) => console.log(m));
    const actorId = opts.actorId ?? null;
    const syncStripe = opts.syncStripe ?? true;

    // ── 1+2. Load & validate (fail fast before any DB write) ─────────────────────
    log('🔎 Validating master-data JSON against Zod schemas…');
    const plans = MasterPlansFile.parse(readJson('master_plans.json'));
    const prices = PlanPricesFile.parse(readJson('plan_prices.json'));
    const assistants = MasterAssistantsFile.parse(readJson('master_assistants.json'));
    const benchmarks = BenchmarksFile.parse(readJson('master_benchmarks.json'));
    log('✅ Validation passed.');

    const db = getDb();
    const result: SeedResult = {
        plans: 0, prices: 0, assistants: 0, benchmarks: 0,
        stripeProducts: 0, stripePrices: 0, stripeSynced: false,
    };

    // ── 3. Upsert master plans (natural key: tierKey) ────────────────────────────
    log('🌱 Seeding master plans…');
    for (const p of plans) {
        await db.insert(masterPlans).values({
            tierKey: p.tierKey,
            name: p.name,
            monthlyPriceGbp: p.monthlyPriceGbp,
            assistantLimit: p.assistantLimit ?? null,
            monthlyTaskLimit: p.monthlyTaskLimit ?? null,
            monthlyTokenLimit: p.monthlyTokenLimit ?? null,
            appConnectionLimit: p.appConnectionLimit ?? null,
            seatLimit: p.seatLimit ?? null,
            storageLimitBytes: p.storageLimitBytes ?? null,
            features: p.features ?? {},
            isActive: p.isActive,
        }).onConflictDoUpdate({
            target: masterPlans.tierKey,
            set: {
                name: p.name,
                monthlyPriceGbp: p.monthlyPriceGbp,
                assistantLimit: p.assistantLimit ?? null,
                monthlyTaskLimit: p.monthlyTaskLimit ?? null,
                monthlyTokenLimit: p.monthlyTokenLimit ?? null,
                appConnectionLimit: p.appConnectionLimit ?? null,
                seatLimit: p.seatLimit ?? null,
                storageLimitBytes: p.storageLimitBytes ?? null,
                features: p.features ?? {},
                isActive: p.isActive,
            },
        });
        result.plans++;
    }

    // Resolve tierKey → masterPlanId for this environment (PKs differ per env).
    const planRows = await db.select({ id: masterPlans.id, tierKey: masterPlans.tierKey, stripeProductId: masterPlans.stripeProductId }).from(masterPlans);
    const planIdByTier = new Map(planRows.map((r) => [r.tierKey, r.id]));

    // ── Upsert plan prices (natural key: masterPlanId + currency) ────────────────
    log('🌱 Seeding plan prices…');
    for (const pr of prices) {
        const masterPlanId = planIdByTier.get(pr.planTierKey);
        if (!masterPlanId) { log(`  ⚠ skipping price for unknown plan tier "${pr.planTierKey}"`); continue; }
        await db.insert(planPrices).values({
            masterPlanId,
            currency: pr.currency,
            monthlyPriceMajorUnit: pr.monthlyPriceMajorUnit,
            isActive: pr.isActive,
        }).onConflictDoUpdate({
            target: [planPrices.masterPlanId, planPrices.currency],
            set: { monthlyPriceMajorUnit: pr.monthlyPriceMajorUnit, isActive: pr.isActive },
        });
        result.prices++;
    }

    // ── Upsert master assistants (natural key: roleKey) ──────────────────────────
    log('🌱 Seeding master assistants…');
    for (const a of assistants) {
        const base = {
            name: a.name,
            description: a.description ?? null,
            comingSoon: a.comingSoon,
            isActive: a.isActive,
            ...(a.category ? { category: a.category } : {}),
            ...(a.iconKey ? { iconKey: a.iconKey } : {}),
            ...(a.iconColor ? { iconColor: a.iconColor } : {}),
            ...(a.lifecycleState ? { lifecycleState: a.lifecycleState } : {}),
            ...(a.riskClassification ? { riskClassification: a.riskClassification } : {}),
        };
        await db.insert(masterAssistants).values({ roleKey: a.roleKey, ...base })
            .onConflictDoUpdate({ target: masterAssistants.roleKey, set: { ...base, updatedAt: new Date() } });
        result.assistants++;
    }

    // ── Upsert benchmarks into platform_config (natural key: key) ────────────────
    log('🌱 Seeding benchmarks…');
    for (const b of benchmarks) {
        await db.insert(platformConfig).values({
            key: b.key,
            value: { version: b.version, description: b.description ?? null, categories: b.categories },
            updatedBy: actorId,
            reason: 'Master-data seed',
        }).onConflictDoUpdate({
            target: platformConfig.key,
            set: { value: { version: b.version, description: b.description ?? null, categories: b.categories }, updatedBy: actorId, updatedAt: new Date(), reason: 'Master-data seed' },
        });
        result.benchmarks++;
    }

    // ── 4. Stripe test sync (US5.3) ──────────────────────────────────────────────
    if (syncStripe && stripeKeyAvailable()) {
        log(`💳 Syncing Stripe Products/Prices (apiVersion ${STRIPE_API_VERSION})…`);
        const stripe = getStripe();

        // Re-read prices with their (possibly missing) stripePriceId.
        const priceRows = await db.select().from(planPrices);

        for (const plan of planRows) {
            const planMeta = plans.find((p) => p.tierKey === plan.tierKey);
            if (!planMeta) continue;

            // Ensure a Product exists for the plan.
            let productId = plan.stripeProductId;
            if (!productId) {
                const product = await stripe.products.create({
                    name: planMeta.name,
                    metadata: { tierKey: plan.tierKey },
                });
                productId = product.id;
                await db.update(masterPlans).set({ stripeProductId: productId }).where(eq(masterPlans.id, plan.id));
                result.stripeProducts++;
            }

            // Ensure a Price exists for each currency row of this plan.
            for (const row of priceRows.filter((r) => r.masterPlanId === plan.id)) {
                if (row.stripePriceId) continue; // Stripe prices are immutable — never duplicate
                const unitAmount = Math.round(Number(row.monthlyPriceMajorUnit) * 100);
                const price = await stripe.prices.create({
                    product: productId,
                    currency: row.currency.toLowerCase(),
                    unit_amount: unitAmount,
                    recurring: { interval: 'month' },
                    metadata: { tierKey: plan.tierKey },
                });
                await db.update(planPrices).set({ stripePriceId: price.id }).where(eq(planPrices.id, row.id));
                result.stripePrices++;
            }
        }
        result.stripeSynced = true;
    } else if (syncStripe) {
        log('⏭  Stripe key not configured for this environment — skipping Stripe sync.');
    }

    log(`✅ Seed complete: ${result.plans} plans, ${result.prices} prices, ${result.assistants} assistants, ${result.benchmarks} benchmarks` +
        (result.stripeSynced ? `, Stripe(+${result.stripeProducts} products, +${result.stripePrices} prices)` : ''));
    return result;
}
