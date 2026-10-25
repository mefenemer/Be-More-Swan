// src/config/mentor-data-inventory.ts
// Every table that holds a workspace's data, and whether the Business Mentor may read it
// (docs/business-mentor-plan.md §12). Pure.
//
//   always      — in its <workspace> block every turn (src/utils/mentor-snapshot.ts), or in a block
//                 every chat already gets (business identity, products, Brand Knowledge, team activity,
//                 plan and tasks).
//   on_request  — may be read when the conversation needs it. Phase 1a reads none of these yet; each
//                 one is read only once its loader is written, and only for the stated purpose.
//   never       — the Mentor must not read it, for the reason given.
//
// tests/mentor-data-inventory.test.ts fails when a table with an organisation column is missing here,
// when the snapshot reads a table not marked `always`, or when a `never` has no reason. So a new table
// forces a decision rather than being quietly visible or quietly missing. The "What I can see" panel
// and the help article are written from this file.

export type MentorAccess = 'always' | 'on_request' | 'never';
/** `shown` = how the Mentor page's "What I can see" panel and the Mentor's prompt say it to the customer. */
export interface MentorInventoryEntry { access: MentorAccess; reason: string; shown?: string }

function group(access: MentorAccess, reason: string, tables: string[], shown?: string): Record<string, MentorInventoryEntry> {
    return Object.fromEntries(tables.map((t) => [t, shown ? { access, reason, shown } : { access, reason }]));
}

export const MENTOR_DATA_INVENTORY: Readonly<Record<string, MentorInventoryEntry>> = {
    // ── always ────────────────────────────────────────────────────────────────────────────────
    ...group('always', 'The business: what it does and sells (Business Information gaps)', [
        'org_products', 'org_offer_profile', 'org_intro_offer',
    ], 'Your business: Business Information, Products & Services and your offers'),
    ...group('always', 'The team: every assistant, its state and its set-up answers', ['ai_assistants'], 'Your team: each assistant, whether it is active or paused, and its set-up answers'),
    ...group('always', 'Goals and their progress across the team', ['goals'], 'Goals and how close each one is'),
    ...group('always', 'Brand Knowledge, as every chat reads it (business-knowledge.ts)', ['workspace_assets'], 'Brand Knowledge documents and links'),
    ...group('always', 'What the team did and has booked, as every chat reads it (team-activity.ts)', [
        'scheduled_posts', 'blog_posts', 'newsletter_issues',
    ], 'What your assistants did in the last two weeks and what is booked next'),
    ...group('always', 'Plan and task balance, as every chat reads it (chat-plan-snapshot.ts)', [
        'plans', 'usage_counters',
    ], 'Your plan and the tasks used this month'),

    // ── on request ────────────────────────────────────────────────────────────────────────────
    ...group('always', 'Its own strategy documents: the idea check, business plan and marketing plan (§4.4)', ['strategy_documents'], 'Your plans: the idea check, business plan and marketing plan'),
    ...group('always', 'Its own research answers and drafting jobs, with their links (§4.5)', ['mentor_jobs'], 'What it has looked up for you, with the links'),
    ...group('always', 'Its own suggestions and what the user did with them: the weekly cap and what not to suggest again (§3.13)', ['mentor_proposals'], 'Its own suggestions and the ones you dismissed'),
    ...group('on_request', 'Task detail: what spent tasks this month and bonus tasks', ['task_ledger', 'task_bonus']),
    ...group('on_request', 'Drafting jobs in progress, and the compiled assistant brief', ['content_generation_jobs', 'ai_blueprints']),
    ...group('on_request', 'Results: goal measurements and post performance', ['goal_telemetry', 'post_insights', 'manual_follower_counts']),
    ...group('on_request', 'Sales: lead counts, outcomes and reasons (counts, not people)', [
        'discovered_leads', 'revenue_events', 'lead_reject_feedback', 'template_feedback', 'discovery_campaigns', 'discovery_guardrails',
    ]),
    ...group('on_request', 'Customers: counts, segments and reviews — never contact details', [
        'audience_segments', 'org_reviews', 'review_requests', 'review_settings',
    ]),
    ...group('on_request', 'Quiet customers (Phase 3b): name, company and last-contact date only — never message bodies', ['lead_threads']),
    ...group('on_request', 'Overdue invoices: count and total, when Accounts Receivable is active', ['invoices']),
    ...group('on_request', 'Support Agent records: themes and counts; meeting action items', ['assistant_records', 'action_items']),
    ...group('on_request', 'Campaigns and their orders: status, who asked for what', [
        'campaigns', 'campaign_orders', 'orchestration_runs', 'orchestration_links', 'campaign_learnings',
    ]),
    ...group('on_request', 'Website checks and site status, when those assistants are active', [
        'site_audits', 'site_audit_fixes', 'site_audit_briefs', 'sites',
    ]),
    ...group('on_request', 'Email results: sends and link clicks (totals)', ['newsletter_sends', 'newsletter_link_clicks', 'newsletter_sequences']),
    ...group('on_request', 'Brand Designer briefs and Inspo titles', ['visual_briefs', 'inspo_items']),
    ...group('on_request', 'The user\'s own support tickets and issue reports, with status', ['support_tickets', 'issue_reports']),
    ...group('on_request', 'A half-finished assistant set-up, to offer picking it up', ['onboarding_drafts']),
    ...group('on_request', 'Bookings: counts and upcoming, when bookings are in use', ['bookings', 'booking_settings', 'class_sessions']),
    ...group('on_request', 'Team Chat notes addressed to the Mentor', ['team_messages']),
    ...group('on_request', 'Its own chat history with this user (never other assistants\' — §2.8)', ['chat_sessions']),

    // ── never ─────────────────────────────────────────────────────────────────────────────────
    ...group('never', 'Secrets and connection credentials', [
        'vault_secrets', 'api_keys', 'system_connections', 'workspace_integrations', 'stripe_connect_accounts',
        'newsletter_sending_domains', 'webhook_endpoints',
    ], 'Passwords, connection keys and other secrets'),
    ...group('never', 'Contacts\' personal details and consent records (it coaches from counts and segments)', [
        'audience_contacts', 'audience_consent_events', 'audience_confirmations', 'audience_custom_fields',
        'audience_form_submissions', 'lead_opt_outs', 'review_opt_outs', 'suppression_list', 'site_enquiries',
    ], 'Your contacts\' email addresses, phone numbers and consent records'),
    ...group('never', 'Message bodies and transcripts (size and privacy; the owning assistant reads them)', [
        'lead_messages', 'chat_attachments',
    ], 'The emails and messages your leads send'),
    ...group('never', 'People\'s personal details: who belongs to the workspace, logins, IP addresses', [
        'user_organisations', 'login_events', 'team_reads',
    ], 'Your team members\' email addresses and logins'),
    ...group('never', 'Billing and payment internals', [
        'payments', 'stripe_disputes', 'site_orders', 'reward_redemptions', 'reward_audits', 'ai_credit_ledger', 'ai_credit_balance', 'trials', 'plan_moves',
    ], 'Card details and payments'),
    ...group('never', 'What Be More Swan records about the customer, and compliance records', [
        'dpa_acceptances', 'legal_holds', 'beta_endings', 'risk_assessments', 'security_audits', 'agent_anomalies',
        'agent_anomaly_thresholds', 'feature_requests',
    ]),
    ...group('never', 'Platform machinery: queues, logs, runs, caches and internal state, with nothing to coach on', [
        'account_edges', 'account_memory', 'account_nodes', 'action_policies', 'active_scenarios', 'agent_run_events',
        'agent_run_summaries', 'calendar_busy', 'canva_import_jobs', 'content_provenance', 'discovery_jobs',
        'discovery_schedules', 'inspo_chunks', 'inspo_style_profiles', 'kb_chunks', 'media_generation_jobs',
        'pending_actions', 'post_render_jobs', 'rate_limit_states', 'scenario_jobs', 'site_audit_runs', 'site_imports',
        'storage_usage', 'swan_index_posts', 'swan_index_profiles', 'task_runs', 'vector_embeddings', 'webhook_deliveries',
        'webhook_events', 'widget_configs', 'site_domains',
    ]),
    ...group('never', 'Assistant-owned detail the Mentor sees through counts and results instead', [
        'ad_variant_metrics', 'ad_variants', 'audience_forms', 'audience_import_jobs', 'bookable_resources', 'calendar_events',
        'campaign_assets', 'campaign_attributions', 'campaign_budgets', 'campaign_click_events', 'campaign_decisions',
        'campaign_experiments', 'campaign_links', 'campaign_spend_events', 'class_waitlist', 'content_assets', 'kb_articles',
        'newsletter_sequence_enrolments', 'newsletter_sequence_sends', 'newsletter_sequence_steps', 'outreach_sequences',
        'post_idea_suggestions', 'posted_assets', 'relationship_building_tasks', 'sequence_enrolments', 'sequence_steps',
        'strategy_proposals', 'visual_brief_options',
    ]),
};

/**
 * What the customer is told the Mentor sees and never sees: the "What I can see" panel on its Overview
 * tab (netlify/functions/mentor.ts) and the same list in its prompt, so chat and page say the same.
 * `sees` is only what it reads today (`always`); other workspaces and other assistants' chats are never
 * tables of this workspace, so they are added in words.
 */
export function mentorVisibility(): { sees: string[]; never: string[] } {
    const uniq = (access: MentorAccess) => [...new Set(Object.values(MENTOR_DATA_INVENTORY).filter((e) => e.access === access && e.shown).map((e) => e.shown!))];
    return {
        sees: uniq('always'),
        never: [...uniq('never'), 'Any other workspace, even one you also belong to', 'Your chats with your other assistants'],
    };
}

/** The same list for the Mentor's prompt, so "what can you see?" in chat matches the panel. */
export function mentorVisibilityPromptBlock(): string {
    const v = mentorVisibility();
    return `WHAT YOU CAN SEE — if asked, answer from this list only (the same list is on your Overview tab, under "What I can see"):
Sees: ${v.sees.join('; ')}.
Never sees: ${v.never.join('; ')}.`;
}
