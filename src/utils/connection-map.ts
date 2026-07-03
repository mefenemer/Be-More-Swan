// connection-map.ts — server-side single source of truth for which connections
// each Digital Assistant role may use (the Assistant Connection Map).
//
// This is a SECURITY control (data sandboxing): the Connections UI filters by it,
// but enforcement lives here and is applied server-side in integrations.ts so a
// crafted request cannot connect/list a service that is irrelevant to the assistant
// (e.g. a Social Media Manager must not reach HR/CRM connectors).
//
// EXTENSIBLE: add an assistant by adding its roleKey to ROLE_CONNECTIONS; add a
// connector by tagging its category in CONNECTOR_CATEGORY. Only social connectors
// exist today — the other categories are declared ahead of their connectors so the
// policy is ready the moment they land. Consider moving this to the DB (a category
// column on the connector catalog + a role→category table) once non-social
// connectors start shipping.

// Connector serviceName (lowercased) → category.
export const CONNECTOR_CATEGORY: Record<string, string> = {
    facebook: 'social',
    instagram: 'social',
    linkedin: 'social',
    x: 'social',
    twitter: 'social',
};

// Assistant roleKey (aiAssistants.configuration.type) → allowed connection categories.
// NOTE: the LIVE roleKeys come from seed/data/master_assistants.json (e.g. 'social_media',
// 'community_mgmt', 'paid_ads'); the longer keys below mirror seed-catalog.ts. Both are listed
// so the policy is authoritative by roleKey rather than relying on the display-name keyword
// fallback (which the live keys would otherwise depend on).
export const ROLE_CONNECTIONS: Record<string, string[]> = {
    // Live seed roleKeys (seed/data/master_assistants.json)
    social_media:              ['social'],
    community_mgmt:            ['social'],
    paid_ads:                  ['social'],
    // Catalog roleKeys (seed-catalog.ts)
    social_media_manager:      ['social'],
    review_reputation_manager: ['reviews', 'social'],
    inbox_manager:             ['email'],
    calendar_coordinator:      ['calendar', 'email'],
    travel_logistics_booker:   ['email', 'calendar'],
    document_organizer:        ['knowledge'],
    lead_qualifier:            ['crm', 'email'],
    crm_enricher:              ['crm'],
    seo_content_strategist:    ['cms', 'search_console', 'knowledge'],
    newsletter_editor:         ['email', 'cms'],
    vendor_communications_rep: ['email'],
    inventory_tracker:         ['inventory'],
    sop_writer:                ['knowledge'],
    tier1_support_agent:       ['support', 'chat'],
    client_onboarding_guide:   ['email', 'esign', 'knowledge'],
    standup_summarizer:        ['chat', 'project_mgmt'],
    meeting_note_taker:        ['calendar', 'knowledge'],
    status_report_generator:   ['project_mgmt', 'chat'],
    accounts_receivable_clerk: ['payments', 'accounting'],
    expense_categorizer:       ['accounting'],
};

export interface AssistantRole {
    roleKey?: string | null;
    role?: string | null; // display name, e.g. "The Social Media Manager"
}

// Keyword fallback for assistants created before roleKey was stored, or custom roles.
function categoriesFromName(roleName?: string | null): Set<string> {
    const r = (roleName || '').toLowerCase();
    const c = new Set<string>();
    if (/social|community|brand|post/.test(r)) c.add('social');
    if (/review|reputation/.test(r)) { c.add('reviews'); c.add('social'); }
    if (/inbox|email|mail/.test(r)) c.add('email');
    if (/calendar|schedul/.test(r)) c.add('calendar');
    if (/crm|lead|sales/.test(r)) c.add('crm');
    if (/support|ticket|helpdesk/.test(r)) { c.add('support'); c.add('chat'); }
    if (/seo|content|cms/.test(r)) c.add('cms');
    if (/project|sprint|stand-?up|status/.test(r)) c.add('project_mgmt');
    if (/invoice|account|expense|billing|receivable/.test(r)) { c.add('accounting'); c.add('payments'); }
    return c;
}

// Allowed categories for an assistant. Returns null when no policy can be determined
// (unknown / custom role) → treated as "unrestricted" by the helpers below.
export function allowedCategoriesForAssistant(a: AssistantRole | null | undefined): Set<string> | null {
    if (a?.roleKey && ROLE_CONNECTIONS[a.roleKey]) return new Set(ROLE_CONNECTIONS[a.roleKey]);
    const kw = categoriesFromName(a?.role);
    return kw.size ? kw : null;
}

// Is `serviceName` allowed for this assistant? Fail-closed for a categorised role +
// uncategorised connector; fail-open only when the role itself has no policy.
export function isServiceAllowedForAssistant(serviceName: string, a: AssistantRole | null | undefined): boolean {
    const cats = allowedCategoriesForAssistant(a);
    if (!cats) return true; // unrestricted role (unknown/custom)
    const cat = CONNECTOR_CATEGORY[(serviceName || '').toLowerCase()];
    if (!cat) return false; // scoped role + uncategorised connector → deny
    return cats.has(cat);
}

// Filter a list of service names down to those allowed for the assistant.
export function allowedServiceNames(a: AssistantRole | null | undefined, services: string[]): string[] {
    return services.filter(s => isServiceAllowedForAssistant(s, a));
}

// Connectors (from the known catalog) that are relevant to this assistant's role,
// independent of whether a connection row exists yet in the DB. The Connections UI
// uses this to decide which connector cards to render — a Social Media Manager must
// show its social connectors even before the user has connected (and thus created a
// row for) any of them. Returns the full catalog for an unrestricted (unknown/custom)
// role. Service names are the lowercased CONNECTOR_CATEGORY keys.
export function relevantConnectorsForAssistant(a: AssistantRole | null | undefined): string[] {
    const cats = allowedCategoriesForAssistant(a);
    const all = Object.keys(CONNECTOR_CATEGORY);
    if (!cats) return all; // unrestricted role (unknown/custom)
    return all.filter(s => cats.has(CONNECTOR_CATEGORY[s]));
}
