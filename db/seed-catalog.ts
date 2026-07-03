/**
 * db/seed-catalog.ts
 *
 * Upserts every master assistant role into the database.
 * Safe to re-run — uses ON CONFLICT (role_key) DO UPDATE so existing
 * records get refreshed with the latest description / metadata.
 *
 * Run with:
 *   npx ts-node -r dotenv/config db/seed-catalog.ts
 */

import { config } from 'dotenv';
import * as path from 'path';
config({ path: path.resolve(process.cwd(), '.env') });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { masterAssistants, masterPlans } from './schema';
import { sql } from 'drizzle-orm';

const connectionString = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('NETLIFY_DATABASE_URL / DATABASE_URL is not set.');

const client = postgres(connectionString, { max: 1 });
const db = drizzle({ client });

// ── Catalog data ──────────────────────────────────────────────────────────────
const CATALOG = [

    // ── 1. Administration ────────────────────────────────────────────────────
    {
        roleKey: 'inbox_manager',
        name: 'The Inbox Manager',
        description: 'Drafts replies to standard emails, categorizes incoming messages, and highlights urgent issues — eliminating email fatigue before your day begins.',
        category: 'Administration',
        iconKey: 'mail',
        iconColor: 'blue',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'calendar_coordinator',
        name: 'The Calendar Coordinator',
        description: 'Negotiates meeting times across different time zones and prepares daily schedule briefings so you never start the day lost.',
        category: 'Administration',
        iconKey: 'cog',
        iconColor: 'purple',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'travel_logistics_booker',
        name: 'The Travel & Logistics Booker',
        description: 'Sources flights, hotels, and creates itineraries based on your budget and preference guardrails — travel sorted without lifting a finger.',
        category: 'Administration',
        iconKey: 'globe',
        iconColor: 'teal',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'document_organizer',
        name: 'The Document Organizer',
        description: 'Automatically renames, tags, and files loose documents, PDFs, and assets into the correct cloud folders — your digital filing cabinet, always tidy.',
        category: 'Administration',
        iconKey: 'document',
        iconColor: 'orange',
        comingSoon: true,
        isActive: true,
    },

    // ── 2. Marketing & Sales ─────────────────────────────────────────────────
    {
        roleKey: 'social_media_manager',
        name: 'The Social Media Manager',
        description: 'Plans, writes, and schedules branded content across all your social channels — consistent pipeline generation without the daily grind.',
        category: 'Marketing & Sales',
        iconKey: 'megaphone',
        iconColor: 'pink',
        comingSoon: false,   // ← Currently Live
        isActive: true,
    },
    {
        roleKey: 'lead_qualifier',
        name: 'The Lead Qualifier',
        description: 'Researches inbound leads, scores them based on your company criteria, and drafts personalised outreach emails — so your sales team only calls the right people.',
        category: 'Marketing & Sales',
        iconKey: 'chart',
        iconColor: 'blue',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'seo_content_strategist',
        name: 'The SEO Content Strategist',
        description: 'Takes a rough topic, researches keywords, and drafts fully formatted, SEO-optimised blog posts — brand consistency at scale.',
        category: 'Marketing & Sales',
        iconKey: 'document',
        iconColor: 'green',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'crm_enricher',
        name: 'The CRM Enricher',
        description: 'Scours the web to fill in missing contact details — LinkedIn profiles, company size, funding stage — for every new lead in your database.',
        category: 'Marketing & Sales',
        iconKey: 'cog',
        iconColor: 'purple',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'newsletter_editor',
        name: 'The Newsletter Editor',
        description: 'Curates weekly industry news and formats it into a ready-to-send email campaign — your audience stays informed without you reading everything.',
        category: 'Marketing & Sales',
        iconKey: 'mail',
        iconColor: 'teal',
        comingSoon: true,
        isActive: true,
    },

    // ── 3. Operations ────────────────────────────────────────────────────────
    {
        roleKey: 'vendor_communications_rep',
        name: 'The Vendor Communications Rep',
        description: 'Chases suppliers for updates, requests quotes, and compares pricing tables — the engine room kept running without your involvement.',
        category: 'Operations',
        iconKey: 'globe',
        iconColor: 'orange',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'inventory_tracker',
        name: 'The Inventory Tracker',
        description: 'Monitors stock levels across platforms and drafts reorder requests when supplies dip below a threshold — stockouts become a thing of the past.',
        category: 'Operations',
        iconKey: 'chart',
        iconColor: 'blue',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'sop_writer',
        name: 'The SOP Writer',
        description: 'Takes messy voice notes or screen recordings and turns them into formatted, step-by-step training manuals — your processes documented while you work.',
        category: 'Operations',
        iconKey: 'document',
        iconColor: 'green',
        comingSoon: true,
        isActive: true,
    },

    // ── 4. Customer Success & Support ────────────────────────────────────────
    {
        roleKey: 'tier1_support_agent',
        name: 'The Tier 1 Support Agent',
        description: 'Instantly resolves common FAQs — refunds, password resets, shipping times — and escalates complex issues to your team with full context.',
        category: 'Customer Success & Support',
        iconKey: 'smile',
        iconColor: 'teal',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'client_onboarding_guide',
        name: 'The Client Onboarding Guide',
        description: 'Sends welcome packets, chases missing onboarding forms, and schedules kick-off calls — every client starts their journey feeling looked after.',
        category: 'Customer Success & Support',
        iconKey: 'lightning',
        iconColor: 'blue',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'review_reputation_manager',
        name: 'The Review & Reputation Manager',
        description: 'Monitors Trustpilot, Google, and more — drafts polite responses to negative reviews and thanks positive reviewers — your reputation protected 24/7.',
        category: 'Customer Success & Support',
        iconKey: 'megaphone',
        iconColor: 'pink',
        comingSoon: true,
        isActive: true,
    },

    // ── 5. Project Management ────────────────────────────────────────────────
    {
        roleKey: 'standup_summarizer',
        name: 'The Daily Stand-up Summarizer',
        description: 'Chases team members for their daily updates and compiles them into one clean Slack or Teams message — no more status meetings.',
        category: 'Project Management',
        iconKey: 'lightning',
        iconColor: 'purple',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'meeting_note_taker',
        name: 'The Meeting Note Taker',
        description: 'Attends virtual meetings, transcribes the conversation, and instantly extracts action items — assigned to the right people before the call ends.',
        category: 'Project Management',
        iconKey: 'document',
        iconColor: 'blue',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'status_report_generator',
        name: 'The Status Report Generator',
        description: 'Pulls data from Jira, Asana, or Monday.com to create weekly executive summaries on project health — leadership always in the loop.',
        category: 'Project Management',
        iconKey: 'chart',
        iconColor: 'green',
        comingSoon: true,
        isActive: true,
    },

    // ── 6. Finance & Bookkeeping ─────────────────────────────────────────────
    {
        roleKey: 'accounts_receivable_clerk',
        name: 'The Accounts Receivable Clerk',
        description: 'Politely but persistently chases unpaid invoices and drafts payment reminders — cash flow protected without awkward conversations.',
        category: 'Finance & Bookkeeping',
        iconKey: 'chart',
        iconColor: 'orange',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'expense_categorizer',
        name: 'The Expense Categorizer',
        description: 'Reads scanned receipts, extracts the vendor and amount, and matches them to the correct tax category — bookkeeping done before your accountant asks.',
        category: 'Finance & Bookkeeping',
        iconKey: 'document',
        iconColor: 'teal',
        comingSoon: true,
        isActive: true,
    },
];

// ── Upsert ────────────────────────────────────────────────────────────────────
async function seedCatalog() {
    console.log(`\n🌱 Seeding ${CATALOG.length} master assistant roles…\n`);

    for (const role of CATALOG) {
        await db
            .insert(masterAssistants)
            .values(role)
            .onConflictDoUpdate({
                target: masterAssistants.roleKey,
                set: {
                    name:        sql`excluded.name`,
                    description: sql`excluded.description`,
                    category:    sql`excluded.category`,
                    iconKey:     sql`excluded.icon_key`,
                    iconColor:   sql`excluded.icon_color`,
                    comingSoon:  sql`excluded.coming_soon`,
                    isActive:    sql`excluded.is_active`,
                },
            });
        console.log(`  ✓ ${role.name}`);
    }

    // P2-5: Seed the trial master plan so registration can look it up at runtime
    await db.insert(masterPlans).values({
        tierKey: 'trial',
        name: 'Free Trial',
        monthlyPriceGbp: '0.00',
        assistantLimit: 1,
        monthlyTaskLimit: 50,
        monthlyTokenLimit: null,
        appConnectionLimit: 2,
        seatLimit: 1,
        isActive: true,
        features: { monthly_ai_credits: 0 },   // no AI media generation on trial (Epic 2) — upgrade to use
    }).onConflictDoNothing();
    console.log('  ✓ masterPlan: trial');

    console.log('\n✅ Catalog seeded successfully.\n');
    await client.end();
}

seedCatalog().catch(e => {
    console.error('❌ Seed failed:', e);
    client.end();
    process.exit(1);
});
