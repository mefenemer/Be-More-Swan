/**
 * db/seed-plan-features.ts
 *
 * Value-preserving migration for the DB-driven pricing feature catalog (plan_features).
 * Transcribes the CURRENT hard-coded pricing.html comparison table into:
 *   1. plan_features catalog rows (one per comparison-table row) — metadata + the "Custom
 *      Enterprise" (t4) column value.
 *   2. Backfilled master_plans.features jsonb for the 3 purchasable tiers (saver/buster/employee)
 *      for every FEATURE-stored row, so the dynamic table renders identically to the old static one.
 *
 * Capacity limits (assistant_limit, monthly_task_limit) are COLUMN-stored — already correct and
 * enforced in master_plans, so this seed does NOT touch them (single source of truth).
 *
 * Idempotent: upserts catalog rows by `key` and merges feature values into each plan's jsonb.
 *
 * Run with:  npx tsx db/seed-plan-features.ts
 * (Requires NETLIFY_DATABASE_URL / DATABASE_URL. Apply db/plan-features.sql first.)
 */

import { config } from 'dotenv';
import * as path from 'path';
config({ path: path.resolve(process.cwd(), '.env') });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { masterPlans, planFeatures } from './schema';

const connectionString = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('NETLIFY_DATABASE_URL / DATABASE_URL is not set.');

const client = postgres(connectionString, { max: 1 });
const db = drizzle({ client });

// Purchasable tiers, in the pricing.html card order (t1, t2, t3). t4 = Custom Enterprise (enterpriseValue).
type Tier = 'saver' | 'buster' | 'employee';
const CHECK = true, DASH = false;

interface Def {
    key: string;
    label: string;
    description: string;
    category: string;
    valueType: 'number' | 'boolean' | 'text';
    storageTarget: 'column' | 'feature';
    columnName?: string;
    unlimitedLabel?: string;
    enterpriseValue: string;         // t4 display value
    // Per-tier value for FEATURE-stored rows (omitted for column-stored rows).
    values?: Record<Tier, unknown>;
}

// Order here IS the display order (grouped by category in first-seen order by pricing.html).
const DEFS: Def[] = [
    // ── Capacity ──────────────────────────────────────────────────────────────
    { key: 'assistant_limit', label: 'Digital Assistants', description: 'The number of distinct AI roles you can deploy in your account',
      category: 'Capacity', valueType: 'number', storageTarget: 'column', columnName: 'assistantLimit', unlimitedLabel: 'Custom', enterpriseValue: 'Custom' },
    { key: 'monthly_task_limit', label: 'Completed Tasks / Month', description: 'Each action your assistant completes counts as one task',
      category: 'Capacity', valueType: 'number', storageTarget: 'column', columnName: 'monthlyTaskLimit', unlimitedLabel: 'Custom', enterpriseValue: 'Custom' },
    // Drives the pricing-card "Apps" stat box AND the per-assistant connection limit enforced by
    // check-capacity. Column-stored so an admin edit in the matrix moves both together.
    { key: 'app_connection_limit', label: 'App Connections', description: 'The number of apps and tools your assistants can connect to',
      category: 'Capacity', valueType: 'number', storageTarget: 'column', columnName: 'appConnectionLimit', unlimitedLabel: 'Custom', enterpriseValue: 'Custom' },
    { key: 'app_connections', label: 'App Connection Details', description: 'The tools and platforms your assistants can connect to and work within',
      category: 'Capacity', valueType: 'text', storageTarget: 'feature', enterpriseValue: 'Bespoke app limits & custom internal system integrations',
      values: { saver: 'Connect up to 4 everyday apps', buster: 'Connect up to 10 standard apps to power your digital department', employee: 'Connect up to 15 apps (unlocks Premium Tool integrations like CRM and e-commerce)' } },
    { key: 'monthly_x_credits', label: 'X (Twitter) Posting Credits / Month', description: 'Credits for posting to X each month — a text post costs 1 credit, a post with a link costs 13. Buy more any time; purchased credits never expire.',
      category: 'Capacity', valueType: 'number', storageTarget: 'feature', unlimitedLabel: 'Custom', enterpriseValue: 'Custom',
      values: { saver: 150, buster: 500, employee: 1500 } },

    // ── AI Media Generation ───────────────────────────────────────────────────
    { key: 'monthly_ai_credits', label: 'AI Media Credits / Month', description: 'Credits included each month for AI media generation (image = 1 credit, video = 5 credits)',
      category: 'AI Media Generation', valueType: 'number', storageTarget: 'feature', unlimitedLabel: 'Custom', enterpriseValue: 'Custom',
      values: { saver: 20, buster: 50, employee: 100 } },
    { key: 'ai_image_generation', label: 'AI Image Generation', description: 'Generate on-brand images from a prompt — 1 credit each',
      category: 'AI Media Generation', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },
    { key: 'ai_video_generation', label: 'AI Video Generation', description: 'Generate short-form videos from a prompt — 5 credits each',
      category: 'AI Media Generation', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: CHECK, employee: CHECK } },
    { key: 'credits_rollover', label: 'Unused Credits Roll Over', description: "Any credits you don't use carry forward to the next month",
      category: 'AI Media Generation', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },
    { key: 'credit_topups', label: 'Buy Extra Credit Top-Ups', description: 'Need more? Purchase additional credits any time your allowance runs low',
      category: 'AI Media Generation', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },

    // ── Core Features — included on every plan ─────────────────────────────────
    { key: 'safe_content_benchmark', label: 'Be More Swan Safe Content Benchmark', description: 'Built-in safety rules that keep every output on-brand and legally compliant',
      category: 'Core Features — included on every plan', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },
    { key: 'brand_memory', label: 'Brand Memory', description: 'Your assistant learns your voice, values, and history from day one',
      category: 'Core Features — included on every plan', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },
    { key: 'scheduled_workflows', label: 'Around-the-Clock Workflows', description: "Scheduled tasks run automatically, even while you're offline or asleep",
      category: 'Core Features — included on every plan', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },
    { key: 'draft_approvals', label: 'Draft Approvals', description: "Every output lands in your inbox for sign-off before it's published or sent",
      category: 'Core Features — included on every plan', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },
    { key: 'content_calendar', label: 'Content Calendar', description: "Plan, schedule, and review your assistant's upcoming work in one view",
      category: 'Core Features — included on every plan', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },
    { key: 'my_content_hub', label: '"My Content" Hub', description: 'Drop in photos, videos, and links for your assistant to use as source material',
      category: 'Core Features — included on every plan', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },
    { key: 'brand_protection', label: 'Brand Protection Guarantee', description: 'Your assistants are governed by our Safe Content Benchmark on every plan',
      category: 'Core Features — included on every plan', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },

    // ── Reporting ─────────────────────────────────────────────────────────────
    { key: 'basic_reporting', label: 'Basic Reporting', description: 'A clear monthly summary of what your assistant completed',
      category: 'Reporting', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },
    { key: 'advanced_reporting', label: 'Advanced Reporting', description: 'Detailed breakdowns of assistant performance, output quality, and time saved',
      category: 'Reporting', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: CHECK, employee: CHECK } },
    { key: 'custom_reporting', label: 'Custom Reporting', description: 'Tailored dashboards built around the metrics that matter most to your business',
      category: 'Reporting', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: DASH, employee: CHECK } },

    // ── Team & Advanced Features ──────────────────────────────────────────────
    { key: 'quality_reviewer', label: 'The Quality Reviewer', description: 'A dedicated assistant that checks and critiques the work of your other assistants',
      category: 'Team & Advanced Features', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: CHECK, employee: CHECK } },
    { key: 'workspace_collaboration', label: 'Workspace Collaboration', description: 'Invite team members, managers, or clients to view and approve outputs',
      category: 'Team & Advanced Features', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: DASH, employee: CHECK } },
    { key: 'advanced_tool_vault', label: 'Advanced Tool Vault', description: 'Access to premium and specialist third-party integrations beyond the standard set',
      category: 'Team & Advanced Features', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: DASH, employee: CHECK } },
    { key: 'internal_systems_access', label: 'Internal Systems Access', description: 'Connect assistants directly to your private databases and legacy business software',
      category: 'Team & Advanced Features', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: DASH, employee: DASH } },
    { key: 'sso_integration', label: 'SSO Integration', description: 'Single sign-on for seamless, secure corporate-wide access management',
      category: 'Team & Advanced Features', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: DASH, employee: DASH } },
    { key: 'sms_whatsapp_alerts', label: 'SMS & WhatsApp Alerts', description: 'Receive push notifications for urgent approvals directly via SMS or WhatsApp',
      category: 'Team & Advanced Features', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: DASH, employee: DASH } },
    { key: 'custom_model_training', label: 'Custom AI Model Training', description: 'Assistants trained on your proprietary data, processes, and brand playbooks',
      category: 'Team & Advanced Features', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: DASH, employee: DASH } },
    { key: 'full_api_access', label: 'Full API Access', description: 'Programmatic access so your own systems can direct and query your workforce',
      category: 'Team & Advanced Features', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: DASH, employee: DASH } },

    // ── Support ───────────────────────────────────────────────────────────────
    { key: 'support_channel', label: 'Support Channel', description: 'How you can reach our team when you need help',
      category: 'Support', valueType: 'text', storageTarget: 'feature', enterpriseValue: 'Dedicated Account Manager',
      values: { saver: 'Email & Help Centre', buster: 'Priority Email & Chat', employee: 'Priority + Strategy Call' } },
    { key: 'onboarding_call', label: '1-on-1 Strategy & Onboarding Call', description: 'A dedicated session with a Be More Swan expert to set up and optimise your workspace',
      category: 'Support', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: DASH, employee: CHECK } },

    // ── Continuous Evolution ──────────────────────────────────────────────────
    { key: 'free_upgrades', label: 'Free Capability Upgrades', description: 'Your assistants automatically improve as we release new capabilities — no extra cost ever',
      category: 'Continuous Evolution', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: CHECK, buster: CHECK, employee: CHECK } },
    { key: 'early_access_roles', label: 'Early Access to New Roles', description: 'Be first to try new assistant roles before they launch to the general public',
      category: 'Continuous Evolution', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: CHECK, employee: CHECK } },
    { key: 'roadmap_voting', label: 'Roadmap Influence & Voting', description: 'Vote on which features and assistant types we prioritise building next',
      category: 'Continuous Evolution', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: DASH, employee: CHECK } },
    { key: 'vip_engineering', label: '➕ Premium Add-On: VIP Engineering Co-Creation', description: 'Commission our core engineering team to architect and build completely bespoke Digital Assistants exclusive to your private organisation. (Scoped and billed per project)',
      category: 'Continuous Evolution', valueType: 'boolean', storageTarget: 'feature', enterpriseValue: 'true',
      values: { saver: DASH, buster: DASH, employee: DASH } },
];

async function main() {
    console.log(`Seeding ${DEFS.length} plan feature definitions…`);

    // 1. Upsert catalog rows (idempotent on key). displayOrder = array index.
    for (let i = 0; i < DEFS.length; i++) {
        const d = DEFS[i];
        await db.insert(planFeatures).values({
            key: d.key, label: d.label, description: d.description, category: d.category,
            valueType: d.valueType, storageTarget: d.storageTarget, columnName: d.columnName ?? null,
            unlimitedLabel: d.unlimitedLabel ?? null, enterpriseValue: d.enterpriseValue,
            displayOrder: i, isEnabled: true,
        }).onConflictDoUpdate({
            target: planFeatures.key,
            set: {
                label: d.label, description: d.description, category: d.category, valueType: d.valueType,
                storageTarget: d.storageTarget, columnName: d.columnName ?? null,
                unlimitedLabel: d.unlimitedLabel ?? null, enterpriseValue: d.enterpriseValue,
                displayOrder: i, updatedAt: new Date(),
            },
        });
    }
    console.log('✓ Catalog upserted.');

    // 2. Backfill master_plans.features for the 3 purchasable tiers (FEATURE-stored rows only).
    const tiers: Tier[] = ['saver', 'buster', 'employee'];
    for (const tier of tiers) {
        const [mp] = await db.select().from(masterPlans).where(eq(masterPlans.tierKey, tier)).limit(1);
        if (!mp) { console.warn(`⚠  master plan '${tier}' not found — skipping.`); continue; }
        const features: Record<string, unknown> = { ...((mp.features as Record<string, unknown>) ?? {}) };
        for (const d of DEFS) {
            if (d.storageTarget !== 'feature' || !d.values) continue;
            features[d.key] = d.values[tier];
        }
        await db.update(masterPlans).set({ features }).where(eq(masterPlans.id, mp.id));
        console.log(`✓ ${tier}: features jsonb backfilled (${Object.keys(features).length} keys).`);
    }

    console.log('\nDone. Verify pricing.html renders identically, then the catalog is live.');
    await client.end();
}

main().catch(async (err) => { console.error(err); await client.end(); process.exit(1); });
