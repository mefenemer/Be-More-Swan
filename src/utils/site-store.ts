// src/utils/site-store.ts — the Website Assistant's site in the database: load (or start), apply
// edits, the AI draft, and the page cap from the plan. docs/website-assistant-plan.md §5.
//
// Every write to `sites.draft` goes through applySiteOperation / siteFromDraftReply, which both end
// in normaliseSiteDefinition — there is no other writer. The editor (assistant-site-editor.js) and
// the chat cards call the same API actions (netlify/functions/sites.ts), so they cannot disagree.

import { dietaryWords } from './product-dietary';
import { depositLabel } from './product-price';
import { bookableSessions } from './class-sessions';
import { reviewsForPrompt } from './reviews';
import { and, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, contentAssets, organisations, orgProducts, siteEnquiries, sites, siteVersions, users } from '../../db/schema';
import { buyablePence } from './product-price';
import { listSignupForms } from './site-forms';
import { connectAccountFor } from './site-shop';
import { loadBookingSetup } from './bookings';
import { describeHours } from './booking-settings';
import { gatewayGenerate } from '../lib/ai-gateway';
import { loadAssistantRulesBlock } from './assistant-rules-prompt';
import { normalizeBrandKit } from './brand-kit';
import { parseModelJson } from './model-json';
import { createNotification } from './notify';
import { loadProductsBlock } from './org-products';
import { getActiveFeaturesByOrg } from './plan-features';
import {
    applySiteOperation, assetIdsIn, DEFAULT_MAX_PAGES, FEATURE_LABELS, markVideos, normaliseSiteDefinition, SITE_FEATURES, withoutAssets, type SiteDefinition, type SiteOperation,
} from './site-definition';
import { buildDraftPrompt, placeholdersIn, siteFromDraftReply, starterSite, themeFromBrandKit, type BusinessFacts } from './site-draft';
import { buildFillPrompt, siteFromFillReply } from './site-template-fill';
import { KEEP_VERSIONS, sameDefinition, siteOrigin, siteSlugProblem, slugFromHost } from './site-hosting';
import { assemblePlacement, buildPlacementPrompt, MAX_WORDS_CHARS, readPlan, tidyWords, wordsToBlocks, type WordsPlan, type WordsProposal } from './site-words';
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
    const checked = await verifySiteAssets(db, site.organisationId, def);
    for (const w of checked.warnings) if (!warnings.includes(w)) warnings.push(w);
    const [saved] = await db.update(sites).set({ draft: checked.definition, updatedAt: new Date() }).where(eq(sites.id, site.id)).returning();
    return { ok: true, site: saved, warnings };
}

/**
 * Library pictures may be used only by the workspace that owns them, only if they are pictures, and
 * never one moderation refused. Anything else is taken out, with a warning. Called on every save —
 * the editor's picker, chat attachments and a chat card all arrive here.
 */
export async function verifySiteAssets(db: Db, orgId: number, def: SiteDefinition): Promise<{ definition: SiteDefinition; warnings: string[] }> {
    const ids = assetIdsIn(def);
    if (!ids.length) return { definition: def, warnings: [] };
    const rows = await db.select({ id: contentAssets.id, assetType: contentAssets.assetType, status: contentAssets.status })
        .from(contentAssets).where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, orgId)));
    const usable = rows.filter((r) => (r.assetType === 'image' || r.assetType === 'video') && r.status !== 'rejected');
    const ok = new Set(usable.map((r) => r.id));
    const drop = new Set(ids.filter((id) => !ok.has(id)));
    // Videos are drawn as videos where a site can show one, and taken out where it can't (markVideos).
    const marked = markVideos(withoutAssets(def, drop), new Set(usable.filter((r) => r.assetType === 'video').map((r) => r.id)));
    const warnings: string[] = [];
    if (drop.size) warnings.push(`${drop.size === 1 ? 'A picture was' : `${drop.size} pictures were`} left out: only pictures from your own library can be used.`);
    if (marked.removed) warnings.push('A video was left out: a logo, a sign-up section and a product show pictures only.');
    return { definition: marked.definition, warnings };
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
        const brief = {
            business: { ...facts, email: current.settings.email ?? facts.email },
            productsBlock, rulesBlock, maxPages,
            goal: str(SITE_SETUP_KEYS.goal), pagesWanted: str(SITE_SETUP_KEYS.pages), style: str(SITE_SETUP_KEYS.style),
            request: request?.trim().slice(0, 2000) || null,
        };
        // Started from a template: write the words INTO its layout (site-template-fill.ts) — the
        // pages, sections, pictures and design stay as they are. Otherwise, a whole new site.
        const fromTemplate = !!current.settings.template;
        const prompt = fromTemplate ? buildFillPrompt(brief, current) : buildDraftPrompt(brief);
        const res = await gatewayGenerate({
            system: prompt.system, messages: [{ role: 'user', content: prompt.user }], maxTokens: 8000,
            usage: { workspaceId: site.organisationId, assistantId: site.aiAssistantId },
        });
        let drafted: { definition: SiteDefinition } | null;
        if (fromTemplate) {
            const filled = siteFromFillReply(parseModelJson(res.text), current, maxPages);
            drafted = filled.changed ? { definition: filled.definition } : null;
        } else {
            drafted = siteFromDraftReply(parseModelJson(res.text), current, maxPages);
        }
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

// ── Publishing (step 3a — docs/website-assistant-plan.md §5.2) ──────────────────────────────
// The public is served a frozen copy (site_versions), never the draft: editing changes nothing live
// until the owner presses Publish on the Website tab. Publish is a click only — never a chat card.

export type PublishResult = { ok: true; site: SiteRow; version: number } | { ok: false; error: string };

/** Choose (or change) the site's address. Refused with the reason in plain words. */
export async function setSiteAddress(db: Db, site: SiteRow, slug: string): Promise<{ ok: true; site: SiteRow } | { ok: false; error: string }> {
    const problem = siteSlugProblem(slug);
    if (problem) return { ok: false, error: problem };
    if (site.slug === slug) return { ok: true, site };
    const [taken] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.slug, slug), ne(sites.id, site.id))).limit(1);
    if (taken) return { ok: false, error: 'Someone already has that address. Try another.' };
    try {
        const [saved] = await db.update(sites).set({ slug, updatedAt: new Date() }).where(eq(sites.id, site.id)).returning();
        return { ok: true, site: saved };
    } catch (err) {
        // The unique index is the real guard: two people choosing the same address at once.
        if ((err as { code?: string })?.code === '23505') return { ok: false, error: 'Someone already has that address. Try another.' };
        throw err;
    }
}

/** Why the draft cannot be published right now, or null. Checked again inside publishSite. */
export function publishBlocker(site: SiteRow, def: SiteDefinition): string | null {
    if (site.status === 'suspended') return 'This site has been taken offline by Be More Swan and can\'t be published. Contact us if you think that is wrong.';
    if (!site.slug) return 'Choose your site\'s address first.';
    for (const p of def.pages) {
        if (p.sections.some((s) => s.type === 'signup' && !s.props.formId)) return `Choose a sign-up form for the sign-up section on "${p.title}", or remove that section.`;
    }
    const holes = placeholdersIn(def);
    if (holes.length) return `Fill in the ${holes.length} part${holes.length === 1 ? '' : 's'} still in [square brackets] first — ${holes.slice(0, 3).map((h) => `${h.pageTitle}: ${h.text}`).join('; ')}${holes.length > 3 ? '…' : ''}.`;
    return null;
}

/**
 * Freeze the draft as the next version and make it live. The caller has already run the safety
 * check on the site's words (sites.ts). Older versions beyond KEEP_VERSIONS are trimmed.
 */
export async function publishSite(db: Db, site: SiteRow, userId: number | null, maxPages: number): Promise<PublishResult> {
    const { definition } = definitionOf(site, maxPages);
    const blocker = publishBlocker(site, definition);
    if (blocker) return { ok: false, error: blocker };
    const result = await db.transaction(async (tx) => {
        const [{ next }] = await tx.select({ next: sql<number>`COALESCE(MAX(${siteVersions.version}), 0) + 1` })
            .from(siteVersions).where(eq(siteVersions.siteId, site.id));
        const version = Number(next);
        await tx.insert(siteVersions).values({ siteId: site.id, version, definition, publishedBy: userId });
        const [saved] = await tx.update(sites)
            .set({ status: 'published', publishedVersion: version, publishedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(sites.id, site.id), ne(sites.status, 'suspended'))).returning();
        if (!saved) throw new Error('suspended');
        if (version > KEEP_VERSIONS) {
            await tx.delete(siteVersions).where(and(eq(siteVersions.siteId, site.id), lte(siteVersions.version, version - KEEP_VERSIONS)));
        }
        return { site: saved, version };
    }).catch((err) => {
        if (err instanceof Error && err.message === 'suspended') return null;
        throw err;
    });
    if (!result) return { ok: false, error: 'This site has been taken offline by Be More Swan and can\'t be published.' };
    return { ok: true, ...result };
}

/** Take the site offline. Its versions are kept; Publish puts it back. */
export async function unpublishSite(db: Db, site: SiteRow): Promise<SiteRow> {
    if (site.status !== 'published') return site;
    const [saved] = await db.update(sites).set({ status: 'draft', updatedAt: new Date() })
        .where(and(eq(sites.id, site.id), eq(sites.status, 'published'))).returning();
    return saved ?? site;
}

export async function listSiteVersions(db: Db, siteId: number): Promise<Array<{ version: number; publishedAt: Date; pages: number }>> {
    const rows = await db.select({ version: siteVersions.version, publishedAt: siteVersions.publishedAt, definition: siteVersions.definition })
        .from(siteVersions).where(eq(siteVersions.siteId, siteId)).orderBy(desc(siteVersions.version)).limit(KEEP_VERSIONS);
    return rows.map((r) => ({ version: r.version, publishedAt: r.publishedAt, pages: Array.isArray((r.definition as SiteDefinition)?.pages) ? (r.definition as SiteDefinition).pages.length : 0 }));
}

/** The published definition, through the gate (a plan's page cap lowered since still holds). */
export async function publishedDefinition(db: Db, site: SiteRow, maxPages: number): Promise<SiteDefinition | null> {
    if (site.publishedVersion == null) return null;
    const [row] = await db.select({ definition: siteVersions.definition }).from(siteVersions)
        .where(and(eq(siteVersions.siteId, site.id), eq(siteVersions.version, site.publishedVersion))).limit(1);
    return row ? normaliseSiteDefinition(row.definition, { maxPages }).definition : null;
}

/** Copy an earlier version back into the DRAFT. Nothing changes live until the owner publishes. */
export async function restoreVersionToDraft(db: Db, site: SiteRow, version: number, maxPages: number): Promise<SiteRow | null> {
    const [row] = await db.select({ definition: siteVersions.definition }).from(siteVersions)
        .where(and(eq(siteVersions.siteId, site.id), eq(siteVersions.version, version))).limit(1);
    if (!row) return null;
    const { definition } = normaliseSiteDefinition(row.definition, { maxPages });
    const [saved] = await db.update(sites).set({ draft: definition, updatedAt: new Date() }).where(eq(sites.id, site.id)).returning();
    return saved;
}

/**
 * Whether `origin` is a PUBLISHED site of organisation `orgId` (https://<slug>.<sites domain>).
 * audience-public.ts uses it to let a workspace's own site post to that workspace's own forms.
 */
export async function isOwnPublishedSite(db: Db, origin: string, orgId: number): Promise<boolean> {
    let host: string;
    try {
        const u = new URL(origin);
        if (u.protocol !== 'https:') return false;
        host = u.host;
    } catch { return false; }
    const slug = slugFromHost(host);
    if (!slug) return false;
    const [row] = await db.select({ id: sites.id }).from(sites)
        .where(and(eq(sites.slug, slug), eq(sites.organisationId, orgId), eq(sites.status, 'published'))).limit(1);
    return !!row;
}

/** Whether the draft differs from what is live (false when nothing is live). */
export async function hasUnpublishedChanges(db: Db, site: SiteRow, maxPages: number): Promise<boolean> {
    if (site.publishedVersion == null) return false;
    const live = await publishedDefinition(db, site, maxPages);
    return !sameDefinition(live, definitionOf(site, maxPages).definition);
}

// ── The owner's own words (site-words.ts) ────────────────────────────────────────────────────

/**
 * Place the owner's own text on one page: a PROPOSAL (ops + preview), nothing saved. The model only
 * maps numbered blocks to sections; the words are the owner's by construction. 1 task, charged once
 * a proposal exists. The editor's "Add your own words" and the chat's attachment card both call this.
 */
export async function proposeOwnWords(db: Db, site: SiteRow, opts: { pageId: string; text: string; note: string | null; maxPages: number }): Promise<{ ok: true; proposal: WordsProposal; blocks: number } | { ok: false; error: string; status: number }> {
    const def = definitionOf(site, opts.maxPages).definition;
    const page = def.pages.find((p) => p.id === opts.pageId);
    if (!page) return { ok: false, status: 404, error: 'That page no longer exists.' };
    const text = tidyWords(opts.text);
    if (!text) return { ok: false, status: 400, error: 'There are no words to add — paste some in, or choose a file.' };
    if (text.length > MAX_WORDS_CHARS) return { ok: false, status: 400, error: `That's more than one page can hold (${text.length.toLocaleString('en-GB')} characters; the limit is ${MAX_WORDS_CHARS.toLocaleString('en-GB')}). Split it across pages.` };
    const blocks = wordsToBlocks(text);
    if (!(await hasTaskCapacity(db, site.organisationId))) return { ok: false, status: 402, error: TASK_LIMIT_MESSAGE };

    const prompt = buildPlacementPrompt(page, blocks, opts.note);
    let plan: WordsPlan | null = null;
    try {
        const res = await gatewayGenerate({
            system: prompt.system, messages: [{ role: 'user', content: prompt.user }], maxTokens: 1500,
            usage: { workspaceId: site.organisationId, assistantId: site.aiAssistantId },
        });
        plan = readPlan(parseModelJson(res.text));
    } catch (err) {
        console.error('[site-store] words placement failed', { siteId: site.id, message: err instanceof Error ? err.message : String(err) });
    }
    // No plan at all: still nothing is lost — the words go at the end of the page, in order.
    const proposal = assemblePlacement(def, page.id, blocks, plan ?? { summary: '', changes: [] });
    if ('error' in proposal) return { ok: false, status: 400, error: proposal.error };
    await recordCompletedWork(db, site.organisationId, 'site_words', 1, site.id);
    return { ok: true, proposal, blocks: blocks.length };
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
        `Status: ${site.status === 'published'
            ? `LIVE at ${siteOrigin(site.slug ?? '')} (version ${site.publishedVersion})${(await hasUnpublishedChanges(db, site, maxPages)) ? '; the draft below has changes that are NOT live until they press Publish' : '; the draft below is what is live'}`
            : site.status === 'suspended'
                ? `TAKEN OFFLINE by Be More Swan${site.suspendedReason ? ` (${site.suspendedReason})` : ''} — they cannot publish; tell them to contact Be More Swan`
                : `private draft — not published${site.slug ? ` (address chosen: ${siteOrigin(site.slug)})` : ''}`}${drafting ? '; an AI draft of the whole site is being written right now' : ''}.`,
        'Publishing, taking the site offline, choosing its address and connecting a domain they own (like yourbusiness.co.uk — they add one or two DNS settings where they bought it, and the card shows exactly what) are buttons on the Website tab only — you cannot do them from chat; point them to the Publish card there.',
        `Pages: ${d.pages.length} of ${maxPages} on their plan. Layout: ${d.structure === 'one_page' ? 'ONE PAGE — the menu jumps down the home page to sections with a menu label' : 'several pages — the menu lists the pages not hidden'}.`,
        `Business: ${d.settings.siteName}${d.settings.locality ? `, ${d.settings.locality}` : ''} · email ${d.settings.email ?? 'none'} · phone ${d.settings.phone ?? 'none'} · type ${d.settings.businessType}`,
        d.settings.features
            ? `What this website does (their choice): ${d.settings.features.map((f) => FEATURE_LABELS[f]).join('; ') || 'only the basics'}. Switched OFF — never propose these kinds of section: ${SITE_FEATURES.filter((f) => !d.settings.features!.includes(f)).map((f) => FEATURE_LABELS[f]).join('; ') || 'nothing'}. To switch one on or off, propose set_settings with the full "features" list (${SITE_FEATURES.join(', ')}).`
            : `What this website does: not chosen yet — every kind of section is offered. When you discuss the site, help them choose and propose set_settings {"features":[…]} from ${SITE_FEATURES.join(', ')}, so what they don't need is hidden.`,
        `Theme: main colour ${d.theme.primaryColor}, text ${d.theme.textColor}, background ${d.theme.backgroundColor}, lettering ${d.theme.font}, corners ${d.theme.radius}${d.theme.logoUrl ? ', has a logo' : ', no logo'}.`,
    ];
    for (const p of d.pages) {
        lines.push(`- Page "${p.title}" (pageId ${p.id}, address ${p.slug ? `/${p.slug}` : '/'}${p.hideFromMenu ? ', HIDDEN from the menu' : ''}${p.seo.title ? `, search title "${clip(p.seo.title, 70)}"` : ', no search title'}):`);
        if (!p.sections.length) lines.push('    (no sections)');
        for (const s of p.sections) {
            const pr = s.props as unknown as Record<string, unknown>;
            const items = Array.isArray(pr.items) ? ` · ${pr.items.length} item(s)` : '';
            const main = pr.headline ?? pr.heading ?? '';
            const lk = s.look && (s.look.background !== 'auto' || s.look.columns !== 'auto' || s.look.menuLabel)
                ? ` · look: ${[s.look.background !== 'auto' ? `${s.look.background} background` : '', s.look.columns !== 'auto' ? `${s.look.columns} columns` : '', s.look.menuLabel ? `menu label "${s.look.menuLabel}"` : ''].filter(Boolean).join(', ')}` : '';
            lines.push(`    · ${s.type} (sectionId ${s.id})${main ? `: "${clip(main, 90)}"` : ''}${items}${typeof pr.body === 'string' ? ` · "${clip(pr.body, 80)}"` : ''}${lk}`);
        }
    }
    const acct = await connectAccountFor(db, orgId).catch(() => null);
    lines.push(acct?.chargesEnabled
        ? 'Payments: their Stripe account is connected — Buy buttons on a products section work on the live site.'
        : acct ? 'Payments: they started connecting Stripe but it is not finished — Buy buttons do not show yet. Point them to the Orders tab.'
            : 'Payments: not connected. Buy buttons on a products section only appear once they connect Stripe on the Orders tab (owner or admin).');
    const catalogue = await db.select({ id: orgProducts.id, name: orgProducts.name, price: orgProducts.price, priceType: orgProducts.priceType, priceAmount: orgProducts.priceAmount, dietary: orgProducts.dietary })
        .from(orgProducts).where(and(eq(orgProducts.organisationId, orgId), eq(orgProducts.status, 'active'))).orderBy(orgProducts.sortOrder, orgProducts.id).catch(() => []);
    lines.push(catalogue.length
        ? `Their Business Information products (for productIds in a products or menu section): ${catalogue.slice(0, 40).map((p) => `${p.name} (productId ${p.id}, ${p.price ?? 'no price shown'}${buyablePence(p) !== null ? ', can be bought online' : ''}${dietaryWords(p.dietary) ? `, ${dietaryWords(p.dietary)}` : ''})`).join('; ')}.`
        : 'They have no products in Business Information yet — a products section needs them (Business Information ▸ Products & Services).');
    const bk = await loadBookingSetup(db, orgId).catch(() => null);
    if (bk) {
        lines.push(Object.keys(bk.settings.weeklyHours).length
            ? `Bookings: opening hours ${describeHours(bk.settings.weeklyHours)} (${bk.settings.timezone}); ${bk.settings.mode === 'instant' ? 'confirmed straight away' : 'they confirm each booking'}; bookable services (with a length): ${bk.services.length ? bk.services.map((x) => `${x.name} (serviceId ${x.id}, ${x.durationMinutes} min${depositLabel(x) ? `, ${depositLabel(x)}` : ''})`).join(', ') : 'none yet'}; who/what can be booked: ${bk.resources.length ? bk.resources.map((r) => `${r.name} (${r.kind})`).join(', ') : 'just them'}.`
            : 'Bookings: not set up (no opening hours yet).');
        lines.push(`Where to find them (Business Information, for an hours section): ${bk.settings.visitAddress ? `visit address "${bk.settings.visitAddress.split('\n').join(', ')}"` : 'no visit address'}; ${bk.settings.whatsapp ? `WhatsApp ${bk.settings.whatsapp}` : 'no WhatsApp number'}.`);
    }
    const tt = await bookableSessions(db, orgId, new Date(), [], 20).catch(() => null);
    if (tt) lines.push(tt.length
        ? `Their class / event timetable (next ${tt.length} bookable dates): ${tt.map((x) => `${x.title}, ${x.dateText} ${x.timeText}${x.resourceName ? ` with ${x.resourceName}` : ''} — ${x.left} of ${x.capacity} places left`).join('; ')}.`
        : 'Their class / event timetable is empty (no bookable dates).');
    lines.push(await reviewsForPrompt(db, orgId).catch(() => 'Their reviews could not be read this turn.'));
    const forms = await listSignupForms(db, orgId).catch(() => []);
    lines.push(forms.length
        ? `Their sign-up forms (for a signup section's formId): ${forms.map((f) => `${f.name} (formId ${f.id}${f.download ? `, emails a free download: "${f.download}"` : ''}${f.active ? '' : ', switched off'})`).join('; ')}.`
        : 'They have no sign-up forms yet — a signup section needs one (made with the Email Marketing Assistant or in Audience).');
    const [{ n: newEnquiries } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(siteEnquiries)
        .where(and(eq(siteEnquiries.siteId, site.id), eq(siteEnquiries.status, 'new')));
    if (Number(newEnquiries)) lines.push(`${newEnquiries} enquiry message(s) from the website's contact form are waiting on the Enquiries tab. You cannot read or answer them — the owner replies by email.`);
    const holes = placeholdersIn(d);
    if (holes.length) lines.push(`Parts still in [square brackets] for the owner to fill in: ${holes.slice(0, 8).map((h) => `${h.text} (${h.pageTitle})`).join(', ')}.`);
    return lines.join('\n');
}
