-- scripts/sql/staging-catalog-sync-2026-10-12.sql — make STAGING's assistant catalogue match PRODUCTION.
--
-- ⚠️ STAGING ONLY. Not a migration (kept out of db/ so the migration runner never picks it up).
-- Generated 2026-10-12 from production's public catalogue (/.netlify/functions/master-assistants),
-- because staging had drifted: Accounts Receivable Clerk and Minute Taker showed as Live there but are
-- Coming soon on prod, Brand Designer was Coming soon there but is Live on prod, and the campaign role
-- was still named "Campaign Assistant" (prod: "Marketing Campaign Orchestrator").
--
-- Status is written as the same three columns admin-assistants.ts writes (src/utils/assistant-go-live.ts
-- columnsFor): live → active, not coming soon, 'live'; coming soon → active, coming soon, 'review'.
-- Roles prod does not list at all are Hidden or Retired there; any still active on staging become Hidden.
-- Copy (name, tagline, description, features, integrations, works-with, category, icon) is copied too.
-- Semicolons inside text are written as chr(59) so a web SQL editor that splits on ';' cannot cut a
-- statement in half.
-- The video column is NOT touched — db/z-assistant-showcases.sql owns it.

BEGIN;

UPDATE master_assistants SET is_active = true, coming_soon = false, lifecycle_state = 'live',
    name = 'Social Media Assistant', category = 'Marketing & Sales', icon_key = 'megaphone', icon_color = 'pink',
    tagline = 'Consistent, on-brand content — without the daily grind.', description = 'Plans, writes, and schedules branded content across all your social channels. Every post lands in your Review for approval, so nothing goes out without your sign-off.',
    key_features = $j$["Automated Content Drafting & Scheduling", "Human-in-the-loop Review", "Per-platform Hashtag & Format Strategy"]$j$::jsonb, integrations = $j$["Facebook  (Coming soon)", "Instagram  (Coming soon)", "LinkedIn", "X (Twitter)", "Threads  (Coming soon)", "TikTok (Coming soon)", "YouTube", "Canva"]$j$::jsonb, works_with = $j$["standalone"]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'social_media_manager';
UPDATE master_assistants SET is_active = true, coming_soon = false, lifecycle_state = 'live',
    name = 'Lead Generation Assistant', category = 'Marketing & Sales', icon_key = 'chart', icon_color = 'blue',
    tagline = 'Stop chasing cold leads. Let AI find your next best customer.', description = 'Researches inbound leads, scores them based on your Ideal Customer Profile (ICP), and drafts personalised outreach emails — so your sales team only talks to winners.',
    key_features = $j$["Automated Lead Scoring", "Personalised Outreach Drafting", "Handoff to CRM Enricher for missing data"]$j$::jsonb, integrations = $j$["CRM (Coming Soon)", "Gmail", "Outlook (Coming Soon)"]$j$::jsonb, works_with = $j$["standalone"]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'lead_qualifier';
UPDATE master_assistants SET is_active = true, coming_soon = false, lifecycle_state = 'live',
    name = 'Blog Writing Assistant', category = 'Marketing & Sales', icon_key = 'document', icon_color = 'pink',
    tagline = 'Long-form content in your voice — researched, written, and published on a cadence you set.', description = 'Researches, drafts, and schedules long-form blog posts in your brand voice, then publishes them to your site via the native widget on a cadence you set. Each published post can also be shared to your LinkedIn feed and submitted to The Swan Index, always linking back to your own page. You review and approve each one' || chr(59) || ' it handles the rest.',
    key_features = $j$["Long-form Drafting in Your Brand Voice", "Human-in-the-loop Review & Approval", "Native Site Widget + One-Click Publishing"]$j$::jsonb, integrations = $j$["Native Widget", "LinkedIn", "The Swan Index", "Google Search Console"]$j$::jsonb, works_with = $j$["standalone"]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'blog_writer';
UPDATE master_assistants SET is_active = true, coming_soon = false, lifecycle_state = 'live',
    name = 'Email Marketing Assistant', category = 'Marketing & Sales', icon_key = 'mail', icon_color = 'teal',
    tagline = 'Newsletters and email campaigns worth opening — without the weekly scramble.', description = 'Writes your regular emails and short email campaigns — from a welcome series for new subscribers to renewal reminders and win-backs — in your brand voice, personalised for each subscriber. A sign-up form for your website, or a shareable sign-up page if you don''t have one, grows your list. You review and approve every email before it sends.',
    key_features = $j$["Automated Campaigns & Sequences: Easily set up structured email flows for client onboarding, product purchases, or subscription renewals.", "Drafts in Your Brand Voice: Understands your style to ensure every broadcast and automated email sounds exactly like you.", "Sign-Up Form or Shareable Page", "You Approve Every Email"]$j$::jsonb, integrations = $j$["Your own sending domain", "Gmail", "Outlook", "Any website, via embed code"]$j$::jsonb, works_with = $j$["standalone", "social_media_manager", "campaign_orchestrator"]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'newsletter_editor';
UPDATE master_assistants SET is_active = true, coming_soon = false, lifecycle_state = 'live',
    name = 'Marketing Campaign Orchestrator', category = 'Marketing & Sales', icon_key = 'megaphone', icon_color = 'purple',
    tagline = 'One objective. Every assistant pulling the same way.', description = 'Turns one business objective into a campaign — then briefs your other assistants, allocates their time across the work, and reallocates it when something is not landing. You approve the plan' || chr(59) || ' it runs the campaign.',
    key_features = $j$["One Objective, Briefed to Every Assistant", "Budgets Measured in Work, Not Guesswork", "Reallocates Effort When Something Is Not Landing"]$j$::jsonb, integrations = $j$["Meta Ads (coming soon)", "Google Ads (coming soon)", "LinkedIn Ads (coming soon)"]$j$::jsonb, works_with = $j$["social_media_manager", "blog_writer", "lead_qualifier", "brand_designer"]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'campaign_orchestrator';
UPDATE master_assistants SET is_active = true, coming_soon = false, lifecycle_state = 'live',
    name = 'Brand Designer', category = 'Marketing & Sales', icon_key = 'lightning', icon_color = 'pink',
    tagline = 'Say what the picture is for. Approve the one that fits.', description = 'Turns a brief into on-brand pictures — stock photos, AI images and branded cards made from your colours, font and logo — and puts the options in front of you to approve. Anything you approve lands in your library for every assistant to use.',
    key_features = $j$["Briefs, Not Prompts", "Stock, AI and Branded Cards Side by Side", "Nothing Is Used Until You Approve It", "Bring In Your Own and Canva Designs"]$j$::jsonb, integrations = $j$["Design"]$j$::jsonb, works_with = $j$["social_media_manager", "campaign_orchestrator", "blog_writer"]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'brand_designer';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'Inbox Assistant', category = 'Administration', icon_key = 'mail', icon_color = 'blue',
    tagline = 'Reach the bottom of your inbox — without reading all of it.', description = 'Drafts replies to standard emails, categorizes incoming messages, and highlights urgent issues — eliminating email fatigue before your day begins.',
    key_features = $j$["Drafted Replies in Your Voice", "Automatic Triage & Categorisation", "Urgent-Issue Escalation"]$j$::jsonb, integrations = $j$["Gmail", "Outlook", "Slack"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'inbox_manager';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'Diary Assistant', category = 'Administration', icon_key = 'cog', icon_color = 'purple',
    tagline = 'Your day, arranged before you open your laptop.', description = 'Negotiates meeting times across different time zones and prepares daily schedule briefings so you never start the day lost.',
    key_features = $j$["Cross-Time-Zone Scheduling", "Daily Agenda Briefings", "Conflict & Buffer Protection"]$j$::jsonb, integrations = $j$["Google Calendar", "Outlook Calendar", "Slack"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'calendar_coordinator';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'Document Filing Assistant', category = 'Administration', icon_key = 'document', icon_color = 'orange',
    tagline = 'A filing cabinet that files itself.', description = 'Automatically renames, tags, and files loose documents, PDFs, and assets into the correct cloud folders — your digital filing cabinet, always tidy.',
    key_features = $j$["Automatic Renaming & Tagging", "Rule-Based Folder Routing", "Duplicate & Clutter Detection"]$j$::jsonb, integrations = $j$["Google Drive", "Dropbox", "OneDrive", "Notion"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'document_organizer';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'SEO Assistant', category = 'Marketing & Sales', icon_key = 'document', icon_color = 'green',
    tagline = 'Rank for what your buyers actually search.', description = 'Takes a rough topic, researches keywords, and drafts fully formatted, SEO-optimised blog posts — brand consistency at scale.',
    key_features = $j$["Keyword Research & Clustering", "SEO-Optimised Drafting", "Search Console Feedback Loop"]$j$::jsonb, integrations = $j$["Google Search Console", "WordPress", "Notion"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'seo_content_strategist';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'CRM Data Assistant', category = 'Marketing & Sales', icon_key = 'cog', icon_color = 'purple',
    tagline = 'Keep your CRM spotless and actionable.', description = 'Scours the web to fill in missing contact details—company size, funding stage, LinkedIn profiles—for every new lead in your database.',
    key_features = $j$["Deep Data Enrichment", "Blank-Field Detection", "Smart Overwrite Protection"]$j$::jsonb, integrations = $j$["HubSpot", "Salesforce", "LinkedIn"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'crm_enricher';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'Proposal Writing Assistant', category = 'Marketing & Sales', icon_key = 'document', icon_color = 'purple',
    tagline = 'Turn weeks of enterprise paperwork into a same-day reply.', description = 'Uses RAG to search your past successful proposals and auto-drafts responses to new RFPs and security questionnaires — turns weeks of enterprise paperwork into a same-day turnaround.',
    key_features = $j$["Answer Reuse from Past Wins", "Security Questionnaire Drafting", "Source-Linked Citations"]$j$::jsonb, integrations = $j$["Notion", "Google Drive", "Salesforce", "Slack"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'rfp_proposal_responder';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'Competitor Research Assistant', category = 'Marketing & Sales', icon_key = 'globe', icon_color = 'pink',
    tagline = 'Know exactly how you stack up — every week, without asking.', description = 'Scrapes competitor websites, pricing pages, and G2 reviews every week and compiles updated battle cards for your sales team — know exactly how you stack up, always.',
    key_features = $j$["Weekly Competitor Sweeps", "Auto-Updated Battle Cards", "Pricing & Positioning Change Alerts"]$j$::jsonb, integrations = $j$["G2", "HubSpot", "Notion", "Slack"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'competitor_intel_analyst';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'SOP Drafting Assistant', category = 'Operations', icon_key = 'document', icon_color = 'green',
    tagline = 'Document the process while you''re doing it.', description = 'Takes messy voice notes or screen recordings and turns them into formatted, step-by-step training manuals — your processes documented while you work.',
    key_features = $j$["Voice Note & Screen Recording Capture", "Step-by-Step Manual Formatting", "Version-Controlled Updates"]$j$::jsonb, integrations = $j$["Notion", "Google Drive", "Slack"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'sop_writer';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'First-Line Support Assistant', category = 'Customer Success & Support', icon_key = 'smile', icon_color = 'teal',
    tagline = 'Cut your first-response times to zero.', description = 'Instantly resolves common FAQs—refunds, password resets, shipping times—and seamlessly escalates complex issues to your human team with full context.',
    key_features = $j$["Automated Ticket Resolution", "Sentiment Analysis", "Smart Human Escalation"]$j$::jsonb, integrations = $j$["Zendesk", "Intercom", "Gmail"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'tier1_support_agent';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'Client Onboarding Assistant', category = 'Customer Success & Support', icon_key = 'lightning', icon_color = 'blue',
    tagline = 'Every client''s first week, handled.', description = 'Sends welcome packets, chases missing onboarding forms, and schedules kick-off calls — every client starts their journey feeling looked after.',
    key_features = $j$["Automated Welcome Sequences", "Missing-Form Chasing", "Kick-Off Call Scheduling"]$j$::jsonb, integrations = $j$["Gmail", "Google Calendar", "HubSpot", "Slack"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'client_onboarding_guide';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'Reputation Management Assistant', category = 'Customer Success & Support', icon_key = 'megaphone', icon_color = 'pink',
    tagline = 'Your reputation, defended around the clock.', description = 'Monitors Trustpilot, Google, and more — drafts polite responses to negative reviews and thanks positive reviewers — your reputation protected 24/7.',
    key_features = $j$["Multi-Platform Review Monitoring", "Drafted Responses for Approval", "Sentiment & Trend Alerts"]$j$::jsonb, integrations = $j$["Trustpilot", "Google Business Profile", "Slack"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'review_reputation_manager';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'Minute Taker', category = 'Project Management', icon_key = 'document', icon_color = 'blue',
    tagline = 'Never lose an action item again.', description = 'Attends virtual meetings, transcribes the conversation, and instantly extracts action items—assigning them to the right people before the call even ends.',
    key_features = $j$["Executive Summaries", "Action Item Extraction", "Direct Project Board Syncing"]$j$::jsonb, integrations = $j$["Zoom", "Slack", "Notion", "Jira"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'meeting_note_taker';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'Project Reporting Assistant', category = 'Project Management', icon_key = 'chart', icon_color = 'green',
    tagline = 'Leadership updated. Without the Sunday-night write-up.', description = 'Pulls data from Jira, Asana, or Monday.com to create weekly executive summaries on project health — leadership always in the loop.',
    key_features = $j$["Automatic Data Pull from Your Boards", "Executive-Ready Summaries", "Risk & Slippage Flagging"]$j$::jsonb, integrations = $j$["Jira", "Asana", "Monday.com", "Slack"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'status_report_generator';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'Accounts Receivable Clerk', category = 'Finance & Bookkeeping', icon_key = 'chart', icon_color = 'orange',
    tagline = 'Protect your cash flow without the awkward conversations.', description = 'Politely but persistently chases unpaid invoices, drafts payment reminders, and logs notes directly into your accounting software.',
    key_features = $j$["Automated Dunning Sequences", "Smart Thresholds (ignores small balances)", "Live Ledger Syncing"]$j$::jsonb, integrations = $j$["Xero", "QuickBooks", "Gmail"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'accounts_receivable_clerk';
UPDATE master_assistants SET is_active = true, coming_soon = true, lifecycle_state = 'review',
    name = 'Data Analysis Assistant', category = 'Finance & Bookkeeping', icon_key = 'chart', icon_color = 'teal',
    tagline = 'Ask your data a question. Get an answer, not a ticket.', description = 'Connects securely to Stripe or your database so you can ask plain-English questions like "What was our net revenue retention last month?" and get instant answers and charts.',
    key_features = $j$["Plain-English Querying", "Instant Charts & Summaries", "Read-Only, Scoped Access"]$j$::jsonb, integrations = $j$["Stripe", "PostgreSQL", "Xero", "QuickBooks"]$j$::jsonb, works_with = $j$[]$j$::jsonb,
    updated_at = now()
  WHERE role_key = 'sql_data_analyst';

-- Not listed on production → Hidden on staging (retired rows are left as they are).
UPDATE master_assistants SET is_active = false, coming_soon = false, lifecycle_state = 'draft', updated_at = now()
  WHERE is_active = true AND role_key NOT IN ('social_media_manager', 'lead_qualifier', 'blog_writer', 'newsletter_editor', 'campaign_orchestrator', 'brand_designer', 'inbox_manager', 'calendar_coordinator', 'document_organizer', 'seo_content_strategist', 'crm_enricher', 'rfp_proposal_responder', 'competitor_intel_analyst', 'sop_writer', 'tier1_support_agent', 'client_onboarding_guide', 'review_reputation_manager', 'meeting_note_taker', 'status_report_generator', 'accounts_receivable_clerk', 'sql_data_analyst');

COMMIT;

-- Check: should list 6 live and 15 coming soon.
-- SELECT role_key, name, is_active, coming_soon, lifecycle_state FROM master_assistants ORDER BY is_active DESC, coming_soon, role_key;
