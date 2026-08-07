// connection-map.ts — server-side single source of truth for which connections
// each Digital Assistant role may use (the Assistant Connection Map).
//
// This is a SECURITY control (data sandboxing): the Connections UI filters by it,
// but enforcement lives here and is applied server-side in integrations.ts so a
// crafted request cannot connect/list a service that is irrelevant to the assistant
// (e.g. a Social Media Assistant must not reach HR/CRM connectors).
//
// EXTENSIBLE: add an assistant by adding its roleKey to ROLE_CONNECTIONS; add a
// connector by tagging its category in CONNECTOR_CATEGORY. Live connectors today are
// the social ones plus Canva ('design'); the remaining categories are declared ahead of
// their connectors so the policy is ready the moment they land. Consider moving this to
// the DB (a category column on the connector catalog + a role→category table) as more
// connectors ship.
//
// A category only renders in the assistant Connections tab if integrations.js can draw a
// card for it — PLATFORMS for social, SOURCES for inbound sources. Tagging a connector
// here without a matching catalog entry there makes it vanish from the UI rather than
// appear as "coming soon" (supportedToolsForAssistant marks the category available, which
// is exactly what suppresses the coming-soon card).

// Connector serviceName (lowercased) → category.
export const CONNECTOR_CATEGORY: Record<string, string> = {
    facebook: 'social',
    instagram: 'social',
    linkedin: 'social',
    x: 'social',
    twitter: 'social',
    threads: 'social',
    tiktok: 'social',
    youtube: 'social',
    // Inbound source, not an action target: assistants pull designs OUT of Canva and never
    // write back. Rendered by _sourceCard() in integrations.js, not _platformCard().
    canva: 'design',
};

// Assistant roleKey (aiAssistants.configuration.type) → allowed connection categories.
// Keys are the canonical db/seed-catalog.ts namespace (the old 'social_media' /
// 'community_mgmt' duplicates were merged by db/rolekey-namespace-unification.sql).
// Assistants created before roleKey was stored still resolve through the display-name
// keyword fallback below — keep it until no pre-roleKey assistants remain.
export const ROLE_CONNECTIONS: Record<string, string[]> = {
    // Legacy-only role with no catalog twin (kept canonical; hidden from the catalog)
    paid_ads:                  ['social'],
    // Catalog roleKeys (seed-catalog.ts)
    //
    // The Campaign Assistant reaches every channel THROUGH another assistant — it publishes
    // nothing and reads no external account directly, so it needs no connector of its own.
    // The empty array is the point: an EMPTY policy is enforced (nothing is allowed), whereas a
    // MISSING roleKey falls through to the display-name keyword fallback and, if that returns
    // nothing, is treated as unrestricted. "Orchestrator" would keyword-match nothing, so
    // omitting this line would fail OPEN and hand the one assistant that commands the others a
    // connection policy of "anything". Do not delete it because it looks empty.
    campaign_orchestrator:     [],
    social_media_manager:      ['social', 'design'],
    review_reputation_manager: ['reviews', 'social'],
    inbox_manager:             ['email'],
    calendar_coordinator:      ['calendar', 'email'],
    travel_logistics_booker:   ['email', 'calendar'],
    document_organizer:        ['knowledge'],
    lead_qualifier:            ['crm', 'email'],
    crm_enricher:              ['crm'],
    seo_content_strategist:    ['cms', 'search_console', 'knowledge'],
    blog_writer:               ['cms', 'search_console', 'knowledge', 'design'],
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

// Human-facing catalogue for each connection category — the label + one-line
// description shown in the Connections grid ("coming soon" cards) and the
// "Your Onboarding Answers" summary. This is DISPLAY metadata only; the security
// policy (which categories a role may use) stays in ROLE_CONNECTIONS above.
export const CATEGORY_LABELS: Record<string, { label: string; description: string }> = {
    social:         { label: 'Social Media',        description: 'Publish and manage posts across your social channels.' },
    design:         { label: 'Design',              description: 'Bring your Canva designs into your Content Library.' },
    reviews:        { label: 'Reviews & Reputation', description: 'Monitor and respond to customer reviews.' },
    email:          { label: 'Email',               description: 'Read, triage, and send email on your behalf.' },
    calendar:       { label: 'Calendar',            description: 'Read availability and schedule events.' },
    knowledge:      { label: 'Knowledge Base',      description: 'Read and organise documents and notes.' },
    crm:            { label: 'CRM',                 description: 'Look up and update contacts and deals.' },
    cms:            { label: 'Content / CMS',        description: 'Draft and publish website content.' },
    search_console: { label: 'Search Console',      description: 'Pull search performance and indexing data.' },
    inventory:      { label: 'Inventory',           description: 'Track stock levels and product data.' },
    support:        { label: 'Support Desk',        description: 'Read and reply to support tickets.' },
    chat:           { label: 'Team Chat',           description: 'Read and post messages in team chat.' },
    esign:          { label: 'E-Signature',         description: 'Send and track documents for signature.' },
    project_mgmt:   { label: 'Project Management',   description: 'Read and update tasks and project boards.' },
    payments:       { label: 'Payments',            description: 'Reconcile and process payments.' },
    accounting:     { label: 'Accounting',          description: 'Sync invoices, expenses, and ledgers.' },
};

// Categories that are LIVE via a subsystem OTHER than the OAuth connector catalog, so they have no
// entry in CONNECTOR_CATEGORY but must still count as available (suppressing the "coming soon" card
// and letting integrations.js draw their real cards). `cms` is served by the blog-destinations
// subsystem (connect-blog-destination + src/utils/blog-destinations), not the OAuth flow.
export const EXTERNALLY_LIVE_CATEGORIES = new Set<string>(['cms']);

// The mailbox providers an assistant can send outreach from. These live in
// `workspace_integrations` (OAuth via /api/oauth/:provider/connect), NOT in CONNECTOR_CATEGORY —
// tagging them there would put them through the social-card renderer, which has no card for them.
export const MAILBOX_PROVIDERS = ['gmail', 'outlook'] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

// Roles whose `email` category is served LIVE by those mailbox providers.
//
// This is role-scoped rather than a plain entry in EXTERNALLY_LIVE_CATEGORIES because the two
// halves are independent: the Gmail/Outlook grants are workspace-wide and real for everybody, but
// only these roles have code that actually sends through them (lead_qualifier → lead-generation.ts
// `send_outreach`). Marking `email` live for a role with nothing to render would make the category
// VANISH from the Connections grid — no connector card, and no "coming soon" card either — which is
// the failure mode this module's header warns about. So a role joins this set at the same time as
// the code that uses the mailbox, never before.
export const MAILBOX_ROLES = new Set<string>(['lead_qualifier']);

export function usesOutreachMailbox(a: AssistantRole | null | undefined): boolean {
    return !!(a?.roleKey && MAILBOX_ROLES.has(a.roleKey));
}

export interface SupportedTool {
    key: string;         // category key (e.g. 'email')
    label: string;       // human label (e.g. 'Email')
    description: string; // one-line description
    available: boolean;  // true once at least one live connector exists for the category
}

// The external tools an assistant supports, for display in the Connections UI and
// the onboarding summary. Includes categories that have no live connector yet
// (available: false → "coming soon"). Available categories are listed first.
export function supportedToolsForAssistant(a: AssistantRole | null | undefined): SupportedTool[] {
    const cats = allowedCategoriesForAssistant(a);
    // Unrestricted role (unknown/custom) → surface the whole catalogue.
    const keys = cats ? Array.from(cats) : Object.keys(CATEGORY_LABELS);
    const liveCategories = new Set([...Object.values(CONNECTOR_CATEGORY), ...EXTERNALLY_LIVE_CATEGORIES]);
    // `email` is live only for the roles that actually send through a connected mailbox — for
    // everyone else it stays a "coming soon" category. See MAILBOX_ROLES.
    if (usesOutreachMailbox(a)) liveCategories.add('email');
    return keys
        .filter(k => CATEGORY_LABELS[k])
        .map(k => ({ key: k, ...CATEGORY_LABELS[k], available: liveCategories.has(k) }))
        .sort((x, y) => (Number(y.available) - Number(x.available)) || x.label.localeCompare(y.label));
}

export interface AssistantRole {
    roleKey?: string | null;
    role?: string | null; // display name, e.g. "Social Media Assistant"
}

// Keyword fallback for assistants created before roleKey was stored, or custom roles.
function categoriesFromName(roleName?: string | null): Set<string> {
    const r = (roleName || '').toLowerCase();
    const c = new Set<string>();
    if (/social|community|brand|post/.test(r)) { c.add('social'); c.add('design'); }
    if (/review|reputation/.test(r)) { c.add('reviews'); c.add('social'); }
    if (/inbox|email|mail/.test(r)) c.add('email');
    if (/calendar|diary|schedul/.test(r)) c.add('calendar');
    if (/crm|lead|sales/.test(r)) c.add('crm');
    if (/support|ticket|helpdesk/.test(r)) { c.add('support'); c.add('chat'); }
    if (/seo|content|cms|blog/.test(r)) { c.add('cms'); c.add('design'); }
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
// uses this to decide which connector cards to render — a Social Media Assistant must
// show its social connectors even before the user has connected (and thus created a
// row for) any of them. Returns the full catalog for an unrestricted (unknown/custom)
// role. Service names are the lowercased CONNECTOR_CATEGORY keys.
export function relevantConnectorsForAssistant(a: AssistantRole | null | undefined): string[] {
    const cats = allowedCategoriesForAssistant(a);
    const all = Object.keys(CONNECTOR_CATEGORY);
    if (!cats) return all; // unrestricted role (unknown/custom)
    return all.filter(s => cats.has(CONNECTOR_CATEGORY[s]));
}
