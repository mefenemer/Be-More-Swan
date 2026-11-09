// src/utils/site-import-store.ts — "Import my current site" in the database: start it, run it (the
// draft worker, draft-site-background.ts), and the owner's decision on the result. The pure work —
// reading pages into blocks, the plan, building sections from the owner's own words — is
// site-import.ts; this file only connects it to the real fetcher, model and picture library.
//
// The import never touches what the owner has: its result waits in site_imports ('ready') and
// replaces sites.draft only when they press "Use this as my draft" (GUI) or the chat's decision card.
// It never publishes. It shares the draft claim (sites.drafting_at) with the AI whole-site draft, so
// only one of the two runs at a time, and spends tasks the same way: 1 task, only once a draft exists.

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, blogPosts, contentAssets, masterAssistants, organisations, orgProducts, siteImports, sites } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';
import { gatewayRoleModel } from './assistant-model';
import { persistBufferToR2, r2IsConfigured } from '../lib/media-persist';
import { CRAWLERS } from '../lib/robots';
import { parseModelJson } from './model-json';
import { createNotification } from './notify';
import { safeFetchBinary } from './safe-fetch';
import { BLOG_PATH, normaliseSiteDefinition, type SiteDefinition, type SiteRedirect } from './site-definition';
import { blogSummary, type ImportedBlog, type ImportedBlogPost, type ImportedBlogSummary } from './site-import-blog';
import { fetchSiteCss, fetchSiteHtml, fetchSiteJson } from './site-fetch';
import { themeWithLook } from './site-import-theme';
import { createPageRenderer, type PageRenderer } from './site-js-render';
import { cleanImportUrl, productFieldsFromImport, runImport, type ImportDeps, type ImportReport, type PictureChoice } from './site-import';
import { readImportPage } from './site-extract';
import { isOwnSitePage, sourcePageText } from './site-source-page';
import { claimDraft, definitionOf, endDraft, maxPagesFor, verifySiteAssets, type SiteRow, SITE_WRITE_DEADLINE_MS } from './site-store';
import { triggerSiteDraft } from './trigger-site-draft';
import { hasTaskCapacity, recordCompletedWork, TASK_LIMIT_MESSAGE } from './work-metering';
import { recordPlatformIncident } from './platform-incident';

type Db = ReturnType<typeof getDb>;
export type SiteImportRow = typeof siteImports.$inferSelect;

const PAGE_TIMEOUT_MS = 15_000;
const PAGE_MAX_BYTES = 5 * 1024 * 1024;   // a Wix home page is 0.6–2.2 MB of HTML (measured 2026-10-21)
/** One page with its JavaScript run, scripts and data included (site-js-render.ts). */
const RENDER_TIMEOUT_MS = 25_000;
const PICTURE_MAX_BYTES = 8 * 1024 * 1024;
const PICTURE_TYPES = /^image\/(jpeg|png|webp|gif)$/i;

/** What the Website tab and the chat see of the import: never the definition itself. */
export interface ImportView {
    status: 'reading' | 'ready' | 'failed';
    sourceUrl: string;
    pictures: PictureChoice;
    message: string | null;
    /** The report, with the blog's posts as a summary (titles, dates, sizes) — never their bodies. */
    report: (Omit<ImportReport, 'blog'> & { blog?: ImportedBlogSummary | null }) | null;
    pages: Array<{ title: string; path: string; sections: number }>;
    updatedAt: Date;
}

/**
 * The words of one page of the owner's CURRENT website, for the chat's site_words card
 * (site-source-page.ts). Only their own site — the host of their website in the business details, or
 * of the site they imported from — read like an import page (robots.txt + SSRF fence). Never throws.
 */
export async function readOwnSitePage(db: Db, site: SiteRow, rawUrl: unknown): Promise<{ ok: true; text: string; url: string; prices: number } | { ok: false; error: string; status: number }> {
    const url = cleanImportUrl(rawUrl);
    if (!url) return { ok: false, status: 400, error: 'That page address couldn\'t be read. Paste the page’s words into the chat instead.' };
    const [org] = await db.select({ websiteUrl: organisations.websiteUrl }).from(organisations).where(eq(organisations.id, site.organisationId)).limit(1);
    const imported = await loadImport(db, site.id);
    if (!isOwnSitePage(url, [org?.websiteUrl, imported?.sourceUrl])) {
        return { ok: false, status: 400, error: 'Words can only be taken from your own website (the one in Business Information). Paste the words into the chat instead.' };
    }
    const r = await fetchSiteHtml(url, CRAWLERS.siteImport, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES });
    if (!r.ok) return { ok: false, status: 400, error: `We couldn't read that page: ${r.message}` };
    let page;
    try { page = readImportPage(r.html, r.finalUrl); } catch { page = null; }
    const words = page ? sourcePageText(page) : { text: '', prices: 0 };
    if (!words.text) return { ok: false, status: 400, error: 'We couldn\'t find any words on that page (some sites draw them with JavaScript). Paste them into the chat instead.' };
    return { ok: true, text: words.text, url: r.finalUrl, prices: words.prices };
}

/** The site's import, if any. Null on any read failure — the table may not exist yet (db/z-site-import.sql). */
export async function loadImport(db: Db, siteId: number): Promise<SiteImportRow | null> {
    try {
        const [row] = await db.select().from(siteImports).where(eq(siteImports.siteId, siteId)).limit(1);
        return row ?? null;
    } catch (err) {
        console.error('[site-import] read failed (is db/z-site-import.sql applied?)', err instanceof Error ? err.message : err);
        return null;
    }
}

export function importView(row: SiteImportRow | null): ImportView | null {
    if (!row) return null;
    const def = row.definition as SiteDefinition | null;
    return {
        status: row.status as ImportView['status'], sourceUrl: row.sourceUrl, pictures: row.pictures as PictureChoice,
        message: row.message, report: reportView(row.report as ImportReport | null),
        pages: Array.isArray(def?.pages) ? def!.pages.map((p) => ({ title: p.title, path: p.slug ? `/${p.slug}` : '/', sections: p.sections.length })) : [],
        updatedAt: row.updatedAt,
    };
}

function reportView(r: ImportReport | null): ImportView['report'] {
    if (!r) return null;
    const { blog, ...rest } = r;
    return { ...rest, blog: blogSummary(blog) };
}

/**
 * Start reading their site: claim the draft, note what was asked, wake the worker. The caller has
 * checked the owner says the site is theirs and chose what happens to the pictures.
 */
export async function startSiteImport(db: Db, site: SiteRow, opts: { url: string; pictures: PictureChoice; userId: number | null }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (!(await hasTaskCapacity(db, site.organisationId))) return { ok: false, status: 402, error: TASK_LIMIT_MESSAGE };
    if (!(await claimDraft(db, site.id))) return { ok: false, status: 409, error: 'Your site is already being drafted — wait for that to finish, then import.' };
    const values = { sourceUrl: opts.url, pictures: opts.pictures, status: 'reading', definition: null, report: null, message: null, requestedBy: opts.userId, updatedAt: new Date() };
    try {
        await db.insert(siteImports).values({ siteId: site.id, organisationId: site.organisationId, ...values })
            .onConflictDoUpdate({ target: siteImports.siteId, set: values });
    } catch (err) {
        console.error('[site-import] could not record the import', err instanceof Error ? err.message : err);
        await endDraft(db, site.id, null);
        return { ok: false, status: 503, error: 'Importing isn\'t available just yet. Nothing was charged.' };
    }
    if (!(await triggerSiteDraft(site.id, null, { import: true }))) {
        await endDraft(db, site.id, null);
        await failImport(db, site.id, 'The import couldn\'t be started. Nothing was charged — try again.', null);
        return { ok: false, status: 503, error: 'The import couldn\'t be started. Nothing was charged — try again.' };
    }
    return { ok: true };
}

async function failImport(db: Db, siteId: number, message: string, report: ImportReport | null): Promise<void> {
    await db.update(siteImports).set({ status: 'failed', message, report, definition: null, updatedAt: new Date() }).where(eq(siteImports.siteId, siteId));
}

/** The real outside world for runImport: robots + SSRF fence, the model, the picture library. */
function liveDeps(db: Db, site: SiteRow, userId: number, renderer: PageRenderer): ImportDeps {
    return {
        fetchHtml: (url) => fetchSiteHtml(url, CRAWLERS.siteImport, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES }),
        // Only after fetchHtml read the same page — so robots.txt has already said yes to it.
        renderHtml: (url) => renderer.render(url),
        fetchJson: (url) => fetchSiteJson(url, CRAWLERS.siteImport, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES }),
        async plan(prompt) {
            const res = await gatewayGenerate({
                system: prompt.system, messages: [{ role: 'user', content: prompt.user }],
                // Block numbers only, but up to IMPORT_MAX_PAGES pages of them (thinking room is added on top).
                maxTokens: 12000,
                usage: { workspaceId: site.organisationId, assistantId: site.aiAssistantId },
                // The Website role's model (Admin ▸ Assistants ▸ Model & rules). Background: full thinking.
                ...(await gatewayRoleModel(db, 'website_assistant')),
                // A background job writing thousands of words: 3 minutes a try, not the gateway's 24s
                // (the background function itself may run 15 minutes).
                deadlineMs: SITE_WRITE_DEADLINE_MS,
            });
            return parseModelJson(res.text);
        },
        savePicture: (src, alt) => saveImportedPicture(db, site.organisationId, userId, src, alt),
        async fetchCss(url) {
            const r = await fetchSiteCss(url, CRAWLERS.siteImport, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES });
            return r.ok ? r.html : null;
        },
    };
}

/**
 * One picture from their old site into the workspace's library (content_assets, provider
 * 'site_import'), so the new site never hot-links someone else's CDN. The same picture imported
 * twice is the same library picture. Null when it couldn't be copied — the section goes without it.
 */
export async function saveImportedPicture(db: Db, orgId: number, userId: number, src: string, alt: string): Promise<number | null> {
    if (!r2IsConfigured()) return null;
    const [existing] = await db.select({ id: contentAssets.id }).from(contentAssets)
        .where(and(eq(contentAssets.organisationId, orgId), eq(contentAssets.provider, 'site_import'), eq(contentAssets.providerAssetId, src.slice(0, 1000)))).limit(1);
    if (existing) return existing.id;
    try {
        const res = await safeFetchBinary(src, { userAgent: CRAWLERS.siteImport.userAgent, timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PICTURE_MAX_BYTES });
        const type = (res.contentType || '').split(';')[0].trim();
        if (!PICTURE_TYPES.test(type) || res.bytes.length < 1000) return null;
        const { storageKey, fileSize } = await persistBufferToR2({ orgId, bytes: res.bytes, contentType: type, folder: 'site-import' });
        const [row] = await db.insert(contentAssets).values({
            userId, organisationId: orgId, name: alt.slice(0, 120) || 'Picture from my website',
            assetType: 'image', mimeType: type, fileSize, storageKey, externalUrl: null,
            provider: 'site_import', providerAssetId: src.slice(0, 1000), status: 'pending',
        }).returning({ id: contentAssets.id });
        return row.id;
    } catch (err) {
        console.error('[site-import] picture not copied', { src: src.slice(0, 200), message: err instanceof Error ? err.message : String(err) });
        return null;
    }
}

/**
 * The worker's job: read, plan, build, and keep the result for review. Charged 1 task (as a website
 * draft) only when a draft was made; a site too thin to import costs nothing. Never throws.
 */
export async function runSiteImport(db: Db, siteId: number): Promise<void> {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site) return;
    const row = await loadImport(db, site.id);
    if (!row || row.status !== 'reading') { await endDraft(db, site.id, null); return; }
    const renderer = createPageRenderer(CRAWLERS.siteImport, { timeoutMs: RENDER_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES });
    try {
        if (!(await hasTaskCapacity(db, site.organisationId))) { await failImport(db, site.id, TASK_LIMIT_MESSAGE, null); await endDraft(db, site.id, null); return; }
        const maxPages = await maxPagesFor(db, site.organisationId);
        const [assistant] = await db.select({ id: aiAssistants.id, name: aiAssistants.name, userId: aiAssistants.userId })
            .from(aiAssistants).where(eq(aiAssistants.id, site.aiAssistantId)).limit(1);
        const owner = row.requestedBy ?? assistant?.userId ?? null;
        if (!owner) { await failImport(db, site.id, 'The import couldn\'t be completed. Nothing was charged — try again.', null); await endDraft(db, site.id, null); return; }
        const outcome = await runImport(
            { url: row.sourceUrl, pictures: row.pictures === 'copy' ? 'copy' : 'skip', current: definitionOf(site, maxPages).definition, maxPages },
            liveDeps(db, site, owner, renderer),
        );
        if (!outcome.ok) { await failImport(db, site.id, outcome.message, outcome.report); await endDraft(db, site.id, null); return; }

        // Pictures were copied into THIS workspace's library; the save-time check still runs.
        const checked = await verifySiteAssets(db, site.organisationId, outcome.definition);
        const [saved] = await db.update(siteImports).set({ status: 'ready', definition: checked.definition, report: outcome.report, message: null, updatedAt: new Date() })
            .where(and(eq(siteImports.siteId, site.id), eq(siteImports.status, 'reading'))).returning({ id: siteImports.id });
        // The success latch: charged only if this import still held the claim.
        const [held] = await db.update(sites).set({ draftingAt: null, draftNote: null }).where(and(eq(sites.id, site.id), sql`${sites.draftingAt} IS NOT NULL`)).returning({ id: sites.id });
        if (!saved || !held) return;
        await recordCompletedWork(db, site.organisationId, 'site_draft', { ref: site.id, assistantId: site.aiAssistantId });
        if (assistant) {
            await createNotification(db, 'site_draft_ready', {
                userId: assistant.userId, assistantId: assistant.id, category: 'state_change',
                context: { assistant: { name: assistant.name }, site: { pages: `${checked.definition.pages.length} page${checked.definition.pages.length === 1 ? '' : 's'} imported from your old site` } },
                metadata: { assistantId: assistant.id, siteId: site.id, import: true },
            }).catch((err) => console.error('[site-import] notification failed', err));
        }
    } catch (err) {
        console.error('[site-import] import failed', { siteId, message: err instanceof Error ? err.message : String(err) });
        await recordPlatformIncident(db, { kind: 'site_import', error: err, organisationId: site.organisationId, assistantId: site.aiAssistantId, role: 'website_assistant', view: 'site-import', ids: { siteId } });
        await failImport(db, site.id, 'The import couldn\'t be completed this time — your site is unchanged and nothing was charged. Try again in a few minutes.', null).catch(() => {});
        await endDraft(db, site.id, null).catch(() => {});
    } finally {
        await renderer.close();
    }
}

/**
 * The owner's "Use this as my draft": the imported site replaces the draft, through the gate. It
 * takes their old site's look (colours, lettering, corners) when the import read one — else keeps
 * the design they have now — and the imported logo only where they have none. Nothing goes live.
 */
export async function acceptImport(db: Db, site: SiteRow, maxPages: number, userId: number | null = null): Promise<{ ok: true; site: SiteRow; warnings: string[]; blogPosts: number } | { ok: false; status: number; error: string }> {
    const row = await loadImport(db, site.id);
    if (!row || row.status !== 'ready' || !row.definition) return { ok: false, status: 404, error: 'There\'s no imported site waiting to be used.' };
    const current = definitionOf(site, maxPages).definition;
    const imported = normaliseSiteDefinition(row.definition, { maxPages });
    const logoAssetId = current.theme.logoUrl || current.theme.logoAssetId ? current.theme.logoAssetId ?? null : imported.definition.theme.logoAssetId ?? null;
    const report = row.report as ImportReport | null;
    const look = report?.look ?? null;
    const theme = look ? themeWithLook(current.theme, look) : current.theme;
    // Posts from their old blog become Blog Assistant drafts first, so their final addresses are known
    // for the redirects. A second press (or a re-import) finds them by their old address: no doubles.
    const owner = userId ?? row.requestedBy ?? null;
    const posts = report?.blog?.posts?.length && owner ? await importBlogDrafts(db, site.organisationId, owner, report.blog) : null;
    const blogOnNow = posts?.redirects.length ? { blog: { enabled: true, menuLabel: imported.definition.settings.blog?.enabled ? imported.definition.settings.blog.menuLabel : (report?.blog?.label || 'Blog') } } : {};
    const merged = normaliseSiteDefinition({
        ...imported.definition, theme: { ...theme, logoAssetId },
        settings: { ...imported.definition.settings, ...blogOnNow },
        redirects: [...(imported.definition.redirects ?? []), ...(posts?.redirects ?? [])],
    }, { maxPages });
    const checked = await verifySiteAssets(db, site.organisationId, merged.definition);
    const [saved] = await db.update(sites).set({ draft: checked.definition, updatedAt: new Date() }).where(eq(sites.id, site.id)).returning();
    await db.delete(siteImports).where(eq(siteImports.siteId, site.id));
    const blogNote = posts ? blogAcceptNote(posts) : [];
    return { ok: true, site: saved, warnings: [...new Set([...blogNote, ...merged.warnings, ...checked.warnings])], blogPosts: posts?.added ?? 0 };
}

function blogAcceptNote(p: { added: number; already: number; failed: number; assistant: string | null }): string[] {
    const out: string[] = [];
    if (p.added) out.push(`${p.added} post${p.added === 1 ? '' : 's'} from your old blog ${p.added === 1 ? 'is' : 'are'} waiting as draft${p.added === 1 ? '' : 's'} in ${p.assistant ? `${p.assistant}'s Review tab` : 'your Review list'} — nothing is published until you publish ${p.added === 1 ? 'it' : 'them'}. Each old post address goes to its new one once it's published.`);
    if (p.already) out.push(`${p.already} post${p.already === 1 ? ' was' : 's were'} already in your Blog Assistant, so ${p.already === 1 ? 'it wasn\'t' : 'they weren\'t'} added again.`);
    if (p.failed) out.push(`${p.failed} post${p.failed === 1 ? '' : 's'} couldn't be saved — add ${p.failed === 1 ? 'it' : 'them'} in the Blog Assistant.`);
    return out;
}

/** The address an imported post may have: its own, unless another post (any status) holds it. */
export function freeBlogSlug(wanted: string, taken: Set<string>): string {
    const base = (wanted || 'post').slice(0, 76).replace(/-+$/, '') || 'post';
    let s = wanted && !taken.has(wanted) ? wanted : base;
    let n = 2;
    while (taken.has(s)) s = `${base}-${n++}`;
    return s;
}

/**
 * The old blog's posts as Blog Assistant DRAFTS, owned by the person who pressed "Use this as my
 * draft", on the workspace's Blog Assistant when it has one (its Review tab lists them). Their own
 * words, so no generation_reason (they are not AI-written — blog-ai-assisted.ts). canonical_url keeps
 * the old address until publishing stamps the new one (blog-publish.ts). Never throws.
 */
export async function importBlogDrafts(db: Db, orgId: number, userId: number, blog: ImportedBlog): Promise<{ added: number; already: number; failed: number; assistant: string | null; redirects: SiteRedirect[] }> {
    const out = { added: 0, already: 0, failed: 0, assistant: null as string | null, redirects: [] as SiteRedirect[] };
    try {
        const [assistant] = await db.select({ id: aiAssistants.id, name: aiAssistants.name }).from(aiAssistants)
            .innerJoin(masterAssistants, eq(masterAssistants.id, aiAssistants.masterAssistantId))
            .where(and(eq(aiAssistants.organisationId, orgId), eq(masterAssistants.roleKey, 'blog_writer'), ne(aiAssistants.lifecycleStatus, 'archived')))
            .orderBy(aiAssistants.id).limit(1);
        out.assistant = assistant?.name ?? null;
        const existing = await db.select({ slug: blogPosts.slug, canonicalUrl: blogPosts.canonicalUrl, status: blogPosts.status }).from(blogPosts).where(eq(blogPosts.organisationId, orgId));
        const taken = new Set(existing.map((r) => r.slug).filter((x): x is string => !!x));
        const bySource = new Map(existing.filter((r) => r.canonicalUrl && r.slug && r.status !== 'archived').map((r) => [r.canonicalUrl!, r.slug!]));
        // Feature pictures must still be this workspace's (they were copied into it by the import).
        const pictureIds = [...new Set(blog.posts.map((p) => p.featureAssetId).filter((x): x is number => !!x))];
        const ours = new Set(pictureIds.length ? (await db.select({ id: contentAssets.id }).from(contentAssets)
            .where(and(eq(contentAssets.organisationId, orgId), inArray(contentAssets.id, pictureIds)))).map((r) => r.id) : []);
        const redirect = (p: ImportedBlogPost, slug: string) => {
            const to = `${BLOG_PATH}/${slug}`;
            if (p.fromPath !== to) out.redirects.push({ from: p.fromPath, to });
        };
        for (const p of blog.posts) {
            const had = bySource.get(p.sourceUrl);
            if (had) { out.already++; redirect(p, had); continue; }
            const slug = freeBlogSlug(p.slug, taken);
            try {
                await db.insert(blogPosts).values({
                    organisationId: orgId, userId, ownerId: userId, assistantId: assistant?.id ?? null,
                    title: p.title.slice(0, 200), bodyMarkdown: p.bodyMarkdown, slug,
                    metaDescription: p.excerpt, tags: p.tags, canonicalUrl: p.sourceUrl,
                    featureAssetId: p.featureAssetId && ours.has(p.featureAssetId) ? p.featureAssetId : null,
                    status: 'draft',
                });
                taken.add(slug);
                out.added++;
                redirect(p, slug);
            } catch (err) {
                out.failed++;
                console.error('[site-import] blog post not saved', { orgId, url: p.sourceUrl.slice(0, 200), message: err instanceof Error ? err.message : String(err) });
            }
        }
    } catch (err) {
        console.error('[site-import] blog posts not imported', { orgId, message: err instanceof Error ? err.message : String(err) });
    }
    return out;
}

/** "Discard": the imported draft goes; copied pictures stay in their library. */
export async function discardImport(db: Db, siteId: number): Promise<boolean> {
    const gone = await db.delete(siteImports).where(and(eq(siteImports.siteId, siteId), sql`${siteImports.status} <> 'reading'`)).returning({ id: siteImports.id });
    return gone.length > 0;
}

/** The imported definition, for the signed-in preview (site-preview.ts ?import=1). */
export async function importedDefinition(db: Db, siteId: number, maxPages: number): Promise<SiteDefinition | null> {
    const row = await loadImport(db, siteId);
    return row?.status === 'ready' && row.definition ? normaliseSiteDefinition(row.definition, { maxPages }).definition : null;
}

/** The import, as one line of the chat's site snapshot (site-store.ts buildSiteSnapshot). */
export function describeImportForChat(imp: ImportView | null, drafting: boolean): string {
    if (!imp) return 'Import of their current site: none. If they have an existing website, offer a site_import_request card.';
    if (imp.status === 'reading' && drafting) return `Import of their current site: reading ${imp.sourceUrl} right now — the imported draft appears on the Website tab in a minute or two.`;
    if (imp.status === 'ready') {
        const r = imp.report;
        return `Import of their current site: an imported DRAFT from ${imp.sourceUrl} is READY for review and has NOT replaced their draft — ${imp.pages.map((p) => `"${p.title}" (${p.path}, ${p.sections} sections)`).join(', ')}; ${r?.wordsRead ?? 0} of their words read; pictures ${imp.pictures === 'copy' ? `copied: ${r?.pictures.copied ?? 0}` : 'left out (their choice)'}; prices found and NOT copied: ${r?.prices.length ?? 0}${r?.prices.length ? ` (${r.prices.slice(0, 5).map((x) => `"${x.slice(0, 80)}"`).join('; ')}) — they belong in Business Information ▸ Products & Services` : ''}; products found on their old shop: ${r?.products?.length ?? 0}${r?.products?.length ? ` (${r.products.slice(0, 5).map((p) => `"${p.name.slice(0, 60)}"${p.price ? ` ${p.price.slice(0, 20)}` : ''}`).join('; ')}) — a site_import_products card adds them to Business Information, before they use or discard the import` : ''}; left out as clutter: ${r?.leftOut.length ?? 0}; ${blogForChat(r?.blog ?? null)}their old site's look ${r?.look ? `read (main colour ${r.look.primaryColor ?? 'not found'}, lettering ${r.look.font ?? 'unchanged'}) — using the import sets it as the site's design` : 'not read — using the import keeps their current design'}. When they decide, a site_import_decision card ("use" or "discard").`;
    }
    return `Import of their current site: the last attempt (${imp.sourceUrl}) did not make a draft — ${imp.message ?? 'it failed'}`;
}

/** Business Information holds at most this many (org-products.ts MAX_PRODUCTS). */
const PRODUCTS_MAX = 200;
/** Pictures fetched in one request when the import hadn't copied a product's picture yet. */
const PRODUCT_PICTURES_PER_REQUEST = 12;

/**
 * The products the import found on their old shop (report.products) into Business Information ▸
 * Products & Services — the owner's choice from the import card (GUI) or the chat's
 * site_import_products card; both send sites.ts import_products. `names` = the ones they ticked (all
 * when omitted). A product already in Business Information by that name is skipped, never overwritten.
 * Its picture comes too when they chose to copy pictures: the library copy the import made, else
 * fetched now through the SSRF fence (a few per request). Prices go only into Business Information.
 */
export async function addImportedProducts(db: Db, site: SiteRow, opts: { names?: unknown; userId: number | null }): Promise<{ ok: true; added: number; skipped: number; withoutPicture: number } | { ok: false; status: number; error: string }> {
    const row = await loadImport(db, site.id);
    const all = (row?.report as ImportReport | null)?.products ?? [];
    if (!row || !all.length) return { ok: false, status: 404, error: 'There are no products from your old shop to add.' };
    const ticked = Array.isArray(opts.names) ? new Set(opts.names.filter((n): n is string => typeof n === 'string').map((n) => n.trim().toLowerCase())) : null;
    const wanted = all.filter((p) => !ticked || ticked.has(p.name.toLowerCase()));
    if (!wanted.length) return { ok: false, status: 400, error: 'Choose at least one product to add.' };
    const orgId = site.organisationId;
    const have = await db.select({ name: orgProducts.name, sortOrder: orgProducts.sortOrder }).from(orgProducts).where(eq(orgProducts.organisationId, orgId));
    const taken = new Set(have.map((h) => h.name.trim().toLowerCase()));
    const fresh = wanted.filter((p) => !taken.has(p.name.trim().toLowerCase()));
    const room = Math.max(0, PRODUCTS_MAX - have.length);
    if (fresh.length && !room) return { ok: false, status: 409, error: `Business Information holds up to ${PRODUCTS_MAX} products and services. Archive or remove some first.` };
    const adding = fresh.slice(0, room);
    // Pictures: only ones still in this workspace's library, or — if they chose to copy pictures — fetched now.
    const ids = adding.map((p) => p.imageAssetId).filter((x): x is number => typeof x === 'number');
    const ours = new Set(ids.length ? (await db.select({ id: contentAssets.id }).from(contentAssets).where(and(eq(contentAssets.organisationId, orgId), inArray(contentAssets.id, ids)))).map((r) => r.id) : []);
    let fetches = 0;
    const pictures: Array<number | null> = [];
    for (const p of adding) {
        if (p.imageAssetId && ours.has(p.imageAssetId)) { pictures.push(p.imageAssetId); continue; }
        if (row.pictures === 'copy' && p.image && opts.userId && fetches < PRODUCT_PICTURES_PER_REQUEST) {
            fetches++;
            pictures.push(await saveImportedPicture(db, orgId, opts.userId, p.image, p.name));
            continue;
        }
        pictures.push(null);
    }
    const start = have.reduce((m, h) => Math.max(m, h.sortOrder ?? -1), -1) + 1;
    if (adding.length) {
        await db.insert(orgProducts).values(adding.map((p, i) => {
            const f = productFieldsFromImport(p);
            return {
                organisationId: orgId, createdBy: opts.userId ?? null, kind: 'product', status: 'active', sortOrder: start + i,
                name: f.name, url: f.url, priceType: f.priceType, priceAmount: f.priceAmount, priceCurrency: f.priceCurrency, price: f.price,
                imageAssetId: pictures[i],
            };
        }));
    }
    return { ok: true, added: adding.length, skipped: wanted.length - adding.length, withoutPicture: pictures.filter((x) => x === null).length };
}

/** The old blog's posts, for the chat's line about a ready import. */
function blogForChat(b: ImportedBlogSummary | null): string {
    if (!b?.posts.length) return '';
    const titles = b.posts.slice(0, 5).map((p) => `"${p.title.slice(0, 80)}"`).join('; ');
    return `posts from their OLD BLOG (${b.indexUrl}): ${b.posts.length}${b.more ? ' (the newest; there were more)' : ''} (${titles}${b.posts.length > 5 ? '; …' : ''})${b.failed.length ? `, ${b.failed.length} couldn't be read` : ''} — using the import adds them to the Blog Assistant as DRAFTS (nothing is published; they review and publish each there), switches the site's blog on, and sends each old post address to /blog/<its address> once published; `;
}
