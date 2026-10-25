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
export interface MentorInventoryEntry { access: MentorAccess; reason: string }

function group(access: MentorAccess, reason: string, tables: string[]): Record<string, MentorInventoryEntry> {
    return Object.fromEntries(tables.map((t) => [t, { access, reason }]));
}

export const MENTOR_DATA_INVENTORY: Readonly<Record<string, MentorInventoryEntry>> = {
    // ── always ────────────────────────────────────────────────────────────────────────────────
    ...group('always', 'The business: what it does and sells (Business Information gaps)', [
        'org_products', 'org_offer_profile', 'org_intro_offer',
    ]),
    ...group('always', 'The team: every assistant, its state and its set-up answers', ['ai_assistants']),
    ...group('always', 'Goals and their progress across the team', ['goals']),
    ...group('always', 'Brand Knowledge, as every chat reads it (business-knowledge.ts)', ['workspace_assets']),
    ...group('always', 'What the team did and has booked, as every chat reads it (team-activity.ts)', [
        'scheduled_posts', 'blog_posts', 'newsletter_issues',
    ]),
    ...group('always', 'Plan and task balance, as every chat reads it (chat-plan-snapshot.ts)', [
        'plans', 'usage_counters',
    ]),

    // ── on request ────────────────────────────────────────────────────────────────────────────
    ...group('on_request', 'Its own suggestions and what the user did with them — read once the proposal cards ship (§3.13)', ['mentor_proposals']),
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
    ]),
    ...group('never', 'Contacts\' personal details and consent records (it coaches from counts and segments)', [
        'audience_contacts', 'audience_consent_events', 'audience_confirmations', 'audience_custom_fields',
        'audience_form_submissions', 'lead_opt_outs', 'review_opt_outs', 'suppression_list', 'site_enquiries',
    ]),
    ...group('never', 'Message bodies and transcripts (size and privacy; the owning assistant reads them)', [
        'lead_messages', 'chat_attachments',
    ]),
    ...group('never', 'People\'s personal details: who belongs to the workspace, logins, IP addresses', [
        'user_organisations', 'login_events', 'team_reads',
    ]),
    ...group('never', 'Billing and payment internals', [
        'payments', 'stripe_disputes', 'site_orders', 'reward_redemptions', 'reward_audits', 'ai_credit_ledger', 'ai_credit_balance', 'trials', 'plan_moves',
    ]),
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
