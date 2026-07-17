-- Renames every assistant ROLE label to a support-framed title (e.g. "The Calendar
-- Coordinator" -> "Diary Assistant"), so the assistant reads as aiding the human
-- rather than managing them.
--
-- Keyed on role_key, never on the current name: master_assistants.name is
-- admin-editable and has already drifted from the seed files in places, so matching
-- on the old name would silently skip the drifted rows. role_key is unique + not null.
--
-- Only master_assistants.name changes here. Deliberately NOT touched:
--   * ai_assistants.name              — the user's own name for their assistant.
--   * ai_assistants.ai_assistant_job_role — a hire-time snapshot; the app already
--     coalesces master_assistants.name over it, so live rows pick the new label up.
--   * onboarding.ts LEGACY_NAME_TO_ROLEKEY — historical session names, not display copy.

BEGIN;

UPDATE master_assistants AS m
SET name = v.new_name, updated_at = now()
FROM (VALUES
    ('inbox_manager',             'Inbox Assistant'),
    ('calendar_coordinator',      'Diary Assistant'),
    ('travel_logistics_booker',   'Travel Assistant'),
    ('document_organizer',        'Document Filing Assistant'),
    ('social_media_manager',      'Social Media Assistant'),
    ('lead_qualifier',            'Lead Generation Assistant'),
    ('seo_content_strategist',    'SEO Assistant'),
    ('blog_writer',               'Blog Writing Assistant'),
    ('crm_enricher',              'CRM Data Assistant'),
    ('newsletter_editor',         'Newsletter Assistant'),
    ('rfp_proposal_responder',    'Proposal Writing Assistant'),
    ('competitor_intel_analyst',  'Competitor Research Assistant'),
    ('vendor_communications_rep', 'Vendor Liaison Assistant'),
    ('inventory_tracker',         'Stock Control Assistant'),
    ('sop_writer',                'SOP Drafting Assistant'),
    ('tier1_support_agent',       'First-Line Support Assistant'),
    ('client_onboarding_guide',   'Client Onboarding Assistant'),
    ('review_reputation_manager', 'Reputation Management Assistant'),
    ('standup_summarizer',        'Stand-up Support Assistant'),
    ('meeting_note_taker',        'Minute Taker'),
    ('status_report_generator',   'Project Reporting Assistant'),
    ('accounts_receivable_clerk', 'Accounts Receivable Clerk'),
    ('expense_categorizer',       'Expenses Assistant'),
    ('sql_data_analyst',          'Data Analysis Assistant'),
    ('paid_ads',                  'Performance Marketing Assistant'),
    ('data_entry',                'Inventory & Order Assistant'),
    ('custom',                    'Operations Assistant')
) AS v(role_key, new_name)
WHERE m.role_key = v.role_key
  AND m.name IS DISTINCT FROM v.new_name;

COMMIT;

-- Verification — expect every row to read as its new support title:
--   SELECT role_key, name FROM master_assistants ORDER BY role_key;
