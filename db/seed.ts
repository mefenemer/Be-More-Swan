import { config } from 'dotenv';
import * as path from 'path';

// Tell dotenv exactly where to find the .env file
config({ path: path.resolve(process.cwd(), '.env') });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { masterPlans } from './schema';

// Grab the database URL directly from the environment
const connectionString = process.env.NETLIFY_DATABASE_URL;

if (!connectionString) {
    throw new Error("CRITICAL: NETLIFY_DATABASE_URL is missing from the environment.");
}

// Set max connections to 1 since this is a one-off script
const sql = postgres(connectionString, { max: 1 });
const db = drizzle({ client: sql });

async function seed() {
    console.log('🌱 Starting database seed...');

    try {
        // 1. Seed the Master Plans
        console.log('Seeding Master Plans...');
        await db.insert(masterPlans).values([
            { tierKey: 'saver', name: 'The Workflow Saver', monthlyPriceGbp: '50.00',
              tierDescription: 'Tier 1 · Best for Solo Operators',
              description: 'Reclaim hours every day. Hand your most draining task to a helper that never takes a day off.' },
            { tierKey: 'buster', name: 'The Busywork Buster', monthlyPriceGbp: '20.00',
              tierDescription: 'Tier 2 · Best for Scaling Founders',
              description: 'Scale your business with autonomous goal tracking, advanced analytics, and your own mini digital department.',
              isMostPopular: true },
            { tierKey: 'employee', name: 'The Digital Employee', monthlyPriceGbp: '100.00',
              tierDescription: 'Tier 3 · Best for Teams',
              description: 'A complete digital workforce built for growing businesses and collaborative teams.' },
            // Enterprise: non-purchasable (contact-sales) so its pricing card is admin-editable too.
            { tierKey: 'enterprise', name: 'Custom Enterprise', monthlyPriceGbp: '1199.00',
              tierDescription: 'Tier 4 · Enterprise',
              description: 'Bespoke digital architecture for complex corporate environments.',
              isContactSales: true },
        ]).onConflictDoNothing({ target: masterPlans.tierKey });
        // ^ onConflictDoNothing prevents duplicate errors if you run this twice!

        // 2. Master Assistants are seeded from seed/data/master_assistants.json via
        // `npm run db:seed` (seed/run-seed.ts). The hardcoded list that used to live here
        // carried the RETIRED pre-catalog roleKey namespace ('social_media', 'inbox', …) and
        // was removed with db/rolekey-namespace-unification.sql so a manual re-run of this
        // script can never reintroduce the drift.
        console.log('Skipping Master Assistants — seeded from seed/data/master_assistants.json (npm run db:seed).');

        console.log('✅ Seeding completed successfully!');
    } catch (error) {
        console.error('❌ Error during seeding:', error);
    } finally {
        // Always close the database connection gracefully
        await sql.end();
    }
}

// Add to db/seed.ts (Make sure to import helpArticles at the top)

console.log("Seeding Help Articles...");

import { getDb } from './client'; // Adjust path if necessary
import { helpArticles } from './schema'; // Adjust path if necessary

// Wrap everything inside an async execution wrapper
(async () => {
    try {
        console.log("Starting Database Seeding...");
        const db = getDb();

        // Your help articles dataset execution block.
        // NOTE: help_articles columns are (category, sortOrder, title, contentMd, isPublished);
        // titles are unique so onConflictDoNothing makes re-seeding idempotent.
        await db.insert(helpArticles).values([
            {
                category: "Getting Started",
                sortOrder: 1,
                title: "Understanding Your Workspace",
                contentMd: "A complete tour of the Be More Swan dashboard, metrics, and how to interpret your digital team's time-saved analytics.",
            },
            {
                category: "Getting Started",
                sortOrder: 2,
                title: "Be More Swan Glossary of Terms",
                contentMd: "Definitions for commonly used terms including Compute Power, Automations, Workflows, and Active vs. Resting states.",
            },
            {
                category: "Getting Started",
                sortOrder: 3,
                title: "Navigating the Interface",
                contentMd: "How to effectively use the sidebar, mobile hamburger menu, and quick-action shortcuts to manage your team.",
            },
            {
                category: "Assistants",
                sortOrder: 1,
                title: "How to Hire & Provision Assistants",
                contentMd: "A step-by-step guide to browsing the catalog, requesting custom roles, and deploying new assistants to your workspace.",
            },
            {
                category: "Assistants",
                sortOrder: 2,
                title: "Updating Assistant Guidelines",
                contentMd: "Learn how to edit the operational rules, tone of voice, and boundary constraints for your active digital employees.",
            },
            {
                category: "Account & Settings",
                sortOrder: 1,
                title: "Updating Account Settings",
                contentMd: "How to change your email, password, and global timezone so your assistants operate on your local schedule.",
            },
            {
                category: "Account & Settings",
                sortOrder: 2,
                title: "Managing Notification Preferences",
                contentMd: "Control how often Be More Swan interrupts you. Set up daily digests, billing alerts, and waitlist updates.",
            },
            {
                category: "Account & Settings",
                sortOrder: 3,
                title: "Compute Budgets & Preferences",
                contentMd: "Understanding how AI processing power is billed at cost, and how to adjust your monthly safety caps to prevent surprise bills.",
            },
            {
                category: "Compliance",
                sortOrder: 1,
                title: "Data Security & Compliance",
                contentMd: "Detailed information on our encryption standards, privacy policies, and how your data is sandboxed from public AI models.",
            },
            {
                category: "Compliance",
                sortOrder: 2,
                title: "The Safe Content Benchmark",
                contentMd: [
                    "Every assistant is governed by the Be More Swan Safe Content Benchmark — an immutable safety layer injected at the highest priority in every system prompt. It cannot be disabled, overridden, or bypassed by any workspace setting.",
                    "",
                    "It covers: no sexually explicit content, no hate speech or discrimination, no violence or dangerous content, no self-harm promotion, no illegal acts, no harassment, no spam or phishing, no unauthorised use of copyrighted or private material, and **No Identity-Based Bias or Stereotyping**.",
                    "",
                    "**No Identity-Based Bias or Stereotyping** — Evaluations, tone, and recommendations remain strictly equitable and will never alter based on a subject's gender, ethnicity, religion, or sexuality. Identical inputs that differ only by a demographic marker yield equivalent professional tone, assumed competence, and recommendations.",
                ].join("\n"),
            },
        ]).onConflictDoNothing({ target: helpArticles.title });

        console.log("🌱 Database seeding completed successfully!");
        process.exit(0);
    } catch (error) {
        console.error("❌ Seeding execution failed:", error);
        process.exit(1);
    }
})();

console.log("Help Articles Seeded!");

seed();