// src/utils/onboarding-recommendations.ts
// "Recommended for you" — the setup guide's second list, beneath the nine required steps.
//
// The required steps get ONE assistant live. These are what makes each hired role actually good
// (or, for a few, able to work at all), so they depend on WHICH assistants the workspace has hired:
// a Lead Generation Assistant cannot send outreach without a postal address and a mailbox, an Email
// Marketing Assistant has nobody to email without contacts, and so on.
//
// ⚠️ Never blocking. None of these gates go-live or the wizard's "all done" — adding a required step
// re-opens the wizard over every live customer's work (see the products step's grandfathering in
// onboarding-progress.ts). They are suggestions with ticks.
//
// Every lookup is independent and fails SOFT: an item whose check errors is left out, rather than
// shown as undone (nagging someone to do what they did) or done (hiding what they haven't).

import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    aiAssistants, audienceContacts, audienceForms, goals, masterAssistants, newsletterSendingDomains,
    organisations, userOrganisations, userProfiles, widgetConfigs, workspaceIntegrations,
} from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** Where a recommendation's button goes. The drawer (workspace.html) turns this into navigation. */
export interface RecommendationRoute {
    view?: string;
    /** Business Information tab (window._bizinfoInitialTab). */
    bizTab?: string;
    /** Open this assistant's page, optionally on a tab (window._assistantDetailInitialTab). */
    assistantId?: number;
    assistantTab?: string;
    /** A UI action once the view has loaded: 'signup-forms' | 'sending-setup' | 'blog-studio'. */
    action?: string;
}

export interface Recommendation {
    key: string;
    label: string;
    benefit: string;
    done: boolean;
    route: RecommendationRoute;
}

const CONTENT_ROLES = ['social_media_manager', 'blog_writer', 'newsletter_editor', 'brand_designer'];

async function soft<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try { return await fn(); } catch (err) {
        console.error('[onboarding-recommendations] lookup failed — item left out', err instanceof Error ? err.message : err);
        return undefined;
    }
}

export async function computeRecommendations(db: Db, orgId: number, userId: number): Promise<Recommendation[]> {
    const hired = await soft(() => db
        .select({ id: aiAssistants.id, roleKey: masterAssistants.roleKey })
        .from(aiAssistants)
        .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.organisationId, orgId), sql`${aiAssistants.archivedAt} IS NULL`)));
    if (!hired || !hired.length) return [];

    const firstOf = (roles: string[]) => hired.find((a) => roles.includes(a.roleKey));
    const has = (roles: string[]) => !!firstOf(roles);
    const exists = async (q: Promise<unknown[]>) => (await q).length > 0;
    const out: Recommendation[] = [];
    const add = (r: Omit<Recommendation, 'done'>, done: boolean | undefined) => { if (done !== undefined) out.push({ ...r, done }); };

    const [org] = (await soft(() => db.select({ brandKit: organisations.brandKit, postal: organisations.outreachPostalAddress })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1))) || [];

    // ── Role-specific ──────────────────────────────────────────────────────────────────────────
    const lead = firstOf(['lead_qualifier']);
    if (lead || has(['newsletter_editor'])) {
        add({
            key: 'postal_address', label: 'Add your business postal address',
            benefit: 'The law requires one in every marketing email, so outreach and newsletters cannot be sent without it.',
            route: { view: 'assets', bizTab: 'profile' },
        }, org ? !!(org.postal && String(org.postal).trim()) : undefined);
    }
    if (lead) {
        add({
            key: 'mailbox', label: 'Connect your Gmail or Outlook',
            benefit: 'Approved outreach is sent from your own address, and replies come back to your Lead Generation Assistant.',
            route: { assistantId: lead.id, assistantTab: 'platforms' },
        // Mailboxes live in workspace_integrations (oauth-integrations.ts), not system_connections.
        }, await soft(() => exists(db.select({ id: workspaceIntegrations.id }).from(workspaceIntegrations).where(and(
            eq(workspaceIntegrations.organisationId, orgId),
            inArray(workspaceIntegrations.provider, ['gmail', 'outlook']),
            eq(workspaceIntegrations.status, 'active'),
        )).limit(1))));
    }
    if (has(['newsletter_editor'])) {
        add({
            key: 'contacts', label: 'Add your first contacts',
            benefit: 'Import a list of people who agreed to hear from you, or add them one at a time — your Email Marketing Assistant needs someone to email.',
            route: { view: 'audience' },
        }, await soft(() => exists(db.select({ id: audienceContacts.id }).from(audienceContacts)
            .where(eq(audienceContacts.organisationId, orgId)).limit(1))));
        add({
            key: 'signup_form', label: 'Put a sign-up form on your website',
            benefit: 'Grow your list while you sleep — people who sign up confirm their own address and join your Audience.',
            route: { view: 'audience', action: 'signup-forms' },
        }, await soft(() => exists(db.select({ id: audienceForms.id }).from(audienceForms)
            .where(eq(audienceForms.organisationId, orgId)).limit(1))));
        add({
            key: 'sending_domain', label: 'Set up your sending domain',
            benefit: 'Send from your own domain so emails land in inboxes, not spam — and lift the small-list limit of a connected mailbox.',
            route: { view: 'newsletter', action: 'sending-setup' },
        }, await soft(() => exists(db.select({ id: newsletterSendingDomains.id }).from(newsletterSendingDomains).where(and(
            eq(newsletterSendingDomains.organisationId, orgId), eq(newsletterSendingDomains.status, 'verified'),
        )).limit(1))));
    }
    if (has(['blog_writer'])) {
        add({
            key: 'blog_site', label: 'Put your blog on your website',
            benefit: 'Copy one embed snippet into your site and every article you approve appears there, styled to match.',
            route: { action: 'blog-studio' },
        }, await soft(() => exists(db.select({ id: widgetConfigs.id }).from(widgetConfigs).where(and(
            eq(widgetConfigs.organisationId, orgId), isNotNull(widgetConfigs.siteBaseUrl),
        )).limit(1))));
    }
    if (has(CONTENT_ROLES)) {
        const kit = (org?.brandKit && typeof org.brandKit === 'object') ? org.brandKit as Record<string, unknown> : null;
        add({
            key: 'brand_style', label: 'Add your logo and brand colours',
            benefit: 'Branded graphics and AI images use them, so your posts look like yours rather than anyone\'s.',
            route: { view: 'assets', bizTab: 'assets' },
        }, org ? !!(kit && (kit.primaryColor || kit.logoUrl)) : undefined);
    }

    // ── For everyone ───────────────────────────────────────────────────────────────────────────
    add({
        key: 'first_goal', label: 'Set your first goal',
        benefit: 'Tell an assistant what success looks like — it reads your goals when it decides what to write, and tracks progress for you.',
        route: { assistantId: hired[0].id, assistantTab: 'goals' },
    }, await soft(() => exists(db.select({ id: goals.id }).from(goals).where(eq(goals.organisationId, orgId)).limit(1))));
    add({
        key: 'invite_teammate', label: 'Invite a teammate',
        benefit: 'Share the review queue with a colleague, so approvals don\'t wait for you.',
        route: { view: 'assets', bizTab: 'team' },
    }, await soft(() => exists(db.select({ userId: userOrganisations.userId }).from(userOrganisations).where(and(
        eq(userOrganisations.organisationId, orgId), ne(userOrganisations.userId, userId),
    )).limit(1))));
    const [profile] = (await soft(() => db.select({ preferences: userProfiles.preferences }).from(userProfiles)
        .where(eq(userProfiles.userId, userId)).limit(1))) || [];
    add({
        key: 'hourly_rate', label: 'Set your hourly rate',
        benefit: 'Your dashboard then shows the time your assistants save in pounds, not just hours.',
        route: { view: 'settings' },
    }, profile ? !!((profile.preferences as Record<string, unknown> | null)?.hourlyRateGbp) : undefined);

    return out;
}
