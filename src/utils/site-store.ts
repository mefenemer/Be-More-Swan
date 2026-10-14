// src/utils/site-store.ts — the Website Assistant's site in the database: load (or start), apply
// edits, the AI draft, and the page cap from the plan. docs/website-assistant-plan.md §5.
//
// Every write to `sites.draft` goes through applySiteOperation / siteFromDraftReply, which both end
// in normaliseSiteDefinition — there is no other writer. The editor (assistant-site-editor.js) and
// the chat cards call the same API actions (netlify/functions/sites.ts), so they cannot disagree.

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, organisations, sites, users } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';
import { loadAssistantRulesBlock } from './assistant-rules-prompt';
import { normalizeBrandKit } from './brand-kit';
import { parseModelJson } from './model-json';
import { createNotification } from './notify';
import { loadProductsBlock } from './org-products';
import { getActiveFeaturesByOrg } from './plan-features';
import {
    applySiteOperation, DEFAULT_MAX_PAGES, normaliseSiteDefinition, type SiteDefinition, type SiteOperation,
} from './site-definition';
import { buildDraftPrompt, placeholdersIn, siteFromDraftReply, starterSite, themeFromBrandKit, type BusinessFacts } from './site-draft';
import { hasTaskCapacity, recordCompletedWork, TASK_LIMIT_MESSAGE } from './work-metering';

type Db = ReturnType<typeof getDb>;
export type SiteRow = typeof sites.$inferSelect;

/** A draft in flight longer than this is assumed dead (the worker never answered); a new one may start. */
export const DRAFT_TIMEOUT_MS = 10 * 60 * 1000;
/** Set-up keys (assistant-onboarding-schemas.js → website_assistant), read by the AI draft. */
export const SITE_SETUP_KEYS = { goal: 'siteGoal', pages: 'pagesWanted', style: 'siteStyle' } as const;

/** Pages this workspace's plan allows (Plan Features `website_pages`; decision D1: 5 on £29). */
export async function maxPagesFor(db: Db, orgId: number): Promise<number> {
    try {
        const n = Number((await getActiveFeaturesByOrg(db, orgId)).website_pages);
        return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_PAGES;
    } catch {
        return DEFAULT_MAX_PAGES;
    }
}

async function businessFacts(db: Db, orgId: number, userId: number | null): Promise<{ facts: BusinessFacts; brandKit: unknown }> {
    const [org] = await db.select({
        name: organisations.name, industry: organisations.industry, description: organisations.businessDescription,
        audience: organisations.targetAudience, websiteUrl: organisations.websiteUrl, brandKit: organisations.brandKit,
    }).from(organisations).where(eq(organisations.id, orgId)).limit(1);
    let email: string | null = null;
    if (userId) {
        const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        email = u?.email ?? null;
    }
    return {
        facts: {
            name: org?.name || 'My business', industry: org?.industry ?? null, description: org?.description ?? null,
            audience: org?.audience ?? null, websiteUrl: org?.websiteUrl ?? null, email,
        },
        brandKit: org?.brandKit ?? null,
    };
}

/** The assistant's site, created from the workspace's profile and brand kit the first time. */
export async function loadOrCreateSite(db: Db, opts: { orgId: number; assistantId: number; userId: number | null }): Promise<SiteRow> {
    const [existing] = await db.select().from(sites)
        .where(and(eq(sites.aiAssistantId, opts.assistantId), eq(sites.organisationId, opts.orgId))).limit(1);
    if (existing) return existing;
    const { facts, brandKit } = await businessFacts(db, opts.orgId, opts.userId);
    const starter = starterSite(facts, themeFromBrandKit(normalizeBrandKit(brandKit)));
    const [created] = await db.insert(sites)
        .values({ organisationId: opts.orgId, aiAssistantId: opts.assistantId, createdBy: opts.userId, draft: starter })
        .onConflictDoNothing({ target: sites.aiAssistantId })
        .returning();
    if (created) return created;
    const [raced] = await db.select().from(sites).where(eq(sites.aiAssistantId, opts.assistantId)).limit(1);
    return raced;
}

/** The stored draft, re-checked by the gate on the way out (a cap lowered since it was saved still holds). */
export function definitionOf(site: SiteRow, maxPages: number): { definition: SiteDefinition; warnings: string[] } {
    return normaliseSiteDefinition(site.draft, { maxPages });
}

/**
 * Apply edits in order; the first one that is refused stops the batch and nothing is saved, so a
 * chat card's three changes land together or not at all.
 */
export async function applySiteOperations(
    db: Db, site: SiteRow, ops: SiteOperation[], maxPages: number,
): Promise<{ ok: true; site: SiteRow; warnings: string[] } | { ok: false; error: string; index: number }> {
    let def = definitionOf(site, maxPages).definition;
    const warnings: string[] = [];
    for (let i = 0; i < ops.length; i++) {
        const r = applySiteOperation(def, ops[i], { maxPages });
        if (!r.ok) return { ok: false, error: r.error, index: i };
        def = r.definition;
        for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
    }
    const [saved] = await db.update(sites).set({ draft: def, updatedAt: new Date() }).where(eq(sites.id, site.id)).returning();
    return { ok: true, site: saved, warnings };
}

/**
 * Claim the AI draft for this site: only one at a time, and a dead one (older than the timeout)
 * may be taken over. Returns false when a draft is already running.
 */
export async function claimDraft(db: Db, siteId: number): Promise<boolean> {
    const [row] = await db.update(sites).set({ draftingAt: new Date(), draftNote: null })
        .where(and(eq(sites.id, siteId), or(isNull(sites.draftingAt), lt(sites.draftingAt, sql`now() - (${DRAFT_TIMEOUT_MS} * interval '1 millisecond')`))))
        .returning({ id: sites.id });
    return !!row;
}

export async function endDraft(db: Db, siteId: number, note: string | null): Promise<void> {
    await db.update(sites).set({ draftingAt: null, draftNote: note, updatedAt: new Date() }).where(eq(sites.id, siteId));
}

/**
 * The worker's job (draft-site-background.ts): write the whole site with the model, through the
 * gate, and save it as the new draft. One task, charged after the draft is saved. Never throws.
 */
export async function runSiteDraft(db: Db, siteId: number, request: string | null): Promise<void> {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site) return;
    try {
        if (!(await hasTaskCapacity(db, site.organisationId))) { await endDraft(db, site.id, TASK_LIMIT_MESSAGE); return; }
        const maxPages = await maxPagesFor(db, site.organisationId);
        const [assistant] = await db.select({ id: aiAssistants.id, name: aiAssistants.name, userId: aiAssistants.userId, ctx: aiAssistants.onboardingContext })
            .from(aiAssistants).where(eq(aiAssistants.id, site.aiAssistantId)).limit(1);
        const answers = (assistant?.ctx && typeof assistant.ctx === 'object' ? assistant.ctx : {}) as Record<string, unknown>;
        const str = (k: string) => (typeof answers[k] === 'string' && (answers[k] as string).trim() ? (answers[k] as string).trim() : null);
        const { facts } = await businessFacts(db, site.organisationId, assistant?.userId ?? null);
        let productsBlock: string | null = null;
        try { productsBlock = await loadProductsBlock(db, site.organisationId, facts.name); } catch { /* none */ }
        let rulesBlock: string | null = null;
        try { rulesBlock = await loadAssistantRulesBlock(db, { assistantId: site.aiAssistantId, organisationId: site.organisationId }); } catch { /* none */ }

        const current = definitionOf(site, maxPages).definition;
        const prompt = buildDraftPrompt({
            business: { ...facts, email: current.settings.email ?? facts.email },
            productsBlock, rulesBlock, maxPages,
            goal: str(SITE_SETUP_KEYS.goal), pagesWanted: str(SITE_SETUP_KEYS.pages), style: str(SITE_SETUP_KEYS.style),
            request: request?.trim().slice(0, 2000) || null,
        });
        const res = await gatewayGenerate({
            system: prompt.system, messages: [{ role: 'user', content: prompt.user }], maxTokens: 8000,
            usage: { workspaceId: site.organisationId, assistantId: site.aiAssistantId },
        });
        const drafted = siteFromDraftReply(parseModelJson(res.text), current, maxPages);
        if (!drafted) { await endDraft(db, site.id, 'The draft couldn\'t be completed this time — your site is unchanged and nothing was charged. Try again in a few minutes.'); return; }

        // The success latch: saved only if this draft still holds the claim.
        const [saved] = await db.update(sites).set({ draft: drafted.definition, draftingAt: null, draftNote: null, updatedAt: new Date() })
            .where(and(eq(sites.id, site.id), sql`${sites.draftingAt} IS NOT NULL`)).returning({ id: sites.id });
        if (!saved) return;
        await recordCompletedWork(db, site.organisationId, 'site_draft', 1, site.id);

        if (assistant) {
            await createNotification(db, 'site_draft_ready', {
                userId: assistant.userId, assistantId: assistant.id, category: 'state_change',
                context: { assistant: { name: assistant.name }, site: { pages: `${drafted.definition.pages.length} page${drafted.definition.pages.length === 1 ? '' : 's'}` } },
                metadata: { assistantId: assistant.id, siteId: site.id },
            }).catch((err) => console.error('[site-store] notification failed', err));
        }
    } catch (err) {
        console.error('[site-store] draft failed', { siteId, message: err instanceof Error ? err.message : String(err) });
        await endDraft(db, siteId, 'The draft couldn\'t be completed this time — your site is unchanged and nothing was charged. Try again in a few minutes.').catch(() => {});
    }
}

// ── What the chat sees (chat-orchestrator.ts route `usesSiteSnapshot`) ──────────────────────

const clip = (s: unknown, n: number) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The site as the chat needs it, read per turn: every page and section with its id, so a change
 * card can name exactly what it changes, and nothing the editor does not also show.
 */
export async function buildSiteSnapshot(db: Db, orgId: number, assistantId: number): Promise<string> {
    const [site] = await db.select().from(sites).where(and(eq(sites.aiAssistantId, assistantId), eq(sites.organisationId, orgId))).limit(1);
    if (!site) return 'YOUR SITE RIGHT NOW: not started. The first time the Website tab opens it starts from their business details; or propose a site_draft_request to draft the whole site.';
    const maxPages = await maxPagesFor(db, orgId);
    const { definition: d } = definitionOf(site, maxPages);
    const drafting = !!site.draftingAt && Date.now() - new Date(site.draftingAt).getTime() < DRAFT_TIMEOUT_MS;
    const lines = [
        'YOUR SITE RIGHT NOW (read from the Website tab this turn — use only these ids):',
        `Status: ${site.status === 'published' ? 'live' : 'private draft — not published'}${drafting ? '; an AI draft of the whole site is being written right now' : ''}.`,
        `Pages: ${d.pages.length} of ${maxPages} on their plan.`,
        `Business: ${d.settings.siteName}${d.settings.locality ? `, ${d.settings.locality}` : ''} · email ${d.settings.email ?? 'none'} · phone ${d.settings.phone ?? 'none'} · type ${d.settings.businessType}`,
        `Theme: main colour ${d.theme.primaryColor}, text ${d.theme.textColor}, background ${d.theme.backgroundColor}, lettering ${d.theme.font}, corners ${d.theme.radius}${d.theme.logoUrl ? ', has a logo' : ', no logo'}.`,
    ];
    for (const p of d.pages) {
        lines.push(`- Page "${p.title}" (pageId ${p.id}, address ${p.slug ? `/${p.slug}` : '/'}${p.seo.title ? `, search title "${clip(p.seo.title, 70)}"` : ', no search title'}):`);
        if (!p.sections.length) lines.push('    (no sections)');
        for (const s of p.sections) {
            const pr = s.props as unknown as Record<string, unknown>;
            const items = Array.isArray(pr.items) ? ` · ${pr.items.length} item(s)` : '';
            const main = pr.headline ?? pr.heading ?? '';
            lines.push(`    · ${s.type} (sectionId ${s.id})${main ? `: "${clip(main, 90)}"` : ''}${items}${typeof pr.body === 'string' ? ` · "${clip(pr.body, 80)}"` : ''}`);
        }
    }
    const holes = placeholdersIn(d);
    if (holes.length) lines.push(`Parts still in [square brackets] for the owner to fill in: ${holes.slice(0, 8).map((h) => `${h.text} (${h.pageTitle})`).join(', ')}.`);
    return lines.join('\n');
}
