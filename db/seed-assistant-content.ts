/**
 * db/seed-assistant-content.ts
 *
 * Seeds DB-driven assistant content into:
 *   1. master_assistants copy columns (tagline, key_features, integrations, video) — for the 7
 *      MIGRATED roles this is a value-preserving transcription of the hard-coded
 *      src/config/assistant-role-content.js, so the detail page renders identically to the old
 *      static one; the other 12 are AUTHORED copy for roles that never had any (see that array).
 *   2. assistant_feature_defs catalog rows, transcribed from the ASSISTANT_FEATURES list that used
 *      to live in src/config/assistant-features.ts.
 *
 * On `description`: master_assistants.description ALREADY exists and is what the catalogue CARD
 * renders, while the hardcoded file's description is what the detail MODAL renders — and for several
 * roles they had silently drifted apart. The hardcoded value wins here (it is the more curated copy,
 * and preserving it is what makes this migration value-preserving for the detail page). Every
 * divergence is printed for review rather than applied silently.
 *
 * name/category/iconKey/iconColor were duplicated in the hardcoded file too, but master_assistants is
 * already the live source for those on the catalogue grid — this seed does NOT touch them.
 *
 * Idempotent: upserts catalog rows by `key`, and only writes copy columns for the roles listed here.
 * Re-running reprints the description-divergence report and restores any admin edit back to these
 * values — so once copy is being maintained in the admin UI, update this file too or stop running it.
 *
 * Run with:  npx tsx db/seed-assistant-content.ts
 * (Requires NETLIFY_DATABASE_URL / DATABASE_URL. Apply db/assistant-content.sql first.)
 */

import { config } from 'dotenv';
import * as path from 'path';
config({ path: path.resolve(process.cwd(), '.env') });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { masterAssistants, assistantFeatureDefs } from './schema';

const connectionString = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('NETLIFY_DATABASE_URL / DATABASE_URL is not set.');

const client = postgres(connectionString, { max: 1 });
const db = drizzle({ client });

interface RoleContent {
    roleKey: string;
    tagline: string;
    // Only set for the 7 MIGRATED roles, where the detail page's copy differed from the DB's and has
    // to win to keep the page identical. Omitted for authored copy, which leaves the DB description
    // (already the live card copy) alone.
    description?: string;
    keyFeatures: string[];
    integrations: string[];
    video?: { url: string | null; title: string; poster?: string };
}

// ── 1. MIGRATED ────────────────────────────────────────────────────────────────
// Transcribed verbatim from src/config/assistant-role-content.js (deleted by this change).
// Do not reword here — this array exists to prove the migration changed nothing on the page.
const MIGRATED: RoleContent[] = [
    {
        roleKey: 'social_media_manager',
        tagline: 'Consistent, on-brand content — without the daily grind.',
        description: 'Plans, writes, and schedules branded content across all your social channels. Every post lands in your Review for approval, so nothing goes out without your sign-off.',
        keyFeatures: [
            'Automated Content Drafting & Scheduling',
            'Human-in-the-loop Review',
            'Per-platform Hashtag & Format Strategy',
        ],
        integrations: ['Facebook', 'Instagram', 'LinkedIn', 'X (Twitter)', 'Threads', 'TikTok', 'YouTube'],
        // url null = the modal renders a branded 16:9 placeholder slot. Set it to go live.
        video: { url: null, title: 'Watch the Social Media Manager in action' },
    },
    {
        roleKey: 'blog_writer',
        tagline: 'Long-form content in your voice — researched, written, and published on a cadence you set.',
        description: 'Researches, drafts, and schedules long-form blog posts in your brand voice, then publishes them to your site via the native widget — or straight to WordPress, Ghost, Hashnode and Dev.to. You review and approve each one; it handles the rest.',
        keyFeatures: [
            'Long-form Drafting in Your Brand Voice',
            'Human-in-the-loop Review & Approval',
            'Native Site Widget + One-Click Publishing',
        ],
        integrations: ['Native Widget', 'WordPress', 'Ghost', 'Hashnode', 'Dev.to', 'Google Search Console'],
    },
    {
        roleKey: 'lead_qualifier',
        tagline: 'Stop chasing cold leads. Let AI find your next best customer.',
        description: 'Researches inbound leads, scores them based on your Ideal Customer Profile (ICP), and drafts personalized outreach emails—so your sales team only talks to winners.',
        keyFeatures: [
            'Automated Lead Scoring',
            'Personalized Outreach Drafting',
            'Handoff to CRM Enricher for missing data',
        ],
        integrations: ['HubSpot', 'Salesforce', 'LinkedIn', 'Gmail'],
    },
    {
        roleKey: 'accounts_receivable_clerk',
        tagline: 'Protect your cash flow without the awkward conversations.',
        description: 'Politely but persistently chases unpaid invoices, drafts payment reminders, and logs notes directly into your accounting software.',
        keyFeatures: [
            'Automated Dunning Sequences',
            'Smart Thresholds (ignores small balances)',
            'Live Ledger Syncing',
        ],
        integrations: ['Xero', 'QuickBooks', 'Gmail'],
    },
    {
        roleKey: 'crm_enricher',
        tagline: 'Keep your CRM spotless and actionable.',
        description: 'Scours the web to fill in missing contact details—company size, funding stage, LinkedIn profiles—for every new lead in your database.',
        keyFeatures: [
            'Deep Data Enrichment',
            'Blank-Field Detection',
            'Smart Overwrite Protection',
        ],
        integrations: ['HubSpot', 'Salesforce', 'LinkedIn'],
    },
    {
        roleKey: 'tier1_support_agent',
        tagline: 'Cut your first-response times to zero.',
        description: 'Instantly resolves common FAQs—refunds, password resets, shipping times—and seamlessly escalates complex issues to your human team with full context.',
        keyFeatures: [
            'Automated Ticket Resolution',
            'Sentiment Analysis',
            'Smart Human Escalation',
        ],
        integrations: ['Zendesk', 'Intercom', 'Gmail'],
    },
    {
        roleKey: 'meeting_note_taker',
        tagline: 'Never lose an action item again.',
        description: 'Attends virtual meetings, transcribes the conversation, and instantly extracts action items—assigning them to the right people before the call even ends.',
        keyFeatures: [
            'Executive Summaries',
            'Action Item Extraction',
            'Direct Project Board Syncing',
        ],
        integrations: ['Zoom', 'Slack', 'Notion', 'Jira'],
    },
];

// ── 2. AUTHORED ────────────────────────────────────────────────────────────────
// Copy for the 12 roles that never had any — they were invisible behind the old `hasDetail` gate, so
// exposing their detail pages surfaced the gap. Drafted and approved 2026-07-16.
//
// `description` is deliberately omitted for every role here: the DB already has one (it's what the
// catalogue card renders) and it's good. This array only fills the blanks.
//
// ⚠️ INTEGRATIONS ARE FORWARD-LOOKING. Every role here is comingSoon, and several named integrations
// have NO connector built yet — marked "not built" below. This matches existing shipped copy (the
// Social Media Manager card names Facebook/Instagram/LinkedIn, none of which have connectors), but it
// is a marketing promise, not a capability list. Revisit before any of these roles goes live.
const AUTHORED: RoleContent[] = [
    {
        roleKey: 'calendar_coordinator',
        tagline: 'Your day, arranged before you open your laptop.',
        keyFeatures: ['Cross-Time-Zone Scheduling', 'Daily Agenda Briefings', 'Conflict & Buffer Protection'],
        integrations: ['Google Calendar', 'Outlook Calendar', 'Slack'],   // Calendar providers not built
    },
    {
        roleKey: 'document_organizer',
        tagline: 'A filing cabinet that files itself.',
        keyFeatures: ['Automatic Renaming & Tagging', 'Rule-Based Folder Routing', 'Duplicate & Clutter Detection'],
        integrations: ['Google Drive', 'Dropbox', 'OneDrive', 'Notion'],  // only Notion built
    },
    {
        roleKey: 'inbox_manager',
        tagline: 'Reach the bottom of your inbox — without reading all of it.',
        keyFeatures: ['Drafted Replies in Your Voice', 'Automatic Triage & Categorisation', 'Urgent-Issue Escalation'],
        integrations: ['Gmail', 'Outlook', 'Slack'],                      // Outlook not built
    },
    {
        roleKey: 'client_onboarding_guide',
        tagline: "Every client's first week, handled.",
        keyFeatures: ['Automated Welcome Sequences', 'Missing-Form Chasing', 'Kick-Off Call Scheduling'],
        integrations: ['Gmail', 'Google Calendar', 'HubSpot', 'Slack'],   // Google Calendar not built
    },
    {
        roleKey: 'review_reputation_manager',
        tagline: 'Your reputation, defended around the clock.',
        keyFeatures: ['Multi-Platform Review Monitoring', 'Drafted Responses for Approval', 'Sentiment & Trend Alerts'],
        integrations: ['Trustpilot', 'Google Business Profile', 'Slack'], // review platforms not built
    },
    {
        roleKey: 'sql_data_analyst',
        tagline: 'Ask your data a question. Get an answer, not a ticket.',
        keyFeatures: ['Plain-English Querying', 'Instant Charts & Summaries', 'Read-Only, Scoped Access'],
        integrations: ['Stripe', 'PostgreSQL', 'Xero', 'QuickBooks'],     // Stripe is billing-only; no user DB connector
    },
    {
        roleKey: 'competitor_intel_analyst',
        tagline: 'Know exactly how you stack up — every week, without asking.',
        keyFeatures: ['Weekly Competitor Sweeps', 'Auto-Updated Battle Cards', 'Pricing & Positioning Change Alerts'],
        integrations: ['G2', 'HubSpot', 'Notion', 'Slack'],               // G2 not built
    },
    {
        roleKey: 'newsletter_editor',
        tagline: 'A newsletter worth opening — without the weekly scramble.',
        keyFeatures: ['Curated Industry Round-Ups', 'Ready-to-Send Campaign Formatting', 'Human-in-the-loop Review'],
        integrations: ['Mailchimp', 'Gmail', 'Slack'],                    // Mailchimp not built
    },
    {
        roleKey: 'rfp_proposal_responder',
        tagline: 'Turn weeks of enterprise paperwork into a same-day reply.',
        keyFeatures: ['Answer Reuse from Past Wins', 'Security Questionnaire Drafting', 'Source-Linked Citations'],
        integrations: ['Notion', 'Google Drive', 'Salesforce', 'Slack'],  // Google Drive not built
    },
    {
        roleKey: 'seo_content_strategist',
        tagline: 'Rank for what your buyers actually search.',
        keyFeatures: ['Keyword Research & Clustering', 'SEO-Optimised Drafting', 'Search Console Feedback Loop'],
        integrations: ['Google Search Console', 'WordPress', 'Notion'],   // all three built
    },
    {
        roleKey: 'sop_writer',
        tagline: "Document the process while you're doing it.",
        keyFeatures: ['Voice Note & Screen Recording Capture', 'Step-by-Step Manual Formatting', 'Version-Controlled Updates'],
        integrations: ['Notion', 'Google Drive', 'Slack'],                // Google Drive not built
    },
    {
        roleKey: 'status_report_generator',
        tagline: 'Leadership updated. Without the Sunday-night write-up.',
        keyFeatures: ['Automatic Data Pull from Your Boards', 'Executive-Ready Summaries', 'Risk & Slippage Flagging'],
        integrations: ['Jira', 'Asana', 'Monday.com', 'Slack'],           // Monday.com not built
    },
];

const CONTENT: RoleContent[] = [...MIGRATED, ...AUTHORED];

// Transcribed verbatim from src/config/assistant-features.ts (ASSISTANT_FEATURES removed by this change).
// Order here IS the display order.
const FEATURE_DEFS = [
    {
        key: 'ai_image_generation',
        label: 'AI Image Generation',
        description: 'Generate images with AI in My Content.',
        category: 'Media',
    },
    {
        key: 'ai_video_generation',
        label: 'AI Video Generation',
        description: 'Generate videos with AI in My Content (a premium plan is also required).',
        category: 'Media',
    },
    {
        key: 'relationship_building_checklist',
        label: 'Relationship Building Checklist',
        description: 'Daily AI-generated checklist of engagement, outreach, and community tasks. Reserved for a future assistant type — not available for Social Media Manager.',
        category: 'Engagement',
    },
];

async function main() {
    // 1. Capability catalog (idempotent on key). displayOrder = array index.
    console.log(`Seeding ${FEATURE_DEFS.length} assistant feature definitions…`);
    for (let i = 0; i < FEATURE_DEFS.length; i++) {
        const d = FEATURE_DEFS[i];
        await db.insert(assistantFeatureDefs).values({
            key: d.key, label: d.label, description: d.description, category: d.category,
            displayOrder: i, isEnabled: true,
        }).onConflictDoUpdate({
            target: assistantFeatureDefs.key,
            set: {
                label: d.label, description: d.description, category: d.category,
                displayOrder: i, updatedAt: new Date(),
            },
        });
    }
    console.log('✓ Feature catalog upserted.');

    // 2. Copy columns: MIGRATED roles (verbatim from the deleted file) + AUTHORED roles (new copy).
    console.log(`\nSeeding copy for ${CONTENT.length} roles (${MIGRATED.length} migrated, ${AUTHORED.length} authored)…`);
    const diffs: Array<{ roleKey: string; db: string; file: string }> = [];
    let missing = 0;

    for (const c of CONTENT) {
        const [ma] = await db.select().from(masterAssistants)
            .where(eq(masterAssistants.roleKey, c.roleKey)).limit(1);
        if (!ma) { console.warn(`⚠  master assistant '${c.roleKey}' not found — skipping.`); missing++; continue; }

        if (c.description !== undefined && (ma.description ?? '') !== c.description) {
            diffs.push({ roleKey: c.roleKey, db: ma.description ?? '(null)', file: c.description });
        }

        await db.update(masterAssistants).set({
            tagline: c.tagline,
            // Only the migrated roles carry a description — authored copy leaves the DB's alone.
            ...(c.description !== undefined ? { description: c.description } : {}),
            keyFeatures: c.keyFeatures,
            integrations: c.integrations,
            video: c.video ?? null,
            updatedAt: new Date(),
        }).where(eq(masterAssistants.id, ma.id));
        console.log(`✓ ${c.roleKey}: ${c.keyFeatures.length} features, ${c.integrations.length} integrations${c.video ? ', video slot' : ''}.`);
    }

    // 3. Report — which roles got no copy, and where the two descriptions had drifted.
    const all = await db.select({ roleKey: masterAssistants.roleKey, name: masterAssistants.name })
        .from(masterAssistants).where(eq(masterAssistants.isActive, true));
    const seeded = new Set(CONTENT.map(c => c.roleKey));
    const uncovered = all.filter(a => !seeded.has(a.roleKey));

    if (uncovered.length) {
        console.log(`\n${uncovered.length} active roles have NO hardcoded copy to migrate — they render with an empty`);
        console.log('Key Features list until copy is added in Admin → Master Data → Assistants:');
        for (const a of uncovered) console.log(`   · ${a.roleKey} (${a.name})`);
    }

    if (diffs.length) {
        console.log(`\n⚠  ${diffs.length} role(s) had a DIFFERENT description in the DB vs the hardcoded file.`);
        console.log('   The card and the detail modal were showing different copy. The file value won —');
        console.log('   review each, and correct in Admin → Master Data → Assistants if the DB one was better:\n');
        for (const d of diffs) {
            console.log(`   ${d.roleKey}`);
            console.log(`     was (DB, on the card):   ${d.db}`);
            console.log(`     now (file, on the page): ${d.file}\n`);
        }
    } else {
        console.log('\n✓ No description divergence found.');
    }

    if (missing) console.log(`\n⚠  ${missing} role(s) in the content file had no master_assistants row.`);
    console.log('\nDone. Verify the detail page renders identically, then the copy is live.');
    await client.end();
}

main().catch(async (err) => { console.error(err); await client.end(); process.exit(1); });
