/**
 * db/seed-catalog.ts
 *
 * Upserts every master assistant role into the database.
 * Safe to re-run — uses ON CONFLICT (role_key) DO UPDATE so existing
 * records get refreshed with the latest description / metadata.
 *
 * Run with:
 *   npx tsx db/seed-catalog.ts
 * (ts-node exits silently without running the script in this repo — use tsx.)
 */

import { config } from 'dotenv';
import * as path from 'path';
config({ path: path.resolve(process.cwd(), '.env') });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { masterAssistants, masterPlans, integrationProviders, integrationScenarios, featureRequests } from './schema';
import { sql, eq } from 'drizzle-orm';

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
        isActive: false,   // killed — booking liability (AI hallucinating a non-refundable flight) too high for v1
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
        comingSoon: false,   // ← Currently Live
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
        roleKey: 'blog_writer',
        name: 'The Blog Writer',
        description: 'Researches, drafts, and schedules long-form blog posts in your brand voice — then publishes them to your site via the native widget on a cadence you set. Review and approve; it handles the rest.',
        category: 'Marketing & Sales',
        iconKey: 'document',
        iconColor: 'pink',
        comingSoon: false,   // ← Live: powers the Blog Studio (Content Engine)
        isActive: true,
    },
    {
        roleKey: 'crm_enricher',
        name: 'The CRM Enricher',
        description: 'Scours the web to fill in missing contact details — LinkedIn profiles, company size, funding stage — for every new lead in your database.',
        category: 'Marketing & Sales',
        iconKey: 'cog',
        iconColor: 'purple',
        comingSoon: false,   // ← Currently Live (Tier 1, Batch 2)
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
    {
        roleKey: 'rfp_proposal_responder',
        name: 'The RFP & Proposal Responder',
        description: 'Uses RAG to search your past successful proposals and auto-drafts responses to new RFPs and security questionnaires — turns weeks of enterprise paperwork into a same-day turnaround.',
        category: 'Marketing & Sales',
        iconKey: 'document',
        iconColor: 'purple',
        comingSoon: true,
        isActive: true,
    },
    {
        roleKey: 'competitor_intel_analyst',
        name: 'The Competitor Intel Analyst',
        description: 'Scrapes competitor websites, pricing pages, and G2 reviews every week and compiles updated battle cards for your sales team — know exactly how you stack up, always.',
        category: 'Marketing & Sales',
        iconKey: 'globe',
        iconColor: 'pink',
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
        isActive: false,   // delayed — deep Shopify/ERP integration needed before this can automate reorders confidently
    },
    {
        roleKey: 'inventory_tracker',
        name: 'The Inventory Tracker',
        description: 'Monitors stock levels across platforms and drafts reorder requests when supplies dip below a threshold — stockouts become a thing of the past.',
        category: 'Operations',
        iconKey: 'chart',
        iconColor: 'blue',
        comingSoon: true,
        isActive: false,   // delayed — parked until there's a dedicated e-commerce user base demanding it
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
        comingSoon: false,   // ← Currently Live (Tier 1, Batch 2)
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
        isActive: false,   // killed — Slack/Teams native workflow builders and Geekbot already own this cheaply
    },
    {
        roleKey: 'meeting_note_taker',
        name: 'The Meeting Note Taker',
        description: 'Attends virtual meetings, transcribes the conversation, and instantly extracts action items — assigned to the right people before the call ends.',
        category: 'Project Management',
        iconKey: 'document',
        iconColor: 'blue',
        comingSoon: false,   // ← Currently Live (Tier 1, Batch 3)
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
        comingSoon: false,   // ← Currently Live
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
        isActive: false,   // delayed — Xero/QuickBooks already bundle strong native OCR categorization
    },
    {
        roleKey: 'sql_data_analyst',
        name: 'The SQL/Data Analyst',
        description: 'Connects securely to Stripe or your database so you can ask plain-English questions like "What was our net revenue retention last month?" and get instant answers and charts.',
        category: 'Finance & Bookkeeping',
        iconKey: 'chart',
        iconColor: 'teal',
        comingSoon: true,
        isActive: true,
    },
];

// ── Integration Scenario Library ────────────────────────────────────────────────
// Providers users can connect + the browsable recipe library. See
// docs/integration-scenario-library-plan.md. providerKey mirrors the IntegrationProvider
// union in src/utils/workspace-integrations.ts (+ 'custom_webhook' for the Tier-2 recipe).
const PROVIDERS = [
    { providerKey: 'hubspot', displayName: 'HubSpot', category: 'crm', authType: 'oauth2', logoKey: 'hubspot' },
    { providerKey: 'salesforce', displayName: 'Salesforce', category: 'crm', authType: 'oauth2', logoKey: 'salesforce' },
    { providerKey: 'custom_webhook', displayName: 'Custom Webhook (Zapier / Make)', category: 'generic', authType: 'webhook_url', logoKey: 'webhook' },
    { providerKey: 'slack', displayName: 'Slack', category: 'comms', authType: 'oauth2', logoKey: 'slack' },
    { providerKey: 'notion', displayName: 'Notion', category: 'productivity', authType: 'oauth2', logoKey: 'notion' },
    { providerKey: 'pipedrive', displayName: 'Pipedrive', category: 'crm', authType: 'oauth2', logoKey: 'pipedrive' },
    { providerKey: 'zoho', displayName: 'Zoho CRM', category: 'crm', authType: 'oauth2', logoKey: 'zoho' },
    // Connection-optional: sends from a connected Gmail if present, else from the Be More Swan
    // outbound domain — so its recipes activate with no setup (see integration-scenarios.ts).
    { providerKey: 'email', displayName: 'Email Follow-Up', category: 'comms', authType: 'builtin', logoKey: 'email' },
    // Project management — meeting action items → tickets.
    { providerKey: 'jira', displayName: 'Jira', category: 'pm', authType: 'oauth2', logoKey: 'jira' },
    { providerKey: 'asana', displayName: 'Asana', category: 'pm', authType: 'oauth2', logoKey: 'asana' },
];

// Field maps the FieldMapper renders. bmsField = the canonical BMS lead field the engine
// exposes in the trigger subject; label = UI copy; defaultTarget = suggested external key.
const LEAD_HANDOFF_FIELDS = [
    { bmsField: 'company', label: 'Company name', required: true, defaultTarget: 'company' },
    { bmsField: 'contactName', label: 'Contact name', required: false, defaultTarget: 'firstname' },
    { bmsField: 'contactEmail', label: 'Contact email', required: false, defaultTarget: 'email' },
    { bmsField: 'aiSummary', label: 'AI interaction summary', required: false, defaultTarget: 'ai_summary' },
    { bmsField: 'attribution', label: 'Attribution / source', required: false, defaultTarget: 'lead_source' },
    { bmsField: 'score', label: 'Lead score', required: false, defaultTarget: 'lead_score' },
];

// Meeting handoff (MEETING_BOOKED) → CRM contact/company property update.
const MEETING_CRM_FIELDS = [
    { bmsField: 'company', label: 'Company name', required: true, defaultTarget: 'company' },
    { bmsField: 'contactEmail', label: 'Contact email', required: false, defaultTarget: 'email' },
    { bmsField: 'meetingTime', label: 'Meeting time', required: false, defaultTarget: 'last_meeting_booked' },
    { bmsField: 'meetingSummary', label: 'Meeting summary', required: false, defaultTarget: 'notes_last_meeting' },
    { bmsField: 'meetingLink', label: 'Meeting link', required: false, defaultTarget: 'meeting_link' },
];

// Meeting handoff → Slack / Notion summary post. The summary payload reads these canonical
// meeting fields directly; the map is informational (which fields to include).
const MEETING_SUMMARY_FIELDS = [
    { bmsField: 'meetingSummary', label: 'Meeting summary', required: true, defaultTarget: 'summary' },
    { bmsField: 'meetingTime', label: 'Meeting time', required: false, defaultTarget: 'time' },
    { bmsField: 'tasks', label: 'Action items', required: false, defaultTarget: 'tasks' },
];


// Meeting handoff → PM tickets (Jira/Asana). The create_tasks handler reads the approved
// action_items ledger; these two config values are stored in the recipe's field map and tell it
// which project (+ Jira issue type) to file into.
const MEETING_TASKS_FIELDS = [
    { bmsField: 'projectKey', label: 'Jira project key', required: true, defaultTarget: '' },
    { bmsField: 'issueType', label: 'Issue type', required: false, defaultTarget: 'Task' },
];
const MEETING_ASANA_FIELDS = [
    { bmsField: 'asanaProjectGid', label: 'Asana project ID', required: true, defaultTarget: '' },
];

// tier 1 native | 2 universal webhook | 3 roadmap (greyed + upvotable).
const SCENARIOS = [
    // ── Tier 1: HubSpot (2-way) ──
    {
        scenarioKey: 'hubspot_handoff_push', providerKey: 'hubspot', tier: 1,
        direction: 'outbound', scenarioType: 'handoff_push',
        title: 'Push Qualified Lead to HubSpot',
        description: 'When a lead is qualified or books a meeting, create/update the HubSpot contact with the AI summary and attribution.',
        triggerConfig: { on: 'lead.status_changed', when: ['QUALIFIED'] },
        actionType: 'hubspot_update_record', fieldSchema: LEAD_HANDOFF_FIELDS, status: 'available', sortOrder: 10,
    },
    {
        scenarioKey: 'hubspot_feedback_loop', providerKey: 'hubspot', tier: 1,
        direction: 'inbound', scenarioType: 'feedback_loop',
        title: 'Sync Closed-Won/Lost from HubSpot',
        description: 'When a HubSpot deal reaches Closed Won or Closed Lost, record the outcome on the matching BMS lead to train discovery.',
        triggerConfig: { on: 'crm.deal_stage_changed', stagePath: 'properties.dealstage', identifierPath: 'properties.email', stageMap: { closedwon: 'CLOSED_WON', closedlost: 'CLOSED_LOST' } },
        actionType: null, fieldSchema: [], status: 'available', sortOrder: 11,
    },
    {
        scenarioKey: 'hubspot_suppression_sync', providerKey: 'hubspot', tier: 1,
        direction: 'inbound', scenarioType: 'suppression_sync',
        title: 'Suppress Existing HubSpot Customers',
        description: 'Daily, pull your existing-customer domains from HubSpot so the discovery AI never prospects a current client.',
        triggerConfig: { on: 'schedule.daily' },
        actionType: null, fieldSchema: [], status: 'available', sortOrder: 12,
    },
    // ── Tier 1: Salesforce ──
    {
        scenarioKey: 'salesforce_handoff_push', providerKey: 'salesforce', tier: 1,
        direction: 'outbound', scenarioType: 'handoff_push',
        title: 'Push Qualified Lead to Salesforce',
        description: 'Create/update the Salesforce Contact or Account with the enriched lead fields on qualification.',
        triggerConfig: { on: 'lead.status_changed', when: ['QUALIFIED'] },
        actionType: 'salesforce_update_record', fieldSchema: LEAD_HANDOFF_FIELDS, status: 'available', sortOrder: 20,
    },
    // ── Tier 2: Universal webhook ──
    {
        scenarioKey: 'universal_webhook_handoff', providerKey: 'custom_webhook', tier: 2,
        direction: 'outbound', scenarioType: 'handoff_push',
        title: 'Send Qualified Lead to a Webhook',
        description: 'POST the qualified-lead payload to any URL (Zapier / Make / your own endpoint) for unsupported tools.',
        triggerConfig: { on: 'lead.status_changed', when: ['QUALIFIED'] },
        actionType: null, fieldSchema: LEAD_HANDOFF_FIELDS, status: 'available', sortOrder: 30,
    },
    // ── Meeting handoff (MEETING_BOOKED) — distinct scenario type + field schema ──
    {
        scenarioKey: 'hubspot_meeting_handoff', providerKey: 'hubspot', tier: 1,
        direction: 'outbound', scenarioType: 'meeting_handoff',
        title: 'Log Booked Meeting to HubSpot',
        description: 'When a meeting is booked, stamp the meeting time and summary onto the HubSpot contact.',
        triggerConfig: { on: 'lead.status_changed', when: ['MEETING_BOOKED'] },
        actionType: 'hubspot_update_record', fieldSchema: MEETING_CRM_FIELDS, status: 'available', sortOrder: 40,
    },
    {
        scenarioKey: 'slack_meeting_summary', providerKey: 'slack', tier: 1,
        direction: 'outbound', scenarioType: 'meeting_handoff',
        title: 'Post Booked Meeting to Slack',
        description: 'When a meeting is booked, post the summary and action items to your Slack channel.',
        triggerConfig: { on: 'lead.status_changed', when: ['MEETING_BOOKED'] },
        actionType: 'slack_post_summary', fieldSchema: MEETING_SUMMARY_FIELDS, status: 'available', sortOrder: 41,
    },
    {
        scenarioKey: 'universal_webhook_meeting', providerKey: 'custom_webhook', tier: 2,
        direction: 'outbound', scenarioType: 'meeting_handoff',
        title: 'Send Booked Meeting to a Webhook',
        description: 'POST the booked-meeting payload to any URL (Zapier / Make / your own endpoint).',
        triggerConfig: { on: 'lead.status_changed', when: ['MEETING_BOOKED'] },
        actionType: null, fieldSchema: MEETING_CRM_FIELDS, status: 'available', sortOrder: 42,
    },
    {
        scenarioKey: 'email_meeting_followup', providerKey: 'email', tier: 1,
        direction: 'outbound', scenarioType: 'meeting_handoff',
        title: 'Email a Follow-Up to Attendees',
        description: 'When you approve a meeting, email the reviewed summary and action items to every attendee — from your connected Gmail, or from Be More Swan when no inbox is connected.',
        triggerConfig: { on: 'lead.status_changed', when: ['MEETING_BOOKED'] },
        actionType: 'email_meeting_followup', fieldSchema: [], status: 'available', sortOrder: 43,
    },
    {
        scenarioKey: 'jira_create_tasks', providerKey: 'jira', tier: 1,
        direction: 'outbound', scenarioType: 'meeting_handoff',
        title: 'Create Jira Tickets from Action Items',
        description: 'When you approve a meeting, create one Jira ticket per action item in your chosen project, with the owner and due date captured from the notes.',
        triggerConfig: { on: 'lead.status_changed', when: ['MEETING_BOOKED'] },
        actionType: 'jira_create_tasks', fieldSchema: MEETING_TASKS_FIELDS, status: 'available', sortOrder: 44,
    },
    {
        scenarioKey: 'asana_create_tasks', providerKey: 'asana', tier: 1,
        direction: 'outbound', scenarioType: 'meeting_handoff',
        title: 'Create Asana Tasks from Action Items',
        description: 'When you approve a meeting, create one Asana task per action item in your chosen project, with the owner and due date captured from the notes.',
        triggerConfig: { on: 'lead.status_changed', when: ['MEETING_BOOKED'] },
        actionType: 'asana_create_tasks', fieldSchema: MEETING_ASANA_FIELDS, status: 'available', sortOrder: 45,
    },
    {
        // Zero-config (fieldSchema: []) like email_meeting_followup — the handler files the page
        // under the most-recently-edited page you've shared with the Be More Swan connection, so
        // there's no target to configure. handleNotionCreatePage builds summary + to_do blocks.
        scenarioKey: 'notion_create_page', providerKey: 'notion', tier: 1,
        direction: 'outbound', scenarioType: 'meeting_handoff',
        title: 'Create a Notion Page from Meeting Notes',
        description: 'When you approve a meeting, create a Notion page with the summary and each action item as a to-do — filed under a page you\'ve shared with Be More Swan.',
        triggerConfig: { on: 'lead.status_changed', when: ['MEETING_BOOKED'] },
        actionType: 'notion_create_page', fieldSchema: [], status: 'available', sortOrder: 46,
    },
    // ── Tier 3: Roadmap (greyed, upvotable) ──
    {
        scenarioKey: 'pipedrive_handoff_push', providerKey: 'pipedrive', tier: 3,
        direction: 'two_way', scenarioType: 'handoff_push',
        title: 'Pipedrive 2-Way Sync', description: 'Push qualified leads to Pipedrive and sync deal outcomes back.',
        triggerConfig: {}, actionType: null, fieldSchema: [], status: 'coming_soon', sortOrder: 90,
        roadmapTitle: 'Pipedrive integration',
    },
    {
        scenarioKey: 'zoho_handoff_push', providerKey: 'zoho', tier: 3,
        direction: 'two_way', scenarioType: 'handoff_push',
        title: 'Zoho CRM 2-Way Sync', description: 'Push qualified leads to Zoho CRM and sync deal outcomes back.',
        triggerConfig: {}, actionType: null, fieldSchema: [], status: 'coming_soon', sortOrder: 91,
        roadmapTitle: 'Zoho CRM integration',
    },
];

/** Find-or-create a roadmap feature_request for a Tier-3 scenario so its "Upvote" button
 *  writes into the existing voting system. Idempotent on title. */
async function findOrCreateRoadmapFeature(title: string): Promise<number> {
    const [existing] = await db.select({ id: featureRequests.id }).from(featureRequests).where(eq(featureRequests.title, title)).limit(1);
    if (existing) return existing.id;
    const [created] = await db.insert(featureRequests).values({
        title, description: `Integration Scenario Library roadmap item: ${title}.`,
        category: 'app_core', status: 'planned', source: 'manual',
    }).returning({ id: featureRequests.id });
    return created.id;
}

async function seedIntegrationLibrary() {
    console.log(`\n🔌 Seeding ${PROVIDERS.length} integration providers…`);
    for (const p of PROVIDERS) {
        await db.insert(integrationProviders).values(p).onConflictDoUpdate({
            target: integrationProviders.providerKey,
            set: { displayName: sql`excluded.display_name`, category: sql`excluded.category`, authType: sql`excluded.auth_type`, logoKey: sql`excluded.logo_key` },
        });
    }

    console.log(`🔌 Seeding ${SCENARIOS.length} integration scenarios…`);
    for (const s of SCENARIOS) {
        const { roadmapTitle, ...scenario } = s as typeof s & { roadmapTitle?: string };
        const roadmapFeatureId = roadmapTitle ? await findOrCreateRoadmapFeature(roadmapTitle) : null;
        await db.insert(integrationScenarios).values({ ...scenario, roadmapFeatureId }).onConflictDoUpdate({
            target: integrationScenarios.scenarioKey,
            set: {
                providerKey: sql`excluded.provider_key`, tier: sql`excluded.tier`, direction: sql`excluded.direction`,
                scenarioType: sql`excluded.scenario_type`, title: sql`excluded.title`, description: sql`excluded.description`,
                triggerConfig: sql`excluded.trigger_config`, actionType: sql`excluded.action_type`,
                fieldSchema: sql`excluded.field_schema`, roadmapFeatureId: sql`excluded.roadmap_feature_id`,
                status: sql`excluded.status`, sortOrder: sql`excluded.sort_order`,
            },
        });
        console.log(`  ✓ ${scenario.title}`);
    }
}

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

    await seedIntegrationLibrary();

    console.log('\n✅ Catalog seeded successfully.\n');
    await client.end();
}

seedCatalog().catch(e => {
    console.error('❌ Seed failed:', e);
    client.end();
    process.exit(1);
});
