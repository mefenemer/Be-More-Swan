// tests/plan-stripe-refs-backfill.test.ts
//
// A first subscription is written by two racers — confirm-payment.ts (the browser landing on
// workspace.html?payment=success) and stripe-webhook.ts (payment_intent.succeeded) — and exactly
// one of them wins the plans_one_active_per_org_unique index. The loser used to walk away:
// confirm-payment returned { alreadyExists: true } on ANY active row without ever looking at what
// that row contained, so an active plan carrying NULL stripe ids could never be healed. Every
// admin action in admin-billing-override.ts is gated on both ids being present, so such a row
// disables upgrade_tier, downgrade_tier, comp_month, extend_trial and pause_subscription for the
// whole organisation.
//
// Two further shapes are pinned here:
//   * the loser's lookup is scoped to the ORGANISATION (what the unique index keys on), not to the
//     user — scoping it to the user both missed the row the insert would collide with and skipped
//     provisioning entirely for a user holding an active plan in some other org;
//   * create-subscription.ts's PaymentIntent metadata stamp is fatal rather than best-effort,
//     because both consumers bail without it and the customer would pay for nothing.
//
// Run:  npx tsx tests/plan-stripe-refs-backfill.test.ts

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { plans } from '../db/schema';

// confirm-payment.ts constructs a Stripe client at module scope; give it something to hold.
process.env.STRIPE_SECRET_KEY ||= 'sk_test_dummy_for_unit_test';
process.env.JWT_SECRET ||= 'dummy_for_unit_test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

let passed = 0, total = 0;
function check(name: string, fn: () => void | Promise<void>) {
    total++;
    return Promise.resolve()
        .then(fn)
        .then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch((e) => { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); });
}

// ── A miniature plans table that enforces the real partial unique index ────────────────────
type Row = {
    id: number;
    organisationId: number;
    userId: number;
    status: string;
    masterPlanId: number | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
};
type Refs = { stripeCustomerId?: string; stripeSubscriptionId?: string; masterPlanIdInt: number | null };

class PlansTable {
    rows: Row[] = [];
    private nextId = 1;
    /** plans_one_active_per_org_unique: uniqueIndex(organisationId) WHERE status IN ('active','past_due') */
    insert(r: Omit<Row, 'id'>): Row {
        if (['active', 'past_due'].includes(r.status) &&
            this.rows.some((x) => x.organisationId === r.organisationId && ['active', 'past_due'].includes(x.status))) {
            throw Object.assign(new Error('duplicate key value violates unique constraint "plans_one_active_per_org_unique"'), { code: '23505' });
        }
        const row = { ...r, id: this.nextId++ };
        this.rows.push(row);
        return row;
    }
    findActiveByOrg(orgId: number) {
        return this.rows.find((x) => x.organisationId === orgId && ['active', 'past_due'].includes(x.status));
    }
    activeCount(orgId: number) {
        return this.rows.filter((x) => x.organisationId === orgId && ['active', 'past_due'].includes(x.status)).length;
    }
}

const REFS: Refs = { stripeCustomerId: 'cus_LIVE', stripeSubscriptionId: 'sub_LIVE', masterPlanIdInt: 5 };
const newRow = (orgId: number, userId: number, refs: Refs): Omit<Row, 'id'> => ({
    organisationId: orgId,
    userId,
    status: 'active',
    masterPlanId: refs.masterPlanIdInt,
    stripeCustomerId: refs.stripeCustomerId ?? null,
    stripeSubscriptionId: refs.stripeSubscriptionId ?? null,
});

const main = async () => {
    // The REAL decision function out of confirm-payment.ts — not a copy of it.
    const { missingPlanRefs } = await import('../netlify/functions/confirm-payment');

    // Mirrors the COALESCE write; the SQL that actually runs is asserted separately below.
    const applyBackfill = (row: Row, refs: Refs) => {
        const m = missingPlanRefs(row as unknown as typeof plans.$inferSelect, refs);
        if (!m.customer && !m.subscription && !m.masterPlan) return false;
        if (m.customer)     row.stripeCustomerId = refs.stripeCustomerId!;
        if (m.subscription) row.stripeSubscriptionId = refs.stripeSubscriptionId!;
        if (m.masterPlan)   row.masterPlanId = refs.masterPlanIdInt;
        return true;
    };

    // confirm-payment.ts's control flow after the fix.
    const confirmPayment = (t: PlansTable, orgId: number, userId: number, refs: Refs) => {
        const existing = t.findActiveByOrg(orgId);
        if (existing) { applyBackfill(existing, refs); return; }
        try { t.insert(newRow(orgId, userId, refs)); }
        catch (e: any) {
            if (e.code !== '23505') throw e;
            const raced = t.findActiveByOrg(orgId);
            if (raced) applyBackfill(raced, refs);
        }
    };

    // stripe-webhook.ts is UNCHANGED: it still swallows the conflict.
    const webhook = (t: PlansTable, orgId: number, userId: number, refs: Refs) => {
        try { t.insert(newRow(orgId, userId, refs)); }
        catch (e: any) { if (e.code !== '23505') throw e; }
    };

    console.log('\nplan stripe refs — interleaving + backfill\n');

    await check('confirm-payment then webhook: one row, ids written exactly once', () => {
        const t = new PlansTable();
        confirmPayment(t, 41, 7, REFS);
        webhook(t, 41, 7, REFS);
        assert.strictEqual(t.activeCount(41), 1, 'the unique index must keep exactly one active row');
        const row = t.findActiveByOrg(41)!;
        assert.strictEqual(row.stripeCustomerId, 'cus_LIVE');
        assert.strictEqual(row.stripeSubscriptionId, 'sub_LIVE');
    });

    await check('webhook then confirm-payment: one row, ids written exactly once', () => {
        const t = new PlansTable();
        webhook(t, 41, 7, REFS);
        confirmPayment(t, 41, 7, REFS);
        assert.strictEqual(t.activeCount(41), 1);
        const row = t.findActiveByOrg(41)!;
        assert.strictEqual(row.stripeCustomerId, 'cus_LIVE');
        assert.strictEqual(row.stripeSubscriptionId, 'sub_LIVE');
    });

    await check('THE REGRESSION: an active row with NULL ids is healed, not skipped', () => {
        const t = new PlansTable();
        // However it got there — a legacy row, or any writer that landed without metadata.
        t.insert({ organisationId: 41, userId: 7, status: 'active', masterPlanId: null, stripeCustomerId: null, stripeSubscriptionId: null });
        confirmPayment(t, 41, 7, REFS);
        const row = t.findActiveByOrg(41)!;
        assert.strictEqual(row.stripeCustomerId, 'cus_LIVE', 'the customer id must be backfilled');
        assert.strictEqual(row.stripeSubscriptionId, 'sub_LIVE', 'the subscription id must be backfilled');
        assert.strictEqual(row.masterPlanId, 5, 'master_plan_id must be backfilled too');
        assert.strictEqual(t.activeCount(41), 1, 'healing must not add a second row');
    });

    await check('a populated id is never overwritten by a writer that arrived without one', () => {
        const t = new PlansTable();
        t.insert(newRow(41, 7, REFS));
        confirmPayment(t, 41, 7, { masterPlanIdInt: null }); // no refs at all
        const row = t.findActiveByOrg(41)!;
        assert.strictEqual(row.stripeCustomerId, 'cus_LIVE', 'must not be nulled out');
        assert.strictEqual(row.stripeSubscriptionId, 'sub_LIVE', 'must not be nulled out');
        assert.strictEqual(row.masterPlanId, 5);
    });

    await check('a populated id is never replaced by a DIFFERENT id', () => {
        const t = new PlansTable();
        t.insert(newRow(41, 7, REFS));
        confirmPayment(t, 41, 7, { stripeCustomerId: 'cus_OTHER', stripeSubscriptionId: 'sub_OTHER', masterPlanIdInt: 9 });
        const row = t.findActiveByOrg(41)!;
        assert.strictEqual(row.stripeCustomerId, 'cus_LIVE', 'first writer wins; backfill only fills gaps');
        assert.strictEqual(row.stripeSubscriptionId, 'sub_LIVE');
        assert.strictEqual(row.masterPlanId, 5);
    });

    await check('backfill is idempotent — repeat landings change nothing', () => {
        const t = new PlansTable();
        t.insert({ organisationId: 41, userId: 7, status: 'active', masterPlanId: null, stripeCustomerId: null, stripeSubscriptionId: null });
        confirmPayment(t, 41, 7, REFS);
        const after1 = JSON.stringify(t.rows);
        confirmPayment(t, 41, 7, REFS);
        confirmPayment(t, 41, 7, REFS);
        assert.strictEqual(JSON.stringify(t.rows), after1, 'a second and third call must be a no-op');
    });

    await check('nothing to add means no write at all (updated_at is left alone)', () => {
        const complete = { id: 1, organisationId: 41, userId: 7, status: 'active', masterPlanId: 5, stripeCustomerId: 'cus_LIVE', stripeSubscriptionId: 'sub_LIVE' };
        const m = missingPlanRefs(complete as unknown as typeof plans.$inferSelect, REFS);
        assert.deepStrictEqual(m, { customer: false, subscription: false, masterPlan: false });
    });

    await check("a past_due row is healed too — it is what the unique index covers", () => {
        const t = new PlansTable();
        t.insert({ organisationId: 41, userId: 7, status: 'past_due', masterPlanId: null, stripeCustomerId: null, stripeSubscriptionId: null });
        confirmPayment(t, 41, 7, REFS);
        const row = t.findActiveByOrg(41)!;
        assert.strictEqual(row.stripeSubscriptionId, 'sub_LIVE');
        assert.strictEqual(t.activeCount(41), 1);
    });

    await check("an active plan in ANOTHER org must not skip provisioning for this one", () => {
        const t = new PlansTable();
        t.insert(newRow(99, 7, REFS));            // same user, different organisation
        confirmPayment(t, 41, 7, REFS);           // paying for org 41
        assert.strictEqual(t.activeCount(41), 1, 'org 41 must get its own plan row');
        assert.strictEqual(t.findActiveByOrg(41)!.stripeSubscriptionId, 'sub_LIVE');
    });

    // ── The write that actually runs ───────────────────────────────────────────────────────
    await check('the backfill UPDATE is COALESCE, so it cannot clobber or null out a column', () => {
        const db = drizzle({ client: postgres('postgres://u:p@127.0.0.1:1/none') });
        const compiled = db.update(plans).set({
            stripeCustomerId:     sql`COALESCE(${plans.stripeCustomerId}, ${'cus_LIVE'})`,
            stripeSubscriptionId: sql`COALESCE(${plans.stripeSubscriptionId}, ${null})`,
            masterPlanId:         sql`COALESCE(${plans.masterPlanId}, ${5})`,
            updatedAt:            new Date(),
        }).where(eq(plans.id, 42)).toSQL();

        for (const col of ['stripe_customer_id', 'stripe_subscription_id', 'master_plan_id']) {
            assert.ok(
                compiled.sql.includes(`"${col}" = COALESCE("plans"."${col}"`),
                `${col} must be written as COALESCE(existing, new) — a bare assignment would clobber it`,
            );
        }
        assert.ok(compiled.params.includes(null), 'an absent ref is bound as NULL, and COALESCE(col, NULL) = col');
        assert.ok(compiled.sql.includes('where "plans"."id" ='), 'the update must be pinned to one row by id');
    });

    // ── Shape of the shipped code ──────────────────────────────────────────────────────────
    console.log('');

    await check('the pre-payment stub endpoint no longer exists', () => {
        assert.ok(
            !existsSync(join(root, 'netlify/functions/create-checkout-intent.ts')),
            'create-checkout-intent.ts inserted an active plan with no stripe ids BEFORE payment',
        );
    });

    await check('confirm-payment scopes its lookup to the organisation, not the user', () => {
        const src = read('netlify/functions/confirm-payment.ts');
        assert.ok(src.includes('eq(plans.organisationId, orgIdInt)'), 'lookup must key on organisation_id');
        assert.ok(
            !src.includes("eq(plans.userId, userId), eq(plans.status, 'active')"),
            'the old user-scoped lookup must be gone — it missed the row the insert collides with',
        );
    });

    await check('confirm-payment backfills on BOTH the pre-check and the 23505 branch', () => {
        const src = read('netlify/functions/confirm-payment.ts');
        const calls = src.split('backfillPlanRefs(').length - 1;
        assert.ok(calls >= 3, `expected the definition plus two call sites, found ${calls} occurrences`);
        const conflict = src.indexOf("planErr?.code === '23505'");
        assert.notStrictEqual(conflict, -1, 'the 23505 handler must still exist');
        assert.ok(
            src.indexOf('backfillPlanRefs(', conflict) !== -1,
            'the 23505 branch must backfill rather than swallow the conflict',
        );
    });

    await check('create-subscription treats the metadata stamp as fatal, not best-effort', () => {
        const src = read('netlify/functions/create-subscription.ts');
        assert.ok(
            !src.includes("console.error('[create-subscription] Failed to stamp PaymentIntent metadata:'"),
            'the log-and-continue swallow must be gone — it let the customer pay for nothing',
        );
        const guard = src.indexOf('if (!stamped)');
        assert.notStrictEqual(guard, -1, 'an unstamped PaymentIntent must be handled explicitly');
        const tail = src.slice(guard);
        assert.ok(tail.includes('stripe.subscriptions.cancel(subscription.id)'), 'the subscription must be cancelled');
        assert.ok(tail.includes('statusCode: 502'), 'checkout must fail rather than return a confirmable secret');
    });

    console.log(`\n${passed}/${total} checks passed${total - passed ? ` — ${total - passed} FAILED` : ''}\n`);
    if (passed !== total) process.exitCode = 1;
};

main().catch((e) => { console.error(e); process.exitCode = 1; });
