// src/utils/workspace-export.ts
// What a self-serve data export contains, in one place (data-export-background.ts builds it).
//
// Two parts, because the product is organisation-scoped but GDPR portability is per person:
//   - `you`       — the requester's own records (profile, agreements, support, their chats). Every
//                   member gets this.
//   - `workspace` — the organisation's data (assistants, posts, blogs, leads, audience, email,
//                   campaigns, products, goals, connections). Owners and admins only — the same
//                   people who accept the DPA for the organisation (EXPORT_WORKSPACE_ROLES). DPA v1.1
//                   §9 promises "export your workspace data at any time from My Account"; this is it.
//
// Rows are exported whole (select *) so a new column reaches the export without anyone remembering
// to add it, then stripped of anything that is a credential or an internal pointer (SECRET_COLUMN).
// Media files themselves are not inside the file — their records are, with names and types.

import * as crypto from 'crypto';
import { eq, and, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import * as s from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export const EXPORT_WORKSPACE_ROLES = ['owner', 'admin'];

/** HMAC data-export-background checks, so only data-export.ts can start a build or set its scope. */
export function exportJobSignature(requestId: number, orgId: number, includeWorkspace: boolean): string {
    return crypto.createHmac('sha256', process.env.JWT_SECRET || '')
        .update(`data-export:${requestId}:${orgId}:${includeWorkspace ? 1 : 0}`).digest('hex');
}

/** Columns never exported: credentials, vault references, internal storage keys, opaque hashes. */
const SECRET_COLUMN = /password|secret|token|vaultRef|^r2Key$|^storageKey$|^ipHash$|^definitionHash$|^embedding$/i;

/**
 * Pure: drop secret columns from a row (exported for tests). Recursive: jsonb columns (an audit
 * log's previous/new state, metadata) can carry the same keys — the first prod export found
 * `activityLog[].newState.r2Key` (null that time, but nothing guaranteed it).
 */
export function stripSecrets<T extends Record<string, unknown>>(row: T): Partial<T> {
    return stripDeep(row) as Partial<T>;
}

function stripDeep(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(stripDeep);
    if (!v || typeof v !== 'object' || v instanceof Date) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!SECRET_COLUMN.test(k)) out[k] = stripDeep(x);
    return out;
}

/**
 * Organisation-scoped tables in the workspace part, by the section name used in the file.
 * Every one has an `organisationId` column. Left out on purpose: secrets (vaultSecrets, apiKeys),
 * caches, embeddings/chunks, telemetry and job queues — operational, not the customer's content.
 */
export const WORKSPACE_TABLES: Record<string, any> = {
    assistants: s.aiAssistants,
    scheduledPosts: s.scheduledPosts,
    postInsights: s.postInsights,
    postIdeas: s.postIdeaSuggestions,
    postedAssets: s.postedAssets,
    blogPosts: s.blogPosts,
    contentAssets: s.contentAssets,
    mediaLibrary: s.workspaceAssets,
    leads: s.leads,
    leadThreads: s.leadThreads,
    leadMessages: s.leadMessages,
    discoveryCampaigns: s.discoveryCampaigns,
    discoveredLeads: s.discoveredLeads,
    outreachSequences: s.outreachSequences,
    outreachSequenceSteps: s.sequenceSteps,
    outreachEnrolments: s.sequenceEnrolments,
    leadOptOuts: s.leadOptOuts,
    suppressionList: s.suppressionList,
    relationshipTasks: s.relationshipBuildingTasks,
    audienceContacts: s.audienceContacts,
    audienceSegments: s.audienceSegments,
    audienceCustomFields: s.audienceCustomFields,
    audienceConsentEvents: s.audienceConsentEvents,
    audienceForms: s.audienceForms,
    audienceFormSubmissions: s.audienceFormSubmissions,
    emailIssues: s.newsletterIssues,
    emailSequences: s.newsletterSequences,
    emailSequenceSteps: s.newsletterSequenceSteps,
    campaigns: s.campaigns,
    campaignAssets: s.campaignAssets,
    products: s.orgProducts,
    goals: s.goals,
    knowledgeBase: s.kbArticles,
    inspiration: s.inspoItems,
    // The Website Assistant: the site's definition (draft and settings) and messages from its contact form.
    websites: s.sites,
    websiteEnquiries: s.siteEnquiries,
    // An imported draft of their old site waiting for review (site-import.ts), if any.
    websiteImports: s.siteImports,
    websiteOrders: s.siteOrders,
    bookings: s.bookings,
    bookingSettings: s.bookingSettings,
    bookableResources: s.bookableResources,
    stripeConnectAccounts: s.stripeConnectAccounts,
    swanIndexProfiles: s.swanIndexProfiles,
    swanIndexPosts: s.swanIndexPosts,
    assistantRecords: s.assistantRecords,
    actionItems: s.actionItems,
    featureRequests: s.featureRequests,
    connections: s.systemConnections,
    integrations: s.workspaceIntegrations,
    webhookEndpoints: s.webhookEndpoints,
    plans: s.plans,
    invoices: s.invoices,
    payments: s.payments,
    dpaAcceptances: s.dpaAcceptances,
};

/** Run async jobs a few at a time: functions sit in us-east-1, the database in London. */
async function inBatches<T>(jobs: Array<() => Promise<T>>, size = 6): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < jobs.length; i += size) out.push(...await Promise.all(jobs.slice(i, i + size).map((j) => j())));
    return out;
}

async function rowsWhere(db: Db, table: any, where: any): Promise<Record<string, unknown>[]> {
    const rows = await db.select().from(table).where(where);
    return (rows as Record<string, unknown>[]).map(stripSecrets);
}

export interface ExportScope {
    userId: number;
    organisationId: number;
    /** Owner/admin of the organisation — include the workspace part. */
    includeWorkspace: boolean;
}

export async function buildDataExport(db: Db, scope: ExportScope) {
    const { userId, organisationId: orgId } = scope;

    // ── You ───────────────────────────────────────────────────────────────
    const [userRows, profileRows, tosRows, ticketRows, issueRows, auditRows, chatRows] = await inBatches([
        () => rowsWhere(db, s.users, eq(s.users.id, userId)),
        () => rowsWhere(db, s.userProfiles, eq(s.userProfiles.userId, userId)),
        () => rowsWhere(db, s.tosAcceptances, eq(s.tosAcceptances.userId, userId)),
        () => rowsWhere(db, s.supportTickets, eq(s.supportTickets.userId, userId)),
        () => rowsWhere(db, s.issueReports, eq(s.issueReports.userId, userId)),
        () => rowsWhere(db, s.auditLogs, eq(s.auditLogs.userId, userId)),
        () => rowsWhere(db, s.chatSessions, and(eq(s.chatSessions.userId, userId), eq(s.chatSessions.organisationId, orgId))),
    ]);
    const chatIds = chatRows.map((c) => c.id as number);
    const chatMessages: Record<string, unknown>[] = [];
    for (let i = 0; i < chatIds.length; i += 500) {
        chatMessages.push(...await rowsWhere(db, s.chatMessages, inArray(s.chatMessages.chatSessionId, chatIds.slice(i, i + 500))));
    }

    // Affiliate partner (docs/affiliate-partner-programme-plan.md §4.8): their own partner record,
    // commission and payouts, and link visits. The customers they introduced are other people — only a
    // COUNT is included, never who they are. Payout details stay in the vault; the row carries only the
    // masked summary, and token hashes are dropped by stripSecrets.
    const [partnerRow] = await rowsWhere(db, s.partners, eq(s.partners.userId, userId));
    const partner = partnerRow ? {
        record: partnerRow,
        commissions: await rowsWhere(db, s.partnerCommissions, eq(s.partnerCommissions.partnerId, partnerRow.id as number)),
        linkVisitsByDay: await rowsWhere(db, s.partnerLinkStats, eq(s.partnerLinkStats.partnerId, partnerRow.id as number)),
        customersIntroduced: (await db.select({ id: s.partnerReferrals.id }).from(s.partnerReferrals).where(eq(s.partnerReferrals.partnerId, partnerRow.id as number))).length,
    } : null;

    const you = {
        partner,
        account: userRows[0] ?? null,
        profile: profileRows[0] ?? null,
        termsAcceptances: tosRows,
        supportTickets: ticketRows,
        issueReports: issueRows,
        activityLog: auditRows,
        chats: chatRows.map((c) => ({ ...c, messages: chatMessages.filter((m) => m.chatSessionId === c.id) })),
    };

    if (!scope.includeWorkspace) {
        return { ...header(scope), you, workspace: null };
    }

    // ── Workspace ─────────────────────────────────────────────────────────
    const [orgRows, members] = await Promise.all([
        rowsWhere(db, s.organisations, eq(s.organisations.id, orgId)),
        db.select({
            email: s.users.email, firstName: s.users.firstName, lastName: s.users.lastName,
            role: s.userOrganisations.role, joinedAt: s.userOrganisations.joinedAt,
        }).from(s.userOrganisations)
            .innerJoin(s.users, eq(s.users.id, s.userOrganisations.userId))
            .where(eq(s.userOrganisations.organisationId, orgId)),
    ]);

    const names = Object.keys(WORKSPACE_TABLES);
    const results = await inBatches(names.map((name) => () => {
        const t = WORKSPACE_TABLES[name];
        return rowsWhere(db, t, eq(t.organisationId, orgId));
    }));
    const workspace: Record<string, unknown> = { organisation: orgRows[0] ?? null, members };
    names.forEach((name, i) => { workspace[name] = results[i]; });

    return { ...header(scope), you, workspace };
}

function header(scope: ExportScope) {
    return {
        format: 'be-more-swan-data-export',
        version: 1,
        exportedAt: new Date().toISOString(),
        about: scope.includeWorkspace
            ? 'Your own records ("you") and your organisation\'s workspace data ("workspace"). Media files are '
              + 'listed by name and type; download the files themselves from your media library.'
            : 'Your own records ("you"). Your organisation\'s workspace data can be exported by its owner or an admin.',
    };
}
