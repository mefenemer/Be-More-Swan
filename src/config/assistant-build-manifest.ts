// src/config/assistant-build-manifest.ts
// Which assistant roles have the CODE behind them that a hired assistant needs to work.
//
// An assistant's catalogue row (copy, prompt, status) lives in the database and is edited on
// Admin ▸ Assistants. But a role only works once three pieces of code exist for it:
//   setup      — its set-up questions (src/public/assistant-onboarding-schemas.js), or its own
//                set-up wizard page (assistant-catalogue.html's wizard map — Social Media only)
//   chat       — its chat route (netlify/functions/chat-orchestrator.ts ROUTES); without one the
//                assistant falls back to plain conversation that can save and do nothing
//   dashboard  — its workspace layout (src/components/assistant-dashboard-registry.js)
// The go-live checks (src/utils/assistant-go-live.ts) read this to refuse "Set live" on a role a
// customer could hire but not use. Those three files are browser scripts or a large function the
// server cannot load at runtime, so this is the server's copy.
//
// ⚠️ tests/assistant-go-live.test.ts compares this file with all three sources and FAILS when they
// disagree. Building a new role: add its schema, chat route and dashboard entry, then add it here.

export interface RoleBuild {
    setup: 'schema' | 'wizard';
    chat: true;
    dashboard: true;
}

export const ASSISTANT_BUILD: Readonly<Record<string, RoleBuild>> = {
    social_media_manager:      { setup: 'wizard', chat: true, dashboard: true },
    blog_writer:               { setup: 'schema', chat: true, dashboard: true },
    newsletter_editor:         { setup: 'schema', chat: true, dashboard: true },
    campaign_orchestrator:     { setup: 'schema', chat: true, dashboard: true },
    brand_designer:            { setup: 'schema', chat: true, dashboard: true },
    lead_qualifier:            { setup: 'schema', chat: true, dashboard: true },
    accounts_receivable_clerk: { setup: 'schema', chat: true, dashboard: true },
    tier1_support_agent:       { setup: 'schema', chat: true, dashboard: true },
    crm_enricher:              { setup: 'schema', chat: true, dashboard: true },
    meeting_note_taker:        { setup: 'schema', chat: true, dashboard: true },
};
